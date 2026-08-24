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

const post = (endpoint, path, payload) =>
  new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = request(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
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
    const cwd = process.cwd();

    await post(endpoint, "/hook/stop", {
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
