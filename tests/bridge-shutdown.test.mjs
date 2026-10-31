import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Every way the bridge is stopped — SIGINT, SIGTERM, and the parent's end of stdin that the
 * app's supervisor uses — runs one shutdown. It called a function it could not see, so the
 * bridge died with a ReferenceError and exit 1, and what the last seconds learnt about
 * sessions was never written (Unexpected fix, #199).
 */
const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CONFIG_DIR = [".config", "gyredeck"];
const APP_WORD = "d4".repeat(32);

const freePort = async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
};

const stopWith = async (how) => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-shutdown-"));
  await mkdir(join(home, ...CONFIG_DIR), { recursive: true });
  const port = await freePort();
  await writeFile(join(home, ...CONFIG_DIR, "gyredeck.config.json"), JSON.stringify({ host: "127.0.0.1", port }));
  let stderr = "";
  const bridge = spawn(
    process.execPath,
    ["adapters/bridge/gyredeck-bridge.mjs", "--port", String(port), "--host", "127.0.0.1", "--parent-stdio", "--broker-handshake"],
    { cwd: repoRoot, env: { ...process.env, HOME: home, GYREDECK_NO_AGENT_SPAWN: "1" }, stdio: ["pipe", "pipe", "pipe"] },
  );
  bridge.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => bridge.on("exit", (code, signal) => resolve({ code, signal })));
  bridge.stdin.write(`broker-secret ${APP_WORD}\nbroker-ready\n`);
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt += 1) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
      if (attempt > 200) throw new Error(`bridge did not start: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const token = (await readFile(join(home, ...CONFIG_DIR, "gyredeck.ingest-token"), "utf8")).trim();
    const conversationId = `shutdown-${how}`;
    const ingested = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gyredeck-token": token },
      body: JSON.stringify({
        version: 2, id: randomUUID(), type: "turn_start", timestamp: new Date().toISOString(), conversationId, cwd: "/tmp/shutdown",
        runtime: { sourcePid: 1, sourcePpid: null, sourceStartedAtMs: 1, sourceKind: "agyHost" }, data: { inputCount: 1 },
      }),
    });
    assert.ok(ingested.ok, "premise: the session was heard");
    // Stopped at once, inside the 750 ms the save waits: only the shutdown's flush writes it.
    if (how === "stdin end") bridge.stdin.end();
    else bridge.kill(how);
    const { code } = await exited;
    assert.equal(code, 0, `${how} exits 0: ${stderr}`);
    assert.doesNotMatch(stderr, /ReferenceError/);
    const kinds = JSON.parse(await readFile(join(home, ...CONFIG_DIR, "gyredeck.session-kinds.json"), "utf8"));
    assert.ok(JSON.stringify(kinds).includes(conversationId), `the session-kinds file was written on ${how}`);
  } finally {
    if (bridge.exitCode === null) bridge.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
};

for (const how of ["SIGTERM", "SIGINT", "stdin end"]) {
  test(`stopping the bridge by ${how} exits 0 with what it learnt written down`, () => stopWith(how));
}
