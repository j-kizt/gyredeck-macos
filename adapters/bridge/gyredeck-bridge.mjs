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

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

function startBridge(config) {
  mkdirSync(dirname(config.logFile), { recursive: true });

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
    const label = providerLabelFor(conversationId);
    found.room.members.delete(conversationId);
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
    appendFileSync(config.logFile, `${serialized}\n`);

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

  const emitHookStop = (data = {}) => {
    const now = Date.now();
    const scope = tracker.hookScope(data, now);
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

  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, accept, x-gyredeck-token",
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
   * How a member is named to people and to other agents.
   *
   * Qualified by workspace only when it has to be: a lone Codex is "Codex", and two of
   * them are "Codex · J-Kitz" and "Codex · AD1". Adding the workspace unconditionally
   * would make every mention longer to no purpose, and the ambiguity it fixes only
   * exists when the room actually holds two of the same agent.
   */
  const memberLabelsFor = (conversationIds) => {
    const ids = [...conversationIds];
    const counts = new Map();
    for (const id of ids) {
      const provider = providerLabelFor(id);
      counts.set(provider, (counts.get(provider) ?? 0) + 1);
    }
    // Provider alone where it is unique; provider and workspace where that is enough;
    // a short id on top where it is not. Two sessions of one agent in one checkout is
    // an ordinary thing to be doing, and it is exactly the case where telling them
    // apart matters most.
    const qualified = new Map(
      ids.map((id) => {
        const provider = providerLabelFor(id);
        if ((counts.get(provider) ?? 0) < 2) return [id, provider];
        const workspace = workspaceFor(id);
        return [id, workspace ? `${provider} · ${workspace}` : provider];
      }),
    );
    const stillClashing = new Map();
    for (const label of qualified.values()) {
      stillClashing.set(label, (stillClashing.get(label) ?? 0) + 1);
    }
    return new Map(
      ids.map((id) => {
        const label = qualified.get(id);
        if ((stillClashing.get(label) ?? 0) < 2) return [id, label];
        // The id is meaningless to a person, which is why it is last and short. It is
        // still better than a name that points at two sessions at once: a request to
        // one of them would read as a request to the other.
        return [id, `${label} #${id.slice(0, 6)}`];
      }),
    );
  };

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

  // Locate an agent CLI the way the desktop app locates node: a process launched from
  // Finder or Spotlight does not inherit the shell's PATH, so the usual install
  // directories have to be searched explicitly.
  const agentBinaryCache = new Map();
  const findAgentBinary = (name) => {
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

  const readCodexReplies = (rolloutPath, sinceMs) => {
    const replies = [];
    let content = "";
    try { content = readFileSync(rolloutPath, "utf8"); } catch { return replies; }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== "event_msg" || entry.payload?.type !== "task_complete") continue;
      const text = entry.payload.last_agent_message;
      if (typeof text !== "string" || !text.trim()) continue;
      const at = Date.parse(entry.timestamp ?? "");
      if (Number.isFinite(at) && at < sinceMs) continue;
      replies.push({ turnId: entry.payload.turn_id ?? null, text: text.trim() });
    }
    return replies;
  };

  // Mail rooms: a named channel for agents on this machine to talk to each other,
  // multiplexed onto the bridge port so no second listener has to be opened. A room
  // is just a key. Subscribers holding an SSE connection are pushed to immediately;
  // peers that can only check in periodically read the backlog instead, which is the
  // only workable shape for a hook process that lives for milliseconds and would
  // otherwise miss anything sent while its agent was idle.
  const MAIL_ROOM_NAME = /^[A-Za-z0-9_-]{1,64}$/;
  const MAIL_MAX_ROOMS = 32;
  const MAIL_MAX_MESSAGES = 100;
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
  const SYNC_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
  /** A room code, as opposed to a conversation id used as a mailbox name. */
  const SYNC_CODE = /^sync-[a-z2-9]{4}$/;
  const mailRooms = new Map();

  // Rooms are created by whoever speaks first, so they need an upper bound and a way
  // to go away again; without both, any local process could grow this map forever.
  const sweepMailRooms = () => {
    const now = Date.now();
    for (const [name, room] of mailRooms) {
      // A room with members was set up deliberately and stays until its last member
      // leaves; only unattended mailboxes age out.
      if (room.members.size > 0) continue;
      if (room.clients.size === 0 && now - room.touchedAt > MAIL_ROOM_IDLE_MS) mailRooms.delete(name);
    }
  };

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
      clients: new Set(),
      members: new Map(),
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
      const labels = memberLabelsFor(room.members.keys());
      return [...room.members].map(([conversationId, member]) => ({
        conversationId,
        provider: labels.get(conversationId) ?? providerLabelFor(conversationId),
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
  const ROOM_SENDER = "gyredeck-room";

  /**
   * Tell a session it is out, and cut anything it left running.
   *
   * The notice cannot go to the room — it is no longer allowed to read it — so it goes
   * to the session's own mailbox, where its next drain will find it, and is pushed to
   * Codex, which has no drain. Any stream it holds on this room is ended here rather
   * than left to fail quietly on the next message: a watch that outlives its membership
   * looks exactly like a quiet room.
   */
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
      " nor post to it now, and its password will not let you back in. If you have a" +
      " watch running on that room, stop it: it has been closed from this end and" +
      " re-arming it will be refused. Nothing about this room will reach you again" +
      " unless someone puts you back in it.]";
    publishMail(mailbox, ROOM_SENDER, text, null);
    deliverMail(conversationId, mailbox, text, ROOM_SENDER);
  };

  const announceMembership = (name, room, note) => {
    const labels = memberLabelsFor(room.members.keys());
    const present = [...room.members.keys()].map((id) => labels.get(id) ?? providerLabelFor(id));
    const text = `${note} Members now: ${present.join(", ") || "nobody"}.`;
    publishMail(room, ROOM_SENDER, text, null);
    // News about the room travels the same way anything else does, or a Codex member
    // would never hear it: it does not read an inbox, it is pushed to.
    deliverMail(name, room, text, ROOM_SENDER);
  };


  // Longer than a room code and from the same alphabet. A code is a name people say to
  // each other; this is the thing that grants the right to speak, so it is not meant to
  // be guessable or memorable.
  const newRoomPassword = () =>
    `gk-${Array.from(randomBytes(10))
      .map((byte) => SYNC_CODE_ALPHABET[byte % SYNC_CODE_ALPHABET.length])
      .join("")}`;

  const newSyncCode = () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const suffix = Array.from(randomBytes(4))
        .map((byte) => SYNC_CODE_ALPHABET[byte % SYNC_CODE_ALPHABET.length])
        .join("");
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
  const describeInbox = (messages, sync, as) => ({
    messages,
    ...(sync
      ? {
          room: sync.name,
          members: (() => {
            const labels = memberLabelsFor(sync.room.members.keys());
            return [...sync.room.members].map(([conversationId, member]) => ({
              conversationId,
              provider: labels.get(conversationId) ?? providerLabelFor(conversationId),
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

  const refuseToPublish = (room, from) => {
    if (room.members.size === 0) return null;
    if (from === ROOM_SENDER) return null;
    const sender = room.members.get(from);
    if (!sender) return "not_a_member";
    if (sender.confirmed !== true) return "not_confirmed";
    return null;
  };

  const publishMail = (room, from, text, replyTo, fromSession = false) => {
    room.seq += 1;
    mailOrdinal += 1;
    room.touchedAt = Date.now();
    // replyTo is the sender naming where it is listening. Without it a recipient can
    // be reached but cannot answer, which is how the first version of this ended up
    // needing a human to carry every reply by hand.
    const message = {
      seq: room.seq,
      ord: mailOrdinal,
      from,
      text,
      replyTo: replyTo ?? null,
      ts: new Date().toISOString(),
    };
    room.messages.push(message);
    if (room.messages.length > MAIL_MAX_MESSAGES) room.messages.shift();

    const frame = mailFrame(message);
    let pushed = false;
    for (const res of room.clients) {
      try {
        res.write(frame);
        pushed = true;
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
    if (author) {
      author.readSeq = Math.max(author.readSeq, message.seq);
      author.lastReadAt = message.ts;
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
      for (const reply of readCodexReplies(rolloutPath, since)) {
        seen.add(reply.turnId ?? reply.text);
        if (!claimCodexReply(threadId, reply)) continue;
        // A harvested answer is still that session speaking, and a session nobody
        // confirmed does not get to speak just because the bridge is the one holding
        // the pen.
        if (refuseToPublish(room, threadId)) continue;
        publishMail(room, threadId, reply.text, null, true);
      }
      if (seen.size === 0 && Date.now() < deadline) setTimeout(poll, CODEX_REPLY_POLL_MS).unref?.();
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
  const deliverMail = (roomName, room, text, from) => {
    const recipients = room.members.size > 0
      // Nobody is delivered their own message, and a notice from the room itself goes
      // to everyone.
      ? [...room.members.keys()].filter((id) => id !== from)
      : [roomName];
    if (recipients.length === 0) return "no_recipients";

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
              " its password you can neither read what is said in it nor answer. Ask the" +
              " person at this terminal for the room's password, then wait — do not try" +
              " to send it anywhere yourself. Your sandbox has no network, so a curl to" +
              " Gyredeck fails before it leaves this process. Asking is the whole of" +
              " your part: when they read the password out of Gyredeck, you are let in" +
              " there and then, and the room simply starts arriving. Nothing further" +
              " will reach you until that happens.]"
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
        // room. What they say is the opposite of what the others are told: Codex runs
        // sandboxed with no network, so `curl` to this bridge fails before it leaves
        // the process ("Couldn't connect ... after 0 ms"). It answers by writing its
        // answer as ordinary text, which the bridge harvests from its own rollout log.
        let outgoing = text;
        if (member && !member.toldHowToAnswer) {
          member.toldHowToAnswer = true;
          outgoing =
            `[Gyredeck: this arrived from room ${roomName}. Answer by writing your reply` +
            " as ordinary text in this turn — do not try to reach Gyredeck over the" +
            " network. Your sandbox has no network access, so curl to 127.0.0.1 will" +
            " fail immediately; the bridge reads your answer from your own session log" +
            " and puts it in the room for you. You also need no watch on the room:" +
            " messages are pushed into your session whether or not you are doing" +
            " anything. Say what came in and who sent it, and after you answer, say" +
            " what you sent back.]\n\n" +
            text;
        }
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
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/ingest") {
      const body = await readJsonBody(req);
      if (body && typeof body === "object" && typeof body.type === "string" && typeof body.id === "string") {
        const runtimeTrusted = matchesIngestToken(config.ingestToken, req.headers["x-gyredeck-token"]);
        const payload = runtimeTrusted ? body : { ...body, runtime: null };
        emitLocal(payload);
        res.writeHead(202, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
        res.end(JSON.stringify({ ok: true, type: body.type, runtimeTrusted }));
        return;
      }
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
      res.end(JSON.stringify({ ok: false, error: "invalid_event" }));
      return;
    }

    if (req.method === "POST" && req.url === "/hook/stop") {
      const body = await readJsonBody(req);
      emitHookStop(body);
      res.writeHead(202, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
      res.end(JSON.stringify({ ok: true, type: "turn_complete" }));
      return;
    }

    if (req.method === "POST" && req.url === "/hook/attention") {
      const body = await readJsonBody(req);
      emitHookAttention(body);
      res.writeHead(202, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
      res.end(JSON.stringify({ ok: true, type: "attention_requested" }));
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
      res.end(JSON.stringify({ ok: true, name: "gyredeck", version: PROTOCOL_VERSION, mode: "standalone", clients: clients.size, capabilities }));
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
        for (const conversationId of [...room.members.keys()]) {
          room.members.delete(conversationId);
          partWithMember(code, room, conversationId, "the room was closed");
        }
        // Anything still holding the stream that was not a member — nothing should be,
        // but a socket outliving its membership is exactly the bug this guards.
        for (const res of [...room.clients]) {
          try {
            res.write(`: gyredeck room ${code} closed\n\n`);
            res.end();
          } catch {
            // Already gone.
          }
        }
        room.clients.clear();
        mailRooms.delete(code);
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
        // has no network from inside its sandbox, so asking it to confirm itself asks
        // for something impossible; the key press is the consent, and it is applied
        // here on its behalf.
        for (const [conversationId, member] of room.members) {
          if (member.confirmed === true) continue;
          if (providerByConversation.get(conversationId) !== "codexCliHook") continue;
          member.confirmed = true;
          member.toldUnconfirmed = false;
          member.toldHowToAnswer = false;
          const labels = memberLabelsFor(room.members.keys());
          announceMembership(
            code,
            room,
            `${labels.get(conversationId) ?? providerLabelFor(conversationId)} was confirmed by the room's owner and can now speak here.`,
          );
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
        if (!room || !room.members.has(conversationId)) {
          sendJson(404, { ok: false, error: "not_a_member" });
          return;
        }
        const member = room.members.get(conversationId);
        if (member.confirmed === true) {
          sendJson(200, { ok: true, ...describeRoom(code, room, conversationId) });
          return;
        }
        if (!holdsRoomPassword(room, password)) {
          sendJson(403, { ok: false, error: "bad_password" });
          return;
        }
        member.confirmed = true;
        member.toldUnconfirmed = false;
        // Being let in is a fresh start: the standing instructions are worth one more
        // airing now that they can be acted on.
        member.toldHowToAnswer = false;
        room.touchedAt = Date.now();
        announceMembership(
          code,
          room,
          `${providerLabelFor(conversationId)} was confirmed by the room's owner and can now speak here.`,
        );
        sendJson(200, { ok: true, ...describeRoom(code, room, conversationId) });
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
          announceMembership(code, room, `${memberLabelsFor(room.members.keys()).get(conversationId) ?? providerLabelFor(conversationId)} joined this room.`);
        }
        room.touchedAt = Date.now();
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
        const label = providerLabelFor(conversationId);
        room.members.delete(conversationId);
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
      // decides what is allowed once inside.
      const headerToken = req.headers["x-gyredeck-token"];
      const machineToken = matchesIngestToken(config.ingestToken, headerToken);
      if (!machineToken && typeof headerToken !== "string") {
        sendJson(401, { ok: false, error: "unauthorized" });
        return;
      }
      sweepMailRooms();

      const url = new URL(req.url, "http://127.0.0.1");
      const segments = url.pathname.split("/").filter(Boolean);

      // GET /mail — which rooms exist, so a peer can find its counterpart.
      if (req.method === "GET" && segments.length === 1) {
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
        const labels = memberLabelsFor(room.members.keys());
        return [...room.members.keys()].map((id) => labels.get(id) ?? providerLabelFor(id));
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
          for (const [roomName, room] of sources) {
            if (!room) continue;
            const reader = readerFor(room, as);
            for (const message of room.messages) {
              if (message.seq > reader.readSeq) fresh.push({ room: roomName, ...message });
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
              if (taken.length > 0) markRead(room, as, taken.at(-1).seq, at);
            }
          }
          return { collected, sync };
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

          const answer = (collected, sync, timedOut) =>
            sendJson(200, { ok: true, timedOut, ...describeInbox(collected, sync, as) });

          const first = collectInbox();
          if (first.collected.length > 0) {
            answer(first.collected, first.sync, false);
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
          const finish = (collected, sync, timedOut) => {
            if (done) return;
            done = true;
            mailWaiters.delete(waiter);
            clearTimeout(timer);
            answer(collected, sync, timedOut);
          };
          const timer = setTimeout(() => finish([], syncRoomFor(as), true), waitMs);
          timer.unref?.();
          waiter.check = () => {
            // A request already gone must not have its position advanced: collect=1
            // would mark messages delivered into a socket nobody is reading.
            if (done || req.destroyed) return;
            const next = collectInbox();
            if (next.collected.length > 0) finish(next.collected, next.sync, false);
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

        const { collected, sync } = collectInbox();
        sendJson(200, { ok: true, ...describeInbox(collected, sync, as) });
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
        const room = mailRoomFor(name, true);
        if (!room) {
          sendJson(429, { ok: false, error: "too_many_rooms" });
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
        const message = publishMail(room, from, text, replyTo);
        // Delivery is per-agent and reported back so a caller can say what will happen
        // rather than guess: "queued" reaches an idle session, "on_next_turn" waits.
        const delivery = deliverMail(name, room, text, from);
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
        const room = SYNC_CODE.test(name) ? mailRooms.get(name) : mailRoomFor(name, true);
        if (!room) {
          sendJson(SYNC_CODE.test(name) ? 404 : 429, {
            ok: false,
            error: SYNC_CODE.test(name) ? "no_such_room" : "too_many_rooms",
            ...(SYNC_CODE.test(name)
              ? { message: "Nothing by that code is open. A room ends with its last member." }
              : {}),
          });
          return;
        }
        // Reading a room people were put into needs that room's password — not the
        // machine's, which every agent can read — and it needs the reader to still be
        // in the room. The password alone is not enough: a session that has been
        // disconnected still remembers it, and without this its watch would keep
        // running on a room it was removed from.
        const watcher = url.searchParams.get("as") ?? null;
        if (room.members.size > 0) {
          if (!holdsRoomPassword(room, headerToken)) {
            sendJson(403, {
              ok: false,
              error: "not_confirmed",
              message: "This room needs its own password. Ask the person at this terminal for it, then send it as the x-gyredeck-token header.",
            });
            return;
          }
          if (!watcher || room.members.get(watcher)?.confirmed !== true) {
            sendJson(403, {
              ok: false,
              error: "not_a_member",
              message: "Name yourself with ?as=<conversationId>; only a confirmed member of this room may watch it.",
            });
            return;
          }
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
        const resumeFrom = Number.parseInt(
          req.headers["last-event-id"] ?? url.searchParams.get("since") ?? "",
          10,
        );
        if (Number.isInteger(resumeFrom) && resumeFrom > 0) {
          for (const message of room.messages) {
            if (message.seq > resumeFrom) res.write(mailFrame(message));
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

  return { server, emitLocal, capabilities };
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

const config = readConfig();
if (portArg && Number.isInteger(portArg)) config.port = portArg;
if (hostArg === BRIDGE_HOST) config.host = hostArg;

const { server, emitLocal } = startBridge(config);

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
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
if (parentStdio) {
  process.stdin.resume();
  process.stdin.once("end", shutdown);
  process.stdin.once("error", shutdown);
}
