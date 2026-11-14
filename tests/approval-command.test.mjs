import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { OWNER_DISCORD_SENDER, ROOM_RULES_VERSION, TERMINAL_ONLY, parseApproval, roomRules } from "../adapters/bridge/gyredeck-bridge.mjs";
import { MESSAGE_LIMIT, approvalOf, messageParts } from "../adapters/discord/connector.mjs";

/**
 * One exact command approved from Discord with the owner's code (#374): the shape every
 * parser shares, the commands only the terminal approves, the bridge route that lets the
 * command through once, and the Claude Code hook that turns that yes into a PreToolUse allow.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const CONFIG_DIR = [".config", "gyredeck"];
const APP_WORD = "e3".repeat(32);
const shapes = JSON.parse(await readFile(join(repoRoot, "tests", "approval-shapes.json"), "utf8"));
const commandOf = (command) => ({ action: "command", command });

const freePort = async () => {
  const probe = createHttpServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
};

/** A bridge on its own HOME; `restart` starts a new one on the same HOME and port. */
const startBridge = async (home = null) => {
  home ??= await mkdtemp(join(tmpdir(), "gd374-"));
  await mkdir(join(home, ...CONFIG_DIR), { recursive: true });
  const port = await freePort();
  const clock = join(home, "approval-clock");
  await writeFile(clock, "0");
  await writeFile(join(home, ...CONFIG_DIR, "gyredeck.config.json"), JSON.stringify({ host: "127.0.0.1", port }));
  let stderr = "";
  const bridge = spawn(
    process.execPath,
    ["adapters/bridge/gyredeck-bridge.mjs", "--port", String(port), "--host", "127.0.0.1", "--parent-stdio", "--broker-handshake"],
    { cwd: repoRoot, env: { ...process.env, HOME: home, GYREDECK_NO_AGENT_SPAWN: "1", GYREDECK_TEST_APPROVAL_CLOCK: clock }, stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = new Promise((resolve) => bridge.once("exit", resolve));
  bridge.stdin.write(`broker-secret ${APP_WORD}\nbroker-ready\n`);
  bridge.stderr.on("data", (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    if (attempt > 200) throw new Error(`bridge did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const token = (await readFile(join(home, ...CONFIG_DIR, "gyredeck.ingest-token"), "utf8")).trim();
  const app = { "content-type": "application/json", "x-gyredeck-token": token, "x-gyredeck-broker": APP_WORD };
  const call = async (method, path, body, headers = app) => {
    const response = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const halt = async () => {
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    await exited;
  };
  const stop = async () => {
    await halt();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  const moveClock = (ms) => writeFile(clock, String(ms));
  return { home, base, call, halt, stop, token, app, moveClock };
};

const keyOf = async (h, as) => (await h.call("GET", `/mail/inbox?as=${as}`)).body.memberKey;
const asMember = async (h, as, password) => ({ "content-type": "application/json", "x-gyredeck-token": password, "x-gyredeck-member": await keyOf(h, as) });

const roomWithRelay = async (h, peers = ["peer-a", "peer-b"]) => {
  const { room: code, password } = (await h.call("POST", "/sync/rooms", { conversationId: "founder-1" })).body;
  for (const peer of peers) {
    assert.equal((await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: peer })).status, 200);
    assert.equal((await h.call("POST", `/sync/rooms/${code}/confirm`, { conversationId: peer, password }, { "content-type": "application/json", "x-gyredeck-broker": APP_WORD })).status, 200);
  }
  assert.equal((await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: `discord-${code}`, relay: "discord" })).status, 200);
  return { code, password };
};

/** An ask for `approval` from `as`, and the app's stamp on it; answers the ask's seq. */
const askFor = async (h, code, headers, approval, as = "peer-a") => {
  const asked = await h.call("POST", `/mail/${code}`, { from: as, to: OWNER_DISCORD_SENDER, kind: "ask", text: "May I? Asking for the 6-digit approval code.", approval }, headers);
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  return asked.body.seq;
};
let discordId = 0;
const stampOf = (h, code, seq, approved, as = "peer-a") => h.call("POST", `/mail/${code}`, {
  from: OWNER_DISCORD_SENDER, to: as, kind: "tell", text: "Approved with the code", inReplyTo: seq, approved, discordMessageId: String(++discordId),
});
const useAs = (h, code, as, command, headers) => h.call("POST", `/mail/${code}/approval/use`, { as, command }, headers);

test("#374 I6: the bridge and the connector take every approval shape the app takes, and refuse every one it refuses", () => {
  for (const shape of shapes.accept) {
    assert.deepEqual(parseApproval(shape), shape, `bridge: ${JSON.stringify(shape).slice(0, 80)}`);
    assert.deepEqual(approvalOf(shape), shape, `connector: ${JSON.stringify(shape).slice(0, 80)}`);
  }
  for (const shape of shapes.refuse) {
    assert.equal(parseApproval(shape), null, `bridge: ${JSON.stringify(shape).slice(0, 80)}`);
    // The connector reads only what the bridge already took; its merge and release check is
    // #207's, unchanged, so a command is where it must agree.
    if (shape?.action === "command") assert.equal(approvalOf(shape), null, `connector: ${JSON.stringify(shape).slice(0, 80)}`);
  }
});

test("#374 I6: Discord shows the whole command, in a code block of its own, in messages within Discord's limit", () => {
  const message = (text, command) => ({ seq: 4, sender: "peer-a", to: "owner", kind: "ask", text, approval: commandOf(command) });
  const short = "gh issue close 160 -R j-kizt/gyredeck-macos";
  const one = messageParts(message("May I close it?", short), false).parts;
  assert.equal(one.length, 1);
  assert.ok(one[0].endsWith(`run this exact command once:\n\`\`\`\n${short}\n\`\`\``), one[0]);
  const long = `echo ${"é".repeat(995)}`;
  for (const text of ["short", "x".repeat(1500), "y".repeat(4100)]) {
    const parts = messageParts(message(text, long), false).parts;
    for (const part of parts) assert.ok(part.length <= MESSAGE_LIMIT, `${part.length} > ${MESSAGE_LIMIT}`);
    const last = parts.at(-1);
    assert.ok(last.includes(`\n\`\`\`\n${long}\n\`\`\``), "the command whole, never cut, in the last part");
    assert.ok(last.startsWith(text.length > 900 ? "Reply to this message" : "→"), last.slice(0, 40));
  }
});

test("#374 I4: the bridge's terminal-only list is the app's, entry for entry", async () => {
  const source = await readFile(join(repoRoot, "apps/desktop/src-tauri/src/discord/approvals.rs"), "utf8");
  const block = source.slice(source.indexOf("pub(crate) const TERMINAL_ONLY"), source.indexOf("];", source.indexOf("pub(crate) const TERMINAL_ONLY")));
  const rust = [...block.slice(block.indexOf("[", block.indexOf("="))).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
  assert.deepEqual(rust, TERMINAL_ONLY);
  assert.ok(TERMINAL_ONLY.every((entry) => entry === entry.toLowerCase()), "kept lower case: both sides compare lower case");
});

test("#374 I4: a command holding a terminal-only entry, in any case, is refused when asked for and nothing is sent", async () => {
  const h = await startBridge();
  try {
    const { code, password } = await roomWithRelay(h);
    const a = await asMember(h, "peer-a", password);
    const upper = (entry) => entry.replace(/[a-z]/g, (c, i) => (i % 2 ? c.toUpperCase() : c));
    for (const entry of TERMINAL_ONLY) {
      for (const command of [`run ${entry} now`, `run ${upper(entry)} now`]) {
        const refused = await h.call("POST", `/mail/${code}`, { from: "peer-a", to: OWNER_DISCORD_SENDER, kind: "ask", text: "may I?", approval: commandOf(command) }, a);
        assert.equal(refused.status, 400, command);
        assert.equal(refused.body.error, "invalid_approval", command);
      }
    }
    const fine = await h.call("POST", `/mail/${code}`, { from: "peer-a", to: OWNER_DISCORD_SENDER, kind: "ask", text: "may I?", approval: commandOf("gh issue close 160") }, a);
    assert.equal(fine.status, 202, "premise: an ordinary command is taken");
    const messages = (await h.call("GET", `/mail/${code}?as=discord-${code}&since=0`)).body.messages;
    assert.deepEqual(messages.filter((m) => m.approval).map((m) => m.approval.command), ["gh issue close 160"], "nothing refused reached the room");
  } finally {
    await h.stop();
  }
});

test("#374 I2 I3 I5: the use route lets exactly the stamped command through once, for the one who asked, while it lives", async () => {
  const h = await startBridge();
  try {
    const { code, password } = await roomWithRelay(h);
    const a = await asMember(h, "peer-a", password);
    const b = await asMember(h, "peer-b", password);
    const command = "gh issue close 160 -R j-kizt/gyredeck-macos";
    const seq = await askFor(h, code, a, commandOf(command));
    const merge = await askFor(h, code, a, { action: "merge", pr: 370, sha: "a".repeat(40) });
    assert.equal((await stampOf(h, code, merge, { action: "merge", pr: 370, sha: "a".repeat(40) })).status, 202);

    // I5: not yet stamped.
    const early = await useAs(h, code, "peer-a", command, a);
    assert.deepEqual([early.status, early.body.allowed], [404, false], "unstamped");
    assert.equal((await stampOf(h, code, seq, commandOf(command))).status, 202, "premise: stamped");

    // I3: whose.
    const machine = { "content-type": "application/json", "x-gyredeck-token": h.token };
    assert.equal((await useAs(h, code, "peer-a", command, machine)).status, 403, "the machine token alone");
    assert.equal((await useAs(h, code, "peer-a", command, b)).status, 403, "another member's key");
    assert.equal((await useAs(h, code, "peer-a", command, { "content-type": "application/json", "x-gyredeck-token": password })).status, 403, "the password with no key");
    const other = await useAs(h, code, "peer-b", command, h.app);
    assert.deepEqual([other.status, other.body.allowed], [404, false], "another session, vouched for by the broker");
    const otherOwn = await useAs(h, code, "peer-b", command, b);
    assert.deepEqual([otherOwn.status, otherOwn.body.allowed], [404, false], "another session with its own key");

    // I1 at the bridge: not exact, or not a command approval.
    for (const near of [`${command} ; echo $?`, ` ${command}`, command.toUpperCase(), command.slice(0, -1), "gh pr merge 370"]) {
      const answer = await useAs(h, code, "peer-a", near, a);
      assert.deepEqual([answer.status, answer.body.allowed], [404, false], near);
    }

    // I5: past 30 minutes, then back inside them.
    await h.moveClock(31 * 60 * 1000);
    const late = await useAs(h, code, "peer-a", command, a);
    assert.deepEqual([late.status, late.body.allowed], [404, false], "past 30 minutes");
    await h.moveClock(0);

    const used = await useAs(h, code, "peer-a", command, a);
    assert.deepEqual([used.status, used.body], [200, { ok: true, allowed: true, room: code, seq, command }]);
    // I2: once.
    const again = await useAs(h, code, "peer-a", command, a);
    assert.deepEqual([again.status, again.body.allowed], [404, false], "a second use");
    const vouchedAgain = await useAs(h, code, "peer-a", command, h.app);
    assert.deepEqual([vouchedAgain.status, vouchedAgain.body.allowed], [404, false], "a second use through the broker");
    const read = await h.call("GET", `/mail/${code}/approval?as=peer-a&seq=${seq}`, undefined, a);
    assert.equal(read.body.used, true, JSON.stringify(read.body));
    assert.equal(read.body.approved, true);
  } finally {
    await h.stop();
  }
});

test("#374 I2: a used approval stays used across a bridge restart", async () => {
  let h = await startBridge();
  const home = h.home;
  try {
    const { code, password } = await roomWithRelay(h);
    const a = await asMember(h, "peer-a", password);
    const seq = await askFor(h, code, a, commandOf("gh issue close 160"));
    await stampOf(h, code, seq, commandOf("gh issue close 160"));
    assert.equal((await useAs(h, code, "peer-a", "gh issue close 160", h.app)).status, 200, "premise: used once");
    await h.halt();
    h = await startBridge(home);
    const after = await useAs(h, code, "peer-a", "gh issue close 160", h.app);
    assert.equal(after.body.allowed, false, JSON.stringify(after.body));
    assert.notEqual(after.status, 200);
  } finally {
    await h.stop();
  }
});

/**
 * A broker as the app's answers a `use` (#374): for the session it bound, never a name in the
 * request, forwarded to the bridge with the app's word. `mode` swaps in a broken answer.
 */
const useBroker = async (home, base) => {
  const dir = join(home, ...CONFIG_DIR, "broker");
  await mkdir(dir, { recursive: true });
  const state = { bound: null, mode: "forward", uses: [] };
  const answerUse = async (request) => {
    state.uses.push(request.use);
    const token = (await readFile(join(home, ...CONFIG_DIR, "gyredeck.ingest-token"), "utf8")).trim();
    // No room: the app finds the bound session's own room, with its word (#344).
    let room = request.use.room;
    if (room === undefined) {
      const found = await fetch(`${base}/sync/rooms?as=${encodeURIComponent(state.bound)}`, { headers: { "x-gyredeck-token": token, "x-gyredeck-broker": APP_WORD } });
      room = (await found.json()).room;
      if (typeof room !== "string") return { v: 1, ok: false, error: "room", status: 404, boundTo: state.bound, answer: { ok: false, error: "no_live_approval" } };
    }
    const response = await fetch(`${base}/mail/${room}/approval/use`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gyredeck-token": token, "x-gyredeck-broker": APP_WORD },
      body: JSON.stringify({ as: state.bound, command: request.use.command }),
    });
    const body = await response.json();
    return response.status === 200
      ? { v: 1, ok: true, boundTo: state.bound, used: body }
      : { v: 1, ok: false, error: "room", status: response.status, boundTo: state.bound, answer: body };
  };
  const server = createServer((socket) => {
    let text = "";
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(text.slice(0, end));
      if (request.bind) {
        state.bound = request.bind.conversationId;
        socket.end(`${JSON.stringify({ v: 1, ok: true, bound: { conversationId: state.bound, pid: 1 } })}\n`);
        return;
      }
      if (!request.use) return socket.end(`${JSON.stringify({ v: 1, ok: true })}\n`);
      const real = await answerUse(request);
      const said = { ...real.used, seq: real.used?.seq };
      const broken = {
        forward: real,
        hang: null,
        garbage: "not json",
        v2: { ...real, v: 2 },
        refused: { v: 1, ok: false, error: "room", status: 404 },
        "other session": { ...real, boundTo: "peer-b" },
        "other command": { ...real, used: { ...said, command: `${said.command} ` } },
        "no seq": { ...real, used: { ...said, seq: undefined } },
        "seq as text": { ...real, used: { ...said, seq: String(said.seq) } },
        "allowed as text": { ...real, used: { ...said, allowed: "true" } },
        "not ok": { ...real, used: { ...said, ok: false } },
      }[state.mode];
      if (broken === null) return;
      socket.end(typeof broken === "string" ? `${broken}\n` : `${JSON.stringify(broken)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(join(dir, "gyredeck.broker.sock"), resolve));
  server.unref();
  return { state, close: () => new Promise((resolve) => server.close(resolve)) };
};

const runHook = (home, payload) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["adapters/claude/gyredeck-claude-hook.mjs", "--event", payload.hook_event_name], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end(JSON.stringify(payload));
    child.on("close", () => resolve(stdout));
  });
const preToolUse = (command, tool = "Bash", session = "peer-a") => ({
  hook_event_name: "PreToolUse", session_id: session, cwd: "/tmp/project", tool_name: tool, tool_input: { command, description: "x" },
});
const allowOf = (stdout) => {
  const line = stdout.trim();
  if (!line) return null;
  const said = JSON.parse(line).hookSpecificOutput;
  return said?.permissionDecision === "allow" ? said : null;
};

test("#374 I1: the hook allows the exact approved Bash command once, unchanged, and nothing else", async () => {
  const h = await startBridge();
  const broker = await useBroker(h.home, h.base);
  try {
    const { code, password } = await roomWithRelay(h);
    const a = await asMember(h, "peer-a", password);
    const command = "gh api -X PATCH repos/j-kizt/gyredeck-macos/milestones/12 -f state=closed";
    const seq = await askFor(h, code, a, commandOf(command));
    assert.equal(allowOf(await runHook(h.home, preToolUse(command))), null, "asked, not yet stamped");
    await stampOf(h, code, seq, commandOf(command));
    for (const [payload, why] of [
      [preToolUse(`${command}; echo $?`), "something appended"],
      [preToolUse(command, "Write"), "another tool"],
      [preToolUse(command, "Bash", "peer-b"), "another session"],
      [{ ...preToolUse(command), tool_input: { command, description: "x", dangerouslyDisableSandbox: true } }, "out of the sandbox"],
      [{ ...preToolUse(command), tool_input: { command, description: "x", run_in_background: true } }, "in the background"],
    ]) assert.equal(allowOf(await runHook(h.home, payload)), null, why);
    const stdout = await runHook(h.home, preToolUse(command));
    assert.deepEqual(JSON.parse(stdout.trim()), {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: `Approved by the owner from Discord with their code (request seq ${seq}): this exact command, once.`,
      },
    }, "the allow, and no updatedInput");
    assert.equal(allowOf(await runHook(h.home, preToolUse(command))), null, "once");
  } finally {
    await broker.close();
    await h.stop();
  }
});

test("#374 I1: any broker answer but a well-formed yes for this session, this command and a seq is no allow", async () => {
  const h = await startBridge();
  const broker = await useBroker(h.home, h.base);
  try {
    const { code, password } = await roomWithRelay(h);
    const a = await asMember(h, "peer-a", password);
    const modes = ["hang", "garbage", "v2", "refused", "other session", "other command", "no seq", "seq as text", "allowed as text", "not ok"];
    for (const mode of [...modes, "forward"]) {
      const command = `gh issue close ${200 + modes.indexOf(mode)}`;
      const seq = await askFor(h, code, a, commandOf(command));
      await stampOf(h, code, seq, commandOf(command));
      broker.state.mode = mode;
      const allowed = allowOf(await runHook(h.home, preToolUse(command)));
      if (mode === "forward") assert.ok(allowed, "control: the same fixture with an honest broker allows");
      else assert.equal(allowed, null, mode);
    }
    await broker.close();
    const seq = await askFor(h, code, a, commandOf("gh issue close 300"));
    await stampOf(h, code, seq, commandOf("gh issue close 300"));
    assert.equal(allowOf(await runHook(h.home, preToolUse("gh issue close 300"))), null, "no broker");
    assert.equal((await useAs(h, code, "peer-a", "gh issue close 300", a)).status, 200, "and the approval was not spent");
  } finally {
    await broker.close().catch(() => {});
    await h.stop();
  }
});

test("#374: rules v20 say one exact command can be asked for, run verbatim, and what stays at the terminal", () => {
  assert.ok(ROOM_RULES_VERSION >= 20, "introduced in v20");
  const rules = roomRules("http://127.0.0.1:47621");
  assert.match(rules, /The one exception is a merge or a release approved with the owner's code, or one exact command approved the same way/);
  assert.match(rules, /\{"action":"command","command":"<the command, exactly as you will run it>"\}/);
  assert.match(rules, /run that command verbatim, as one Bash call: nothing added, wrapped or appended — no `cd … &&`, no `2>&1`, no `; echo \$\?`/);
  for (const entry of TERMINAL_ONLY) assert.ok(rules.includes(`\`${entry}\``), entry);
  assert.match(rules, /Antigravity may ask for a command too, but Gyredeck has no hook in its harness/);
  assert.match(rules, /Codex cannot attach `approval`, so a Codex agent asks at the terminal as before/);
});
