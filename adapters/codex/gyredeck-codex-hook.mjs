import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Gyredeck Codex Hook Adapter
 *
 * Translates Codex CLI lifecycle hooks into GyredeckEvent payloads and posts them to
 * the Gyredeck bridge. Registered in ~/.codex/hooks.json and invoked as a command with
 * `--event <HookEventName>`; Codex also sends a JSON payload on stdin whose
 * `hook_event_name` is authoritative.
 *
 * Usage (from hooks.json):
 *   node gyredeck-codex-hook.mjs --event PreToolUse
 *
 * This replaces the notify-based integration, which could only report turn completion
 * and had to synthesise `codex:<cwd>` as an id because notify carries no session id.
 * Hooks report a real session_id, so Codex sessions are now resumable and no longer
 * collapse together when two run in the same directory.
 *
 * Every path writes `{}` to stdout and exits 0. Codex reads stdout as a hook decision:
 * an empty object states no opinion, which is what keeps PreToolUse and
 * PermissionRequest from turning this reporter into a gate.
 */

const DEFAULT_ENDPOINT = { hostname: "127.0.0.1", port: 47_621 };
const CONFIG_DIR = join(homedir(), ".config", "gyredeck");
const HOST_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1_000);



/** Read bridge endpoint from Gyredeck config. */
const readEndpoint = async () => {
  try {
    const config = JSON.parse(await readFile(join(CONFIG_DIR, "gyredeck.config.json"), "utf8"));
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
    const value = (await readFile(join(CONFIG_DIR, "gyredeck.ingest-token"), "utf8")).trim();
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

/** POST a JSON payload to the Gyredeck bridge. */
const post = (endpoint, token, path, payload) =>
  new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    };
    if (token && path === "/ingest") {
      headers["x-gyredeck-token"] = token;
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
  // Codex reads stdout as a decision object. `{}` is "no opinion" — deliberately not
  // an allow, so this never overrides the user's own hooks or approval settings.
  const respond = () => {
    process.stdout.write("{}\n");
    process.exit(0);
  };

  try {
    const input = await readInput();
    const eventType = typeof input.hook_event_name === "string" && input.hook_event_name.length > 0
      ? input.hook_event_name
      : getCliArg("--event");
    if (!eventType) return respond();

    const endpoint = await readEndpoint();
    const token = await readIngestToken();

    const str = (value) => (typeof value === "string" && value.length > 0 ? value : null);
    const cwd = str(input.cwd) ?? process.cwd();
    const conversationId = str(input.session_id);
    const model = str(input.model);
    const permissionMode = str(input.permission_mode);
    const toolName = str(input.tool_name) ?? "unknown";
    // Codex supplies a real call id, so start and end can be paired — the Claude
    // adapter has to send null here.
    const toolCallId = str(input.tool_use_id);

    /** Build a protocol-v2 GyredeckEvent envelope. */
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
        sourceKind: "codexCliHook",
      },
      data,
    });

    const posts = [];

    switch (eventType) {
      case "SessionStart":
        posts.push(post(endpoint, token, "/ingest", buildEvent("conversation_open", {
          reason: str(input.source) ?? "startup",
          previousConversationId: null,
        })));
        break;
      case "UserPromptSubmit":
        // The prompt itself is never forwarded; only that a turn began.
        posts.push(post(endpoint, token, "/ingest", buildEvent("turn_start", { inputCount: 1 })));
        break;
      case "PreToolUse":
        posts.push(post(endpoint, token, "/ingest", buildEvent("tool_start", {
          toolCallId,
          toolName,
          argKeys: input.tool_input && typeof input.tool_input === "object"
            ? Object.keys(input.tool_input).sort()
            : [],
        })));
        break;
      case "PostToolUse": {
        // tool_response is not pinned by any published contract, so failure is derived
        // defensively and an unfamiliar shape simply reads as success.
        const response = input.tool_response;
        const failed = response && typeof response === "object"
          ? response.success === false || response.error != null || response.is_error === true
          : false;
        const output = response && typeof response === "object"
          ? [response.output, response.stdout, response.content, response.result]
              .find((value) => typeof value === "string")
          : typeof response === "string" ? response : undefined;
        posts.push(post(endpoint, token, "/ingest", buildEvent("tool_end", {
          toolCallId,
          toolName,
          status: failed ? "error" : "success",
          outputLength: typeof output === "string" ? output.length : null,
        })));
        break;
      }
      case "PermissionRequest":
        // Codex is blocked waiting for the user. Relayed raw so it picks up the
        // bridge's scope correlation and de-dup; the absence of a Notification event
        // name is what files it as an approval rather than a question.
        posts.push(post(endpoint, token, "/hook/attention", {
          hookId: randomUUID(),
          hookEventName: "PermissionRequest",
          source: "hook",
          workingDirectory: cwd,
          conversationId,
          toolName,
          message: str(input.tool_input?.description) ?? str(input.tool_input?.command),
        }));
        break;
      case "PreCompact":
        posts.push(post(endpoint, token, "/ingest", buildEvent("compact_start", {
          trigger: str(input.trigger) ?? "manual",
        })));
        break;
      case "PostCompact":
        posts.push(post(endpoint, token, "/ingest", buildEvent("compact_end", {
          trigger: str(input.trigger) ?? "manual",
          messagesBefore: null,
          messagesAfter: null,
          contextTokensBefore: null,
          contextTokensAfter: null,
        })));
        break;
      case "Stop":
      case "SubagentStop":
      // An interrupted turn is still a turn that ended: without this the session sits
      // on "working" until it goes stale, which reads as an agent still thinking.
      case "Interrupt":
        posts.push(post(endpoint, token, "/hook/stop", {
          hookId: randomUUID(),
          hookEventName: eventType,
          source: "hook",
          workingDirectory: cwd,
          conversationId,
          toolName: null,
          message: eventType === "Interrupt" ? "turn interrupted" : null,
          usage: null,
        }));
        break;
      case "SessionEnd":
        posts.push(post(endpoint, token, "/ingest", buildEvent("conversation_close", {
          durationMs: null,
          messageCount: null,
          reason: str(input.reason) ?? "quit",
          toolCallCount: null,
        })));
        break;
      default:
        break;
    }

    await Promise.all(posts);
  } catch {
    // A reporting failure must never surface inside Codex.
  }
  respond();
};

main();
