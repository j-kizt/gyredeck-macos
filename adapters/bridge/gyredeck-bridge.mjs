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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    endpoints: { health: true, snapshot: true, sse: true, hookStop: true, hookAttention: true, ingest: true, mail: true },
    sessionActions: { focusTerminal: false, endSession: false, dismissEnded: true },
  };

  const clients = new Set();
  const maxRecent = 500;
  const recent = readRecentEvents(config.logFile, maxRecent);
  const tracker = createScopeTracker();

  const emitLocal = (payload) => {
    tracker.rememberScope(payload);
    recent.push(payload);
    if (recent.length > maxRecent) recent.shift();

    const serialized = JSON.stringify(payload);
    appendFileSync(config.logFile, `${serialized}\n`);

    const frame = `event: ${payload.type}\ndata: ${serialized}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
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
        usage: data.usage && typeof data.usage === "object" ? data.usage : null,
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
  const mailRooms = new Map();

  // Rooms are created by whoever speaks first, so they need an upper bound and a way
  // to go away again; without both, any local process could grow this map forever.
  const sweepMailRooms = () => {
    const now = Date.now();
    for (const [name, room] of mailRooms) {
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
    const room = { seq: 0, readSeq: 0, messages: [], clients: new Set(), touchedAt: Date.now() };
    mailRooms.set(name, room);
    return room;
  };

  // The seq doubles as the SSE event id, which is what lets a dropped subscriber
  // resume: EventSource replays the last id it saw back as Last-Event-ID.
  const mailFrame = (message) =>
    `id: ${message.seq}\nevent: mail\ndata: ${JSON.stringify(message)}\n\n`;

  const publishMail = (room, from, text, replyTo) => {
    room.seq += 1;
    room.touchedAt = Date.now();
    // replyTo is the sender naming where it is listening. Without it a recipient can
    // be reached but cannot answer, which is how the first version of this ended up
    // needing a human to carry every reply by hand.
    const message = { seq: room.seq, from, text, replyTo: replyTo ?? null, ts: new Date().toISOString() };
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
    if (pushed) {
      room.readSeq = Math.max(room.readSeq, message.seq);
      room.lastReadAt = message.ts;
    }
    return message;
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

    if (req.url === "/mail" || req.url.startsWith("/mail/") || req.url.startsWith("/mail?")) {
      const sendJson = (status, body) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...corsHeaders });
        res.end(JSON.stringify(body));
      };

      // Mail is a channel agents read and act on, not observational data like
      // /ingest, so an untrusted caller must not be able to put words into another
      // agent's input. There is no degraded mode here: no token, no access.
      if (!matchesIngestToken(config.ingestToken, req.headers["x-gyredeck-token"])) {
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
          rooms: [...mailRooms].map(([name, room]) => ({
            room: name,
            seq: room.seq,
            readSeq: room.readSeq,
            pending: Math.max(0, room.seq - room.readSeq),
            buffered: room.messages.length,
            subscribers: room.clients.size,
            lastMessageAt: room.messages.at(-1)?.ts ?? null,
            lastReadAt: room.lastReadAt ?? null,
          })),
        });
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
        const message = publishMail(room, from, text, replyTo);
        sendJson(202, { ok: true, room: name, seq: message.seq, subscribers: room.clients.size });
        return;
      }

      // GET /mail/<room>?since=<seq> — read what was missed. `since` is the highest
      // seq the caller has already handled, so a hook that runs once per turn can
      // pick up everything sent while its agent was idle.
      if (req.method === "GET" && tail === undefined) {
        const room = mailRoomFor(name, false);
        const parsed = Number.parseInt(url.searchParams.get("since") ?? "", 10);
        const since = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
        const messages = room ? room.messages.filter((message) => message.seq > since) : [];
        if (room) {
          // Advance on what was actually handed over, and never backwards: a caller
          // re-reading from an old `since` is inspecting the room, not un-reading it.
          room.readSeq = Math.max(room.readSeq, messages.at(-1)?.seq ?? since);
          room.lastReadAt = new Date().toISOString();
          room.touchedAt = Date.now();
        }
        sendJson(200, { ok: true, room: name, seq: room?.seq ?? 0, messages });
        return;
      }

      // GET /mail/<room>/events — subscribe and be pushed to.
      if (req.method === "GET" && tail === "events") {
        const room = mailRoomFor(name, true);
        if (!room) {
          sendJson(429, { ok: false, error: "too_many_rooms" });
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          ...corsHeaders,
        });
        res.write(`: gyredeck mail room ${name} connected ${new Date().toISOString()}\n\n`);

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
