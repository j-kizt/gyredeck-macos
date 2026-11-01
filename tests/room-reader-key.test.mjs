import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * A read in a member's name takes that member's own key (#274). The room's password is
 * shared by everyone in it, so on its own it let any member — or anyone who learnt it —
 * watch or collect as another and move that member's position, and the member silently
 * missed its mail. Each test names the claim it proves, from Gyre Audit's checklist.
 */
const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CONFIG_DIR = [".config", "gyredeck"];
const APP_WORD = "d3".repeat(32);
const KEY = /^[0-9a-f]{64}$/;

const freePort = async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
};

const startBridge = async () => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-key-"));
  await mkdir(join(home, ...CONFIG_DIR), { recursive: true });
  const port = await freePort();
  await writeFile(join(home, ...CONFIG_DIR, "gyredeck.config.json"), JSON.stringify({ host: "127.0.0.1", port }));
  const log = { stderr: "", stdout: "" };
  const bridge = spawn(
    process.execPath,
    ["adapters/bridge/gyredeck-bridge.mjs", "--port", String(port), "--host", "127.0.0.1", "--parent-stdio", "--broker-handshake"],
    { cwd: repoRoot, env: { ...process.env, HOME: home, GYREDECK_NO_AGENT_SPAWN: "1" }, stdio: ["pipe", "pipe", "pipe"] },
  );
  bridge.stdin.write(`broker-secret ${APP_WORD}\nbroker-ready\n`);
  bridge.stderr.on("data", (chunk) => { log.stderr += chunk; });
  bridge.stdout.on("data", (chunk) => { log.stdout += chunk; });
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
    const response = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), text: null };
  };
  const raw = async (path, headers) => {
    const response = await fetch(`${base}${path}`, { headers });
    return { status: response.status, text: await response.text() };
  };
  const stop = async () => {
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  return { base, call, raw, stop, token, app, log };
};

/** A room founded by `a`, with `b` let in by the password: both confirmed. */
const twoMembers = async (h) => {
  const created = (await h.call("POST", "/sync/rooms", { conversationId: "member-a" })).body;
  const { room: code, password } = created;
  await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: "member-b" });
  const confirmed = await h.call("POST", `/sync/rooms/${code}/confirm`, { conversationId: "member-b", password }, { "content-type": "application/json" });
  assert.equal(confirmed.status, 200, "premise: b is let in");
  const keyOf = async (as) => (await h.call("GET", `/mail/inbox?as=${as}`, null, { "x-gyredeck-token": password, "x-gyredeck-broker": APP_WORD })).body.memberKey;
  const post = (from, to, text) => h.call("POST", `/mail/${code}`, { from, to, kind: "tell", text }, { "content-type": "application/json", "x-gyredeck-token": password });
  return { code, password, created, confirmed, keyOf, post, pw: { "x-gyredeck-token": password } };
};

const pendingOf = async (h, as) => (await h.call("GET", `/sync/rooms?as=${as}`)).body.members.find((m) => m.conversationId === as).pending;

/** Open a watch, read until `ms` passes, and hand back the status and every data frame. */
const watch = async (h, code, as, headers, ms = 400) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  let status = null;
  let text = "";
  try {
    const response = await fetch(`${h.base}/mail/${code}/events?as=${as}&since=resume`, { headers, signal: controller.signal });
    status = response.status;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString();
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
  }
  const frames = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  return { status, frames, text };
};

test("C1: a watch in another member's name is refused and moves nothing; the member's own watch still hears", async () => {
  const h = await startBridge();
  try {
    const r = await twoMembers(h);
    const keyA = await r.keyOf("member-a");
    const sent = (await r.post("member-a", "member-b", "for b only")).body;
    assert.equal(typeof sent.seq, "number", "premise: posted");
    for (const [why, headers] of [
      ["password alone", r.pw],
      ["password and a's key", { ...r.pw, "x-gyredeck-member": keyA }],
      ["password and a key-shaped guess", { ...r.pw, "x-gyredeck-member": "0".repeat(64) }],
      ["password and an empty key", { ...r.pw, "x-gyredeck-member": "" }],
    ]) {
      const stolen = await watch(h, r.code, "member-b", headers);
      assert.equal(stolen.status, 403, why);
      assert.match(stolen.text, /not_your_key/, why);
      assert.deepEqual(stolen.frames.filter((f) => f.seq === sent.seq), [], `${why}: nothing handed over`);
    }
    const own = await watch(h, r.code, "member-b", { ...r.pw, "x-gyredeck-member": await r.keyOf("member-b") }, 800);
    assert.equal(own.status, 200);
    assert.ok(own.frames.some((f) => f.seq === sent.seq), "b's own resume still starts before the message: the refused watches moved nothing");
  } finally {
    await h.stop();
  }
});

test("C1: every read and take in another member's name is refused before anything moves", async () => {
  const h = await startBridge();
  try {
    const r = await twoMembers(h);
    const keyA = await r.keyOf("member-a");
    const sent = (await r.post("member-a", "member-b", "for b only")).body;
    const before = await pendingOf(h, "member-b");
    assert.ok(before >= 1, "premise: b has mail waiting");
    const paths = [
      `/mail/${r.code}?as=member-b`,
      `/mail/${r.code}?as=member-b&collect=1`,
      `/mail/${r.code}?as=member-b&since=0&until=${sent.seq}`,
      `/mail/inbox?as=member-b`,
      `/mail/inbox?as=member-b&collect=1`,
      `/mail/wait?as=member-b&timeout=1&collect=1`,
    ];
    for (const path of paths) {
      for (const [why, headers] of [
        ["password alone", r.pw],
        ["password and a's key", { ...r.pw, "x-gyredeck-member": keyA }],
        ["machine token alone", { "x-gyredeck-token": h.token }],
        ["machine token and a's key", { "x-gyredeck-token": h.token, "x-gyredeck-member": keyA }],
      ]) {
        const answer = await h.raw(path, headers);
        assert.equal(answer.status, 403, `${path}, ${why}: ${answer.text}`);
        assert.doesNotMatch(answer.text, /for b only/, `${path}, ${why}: nothing handed over`);
      }
    }
    assert.equal(await pendingOf(h, "member-b"), before, "no refused read moved b's position");
  } finally {
    await h.stop();
  }
});

test("C3: a member's own key reads only what reaches it — plain, bounded or taken — and the relay still reads the whole room", async () => {
  const h = await startBridge();
  try {
    const r = await twoMembers(h);
    const keyA = await r.keyOf("member-a");
    const secret = (await r.post("member-b", "member-b", "b to b only")).body;
    const toA = (await r.post("member-b", "member-a", "b to a")).body;
    const toAll = (await h.call("POST", `/mail/${r.code}`, { from: "member-b", to: "everyone", kind: "tell", text: "b to everyone" }, { "content-type": "application/json", "x-gyredeck-token": r.password })).body;
    assert.ok([secret, toA, toAll].every((sent) => typeof sent.seq === "number"), "premise: all three posted");
    const asA = { ...r.pw, "x-gyredeck-member": keyA };
    const bBefore = await pendingOf(h, "member-b");
    for (const path of [
      `/mail/${r.code}?as=member-a`,
      `/mail/${r.code}?as=member-a&since=0`,
      `/mail/${r.code}?as=member-a&since=0&until=${toAll.seq}`,
      `/mail/${r.code}?as=member-a&since=0&collect=1`,
    ]) {
      const answer = await h.raw(path, asA);
      assert.equal(answer.status, 200, `${path}: ${answer.text}`);
      const seqs = JSON.parse(answer.text).messages.map((m) => m.seq);
      assert.ok(!seqs.includes(secret.seq), `${path}: a message to b alone is not a's to read`);
      assert.ok(seqs.includes(toA.seq) && seqs.includes(toAll.seq), `${path}: what reaches a is there`);
    }
    assert.equal(await pendingOf(h, "member-a"), 0, "a's take moved a's own position past what reached it");
    assert.equal(await pendingOf(h, "member-b"), bBefore, "and b's not at all");
    const relayId = "discord-relay-2";
    assert.equal((await h.call("POST", `/sync/rooms/${r.code}/members`, { conversationId: relayId, relay: "discord" })).status, 200, "premise: the relay joined");
    const relayRead = await h.call("GET", `/mail/${r.code}?as=${relayId}&since=0`);
    assert.equal(relayRead.status, 200, JSON.stringify(relayRead.body));
    assert.ok(relayRead.body.messages.some((m) => m.seq === secret.seq), "the relay hears the whole room");
  } finally {
    await h.stop();
  }
});

test("C3: a take moves its reader past everything it examined — another member's line last, or nothing to hand — and nobody else", async () => {
  const h = await startBridge();
  try {
    const r = await twoMembers(h);
    const asA = { ...r.pw, "x-gyredeck-member": await r.keyOf("member-a") };
    // A reader's position, as the room keeps it: pending is the room's seq less it.
    const readSeqOf = async (as) => {
      const listed = (await h.call("GET", `/sync/rooms?as=${as}`)).body;
      return listed.seq - listed.members.find((m) => m.conversationId === as).pending;
    };
    let since = 0;
    // Each take is checked to leave b where b was: a sender's own post moves its own
    // position, a's take never does.
    const take = async () => {
      const bAt = await readSeqOf("member-b");
      const body = JSON.parse((await h.raw(`/mail/${r.code}?as=member-a&since=${since}&collect=1`, asA)).text);
      since = body.seq;
      assert.equal(await readSeqOf("member-b"), bAt, "b's position is never a's take's business");
      return body.messages.map((m) => m.text);
    };
    await take();
    assert.equal(await pendingOf(h, "member-a"), 0, "premise: a starts with nothing unread");
    await r.post("member-b", "member-a", "for a");
    await r.post("member-b", "member-b", "b's own, last");
    assert.deepEqual(await take(), ["for a"], "a is handed its line and not b's");
    assert.equal(await pendingOf(h, "member-a"), 0, "a is past b's line too: it examined it");
    assert.deepEqual(await take(), [], "a repeat hands nothing");
    assert.equal(await pendingOf(h, "member-a"), 0);
    await r.post("member-b", "member-b", "only b's after this");
    assert.deepEqual(await take(), [], "nothing reaches a");
    assert.equal(await pendingOf(h, "member-a"), 0, "a take that hands nothing still moves a past what it examined");
    await r.post("member-b", "member-a", "a's next");
    assert.deepEqual(await take(), ["a's next"], "and the next line for a is not skipped");
    assert.equal(await pendingOf(h, "member-a"), 0);
    // A since past the room's end moves the position only to the end: what is said after it
    // is still owed to a, and still counted.
    const end = since;
    since = end + 1000;
    assert.deepEqual(await take(), []);
    since = end;
    await r.post("member-b", "member-a", "after a far since");
    assert.equal(await pendingOf(h, "member-a"), 1, "never past the room's end");
    assert.deepEqual(await take(), ["after a far since"]);
  } finally {
    await h.stop();
  }
});

test("C3: a member's own key reads its own view, and only its own", async () => {
  const h = await startBridge();
  try {
    const r = await twoMembers(h);
    const [keyA, keyB] = [await r.keyOf("member-a"), await r.keyOf("member-b")];
    assert.match(keyA, KEY);
    assert.match(keyB, KEY);
    assert.notEqual(keyA, keyB, "each member its own");
    const sent = (await r.post("member-a", "member-b", "for b")).body;
    const look = await h.raw(`/mail/${r.code}?as=member-b&since=0&until=${sent.seq}`, { ...r.pw, "x-gyredeck-member": keyB });
    assert.equal(look.status, 200, look.text);
    assert.match(look.text, /for b/);
    const inbox = await h.raw(`/mail/inbox?as=member-b`, { ...r.pw, "x-gyredeck-member": keyB });
    assert.equal(inbox.status, 200, inbox.text);
    assert.equal((await h.raw(`/mail/${r.code}?as=member-a&since=0&until=${sent.seq}`, { ...r.pw, "x-gyredeck-member": keyB })).status, 403, "b's key does not open a's view");
    assert.equal((await h.raw(`/mail/inbox?as=member-a`, { ...r.pw, "x-gyredeck-member": keyB })).status, 403, "nor a's mailbox");
  } finally {
    await h.stop();
  }
});

test("C2/C4: the key is handed only to a read the broker vouches for, and never shows anywhere else", async () => {
  const h = await startBridge();
  try {
    const r = await twoMembers(h);
    const keyA = await r.keyOf("member-a");
    const keyB = await r.keyOf("member-b");
    const sent = await r.post("member-a", "member-b", "hello b");
    const surfaces = {
      "create answer": JSON.stringify(r.created),
      "confirm answer": JSON.stringify(r.confirmed.body),
      "post receipt": JSON.stringify(sent.body),
      "app listing": JSON.stringify((await h.call("GET", "/mail")).body),
      "rooms listing": JSON.stringify((await h.call("GET", "/sync/rooms?as=member-a")).body),
      "b's own keyed look": (await h.raw(`/mail/${r.code}?as=member-b&since=0`, { ...r.pw, "x-gyredeck-member": keyB })).text,
      "b's own keyed inbox": (await h.raw(`/mail/inbox?as=member-b`, { ...r.pw, "x-gyredeck-member": keyB })).text,
      "b's own keyed watch": (await watch(h, r.code, "member-b", { ...r.pw, "x-gyredeck-member": keyB })).text,
      "a refused read": (await h.raw(`/mail/inbox?as=member-a`, r.pw)).text,
      "a refused watch": (await watch(h, r.code, "member-a", r.pw)).text,
      "b's broker read": JSON.stringify((await h.call("GET", `/mail/inbox?as=member-b`, null, { "x-gyredeck-token": r.password, "x-gyredeck-broker": APP_WORD })).body),
      "bridge stderr": h.log.stderr,
      "bridge stdout": h.log.stdout,
    };
    for (const [where, text] of Object.entries(surfaces)) {
      assert.ok(!text.includes(keyA), `a's key in ${where}`);
      if (!where.startsWith("b's broker read")) assert.ok(!text.includes(keyB), `b's key in ${where}`);
    }
    assert.ok(surfaces["b's broker read"].includes(keyB), "premise: the broker's read for b carries b's key");
    // Over TCP, with the shared password and no broker word, there is nothing to take a key from.
    for (const headers of [r.pw, { "x-gyredeck-token": h.token }, { "x-gyredeck-token": r.password, "x-gyredeck-broker": "e4".repeat(32) }]) {
      const answer = await h.raw(`/mail/inbox?as=member-b`, headers);
      assert.equal(answer.status, 403, answer.text);
      assert.ok(!answer.text.includes(keyB), "no key over an unvouched read");
    }
  } finally {
    await h.stop();
  }
});

test("C2: an unconfirmed member is handed no key, even by the broker", async () => {
  const h = await startBridge();
  try {
    const { room: code } = (await h.call("POST", "/sync/rooms", { conversationId: "member-a" })).body;
    await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: "member-c" });
    const answer = await h.call("GET", `/mail/inbox?as=member-c`);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.memberKey, undefined);
  } finally {
    await h.stop();
  }
});

test("C5: a key dies with its membership; coming back mints a new one", async () => {
  const h = await startBridge();
  try {
    const r = await twoMembers(h);
    const old = await r.keyOf("member-b");
    assert.equal((await h.call("DELETE", `/sync/rooms/${r.code}/members/member-b`)).status, 200, "premise: b is taken out");
    await h.call("POST", `/sync/rooms/${r.code}/members`, { conversationId: "member-b" });
    const again = await h.call("POST", `/sync/rooms/${r.code}/confirm`, { conversationId: "member-b", password: r.password }, { "content-type": "application/json" });
    assert.equal(again.status, 200, "premise: b is back");
    const fresh = await r.keyOf("member-b");
    assert.match(fresh, KEY);
    assert.notEqual(fresh, old, "a new membership, a new key");
    assert.equal((await h.raw(`/mail/inbox?as=member-b`, { ...r.pw, "x-gyredeck-member": old })).status, 403, "the old key reads nothing");
    assert.equal((await watch(h, r.code, "member-b", { ...r.pw, "x-gyredeck-member": old })).status, 403, "nor watches");
    assert.equal((await h.raw(`/mail/inbox?as=member-b`, { ...r.pw, "x-gyredeck-member": fresh })).status, 200, "the new one does");
    const repeat = await h.call("POST", `/sync/rooms/${r.code}/confirm`, { conversationId: "member-b", password: r.password }, { "content-type": "application/json" });
    assert.equal(repeat.status, 200);
    assert.equal(await r.keyOf("member-b"), fresh, "a repeated paste does not re-mint: a running watch keeps working");
  } finally {
    await h.stop();
  }
});

test("C6: the relay still reads by the app's word alone, and a member's key never stands in for it", async () => {
  const h = await startBridge();
  try {
    const r = await twoMembers(h);
    const relayId = "discord-relay-1";
    assert.equal((await h.call("POST", `/sync/rooms/${r.code}/members`, { conversationId: relayId, relay: "discord" })).status, 200, "premise: the relay joined");
    const keyA = await r.keyOf("member-a");
    assert.equal((await watch(h, r.code, relayId, h.app)).status, 200, "the app reads as its relay");
    for (const [why, headers] of [
      ["password", r.pw],
      ["password and a member's key", { ...r.pw, "x-gyredeck-member": keyA }],
      ["machine token without the word", { "x-gyredeck-token": h.token }],
      ["the word without the machine token", { "x-gyredeck-token": r.password, "x-gyredeck-broker": APP_WORD }],
    ]) {
      const refused = await watch(h, r.code, relayId, headers);
      assert.equal(refused.status, 403, why);
      assert.match(refused.text, /app_only/, why);
    }
  } finally {
    await h.stop();
  }
});
