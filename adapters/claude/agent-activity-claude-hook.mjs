import { request } from "node:http";
import { readFile, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Agent Activity Claude Code Hook Adapter
 *
 * Translates Claude Code lifecycle hook events into AgentActivityEvent payloads and
 * posts them to the Agent Activity bridge. Registered in Claude Code settings.json
 * and invoked as a command with `--event <HookEventName>`; Claude Code also
 * sends a JSON payload on stdin whose `hook_event_name` field is authoritative.
 *
 * Usage (from settings.json hooks):
 *   node agent-activity-claude-hook.mjs --event PreToolUse
 *
 * The adapter never blocks Claude Code: it exits 0 with no stdout, so a
 * PreToolUse hook is treated as "allow" and other hooks proceed normally.
 */

const DEFAULT_ENDPOINT = { hostname: "127.0.0.1", port: 47_621 };
const CONFIG_DIR = join(homedir(), ".config", "agent-activity");
const HOST_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1_000);

/**
 * Read the current model from the tail of the Claude transcript (JSONL). The last
 * assistant entry carries `message.model`. Only the tail is read, so this stays cheap
 * even for large transcripts. Returns null if unavailable.
 */
const readModelFromTranscript = async (transcriptPath) => {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return null;
  try {
    const handle = await open(transcriptPath, "r");
    try {
      const { size } = await handle.stat();
      const readLen = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(readLen);
      await handle.read(buf, 0, readLen, size - readLen);
      const matches = [...buf.toString("utf8").matchAll(/"model"\s*:\s*"([^"<]+)"/g)];
      return matches.at(-1)?.[1] ?? null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

/** Read bridge endpoint from Agent Activity config. */
const readEndpoint = async () => {
  try {
    const config = JSON.parse(await readFile(join(CONFIG_DIR, "agent-activity.config.json"), "utf8"));
    const hostname = config.host === DEFAULT_ENDPOINT.hostname ? config.host : DEFAULT_ENDPOINT.hostname;
    const port = Number.isInteger(config.port) ? config.port : DEFAULT_ENDPOINT.port;
    if (port < 1 || port > 65_535) return DEFAULT_ENDPOINT;
    return { hostname, port };
  } catch {
    return DEFAULT_ENDPOINT;
  }
};

/** Read shared ingest token so forwarded runtime identity is trusted. */
const readIngestToken = async () => {
  try {
    const value = (await readFile(join(CONFIG_DIR, "agent-activity.ingest-token"), "utf8")).trim();
    return /^[a-f0-9]{64}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
};

/** Read JSON payload from stdin. */
const readInput = async () => {
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  try {
    return body.trim() ? JSON.parse(body) : {};
  } catch {
    return {};
  }
};

/** POST a JSON payload to the Agent Activity bridge. */
const post = (endpoint, token, path, payload) =>
  new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    };
    if (token && path === "/ingest") {
      headers["x-agent-activity-token"] = token;
    }

    const req = request(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        path,
        method: "POST",
        headers,
        timeout: 750,
      },
      (res) => {
        res.resume();
        resolve();
      },
    );
    req.on("error", resolve);
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });

/** Parse a CLI flag value, e.g. --event PreToolUse. */
const getCliArg = (flag) => {
  const index = process.argv.indexOf(flag);
  return index !== -1 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
};

const main = async () => {
  const respond = () => process.exit(0);

  try {
    const input = await readInput();
    // Claude Code puts the authoritative event name in the payload; fall back to --event.
    const eventType = typeof input.hook_event_name === "string" && input.hook_event_name.length > 0
      ? input.hook_event_name
      : getCliArg("--event");
    if (!eventType) return respond();

    const endpoint = await readEndpoint();
    const token = await readIngestToken();

    const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();
    const conversationId = typeof input.session_id === "string" && input.session_id.length > 0
      ? input.session_id
      : null;
    const permissionMode = typeof input.permission_mode === "string" && input.permission_mode.length > 0
      ? input.permission_mode
      : null;
    const model = await readModelFromTranscript(input.transcript_path);

    /** Build a protocol-v2 AgentActivityEvent envelope. */
    const buildEvent = (type, data = {}) => ({
      version: 2,
      id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      agentId: null,
      agentName: null,
      conversationId,
      cwd,
      model,
      permissionMode,
      runtime: {
        sourcePid: process.pid,
        sourcePpid: Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : null,
        sourceStartedAtMs: HOST_STARTED_AT_MS,
        sourceKind: "claudeCodeHook",
      },
      data,
    });

    const posts = [];

    switch (eventType) {
      case "SessionStart":
        posts.push(post(endpoint, token, "/ingest", buildEvent("conversation_open", {
          reason: typeof input.source === "string" ? input.source : "startup",
          previousConversationId: null,
        })));
        break;
      case "UserPromptSubmit":
        posts.push(post(endpoint, token, "/ingest", buildEvent("turn_start", {
          inputCount: 1,
        })));
        break;
      case "PreToolUse":
        posts.push(post(endpoint, token, "/ingest", buildEvent("tool_start", {
          toolCallId: null,
          toolName: typeof input.tool_name === "string" ? input.tool_name : "unknown",
          argKeys: input.tool_input && typeof input.tool_input === "object"
            ? Object.keys(input.tool_input).sort()
            : [],
        })));
        break;
      case "PostToolUse": {
        const response = input.tool_response;
        const status = response && typeof response === "object" && response.success === false ? "error" : "success";
        const outputLength = typeof response === "string"
          ? response.length
          : response && typeof response === "object" && typeof response.stdout === "string"
            ? response.stdout.length
            : null;
        posts.push(post(endpoint, token, "/ingest", buildEvent("tool_end", {
          toolCallId: null,
          toolName: typeof input.tool_name === "string" ? input.tool_name : "unknown",
          status,
          outputLength,
        })));
        break;
      }
      case "PreCompact":
        posts.push(post(endpoint, token, "/ingest", buildEvent("compact_start", {
          trigger: typeof input.trigger === "string" ? input.trigger : "manual",
        })));
        break;
      case "Notification":
        posts.push(post(endpoint, token, "/hook/attention", {
          hookId: randomUUID(),
          hookEventName: "Notification",
          source: "hook",
          workingDirectory: cwd,
          conversationId,
          message: typeof input.message === "string" ? input.message : null,
        }));
        break;
      case "Stop":
      case "SubagentStop":
        posts.push(post(endpoint, token, "/hook/stop", {
          hookId: randomUUID(),
          hookEventName: eventType,
          source: "hook",
          workingDirectory: cwd,
          conversationId,
          toolName: null,
          message: null,
        }));
        break;
      case "SessionEnd":
        posts.push(post(endpoint, token, "/ingest", buildEvent("conversation_close", {
          reason: typeof input.reason === "string" ? input.reason : "quit",
        })));
        break;
      default:
        break;
    }

    if (posts.length > 0) await Promise.all(posts);
    respond();
  } catch {
    respond();
  }
};

main();
