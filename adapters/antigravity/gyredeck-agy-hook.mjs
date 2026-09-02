import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Gyredeck AGY (Antigravity) Hook Adapter
 *
 * Translates AGY lifecycle hook events into GyredeckEvent payloads and posts
 * them to the Gyredeck bridge. Invoked as a shell command from AGY's
 * hooks.json with `--event <EventType>` to identify the hook being fired.
 *
 * Usage:
 *   node gyredeck-agy-hook.mjs --event PreToolUse
 *   node gyredeck-agy-hook.mjs --event PostToolUse
 *   node gyredeck-agy-hook.mjs --event PreInvocation
 *   node gyredeck-agy-hook.mjs --event Stop
 *
 * AGY sends a JSON payload on stdin and expects a JSON response on stdout.
 * PreToolUse MUST return { "decision": "allow" } — empty {} is treated as deny.
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

/** The tool Antigravity calls when it needs an answer from the user. */
const ASK_QUESTION_TOOL = "ask_question";

/**
 * Pull the question out of an ask_question call so the panel can show what is being
 * asked. The argument shape is not pinned by any published contract, so every step is
 * guarded and an unrecognised shape simply yields no message.
 */
const firstQuestionText = (args) => {
  const question = Array.isArray(args?.questions) ? args.questions[0] : null;
  const text = typeof question?.question === "string" ? question.question.trim() : "";
  if (text) return text;
  const summary = typeof args?.toolSummary === "string" ? args.toolSummary.trim() : "";
  return summary || null;
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
  const eventType = getCliArg("--event");

  // Each AGY event has its own documented response shape; an empty {} is not a
  // valid answer for the gating events (PreToolUse treats it as a deny, which
  // would block every tool call). Mirror the documented shape per event.
  const agyResponseFor = (event) => {
    switch (event) {
      case "PreToolUse":
        return { decision: "allow", reason: "", permissionOverrides: [] };
      case "PreInvocation":
        return { injectSteps: [] };
      case "PostInvocation":
        return { injectSteps: [], terminationBehavior: "" };
      // "allow" permits the turn to end. It must never be "continue": AGY reads that
      // as "keep going" and answers every finished turn with "Stop hook blocked
      // termination", looping the agent forever. The bridge POST below is what
      // reports turn completion — it is independent of this decision.
      case "Stop":
        return { decision: "allow", reason: "" };
      default:
        // PostToolUse (and anything unrecognized) expects a bare object.
        return {};
    }
  };
  const agyResponse = agyResponseFor(eventType);

  // Always output valid JSON to stdout so AGY does not block or error.
  const respond = () => {
    process.stdout.write(JSON.stringify(agyResponse) + "\n");
    process.exit(0);
  };

  try {
    if (!eventType) return respond();

    const input = await readInput();
    const endpoint = await readEndpoint();
    const token = await readIngestToken();

    const cwd = Array.isArray(input.workspacePaths) && input.workspacePaths.length > 0
      ? input.workspacePaths[0]
      : process.cwd();

    const conversationId = typeof input.conversationId === "string" && input.conversationId.length > 0
      ? input.conversationId
      : null;

    const model = typeof input.modelName === "string" && input.modelName.length > 0
      ? input.modelName
      : null;

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
      permissionMode: null,
      runtime: {
        sourcePid: process.pid,
        sourcePpid: Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : null,
        sourceStartedAtMs: HOST_STARTED_AT_MS,
        sourceKind: "agyHost",
      },
      data,
    });

    const posts = [];

    if (eventType === "PreToolUse") {
      const toolName = input.toolCall?.name ?? "unknown";
      const argKeys = input.toolCall?.args ? Object.keys(input.toolCall.args).sort() : [];
      posts.push(post(endpoint, token, "/ingest", buildEvent("tool_start", {
        toolCallId: null,
        toolName,
        argKeys,
      })));
      // Antigravity has no notification hook. When it needs an answer it calls the
      // ask_question tool, so that call is the only signal that the turn has stopped
      // for the user — the same role AskUserQuestion plays for Claude Code. Relayed
      // raw so it picks up the bridge's scope correlation and de-dup, and labelled
      // Notification because that is what makes the bridge file it as a question
      // rather than a permission prompt.
      if (toolName === ASK_QUESTION_TOOL) {
        posts.push(post(endpoint, token, "/hook/attention", {
          hookId: randomUUID(),
          hookEventName: "Notification",
          source: "tool",
          workingDirectory: cwd,
          conversationId,
          toolName,
          message: firstQuestionText(input.toolCall?.args),
        }));
      }
    } else if (eventType === "PostToolUse") {
      const status = input.error ? "error" : "success";
      posts.push(post(endpoint, token, "/ingest", buildEvent("tool_end", {
        toolCallId: null,
        toolName: input.toolCall?.name ?? "unknown",
        status,
        outputLength: null,
      })));
    } else if (eventType === "PreInvocation") {
      if (input.invocationNum === 0) {
        posts.push(post(endpoint, token, "/ingest", buildEvent("conversation_open", {
          reason: "startup",
          previousConversationId: null,
        })));
      }
      posts.push(post(endpoint, token, "/ingest", buildEvent("turn_start", {
        inputCount: 1,
      })));
    } else if (eventType === "PostInvocation") {
      // Registered so AGY gets a valid `injectSteps` answer and Gyredeck stays a
      // well-behaved hook citizen. No Gyredeck event is emitted: a turn can span
      // several invocations, so treating this as turn completion would end the
      // turn early — `Stop` is the real completion signal.
    } else if (eventType === "Stop") {
      posts.push(post(endpoint, token, "/hook/stop", {
        hookId: randomUUID(),
        hookEventName: "Stop",
        source: "hook",
        workingDirectory: cwd,
        agentId: null,
        conversationId,
        toolName: null,
        message: typeof input.terminationReason === "string" ? input.terminationReason : null,
      }));
    }

    if (posts.length > 0) {
      await Promise.all(posts);
    }

    respond();
  } catch {
    respond();
  }
};

main();
