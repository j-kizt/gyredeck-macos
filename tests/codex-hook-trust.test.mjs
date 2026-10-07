import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { gyredeckCodexEvents, summariseCodexHooks } from "../adapters/bridge/gyredeck-bridge.mjs";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CONFIG_DIR = [".config", "gyredeck"];
const OURS = "/Users/x/.nvm/bin/node /Users/x/.config/gyredeck/gyredeck-codex-hook.mjs --event";

const HOOKS_JSON = "/Users/x/.codex/hooks.json";
const hook = (event, trustStatus, enabled = true, command = `${OURS} ${event}`, sourcePath = HOOKS_JSON) => ({
  key: `${sourcePath}:${event}:0:0`,
  sourcePath,
  command,
  enabled,
  trustStatus,
});
const answer = (...hooks) => ({ id: 2, result: { data: [{ cwd: "/Users/x", hooks, warnings: [], errors: [] }] } });
/** What the installer registered. The rule holds Codex to all of it, read from the file. */
const registered = (...events) => ({ hooksJsonPath: HOOKS_JSON, expectedEvents: new Set(events) });
const summarise = (message, ...events) => summariseCodexHooks(message, registered(...(events.length ? events : ["stop"])));

// ── The rule itself ──────────────────────────────────────────────────────────────────

test("every one of our hooks approved and enabled is the only green", () => {
  const result = summarise(answer(hook("stop", "trusted"), hook("pre_tool_use", "managed")), "stop", "pre_tool_use");
  assert.equal(result.state, "approved");
  assert.equal(result.hooks.length, 2);
});

test("approved means every hook the installer registered, not every one Codex listed", () => {
  // Codex lists only Stop, approved — and the other events the installer wrote are not
  // there at all. A hook Codex leaves out is a hook it will not run, so this is not green.
  const result = summarise(answer(hook("stop", "trusted")), "stop", "pre_tool_use", "post_tool_use");
  assert.equal(result.state, "unknown");
  assert.equal(result.reason, "incomplete");
});

test("one hook never approved is enough to say so, however many others are", () => {
  const result = summarise(answer(hook("stop", "trusted"), hook("pre_tool_use", "untrusted")), "stop", "pre_tool_use");
  assert.equal(result.state, "untrusted");
});

test("a hook approved before and changed since asks to be approved again", () => {
  assert.equal(summarise(answer(hook("stop", "modified"))).state, "modified");
});

test("never approved is reported ahead of changed, because it is the bigger thing to fix", () => {
  const result = summarise(answer(hook("stop", "modified"), hook("pre_tool_use", "untrusted")), "stop", "pre_tool_use");
  assert.equal(result.state, "untrusted");
});

test("a hook the person switched off is not green, even though Codex still calls it trusted", () => {
  // Measured against a real Codex 0.160.0: `enabled = false` beside a valid trusted_hash
  // reports `trustStatus: "trusted"`. Reading trust alone would light a hook that never runs.
  assert.equal(summarise(answer(hook("stop", "trusted", false))).state, "disabled");
});

test("somebody else's hooks are not ours to grade", () => {
  const result = summarise(answer(
    hook("stop", "trusted"),
    hook("stop", "untrusted", true, "/usr/local/bin/some-other-tool --stop"),
  ));
  assert.equal(result.state, "approved");
  assert.equal(result.hooks.length, 1);
});

test("our script named in some other hooks file is not the registration we made", () => {
  // Same command, read from a project's own hooks file. Grading it would let a stray copy
  // somewhere else decide what the install row says.
  const result = summarise(answer(
    hook("stop", "trusted"),
    hook("stop", "untrusted", true, `${OURS} stop`, "/Users/x/project/.codex/hooks.json"),
  ));
  assert.equal(result.state, "approved");
  assert.equal(result.hooks.length, 1);
});

test("Codex listing none of ours is not evidence of anything", () => {
  const result = summarise(answer(hook("stop", "trusted", true, "/usr/local/bin/other")));
  assert.equal(result.state, "unknown");
  assert.equal(result.reason, "not_listed");
});

test("nothing of ours in the file is a question for the install row, not for Codex", () => {
  const result = summariseCodexHooks(answer(hook("stop", "trusted")), registered());
  assert.equal(result.state, "unknown");
  assert.equal(result.reason, "not_registered");
});

test("Codex saying it could not read the hooks is not a pass for what it did read", () => {
  const message = answer(hook("stop", "trusted"));
  message.result.data[0].errors = [{ message: "failed to parse hooks.json" }];
  assert.equal(summarise(message).reason, "codex_reported_errors");
});

test("a status this version has never heard of is unknown, not a guess", () => {
  const result = summarise(answer(hook("stop", "pending-review")));
  assert.equal(result.state, "unknown");
  assert.equal(result.reason, "unrecognised_status");
});

test("an answer in a shape we do not recognise is unknown", () => {
  assert.equal(summarise({ id: 2, result: { hooks: [] } }).state, "unknown");
  assert.equal(summarise({ id: 2, error: { code: -32601, message: "no such method" } }).reason, "method_refused");
  assert.equal(summarise(null).state, "unknown");
});

test("the events to hold Codex to are read from what the installer wrote", () => {
  const events = gyredeckCodexEvents({
    hooks: {
      PreToolUse: [{ hooks: [{ type: "command", command: `${OURS} PreToolUse` }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: `${OURS} UserPromptSubmit` }] }],
      Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/someone-else" }] }],
    },
  });
  assert.deepEqual([...events].sort(), ["pre_tool_use", "user_prompt_submit"]);
  assert.equal(gyredeckCodexEvents(null).size, 0);
});

// ── Through the bridge, with a Codex that is a script written here ───────────────────

/** Wait until the standalone bridge answers /health, or throw with captured stderr. */
const waitForHealth = async (port, stderrRef) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`bridge did not start: ${stderrRef.value}`);
};

const freePort = async () => {
  const { createServer } = await import("node:http");
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
};

/**
 * A bridge whose `codex` is a script that speaks just enough of the app-server protocol:
 * it waits for `initialize`, then answers `hooks/list` with whatever this test hands it.
 * `~/.bun/bin` because `findAgentBinary` searches a fixed list before PATH, and a real
 * `codex` in `/opt/homebrew/bin` would otherwise win and run.
 */
const withBridge = async (hooksListAnswer, run, { spawnAllowed = true, silent = false, registeredEvents = ["Stop", "PreToolUse"], answerDelayMs = 300 } = {}) => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-codex-trust-"));
  await mkdir(join(home, ...CONFIG_DIR), { recursive: true });
  const fakeBin = join(home, ".bun", "bin");
  await mkdir(fakeBin, { recursive: true });
  const codexHome = join(home, ".codex");
  if (silent) {
    // Present, and gone again without a word — an app-server that will not start.
    await writeFile(join(fakeBin, "codex"), `#!${process.execPath}\nprocess.exit(0);\n`);
    await chmod(join(fakeBin, "codex"), 0o755);
  } else if (hooksListAnswer !== null) {
    const listed = typeof hooksListAnswer === "function" ? hooksListAnswer(home) : hooksListAnswer;
    // Either one answer, or an answer chosen by what `hooks.json` holds when this Codex
    // reads it — the way the real one decides. Choosing by start order instead raced: two
    // started together under load both believed they were first.
    const byFile = listed && listed.whenFileHas ? listed : { whenFileHas: null, then: listed, otherwise: listed };
    await writeFile(
      join(fakeBin, "codex"),
      `#!${process.execPath}\n` +
        `const rule = ${JSON.stringify(byFile)};\n` +
        `const file = (() => { try { return require('node:fs').readFileSync(${JSON.stringify(join(codexHome, "hooks.json"))}, 'utf8'); } catch { return ''; } })();\n` +
        "const answer = rule.whenFileHas && file.includes(rule.whenFileHas) ? rule.then : rule.otherwise;\n" +
        `require('node:fs').appendFileSync(${JSON.stringify(join(home, "spawned.log"))}, 'x\\n');\n` +
        "let buffered = '';\n" +
        "process.stdin.setEncoding('utf8');\n" +
        "process.stdin.on('data', (chunk) => {\n" +
        "  buffered += chunk;\n" +
        "  let i;\n" +
        "  while ((i = buffered.indexOf('\\n')) >= 0) {\n" +
        "    const message = JSON.parse(buffered.slice(0, i)); buffered = buffered.slice(i + 1);\n" +
        "    if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');\n" +
        `    if (message.id === 2) setTimeout(() => process.stdout.write(JSON.stringify({ ...answer, id: 2 }) + '\\n'), ${answerDelayMs});\n` +
        "  }\n" +
        "});\n",
    );
    await chmod(join(fakeBin, "codex"), 0o755);
  }
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "hooks.json"), JSON.stringify({
    hooks: Object.fromEntries(registeredEvents.map((event) => [event, [{ hooks: [{ type: "command", command: `${OURS} ${event}` }] }]])),
  }));
  const port = await freePort();
  await writeFile(join(home, ...CONFIG_DIR, "gyredeck.config.json"), JSON.stringify({ host: "127.0.0.1", port }));

  const stderrRef = { value: "" };
  const bridge = spawn(
    process.execPath,
    ["adapters/bridge/gyredeck-bridge.mjs", "--port", String(port), "--host", "127.0.0.1", "--parent-stdio"],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome, GYREDECK_NO_AGENT_SPAWN: spawnAllowed ? "0" : "1", PATH: fakeBin },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  bridge.stderr.on("data", (chunk) => { stderrRef.value += chunk; });
  try {
    await waitForHealth(port, stderrRef);
    const token = (await readFile(join(home, ...CONFIG_DIR, "gyredeck.ingest-token"), "utf8")).trim();
    const ask = async (withToken = true) => {
      const response = await fetch(`http://127.0.0.1:${port}/codex/hook-trust`, {
        headers: withToken ? { "x-gyredeck-token": token } : {},
      });
      return { status: response.status, body: await response.json() };
    };
    const spawned = async () => (await readFile(join(home, "spawned.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    await run(ask, spawned, { home, codexHome });
  } finally {
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    await rm(home, { recursive: true, force: true });
  }
};

/** The same hook, as Codex would report it from the bridge's own HOME. */
const homeHook = (home, event, trustStatus) => hook(event, trustStatus, true, `${OURS} ${event}`, join(home, ".codex", "hooks.json"));

test("the bridge asks Codex and reports what it says", async () => {
  await withBridge((home) => answer(homeHook(home, "stop", "trusted"), homeHook(home, "pre_tool_use", "untrusted")), async (ask) => {
    const { status, body } = await ask();
    assert.equal(status, 200);
    assert.equal(body.state, "untrusted");
    assert.deepEqual(body.hooks.map((h) => h.key), ["stop:0:0", "pre_tool_use:0:0"]);
  });
});

test("a machine with no codex says unknown, never green", async () => {
  // Not by leaving `codex` off PATH: `findAgentBinary` searches a fixed list first, so a
  // real `codex` in `/opt/homebrew/bin` is found anyway and the test runs it — which is
  // what the first version of this test did. The bridge's own switch is what makes no
  // binary findable without touching anything installed.
  await withBridge(null, async (ask) => {
    const { body } = await ask();
    assert.equal(body.state, "unknown");
    assert.equal(body.reason, "codex_not_found");
  }, { spawnAllowed: false });
});

test("a codex that starts and says nothing is unknown, not a hang", async () => {
  await withBridge(null, async (ask) => {
    const { body } = await ask();
    assert.equal(body.state, "unknown");
    assert.equal(body.reason, "exited");
  }, { silent: true });
});

test("the answer is for this machine's own callers only", async () => {
  await withBridge((home) => answer(homeHook(home, "stop", "trusted")), async (ask) => {
    const { status } = await ask(false);
    assert.equal(status, 401);
  });
});

test("asks that overlap start one app-server between them", async () => {
  // Opening Settings, coming back to the window and pressing Recheck can land in the same
  // second. Each one starting its own app-server is a real process opening Codex's
  // database, several times over, for one question.
  await withBridge((home) => answer(homeHook(home, "stop", "trusted"), homeHook(home, "pre_tool_use", "trusted")), async (ask, spawned) => {
    const answers = await Promise.all([ask(), ask(), ask()]);
    assert.deepEqual(answers.map((a) => a.body.state), ["approved", "approved", "approved"]);
    assert.equal(await spawned(), 1, "three asks, one app-server");
    // And once it has answered, the next ask is a fresh question, not a cached one.
    await ask();
    assert.equal(await spawned(), 2);
  });
});

test("an ask started before the hooks changed does not answer for the hooks after", async () => {
  // The race: Settings opens and asks; while that is still out, the person presses
  // Reinstall, which rewrites the hook Codex approved. Codex keys approval by the entry's
  // content, so the approval the first question finds belongs to a hook that is gone. Had
  // the second ask simply joined the first, the row would go green over a hook Codex now
  // calls modified.
  await withBridge(
    (home) => ({
      // The change below sets a timeout of 30 on Stop; a Codex that reads the file after it
      // answers about the changed hooks, one that read it before answers about the old.
      whenFileHas: '"timeout":30',
      then: answer(homeHook(home, "stop", "modified"), homeHook(home, "pre_tool_use", "modified")),
      otherwise: answer(homeHook(home, "stop", "trusted"), homeHook(home, "pre_tool_use", "trusted")),
    }),
    async (ask, spawned, { codexHome }) => {
      const before = ask();
      // Wait until the first question is really out — its Codex has read the file — then
      // change what it was about. Long enough for a loaded machine, and checked rather than
      // assumed: proceeding early is exactly how this test once raced.
      for (let i = 0; i < 500 && (await spawned()) < 1; i += 1) await new Promise((r) => setTimeout(r, 20));
      assert.equal(await spawned(), 1, "the first question reached Codex before the file changed");
      const hooksJson = join(codexHome, "hooks.json");
      const current = JSON.parse(await readFile(hooksJson, "utf8"));
      current.hooks.Stop[0].hooks[0].timeout = 30;
      await writeFile(hooksJson, JSON.stringify(current));
      const after = ask();

      assert.equal((await before).body.state, "approved", "the first question still gets its own answer");
      assert.equal((await after).body.state, "modified", "the one asked after the change is answered about the change");
      assert.equal(await spawned(), 2, "and that took a question of its own");
    },
    { answerDelayMs: 800 },
  );
});
