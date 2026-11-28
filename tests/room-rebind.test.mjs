import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A session that reopens in a new process is let back into its room only by a fresh one-time
 * password (#332), and the shared room password is gone. The broker numbers each new binding
 * of a session (its generation); the bridge takes a higher number for a confirmed member as a
 * new process, and shuts it out until the person pastes a new password into that terminal.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const CONFIG_DIR = [".config", "gyredeck"];
const APP_WORD = "e7".repeat(32);

const freePort = async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
};

const startBridge = async ({ env = {}, ledger = [] } = {}) => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-rebind-"));
  await mkdir(join(home, ...CONFIG_DIR), { recursive: true });
  const port = await freePort();
  await writeFile(join(home, ...CONFIG_DIR, "gyredeck.config.json"), JSON.stringify({ host: "127.0.0.1", port }));
  const log = { stderr: "" };
  const bridge = spawn(
    process.execPath,
    ["adapters/bridge/gyredeck-bridge.mjs", "--port", String(port), "--host", "127.0.0.1", "--parent-stdio", "--broker-handshake"],
    { cwd: repoRoot, env: { ...process.env, HOME: home, GYREDECK_NO_AGENT_SPAWN: "1", ...env }, stdio: ["pipe", "pipe", "pipe"] },
  );
  bridge.stdin.write(`broker-secret ${APP_WORD}\n${ledger.map((line) => `broker-bound ${line}\n`).join("")}broker-ready\n`);
  bridge.stderr.on("data", (chunk) => { log.stderr += chunk; });
  bridge.stdout.resume();
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    if (attempt > 200) throw new Error(`bridge did not start: ${log.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const token = (await readFile(join(home, ...CONFIG_DIR, "gyredeck.ingest-token"), "utf8")).trim();
  const app = { "content-type": "application/json", "x-gyredeck-token": token, "x-gyredeck-broker": APP_WORD };
  const call = async (method, path, body, headers = app) => {
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const stop = async () => {
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  return { base, call, stop, token, app };
};

/** A room founded by `founder`, with `member` let in by its own one-time password. */
const roomWith = async (h, founder, member, { memberGeneration = 2 } = {}) => {
  assert.equal((await h.call("POST", "/broker/bound", { conversationId: founder, generation: 1 })).status, 200);
  const created = await h.call("POST", "/sync/rooms", { conversationId: founder });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const code = created.body.room;
  await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: member });
  // Its hook binds before it confirms: the broker names the session from the process.
  assert.equal((await h.call("POST", "/broker/bound", { conversationId: member, generation: memberGeneration })).status, 200);
  const minted = await h.call("POST", `/sync/rooms/${code}/members/${member}/join-code`, {});
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  const confirmed = await h.call("POST", `/sync/rooms/${code}/confirm`, { conversationId: member, password: minted.body.code });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return { code, created: created.body };
};

const keyOf = async (h, as) => (await h.call("GET", `/mail/inbox?as=${as}`)).body?.memberKey;
const confirmedIn = async (h, as) => (await h.call("GET", `/sync/rooms?as=${as}`)).body?.members?.find((m) => m.conversationId === as)?.confirmed === true;
const readAs = (h, code, as, key) => h.call("GET", `/mail/${code}?as=${as}&since=0`, undefined, { "x-gyredeck-token": h.token, "x-gyredeck-member": key });
const bound = (h, conversationId, generation) => h.call("POST", "/broker/bound", { conversationId, generation });
const reopenedNotices = async (h, code, as) => {
  const read = await readAs(h, code, as, await keyOf(h, as));
  return (read.body?.messages ?? []).filter((m) => /reopened in a new process/.test(m.text));
};

test("#332 a confirmed member that reopens in a new process is shut out: key, watch and roster, told once", async () => {
  const h = await startBridge();
  try {
    const { code } = await roomWith(h, "founder-1", "member-b");
    const oldKey = await keyOf(h, "member-b");
    assert.equal((await readAs(h, code, "member-b", oldKey)).status, 200, "premise: b reads with its key");

    const watch = await fetch(`${h.base}/mail/${code}/events?as=member-b`, { headers: { "x-gyredeck-token": h.token, "x-gyredeck-member": oldKey } });
    assert.equal(watch.status, 200, "premise: b's watch is open");
    // Bounded, so a watch left open fails here by name instead of hanging the file.
    const watchText = Promise.race([watch.text(), new Promise((resolve) => setTimeout(() => resolve("(still open after 3 s)"), 3000))]);

    assert.equal((await bound(h, "member-b", 7)).status, 200);
    assert.equal(await confirmedIn(h, "member-b"), false, "the new process is not confirmed");
    assert.equal((await readAs(h, code, "member-b", oldKey)).status, 403, "the old process's key reads nothing");
    assert.match(await watchText, /reopened in a new process/, "the old watch is cut");
    // The new process's first delivery hands it a key of its own (#403 F2), which reads nothing of
    // the room until it is let in again.
    const newKey = await keyOf(h, "member-b");
    assert.notEqual(newKey, oldKey, "a new process, a new key");
    assert.equal((await readAs(h, code, "member-b", newKey)).status, 403, "the new key reads nothing of the room while unconfirmed");
    const sent = await h.call("POST", `/mail/${code}`, { from: "member-b", to: "everyone", kind: "tell", text: "still here?" }, { "content-type": "application/json", "x-gyredeck-token": h.token, "x-gyredeck-member": oldKey });
    assert.ok(sent.status >= 400, `the old key posts nothing: ${sent.status}`);
    // Its own inbox, wait and private mailbox stream too: the door those take judges the key alone.
    const byOldKey = { "x-gyredeck-member": oldKey };
    for (const path of ["/mail/inbox?as=member-b", "/mail/wait?as=member-b&timeoutMs=1", "/mail/member-b/events?as=member-b"]) {
      const response = await fetch(`${h.base}${path}`, { headers: byOldKey, signal: AbortSignal.timeout(3000) }).catch((error) => ({ status: `threw ${error.name}` }));
      assert.ok(typeof response.status === "number" && response.status >= 400, `the old key opens nothing at ${path}: ${response.status}`);
      await response.body?.cancel?.();
    }

    assert.equal((await reopenedNotices(h, code, "founder-1")).length, 1, "the room is told once");
    assert.equal((await bound(h, "member-b", 7)).status, 200);
    assert.equal((await reopenedNotices(h, code, "founder-1")).length, 1, "the same binding again tells nobody twice");
  } finally {
    await h.stop();
  }
});

test("#332 the same process binding again, or a late report of an older binding, changes nothing", async () => {
  const h = await startBridge();
  try {
    const { code } = await roomWith(h, "founder-1", "member-b", { memberGeneration: 5 });
    const key = await keyOf(h, "member-b");
    for (const generation of [5, 4, 1]) {
      assert.equal((await bound(h, "member-b", generation)).status, 200);
      assert.equal(await confirmedIn(h, "member-b"), true, `generation ${generation} is not a new process`);
      assert.equal((await readAs(h, code, "member-b", key)).status, 200, `the key still reads after generation ${generation}`);
    }
    // A report with no generation (an older app) says nothing about which process it is.
    assert.equal((await h.call("POST", "/broker/bound", { conversationId: "member-b" })).status, 200);
    assert.equal(await confirmedIn(h, "member-b"), true);
    assert.equal((await reopenedNotices(h, code, "founder-1")).length, 0);
    for (const generation of [0, -1, 1.5, "6", 2 ** 60]) {
      assert.equal((await bound(h, "member-b", generation)).status, 400, `generation ${JSON.stringify(generation)} is refused`);
    }
    assert.equal(await confirmedIn(h, "member-b"), true, "and a refused report shuts nobody out");
  } finally {
    await h.stop();
  }
});

test("#332 a fresh one-time password lets the new process back in exactly once; the old one is dead", async () => {
  const h = await startBridge();
  try {
    const { code } = await roomWith(h, "founder-1", "member-b");
    const oldKey = await keyOf(h, "member-b");
    // A password minted for the old process and never pasted dies with it: the new process
    // cannot inherit it.
    const unused = (await h.call("POST", `/sync/rooms/${code}/members/member-b/join-code`, {})).body.code;
    await bound(h, "member-b", 9);
    const inherited = await h.call("POST", `/sync/rooms/${code}/confirm`, { conversationId: "member-b", password: unused });
    assert.notEqual(inherited.status, 200, "the old process's outstanding password is dropped");
    assert.equal(await confirmedIn(h, "member-b"), false);

    const fresh = (await h.call("POST", `/sync/rooms/${code}/members/member-b/join-code`, {})).body.code;
    assert.equal((await h.call("POST", `/sync/rooms/${code}/confirm`, { conversationId: "member-b", password: fresh })).status, 200);
    assert.equal(await confirmedIn(h, "member-b"), true, "a fresh password lets it in");
    const newKey = await keyOf(h, "member-b");
    assert.notEqual(newKey, oldKey, "with a new key");
    assert.equal((await readAs(h, code, "member-b", newKey)).status, 200);
    assert.equal((await readAs(h, code, "member-b", oldKey)).status, 403, "and the old key stays dead");
    await h.call("POST", `/sync/rooms/${code}/confirm`, { conversationId: "member-b", password: fresh });
    assert.equal(await keyOf(h, "member-b"), newKey, "a replay of the spent password changes nothing");

    // The binding it was confirmed under is now its own: the same generation again is no reopen.
    await bound(h, "member-b", 9);
    assert.equal(await confirmedIn(h, "member-b"), true);
  } finally {
    await h.stop();
  }
});

test("#332 a member confirmed with no binding known is shut out by its first one (fail closed)", async () => {
  const h = await startBridge();
  try {
    const created = await h.call("POST", "/sync/rooms", { conversationId: "founder-1" });
    const code = created.body.room;
    assert.equal(await confirmedIn(h, "founder-1"), true, "premise: the founder is in");
    await bound(h, "founder-1", 3);
    assert.equal(await confirmedIn(h, "founder-1"), false, "a process the bridge never saw confirmed is not taken on trust");
    const fresh = (await h.call("POST", `/sync/rooms/${code}/members/founder-1/join-code`, {})).body.code;
    assert.equal((await h.call("POST", `/sync/rooms/${code}/confirm`, { conversationId: "founder-1", password: fresh })).status, 200);
    assert.equal(await confirmedIn(h, "founder-1"), true);
  } finally {
    await h.stop();
  }
});

test("#332 a bridge restarted with the ledger knows each live binding, so the founder is not shut out", async () => {
  const h = await startBridge({ ledger: ["founder-1 4"] });
  try {
    const created = await h.call("POST", "/sync/rooms", { conversationId: "founder-1" });
    assert.equal(created.status, 201);
    await bound(h, "founder-1", 4);
    assert.equal(await confirmedIn(h, "founder-1"), true, "the binding the ledger named is the one it was founded under");
    await bound(h, "founder-1", 5);
    assert.equal(await confirmedIn(h, "founder-1"), false, "a newer one is a new process");
  } finally {
    await h.stop();
  }
});

test("#332 the shared room password is gone: create hands none out, and no route mints one", async () => {
  const h = await startBridge();
  try {
    const { code, created } = await roomWith(h, "founder-1", "member-b");
    assert.equal(created.password, undefined, "create hands out no password");
    assert.equal(JSON.stringify(created).match(/\b[0-9a-f]{32}\b/), null, "nor anything of a password's shape");
    const minted = await h.call("POST", `/sync/rooms/${code}/passwords`, { conversationId: "founder-1" });
    assert.notEqual(minted.status, 200, "the founder's password route is gone");
    assert.equal(minted.body?.password, undefined);
  } finally {
    await h.stop();
  }
});

test("#332 a one-time password lives one minute by default and not past its time", async () => {
  const h = await startBridge();
  try {
    const { code } = await roomWith(h, "founder-1", "member-b");
    await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: "member-c" });
    const before = Date.now();
    const minted = (await h.call("POST", `/sync/rooms/${code}/members/member-c/join-code`, {})).body;
    const lives = Date.parse(minted.expiresAt) - before;
    assert.ok(lives > 59_000 && lives <= 61_000, `one minute, not two: ${lives} ms`);
  } finally {
    await h.stop();
  }
  const short = await startBridge({ env: { GYREDECK_JOIN_CODE_TTL_MS: "400" } });
  try {
    const { code } = await roomWith(short, "founder-1", "member-b");
    await short.call("POST", `/sync/rooms/${code}/members`, { conversationId: "member-c" });
    const late = (await short.call("POST", `/sync/rooms/${code}/members/member-c/join-code`, {})).body.code;
    await new Promise((resolve) => setTimeout(resolve, 600));
    const expired = await short.call("POST", `/sync/rooms/${code}/confirm`, { conversationId: "member-c", password: late });
    assert.notEqual(expired.status, 200, "past its minute it lets nobody in");
    assert.equal(await confirmedIn(short, "member-c"), false);
  } finally {
    await short.stop();
  }
});

test("#332 an inbox answer names which room it is, not only its code, so parked mail goes back to that room only", async () => {
  const h = await startBridge();
  try {
    const { code } = await roomWith(h, "founder-1", "member-b");
    const inbox = (await h.call("GET", "/mail/inbox?as=member-b")).body;
    assert.equal(inbox.room, code);
    assert.match(inbox.roomInstance ?? "", /^[0-9a-f-]{36}$/, JSON.stringify(inbox));
  } finally {
    await h.stop();
  }
});
