import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CONFIG_DIR = [".config", "gyredeck"];

/** Wait until the standalone bridge answers /health, or throw with captured stderr. */
const waitForHealth = async (port, stderrRef) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`bridge did not start: ${stderrRef.value}`);
};

/** Pick a free port by opening then closing an ephemeral listener. */
const freePort = async () => {
  const { createServer } = await import("node:http");
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
};

/** Run a hook adapter with a temp HOME, feeding a JSON payload on stdin. */
const runAdapter = (adapterPath, args, home, payload) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [adapterPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify(payload));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

test("install-claude-hooks copies the adapter and merges settings idempotently", async () => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-install-"));
  const settingsPath = join(home, ".claude", "settings.json");
  await mkdir(join(home, ".claude"), { recursive: true });
  // A pre-existing unrelated hook must survive the merge untouched.
  const existing = {
    theme: "dark",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "say done", timeout: 10_000 }] }],
    },
  };
  await writeFile(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);

  try {
    let first;
    for (let index = 0; index < 2; index += 1) {
      const result = spawnSync(process.execPath, ["scripts/install-claude-hooks.mjs"], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      if (index === 0) first = settings;
      else assert.deepEqual(settings, first, "second install must be a no-op");
    }

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    // Existing unrelated preferences and hooks are preserved.
    assert.equal(settings.theme, "dark");
    assert.ok(settings.hooks.Stop.some((entry) => entry.hooks.some((h) => h.command === "say done")));
    // The adapter command is wired for matched and plain events exactly once.
    const installedHook = join(home, ...CONFIG_DIR, "gyredeck-claude-hook.mjs");
    const command = (event) => `node ${installedHook} --event ${event}`;
    assert.ok(settings.hooks.PreToolUse.some((entry) => entry.matcher === "*" && entry.hooks.some((h) => h.command === command("PreToolUse"))));
    for (const event of ["UserPromptSubmit", "Notification", "Stop", "SessionStart", "SessionEnd", "PreCompact"]) {
      const matches = settings.hooks[event].filter((entry) => entry.hooks.some((h) => h.command === command(event)));
      assert.equal(matches.length, 1, `${event} wired exactly once`);
    }
    // The adapter was copied to the stable config path.
    assert.match(await readFile(installedHook, "utf8"), /Gyredeck Claude Code Hook Adapter/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("claude adapter relays a Notification into the running bridge", async () => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-claude-"));
  await mkdir(join(home, ...CONFIG_DIR), { recursive: true });
  const port = await freePort();
  await writeFile(join(home, ...CONFIG_DIR, "gyredeck.config.json"), JSON.stringify({ host: "127.0.0.1", port }));

  const stderrRef = { value: "" };
  const bridge = spawn(
    process.execPath,
    ["adapters/bridge/gyredeck-bridge.mjs", "--port", String(port), "--host", "127.0.0.1", "--parent-stdio"],
    { cwd: repoRoot, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
  );
  bridge.stderr.on("data", (chunk) => { stderrRef.value += chunk; });

  try {
    const health = await waitForHealth(port, stderrRef);
    assert.equal(health.mode, "standalone");
    assert.equal(health.name, "gyredeck");

    const result = await runAdapter(
      "adapters/claude/gyredeck-claude-hook.mjs",
      ["--event", "Notification"],
      home,
      {
        hook_event_name: "Notification",
        cwd: "/tmp/claude-project",
        session_id: "claude-conv-1",
        message: "Waiting for your approval",
      },
    );
    assert.equal(result.code, 0, result.stderr);
    // The adapter never writes to stdout so it never blocks Claude Code.
    assert.equal(result.stdout.trim(), "");

    const snapshot = await (await fetch(`http://127.0.0.1:${port}/snapshot`)).json();
    const attention = snapshot.recent.find((event) => event.type === "attention_requested" && event.conversationId === "claude-conv-1");
    assert.ok(attention, "attention_requested event reached the bridge");
    assert.equal(attention.cwd, "/tmp/claude-project");
    assert.equal(attention.data.kind, "question");
  } finally {
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    await rm(home, { recursive: true, force: true });
  }
});

test("claude adapter forwards a PreToolUse ingest event with trusted runtime", async () => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-claude-ingest-"));
  await mkdir(join(home, ...CONFIG_DIR), { recursive: true });
  const port = await freePort();
  await writeFile(join(home, ...CONFIG_DIR, "gyredeck.config.json"), JSON.stringify({ host: "127.0.0.1", port }));

  const stderrRef = { value: "" };
  const bridge = spawn(
    process.execPath,
    ["adapters/bridge/gyredeck-bridge.mjs", "--port", String(port), "--host", "127.0.0.1", "--parent-stdio"],
    { cwd: repoRoot, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
  );
  bridge.stderr.on("data", (chunk) => { stderrRef.value += chunk; });

  try {
    await waitForHealth(port, stderrRef);
    const result = await runAdapter(
      "adapters/claude/gyredeck-claude-hook.mjs",
      ["--event", "PreToolUse"],
      home,
      {
        hook_event_name: "PreToolUse",
        cwd: "/tmp/claude-project",
        session_id: "claude-conv-2",
        tool_name: "Bash",
        tool_input: { command: "ls", description: "list" },
      },
    );
    assert.equal(result.code, 0, result.stderr);

    const snapshot = await (await fetch(`http://127.0.0.1:${port}/snapshot`)).json();
    const toolStart = snapshot.recent.find((event) => event.type === "tool_start" && event.conversationId === "claude-conv-2");
    assert.ok(toolStart, "tool_start event reached the bridge");
    assert.equal(toolStart.data.toolName, "Bash");
    assert.deepEqual(toolStart.data.argKeys, ["command", "description"]);
    // The bridge auto-created the ingest token; the adapter read it and sent it,
    // so runtime identity is trusted (not stripped to null).
    assert.equal(toolStart.runtime?.sourceKind, "claudeCodeHook");
    assert.equal(Number.isInteger(toolStart.runtime?.sourcePid), true);
  } finally {
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    await rm(home, { recursive: true, force: true });
  }
});

test("antigravity adapter allows PreToolUse and relays a tool_start", async () => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-agy-"));
  await mkdir(join(home, ...CONFIG_DIR), { recursive: true });
  const port = await freePort();
  await writeFile(join(home, ...CONFIG_DIR, "gyredeck.config.json"), JSON.stringify({ host: "127.0.0.1", port }));

  const stderrRef = { value: "" };
  const bridge = spawn(
    process.execPath,
    ["adapters/bridge/gyredeck-bridge.mjs", "--port", String(port), "--host", "127.0.0.1", "--parent-stdio"],
    { cwd: repoRoot, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
  );
  bridge.stderr.on("data", (chunk) => { stderrRef.value += chunk; });

  try {
    await waitForHealth(port, stderrRef);
    const result = await runAdapter(
      "adapters/antigravity/gyredeck-agy-hook.mjs",
      ["--event", "PreToolUse"],
      home,
      {
        conversationId: "agy-conv-1",
        workspacePaths: ["/tmp/agy-project"],
        toolCall: { name: "Read", args: { path: "README.md" } },
      },
    );
    assert.equal(result.code, 0, result.stderr);
    // AGY treats an empty {} as deny, so PreToolUse MUST answer the full documented
    // allow shape on stdout — a partial answer risks blocking every tool call.
    assert.deepEqual(JSON.parse(result.stdout), { decision: "allow", reason: "", permissionOverrides: [] });

    const snapshot = await (await fetch(`http://127.0.0.1:${port}/snapshot`)).json();
    const toolStart = snapshot.recent.find((event) => event.type === "tool_start" && event.conversationId === "agy-conv-1");
    assert.ok(toolStart, "tool_start event reached the bridge");
    assert.equal(toolStart.cwd, "/tmp/agy-project");
    assert.equal(toolStart.data.toolName, "Read");
    assert.equal(toolStart.runtime?.sourceKind, "agyHost");
  } finally {
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    await rm(home, { recursive: true, force: true });
  }
});

test("antigravity adapter raises attention when the model asks the user a question", async () => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-agy-ask-"));
  await mkdir(join(home, ...CONFIG_DIR), { recursive: true });
  const port = await freePort();
  await writeFile(join(home, ...CONFIG_DIR, "gyredeck.config.json"), JSON.stringify({ host: "127.0.0.1", port }));

  const stderrRef = { value: "" };
  const bridge = spawn(
    process.execPath,
    ["adapters/bridge/gyredeck-bridge.mjs", "--port", String(port), "--host", "127.0.0.1", "--parent-stdio"],
    { cwd: repoRoot, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
  );
  bridge.stderr.on("data", (chunk) => { stderrRef.value += chunk; });

  try {
    await waitForHealth(port, stderrRef);
    // Shape taken from a real ask_question call captured off the Antigravity hook.
    const asked = await runAdapter(
      "adapters/antigravity/gyredeck-agy-hook.mjs",
      ["--event", "PreToolUse"],
      home,
      {
        conversationId: "agy-ask-1",
        workspacePaths: ["/tmp/agy-project"],
        toolCall: {
          name: "ask_question",
          args: {
            questions: [{ question: "Which layout do you want?", options: ["A", "B"], is_multi_select: false }],
            toolAction: "Asking user for next steps",
            toolSummary: "Ask layout preference",
          },
        },
      },
    );
    assert.equal(asked.code, 0, asked.stderr);
    // Still has to answer the gating shape, or Antigravity reads it as a deny.
    assert.deepEqual(JSON.parse(asked.stdout), { decision: "allow", reason: "", permissionOverrides: [] });

    // A tool that does not involve the user must not raise attention.
    const quiet = await runAdapter(
      "adapters/antigravity/gyredeck-agy-hook.mjs",
      ["--event", "PreToolUse"],
      home,
      {
        conversationId: "agy-quiet-1",
        workspacePaths: ["/tmp/agy-project"],
        toolCall: { name: "view_file", args: { path: "README.md" } },
      },
    );
    assert.equal(quiet.code, 0, quiet.stderr);

    const snapshot = await (await fetch(`http://127.0.0.1:${port}/snapshot`)).json();
    const attention = snapshot.recent.filter((event) => event.type === "attention_requested");
    assert.equal(attention.length, 1, "only the ask_question call raises attention");
    assert.equal(attention[0].conversationId, "agy-ask-1");
    // Notification is what makes the bridge file this as a question rather than a
    // permission prompt, and the question text is what the panel shows.
    assert.equal(attention[0].data.kind, "question");
    assert.equal(attention[0].data.toolName, "ask_question");
    assert.equal(attention[0].data.message, "Which layout do you want?");
    assert.equal(attention[0].runtime?.sourceKind, "agyHost");

    // The tool_start still goes out for both, attention is additional.
    const starts = snapshot.recent.filter((event) => event.type === "tool_start");
    assert.deepEqual(starts.map((event) => event.data.toolName).sort(), ["ask_question", "view_file"]);
  } finally {
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    await rm(home, { recursive: true, force: true });
  }
});

test("antigravity adapter answers each event with its documented response shape", async () => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-agy-shapes-"));
  await mkdir(join(home, ...CONFIG_DIR), { recursive: true });
  const port = await freePort();
  await writeFile(join(home, ...CONFIG_DIR, "gyredeck.config.json"), JSON.stringify({ host: "127.0.0.1", port }));

  const stderrRef = { value: "" };
  const bridge = spawn(
    process.execPath,
    ["adapters/bridge/gyredeck-bridge.mjs", "--port", String(port), "--host", "127.0.0.1", "--parent-stdio"],
    { cwd: repoRoot, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
  );
  bridge.stderr.on("data", (chunk) => { stderrRef.value += chunk; });

  try {
    await waitForHealth(port, stderrRef);
    const expected = {
      PreToolUse: { decision: "allow", reason: "", permissionOverrides: [] },
      PostToolUse: {},
      PreInvocation: { injectSteps: [] },
      PostInvocation: { injectSteps: [], terminationBehavior: "" },
      // "allow", never "continue" — see the adapter. A wrong value here loops AGY.
      Stop: { decision: "allow", reason: "" },
    };

    for (const [event, shape] of Object.entries(expected)) {
      const result = await runAdapter(
        "adapters/antigravity/gyredeck-agy-hook.mjs",
        ["--event", event],
        home,
        {
          conversationId: "agy-shapes",
          workspacePaths: ["/tmp/agy-project"],
          toolCall: { name: "Read", args: {} },
          invocationNum: 1,
        },
      );
      assert.equal(result.code, 0, `${event}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), shape, `${event} response shape`);
    }

    // PostInvocation is registered for a valid answer only — a turn can span
    // several invocations, so it must not report the turn as complete.
    const snapshot = await (await fetch(`http://127.0.0.1:${port}/snapshot`)).json();
    const forConv = snapshot.recent.filter((event) => event.conversationId === "agy-shapes");
    assert.ok(forConv.some((event) => event.type === "tool_start"), "PreToolUse still relays");
    assert.equal(
      forConv.filter((event) => event.type === "turn_complete").length,
      1,
      "only Stop reports turn completion",
    );
  } finally {
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    await rm(home, { recursive: true, force: true });
  }
});

test("standalone bridge appends relayed events to the ndjson log", async () => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-log-"));
  await mkdir(join(home, ...CONFIG_DIR), { recursive: true });
  const port = await freePort();
  await writeFile(join(home, ...CONFIG_DIR, "gyredeck.config.json"), JSON.stringify({ host: "127.0.0.1", port }));

  const stderrRef = { value: "" };
  const bridge = spawn(
    process.execPath,
    ["adapters/bridge/gyredeck-bridge.mjs", "--port", String(port), "--host", "127.0.0.1", "--parent-stdio"],
    { cwd: repoRoot, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
  );
  bridge.stderr.on("data", (chunk) => { stderrRef.value += chunk; });

  try {
    await waitForHealth(port, stderrRef);
    const result = await runAdapter(
      "adapters/claude/gyredeck-claude-hook.mjs",
      ["--event", "Stop"],
      home,
      { hook_event_name: "Stop", cwd: "/tmp/claude-project", session_id: "claude-conv-3" },
    );
    assert.equal(result.code, 0, result.stderr);

    const logPath = join(home, ...CONFIG_DIR, "gyredeck.events.ndjson");
    const lines = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.some((event) => event.type === "bridge_ready"), "bridge_ready persisted");
    const complete = lines.find((event) => event.type === "turn_complete" && event.conversationId === "claude-conv-3");
    assert.ok(complete, "turn_complete persisted to the ndjson log");
    assert.equal(complete.data.hookEventName, "Stop");
  } finally {
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    await rm(home, { recursive: true, force: true });
  }
});

test("bridge mail rooms push to subscribers and buffer for periodic readers", async () => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-mail-"));
  await mkdir(join(home, ...CONFIG_DIR), { recursive: true });
  const port = await freePort();
  await writeFile(join(home, ...CONFIG_DIR, "gyredeck.config.json"), JSON.stringify({ host: "127.0.0.1", port }));

  const stderrRef = { value: "" };
  const bridge = spawn(
    process.execPath,
    ["adapters/bridge/gyredeck-bridge.mjs", "--port", String(port), "--host", "127.0.0.1", "--parent-stdio"],
    { cwd: repoRoot, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
  );
  bridge.stderr.on("data", (chunk) => { stderrRef.value += chunk; });

  const base = `http://127.0.0.1:${port}`;
  const subscription = new AbortController();
  try {
    const health = await waitForHealth(port, stderrRef);
    assert.equal(health.capabilities.endpoints.mail, true);

    const token = (await readFile(join(home, ...CONFIG_DIR, "gyredeck.ingest-token"), "utf8")).trim();
    const headers = { "content-type": "application/json", "x-gyredeck-token": token };
    const publish = (room, body) =>
      fetch(`${base}/mail/${room}`, { method: "POST", headers, body: JSON.stringify(body) });

    // Mail is acted on by agents, so an untrusted caller gets nothing at all —
    // unlike /ingest, which downgrades runtime identity but still accepts the event.
    const unauthorized = await fetch(`${base}/mail/alpha`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "intruder", text: "do this" }),
    });
    assert.equal(unauthorized.status, 401);

    // A room name has to stay a single path segment.
    assert.equal((await fetch(`${base}/mail/has%2Fslash`, { headers })).status, 400);
    // A message needs a sender and a body.
    assert.equal((await publish("alpha", { text: "no sender" })).status, 400);

    // A subscriber holding the stream is pushed to as messages arrive.
    const pushed = [];
    const stream = fetch(`${base}/mail/alpha/events`, { headers, signal: subscription.signal })
      .then(async (response) => {
        for await (const chunk of response.body) {
          for (const line of Buffer.from(chunk).toString("utf8").split("\n")) {
            if (line.startsWith("data: ")) pushed.push(JSON.parse(line.slice(6)));
          }
        }
      })
      .catch(() => {});
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rooms = await (await fetch(`${base}/mail`, { headers })).json();
      if (rooms.rooms.some((room) => room.room === "alpha" && room.subscribers === 1)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal((await publish("alpha", { from: "codex", text: "hello" })).status, 202);
    assert.equal((await publish("alpha", { from: "claude-code", text: "hi back" })).status, 202);
    for (let attempt = 0; attempt < 100 && pushed.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(pushed.map((message) => `${message.seq}:${message.from}`), ["1:codex", "2:claude-code"]);

    // A peer that can only check in periodically — a hook process lives for
    // milliseconds — reads what it missed instead, and `since` makes that repeatable.
    await publish("beta", { from: "claude-code", text: "while you were away" });
    await publish("beta", { from: "claude-code", text: "and again" });
    const drained = await (await fetch(`${base}/mail/beta`, { headers })).json();
    assert.deepEqual(drained.messages.map((message) => message.text), ["while you were away", "and again"]);
    const empty = await (await fetch(`${base}/mail/beta?since=${drained.seq}`, { headers })).json();
    assert.deepEqual(empty.messages, []);

    // Rooms do not leak into each other.
    const alpha = await (await fetch(`${base}/mail/alpha`, { headers })).json();
    assert.deepEqual(alpha.messages.map((message) => message.from), ["codex", "claude-code"]);
  } finally {
    subscription.abort();
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    await rm(home, { recursive: true, force: true });
  }
});
