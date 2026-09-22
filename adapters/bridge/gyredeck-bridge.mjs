#!/usr/bin/env node

/**
 * Gyredeck Standalone Bridge
 *
 * A self-contained HTTP bridge that can run independently of Letta Code.
 * When running, both the Letta mod and AGY adapter can forward events here
 * via POST /ingest. The Letta mod auto-detects this bridge and forwards
 * instead of starting its own.
 *
 * Usage:
 *   node gyredeck-bridge.mjs              # start with defaults
 *   node gyredeck-bridge.mjs --port 47621 # explicit port
 *   node gyredeck-bridge.mjs --daemon     # background mode (detach)
 *
 * Endpoints:
 *   GET  /health    - Bridge status and capabilities
 *   GET  /snapshot  - Current capabilities and recent events
 *   GET  /events    - Live Server-Sent Events stream
 *   POST /hook/stop - Turn completion hook relay
 *   POST /hook/attention - Attention/permission hook relay
 *   POST /ingest    - Multi-provider event fan-in
 */

import { appendFileSync, closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const PROTOCOL_VERSION = 2;
const DEFAULT_PORT = 47621;
const MOD_DIR = join(homedir(), ".config", "gyredeck");
const CONFIG_PATH = join(MOD_DIR, "gyredeck.config.json");
const DEFAULT_LOG_FILE = join(MOD_DIR, "gyredeck.events.ndjson");
const INGEST_TOKEN_PATH = join(MOD_DIR, "gyredeck.ingest-token");
const BRIDGE_HOST = "127.0.0.1";

// ── Token management ──

function readOrCreateIngestToken() {
  mkdirSync(MOD_DIR, { recursive: true });
  const read = () => {
    try {
      const value = readFileSync(INGEST_TOKEN_PATH, "utf8").trim();
      return /^[a-f0-9]{64}$/i.test(value) ? value : null;
    } catch {
      return null;
    }
  };
  const existing = read();
  if (existing) return existing;
  const token = randomBytes(32).toString("hex");
  try {
    writeFileSync(INGEST_TOKEN_PATH, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return token;
  } catch {
    return read() ?? token;
  }
}

// The two credentials that reach /mail: the machine's token (32 bytes) and a room's
// password (16). Kept as one expression so the door and the things that mint them cannot
// drift — `readOrCreateIngestToken` and `newRoomPassword` are the other two ends of it.
const CREDENTIAL_SHAPE = /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/i;

/**
 * Whether a room still holds the session that created it.
 *
 * A room without its founder is over, whoever else is still in it: nobody left can be let
 * in (`/passwords` answers `not_the_founder` to them) and nobody can close it either,
 * since the app asks as itself and gets the same refusal. What remains is a code nobody
 * can use for anything.
 *
 * A mailbox has no founder — `createdBy` is null — and is not judged by this.
 *
 * Its own function, at module scope, so the sweep and the test ask the same question. The
 * three paths that remove a member each close the room when it is the founder; this is the
 * net under them, for the one that forgets. One of them did forget, which is how a room
 * came to outlive its founder to begin with.
 */
export const roomHasLostItsFounder = (room) =>
  room.createdBy !== null && room.createdBy !== undefined && !room.members.has(room.createdBy);

/** Why an orphaned room was closed, told to whoever is still in it. */
/**
 * How much a room may hold, in two units, because one of them was lying.
 *
 * The cap used to be a count alone, and the count is in UTF-16 code units — Thai runs
 * about 2.14× that in UTF-8, so "100 messages of 4096" was not 13 MB of anything. Bytes
 * are what the machine spends, so bytes are what is budgeted; the count stays as a second
 * ceiling so one room cannot hold a hundred thousand one-character messages.
 *
 * 500 and 1 MiB are chosen against the work these rooms actually do: a single code review
 * between two agents ran to 26 messages and 76 KB, so this is roughly a dozen of those.
 */
export const MAIL_MAX_MESSAGES = 500;
export const MAIL_MAX_ROOM_BYTES = 1_048_576;

/**
 * How many of the room's own notices it keeps.
 *
 * A notice cannot be refused — it is how a session learns it was removed from a room, and
 * refusing one is the silent failure this work exists to end. So it must be bounded some
 * other way, or a room joined and left repeatedly while somebody is not reading grows past
 * both caps with nothing able to stop it. Codex found that hole in the exemption.
 *
 * Bounded by dropping the *oldest notice*, never correspondence: a notice says what the
 * room looks like now, and the newest is the one that is true. Thirty-two is well past any
 * real join and leave history and still nothing against the budget.
 *
 * This deliberately does not move `droppedThroughSeq`. That number is a watermark — "every
 * seq at or below this is gone" — and it is only true of a prefix. A notice removed from
 * the middle of the history would raise it over mail still sitting there, and the inbox
 * carries the reader's cursor up to it: the first version of this did exactly that, and
 * Codex reproduced a reader collecting seq 1 and never being handed seq 2. Nobody is owed
 * an old roster, so nothing needs reporting when one goes.
 */
export const MAIL_MAX_NOTICES = 32;

/** What a message costs the room. The envelope is small and fixed; the text is not. */
export const messageBytes = (message) => Buffer.byteLength(message.text ?? "", "utf8");

export const roomBytes = (room) => room.messages.reduce((total, m) => total + messageBytes(m), 0);

/**
 * The furthest point every reader of this room has passed.
 *
 * Anything at or below it has been handed to everyone who was waiting for it, so dropping
 * it loses nothing. A member who has read nothing holds this at zero, which is the point:
 * their mail is not something the room may quietly spend to make space.
 *
 * A private mailbox has no members and uses the room-level position, which is the one its
 * single reader advances.
 */
export const slowestReaderSeq = (room) => {
  if (room.members.size === 0) return room.readSeq;
  let slowest = Infinity;
  for (const member of room.members.values()) slowest = Math.min(slowest, member.readSeq ?? 0);
  return slowest === Infinity ? room.readSeq : slowest;
};

/**
 * Drop what everyone has already read, oldest first, until the room is inside both caps.
 *
 * Records how far it got on the room, so a reader can be told that something it never saw
 * is gone rather than being handed a shorter list and left to assume that was all there
 * was. Returns how many messages went.
 */
/**
 * Keep the room's own notices to their own allowance, oldest first.
 *
 * Run before the ordinary trim so a notice never costs a message somebody is still owed.
 * Read or unread does not enter into it — a notice is a statement about the room, not
 * correspondence addressed to anyone, and nobody is owed an old roster.
 */
/**
 * Who the room speaks as. Not a session: nothing answers it and nothing is addressed to it.
 */
export const ROOM_SENDER = "gyredeck-room";

/** Whether the room itself said this, whatever kind it chose to say it as. */
const isRoomsOwnVoice = (message) => message.from === ROOM_SENDER || message.kind === "notice";

export const trimRoomNotices = (room) => {
  let notices = room.messages.reduce((count, m) => count + (isRoomsOwnVoice(m) ? 1 : 0), 0);
  let dropped = 0;
  while (notices > MAIL_MAX_NOTICES) {
    const index = room.messages.findIndex((m) => isRoomsOwnVoice(m));
    if (index < 0) break;
    room.messages.splice(index, 1);
    notices -= 1;
    dropped += 1;
  }
  return dropped;
};

export const trimRoomMessages = (room) => {
  const safeUpTo = slowestReaderSeq(room);
  let bytes = roomBytes(room);
  let dropped = 0;
  while (
    room.messages.length > 0 &&
    room.messages[0].seq <= safeUpTo &&
    (room.messages.length > MAIL_MAX_MESSAGES || bytes > MAIL_MAX_ROOM_BYTES)
  ) {
    const [gone] = room.messages.splice(0, 1);
    bytes -= messageBytes(gone);
    room.droppedThroughSeq = Math.max(room.droppedThroughSeq ?? 0, gone.seq);
    dropped += 1;
  }
  return dropped;
};

/**
 * Whether one more message would have to push out one nobody has read.
 *
 * Asked before a send rather than after, because the answer decides whether the sender is
 * told. The old code pushed and then `shift()`ed the oldest unconditionally: a room busy
 * enough to hit the cap silently ate whatever its slowest reader had not collected, and
 * nothing anywhere said so. Refusing is worse for the sender and better for everyone,
 * since a refusal can be read and acted on.
 */
export const roomIsFull = (room, incomingBytes = 0) => {
  // Spend what is spendable on paper first, and spend as much of it as the incoming
  // message needs. An earlier version asked only whether the *oldest* message could go,
  // which is the right question for the count — one over means one out — and the wrong
  // one for bytes: a megabyte arriving behind a one-byte read message freed one byte and
  // reported room. Codex reproduced it against this function; the room ended 3,425 bytes
  // over its budget having answered 202.
  const safeUpTo = slowestReaderSeq(room);
  let messages = room.messages.length;
  let bytes = roomBytes(room);
  for (const message of room.messages) {
    if (messages + 1 <= MAIL_MAX_MESSAGES && bytes + incomingBytes <= MAIL_MAX_ROOM_BYTES) break;
    // Past here is owed to somebody, and no amount of need makes it spendable.
    if (message.seq > safeUpTo) break;
    messages -= 1;
    bytes -= messageBytes(message);
  }
  return messages + 1 > MAIL_MAX_MESSAGES || bytes + incomingBytes > MAIL_MAX_ROOM_BYTES;
};

/** Who is holding the room up, for the sentence the refusal hands back. */
export const slowestReaders = (room) => {
  const slowest = slowestReaderSeq(room);
  return [...room.members.entries()]
    .filter(([, member]) => (member.readSeq ?? 0) <= slowest)
    .map(([id]) => id);
};

export const ORPHANED_ROOM_REASON =
  "the session that created it is no longer in it, and a room does not outlive its founder";

/**
 * One pass over the room table: close what is orphaned, forget what has gone cold.
 *
 * **This runs on a request, not on a clock.** There is no timer; the two callers are a
 * `/sync/rooms` listing and a `/mail` call, so a room nobody asks about sits as it is.
 * That is why the three paths that remove a member each close the room themselves — they
 * are what makes it immediate. This is the repair for a path that forgets to, taking
 * effect at the next request, and one of them did forget, which is how a room came to
 * outlive its founder. Do not read it as an invariant held at the moment of mutation.
 *
 * Lifted out of `startBridge` and given the map and the close as arguments so a test can
 * run the real pass. Behind the closure the only reachable question was the predicate, and
 * a test that asks only that goes on passing with the pass itself deleted.
 */
export const sweepRooms = (rooms, now, { close, idleMs }) => {
  for (const [name, room] of rooms) {
    // A room without the session that made it is over, whoever else is still in it:
    // nobody left can be let in (`/passwords` answers `not_the_founder` to them) and
    // nobody can close it either. Checked before the members test below, or the case
    // that matters — the founder gone, a peer still there — would never be reached.
    if (roomHasLostItsFounder(room)) {
      close(name, room, ORPHANED_ROOM_REASON);
      continue;
    }
    // A room with members was set up deliberately and stays until its last member
    // leaves; only unattended mailboxes age out.
    if (room.members.size > 0) continue;
    if (room.clients.size === 0 && now - room.touchedAt > idleMs) rooms.delete(name);
  }
};

/** Characters a room code is drawn from: no `0/O`, no `1/l/I`, nothing that reads alike. */
export const SYNC_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * One character of a room code, drawn evenly from the alphabet.
 *
 * `byte % 31` is not even: 256 is not a multiple of 31, so the first eight letters come up
 * on nine of the 256 byte values and the other twenty-three on eight — a 12.5% edge. Small,
 * and a code is a name people read to each other rather than a secret, so nothing depends
 * on it; it is simply free to do properly. Bytes at or above the largest whole multiple of
 * the alphabet are thrown away and another drawn, which is what makes the remainder even.
 *
 * Module scope, and exported, so the test can draw from the generator the bridge itself
 * uses. A copy of this rule living in the test would go on passing if this one went back
 * to a plain modulo.
 */
const SYNC_CODE_LIMIT = 256 - (256 % SYNC_CODE_ALPHABET.length);
export const syncCodeChar = () => {
  for (;;) {
    const [byte] = randomBytes(1);
    if (byte < SYNC_CODE_LIMIT) return SYNC_CODE_ALPHABET[byte % SYNC_CODE_ALPHABET.length];
  }
};

function matchesIngestToken(expected, value) {
  if (typeof value !== "string") return false;
  const provided = Buffer.from(value);
  const trusted = Buffer.from(expected);
  return provided.length === trusted.length && timingSafeEqual(provided, trusted);
}

// ── Config ──

function readConfig() {
  const fallback = {
    port: DEFAULT_PORT,
    host: "127.0.0.1",
    logFile: DEFAULT_LOG_FILE,
    ingestToken: readOrCreateIngestToken(),
  };

  if (!existsSync(CONFIG_PATH)) return fallback;

  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      ...fallback,
      ...parsed,
      port: Number.isInteger(parsed.port) ? parsed.port : fallback.port,
      host: parsed.host === BRIDGE_HOST ? parsed.host : fallback.host,
      logFile: typeof parsed.logFile === "string" ? parsed.logFile : fallback.logFile,
      ingestToken: fallback.ingestToken,
    };
  } catch {
    return fallback;
  }
}

// ── Scope tracking ──

function createScopeTracker() {
  const activeScopesByConversation = new Map();
  const activeScopesByCwd = new Map();
  const recentHookIds = new Map();
  const recentLegacySignals = new Map();
  const lastRelaySignalAtByType = new Map();
  const recentCompletionAtByCwd = new Map();
  const recentCompletedScopesByCwd = new Map();
  const legacySignalRetentionMs = 5_000;
  const recentScopeRetentionMs = 15_000;
  const hookIdRetentionMs = 60_000;
  const activeScopeRetentionMs = 30 * 60_000;
  const cleanupIntervalMs = 1_000;
  let nextRecentCleanupAt = 0;

  // Carry-forward scope is kept PER conversation (falling back to cwd) so that
  // fields like `model` never bleed from one agent/source into another — e.g. an
  // Antigravity turn must not stamp its model onto a Claude conversation.
  const scopeMemory = new Map();
  const blankScope = () => ({
    agentId: null, agentName: null, conversationId: null,
    cwd: null, model: null, permissionMode: null, runtime: null,
  });
  const scopeMemoryKey = (payload) =>
    (typeof payload.conversationId === "string" && payload.conversationId.length > 0 && payload.conversationId) ||
    (typeof payload.cwd === "string" && payload.cwd.length > 0 && payload.cwd) ||
    "__global__";

  const cloneScope = (scope) => ({
    agentId: scope.agentId ?? null,
    agentName: scope.agentName ?? null,
    conversationId: scope.conversationId ?? null,
    cwd: scope.cwd ?? null,
    model: scope.model ?? null,
    permissionMode: scope.permissionMode ?? null,
    runtime: scope.runtime && typeof scope.runtime === "object" ? { ...scope.runtime } : null,
  });

  const removeActiveScope = (conversationId) => {
    if (!conversationId) return;
    scopeMemory.delete(conversationId);
    const record = activeScopesByConversation.get(conversationId);
    activeScopesByConversation.delete(conversationId);
    if (!record?.scope.cwd) return;
    const cwdScopes = activeScopesByCwd.get(record.scope.cwd);
    cwdScopes?.delete(conversationId);
    if (cwdScopes?.size === 0) activeScopesByCwd.delete(record.scope.cwd);
  };

  const cleanupRecentState = (now) => {
    if (now < nextRecentCleanupAt) return;
    nextRecentCleanupAt = now + cleanupIntervalMs;
    for (const [key, seenAt] of recentLegacySignals) {
      if (now - seenAt > legacySignalRetentionMs) recentLegacySignals.delete(key);
    }
    for (const [cwd, completedAt] of recentCompletionAtByCwd) {
      if (now - completedAt > recentScopeRetentionMs) recentCompletionAtByCwd.delete(cwd);
    }
    for (const [cwd, cwdScopes] of recentCompletedScopesByCwd) {
      for (const [conversationId, record] of cwdScopes) {
        if (now - record.completedAt > recentScopeRetentionMs) cwdScopes.delete(conversationId);
      }
      if (cwdScopes.size === 0) recentCompletedScopesByCwd.delete(cwd);
    }
    for (const [hookId, seenAt] of recentHookIds) {
      if (now - seenAt > hookIdRetentionMs) recentHookIds.delete(hookId);
    }
    const stale = [];
    for (const [conversationId, record] of activeScopesByConversation) {
      if (now - record.lastActiveAt > activeScopeRetentionMs) stale.push(conversationId);
    }
    for (const conversationId of stale) removeActiveScope(conversationId);
  };

  const isTerminalLlmEvent = (payload) => {
    if (payload.type !== "llm_end") return false;
    const reason = String(payload.data?.stopReason ?? "").toLowerCase();
    return reason.includes("end") || reason.includes("stop") || reason.includes("done") || reason.includes("complete") || Boolean(payload.data?.error);
  };

  const rememberCompletedScope = (payload, now) => {
    if (!payload.cwd || !payload.conversationId) return;
    const cwdScopes = recentCompletedScopesByCwd.get(payload.cwd) ?? new Map();
    cwdScopes.set(payload.conversationId, { scope: cloneScope(payload), completedAt: now });
    recentCompletedScopesByCwd.set(payload.cwd, cwdScopes);
  };

  const recentCompletedScopes = (cwd, now) => {
    if (!cwd) return [];
    cleanupRecentState(now);
    const cwdScopes = recentCompletedScopesByCwd.get(cwd);
    if (!cwdScopes) return [];
    for (const [conversationId, record] of cwdScopes) {
      if (now - record.completedAt > recentScopeRetentionMs) cwdScopes.delete(conversationId);
    }
    if (cwdScopes.size === 0) recentCompletedScopesByCwd.delete(cwd);
    return [...cwdScopes.values()];
  };

  const rememberScope = (payload) => {
    const now = Date.now();
    cleanupRecentState(now);
    const memKey = scopeMemoryKey(payload);
    let mem = scopeMemory.get(memKey);
    if (!mem) { mem = blankScope(); scopeMemory.set(memKey, mem); }
    for (const key of Object.keys(mem)) {
      if (payload[key] != null) mem[key] = payload[key];
    }
    if (["turn_start", "tool_start", "compact_start", "llm_start", "attention_requested"].includes(payload.type)) {
      const scope = cloneScope(mem);
      if (payload.type === "turn_start" && scope.cwd) recentCompletionAtByCwd.delete(scope.cwd);
      if (scope.conversationId) {
        removeActiveScope(scope.conversationId);
        const record = { scope, lastActiveAt: now };
        activeScopesByConversation.set(scope.conversationId, record);
        if (scope.cwd) {
          const cwdScopes = activeScopesByCwd.get(scope.cwd) ?? new Map();
          cwdScopes.set(scope.conversationId, record);
          activeScopesByCwd.set(scope.cwd, cwdScopes);
        }
      }
    }
    if (["turn_complete", "turn_stop", "conversation_close"].includes(payload.type) || isTerminalLlmEvent(payload)) {
      if (payload.cwd) recentCompletionAtByCwd.set(payload.cwd, now);
      rememberCompletedScope(payload, now);
      removeActiveScope(payload.conversationId);
    }
  };

  const hookScope = (data, now) => {
    const requestedCwd = typeof data.cwd === "string" && data.cwd.length > 0
      ? data.cwd
      : typeof data.workingDirectory === "string" && data.workingDirectory.length > 0
        ? data.workingDirectory : null;
    const requestedConversationId = typeof data.conversationId === "string" && data.conversationId.length > 0 ? data.conversationId : null;
    const requestedAgentId = typeof data.agentId === "string" && data.agentId.length > 0 ? data.agentId : null;
    let candidates = [];
    if (requestedConversationId) {
      const exact = activeScopesByConversation.get(requestedConversationId);
      if (exact) candidates = [exact];
    } else if (requestedCwd) {
      candidates = [...(activeScopesByCwd.get(requestedCwd)?.values() ?? [])];
      if (candidates.length === 0) candidates = recentCompletedScopes(requestedCwd, now);
    } else {
      candidates = [...activeScopesByConversation.values()];
    }
    if (requestedAgentId) {
      candidates = candidates.filter((record) => record.scope.agentId === requestedAgentId);
    }
    const scope = cloneScope(candidates.length === 1 ? candidates[0].scope : {});
    if (requestedConversationId) scope.conversationId = requestedConversationId;
    if (requestedAgentId) scope.agentId = requestedAgentId;
    if (requestedCwd) scope.cwd = requestedCwd;
    for (const key of Object.keys(scope)) {
      if (typeof data[key] === "string" && data[key].length > 0) scope[key] = data[key];
    }
    return scope;
  };

  const shouldEmitHookSignal = (type, scope, data, now) => {
    cleanupRecentState(now);
    const hookId = typeof data.hookId === "string" && data.hookId.length > 0 ? data.hookId : null;
    if (hookId) {
      const seenAt = recentHookIds.get(hookId);
      if (seenAt != null && now - seenAt <= hookIdRetentionMs) return false;
      recentHookIds.set(hookId, now);
      lastRelaySignalAtByType.set(type, now);
      return true;
    }
    if (now - (lastRelaySignalAtByType.get(type) ?? 0) <= legacySignalRetentionMs) return false;
    const legacyKey = [type, scope.conversationId ?? "", scope.cwd ?? ""].join(":");
    const previous = recentLegacySignals.get(legacyKey) ?? 0;
    recentLegacySignals.set(legacyKey, now);
    return now - previous > legacySignalRetentionMs;
  };

  return { rememberScope, hookScope, shouldEmitHookSignal, recentCompletionAtByCwd };
}

// ── Bridge server ──

/**
 * The mode the event log is kept at.
 *
 * Every line of it carries a `conversationId`, a `cwd`, a `model` and a `permissionMode`,
 * which is a record of what every agent on this machine was doing and where. The ingest
 * token sits in the same directory at `0600`; the log had no mode of its own and was
 * created by whatever appended to it first, under the process umask — `0644`.
 */
const LOG_FILE_MODE = 0o600;

/**
 * Open the event log for appending, or refuse to write to disk and say why.
 *
 * Everything happens through one file descriptor, deliberately. Checking a path and then
 * writing to that path are two different files if anything moves in between, and the mode
 * is exactly what an attacker would want to change in that gap; a descriptor is the file
 * itself. `O_NOFOLLOW` refuses a symlink outright, so the log cannot be pointed at
 * something else that then inherits `0600` and our writes.
 *
 * A log that cannot be confirmed as a regular file at `0600` is **not written to**. The
 * earlier version of this swallowed a failed `chmod` and appended anyway, which left the
 * file exactly as wide as it had been while the docs claimed otherwise — Codex caught that
 * in review. Presence is still not worth a leak, so the bridge says one line on stderr and
 * runs on: the log is local diagnostics, and `GET /events` and `/snapshot` are unaffected.
 *
 * Note what that does *not* promise. Disk logging narrows the file before writing to it, or
 * it is off. It does not narrow a file it has given up on — a log that was already `0644`
 * and could not be chmodded stays `0644`, holding whatever it already held. The guarantee
 * is about what this bridge adds, not about what it finds.
 *
 * Exported, and returns a writer rather than a descriptor, so no caller can hold the fd
 * and skip the check that earned it.
 */
export function openEventLog(logFile) {
  const refuse = (why) => ({
    enabled: false,
    why,
    append() {},
    close() {},
  });

  try {
    mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  } catch (error) {
    return refuse(`cannot create the directory for ${logFile}: ${error.code ?? error.message}`);
  }

  let fd;
  try {
    const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW;
    fd = openSync(logFile, flags, LOG_FILE_MODE);
  } catch (error) {
    // ELOOP is the interesting one: the path is a symlink, and following it is the whole
    // thing `O_NOFOLLOW` exists to refuse.
    return refuse(`cannot open ${logFile} for appending: ${error.code ?? error.message}`);
  }

  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("not a regular file");
    if ((opened.mode & 0o777) !== LOG_FILE_MODE) {
      // Every machine that ran an older bridge has a log at 0644, and nothing else would
      // ever narrow it. Through the descriptor, so it is this file and not whatever the
      // path names by now.
      fchmodSync(fd, LOG_FILE_MODE);
      if ((fstatSync(fd).mode & 0o777) !== LOG_FILE_MODE) throw new Error("the mode did not change");
    }
  } catch (error) {
    closeSync(fd);
    return refuse(`will not write ${logFile}: ${error.code ?? error.message}`);
  }

  let open = true;
  return {
    enabled: true,
    why: null,
    append(line) {
      if (!open) return;
      try {
        // Through the descriptor that was checked, but by `appendFileSync` rather than
        // `writeSync`: a raw write may take only part of the line and report how much,
        // which would leave half a JSON object in an NDJSON file and call it a success.
        // Codex caught that. This writes all of it or throws.
        appendFileSync(fd, line);
      } catch (error) {
        // A descriptor that has stopped accepting writes is not going to start again, and
        // an event every turn would be a line of stderr every turn.
        open = false;
        console.error(`gyredeck: stopped writing the event log — ${error.code ?? error.message}`);
        try { closeSync(fd); } catch { /* already gone */ }
      }
    },
    close() {
      if (!open) return;
      open = false;
      try { closeSync(fd); } catch { /* already gone */ }
    },
  };
}

function startBridge(config) {
  const eventLog = openEventLog(config.logFile);
  if (!eventLog.enabled) console.error(`gyredeck: event log disabled — ${eventLog.why}`);

  const capabilities = {
    events: { lifecycle: true, turns: true, tools: true, compact: true, llm: true },
    endpoints: { health: true, snapshot: true, sse: true, hookStop: true, hookAttention: true, ingest: true, mail: true, syncRooms: true },
    sessionActions: { focusTerminal: false, endSession: false, dismissEnded: true },
  };

  const clients = new Set();
  const maxRecent = 500;
  const recent = readRecentEvents(config.logFile, maxRecent);
  const tracker = createScopeTracker();

  /**
   * Take a finished session out of the room it was in.
   *
   * A session that has ended can never collect its mail again, so leaving it in place
   * would tell everyone else it is still there — and an agent handing work to a
   * member that will never read it waits for an answer that cannot come. Its `pending`
   * would also climb forever, and a room with members is exempt from the idle sweep,
   * so nothing would ever reclaim it.
   *
   * Sessions are resumable and keep their id, so a resumed one finds itself out of the
   * room and has to be put back. That is one action for the person, against a peer
   * that silently is not there.
   */
  const releaseClosedSession = (conversationId) => {
    const found = syncRoomFor(conversationId);
    if (!found) return;
    // A founder leaving by ending its session is a founder leaving. There are two doors
    // out of a room — the app's Disconnect and a session simply stopping — and fixing
    // only the one being looked at is how the room outlived its founder in the first
    // place.
    if (found.room.createdBy === conversationId) {
      closeRoom(found.name, found.room, "the session that created it ended, and a room does not outlive its founder");
      return;
    }
    const label = labelIn(found.room, conversationId);
    retireLabel(found.room, conversationId);
    found.room.touchedAt = Date.now();
    // A session that has ended cannot read the notice, but its stream is still open
    // until something closes it, and this is that something.
    partWithMember(found.name, found.room, conversationId, "its session ended");
    if (found.room.members.size === 0 && found.room.clients.size === 0) {
      mailRooms.delete(found.name);
    } else if (found.room.members.size > 0) {
      announceMembership(found.name, found.room, `${label} ended its session and left this room.`);
    }
  };

  const emitLocal = (payload) => {
    tracker.rememberScope(payload);
    rememberProvider(payload);
    if (payload.type === "conversation_close" && typeof payload.conversationId === "string") {
      releaseClosedSession(payload.conversationId);
    }
    recent.push(payload);
    if (recent.length > maxRecent) recent.shift();

    const serialized = JSON.stringify(payload);
    eventLog.append(`${serialized}\n`);

    const frame = `event: ${payload.type}\ndata: ${serialized}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  };

  /**
   * What a Codex thread has in its context window, read from its own rollout log.
   *
   * Codex's hook payload carries no token counts, but the log it writes anyway does —
   * so the numbers arrive without asking the session for anything. `input_tokens`
   * already contains `cached_input_tokens`; adding them double-counts, which on a live
   * thread turned 5.4% into 10.4%. Reported here in the shape the meter reads, with the
   * cache fields zeroed rather than omitted, because the meter sums all three.
   */
  const codexUsageFor = (threadId) => {
    const path = codexRolloutFor(threadId);
    if (!path) return null;
    let window = null;
    let last = null;
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const payload = entry?.payload;
        if (!payload) continue;
        const seen = payload.model_context_window ?? payload.info?.model_context_window;
        if (Number.isFinite(seen)) window = seen;
        const usage = payload.info?.last_token_usage;
        if (usage && Number.isFinite(usage.input_tokens)) last = usage;
      }
    } catch {
      return null;
    }
    if (!last) return null;
    return {
      inputTokens: last.input_tokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: Number.isFinite(last.output_tokens) ? last.output_tokens : null,
      contextWindow: window,
    };
  };

  /**
   * Put whatever a Codex session just said into the room it is in.
   *
   * Codex cannot post for itself, so the bridge speaks on its behalf — but it used to do
   * that only while a harvest was running, and a harvest only started when somebody
   * pushed a message in. A Codex session told by its own user to say something wrote the
   * message and it reached nobody. Reading its log whenever it finishes a turn covers
   * both cases with one path.
   *
   * Nothing is published twice: the same per-thread claim guards this and the harvest
   * that follows a push.
   */
  /**
   * The routing Codex asked for, taken off the front of what it wrote.
   *
   * Every other member sends `to` and `kind` as fields. Codex sends nothing — the
   * bridge posts on its behalf — so the one place it can say who a message is for is
   * the message. A first line of `@everyone ask` or `@Claude Code ack` is lifted off
   * and becomes the fields; anything else leaves the text alone and takes the loud
   * default, because a Codex turn that was never taught this must still be heard.
   */
  // Either the line is only the routing, or it carries the message after a separator.
  // Codex wrote `@Antigravity reaction — รับทราบครับ` every time, which is the natural
  // way to write it and which the first version of this refused: the line did not match,
  // so the message fell through to the loud default and went to the whole room as a
  // tell. Silently, and with an ok and a seq, so nothing looked wrong from either end.
  // A separator is required rather than plain space, or `@Antigravity tell me about X`
  // would lose three words to the parser.
  const CODEX_ROUTING_LINE =
    /^@(.+?)[ \t]+(ask|tell|reaction|ack)[ \t]*(?:[—–\-:|][ \t]*(.*))?$/i;
  const routeCodexReply = (room, text) => {
    const [first, ...rest] = text.split("\n");
    const match = CODEX_ROUTING_LINE.exec(first.trim());
    if (!match) return { text, routing: { to: MAIL_EVERYONE, kind: MAIL_DEFAULT_KIND } };
    const inline = (match[3] ?? "").trim();
    const target = match[1].trim();
    const to = /^everyone$/i.test(target)
      ? MAIL_EVERYONE
      : room.members.has(target)
        ? target
        : [...room.members.keys()].find(
            (id) => labelIn(room, id).toLowerCase() === target.toLowerCase(),
          ) ?? MAIL_EVERYONE;
    // A line with nothing under it said everything it meant in the line. Falling back
    // to the whole text published `@everyone ack` as the message body, which is the
    // instruction wearing the costume of a reply.
    const body = [inline, rest.join("\n").trim()].filter(Boolean).join("\n");
    return { text: body || "ok", routing: { to, kind: asKind(match[2].toLowerCase()) } };
  };

  /** Where the last harvest of each Codex log stopped, as a byte offset into it. */
  const harvestAt = new Map();
  /**
   * How the harvest is doing, because its failure mode is indistinguishable from quiet.
   *
   * Reading another program's log is not a contract: `event_msg` / `task_complete` /
   * `last_agent_message` are Codex's own shapes and can change under us. If they do,
   * every read parses nothing, no message is ever published, and a room where an agent
   * is talking looks exactly like a room where nobody is. Counting turns against
   * replies is the cheapest thing that can tell those two apart.
   */
  const codexHarvest = { turns: 0, published: 0, warned: false };
  /**
   * The seq the bridge last gave a Codex session's own words, so it can be told.
   *
   * Codex never sees a reply to anything: the bridge posts for it, and the response
   * goes nowhere it can read. The brief nevertheless told it not to claim a message was
   * sent without seeing ok:true and a seq — a rule it could never satisfy even once,
   * while its messages were in fact being published every time. Handing the seq back on
   * the next push is the only confirmation that can reach it, and its absence is the
   * only way it can learn a harvest failed. Codex itself pointed out the gap that
   * remains: with no next push, the last message stays unconfirmed. That is accepted —
   * closing it would mean waking a session to tell it a number.
   */
  const publishedForCodex = new Map();
  // Several turns is enough to be past a slow flush and not enough to be a whole
  // working session lost before anyone hears about it.
  const CODEX_HARVEST_SUSPECT_AFTER = 5;
  const harvestCodexTurn = (conversationId) => {
    const found = syncRoomFor(conversationId);
    const member = found?.room.members.get(conversationId);
    if (!member || member.confirmed !== true) return;
    const path = codexRolloutFor(conversationId);
    if (!path) return;
    // A log nobody has read yet starts at the moment this session joined the room, so a
    // conversation that was already long does not arrive in the room all at once. Every
    // read after that resumes from a byte offset, which cannot step over a line.
    const resuming = harvestAt.get(path);
    const { replies, offset, from } = readCodexLog(
      path,
      resuming ?? 0,
      resuming === undefined ? Date.parse(member.joinedAt) || 0 : 0,
    );
    codexHarvest.turns += 1;
    codexHarvest.published += replies.length;
    if (
      !codexHarvest.warned &&
      codexHarvest.published === 0 &&
      codexHarvest.turns >= CODEX_HARVEST_SUSPECT_AFTER
    ) {
      codexHarvest.warned = true;
      console.error(
        `⚠ codex harvest has read ${codexHarvest.turns} finished turns in a room and found` +
          " nothing to publish — its rollout format may have changed. Messages from Codex" +
          " are being lost silently.",
      );
    }
    // How far the batch was actually taken. A reply the room has no space for must be read
    // again later, and the byte cursor is what decides that: advancing it past a refusal
    // loses the answer for good, whether or not it was claimed. Per reply rather than per
    // batch, because keeping the whole batch for the sake of its tail re-reads the head —
    // and `claimCodexReply` only remembers the last CODEX_PUBLISHED_MEMORY, so a long
    // enough batch would publish its own beginning twice. Codex found both halves of this.
    // Seeded from where the read actually began, not from the old cursor: a rotated or
    // truncated log restarts at zero, and clamping to the previous offset would make the
    // bridge read the new file from the top over and over until it outgrew the old one.
    let handledThrough = from;
    for (const reply of replies) {
      // Capacity first, and a refusal stops the batch rather than skipping one of it:
      // publishing what came after would put Codex's answers in the room out of order.
      if (roomIsFull(found.room, Buffer.byteLength(reply.text ?? "", "utf8"))) break;
      if (!claimCodexReply(conversationId, reply)) { handledThrough = reply.endsAt; continue; }
      if (refuseToPublish(found.room, conversationId)) { handledThrough = reply.endsAt; continue; }
      const { text, routing } = routeCodexReply(found.room, reply.text);
      // Codex never sees a refusal, so the run is broken by not publishing rather than
      // by answering — the next brief tells it no seq followed, which is the signal it
      // has for anything that did not arrive.
      if (routing.kind === "reaction" && reactionRunExhausted(found.room)) { handledThrough = reply.endsAt; continue; }
      const published = publishMail(found.room, conversationId, text, null, true, routing);
      if (published?.seq) publishedForCodex.set(conversationId, published.seq);
      deliverMail(found.name, found.room, text, conversationId, published);
      handledThrough = reply.endsAt;
    }
    // Everything the room took, and not one byte more.
    //
    // With no replies at all the whole read is consumed — there was nothing to come back
    // for. With replies but none handled, the cursor is left exactly as it was found, and
    // on a first read that means leaving it *unset*: setting it to zero would turn the
    // next read from "everything since this session joined the room" into "everything in
    // the log", and publish answers Codex gave before it was ever in the room.
    if (replies.length === 0) {
      harvestAt.set(path, offset);
    } else if (handledThrough > from || resuming !== undefined) {
      harvestAt.set(path, handledThrough);
    }
  };

  // One Codex turn ending can arrive twice: once from the full hooks under the real
  // session id, and once from notify under `codex:<cwd>`, which it invents because it is
  // told nothing else. Random hookIds mean shouldEmitHookSignal cannot pair them, so they
  // are correlated stop-to-stop here: a notify stop waits briefly, and a full-hook stop
  // for the same directory inside that wait replaces it — whichever order they arrive in,
  // since Codex promises neither. The wait is the whole cost, and only notify pays it.
  //
  // Correlated on stops rather than on the hook having reported anything lately, because
  // "it sent an event" is not "its stop works" — a hook whose stop path is broken (an old
  // copy the bridge has started refusing, say) must not silence the notify that still
  // covers for it. And refused here rather than prevented in Settings: which adapters are
  // installed can be changed from outside the app entirely, so the only place the
  // duplicate can be ruled out is where both signals arrive.
  const NOTIFY_STOP_HOLD_MS = 1_500;
  const CODEX_STOP_ECHO_MS = 5_000;
  const codexStopAtByCwd = new Map();
  const heldNotifyStopByCwd = new Map();

  const emitHookStop = (data = {}) => {
    const now = Date.now();
    const scope = tracker.hookScope(data, now);
    if (data.source === "codex-notify" && scope.cwd) {
      if (now - (codexStopAtByCwd.get(scope.cwd) ?? 0) <= CODEX_STOP_ECHO_MS) return;
      // A second notify inside the hold is the same turn again; the held one covers it.
      if (heldNotifyStopByCwd.has(scope.cwd)) return;
      const timer = setTimeout(() => {
        heldNotifyStopByCwd.delete(scope.cwd);
        finishHookStop(data, scope, Date.now());
      }, NOTIFY_STOP_HOLD_MS);
      timer.unref?.();
      heldNotifyStopByCwd.set(scope.cwd, timer);
      return;
    }
    // A stop can be the first thing the bridge ever hears from a session — a restart
    // mid-turn loses the ingest events the provider map is normally learned from — so a
    // stop that names its own runtime is believed. Naming a runtime is what opens the
    // Codex harvest and dedupe paths; the machine token is what makes the claim
    // believable, and the route now refuses the call outright without it, so there is no
    // longer an untrusted stop to guard against here. This is also what lets
    // finishHookStop harvest a Codex turn the bridge has no history for.
    if (data.sourceKind === "codexCliHook" && typeof scope.conversationId === "string" && scope.conversationId.length > 0) {
      providerByConversation.set(scope.conversationId, "codexCliHook");
    }
    if (scope.cwd && providerByConversation.get(scope.conversationId) === "codexCliHook") {
      codexStopAtByCwd.set(scope.cwd, now);
      const held = heldNotifyStopByCwd.get(scope.cwd);
      if (held) { clearTimeout(held); heldNotifyStopByCwd.delete(scope.cwd); }
      for (const [cwd, at] of codexStopAtByCwd) {
        if (now - at > CODEX_STOP_ECHO_MS) codexStopAtByCwd.delete(cwd);
      }
    }
    finishHookStop(data, scope, now);
  };

  const finishHookStop = (data, scope, now) => {
    if (!tracker.shouldEmitHookSignal("turn_complete", scope, data, now)) return;
    emitLocal({
      version: PROTOCOL_VERSION, id: randomUUID(), type: "turn_complete",
      timestamp: new Date().toISOString(), ...scope,
      data: {
        hookEventName: typeof data.hookEventName === "string" ? data.hookEventName : "Stop",
        source: typeof data.source === "string" ? data.source : "hook",
        message: typeof data.message === "string" ? data.message : null,
        // A hook that reports its own usage is believed; Codex reports none, so its log
        // is read instead. Only for Codex — the others put real numbers in the payload.
        usage: data.usage && typeof data.usage === "object"
          ? data.usage
          : providerByConversation.get(scope.conversationId) === "codexCliHook"
            ? codexUsageFor(scope.conversationId)
            : null,
      },
    });

    // A Codex turn ending is the only signal that it has said something, and until now
    // its words were only collected while a harvest happened to be running — which
    // started only when somebody pushed a message to it. Told to speak by its own user,
    // it wrote a perfectly good reply that reached nobody. Its log is read on every turn
    // it completes, so what it says in a room arrives whoever prompted it.
    if (providerByConversation.get(scope.conversationId) === "codexCliHook") {
      harvestCodexTurn(scope.conversationId);
    }
  };

  const emitHookAttention = (data = {}) => {
    const now = Date.now();
    const scope = tracker.hookScope(data, now);
    const isNotificationHook = data.hookEventName === "Notification";
    if (isNotificationHook && scope.cwd && now - (tracker.recentCompletionAtByCwd.get(scope.cwd) ?? 0) <= 15_000) return;
    if (!tracker.shouldEmitHookSignal("attention_requested", scope, data, now)) return;
    emitLocal({
      version: PROTOCOL_VERSION, id: randomUUID(), type: "attention_requested",
      timestamp: new Date().toISOString(), ...scope,
      data: {
        hookEventName: typeof data.hookEventName === "string" ? data.hookEventName : "PermissionRequest",
        source: typeof data.source === "string" ? data.source : "hook",
        kind: isNotificationHook ? "question" : "approval",
        toolName: typeof data.toolName === "string" ? data.toolName : null,
        message: typeof data.message === "string" ? data.message : null,
      },
    });
  };

  /**
   * The pages allowed to call this bridge from a browser.
   *
   * `*` let any page a person had open reach a server on their own loopback — the one
   * thing a same-origin policy exists to stop. Only two pages ever legitimately do:
   * the packaged app's webview, and the dev server the same renderer runs from.
   *
   * `tauri://localhost` is what Tauri gives a macOS webview whose content is bundled
   * (`tauri_protocol_url`, tauri 2.11.2 — Windows and Android get `http://tauri.localhost`
   * instead, and this app is macOS only). The dev port is `vite.config.ts`'s, which sets
   * `strictPort: true`, so it is this number or the dev server does not come up at all;
   * both spellings of loopback are listed because the browser sends whichever the URL bar
   * holds.
   */
  const VITE_DEV_PORT = 47622;
  const ALLOWED_ORIGINS = new Set([
    "tauri://localhost",
    `http://127.0.0.1:${VITE_DEV_PORT}`,
    `http://localhost:${VITE_DEV_PORT}`,
  ]);

  /**
   * What a caller with no `Origin` at all is: not a browser.
   *
   * Every adapter, every hook and the whole native side reach the bridge over plain
   * HTTP from a process, and send no Origin. Refusing those would take the bridge off
   * the air; they are also not the thing CORS defends against, which is a page acting
   * with a person's browser behind it.
   */
  const corsHeadersFor = (req) => {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || origin.length === 0) return {};
    if (!ALLOWED_ORIGINS.has(origin)) return null;
    return {
      "access-control-allow-origin": origin,
      // Reflected rather than fixed, so anything that caches a response cannot serve it
      // to a page from the other allowed origin.
      vary: "origin",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, accept, x-gyredeck-token",
    };
  };

  /**
   * Say a refused origin once, and only ever a few of them.
   *
   * Silence here is the expensive failure: if the allowlist is ever wrong, the renderer
   * stops working and looks like a dead bridge with nothing anywhere saying why. One line
   * naming the origin turns that into a five-second diagnosis. Bounded because the trigger
   * is a stranger's to pull.
   */
  const refusedOrigins = new Set();
  const noteRefusedOrigin = (origin) => {
    if (refusedOrigins.has(origin) || refusedOrigins.size >= 8) return;
    refusedOrigins.add(origin);
    console.error(`gyredeck: refused a browser request from origin ${JSON.stringify(origin)}`);
  };

  // Said to a person, not to a program: a hook that stops working is noticed by whoever
  // is at the terminal, and the one thing they need to know is that reinstalling it fixes
  // this. Adapters have carried the token since v1.15.0; older copies left behind by an
  // update are exactly what the staleness check already names in Settings.
  const ROOM_PASSWORD_HINT =
    "This room needs its own password. Ask the person at this terminal for it, then send it as the x-gyredeck-token header.";

  const TOKEN_HINT =
    "This call must carry the machine token from ~/.config/gyredeck/gyredeck.ingest-token" +
    " in the x-gyredeck-token header. If this is an agent hook, reinstall it from" +
    " Settings → Plugins (or run `pnpm hooks:install`) — older copies do not send it.";

  /**
   * Refuse a hook mutation that does not carry the machine token, and say so.
   *
   * Every mutation shares one gate rather than each route testing for itself, because
   * the route that forgot was the whole hole: /hook/attention never read the header at
   * all, and the two beside it read it only to decide how much of the payload to
   * believe. Returns true when the request has been answered and the caller must stop.
   */
  const refuseHookCall = (res, req) => {
    if (holdsMachineToken(req.headers["x-gyredeck-token"])) return false;
    res.writeHead(401, { "content-type": "application/json; charset=utf-8", ...(corsHeadersFor(req) ?? {}) });
    res.end(JSON.stringify({ ok: false, error: "unauthorized", message: TOKEN_HINT }));
    return true;
  };

  const readJsonBody = (req) =>
    new Promise((resolve) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 16_384) { req.destroy(); resolve({}); }
      });
      req.on("end", () => {
        if (!body.trim()) { resolve({}); return; }
        try { resolve(JSON.parse(body)); } catch { resolve({}); }
      });
      req.on("error", () => resolve({}));
    });

  // Which agent runtime owns a conversation, learned from the events it sends.
  // A mail room is named after a conversation, and delivery is not the same for every
  // agent: Codex takes a queued message and wakes to read it, while the others are
  // handed theirs by their own hook on their next turn.
  const providerByConversation = new Map();
  // A member is addressed by conversation id, which says nothing a person or an agent
  // can read. The runtime kind the events carry is the only name available.
  const PROVIDER_LABELS = {
    claudeCodeHook: "Claude Code",
    codexCliHook: "Codex",
    "codex-notify": "Codex",
    codex: "Codex",
    agyHost: "Antigravity",
  };
  /**
   * The workspace a session is working in, which is what tells two of the same agent
   * apart. "Codex" and "Codex" in one room name nobody; "Codex · J-Kitz" and
   * "Codex · AD1" name two particular sessions, and they are the names the person
   * already uses for them.
   */
  const workspaceByConversation = new Map();

  const workspaceFor = (conversationId) => {
    const cwd = workspaceByConversation.get(conversationId);
    if (typeof cwd !== "string" || cwd.length === 0) return null;
    const leaf = cwd.split("/").filter(Boolean).pop();
    return leaf && leaf.length > 0 ? leaf : null;
  };

  /**
   * The name a member goes by in one room, chosen once when it arrives.
   *
   * Chosen rather than derived. A name computed from whoever happens to be present is
   * a different name at different moments: one session picks up several across a
   * transcript with nothing linking them, and a question about what "Codex" said an
   * hour ago has no answer. Deciding at the door costs an asymmetry — whoever arrived
   * first keeps the short name — and buys a name that still means the same session
   * later, which is the property that cannot be repaired after the fact.
   *
   * It also retires the argument that kept being got wrong. There is no member set to
   * pass any more, only a field to read, so a call site cannot name a member from the
   * wrong moment — which is what three of them were doing.
   */
  const allocateLabel = (room, conversationId) => {
    const taken = new Set();
    for (const member of room.members.values()) if (member.label) taken.add(member.label);
    const former = room.formerLabels.get(conversationId);
    if (former && !taken.has(former)) return former;
    const provider = providerLabelFor(conversationId);
    const workspace = workspaceFor(conversationId);
    // Shortest first: a lone Codex is "Codex", the second one to arrive in another
    // checkout is "Codex · AD1", and a second one in the same checkout takes an id.
    const candidates = workspace ? [provider, `${provider} · ${workspace}`] : [provider];
    for (const candidate of candidates) if (!taken.has(candidate)) return candidate;
    // An id means nothing to a person, which is why it is last. It still beats a name
    // that points at two sessions at once: a request to one would read as a request to
    // the other.
    const longest = candidates[candidates.length - 1];
    const short = `${longest} #${conversationId.slice(0, 6)}`;
    return taken.has(short) ? `${longest} #${conversationId}` : short;
  };

  /**
   * Take a member out of a room, keeping the name it was known by.
   *
   * The name outlives the membership on purpose: the notices that announce a departure
   * are written after it, and a resumed session put back in the room should not come
   * back under a different name. What does not outlive it is the harvest cursor —
   * that belongs to a membership, and a rejoin should read from where the room is now.
   */
  const retireLabel = (room, conversationId) => {
    const member = room.members.get(conversationId);
    if (member?.label) room.formerLabels.set(conversationId, member.label);
    room.members.delete(conversationId);
    harvestAt.delete(codexRolloutFor(conversationId) ?? "");
  };

  /**
   * Tell the session that was just let in, not only the room it was let into.
   *
   * The roster announcement is state and wakes nobody, which is right — and left the
   * one session that most needed to know entirely uninformed. Codex sat asking for a
   * password it had already been given and could not have used, because being confirmed
   * had been announced to everyone except it.
   */
  const tellConfirmed = (name, room, conversationId) => {
    const mailbox = mailRoomFor(conversationId, true);
    if (!mailbox) return;
    const text =
      `[Gyredeck: you are confirmed in room ${name} and may speak here now. Reply to this` +
      " with a reaction so the person at this terminal can see that it took: a reaction" +
      " is a short line saying where this leaves you, it interrupts nobody, and nothing" +
      " answers it.]";
    const told = publishMail(mailbox, ROOM_SENDER, text, null, false, { to: conversationId, kind: "tell" });
    deliverMail(conversationId, mailbox, text, ROOM_SENDER, told);
  };

  /**
   * What to call a session in this room, whether or not it is still in it.
   *
   * Falling back through the names the room has retired is what makes the departure
   * notices safe: they used to name the leaver from the membership it had just been
   * removed from, and so named whoever was left instead.
   */
  const labelIn = (room, conversationId) =>
    room.members.get(conversationId)?.label ??
    room.formerLabels.get(conversationId) ??
    providerLabelFor(conversationId);

  const providerLabelFor = (conversationId) =>
    PROVIDER_LABELS[providerByConversation.get(conversationId)] ?? "Agent";
  const rememberProvider = (payload) => {
    const conversationId = payload?.conversationId;
    const sourceKind = payload?.runtime?.sourceKind;
    if (typeof conversationId === "string" && typeof sourceKind === "string") {
      providerByConversation.set(conversationId, sourceKind);
    }
    if (typeof conversationId === "string" && typeof payload?.cwd === "string") {
      workspaceByConversation.set(conversationId, payload.cwd);
    }
  };

  /**
   * Whether this bridge is allowed to start an agent CLI at all.
   *
   * A test suite must not launch the user's real agents. The hook tests point `HOME` at a
   * `mkdtemp` directory and spawn this bridge against it; `deliverToCodex` then ran the
   * real `codex`, which inherited that fake `HOME` and scaffolded `~/.codex/skills/…` into
   * it while the test's own cleanup was deleting the directory — `ENOTEMPTY`, about one run
   * in eight. The flake was the smaller half: running somebody's agent as a side effect of
   * `pnpm test:hooks` is the part that should never have been possible.
   *
   * Read once, because a switch that can change under a running bridge is a second state to
   * reason about for no gain.
   */
  const agentSpawnAllowed = process.env.GYREDECK_NO_AGENT_SPAWN !== "1";

  // Locate an agent CLI the way the desktop app locates node: a process launched from
  // Finder or Spotlight does not inherit the shell's PATH, so the usual install
  // directories have to be searched explicitly.
  //
  // This is the only door to spawning one, and every caller already handles "not found" —
  // so refusing here covers any agent added later, rather than this one command.
  const agentBinaryCache = new Map();
  const findAgentBinary = (name) => {
    if (!agentSpawnAllowed) return null;
    if (agentBinaryCache.has(name)) return agentBinaryCache.get(name);
    const directories = [
      join(homedir(), ".bun", "bin"),
      join(homedir(), ".nvm", "current", "bin"),
      join(homedir(), ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      ...(process.env.PATH ?? "").split(":"),
    ];
    let found = null;
    for (const directory of directories) {
      if (!directory) continue;
      const candidate = join(directory, name);
      try {
        if (statSync(candidate).isFile()) { found = candidate; break; }
      } catch {}
    }
    agentBinaryCache.set(name, found);
    return found;
  };

  // Events already on disk tell us who owns which conversation, so a bridge that has
  // just restarted can still route a message without waiting for fresh activity.
  for (const payload of recent) rememberProvider(payload);

  const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
  const CODEX_REPLY_TIMEOUT_MS = 120_000;
  const CODEX_REPLY_POLL_MS = 1_000;

  /** Newest rollout log for a Codex thread, or null when the session is unknown. */
  const codexRolloutFor = (threadId) => {
    let newest = null;
    try {
      for (const entry of readdirSync(CODEX_SESSIONS_DIR, { recursive: true })) {
        const name = String(entry);
        if (!name.endsWith(".jsonl") || !name.includes(threadId)) continue;
        const path = join(CODEX_SESSIONS_DIR, name);
        const at = statSync(path).mtimeMs;
        if (!newest || at > newest.at) newest = { path, at };
      }
    } catch {}
    return newest?.path ?? null;
  };

  /**
   * What Codex said after `sinceMs`, read from its own log rather than asked of it.
   *
   * Replying through the bridge would mean running a shell command, and Codex asks the
   * user to approve each one — the message text is part of the command, so no approval
   * is ever reused. Reading `task_complete` costs nothing and needs no permission: the
   * whole answer is one field, already bounded to a turn.
   */
  /**
   * Replies already put in a room, per Codex thread.
   *
   * Each delivery starts its own harvest with its own window, and windows overlap: a
   * room notice and a question sent moments apart both see the one answer Codex
   * writes, and both publish it. Deduplication therefore cannot live inside a single
   * harvest — it has to be per thread, outliving any one of them.
   */
  const codexPublished = new Map();
  const CODEX_PUBLISHED_MEMORY = 64;

  const claimCodexReply = (threadId, reply) => {
    let published = codexPublished.get(threadId);
    if (!published) {
      published = new Set();
      codexPublished.set(threadId, published);
    }
    // Both, because a retried turn repeats the text under a new id, and a re-read of
    // the log repeats the id with the same text.
    const key = `${reply.turnId ?? ""}\u0000${reply.text}`;
    if (published.has(key)) return false;
    published.add(key);
    // Bounded: a long-lived thread must not grow this without limit. The oldest keys
    // are the least likely to reappear, so dropping them first is safe.
    if (published.size > CODEX_PUBLISHED_MEMORY) {
      const excess = published.size - CODEX_PUBLISHED_MEMORY;
      let dropped = 0;
      for (const stale of published) {
        published.delete(stale);
        if (++dropped >= excess) break;
      }
    }
    return true;
  };

  /** One line of a Codex rollout as a reply, or null when the line is anything else. */
  const codexReplyFromLine = (line, sinceMs) => {
    if (!line.trim()) return null;
    let entry;
    try { entry = JSON.parse(line); } catch { return null; }
    if (entry.type !== "event_msg" || entry.payload?.type !== "task_complete") return null;
    const text = entry.payload.last_agent_message;
    if (typeof text !== "string" || !text.trim()) return null;
    const at = Date.parse(entry.timestamp ?? "");
    if (Number.isFinite(at) && at < sinceMs) return null;
    return { turnId: entry.payload.turn_id ?? null, text: text.trim() };
  };

  const readCodexReplies = (rolloutPath, sinceMs) => {
    const replies = [];
    let content = "";
    try { content = readFileSync(rolloutPath, "utf8"); } catch { return replies; }
    for (const line of content.split("\n")) {
      const reply = codexReplyFromLine(line, sinceMs);
      if (reply) replies.push(reply);
    }
    return replies;
  };

  /**
   * Everything Codex has said past `offset`, and the offset to resume from next time.
   *
   * A byte cursor rather than a clock, because this one advances and a clock cannot
   * advance safely: the old cursor moved to "now" before the file was read, so a line
   * flushed a moment late fell below the next read's floor and was never published. The
   * per-thread claim stops a reply being said twice; nothing stopped one being skipped.
   *
   * Only whole lines are consumed. A log caught mid-write ends in a partial line, and
   * the returned offset stops in front of it so the next read sees it complete.
   */
  const readCodexLog = (rolloutPath, offset, sinceMs) => {
    let size = 0;
    try { size = statSync(rolloutPath).size; } catch { return { replies: [], offset, from: offset }; }
    // A file smaller than its cursor was rotated or rewritten, and the cursor now points
    // into a log that no longer exists.
    const from = offset > size ? 0 : offset;
    if (from >= size) return { replies: [], offset: size, from };
    let chunk = "";
    let fd = null;
    try {
      fd = openSync(rolloutPath, "r");
      const buffer = Buffer.allocUnsafe(size - from);
      const read = readSync(fd, buffer, 0, buffer.length, from);
      // Safe to decode from here: an offset only ever lands just past a newline, so it
      // never cuts a multi-byte character in half.
      chunk = buffer.subarray(0, read).toString("utf8");
    } catch {
      return { replies: [], offset, from };
    } finally {
      if (fd !== null) { try { closeSync(fd); } catch {} }
    }
    const lastBreak = chunk.lastIndexOf("\n");
    if (lastBreak < 0) return { replies: [], offset: from, from };
    const whole = chunk.slice(0, lastBreak);
    const replies = [];
    // Where each reply ends, so the caller can stop the cursor between two of them. A
    // batch can be taken in part — the room may have space for the first answer and not
    // the second — and one offset for the whole read cannot say that. Rereading the ones
    // already published is not free either: `claimCodexReply` remembers only the last
    // CODEX_PUBLISHED_MEMORY of them, so a long enough batch would republish its own head.
    let at = from;
    for (const line of whole.split("\n")) {
      at += Buffer.byteLength(line, "utf8") + 1;
      const reply = codexReplyFromLine(line, sinceMs);
      if (reply) replies.push({ ...reply, endsAt: at });
    }
    return { replies, offset: from + Buffer.byteLength(whole, "utf8") + 1, from };
  };

  // Mail rooms: a named channel for agents on this machine to talk to each other,
  // multiplexed onto the bridge port so no second listener has to be opened. A room
  // is just a key. Subscribers holding an SSE connection are pushed to immediately;
  // peers that can only check in periodically read the backlog instead, which is the
  // only workable shape for a hook process that lives for milliseconds and would
  // otherwise miss anything sent while its agent was idle.
  const MAIL_ROOM_NAME = /^[A-Za-z0-9_-]{1,64}$/;
  const MAIL_MAX_ROOMS = 32;
  const MAIL_MAX_TEXT = 4_096;
  const MAIL_MAX_FROM = 64;
  const MAIL_ROOM_IDLE_MS = 3_600_000;
  const MAIL_MAX_MEMBERS = 8;
  // A stream is closed after this long whether anything happened or not. A watcher
  // that is never hung up on outlives the reason it was armed: the room ends, the
  // session moves on, and the connection sits there proving nothing. Ending it on a
  // known schedule makes re-arming a decision someone takes again.
  const MAIL_STREAM_MAX_MS = 300_000;
  const MAIL_WAIT_DEFAULT_MS = 60_000;
  const MAIL_WAIT_MAX_MS = 300_000;
  const MAIL_MAX_WAITERS = 16;
  // Codes are read off one screen and typed into another, so the alphabet leaves out
  // characters that get confused by eye: 0/O, 1/l/I.

  /** A room code, as opposed to a conversation id used as a mailbox name. */
  const SYNC_CODE = /^sync-[a-z2-9]{4}$/;
  const mailRooms = new Map();

  // Rooms are created by whoever speaks first, so they need an upper bound and a way
  // to go away again; without both, any local process could grow this map forever.
  // The pass lives at module scope — see `sweepRooms`, including when it does and does
  // not run.
  const sweepMailRooms = () =>
    sweepRooms(mailRooms, Date.now(), { close: closeRoom, idleMs: MAIL_ROOM_IDLE_MS });

  const mailRoomFor = (name, create) => {
    const existing = mailRooms.get(name);
    if (existing) return existing;
    if (!create || mailRooms.size >= MAIL_MAX_ROOMS) return null;
    // readSeq is how far a reader has got. The reader's own cursor lives in the
    // adapter, which the app cannot see, so the room records what it has handed out
    // instead — that is what makes "still waiting to be picked up" observable.
    //
    // The room-level number is the furthest *anyone* has read. A room with members
    // also tracks each one separately, because two sessions reading at different
    // rates would otherwise share a single position and the slower one would lose
    // whatever the faster one collected.
    const room = {
      // Its own name, because everything that publishes into a room is handed the room
      // and not the key it is filed under, and a reverse lookup to recover the one from
      // the other is a scan that can disagree with itself.
      name,
      seq: 0,
      // Who pressed Create. Only they are offered the key, because handing out the
      // right to speak is the founder's act, not something any member can pass on.
      createdBy: null,
      // The room's password: one string, created with the room, presented in the
      // x-gyredeck-token header for every read and every send here. Password and token
      // are the same thing said two ways — it is a password to the person copying it
      // out of the panel, and a token to the header carrying it.
      password: null,
      readSeq: 0,
      messages: [],
      // The highest seq this room has dropped to stay inside its caps. A reader whose
      // cursor is below it has missed something, and is told so rather than handed a
      // short list it would read as "that was all".
      droppedThroughSeq: 0,
      clients: new Set(),
      members: new Map(),
      // Names already handed out in this room, kept past the member that held them.
      // A session is resumable and keeps its id, so one that leaves and is put back
      // is the same session — and a stable name that changes on return is not stable.
      formerLabels: new Map(),
      touchedAt: Date.now(),
    };
    mailRooms.set(name, room);
    return room;
  };

  // The seq doubles as the SSE event id, which is what lets a dropped subscriber
  // resume: EventSource replays the last id it saw back as Last-Event-ID.
  const mailFrame = (message) =>
    `id: ${message.seq}\nevent: mail\ndata: ${JSON.stringify(message)}\n\n`;

  /**
   * Read position for one reader of a room.
   *
   * A member gets its own; anyone reading without saying who they are shares the
   * room-level number, which is what a session's private mailbox has always used and
   * what the shipped adapters still expect.
   */
  const readerFor = (room, as) => (as && room.members.get(as)) || room;

  const markRead = (room, as, seq, at) => {
    const reader = readerFor(room, as);
    // Never backwards: re-reading from an older `since` has not un-taken anything.
    reader.readSeq = Math.max(reader.readSeq, seq);
    reader.lastReadAt = at;
    // The room-level number stays "the furthest anyone got", so a chip that does not
    // identify a reader still shows something truthful.
    room.readSeq = Math.max(room.readSeq, reader.readSeq);
    room.lastReadAt = at;
  };

  /** Which room a session has been put into, if any. A session belongs to at most one. */
  const syncRoomFor = (conversationId) => {
    for (const [name, room] of mailRooms) {
      if (room.members.has(conversationId)) return { name, room };
    }
    return null;
  };

  const describeRoom = (name, room, as) => ({
    room: name,
    seq: room.seq,
    members: (() => {
      return [...room.members].map(([conversationId, member]) => ({
        conversationId,
        provider: labelIn(room, conversationId),
        confirmed: member.confirmed === true,
        joinedAt: member.joinedAt,
        pending: Math.max(0, room.seq - member.readSeq),
        lastReadAt: member.lastReadAt ?? null,
      }));
    })(),
    you: as && room.members.has(as) ? as : null,
    // Named rather than inferred: a confirmed joiner looks identical to a founder from
    // the outside, and only the founder may hand out the right to speak.
    founder: room.createdBy ?? null,
  });

  /**
   * Sender used when the room itself has something to say.
   *
   * Reserved rather than a member id: a membership change is a fact about the room, not
   * a request from a peer, and the framing an agent gets has to be able to tell those
   * apart. It reuses the message path so the news travels the way everything else does
   * — instantly for Codex, on the next turn for the others.
   */


  /**
   * Tell a session it is out, and cut anything it left running.
   *
   * The notice cannot go to the room — it is no longer allowed to read it — so it goes
   * to the session's own mailbox, where its next drain will find it, and is pushed to
   * Codex, which has no drain. Any stream it holds on this room is ended here rather
   * than left to fail quietly on the next message: a watch that outlives its membership
   * looks exactly like a quiet room.
   */
  /**
   * End a room: tell every member, cut every stream, then drop it — in that order.
   *
   * A room deleted first has no members left to tell and no streams left to find. Called
   * both by the close button and by the founder leaving, because a room without its
   * founder is not a room anybody can go on using: nobody can be let into it (`/passwords`
   * answers `not_the_founder` to everyone left) and nobody can close it either, since the
   * app asks as itself and gets the same refusal. It became a code that could only be
   * abandoned.
   */
  const closeRoom = (name, room, why) => {
    for (const conversationId of [...room.members.keys()]) {
      retireLabel(room, conversationId);
      partWithMember(name, room, conversationId, why);
    }
    // Anything still holding the stream that was not a member — nothing should be, but a
    // socket outliving its membership is exactly the bug this guards.
    for (const res of [...room.clients]) {
      try {
        res.write(`: gyredeck room ${name} closed\n\n`);
        res.end();
      } catch {
        // Already gone.
      }
    }
    room.clients.clear();
    mailRooms.delete(name);
  };

  const partWithMember = (name, room, conversationId, why) => {
    for (const res of [...room.clients]) {
      if (res.gyredeckWatcher !== conversationId) continue;
      try {
        res.write(`: gyredeck removed from room ${name}\n\n`);
        res.end();
      } catch {
        // Already gone; its close handler has cleaned up.
      }
      room.clients.delete(res);
    }
    const mailbox = mailRoomFor(conversationId, true);
    if (!mailbox) return;
    const text =
      `[Gyredeck: you are no longer in room ${name} — ${why}. You can neither read it` +
      " nor post to it now, and its password will not let you back in. This is one of" +
      " the two messages that end a watch on that room: stop yours and do not open" +
      " another, since it has been closed from this end and re-opening will be refused." +
      " Nothing about this room will reach you again unless someone puts you back in" +
      " it.]";
    const told = publishMail(mailbox, ROOM_SENDER, text, null, false, { to: conversationId, kind: "tell" });
    deliverMail(conversationId, mailbox, text, ROOM_SENDER, told);
  };

  /**
   * Tell a session, in its own mailbox, that it has been put in a room.
   *
   * The room itself cannot carry this: a member that has not been confirmed cannot read
   * the room, so an announcement posted there is invisible to exactly the session that
   * needs it. Without this a session first learns of a room when a password arrives
   * with no explanation of what it is for — which is what happened to Codex, told a
   * secret for a room it did not know it was in.
   */
  const tellJoined = (name, room, conversationId, how) => {
    const mailbox = mailRoomFor(conversationId, true);
    if (!mailbox) return;
    const confirmed = room.members.get(conversationId)?.confirmed === true;
    const others = [...room.members.keys()].filter((id) => id !== conversationId);
    const company = others.length > 0
      ? ` Also here: ${others.map((id) => labelIn(room, id)).join(", ")}.`
      : " Nobody else is in it yet.";
    const text =
      `[Gyredeck: you are now in sync room ${name} — ${how}.${company}` +
      // What the password is for differs by what this session can do with it. Codex
      // cannot open a stream and cannot call the bridge at all, so for it the password
      // really is somebody else's business. Everyone else needs it in hand: it is the
      // header on every call about this room, the watch included.
      (providerByConversation.get(conversationId) === "codexCliHook"
        ? confirmed
          ? " You can read it and post to it already, and messages are pushed into your" +
            " session, so there is nothing to set up. The room's password is what the" +
            " person hands to another session so that one can join; a long string of hex" +
            " arriving here is that, and there is nothing for you to do with it."
          : " You cannot read or post there yet. The person at this terminal will be" +
            " given the room's password, and you are let in the moment they read it out" +
            " — you do not present it yourself and there is nothing to run."
        : confirmed
          ? " You can read it and post to it, but you need the room's password in hand to" +
            " do either: it is the x-gyredeck-token header on every call about this room," +
            " including the watch you should be running on it. A long string of hex" +
            " arriving in this terminal is that password."
          : " You cannot read or post there yet: that needs the room's password, which the" +
            " person at this terminal has to give you. A long string of hex arriving with" +
            " no explanation is it — present it, and then keep a watch on the room.") +
      "]";
    const told = publishMail(mailbox, ROOM_SENDER, text, null, false, { to: conversationId, kind: "tell" });
    deliverMail(conversationId, mailbox, text, ROOM_SENDER, told);
  };

  /**
   * What a session can do in a room, written where it will actually be read.
   *
   * A confirm is a call the session makes itself and reads the answer to, so it is the
   * one place an instruction is certain to land — anything a hook injects arrives a turn
   * later, by which point the session has usually guessed. The commands come with the
   * password already in them: a session that just presented it plainly has it.
   */
  const howToUseRoom = (name, password, conversationId, host, port) => ({
    credential: {
      header: "x-gyredeck-token",
      value: password,
      note:
        "This room's own password, on every call below. Another room's password will not" +
        " open this one, and reading this room takes this password and nothing else.",
    },
    identity: {
      as: conversationId,
      note:
        "Name yourself with this wherever a call takes `as` or `from`. A stream without" +
        " it is refused; a message without it is not attributed to you.",
    },
    send: {
      what: "Post a message everyone in the room sees.",
      method: "POST",
      url: `http://${host}:${port}/mail/${name}`,
      body: {
        from: conversationId,
        text: "<your message, plain text>",
        replyTo: conversationId,
      },
      command:
        `curl -s -X POST http://${host}:${port}/mail/${name}` +
        ` -H 'content-type: application/json' -H 'x-gyredeck-token: ${password}'` +
        ` -d '{"from":"${conversationId}","text":"YOUR TEXT","replyTo":"${conversationId}"}'`,
      success: '{"ok":true,"seq":<number>} — the seq is the room-wide sequence of your message.',
      failure: {
        403: "not_a_member or not_confirmed — you are out of the room, or have not presented its password.",
        400: "invalid_message — from or text missing.",
      },
      rule:
        "Treat a send as failed unless you saw ok:true and a seq. A refused POST prints" +
        " little or nothing, and reporting a message you did not send is worse than" +
        " reporting nothing.",
    },
    receive: {
      what: "Each message arrives as one Server-Sent Event on the stream below.",
      frame: "id: <seq>\\nevent: mail\\ndata: <json>\\n\\n",
      dataShape: {
        seq: "<number> — room-wide, increasing; the resume point",
        from: "<conversationId of the sender, or gyredeck-room for the room itself, or gyredeck for the person>",
        text: "<the message>",
        replyTo: "<where to answer, usually the sender>",
        ts: "<ISO timestamp>",
      },
      note:
        "Ignore frames whose from is your own id — your posts come back on your own" +
        " stream. Frames from gyredeck-room are facts about membership, not requests.",
    },
    watch: {
      what: "Be woken when a message arrives, rather than waiting to be typed at.",
      method: "GET",
      url: `http://${host}:${port}/mail/${name}/events?as=${conversationId}`,
      command:
        `curl -sN "http://${host}:${port}/mail/${name}/events?as=${conversationId}"` +
        ` -H 'x-gyredeck-token: ${password}'`,
      runner:
        "Run it with a facility that turns each line into a notification while the" +
        " command is still running. A plain background job will not do: most report only" +
        " when the process exits, and a working stream never exits — the messages land" +
        " in a file and nothing reaches you. If that is all you have, say so rather than" +
        " arming it, because the failure is silent and looks like a quiet room.",
      lifetime:
        "Keep exactly one running for as long as you are in the room, not only while" +
        " awaiting a reply. The stream closes after five minutes and says so first;" +
        " that is routine — reopen at once.",
      resume:
        `Reopen with &since=<the last seq you saw>, e.g.` +
        ` .../mail/${name}/events?as=${conversationId}&since=12 . Without it the new` +
        " stream starts from now and anything published in the gap is lost silently.",
      stop:
        "Stop for good on either of two messages, and only those: the room was closed," +
        " or you were disconnected from it.",
    },
    wait: {
      what: "Block inside this turn for an answer you need before you can carry on.",
      method: "GET",
      url: `http://${host}:${port}/mail/wait?as=${conversationId}&timeout=60&collect=1`,
      command:
        `curl -s "http://${host}:${port}/mail/wait?as=${conversationId}&timeout=60&collect=1"` +
        ` -H 'x-gyredeck-token: ${password}'`,
      success: '{"ok":true,"timedOut":false,"messages":[...]} — same message shape as the stream.',
      rule:
        "Only while an answer is genuinely outstanding. It answers timedOut:true if" +
        " none arrives; one wait at a time per session, a second is refused.",
    },
  });

  const announceMembership = (name, room, note) => {
    const present = [...room.members.keys()].map((id) => labelIn(room, id));
    const text = `${note} Members now: ${present.join(", ") || "nobody"}.`;
    const notice = publishMail(room, ROOM_SENDER, text, null);
    // A room notice is published and readable but wakes nobody: the roster it carries
    // already rides on every message Codex is handed, so interrupting three sessions to
    // repeat it is pure cost. This was measured — a join and a confirmation woke every
    // member twice inside six seconds, and one of them answered each time.
    deliverMail(name, room, text, ROOM_SENDER, notice);
  };


  // Thirty-two hex characters, the length and shape of an MD5 digest. A room code is a
  // name people say to each other and is kept short for that; this is the thing that
  // grants the right to speak, and nobody types it — it is copied from the panel and
  // pasted into a terminal — so length costs nothing and buys the difference between
  // fifty bits and a hundred and twenty-eight.
  const newRoomPassword = () => randomBytes(16).toString("hex");

  const newSyncCode = () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const suffix = Array.from({ length: 4 }, syncCodeChar).join("");
      const code = `sync-${suffix}`;
      if (!mailRooms.has(code)) return code;
    }
    return null;
  };

  /**
   * Readers holding a long poll open, waiting for something addressed to them.
   *
   * A session that has just asked a room-mate for something it needs in order to
   * continue would otherwise have to end its turn and wait to be typed at again. This
   * lets it wait inside the turn instead — the answer comes back as the result of the
   * call it is already blocked on. Bounded on purpose: this is one wait for one
   * outstanding answer, not a listen loop holding a session open indefinitely.
   */
  const mailWaiters = new Set();

  /**
   * The body both inbox reads answer with.
   *
   * Room and members travel with the messages because the caller is a hook with a
   * sub-second budget and would otherwise need a second request to know who it is
   * talking to.
   */
  const describeInbox = (messages, sync, as, missed = []) => ({
    messages,
    // Only when something was actually lost. An empty field on every answer is noise
    // that teaches readers to skip the one time it matters.
    ...(missed.length > 0
      ? {
          missed,
          missedNote:
            "Messages addressed to you were dropped before you collected them: the room filled up. " +
            "They cannot be recovered. Ask whoever was speaking to repeat anything you needed.",
        }
      : {}),
    ...(sync
      ? {
          room: sync.name,
          members: (() => {
            return [...sync.room.members].map(([conversationId, member]) => ({
              conversationId,
              provider: labelIn(sync.room, conversationId),
              confirmed: member.confirmed === true,
              you: conversationId === as,
            }));
          })(),
        }
      : { room: null, members: [] }),
  });

  const wakeMailWaiters = () => {
    // Every waiter re-checks rather than being told what changed. There are at most a
    // handful, and the alternative — working out which readers a publish affected —
    // duplicates the merge logic the inbox already owns.
    for (const waiter of [...mailWaiters]) waiter.check();
  };

  /**
   * Publish order across every room, which `seq` cannot give.
   *
   * `seq` counts within one room, so merging two rooms and tie-breaking on it compares
   * numbers that mean different things — a room's second message can sort ahead of
   * another room's first. Timestamps alone are not enough either: several messages
   * routinely land in the same millisecond.
   */
  let mailOrdinal = 0;

  /**
   * Whether a sender may speak in this room, or null when it may.
   *
   * This lives with publishing rather than with the HTTP route because publishing has
   * more than one door. Codex never posts: the bridge reads its answer out of its own
   * log and publishes on its behalf, so a check on the POST handler let Codex speak in
   * a room nobody had confirmed it for — found by asking who had told Codex the
   * password, and the answer was that nobody had to.
   */
  /**
   * Whether a request carries this room's credential.
   *
   * The room's password, not the machine's token: every agent can read the ingest token
   * file, so that one proves only "this call came from this machine" and can never
   * carry the person's decision to let one particular session in. The room's password
   * is copied by hand from the founder's panel into the joining session's terminal.
   */
  const holdsRoomPassword = (room, headerValue) =>
    typeof room.password === "string" && matchesIngestToken(room.password, headerValue);

  /**
   * Whether a request carries the machine's own token.
   *
   * Verified, not noticed. The gate this replaced accepted any string at all, which made
   * every route behind it look guarded while proving nothing about the caller.
   */
  const holdsMachineToken = (headerValue) => matchesIngestToken(config.ingestToken, headerValue);

  /**
   * Whether a caller holds *a* credential that reaches a mailbox nobody was put into.
   *
   * Two callers are legitimate and they hold different things. A hook holds the machine
   * token, because that file is how it reaches the bridge at all. A session that has been
   * let into a room holds that room's password, which is what `howToUseRoom` puts in every
   * call it hands out. Either shuts out a process holding neither — and `collect=1` is
   * why that matters: it does not merely read the mail, it takes it, moving the cursor so
   * the session it was addressed to never sees it.
   *
   * What this cannot do is say *which* session is asking, so it is not yet the rule the
   * name `as` implies. Neither credential is per-session: the machine token is read by
   * every agent on this machine to make any call at all, and a room's password is shared
   * by everyone in that room, an ex-member who still remembers it included. So a peer can
   * still open a peer's mailbox. Closing that needs a per-session credential, which does
   * not exist yet — see `event-protocol.md`, "What a mailbox credential does not prove".
   */
  const holdsMailboxCredential = (mailboxName, headerValue) => {
    if (holdsMachineToken(headerValue)) return true;
    const sync = syncRoomFor(mailboxName);
    return sync ? holdsRoomPassword(sync.room, headerValue) : false;
  };

  /**
   * Why a room people were put into may not be read: its own password, and still being in
   * it. The password alone is not enough — a session that has been disconnected still
   * remembers it.
   *
   * One rule, because it was written twice and the two copies had already drifted: the
   * stream applied it and the backlog read beside it applied nothing, so a whole room
   * could be read by a caller that only had to send the header non-empty.
   */
  const refuseRoomRead = (room, headerValue, as, verb) => {
    if (room.members.size === 0) return null;
    if (!holdsRoomPassword(room, headerValue)) {
      return { error: "not_confirmed", message: ROOM_PASSWORD_HINT };
    }
    if (!as || room.members.get(as)?.confirmed !== true) {
      return {
        error: "not_a_member",
        message: `Name yourself with ?as=<conversationId>; only a confirmed member of this room may ${verb} it.`,
      };
    }
    return null;
  };

  const refuseToPublish = (room, from) => {
    if (room.members.size === 0) return null;
    if (from === ROOM_SENDER) return null;
    const sender = room.members.get(from);
    if (!sender) return "not_a_member";
    if (sender.confirmed !== true) return "not_confirmed";
    return null;
  };

  /**
   * What a message is for, declared by whoever sends it.
   *
   * The room cannot judge whether a message deserves to interrupt anyone — only the
   * sender knows that — and asking every reader to judge it instead was tried and
   * failed: told never to acknowledge, two agents acknowledged each other until the
   * room had to be closed. Neither was breaking the rule as it understood it. Saying it
   * once, in a field, is something a sender can actually do.
   *
   * `ask` and `tell` reach whoever they are addressed to. `ack` reaches the room and
   * nobody's attention, which is what makes it harmless — the point was never that
   * acknowledgements should not exist, only that they should not cost a turn. `notice`
   * is the room speaking about itself; the roster it carries already rides on every
   * message Codex is handed, so waking anyone for it buys nothing.
   */
  const MAIL_KINDS = new Set(["ask", "tell", "reaction", "notice"]);
  /**
   * What may be said back, which is as much of the design as what may be sent.
   *
   * An `ask` is answered. A `tell` may be answered with a `reaction` and nothing more,
   * and so may a `notice` — a member told that somebody joined or left may want to say
   * what that means for it, and the person watching wants to see that it noticed. A
   * `reaction` ends there. Without that last clause the pair is a conversation again:
   * the loop that closed a room was two agents each answering what the other had merely
   * said.
   *
   * There was briefly an `ack` beside `reaction` and it earned nothing: same routing,
   * same terminal position, differing only in that one was defined to carry no content.
   * A reaction says the same thing and says it usefully, because the person watching a
   * terminal is the audience and the framing already asks a session to show what it
   * sent. `ack` is still accepted on the wire and read as a reaction — dropping it would
   * turn every acknowledgement already in flight into the loud default, which is the one
   * direction this must never fail in.
   */
  const MAIL_TERMINAL_KINDS = new Set(["reaction"]);
  const asKind = (value) => (value === "ack" ? "reaction" : value);
  /**
   * How many reactions may follow one another before the room stops taking them.
   *
   * A reaction is where an exchange is supposed to stop, and saying so is an
   * instruction — the kind that failed twice today. This is the same rule with something
   * behind it. Ordinary use never comes near: a tell answered by a reaction is one in a
   * row, and three sessions each reacting to the same notice is three. A fourth means
   * reactions are being answered with reactions, which is the shape of the loop that
   * closed a room, and it is refused with the reason rather than absorbed.
   */
  const MAIL_MAX_REACTION_RUN = 3;
  const reactionRunExhausted = (room) => {
    let run = 0;
    for (let index = room.messages.length - 1; index >= 0; index -= 1) {
      if (room.messages[index].kind !== "reaction") break;
      run += 1;
      if (run >= MAIL_MAX_REACTION_RUN) return true;
    }
    return false;
  };
  /** Unaddressed and attention-worthy: what a sender who says nothing must get. */
  const MAIL_DEFAULT_KIND = "tell";
  const MAIL_EVERYONE = "everyone";

  /**
   * Whether this message is this member's to see at all.
   *
   * Addressing only. Two sessions working something out between them are not writing to
   * a third, and handing it to them anyway is the noise the `to` field exists to stop.
   */
  const reachesMember = (message, conversationId) =>
    message.from !== conversationId &&
    (message.to === MAIL_EVERYONE || message.to === conversationId);

  /**
   * Whether it should interrupt them, which is a stricter question than reaching them.
   *
   * Asked of the channels that cost a turn — a stream, and a push into Codex. Not of a
   * collection, where the session is already awake and running: there an acknowledgement
   * costs nothing to include, and a notice that someone has left the room is worth
   * having, since a member told an hour ago that somebody was here may be about to ask
   * them for something.
   */
  /**
   * Whether it interrupts them, which — since every kind now does — is the same question.
   *
   * It was not always. `ack` and `notice` were silent for a while, and silence turned out
   * to be the wrong tool: a confirmation nobody is woken for is a confirmation nobody
   * gets, and somebody joining or leaving is exactly the thing a member needs promptly,
   * since it decides who there is left to ask. So addressing is the only thing that
   * routes, and `kind` says what to do about a message rather than who hears it.
   *
   * What bounds an exchange is now the reply rules alone: an ask is answered, a tell or a
   * notice may draw a reaction, and a reaction is never answered. The loop that closed a
   * room was not caused by replies waking people — it was caused by every reply going to
   * everyone, which addressing fixes and which the briefs now say outright. The two
   * functions are kept apart because the distinction is real and may be wanted again;
   * today they agree.
   */
  const wakesMember = (message, conversationId) => reachesMember(message, conversationId);

  const publishMail = (room, from, text, replyTo, fromSession = false, routing = null) => {
    // Capacity is decided here, not at one caller. The HTTP route checks first so it can
    // answer with a sentence naming who has not read; every other way into a room — a
    // harvested Codex reply, a relayed hook message — arrives through this line, and
    // without it they could push a room past a budget the route was busy enforcing.
    //
    // The room's own voice is exempt. A notice is how a session learns it was removed or
    // that somebody joined, and refusing one would be the same silent failure in a
    // different place; they are small, and the budget bounds what senders add.
    if (from !== ROOM_SENDER && roomIsFull(room, Buffer.byteLength(text, "utf8"))) return null;
    room.seq += 1;
    mailOrdinal += 1;
    room.touchedAt = Date.now();
    // replyTo is the sender naming where it is listening. Without it a recipient can
    // be reached but cannot answer, which is how the first version of this ended up
    // needing a human to carry every reply by hand.
    // The room speaks in two registers and they are not interchangeable. Saying who is
    // in it is state, and waking three sessions to repeat a roster they are handed on
    // every message buys nothing. Telling one session that it has been removed, or that
    // it is in a room and cannot yet read it, is addressed to that session and has to
    // arrive. Until this was explicit the difference rested on whether a caller had
    // happened to pass the message on to delivery — right by accident, and one tidying
    // pass away from a session never learning it had been disconnected.
    const asked = asKind(routing?.kind);
    const kind = from === ROOM_SENDER
      ? (asked === "tell" ? "tell" : "notice")
      : MAIL_KINDS.has(asked) && asked !== "notice"
        ? asked
        : MAIL_DEFAULT_KIND;
    const message = {
      seq: room.seq,
      ord: mailOrdinal,
      from,
      // Addressed, so the room can route rather than broadcast. Anything unrecognised
      // becomes everyone: a sender who gets this wrong must be heard too loudly rather
      // than not at all, since silence is the failure nobody notices.
      to: typeof routing?.to === "string" && routing.to.length > 0 ? routing.to : MAIL_EVERYONE,
      kind,
      text,
      replyTo: replyTo ?? null,
      ts: new Date().toISOString(),
    };
    room.messages.push(message);
    // Notices first, against their own allowance, so the room's own voice can never cost
    // a message addressed to somebody. Then what every reader has already been handed. A
    // room that cannot make space this way is refused at the door — see `roomIsFull` — so
    // reaching here and still being over the cap means it is full of mail somebody is
    // still owed, and the only thing that was let past that door is a notice.
    trimRoomNotices(room);
    trimRoomMessages(room);

    const frame = mailFrame(message);
    let pushed = false;
    for (const res of room.clients) {
      try {
        // A stream exists to interrupt, so only what should interrupt goes down it.
        // Filtering in the watcher would mean parsing every frame there, which is the
        // second command per frame that keeps tempting the capture-into-a-variable bug
        // — and the room already knows who is reading, from the `?as=` it insists on.
        // An acknowledgement or a room notice is still published and still readable; it
        // simply does not cost anyone a turn.
        if (res.gyredeckWatcher && !wakesMember(message, res.gyredeckWatcher)) continue;
        res.write(frame);
        pushed = true;
        // How far this member's stream has been written, which is what `since=resume`
        // hands back. Deliberately not the same as readSeq below: a push is not a read.
        const member = res.gyredeckWatcher ? room.members.get(res.gyredeckWatcher) : null;
        if (member) member.streamSeq = Math.max(member.streamSeq ?? 0, message.seq);
      } catch {
        room.clients.delete(res);
      }
    }
    // A push is a delivery. Without this a room whose only reader holds a stream
    // would report every message as still waiting to be picked up forever, because
    // nothing ever calls the read endpoint on it.
    // A push is a delivery, and so is a message the session itself produced — neither
    // is waiting for anyone to collect it.
    if (pushed || fromSession) {
      room.readSeq = Math.max(room.readSeq, message.seq);
      room.lastReadAt = message.ts;
    }
    // A push does not count for the members: the stream and the membership are
    // different things, and a member reads on its own schedule. The author is the
    // exception — nobody waits to be handed what they just wrote.
    const author = room.members.get(from);
    // Nobody waits to be handed what they just wrote — but writing is not reading, and
    // this used to say otherwise: the author's cursor jumped to its own message, so a
    // session that answered without collecting looked caught up, the room felt free to
    // drop mail addressed to it, and the sender was told 202. Codex caught that.
    //
    // The question is not "was the author exactly up to date" — a single room notice in
    // between would then strand the cursor for good, and the room would never free space
    // again. It is whether anything the author is actually owed sits in the gap: mail
    // addressed to them, by somebody else. A notice is the room describing itself, kept
    // to its own allowance and owed to nobody, so it does not hold a cursor.
    if (author) {
      const owed = room.messages.some(
        (earlier) =>
          earlier.seq > author.readSeq &&
          earlier.seq < message.seq &&
          earlier.kind !== "notice" &&
          reachesMember(earlier, from),
      );
      if (!owed) {
        author.readSeq = message.seq;
        author.lastReadAt = message.ts;
      }
    }
    // Mail and presence are separate streams, and the app only polls rooms while the
    // session list is on screen — which is not when a person needs telling that a reply
    // landed. One line on the stream the window is always subscribed to closes that.
    // Only what was addressed to a member and asks something of them: a reaction is
    // where an exchange stops and a notice is the room describing itself, and a
    // notification with nothing behind it is how notifications get switched off.
    if (room.members.size > 0 && (message.kind === "ask" || message.kind === "tell")) {
      for (const member of room.members.keys()) {
        if (!wakesMember(message, member)) continue;
        emitLocal({
          version: PROTOCOL_VERSION,
          id: randomUUID(),
          type: "room_message",
          timestamp: message.ts,
          // The member this concerns, not the sender: the app shows it against the
          // session a person would go to.
          conversationId: member,
          cwd: workspaceByConversation.get(member) ?? null,
          runtime: null,
          data: {
            room: room.name ?? "",
            seq: message.seq,
            from: message.from,
            fromLabel: labelIn(room, message.from),
            kind: message.kind,
            preview: String(message.text).replace(/\s+/g, " ").slice(0, 160),
          },
        });
      }
    }
    wakeMailWaiters();
    return message;
  };

  /**
   * Hand a message to a Codex session and put its answer back in the room.
   *
   * `codex queue` reaches a session that is sitting idle — it starts a turn within a
   * couple of seconds with nobody at the keyboard, which no other agent here can do.
   * The answer is then read from the session's own log, so Codex never has to run a
   * command to reply and the user is never asked to approve one.
   *
   * Fire-and-forget on purpose: the POST that triggered this has already been answered,
   * and a session that never replies must not leave a request hanging.
   */
  const deliverToCodex = (threadId, room, text) => {
    const binary = findAgentBinary("codex");
    if (!binary) return "unavailable";

    const rolloutPath = codexRolloutFor(threadId);
    const since = Date.now();
    const child = spawn(binary, ["queue", "--thread", threadId, "--message", text], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", () => {});

    // Without a log to read there is nothing to harvest, but the message was still
    // delivered — the session will show it even if we cannot see the answer.
    if (!rolloutPath) return "queued";

    const deadline = since + CODEX_REPLY_TIMEOUT_MS;
    // Local, and only to decide when to stop looking. Whether a reply is published is
    // not this harvest's call to make — an overlapping one may already have posted it.
    const seen = new Set();
    const poll = () => {
      // Whether this pass stopped because the room was full rather than because it ran
      // out of replies. Per pass, so an earlier success cannot end the polling that the
      // refused reply still needs.
      let waitingForRoom = false;
      for (const reply of readCodexReplies(rolloutPath, since)) {
        // A reply the room has no space for is not "seen": marking it so would stop the
        // polling that is the only thing that will ever look at it again. Nor may an
        // earlier success in the same pass end it — that was the second half of the fault.
        if (roomIsFull(room, Buffer.byteLength(reply.text ?? "", "utf8"))) {
          waitingForRoom = true;
          break;
        }
        seen.add(reply.turnId ?? reply.text);
        if (!claimCodexReply(threadId, reply)) continue;
        // A harvested answer is still that session speaking, and a session nobody
        // confirmed does not get to speak just because the bridge is the one holding
        // the pen.
        if (refuseToPublish(room, threadId)) continue;
        const routed = routeCodexReply(room, reply.text);
        const published = publishMail(room, threadId, routed.text, null, true, routed.routing);
        if (published?.seq) publishedForCodex.set(threadId, published.seq);
      }
      if ((seen.size === 0 || waitingForRoom) && Date.now() < deadline) {
        setTimeout(poll, CODEX_REPLY_POLL_MS).unref?.();
      }
    };
    setTimeout(poll, CODEX_REPLY_POLL_MS).unref?.();
    return "queued";
  };

  /**
   * How a message reaches the sessions it is addressed to, if it can at all.
   *
   * A private mailbox is named after its one session. A sync room is named after
   * nothing, and its recipients are its members — so the room has to be fanned out.
   * Codex is the only one that can be pushed to; the others collect through a hook
   * that runs when their session next does, so there is nothing to send and nothing
   * to wait for.
   */
  const deliverMail = (roomName, room, text, from, routing = null) => {
    // A message that should not interrupt is still in the room to be read; it just is
    // not carried to anyone. Codex is the reason this has to be decided here: it holds
    // no stream to filter and cannot choose whether to be woken, so the room chooses
    // for it — the same choice every other member makes for itself at its watch.
    const carries = (recipient) =>
      !routing ||
      wakesMember({ from, to: routing.to ?? MAIL_EVERYONE, kind: routing.kind ?? MAIL_DEFAULT_KIND }, recipient);
    const recipients = room.members.size > 0
      // Nobody is delivered their own message, and a notice from the room itself goes
      // to everyone.
      ? [...room.members.keys()].filter((id) => id !== from && carries(id))
      : [roomName];
    if (recipients.length === 0) return routing && routing.kind === "ack" ? "not_notified" : "no_recipients";

    let queued = false;
    let waiting = false;
    let unavailable = false;
    for (const recipient of recipients) {
      const provider = providerByConversation.get(recipient);
      // A member that has not been confirmed gets none of the room's content. Reading is
      // what the password buys — the others cannot open the stream without it, and
      // pushing the conversation to Codex regardless would make it the one way in that
      // needs no permission at all. It is told once why it is quiet, and then nothing
      // reaches it until a person hands over the password.
      const member = room.members.size > 0 ? room.members.get(recipient) : null;
      if (member && member.confirmed !== true) {
        if (member.toldUnconfirmed) continue;
        member.toldUnconfirmed = true;
        // What to do with the password differs by agent, and telling everyone the same
        // thing is how Codex ended up being asked to run a call its sandbox forbids.
        // It cannot reach the bridge at all; the person types the password and Gyredeck
        // does the rest, so its instruction is to ask and then wait.
        const notice =
          provider === "codexCliHook"
            ? "[Gyredeck: you have been put in a room here, but until someone gives you" +
              " its password you can neither read what is said in it nor answer. Two" +
              " things stop you calling Gyredeck about it, and both hold: the room's" +
              " password is the x-gyredeck-token header on every such call and you do" +
              " not have it, and your sandbox denies network syscalls outright, so even" +
              " a request to 127.0.0.1 fails at connect rather than in transit. Ask the person at this" +
              " terminal for the password and then wait — asking is the whole of your" +
              " part. When they read it out of Gyredeck you are let in there and then," +
              " and the room simply starts arriving. Nothing further will reach you" +
              " until that happens.]"
            : "[Gyredeck: you have been put in a room here, but until someone gives you" +
              " its password you can neither read what is said in it nor answer. Ask the" +
              " person at this terminal for the room's password. When they give it to" +
              " you, use it yourself: send it as the x-gyredeck-token header on every" +
              ` call about this room, starting with POST http://127.0.0.1:${config.port}` +
              `/sync/rooms/${roomName}/confirm with {\"conversationId\":\"${recipient}\",` +
              ' \"password\":\"THE PASSWORD\"}. Nobody will confirm you; presenting it is' +
              " what lets you in. Until then, do not retry and do not look for another" +
              " way in — nothing further will reach you.]";
        if (provider === "codexCliHook") {
          if (deliverToCodex(recipient, room, notice) === "queued") queued = true;
          else unavailable = true;
        } else if (provider === "agyHost" || provider === "claudeCodeHook") {
          waiting = true;
        }
        continue;
      }
      if (provider === "codexCliHook") {
        // Codex is the one agent nothing can be injected into — its hook fires but the
        // text never reaches the model — so a queued message is the only channel there
        // is, and the standing instructions ride along with the first one it gets in a
        // room. What they say is the opposite of what the others are told: Codex's
        // sandbox denies the network syscall itself, so `curl` fails at connect even
        // for loopback ("Couldn't connect ... after 0 ms" — the timing is the tell). It answers by writing its
        // answer as ordinary text, which the bridge harvests from its own rollout log.
        // Repeated on every message, not once. Told a single time, Codex forgot by the
        // next turn and went back to curl — which its sandbox refuses at connect, so
        // the POST failed silently and it reported "sent" for messages the room never
        // received. A standing rule has to stand where it is read.
        // Everything here is repeated on every message rather than said once. Told a
        // single time, Codex forgot by the next turn; asked later to list the room's
        // rules, it named none of the ones that had only been posted into the room.
        // A standing rule has to stand where it is read.
        // Only for an actual room. A session's private mailbox is delivered through
        // this same function, and the brief was going out with it — naming the mailbox
        // as though it were a room, and reporting "Members now: nobody" directly above
        // a notice listing the two members who were in fact there. Everything it says
        // about addressing and rosters is about a room; a mailbox has one reader and
        // needs none of it.
        if (!SYNC_CODE.test(roomName)) {
          if (deliverToCodex(recipient, room, text) === "queued") queued = true;
          else unavailable = true;
          continue;
        }
        const roster = [...room.members.keys()].map((id) => labelIn(room, id)).join(", ");
        const wasPublished = publishedForCodex.get(recipient);
        const outgoing =
          `[Gyredeck · room ${roomName} — how to answer: write your reply as ordinary` +
          " text in this turn. Do not call Gyredeck: your sandbox refuses the network" +
          " syscall, so curl fails at connect even for 127.0.0.1, and a failed POST" +
          " looks like nothing at all. The bridge reads what you write from your own" +
          " session log and puts it in the room for you — that is the only path that" +
          " works, and it needs nothing from you but the words. Only the last thing you" +
          " write in a turn is taken, so say everything the room needs in one closing" +
          " message rather than several. You also need no watch:" +
          " messages are pushed into your session whether or not you are doing anything." +
          // Say who it is for and what it is for, in the one place Codex can say
          // anything. Telling it never to acknowledge was tried and did not hold: the
          // rule was in front of it on every message while it offered its help every
          // ten seconds, because "is there anything else?" is not an acknowledgement in
          // its own reading. A label it writes is something it can get right.
          " Open your message with one line saying who it is for and what it is:" +
          " @everyone ask, @Antigravity tell, @everyone reaction, or any member's name" +
          " in place of everyone. The line is removed before the room sees it. ask wants" +
          " an answer; tell does not but may draw a reaction; a reaction is a short line" +
          " saying it landed and where that leaves you — send one for a tell or for a" +
          " notice that somebody joined or left, and never answer one, which is where an" +
          " exchange stops. Leave the line out and it goes to everyone as tell, which" +
          " interrupts them all. When you answer someone, name them: that is what keeps" +
          " one exchange costing one wake instead of waking the room." +
          // Its roster is memory of announcements it happened to receive: it cannot
          // read the room's state, so a push that failed once would leave it wrong
          // forever. Restating who is here on every message costs a line and closes it.
          ` Members now: ${roster || "nobody"}.` +
          // Never "wait for ok:true" — Codex cannot see a response to anything, so that
          // rule was unsatisfiable while its messages were in fact being published.
          (wasPublished
            ? ` Your previous message reached the room as seq ${wasPublished}.`
            : " Nothing of yours has been published in this room yet.") +
          " You will not see a response to what you write — the bridge posts for you and" +
          " tells you the seq here, on the next message you get. If a seq never follows," +
          " what you wrote did not arrive.]\n\n" +
          text;
        const outcome = deliverToCodex(recipient, room, outgoing);
        if (outcome === "queued") queued = true;
        else unavailable = true;
      } else if (provider === "agyHost" || provider === "claudeCodeHook") {
        waiting = true;
      }
    }
    // The best outcome any recipient got, because that is what the sender can act on:
    // something is on its way, or everything is waiting for a turn.
    if (queued) return "queued";
    if (waiting) return "on_next_turn";
    if (unavailable) return "unavailable";
    return "unknown_recipient";
  };

  const server = createServer(async (req, res) => {
    // Answered before anything is read or written, preflight included: a page that is not
    // allowed to be here must not get as far as the route, and a 403 on the preflight is
    // what tells it so rather than leaving the real call to be made and then blocked in
    // the browser after the bridge has already acted on it.
    const corsHeaders = corsHeadersFor(req);
    if (corsHeaders === null) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: false,
        error: "forbidden_origin",
        message: "This bridge answers the Gyredeck app and its dev server, and nothing else in a browser.",
      }));
      noteRefusedOrigin(req.headers.origin);
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/ingest") {
      if (refuseHookCall(res, req)) return;
      const body = await readJsonBody(req);
      if (body && typeof body === "object" && typeof body.type === "string" && typeof body.id === "string") {
        emitLocal(body);
        res.writeHead(202, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
        res.end(JSON.stringify({ ok: true, type: body.type }));
        return;
      }
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
      res.end(JSON.stringify({ ok: false, error: "invalid_event" }));
      return;
    }

    if (req.method === "POST" && req.url === "/hook/stop") {
      if (refuseHookCall(res, req)) return;
      const body = await readJsonBody(req);
      emitHookStop(body);
      res.writeHead(202, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
      res.end(JSON.stringify({ ok: true, type: "turn_complete" }));
      return;
    }

    if (req.method === "POST" && req.url === "/hook/attention") {
      if (refuseHookCall(res, req)) return;
      const body = await readJsonBody(req);
      emitHookAttention(body);
      res.writeHead(202, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
      res.end(JSON.stringify({ ok: true, type: "attention_requested" }));
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
      res.end(
        JSON.stringify({
          ok: true,
          name: "gyredeck",
          version: PROTOCOL_VERSION,
          mode: "standalone",
          clients: clients.size,
          capabilities,
          // Surfaced rather than only logged: a log line scrolls away, and this is the
          // one fault in the room that nothing else can show.
          codexHarvest: {
            turns: codexHarvest.turns,
            published: codexHarvest.published,
            suspect: codexHarvest.published === 0 && codexHarvest.turns >= CODEX_HARVEST_SUSPECT_AFTER,
          },
        }),
      );
      return;
    }

    if (req.url === "/snapshot") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
      res.end(JSON.stringify({ ok: true, recent, capabilities }));
      return;
    }

    if (req.url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...corsHeaders,
      });
      res.write(`: gyredeck standalone bridge connected ${new Date().toISOString()}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    // Sync rooms: a mail room that people were deliberately put into, each with a
    // Being in the room together is the whole of the arrangement: what each session is
    // for is something its own user tells it in its own terminal, not something
    // restated here. The room is the same object mail already uses, so nothing about
    // messages is duplicated.
    if (req.url === "/sync/rooms" || req.url.startsWith("/sync/rooms/") || req.url.startsWith("/sync/rooms?")) {
      const sendJson = (status, body) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
        res.end(JSON.stringify(body));
      };
      // Create and join are deliberately open. Putting a session into a room lets it
      // neither read nor say anything — the room's own token gates both — and asking
      // for the machine token here would only prove what every local caller can prove.
      sweepMailRooms();

      const url = new URL(req.url, "http://127.0.0.1");
      const segments = url.pathname.split("/").filter(Boolean);
      const code = segments[2];

      // The three that change who may do what are not like create and join: issuing the
      // password, closing the room, and taking a member out. Each is pressed in the app
      // and only ever called by it, and each was authorised on `?as=` alone — a session
      // id, which is a name a caller writes, not something it holds. The machine token
      // does not prove which session is asking, but it does keep the act inside the app
      // that has the button, which `?as=` never did.
      const changesAuthority =
        (req.method === "POST" && segments.length === 4 && segments[3] === "passwords") ||
        (req.method === "DELETE" && segments.length >= 3);
      if (changesAuthority && !holdsMachineToken(req.headers["x-gyredeck-token"])) {
        sendJson(401, { ok: false, error: "unauthorized", message: TOKEN_HINT });
        return;
      }

      // GET /sync/rooms?as=<id> — which room this session is in, if any.
      if (req.method === "GET" && segments.length === 2) {
        const as = url.searchParams.get("as") ?? "";
        if (!MAIL_ROOM_NAME.test(as)) {
          sendJson(400, { ok: false, error: "invalid_session" });
          return;
        }
        const found = syncRoomFor(as);
        sendJson(200, { ok: true, ...(found ? describeRoom(found.name, found.room, as) : { room: null, members: [], you: null }) });
        return;
      }

      // POST /sync/rooms — create a room and put the caller in it. Creating without
      // joining would leave a code nobody is in, which is never what the button means.
      if (req.method === "POST" && segments.length === 2) {
        const body = await readJsonBody(req);
        const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
        if (!MAIL_ROOM_NAME.test(conversationId)) {
          sendJson(400, { ok: false, error: "invalid_session" });
          return;
        }
        // One room per session, so the button has one meaning and Disconnect is
        // unambiguous. Being in a room already is a conflict, not a silent move.
        const existing = syncRoomFor(conversationId);
        if (existing) {
          sendJson(409, { ok: false, error: "already_in_room", room: existing.name });
          return;
        }
        const name = newSyncCode();
        if (!name) {
          sendJson(429, { ok: false, error: "too_many_rooms" });
          return;
        }
        const room = mailRoomFor(name, true);
        if (!room) {
          sendJson(429, { ok: false, error: "too_many_rooms" });
          return;
        }
        room.createdBy = conversationId;
        room.password = newRoomPassword();
        room.members.set(conversationId, {
          label: allocateLabel(room, conversationId),
          // Pressing Create in this session's own detail panel is the same act of
          // intent the password exists to capture, so the founder needs no password.
          confirmed: true,
          joinedAt: new Date().toISOString(),
          // Joining mid-conversation should not replay what was said before: a member
          // starts from where the room is now.
          readSeq: room.seq,
          lastReadAt: null,
        });
        room.touchedAt = Date.now();
        // Told after the room exists, so the notice can name it and say who is there.
        tellJoined(name, room, conversationId, "you created it");
        // The founder is handed the room's token once, here; everyone else gets it
        // from them, by hand, into the terminal of the session being let in.
        sendJson(201, { ok: true, password: room.password, ...describeRoom(name, room, conversationId) });
        return;
      }

      // DELETE /sync/rooms/<code> — close the room for everyone.
      //
      // Leaving is one member's business; closing is the room's end, and the difference
      // matters to what is still running. Every member is told, every stream is cut,
      // and only then is the room dropped — in that order, because a room deleted first
      // has no members left to tell and no streams left to find.
      if (req.method === "DELETE" && segments.length === 3) {
        const room = mailRooms.get(code);
        if (!room || room.members.size === 0) {
          sendJson(404, { ok: false, error: "no_such_room" });
          return;
        }
        const closer = url.searchParams.get("as");
        if (closer && room.createdBy !== closer) {
          sendJson(403, {
            ok: false,
            error: "not_the_founder",
            message: "Only the session that created this room can close it.",
          });
          return;
        }
        closeRoom(code, room, "the room was closed");
        sendJson(200, { ok: true, room: code, closed: true });
        return;
      }

      // POST /sync/rooms/<code>/passwords — the founder reads the room's password, to
      // hand to a session being let in. The same string every time: it is presented in
      // the x-gyredeck-token header of every read and send in this room, so it has to
      // keep working.
      if (req.method === "POST" && segments.length === 4 && segments[3] === "passwords") {
        const body = await readJsonBody(req);
        const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
        const room = mailRooms.get(code);
        if (!room || room.members.size === 0) {
          sendJson(404, { ok: false, error: "no_such_room" });
          return;
        }
        if (room.createdBy !== conversationId) {
          sendJson(403, { ok: false, error: "not_the_founder" });
          return;
        }
        room.touchedAt = Date.now();
        // Reading the password out is the founder's act of letting people in, and for
        // an agent that cannot present it there is nothing further to wait for. Codex
        // cannot open a socket from inside its sandbox, so asking it to confirm itself asks
        // for something impossible; the key press is the consent, and it is applied
        // here on its behalf.
        for (const [conversationId, member] of room.members) {
          if (member.confirmed === true) continue;
          if (providerByConversation.get(conversationId) !== "codexCliHook") continue;
          member.confirmed = true;
          member.toldUnconfirmed = false;
          announceMembership(
            code,
            room,
            `${labelIn(room, conversationId)} was confirmed by the room's owner and can now speak here.`,
          );
          tellConfirmed(code, room, conversationId);
        }
        sendJson(200, { ok: true, room: code, password: room.password });
        return;
      }

      // POST /sync/rooms/<code>/confirm — a joined session presents the password its
      // person typed into it, and earns the right to speak in the room.
      if (req.method === "POST" && segments.length === 4 && segments[3] === "confirm") {
        const body = await readJsonBody(req);
        const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
        const password = typeof body.password === "string" ? body.password.trim() : "";
        const room = mailRooms.get(code);
        // Two very different situations answered by the same bare word, and a live
        // session met both: holding a password for a room it had never been added to,
        // and holding one for a room that had ended. Neither is something the session
        // can fix, and both are one sentence to explain — the password is the right to
        // speak in a room, not the way into one.
        if (!room) {
          sendJson(404, {
            ok: false,
            error: "no_such_room",
            message: `No room is open under the code ${code}. A room ends with its last member, and with the bridge that held it. Ask the person at this terminal to make a new one.`,
          });
          return;
        }
        if (!room.members.has(conversationId)) {
          sendJson(404, {
            ok: false,
            error: "not_a_member",
            message: "You are not in this room yet, and the password does not put you in one — it is the right to speak once you are. Ask the person at this terminal to add this session to the room from Gyredeck, then present the password again.",
          });
          return;
        }
        // The password is checked before anything else about this member, so there is no
        // longer a case where being already confirmed answers a question about the
        // password without looking at it. That case used to hand the room's password back
        // to anyone who could name a confirmed member, and answering `ok:true` to a wrong
        // one is its own fault: `confirmRoomPassword` in the Claude hook reads `ok` as
        // "the password I just gave was accepted", so the person at the terminal was told
        // a wrong password had worked.
        if (!holdsRoomPassword(room, password)) {
          sendJson(403, {
            ok: false,
            error: "bad_password",
            message: "That is not this room's password. It is 32 hex characters, copied from Gyredeck by the person who made the room — a room code is not it, and neither is the machine's ingest token.",
          });
          return;
        }
        const member = room.members.get(conversationId);
        if (member.confirmed === true) {
          // Presenting it again is not an error: a session that restarts and is handed the
          // password a second time is asking the same question and gets the same answer.
          sendJson(200, {
            ok: true,
            ...describeRoom(code, room, conversationId),
            howTo: howToUseRoom(code, room.password, conversationId, BRIDGE_HOST, config.port),
          });
          return;
        }
        member.confirmed = true;
        member.toldUnconfirmed = false;
        room.touchedAt = Date.now();
        announceMembership(
          code,
          room,
          `${labelIn(room, conversationId)} was confirmed by the room's owner and can now speak here.`,
        );
        tellConfirmed(code, room, conversationId);
        sendJson(200, {
          ok: true,
          ...describeRoom(code, room, conversationId),
          // Reached only past the password check above, so this caller has already proved
          // it holds what it is being handed back. The answer to a call the session made
          // itself, and so the one place an instruction is certain to be read —
          // everything a hook injects lands a turn later, by which point the session has
          // usually guessed.
          howTo: howToUseRoom(code, room.password, conversationId, BRIDGE_HOST, config.port),
        });
        return;
      }

      // POST /sync/rooms/<code>/members — join. Idempotent, so a second press of
      // Connect is not an error.
      if (req.method === "POST" && segments.length === 4 && segments[3] === "members") {
        const body = await readJsonBody(req);
        const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
        if (!MAIL_ROOM_NAME.test(code) || !MAIL_ROOM_NAME.test(conversationId)) {
          sendJson(400, { ok: false, error: "invalid_session" });
          return;
        }
        const room = mailRoomFor(code, false);
        // A code that names nothing is a typo, and saying so is the whole reason the
        // join field can show an error.
        if (!room || room.members.size === 0) {
          sendJson(404, { ok: false, error: "unknown_room" });
          return;
        }
        const existing = syncRoomFor(conversationId);
        if (existing && existing.name !== code) {
          sendJson(409, { ok: false, error: "already_in_room", room: existing.name });
          return;
        }
        const joining = !room.members.has(conversationId);
        if (joining) {
          if (room.members.size >= MAIL_MAX_MEMBERS) {
            sendJson(429, { ok: false, error: "room_full" });
            return;
          }
          room.members.set(conversationId, {
            label: allocateLabel(room, conversationId),
            // Joining puts a session in the room; it does not yet let it speak. The
            // person confirms that separately, by typing the room's password into this
            // session's own terminal — an act performed where the session lives rather
            // than in another window.
            confirmed: false,
            joinedAt: new Date().toISOString(),
            // Announced after the member is added, so its own read position is behind
            // the notice and it learns who else is here too.
            readSeq: room.seq,
            lastReadAt: null,
          });
          announceMembership(code, room, `${labelIn(room, conversationId)} joined this room.`);
          // The room's own announcement reaches everyone who can already read it; the
          // one being added usually cannot, and hears about it here instead.
          tellJoined(code, room, conversationId, "someone put you in it from the app");
        }
        room.touchedAt = Date.now();
        // No `howTo`, and so no password. Joining is deliberately open — putting a session
        // in a room grants it nothing — but the answer used to carry the room's password
        // whenever the *named* session was already confirmed, without ever asking who was
        // calling. Anything on this machine could name a member and be handed the one
        // thing a person is supposed to read out by hand. Nothing on the desktop side
        // reads `howTo`; the session that needs it gets it from `/confirm`, where it has
        // just presented the password.
        sendJson(200, { ok: true, ...describeRoom(code, room, conversationId) });
        return;
      }

      // DELETE /sync/rooms/<code>/members/<id> — leave. The room goes with the last
      // member: an empty room is a code nobody can use for anything.
      if (req.method === "DELETE" && segments.length === 5 && segments[3] === "members") {
        const conversationId = segments[4];
        if (!MAIL_ROOM_NAME.test(code) || !MAIL_ROOM_NAME.test(conversationId)) {
          sendJson(400, { ok: false, error: "invalid_session" });
          return;
        }
        const room = mailRoomFor(code, false);
        if (!room || !room.members.has(conversationId)) {
          sendJson(404, { ok: false, error: "not_a_member" });
          return;
        }
        // The founder leaving ends the room rather than shrinking it. Everything a room
        // is for afterwards runs through the founder — letting the next session in, and
        // closing the room at all — so what was left behind was a code nobody could use
        // and nobody could get rid of. Everyone in it is told, which is the whole reason
        // this goes through the same close as the button rather than dropping the room
        // here.
        if (room.createdBy === conversationId) {
          closeRoom(code, room, "the session that created it left, and a room does not outlive its founder");
          sendJson(200, { ok: true, room: code, closed: true, members: [] });
          return;
        }
        const label = labelIn(room, conversationId);
        retireLabel(room, conversationId);
        room.touchedAt = Date.now();
        // The one leaving is told first, while the room object is still here to name.
        partWithMember(code, room, conversationId, "someone disconnected it from the app");
        if (room.members.size === 0 && room.clients.size === 0) mailRooms.delete(code);
        // Whoever is left was told this member was here, and might be about to ask it
        // something.
        else if (room.members.size > 0) announceMembership(code, room, `${label} left this room.`);
        sendJson(200, { ok: true, room: code, members: [...(mailRooms.get(code)?.members.keys() ?? [])] });
        return;
      }

      sendJson(404, { ok: false, error: "not_found" });
      return;
    }

    if (req.url === "/mail" || req.url.startsWith("/mail/") || req.url.startsWith("/mail?")) {
      const sendJson = (status, body) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
        res.end(JSON.stringify(body));
      };

      // Mail is a channel agents read and act on, not observational data like
      // /ingest, so an untrusted caller must not be able to put words into another
      // agent's input. There is no degraded mode here: no token, no access.
      // Two credentials reach here and they mean different things. The machine token is
      // what the app itself holds; it lists rooms and draws the UI. A room's own token
      // is what a session is given by hand, and it is the only thing that says a person
      // let this session into this room. Either opens the door; which one came in
      // decides what is allowed once inside, and that is decided per route below.
      // Both are hex of a known length, so the door turns away anything not even shaped
      // like a credential without having to know which of the two this caller should be
      // holding. It used to admit any non-empty string, which left every route behind it
      // looking guarded while proving nothing at all about the caller.
      const headerToken = req.headers["x-gyredeck-token"];
      if (typeof headerToken !== "string" || !CREDENTIAL_SHAPE.test(headerToken)) {
        sendJson(401, { ok: false, error: "unauthorized", message: TOKEN_HINT });
        return;
      }
      sweepMailRooms();

      const url = new URL(req.url, "http://127.0.0.1");
      const segments = url.pathname.split("/").filter(Boolean);

      // GET /mail — which rooms exist, so a peer can find its counterpart.
      //
      // The whole table, every room and its roster, which is the app's view and not a
      // member's. The door above admits a room's password too, so this one route has to
      // say which of the two it takes: passing the shape check is not being the app.
      if (req.method === "GET" && segments.length === 1) {
        if (!holdsMachineToken(headerToken)) {
          sendJson(401, { ok: false, error: "unauthorized", message: TOKEN_HINT });
          return;
        }
        sendJson(200, {
          ok: true,
          rooms: [...mailRooms].map(([name, room]) => {
            // `as` asks "what is waiting for me", which in a room with members is the
            // only question with one answer — the room-level number is the furthest
            // anyone got and says nothing about the reader who is behind.
            const reader = readerFor(room, url.searchParams.get("as"));
            return {
              room: name,
              seq: room.seq,
              readSeq: reader.readSeq,
              pending: Math.max(0, room.seq - reader.readSeq),
              buffered: room.messages.length,
              subscribers: room.clients.size,
              // Named, not raw ids: this list is read by a person in Settings, and a
      // conversation id tells them nothing.
      members: (() => {
        return [...room.members.keys()].map((id) => labelIn(room, id));
      })(),
      // Named so a listing can tell which rooms the person may close from here.
      founder: room.createdBy ?? null,
              lastMessageAt: room.messages.at(-1)?.ts ?? null,
              lastReadAt: reader.lastReadAt ?? null,
            };
          }),
        });
        return;
      }

      // GET /mail/inbox?as=<id> — everything addressed to one session, wherever it
      // lives: its own mailbox and the sync room it was put into. The reader asks what
      // is for it rather than naming rooms, so a hook needs no idea that rooms exist
      // and no cursor of its own — the position each reader has reached lives with the
      // room it belongs to, and the two are lost together on a restart instead of the
      // cursor outliving the room and silently discarding everything after it.
      //
      // Room and members come back in the same response because the caller is a hook
      // with a sub-second budget and would otherwise need a second request to say who
      // it is talking to.
      if (
        req.method === "GET" &&
        segments.length === 2 &&
        (segments[1] === "inbox" || segments[1] === "wait")
      ) {
        const as = url.searchParams.get("as") ?? "";
        if (!MAIL_ROOM_NAME.test(as)) {
          sendJson(400, { ok: false, error: "invalid_session" });
          return;
        }
        // `as` is a claim, not a credential: it says which mailbox to open and nothing
        // about who is asking. Without this, any local process could name another
        // session and, with collect=1, empty its mailbox — leaving a session that was
        // written to and never told.
        if (!holdsMailboxCredential(as, headerToken)) {
          sendJson(401, { ok: false, error: "unauthorized", message: TOKEN_HINT });
          return;
        }
        const collect = url.searchParams.get("collect") === "1";
        // The cap has to be applied by whoever advances the position. A caller that
        // trimmed the list itself would leave the rest marked as read and never
        // delivered — the position must only ever move as far as what was handed over.
        const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
        const limit = Number.isInteger(requested) && requested > 0
          ? Math.min(requested, MAIL_MAX_MESSAGES)
          : MAIL_MAX_MESSAGES;

        const collectInbox = () => {
          const at = new Date().toISOString();
          const sync = syncRoomFor(as);
          // A session's own mailbox is always its own to read. Its room is not: reading
          // is what the password buys, and a merge that handed the room over anyway
          // would be the same leak as pushing it — one door closed, another open. The
          // room is still *named* in the answer, so an unconfirmed session can be told
          // where it is and what it lacks.
          const mayReadRoom = sync ? sync.room.members.get(as)?.confirmed === true : false;
          const sources = [
            [as, mailRoomFor(as, false)],
            ...(sync && mayReadRoom ? [[sync.name, sync.room]] : []),
          ];
          const fresh = [];
          // How far each source was examined, which is not the same as what was taken:
          // a message deliberately not carried to this session must still stop counting
          // as waiting to be picked up, or its pending total climbs forever.
          const examined = new Map();
          // Mail this session is owed and can never be handed: the room hit its cap and
          // dropped messages it had already given to everyone else. Saying nothing here
          // hands back a short list that reads exactly like "that was all there was".
          const missed = [];
          for (const [roomName, room] of sources) {
            if (!room) continue;
            const reader = readerFor(room, as);
            const gap = (room.droppedThroughSeq ?? 0) - reader.readSeq;
            if (gap > 0) missed.push({ room: roomName, count: gap, throughSeq: room.droppedThroughSeq });
            // A private mailbox is addressed to this session by being its mailbox, so
            // everything in it is for it — the notice that says which room it has been
            // put in arrives that way. A sync room is shared, and collecting from it is
            // as much an interruption as a push: the hook drops what it finds straight
            // into the session's next turn. So the same rule applies, and it has to be
            // applied here too — two agents addressing each other directly still woke a
            // third, because the stream had learnt this and the inbox had not.
            const shared = room !== mailRoomFor(as, false);
            for (const message of room.messages) {
              if (message.seq <= reader.readSeq) continue;
              examined.set(roomName, Math.max(examined.get(roomName) ?? 0, message.seq));
              // Everything addressed here, whatever its kind. A collection costs no
              // turn, and both of the quiet kinds have something to give a reader: a
              // notice says who arrived or left, and a reaction says how somebody took
              // what was said to them.
              if (shared && !reachesMember(message, as)) continue;
              fresh.push({ room: roomName, ...message });
            }
            room.touchedAt = Date.now();
          }

          // Oldest first across both rooms, so a batch reads in the order it was said
          // rather than grouped by where it came from. Ordered by the bridge-wide
          // publish order: within a millisecond, one room's seq says nothing about
          // another's.
          fresh.sort((left, right) => (left.ord ?? 0) - (right.ord ?? 0));
          const collected = fresh.slice(0, limit);

          if (collect) {
            for (const [roomName, room] of sources) {
              if (!room) continue;
              const taken = collected.filter((message) => message.room === roomName);
              // Past everything looked at, not merely everything handed over — but never
              // past what the cap left behind, which is still owed to this session.
              const upTo = collected.length < fresh.length
                ? taken.at(-1)?.seq
                : Math.max(taken.at(-1)?.seq ?? 0, examined.get(roomName) ?? 0);
              if (upTo) markRead(room, as, upTo, at);
              // Past the gap as well, or the same loss is reported on every collection
              // for the rest of the session. It is told once, and once is the point.
              if ((room.droppedThroughSeq ?? 0) > 0) markRead(room, as, room.droppedThroughSeq, at);
            }
          }
          return { collected, sync, missed };
        };

        // GET /mail/wait?as=<id> — the same answer as the inbox, except that an empty
        // one is held rather than returned. A session that has asked for something it
        // needs waits here instead of ending its turn, and the reply arrives as the
        // result of the call it is already blocked on.
        if (segments[1] === "wait") {
          const requestedWait = Number.parseInt(url.searchParams.get("timeout") ?? "", 10);
          const waitMs = Number.isInteger(requestedWait) && requestedWait > 0
            ? Math.min(requestedWait * 1_000, MAIL_WAIT_MAX_MS)
            : MAIL_WAIT_DEFAULT_MS;

          /**
           * Why nothing came back, when the bridge can actually tell.
           *
           * An asker that waits a minute and hears nothing has two very different
           * problems — it addressed the message wrongly, or it addressed it right and
           * the other session is busy — and no way to tell them apart. The room knows:
           * it routed the message. Saying so here costs nothing and lands in the reply
           * to the call the asker is already blocked on, which is the one place it is
           * certain to be read. Distinguishing the two matters as much as spotting the
           * first: an asker that "fixes" a message that was already correct and sends
           * it again is the start of the next loop.
           */
          const diagnoseSilence = (sync) => {
            if (!sync) return null;
            const mine = [...sync.room.messages].reverse().find((message) => message.from === as);
            if (!mine) return { sent: false, reason: "You have not said anything in this room yet." };
            const base = { seq: mine.seq, to: mine.to, kind: mine.kind };
            if (mine.kind === "ack") {
              return { ...base, reason: "kind \"ack\" reaches the room but wakes nobody. Nothing was notified of this. Send it as \"ask\" if you need an answer." };
            }
            if (mine.to !== MAIL_EVERYONE && !sync.room.members.has(mine.to)) {
              return { ...base, reason: `Addressed to "${mine.to}", who is not in this room. Nobody received it. Address it to everyone, or to a name from the members list.` };
            }
            const target = mine.to === MAIL_EVERYONE
              ? [...sync.room.members.keys()].filter((id) => id !== as)
              : [mine.to];
            const unconfirmed = target.filter((id) => sync.room.members.get(id)?.confirmed !== true);
            if (target.length > 0 && unconfirmed.length === target.length) {
              return { ...base, reason: "Everyone it was addressed to is still waiting for the room's password, so none of them can read it yet." };
            }
            if (target.length === 0) {
              return { ...base, reason: "There is nobody else in this room to answer." };
            }
            return { ...base, reason: "Addressed correctly and delivered. The silence is theirs, not a mistake in what you sent — do not send it again on account of this." };
          };

          const answer = (collected, sync, timedOut, missed = []) =>
            sendJson(200, {
              ok: true,
              timedOut,
              ...(timedOut ? { yourLastMessage: diagnoseSilence(sync) } : {}),
              ...describeInbox(collected, sync, as, missed),
            });

          const first = collectInbox();
          if (first.collected.length > 0) {
            answer(first.collected, first.sync, false, first.missed);
            return;
          }
          // One wait per session, enforced rather than asked for. The instruction says
          // to wait only while an answer is outstanding, but an agent that ignores it
          // would otherwise stack waits into the listen loop this is meant not to be —
          // and a session holding several is a session that has stopped working.
          for (const existing of mailWaiters) {
            if (existing.as === as) {
              sendJson(409, { ok: false, error: "already_waiting" });
              return;
            }
          }
          // A held request costs a socket and a timer. Past the cap, say so rather than
          // accumulating waiters nobody is counting.
          if (mailWaiters.size >= MAIL_MAX_WAITERS) {
            sendJson(429, { ok: false, error: "too_many_waiters" });
            return;
          }

          const waiter = { as, check: null };
          let done = false;
          const finish = (collected, sync, timedOut, missed = []) => {
            if (done) return;
            done = true;
            mailWaiters.delete(waiter);
            clearTimeout(timer);
            answer(collected, sync, timedOut, missed);
          };
          const timer = setTimeout(() => finish([], syncRoomFor(as), true), waitMs);
          timer.unref?.();
          waiter.check = () => {
            // A request already gone must not have its position advanced: collect=1
            // would mark messages delivered into a socket nobody is reading.
            if (done || req.destroyed) return;
            const next = collectInbox();
            if (next.collected.length > 0) finish(next.collected, next.sync, false, next.missed);
          };
          // A client that hangs up must not leave a timer and a closure behind, and
          // must not have its read position advanced on the way out.
          req.on("close", () => {
            if (done) return;
            done = true;
            mailWaiters.delete(waiter);
            clearTimeout(timer);
          });
          mailWaiters.add(waiter);
          return;
        }

        const { collected, sync, missed } = collectInbox();
        sendJson(200, { ok: true, ...describeInbox(collected, sync, as, missed) });
        return;
      }

      const name = segments[1] ?? "";
      const tail = segments[2];
      // Room names land in a Map key and in URLs, so keep them to a shape that
      // cannot be confused for a path of its own.
      if (!MAIL_ROOM_NAME.test(name)) {
        sendJson(400, { ok: false, error: "invalid_room" });
        return;
      }
      if (segments.length > 3 || (tail !== undefined && tail !== "events")) {
        sendJson(404, { ok: false, error: "not_found" });
        return;
      }

      // POST /mail/<room> — publish. Whoever speaks first creates the room.
      if (req.method === "POST" && tail === undefined) {
        const body = await readJsonBody(req);
        const from = typeof body.from === "string" ? body.from.trim().slice(0, MAIL_MAX_FROM) : "";
        const text = typeof body.text === "string" ? body.text : "";
        if (!from || !text || text.length > MAIL_MAX_TEXT) {
          sendJson(400, { ok: false, error: "invalid_message" });
          return;
        }
        // A reply address has to be a room name like any other, since it is handed to
        // an agent that will put it in a URL.
        const replyTo = typeof body.replyTo === "string" ? body.replyTo : null;
        if (replyTo !== null && !MAIL_ROOM_NAME.test(replyTo)) {
          sendJson(400, { ok: false, error: "invalid_reply_to" });
          return;
        }
        // Who this is for and what it is for. Both are optional and both default to the
        // loud answer — an unaddressed `tell` to everyone — because a sender who omits
        // them or spells them wrong has to be over-heard rather than silently dropped.
        const routedKind = MAIL_KINDS.has(asKind(body.kind)) && asKind(body.kind) !== "notice"
          ? asKind(body.kind)
          : MAIL_DEFAULT_KIND;
        const routedTo = typeof body.to === "string" && body.to.length > 0 ? body.to : MAIL_EVERYONE;
        // Asked before the name is resolved, because resolving a mailbox name creates it:
        // an uncredentialed caller must otherwise be able to fill the room table with
        // mailboxes nobody will ever read.
        //
        // A room people were put into takes a credential that verifies before `from` is
        // looked at, because `from` is a name the caller writes. Without this, a member
        // the room already remembers as confirmed could be spoken for by anything that
        // sent the header non-empty — the one thing mail must not allow.
        //
        // Either credential: the room's own password, or the machine token. Not the
        // password alone, because the founder is confirmed by pressing Create and has no
        // password in hand until a person reads one out — that exemption is the design,
        // not an oversight. The machine token is read by every agent on this machine, so
        // this does not isolate one local agent from another; that needs a per-session
        // credential and is written up in event-protocol.md.
        const standing = SYNC_CODE.test(name) ? mailRooms.get(name) ?? null : null;
        if (standing && standing.members.size > 0) {
          if (!holdsMachineToken(headerToken) && !holdsRoomPassword(standing, headerToken)) {
            sendJson(403, { ok: false, error: "not_confirmed", message: ROOM_PASSWORD_HINT });
            return;
          }
        } else if (!holdsMailboxCredential(name, headerToken)) {
          sendJson(401, { ok: false, error: "unauthorized", message: TOKEN_HINT });
          return;
        }
        // A sync room is never conjured by posting to it. A private mailbox is: it is
        // named after one session and writing to it before that session has read
        // anything is ordinary. A room code is not — it is issued, and a code with no
        // room behind it means the room ended, most often because the bridge restarted
        // and took its memory with it.
        //
        // Creating one here answered ok:true with a seq for a message nobody would ever
        // read: the new room has no members, so the guard below — which only applies to
        // rooms that have any — waved it through. The sender was told the one thing it
        // is supposed to be able to trust. Watchers already stop themselves when a room
        // goes; until now senders were the half still being lied to.
        const room = SYNC_CODE.test(name) ? mailRooms.get(name) ?? null : mailRoomFor(name, true);
        if (!room) {
          if (SYNC_CODE.test(name)) {
            sendJson(404, {
              ok: false,
              error: "no_such_room",
              message: "Nothing by that code is open. A room ends with its last member, and with the bridge that held it — this message was not delivered to anyone.",
            });
          } else {
            sendJson(429, { ok: false, error: "too_many_rooms" });
          }
          return;
        }
        // This is where the password earns its place. A room with members is one people
        // were put into deliberately, and the framing tells an agent that a request
        // from a member is what it is there for — so being able to post as a member has
        // to be granted, not assumed.
        // Presenting the room's token is the whole of the authorisation, and it is
        // presented on every call because that is where a credential already travels.
        // The first time it arrives from a member, remember it: Codex never posts for
        // itself — the bridge reads its answer out of its own log and publishes on its
        // behalf, with no header to carry anything.
        if (room.members.has(from) && holdsRoomPassword(room, headerToken)) {
          room.members.get(from).confirmed = true;
        }
        const refusal = refuseToPublish(room, from);
        if (refusal) {
          sendJson(403, {
            ok: false,
            error: refusal,
            message:
              refusal === "not_confirmed"
                ? "This room needs its own password. Ask the person at this terminal for it, then send it as the x-gyredeck-token header."
                : "You are not in this room.",
          });
          return;
        }
        // Addressing by the name the room uses, not only by id: those names exist so
        // that agents can refer to each other, and an address nobody can write is an
        // address nobody will use.
        const addressed = routedTo === MAIL_EVERYONE || room.members.has(routedTo)
          ? routedTo
          : [...room.members.keys()].find(
              (id) => labelIn(room, id).toLowerCase() === routedTo.toLowerCase(),
            ) ?? routedTo;
        if (roomIsFull(room, Buffer.byteLength(text, "utf8"))) {
          // Everything left in the room is owed to somebody, so making space would mean
          // taking a message from the session it was addressed to — which is what used to
          // happen, without a word to anyone. The sender is told instead, and told who to
          // wait for.
          const waiting = slowestReaders(room).map((id) => labelIn(room, id));
          sendJson(409, {
            ok: false,
            error: "room_full",
            message:
              `This room is holding all it can (${MAIL_MAX_MESSAGES} messages or ${Math.round(MAIL_MAX_ROOM_BYTES / 1024)} KB) and nothing in it has been read by everyone yet, so this message was not published — publishing it would have taken somebody else's.` +
              (waiting.length > 0 ? ` Waiting on: ${waiting.join(", ")}.` : "") +
              " Once they collect their mail there will be room again.",
          });
          return;
        }
        if (routedKind === "reaction" && reactionRunExhausted(room)) {
          sendJson(409, {
            ok: false,
            error: "reaction_run",
            message: `The last ${MAIL_MAX_REACTION_RUN} messages in this room are reactions, so this one was not published. A reaction is where an exchange stops — nothing answers one. If you have something to add, send it as a tell or an ask.`,
          });
          return;
        }
        const message = publishMail(room, from, text, replyTo, false, { to: addressed, kind: routedKind });
        // Delivery is per-agent and reported back so a caller can say what will happen
        // rather than guess: "queued" reaches an idle session, "on_next_turn" waits,
        // "not_notified" means it was published and deliberately woke nobody.
        const delivery = deliverMail(name, room, text, from, message);
        // A queued message is in the session's hands whether or not it answers, so it
        // is not still waiting to be collected. Leaving it pending would light the
        // chip on a session that had already been handed the message.
        if (delivery === "queued") {
          room.readSeq = Math.max(room.readSeq, message.seq);
          room.lastReadAt = message.ts;
        }
        sendJson(202, {
          ok: true,
          room: name,
          seq: message.seq,
          subscribers: room.clients.size,
          delivery,
        });
        return;
      }

      // GET /mail/<room>?since=<seq> — read what was missed. `since` is the highest
      // seq the caller has already handled, so a hook that runs once per turn can
      // pick up everything sent while its agent was idle.
      //
      // `collect=1` says the caller is the session's actual reader and is taking
      // delivery. Everything else is a look: the desktop panel polls this to draw the
      // thread, and if looking counted as collecting then opening a session would mark
      // its mail delivered while the agent had never seen it.
      if (req.method === "GET" && tail === undefined) {
        const room = mailRoomFor(name, false);
        // A room code that is not open answers like a room that is, but empty — which
        // reads as "nothing was said here" rather than "this room is gone". The person at
        // the terminal found it: a dead code and a code nobody ever minted were
        // indistinguishable, so a session could keep watching a room that had ended and
        // see only quiet. The send path and the stream beside this one already say so;
        // this one had been left out.
        if (!room && SYNC_CODE.test(name)) {
          sendJson(404, {
            ok: false,
            error: "no_such_room",
            message: "Nothing by that code is open. A room ends with its last member, and with the bridge that held it — there is nothing here to read, and there never will be again.",
          });
          return;
        }
        // The same rule the stream beside this one applies, and for the same reason: this
        // hands over the room's messages, and `collect=1` takes them — the cursor moves
        // and the session they were addressed to never sees them. It was the stream alone
        // that checked, so a backlog read was the way around it.
        if (room) {
          const refusal = refuseRoomRead(room, headerToken, url.searchParams.get("as"), "read");
          if (refusal) {
            sendJson(403, { ok: false, ...refusal });
            return;
          }
          if (room.members.size === 0 && !holdsMailboxCredential(name, headerToken)) {
            sendJson(401, { ok: false, error: "unauthorized", message: TOKEN_HINT });
            return;
          }
        }
        const parsed = Number.parseInt(url.searchParams.get("since") ?? "", 10);
        const since = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
        const messages = room ? room.messages.filter((message) => message.seq > since) : [];
        if (room) {
          room.touchedAt = Date.now();
          if (url.searchParams.get("collect") === "1") {
            markRead(room, url.searchParams.get("as"), messages.at(-1)?.seq ?? since, new Date().toISOString());
          }
        }
        sendJson(200, { ok: true, room: name, seq: room?.seq ?? 0, messages });
        return;
      }

      // GET /mail/<room>/events — subscribe and be pushed to.
      if (req.method === "GET" && tail === "events") {
        // Subscribing must not bring a *sync room* into being. A watcher that
        // resurrects a room code gets a stream nothing will ever flow through and no
        // way to tell — the same shape as the cursor that outlived its room and
        // reported success while discarding everything. A mailbox is different: it is
        // named after one session and watching it before anything is sent is normal.
        // Every refusal on this route answers in frames, because a watcher reads the
        // body for `data:` lines — that is what a stream is made of — and a plain JSON
        // error is printed and then dropped by the reader's own filter, leaving a watch
        // that looks like a quiet room. The status is kept for anything checking it,
        // and 404 matters most of the three: it is the one a watcher meets when the
        // room it is trying to rejoin no longer exists.
        const refuseStream = (status, error, message) => {
          res.writeHead(status, { "content-type": "text/event-stream; charset=utf-8", ...corsHeaders });
          res.end(`event: error\ndata: ${JSON.stringify({ ok: false, error, message, fatal: status === 404 })}\n\n`);
        };
        // Asked before the name is resolved, because resolving a mailbox name creates it:
        // an uncredentialed caller must otherwise be able to fill the room table with
        // mailboxes nobody will ever read. A room that has members is not covered here —
        // its own password is what stands in front of it, further down.
        const standing = SYNC_CODE.test(name) ? mailRooms.get(name) ?? null : null;
        if ((standing?.members.size ?? 0) === 0 && !holdsMailboxCredential(name, headerToken)) {
          refuseStream(401, "unauthorized", TOKEN_HINT);
          return;
        }
        const room = SYNC_CODE.test(name) ? mailRooms.get(name) : mailRoomFor(name, true);
        if (!room) {
          if (SYNC_CODE.test(name)) {
            refuseStream(404, "no_such_room", "Nothing by that code is open. A room ends with its last member, and with the bridge that held it. Stop watching; re-opening will be refused again.");
          } else {
            refuseStream(429, "too_many_rooms", "No room can be opened for this name right now.");
          }
          return;
        }
        // Reading a room people were put into needs that room's password — not the
        // machine's, which every agent can read — and it needs the reader to still be
        // in the room. The password alone is not enough: a session that has been
        // disconnected still remembers it, and without this its watch would keep
        // running on a room it was removed from.
        const watcher = url.searchParams.get("as") ?? null;
        const refusal = refuseRoomRead(room, headerToken, watcher, "watch");
        if (refusal) {
          refuseStream(403, refusal.error, refusal.message);
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          ...corsHeaders,
        });
        res.write(
          `: gyredeck mail room ${name} connected ${new Date().toISOString()}` +
            ` expires in ${MAIL_STREAM_MAX_MS / 1000}s\n\n`,
        );
        // Said in the stream as well as enforced, so a watcher can tell a deliberate
        // expiry from a connection that dropped.
        const expiry = setTimeout(() => {
          try {
            res.write(`: gyredeck stream expired after ${MAIL_STREAM_MAX_MS / 1000}s\n\n`);
            res.end();
          } catch {
            // Already gone; the close handler has cleaned up.
          }
        }, MAIL_STREAM_MAX_MS);
        expiry.unref?.();
        res.on("close", () => clearTimeout(expiry));

        // Hand back what was missed while disconnected. Without this a subscriber
        // that drops has no way to close the gap except to fall back to the
        // read endpoint, and a push-only reader would simply lose those messages.
        // `since=resume` asks the room where this watcher had got to, instead of the
        // watcher telling it. Tracking a seq client-side is the part of a watch that
        // keeps going wrong: it takes a second command per frame, and the obvious way
        // to write that captures the stream into a variable, at which point nothing
        // reaches the notifier and the room looks silent. Two sessions wrote that same
        // bug on the same day, one of them the author of the instruction.
        const asked = url.searchParams.get("since");
        const streamed = watcher ? room.members.get(watcher)?.streamSeq : null;
        const resumeFrom =
          asked === "resume"
            ? (typeof streamed === "number" ? streamed : 0)
            : Number.parseInt(req.headers["last-event-id"] ?? asked ?? "", 10);
        if (Number.isInteger(resumeFrom) && resumeFrom > 0) {
          const member = watcher ? room.members.get(watcher) : null;
          for (const message of room.messages) {
            if (message.seq <= resumeFrom) continue;
            // The same rule as a live push, applied by the same function rather than
            // restated — the two paths were written apart and drifted apart, so a watch
            // that reconnected was handed the acknowledgements and room notices it had
            // just been spared. Every five minutes, for every member.
            if (wakesMember(message, watcher)) res.write(mailFrame(message));
            // Moved past whether it was written or not, and moved here rather than only
            // where frames are pushed. Catching up used to hand messages over without
            // recording that it had, so `since=resume` answered with the same cursor
            // next time and replayed the same backlog — every reconnect, for as long as
            // the room stayed open. A quiet room woke everyone in it every five minutes.
            if (member) member.streamSeq = Math.max(member.streamSeq ?? 0, message.seq);
          }
        }

        // Tagged so the stream can be closed if this member is later removed. A watch
        // that outlives its membership is the same silent failure as watching a room
        // that no longer exists.
        res.gyredeckWatcher = watcher;
        room.clients.add(res);
        room.touchedAt = Date.now();
        req.on("close", () => {
          room.clients.delete(res);
          room.touchedAt = Date.now();
        });
        return;
      }

      sendJson(405, { ok: false, error: "method_not_allowed" });
      return;
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  return { server, emitLocal, capabilities, eventLog };
}

function readRecentEvents(logFile, maxRecent) {
  try {
    if (!existsSync(logFile)) return [];
    return readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .slice(-maxRecent)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((event) => event && typeof event.type === "string" && typeof event.id === "string");
  } catch {
    return [];
  }
}

// ── CLI ──

const args = process.argv.slice(2);
const portArg = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : null;
const hostArg = args.includes("--host") ? args[args.indexOf("--host") + 1] : null;
const daemon = args.includes("--daemon");
const parentStdio = args.includes("--parent-stdio");

/**
 * Everything below starts a bridge, so it runs only when this file is the program.
 *
 * Importing it — which the tests do, to draw from the very generator the bridge uses
 * rather than a copy of it that could silently stop matching — used to bind the port and
 * collide with whatever bridge was already running.
 */
const isEntryPoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const config = readConfig();
  if (portArg && Number.isInteger(portArg)) config.port = portArg;
  if (hostArg === BRIDGE_HOST) config.host = hostArg;

  const { server, emitLocal, eventLog } = startBridge(config);

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`✗ Port ${config.port} already in use (Letta mod or another bridge is running)`);
      process.exit(1);
    }
    console.error(`✗ Bridge error: ${error.message}`);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    const bridgeReadyEvent = {
      version: PROTOCOL_VERSION,
      id: randomUUID(),
      type: "bridge_ready",
      timestamp: new Date().toISOString(),
      agentId: null, agentName: null, conversationId: null,
      cwd: null, model: null, permissionMode: null, runtime: null,
      data: {
        port: config.port,
        logFile: config.logFile,
        ssePath: "/events",
        healthPath: "/health",
      },
    };
    emitLocal(bridgeReadyEvent);

    console.log(`✓ Gyredeck standalone bridge running on ${config.host}:${config.port}`);
    console.log(`  Log: ${config.logFile}`);
    console.log(`  SSE: http://${config.host}:${config.port}/events`);
    console.log(`  Health: http://${config.host}:${config.port}/health`);
    console.log(`  Mode: standalone (accepts Letta /ingest + AGY /ingest + hooks)`);

    if (daemon) {
      // Detach from terminal
      process.stdin.unref();
      process.stdout.write("");
      if (typeof process.disconnect === "function") process.disconnect();
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n⏹ Bridge shutting down...");
    server.close();
    eventLog.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (parentStdio) {
    process.stdin.resume();
    process.stdin.once("end", shutdown);
    process.stdin.once("error", shutdown);
  }

}
