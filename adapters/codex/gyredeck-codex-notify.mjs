import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Gyredeck Codex notify adapter
 *
 * Codex CLI has no tool-level hooks; it only invokes a `notify` program with a
 * single JSON argument on certain events (notably `agent-turn-complete`). This
 * adapter maps that into a coarse turn-completion signal for the Gyredeck
 * bridge — enough to surface "a Codex turn finished in <project>", not live
 * tool-by-tool activity.
 *
 * Wire it up in ~/.codex/config.toml:
 *   notify = ["node", "/Users/<you>/.config/gyredeck/gyredeck-codex-notify.mjs"]
 *
 * Codex calls:  node gyredeck-codex-notify.mjs '<json>'
 */

const DEFAULT_ENDPOINT = { hostname: "127.0.0.1", port: 47_621 };
const CONFIG_DIR = join(homedir(), ".config", "gyredeck");

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

/**
 * The machine token, in the one shape the bridge mints. Anything else is treated as
 * absent rather than sent, so a half-written file cannot become a credential.
 */
const readIngestToken = async () => {
  try {
    const value = (await readFile(join(CONFIG_DIR, "gyredeck.ingest-token"), "utf8")).trim();
    return /^[a-f0-9]{64}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
};

const post = (endpoint, token, path, payload) =>
  new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
    if (token) headers["x-gyredeck-token"] = token;
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

const main = async () => {
  try {
    // Codex passes the event as a single JSON argument.
    const raw = process.argv[2];
    const input = raw ? JSON.parse(raw) : {};
    const type = typeof input.type === "string" ? input.type : "";

    // Only turn completion is meaningful from Codex notify today.
    if (type !== "agent-turn-complete") {
      process.exit(0);
    }

    const endpoint = await readEndpoint();
    const token = await readIngestToken();
    const cwd = process.cwd();

    // A room password the person typed at the Codex prompt, on its way to the bridge.
    //
    // Codex's own hook never sees a prompt — it forwards `{inputCount: 1}` and nothing
    // else, deliberately — and Codex cannot call the bridge itself from inside its
    // sandbox. So until now the password a person was told to paste did nothing at all,
    // and the session sat waiting for a confirmation that could never come.
    //
    // Only a string that is already the exact shape of a room password is sent, and only
    // the last thing typed. Everything else the person writes stays here, which is the
    // same promise the hook makes; the bridge still has to recognise the value as the
    // room's own password before it lets anybody in. Never logged, never echoed — it
    // goes straight into the request.
    const typed = Array.isArray(input["input-messages"]) ? input["input-messages"] : [];
    const last = typeof typed.at(-1) === "string" ? typed.at(-1).trim() : "";
    const threadId = typeof input["thread-id"] === "string" ? input["thread-id"] : "";
    if (threadId && /^[a-f0-9]{32}$/i.test(last)) {
      await post(endpoint, token, "/hook/sync/confirm", {
        conversationId: threadId,
        turnId: typeof input["turn-id"] === "string" ? input["turn-id"] : null,
        password: last,
      });
    }

    await post(endpoint, token, "/hook/stop", {
      hookId: randomUUID(),
      hookEventName: "Stop",
      source: "codex-notify",
      workingDirectory: cwd,
      conversationId: `codex:${cwd}`,
      toolName: null,
      message: typeof input["last-assistant-message"] === "string" ? "turn complete" : null,
    });
  } catch {
    // Never block Codex.
  }
  process.exit(0);
};

main();
