import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const bridgePath = resolve(repoRoot, "adapters/bridge/agent-activity-bridge.mjs");

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key, value.join("=") || true];
}));

const eventCount = Number(args.get("events") ?? 5_000);
const host = "127.0.0.1";

// Budgets are grounded in the REAL standalone bridge, which is fundamentally
// different from the removed in-process mod the old benchmark called directly.
//   startup: the bridge is a separate `node adapters/bridge/…` process that must
//     spawn and open a socket; observed cold start is ~55ms locally, so 750ms is
//     a safe ceiling that tolerates slower CI runners.
//   throughput: the bridge is a single-threaded Node HTTP server that does a
//     synchronous appendFileSync per event, driven here over real HTTP. That
//     ceiling is ~5k events/s locally — the removed mod's 20000/s target assumed
//     a direct in-process handler call with no network or fsync. 2000 events/s is
//     a realistic floor for this transport with headroom below the observed rate.
const STARTUP_BUDGET_MS = 750;
const THROUGHPUT_BUDGET = 2_000;
// Ingest is driven over real HTTP, so serial round-trips would measure client
// latency rather than the bridge. A bounded worker pool keeps the socket busy
// and reflects the bridge's sustained /ingest capacity.
const CONCURRENCY = Number(args.get("concurrency") ?? 64);

const reservePort = async () => {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, host, done));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve benchmark port");
  const { port } = address;
  await new Promise((done) => probe.close(done));
  return port;
};

const waitFor = async (fn, attempts, delayMs, label) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await fn();
    if (value != null) return value;
    await new Promise((done) => setTimeout(done, delayMs));
  }
  throw new Error(label);
};

const home = await mkdtemp(join(tmpdir(), "agent-activity-benchmark-"));
const tokenPath = join(home, ".config", "agent-activity", "agent-activity.ingest-token");
const logFile = join(home, ".config", "agent-activity", "agent-activity.events.ndjson");
const port = await reservePort();

let child = null;
try {
  const startupStartedAt = performance.now();
  child = spawn(process.execPath, [bridgePath, "--port", String(port), "--host", host], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("exit", (code) => {
    if (code && code !== 0) process.stderr.write(stderr);
  });

  await waitFor(async () => {
    try {
      const response = await fetch(`http://${host}:${port}/health`);
      return response.ok ? true : null;
    } catch {
      return null;
    }
  }, 750, 4, "bridge did not become healthy");
  const startupMs = performance.now() - startupStartedAt;

  const ingestToken = await waitFor(async () => {
    try {
      const value = (await readFile(tokenPath, "utf8")).trim();
      return /^[a-f0-9]{64}$/i.test(value) ? value : null;
    } catch {
      return null;
    }
  }, 250, 4, "bridge did not write an ingest token");

  const event = (index) => ({
    version: 2,
    id: `benchmark-${index}`,
    type: "tool_end",
    timestamp: new Date().toISOString(),
    agentId: "benchmark-agent",
    agentName: "Benchmark",
    conversationId: "benchmark-conversation",
    cwd: "/tmp/agent-activity-benchmark",
    model: "benchmark-model",
    permissionMode: "ask",
    runtime: {
      sourcePid: 1,
      sourcePpid: null,
      sourceStartedAtMs: 0,
      sourceKind: "hookRelay",
    },
    data: { toolCallId: `tool-${index}`, toolName: "Read", status: "success", outputLength: 0 },
  });
  const headers = { "content-type": "application/json", "x-agent-activity-token": ingestToken };

  const send = async (index) => {
    const response = await fetch(`http://${host}:${port}/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify(event(index)),
    });
    if (!response.ok) throw new Error(`ingest rejected event ${index}: ${response.status}`);
    await response.arrayBuffer();
  };

  const startedAt = performance.now();
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < eventCount; index = next++) {
      await send(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, eventCount) }, worker));
  const durationMs = performance.now() - startedAt;
  const eventsPerSecond = eventCount / (durationMs / 1_000);
  const logBytes = (await stat(logFile)).size;

  const payload = {
    source: bridgePath,
    temporaryHome: true,
    startupMs,
    eventCount,
    durationMs,
    eventsPerSecond,
    logBytes,
  };
  console.log(JSON.stringify(payload, null, 2));

  if (args.has("assert")) {
    if (payload.startupMs > STARTUP_BUDGET_MS) throw new Error(`bridge startup budget exceeded: ${payload.startupMs.toFixed(2)}ms > ${STARTUP_BUDGET_MS}ms`);
    if (payload.eventsPerSecond < THROUGHPUT_BUDGET) throw new Error(`bridge throughput budget missed: ${payload.eventsPerSecond.toFixed(0)} < ${THROUGHPUT_BUDGET} events/s`);
    if (payload.logBytes <= 0) throw new Error("bridge benchmark did not persist its temporary event log");
  }
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((done) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 2_000);
      child.on("exit", () => { clearTimeout(timer); done(); });
    });
  }
  await rm(home, { recursive: true, force: true });
}
