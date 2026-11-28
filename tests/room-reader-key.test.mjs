import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A read in a member's name takes that member's own key (#274). The room's password is
 * shared by everyone in it, so on its own it let any member — or anyone who learnt it —
 * watch or collect as another and move that member's position, and the member silently
 * missed its mail. Each test names the claim it proves, from Gyre Audit's checklist.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
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
  const raw2 = async (method, path, body, headers) => {
    const response = await fetch(`${base}${path}`, { method, headers, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  };
  const stop = async () => {
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  const confirm = (code, conversationId, password) => call("POST", `/sync/rooms/${code}/confirm`, { conversationId, password }, { "content-type": "application/json", "x-gyredeck-broker": APP_WORD });
  const joinRoom = async (code, conversationId) => {
    const minted = await call("POST", `/sync/rooms/${code}/members/${conversationId}/join-code`, {});
    assert.equal(minted.status, 200, JSON.stringify(minted.body));
    const confirmed = await confirm(code, conversationId, minted.body.code);
    return { ...confirmed, code: minted.body.code };
  };
  return { base, call, raw, raw2, stop, token, app, log, confirm, joinRoom, home };
};

const STALE_PW = "5a".repeat(16);
// The retired room password is no token at all now: a read that checks the token first answers 401.

/** A room founded by `a`, with `b` let in by a one-time join code (#332): both confirmed. */
const twoMembers = async (h) => {
  const created = (await h.call("POST", "/sync/rooms", { conversationId: "member-a" })).body;
  const { room: code } = created;
  const password = h.token;
  await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: "member-b" });
  const confirmed = await h.joinRoom(code, "member-b");
  assert.equal(confirmed.status, 200, "premise: b is let in");
  const keyOf = async (as) => (await h.call("GET", `/mail/inbox?as=${as}`, null, { "x-gyredeck-token": password, "x-gyredeck-broker": APP_WORD })).body.memberKey;
  // A member posts with its own key (#294).
  const post = async (from, to, text) => h.call("POST", `/mail/${code}`, { from, to, kind: "tell", text }, { "content-type": "application/json", "x-gyredeck-token": password, "x-gyredeck-member": await keyOf(from) });
  return { code, password, created, confirmed, keyOf, post, pw: { "x-gyredeck-token": password }, stale: { "x-gyredeck-token": STALE_PW }, stalePw: STALE_PW };
};

const pendingOf = async (h, as) => (await h.call("GET", `/sync/rooms?as=${as}`)).body.members.find((m) => m.conversationId === as).pending;

/** Open a watch, read until `ms` passes, and hand back the status and every data frame. */
const watch = async (h, code, as, headers, ms = 400, query = "") => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  let status = null;
  let text = "";
  try {
    const response = await fetch(`${h.base}/mail/${code}/events?as=${as}&since=resume${query}`, { headers, signal: controller.signal });
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
      ["the retired room password alone", r.stale],
      ["the retired room password and a's key", { ...r.stale, "x-gyredeck-member": keyA }],
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

// #403: a read of the inbox in a member's name without its key is not refused: it gets the keyless
// view, which carries none of the room's mail and moves nothing of the member's.
test("C1: every read and take in another member's name hands none of the room's mail and moves nothing", async () => {
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
        ["the retired room password alone", r.stale],
        ["the retired room password and a's key", { ...r.stale, "x-gyredeck-member": keyA }],
        ["machine token alone", { "x-gyredeck-token": h.token }],
        ["machine token and a's key", { "x-gyredeck-token": h.token, "x-gyredeck-member": keyA }],
      ]) {
        const answer = await h.raw(path, headers);
        const expected = path.startsWith(`/mail/${r.code}`) ? 403 : headers === r.stale || headers["x-gyredeck-token"] === STALE_PW ? 401 : 200;
        assert.equal(answer.status, expected, `${path}, ${why}: ${answer.text}`);
        assert.doesNotMatch(answer.text, /for b only/, `${path}, ${why}: nothing handed over`);
      }
    }
    assert.equal(await pendingOf(h, "member-b"), before, "no read without b's key moved b's position");
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
    const toAll = (await h.call("POST", `/mail/${r.code}`, { from: "member-b", to: "everyone", kind: "tell", text: "b to everyone" }, { "content-type": "application/json", "x-gyredeck-token": r.password, "x-gyredeck-member": await r.keyOf("member-b") })).body;
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

// Every route that reads or moves a position in a session's name (#274 audit, round 4). Since #403 a
// read without the member's key is not refused: it gets the keyless view, private mail only, and
// what a keyless take hands is not handed again.
test("C1 table: every read in a room member's own name without its key — inbox, wait, private mailbox and its stream — is the keyless view, and mail is handed once", async () => {
  const h = await startBridge();
  try {
    const r = await twoMembers(h);
    const keyA = await r.keyOf("member-a");
    const sent = await h.call("POST", "/mail/member-b", { from: "member-a", text: "private to b", replyTo: "member-a" }, { "content-type": "application/json", "x-gyredeck-token": h.token, "x-gyredeck-member": keyA });
    assert.ok([200, 202].includes(sent.status), `premise: posted to b's own mailbox: ${JSON.stringify(sent.body)}`);
    await r.post("member-a", "member-b", "room mail for b");
    const looks = [
      ["inbox", "/mail/inbox?as=member-b"],
      ["mailbox look", "/mail/member-b?as=member-b&since=0"],
    ];
    const credentials = [
      ["the retired room password alone", r.stale],
      ["machine token alone", { "x-gyredeck-token": h.token }],
      ["the retired room password and a's key", { ...r.stale, "x-gyredeck-member": keyA }],
      ["machine token and a's key", { "x-gyredeck-token": h.token, "x-gyredeck-member": keyA }],
    ];
    for (const [route, path] of looks) {
      for (const [why, headers] of credentials) {
        const answer = await h.raw(path, headers);
        if (headers["x-gyredeck-token"] === STALE_PW) {
          assert.equal(answer.status, 401, `${route}, ${why}: ${answer.text}`);
          assert.doesNotMatch(answer.text, /private to b/, `${route}, ${why}`);
          continue;
        }
        assert.equal(answer.status, 200, `${route}, ${why}: ${answer.text}`);
        assert.match(answer.text, /private to b/, `${route}, ${why}: private mail is the keyless view`);
        assert.doesNotMatch(answer.text, /room mail for b/, `${route}, ${why}: no room mail`);
        assert.ok(!answer.text.includes(r.code), `${route}, ${why}: the room is never named`);
        assert.equal(JSON.parse(answer.text).hint.length > 0, true, `${route}, ${why}: says why`);
      }
    }
    for (const [why, headers] of credentials) {
      const stream = await watch(h, "member-b", "member-b", headers);
      assert.equal(stream.status, headers["x-gyredeck-token"] === STALE_PW ? 401 : 200, `mailbox stream, ${why}`);
      assert.ok(!stream.text.includes(r.code), `mailbox stream, ${why}: the room is never named`);
    }
    const take = await h.raw("/mail/inbox?as=member-b&collect=1", { "x-gyredeck-token": h.token });
    assert.deepEqual(JSON.parse(take.text).messages.map((m) => m.text), ["private to b"], "a keyless take hands the private mail");
    assert.deepEqual(JSON.parse((await h.raw("/mail/wait?as=member-b&timeout=1&collect=1", { "x-gyredeck-token": h.token })).text).messages, [], "and no keyless read hands it again");
    const own = await h.call("GET", "/mail/inbox?as=member-b&collect=1", null, { "x-gyredeck-token": r.password, "x-gyredeck-broker": APP_WORD });
    assert.equal(own.status, 200);
    assert.ok(own.body.messages.some((m) => m.text === "room mail for b"), "b's own collect still gets its room mail");
    assert.ok(!own.body.messages.some((m) => m.text === "private to b"), "and is not handed again what a keyless take handed");
    const keyB = await r.keyOf("member-b");
    assert.equal((await h.raw("/mail/member-b?as=member-b&since=0", { ...r.pw, "x-gyredeck-member": keyB })).status, 200, "b's own key opens b's mailbox");
  } finally {
    await h.stop();
  }
});

test("C1 table: a room member's usage answers as any session's does (#403)", async () => {
  const h = await startBridge();
  try {
    const r = await twoMembers(h);
    const keyA = await r.keyOf("member-a");
    const answers = [];
    for (const [why, headers, as] of [
      ["machine token alone", { "x-gyredeck-token": h.token }, "member-b"],
      ["machine token and a's key", { "x-gyredeck-token": h.token, "x-gyredeck-member": keyA }, "member-b"],
      ["b's own key", { ...r.pw, "x-gyredeck-member": await r.keyOf("member-b") }, "member-b"],
      ["the broker's word", { "x-gyredeck-token": h.token, "x-gyredeck-broker": APP_WORD }, "member-b"],
      ["a session in no room", { "x-gyredeck-token": h.token }, "loner-2"],
    ]) {
      const answer = await h.raw(`/usage?as=${as}`, headers);
      assert.equal(answer.status, 200, `${why}: ${answer.text}`);
      answers.push(answer.text);
    }
    assert.equal(new Set(answers).size, 1, "one answer, in a room or not");
    assert.equal((await h.raw("/usage?as=member-b", r.stale)).status, 401, "the retired password is no token");
  } finally {
    await h.stop();
  }
});

test("C1 control: a session in no room keeps its mailbox as it was", async () => {
  const h = await startBridge();
  try {
    // A post in someone's name takes someone's own key (#403 F2), handed by the broker's read.
    const someoneKey = (await h.call("GET", "/mail/inbox?as=someone")).body.memberKey;
    const posted = await h.call("POST", "/mail/loner-1", { from: "someone", text: "for the loner", replyTo: "someone" }, { "content-type": "application/json", "x-gyredeck-token": h.token, "x-gyredeck-member": someoneKey });
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    const look = await h.raw("/mail/loner-1?since=0", { "x-gyredeck-token": h.token });
    assert.equal(look.status, 200, look.text);
    assert.match(look.text, /for the loner/);
    const inbox = await h.raw("/mail/inbox?as=loner-1&collect=1", { "x-gyredeck-token": h.token });
    assert.equal(inbox.status, 200, inbox.text);
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
    const notA = await h.raw(`/mail/inbox?as=member-a`, { ...r.pw, "x-gyredeck-member": keyB });
    assert.equal(notA.status, 200, notA.text);
    assert.equal(typeof JSON.parse(notA.text).hint, "string", "b's key reads a's mailbox keyless, as any caller would (#403)");
    assert.equal(JSON.parse(notA.text).room, null, "with no room named");
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
      "a refused read": (await h.raw(`/mail/inbox?as=member-a`, r.stale)).text,
      "a refused watch": (await watch(h, r.code, "member-a", r.stale)).text,
      "b's broker read": JSON.stringify((await h.call("GET", `/mail/inbox?as=member-b`, null, { "x-gyredeck-token": r.password, "x-gyredeck-broker": APP_WORD })).body),
      "bridge stderr": h.log.stderr,
      "bridge stdout": h.log.stdout,
    };
    for (const [where, text] of Object.entries(surfaces)) {
      assert.ok(!text.includes(keyA), `a's key in ${where}`);
      if (!where.startsWith("b's broker read")) assert.ok(!text.includes(keyB), `b's key in ${where}`);
    }
    assert.ok(surfaces["b's broker read"].includes(keyB), "premise: the broker's read for b carries b's key");
    // Over TCP, with a retired room password and no broker word, there is nothing to take a key from.
    for (const headers of [r.stale, { "x-gyredeck-token": h.token }, { "x-gyredeck-token": r.stalePw, "x-gyredeck-broker": "e4".repeat(32) }]) {
      const answer = await h.raw(`/mail/inbox?as=member-b`, headers);
      assert.equal(answer.status, headers["x-gyredeck-token"] === STALE_PW ? 401 : 200, answer.text);
      assert.ok(!answer.text.includes(keyB), "no key over an unvouched read");
    }
  } finally {
    await h.stop();
  }
});

test("C2: an unconfirmed member is handed its session's key by the broker, and the key opens nothing of the room (#403 F2)", async () => {
  const h = await startBridge();
  try {
    const { room: code } = (await h.call("POST", "/sync/rooms", { conversationId: "member-a" })).body;
    await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: "member-c" });
    const answer = await h.call("GET", `/mail/inbox?as=member-c`);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const key = answer.body.memberKey;
    assert.match(String(key), KEY);
    const withKey = { "x-gyredeck-token": h.token, "x-gyredeck-member": key };
    const watched = await watch(h, code, "member-c", withKey);
    assert.equal(watched.status, 403, watched.text);
    assert.match(watched.text, /not_confirmed/);
    const looked = await h.raw(`/mail/${code}?as=member-c&since=0`, withKey);
    assert.equal(looked.status, 403, looked.text);
    const posted = await h.call("POST", `/mail/${code}`, { from: "member-c", text: "let me in" }, { "content-type": "application/json", ...withKey });
    assert.equal(posted.status, 403, JSON.stringify(posted.body));
    assert.equal(posted.body.error, "not_confirmed");
  } finally {
    await h.stop();
  }
});

test("C5 (#403 F2 invariant 3): a session's key outlives leaving and coming back; out of the room it opens nothing of the room", async () => {
  const h = await startBridge();
  try {
    const r = await twoMembers(h);
    const old = await r.keyOf("member-b");
    assert.equal((await h.call("DELETE", `/sync/rooms/${r.code}/members/member-b`)).status, 200, "premise: b is taken out");
    const out = { ...r.pw, "x-gyredeck-member": old };
    assert.equal(await r.keyOf("member-b"), old, "leaving takes the key away from nobody");
    const keyedOut = await h.raw(`/mail/inbox?as=member-b`, out);
    assert.equal(keyedOut.status, 200, keyedOut.text);
    assert.notEqual(JSON.parse(keyedOut.text).room, r.code, "out of the room, the key reads no room");
    assert.equal((await watch(h, r.code, "member-b", out)).status, 403, "nor watches it");
    await h.call("POST", `/sync/rooms/${r.code}/members`, { conversationId: "member-b" });
    const again = await h.joinRoom(r.code, "member-b");
    assert.equal(again.status, 200, "premise: b is back");
    assert.equal(await r.keyOf("member-b"), old, "joining again mints nothing new");
    assert.equal((await watch(h, r.code, "member-b", out)).status, 200, "the key b held before joining watches after");
    assert.equal((await r.post("member-b", "member-a", "back, same key")).status, 202, "and posts");
    const spent = await h.confirm(r.code, "member-b", again.code);
    assert.equal(spent.status, 403, "a spent join code confirms nothing");
    assert.equal(await r.keyOf("member-b"), old, "a refused repeat does not re-mint: a running watch keeps working");
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
      ["the retired room password", r.stale],
      ["the retired room password and a member's key", { ...r.stale, "x-gyredeck-member": keyA }],
      ["machine token without the word", { "x-gyredeck-token": h.token }],
      ["the word without the machine token", { "x-gyredeck-token": r.stalePw, "x-gyredeck-broker": APP_WORD }],
    ]) {
      const refused = await watch(h, r.code, relayId, headers);
      assert.equal(refused.status, 403, why);
      assert.match(refused.text, /app_only/, why);
    }
  } finally {
    await h.stop();
  }
});

// #294: a post in a member's name takes that member's own key, or the broker's word, the same
// door #274 set for reads. The password and the machine token are every member's.
test("#294 C1–C5: a post in another member's name is refused without that member's key; its own key or the broker's word posts", async () => {
  const h = await startBridge();
  try {
    const r = await twoMembers(h);
    const keyA = await r.keyOf("member-a");
    const keyB = await r.keyOf("member-b");
    const send = (headers, text) => h.call("POST", `/mail/${r.code}`, { from: "member-b", to: "member-a", kind: "tell", text }, { "content-type": "application/json", ...headers });
    const said = async () => (await h.call("GET", `/mail/${r.code}?as=member-a&since=0`, null, { ...r.pw, "x-gyredeck-member": keyA })).body.messages.filter((m) => m.from === "member-b").map((m) => m.text);
    for (const [headers, who] of [[r.stale, "the retired password alone"], [{ "x-gyredeck-token": h.token }, "the machine token alone"], [{ ...r.pw, "x-gyredeck-member": keyA }, "another member's key"]]) {
      const refused = await send(headers, `as b, by ${who}`);
      assert.equal(refused.status, 403, `${who}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.error, who === "the retired password alone" ? "not_confirmed" : "not_your_key", who);
    }
    assert.deepEqual(await said(), [], "nothing was published in b's name");
    assert.equal((await send({ ...r.pw, "x-gyredeck-member": keyB }, "b, by its own key")).status, 202);
    assert.equal((await send({ ...r.pw, "x-gyredeck-broker": APP_WORD }, "b, by the broker's word")).status, 202);
    assert.deepEqual(await said(), ["b, by its own key", "b, by the broker's word"]);
  } finally {
    await h.stop();
  }
});

// #403: a read with neither the member's own key nor the broker's word gets one no-room view,
// the same for a member and a session in no room. Two ids of one length, so a byte count
// compares what was said and not whose name it was said under.
const LONER = "a4030000-0000-4000-8000-000000000001";
const JOINER = "a4030000-0000-4000-8000-000000000002";
const FOUNDER = "a4030000-0000-4000-8000-000000000003";
const keylessOnly = (h) => ({ "x-gyredeck-token": h.token });
const plant = (h, to, text) => h.call("POST", `/mail/${to}`, { from: "gyredeck-app", kind: "tell", text });
// A usage answer's age is read at the moment of each request (#398), so a second can pass between the two.
const unnamed = (text, as) => text.replaceAll(as, "<as>").replace(/"(ts|id)":"[^"]*"/g, '"$1":"<$1>"').replace(/"ageSeconds":\d+/g, '"ageSeconds":<n>');
/** The same read for the session in no room and the member: identical status, body and size. */
const twin = async (h, path, why, headers = keylessOnly(h)) => {
  const loner = await h.raw(path(LONER), headers);
  const joiner = await h.raw(path(JOINER), headers);
  assert.equal(joiner.status, loner.status, `${why}: ${path(JOINER)}`);
  assert.equal(unnamed(joiner.text, JOINER), unnamed(loner.text, LONER), `${why}: ${path(JOINER)}`);
  const aged = (text) => text.replace(/"ageSeconds":\d+/g, '"ageSeconds":0');
  assert.equal(aged(joiner.text).length, aged(loner.text).length, `${why}: size of ${path(JOINER)}`);
  return { loner, joiner };
};
const texts = (answer) => JSON.parse(answer.text).messages.map((m) => m.text);
const openRoom = async (h) => (await h.call("POST", "/sync/rooms", { conversationId: FOUNDER })).body.room;
const letIn = async (h, code, as) => {
  await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: as });
  assert.equal((await h.joinRoom(code, as)).status, 200, `premise: ${as} is let in`);
};
const letOut = async (h, code, as) => assert.equal((await h.call("DELETE", `/sync/rooms/${code}/members/${as}`)).status, 200, `premise: ${as} leaves`);
const ingestAs = (h, conversationId, sourceKind) => h.call("POST", "/ingest", {
  version: 2, id: crypto.randomUUID(), type: "turn_start", timestamp: new Date().toISOString(),
  conversationId, cwd: "/tmp/project",
  runtime: { sourcePid: 1, sourcePpid: null, sourceStartedAtMs: 1, sourceKind },
  data: { inputCount: 1 },
});

test("#403 claim 1: a keyless read answers a member as it answers a session in no room — status, body, size and wake — across join and leave", async () => {
  const h = await startBridge();
  try {
    const code = await openRoom(h);
    const looks = [(as) => `/mail/inbox?as=${as}`, (as) => `/mail/${as}?as=${as}&since=0`, (as) => `/usage?as=${as}`];
    const takes = [(as) => `/mail/inbox?as=${as}&collect=1`, (as) => `/mail/${as}?as=${as}&since=0&collect=1`];
    const compare = async (stage) => {
      for (const path of looks) {
        const { joiner } = await twin(h, path, stage);
        assert.equal(joiner.status, 200, `${stage}: ${joiner.text}`);
        assert.ok(!joiner.text.includes(code), `${stage}: the room is never named`);
      }
      for (const path of takes) await twin(h, path, `${stage}, a take`);
    };
    // A wait opened on both, then the member's mailbox gets the room's own notices: neither
    // wait returns for them, and both return for the private mail planted after.
    const waitAcross = async (stage, roomEvent) => {
      const waits = [LONER, JOINER].map((as) => {
        const state = { settled: false };
        const answer = h.raw(`/mail/wait?as=${as}&timeout=5&collect=1`, keylessOnly(h)).then((a) => { state.settled = true; return a; });
        return { state, answer };
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await roomEvent();
      // A negative claim needs a window: the notices are written synchronously by the call
      // just awaited, so a wake for them would already be under way.
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.deepEqual(waits.map((w) => w.state.settled), [false, false], `${stage}: no keyless wait woke for the room's notices`);
      for (const as of [LONER, JOINER]) await plant(h, as, `wakes, ${stage}`);
      const [loner, joiner] = await Promise.all(waits.map((w) => w.answer));
      assert.deepEqual(texts(joiner), [`wakes, ${stage}`], `${stage}: the member woke for its private mail`);
      assert.equal(unnamed(joiner.text, JOINER), unnamed(loner.text, LONER), `${stage}: the same wake`);
      assert.equal(joiner.text.length, loner.text.length, `${stage}: the same size`);
    };

    for (const as of [LONER, JOINER]) await plant(h, as, "before join");
    await compare("before join");
    await waitAcross("on joining", () => letIn(h, code, JOINER));
    const own = await h.call("GET", `/mail/inbox?as=${JOINER}`);
    assert.ok(JSON.stringify(own.body).includes(code), "premise: the member's own read names its room and carries its notices");
    for (const as of [LONER, JOINER]) await plant(h, as, "as a member");
    await compare("as a member");
    await waitAcross("on leaving", () => letOut(h, code, JOINER));
    const parted = await h.call("GET", `/mail/inbox?as=${JOINER}`);
    assert.ok(parted.body.messages.length > 0, "premise: leaving wrote a notice into the mailbox");
    for (const as of [LONER, JOINER]) await plant(h, as, "after leaving");
    await compare("after leaving");
  } finally {
    await h.stop();
  }
});

test("#403 claim 2: no keyless read or push moves a member's own cursor, in its mailbox or its room", async () => {
  const h = await startBridge();
  try {
    const code = await openRoom(h);
    await letIn(h, code, JOINER);
    const founderKey = (await h.call("GET", `/mail/inbox?as=${FOUNDER}`)).body.memberKey;
    const roomMail = await h.call("POST", `/mail/${code}`, { from: FOUNDER, to: JOINER, kind: "tell", text: "room mail" }, { "content-type": "application/json", "x-gyredeck-token": h.token, "x-gyredeck-member": founderKey });
    assert.equal(roomMail.status, 202, JSON.stringify(roomMail.body));
    const cursor = async () => (await h.call("GET", "/mail")).body.rooms.find((room) => room.room === JOINER).readSeq;
    const before = { mailbox: await cursor(), room: await pendingOf(h, JOINER) };
    assert.ok(before.room > 0, "premise: room mail is waiting for the member");

    await plant(h, JOINER, "p1");
    assert.deepEqual(texts(await h.raw(`/mail/inbox?as=${JOINER}&collect=1`, keylessOnly(h))), ["p1"]);
    await plant(h, JOINER, "p2");
    assert.deepEqual(texts(await h.raw(`/mail/${JOINER}?as=${JOINER}&since=0&collect=1`, keylessOnly(h))), ["p2"]);
    await plant(h, JOINER, "p3");
    assert.deepEqual(texts(await h.raw(`/mail/wait?as=${JOINER}&timeout=2&collect=1`, keylessOnly(h))), ["p3"]);
    const pushed = watch(h, JOINER, JOINER, keylessOnly(h), 800);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await plant(h, JOINER, "p4");
    assert.deepEqual((await pushed).frames.map((frame) => frame.text), ["p4"], "premise: the keyless stream carried it");

    assert.equal(await cursor(), before.mailbox, "the mailbox cursor did not move");
    assert.equal(await pendingOf(h, JOINER), before.room, "nor the member's place in its room");
    const ownTake = await h.call("GET", `/mail/inbox?as=${JOINER}&collect=1`);
    const got = ownTake.body.messages.map((m) => m.text);
    assert.ok(got.includes("room mail"), "the member's own read still gets its room mail");
    assert.ok(ownTake.body.messages.some((m) => m.room === JOINER), "and its room's notices in its mailbox");
    assert.deepEqual(got.filter((text) => /^p\d$/.test(text)), [], "and none of what the keyless reads handed");
  } finally {
    await h.stop();
  }
});

test("#403 claim 3: private mail is handed once, whichever read takes it, across join and leave, for a member and a session in no room", async () => {
  const h = await startBridge();
  try {
    const code = await openRoom(h);
    const broker = { "x-gyredeck-token": h.token, "x-gyredeck-broker": APP_WORD };
    const privateOf = (answer) => texts(answer).filter((text) => text.startsWith("h-"));
    for (const as of [LONER, JOINER]) {
      const keyless = (path) => h.raw(path, keylessOnly(h));
      const keyed = () => h.raw(`/mail/inbox?as=${as}&collect=1`, broker);
      await plant(h, as, "h-a");
      assert.deepEqual(privateOf(await keyless(`/mail/inbox?as=${as}&collect=1`)), ["h-a"], `${as}: a keyless take hands it`);
      assert.deepEqual(privateOf(await keyless(`/mail/${as}?as=${as}&since=0&collect=1`)), [], `${as}: and no keyless read hands it again`);
      assert.deepEqual(privateOf(await h.raw(`/mail/${as}?as=${as}&since=0`, broker)), [], `${as}: nor does the broker's look at the mailbox show it`);
      if (as === JOINER) await letIn(h, code, as);
      assert.deepEqual(privateOf(await keyed()), [], `${as}: the keyed read does not hand it again`);
      await plant(h, as, "h-b");
      assert.deepEqual(privateOf(await keyed()), ["h-b"], `${as}: the keyed read hands its own`);
      assert.deepEqual(privateOf(await keyless(`/mail/inbox?as=${as}&collect=1`)), [], `${as}: and the keyless read does not again`);
      await plant(h, as, "h-c");
      assert.deepEqual(privateOf(await keyless(`/mail/${as}?as=${as}&since=0&collect=1`)), ["h-c"], `${as}: a keyless mailbox take hands it`);
      if (as === JOINER) await letOut(h, code, as);
      assert.deepEqual(privateOf(await keyed()), [], `${as}: after leaving, still not again`);
      await plant(h, as, "h-d");
      assert.deepEqual(privateOf(await keyless(`/mail/inbox?as=${as}`)), ["h-d"], `${as}: a keyless look hands nothing`);
      assert.deepEqual(privateOf(await keyed()), ["h-d"], `${as}: so the keyed read takes it`);
      assert.deepEqual(privateOf(await keyless(`/mail/inbox?as=${as}&collect=1`)), [], `${as}: once`);
    }
  } finally {
    await h.stop();
  }
});

test("#403 audit r1: a member that only reads keyless keeps receiving private mail past the room's size, and its room notice stays for the keyed read", async () => {
  const h = await startBridge();
  try {
    const code = await openRoom(h);
    await letIn(h, code, JOINER);
    for (let i = 0; i < 520; i += 1) {
      const sent = await plant(h, JOINER, `r${i}`);
      assert.equal(sent.status, 202, `send ${i}: ${JSON.stringify(sent.body)}`);
      assert.deepEqual(texts(await h.raw(`/mail/inbox?as=${JOINER}&collect=1`, keylessOnly(h))), [`r${i}`], `take ${i}`);
    }
    const mailbox = (await h.call("GET", "/mail")).body.rooms.find((room) => room.room === JOINER);
    assert.ok(mailbox.buffered <= 500, `the mailbox keeps to its size: ${mailbox.buffered} held`);
    const ownTake = await h.call("GET", `/mail/inbox?as=${JOINER}&collect=1`);
    assert.ok(ownTake.body.messages.some((m) => m.room === JOINER), "the room's notice is still there for the member's own read");
    assert.deepEqual(ownTake.body.messages.map((m) => m.text).filter((text) => /^r\d+$/.test(text)), [], "and none of the mail the keyless reads handed");
  } finally {
    await h.stop();
  }
});

test("#403 audit r2: a wake-only watch wakes and hands nothing, so the read after it takes the mail, keyless or keyed", async () => {
  const h = await startBridge();
  try {
    const broker = { "x-gyredeck-token": h.token, "x-gyredeck-broker": APP_WORD };
    const reads = [
      ["keyless", keylessOnly(h)],
      ["keyed", broker],
    ];
    for (const [how, headers] of reads) {
      for (const as of [LONER, JOINER]) {
        const woken = watch(h, as, as, headers, 2000, "&once=1");
        await new Promise((resolve) => setTimeout(resolve, 200));
        await plant(h, as, `w-${how}`);
        const { frames } = await woken;
        assert.deepEqual(frames.map((frame) => frame.text), [`w-${how}`], `${how} ${as}: premise: the watch woke on it`);
        const taken = texts(await h.raw(`/mail/inbox?as=${as}&collect=1`, headers)).filter((text) => text.startsWith("w-"));
        assert.deepEqual(taken, [`w-${how}`], `${how} ${as}: the read after the wake takes it`);
      }
    }
  } finally {
    await h.stop();
  }
});

test("#403 claim 4: keyless notices are a session in no room's, and spend none of the session's own; usage answers 200", async () => {
  const h = await startBridge();
  try {
    for (const as of [LONER, JOINER]) await ingestAs(h, as, "claudeCodeHook");
    await h.call("POST", "/usage", {
      providerId: "claude", displayName: "Claude Code", fetchedAt: new Date().toISOString(),
      lines: [{ type: "progress", label: "Session", used: 40, limit: 100, resetsAt: null }],
    });
    const code = await openRoom(h);
    await letIn(h, code, JOINER);
    const take = (as) => `/mail/inbox?as=${as}&collect=1`;
    const first = await twin(h, take, "the first keyless take");
    assert.match(JSON.parse(first.joiner.text).usageNotice ?? "", /^USAGE: ask Gyredeck/, "the member is told usage as a session in no room is");
    assert.match(JSON.parse(first.joiner.text).heavyNotice ?? "", /^HEAVY RUNS/);
    assert.doesNotMatch(first.joiner.text, /x-gyredeck-member: [0-9a-f]{64}/, "and handed no key");
    const second = await twin(h, take, "the second keyless take");
    assert.equal(JSON.parse(second.joiner.text).usageNotice, undefined, "told once");
    assert.equal(JSON.parse(second.joiner.text).heavyNotice, undefined, "told once");
    const usage = await twin(h, (as) => `/usage?as=${as}`, "usage");
    assert.equal(usage.joiner.status, 200);

    const own = async (as) => (await h.call("GET", take(as))).body;
    const loner = await own(LONER);
    assert.match(loner.usageNotice ?? "", /^USAGE: ask Gyredeck/, "the session's own read is still told usage");
    assert.match(loner.heavyNotice ?? "", /^HEAVY RUNS/, "and the heavy runs");
    const joiner = await own(JOINER);
    assert.match(joiner.heavyNotice ?? "", /^HEAVY RUNS/, "the member's own read still carries the line its confirmation owes");
    assert.equal(joiner.usageNotice, undefined, "a member's usage is the room's to tell, as before");
  } finally {
    await h.stop();
  }
});

test("#403 claim 5: a broker-bound or Codex session is refused its mailbox the same way, member or not", async () => {
  const h = await startBridge();
  try {
    const code = await openRoom(h);
    await letIn(h, code, JOINER);
    for (const as of [LONER, JOINER]) {
      const bound = await h.call("POST", "/broker/bound", { conversationId: as }, { "content-type": "application/json", "x-gyredeck-broker": APP_WORD });
      assert.equal(bound.status, 200, JSON.stringify(bound.body));
    }
    const reads = [(as) => `/mail/inbox?as=${as}`, (as) => `/mail/wait?as=${as}&timeout=1&collect=1`, (as) => `/mail/${as}?as=${as}&since=0`];
    for (const path of reads) {
      const { joiner } = await twin(h, path, "broker-bound");
      assert.equal(JSON.parse(joiner.text).error, "broker_required", joiner.text);
    }
    const CODEX_LONER = "a4030000-0000-4000-8000-0000000000c1";
    const CODEX_MEMBER = "a4030000-0000-4000-8000-0000000000c2";
    for (const as of [CODEX_LONER, CODEX_MEMBER]) await ingestAs(h, as, "codexCliHook");
    await letIn(h, code, CODEX_MEMBER);
    for (const path of reads) {
      const loner = await h.raw(path(CODEX_LONER), keylessOnly(h));
      const member = await h.raw(path(CODEX_MEMBER), keylessOnly(h));
      assert.equal(member.status, loner.status, path(CODEX_MEMBER));
      assert.equal(member.text.replaceAll(CODEX_MEMBER, "<as>"), loner.text.replaceAll(CODEX_LONER, "<as>"), path(CODEX_MEMBER));
      assert.equal(JSON.parse(member.text).error, "codex_mailbox_closed", member.text);
    }
  } finally {
    await h.stop();
  }
});

test("#403 F2 groundwork: every delivery the broker vouches for carries the member's own key, not only the first", async () => {
  const h = await startBridge();
  try {
    const code = await openRoom(h);
    await letIn(h, code, JOINER);
    const keys = [];
    for (let delivery = 1; delivery <= 3; delivery += 1) {
      await plant(h, JOINER, `delivery ${delivery}`);
      const answer = await h.call("GET", `/mail/inbox?as=${JOINER}&collect=1`);
      assert.ok(answer.body.messages.some((m) => m.text === `delivery ${delivery}`), `premise: delivery ${delivery} was handed`);
      keys.push(answer.body.memberKey);
    }
    assert.ok(keys.every((key) => KEY.test(key ?? "")), `a key on every delivery: ${JSON.stringify(keys)}`);
    assert.equal(new Set(keys).size, 1, "and the same key each time, so a session that lost its context still replies");
  } finally {
    await h.stop();
  }
});

// #403 F2 (owner, option A): every session has its own key from its first delivery, in a room
// or not, and a post in any session's name takes that key or the broker's word.
const keyOfSession = async (h, as) => {
  const key = (await h.call("GET", `/mail/inbox?as=${as}`)).body.memberKey;
  assert.match(String(key), KEY, `premise: the broker's read hands ${as} its key`);
  return key;
};
const postAs = (h, to, from, text, headers) =>
  h.raw2("POST", `/mail/${to}`, { from, to: "everyone", kind: "tell", text }, { "content-type": "application/json", ...headers });
const landed = async (h, mailbox) => (await h.call("GET", `/mail/${mailbox}?since=0`)).body.messages.map((m) => `${m.from}:${m.text}`);

test("#403 F2 invariant 1: a keyless post in a session's name answers a member as it answers a session in no room — status, error, body and size — across join and leave", async () => {
  const h = await startBridge();
  try {
    const code = await openRoom(h);
    const founderKey = await keyOfSession(h, FOUNDER);
    // Both hold a key already, so the only difference left is membership.
    const keys = { [LONER]: await keyOfSession(h, LONER), [JOINER]: await keyOfSession(h, JOINER) };
    const keyless = [
      ["the machine token alone", { "x-gyredeck-token": h.token }],
      ["the machine token and another session's key", { "x-gyredeck-token": h.token, "x-gyredeck-member": founderKey }],
      ["the machine token and a key-shaped guess", { "x-gyredeck-token": h.token, "x-gyredeck-member": "0".repeat(64) }],
      ["the machine token and a stranger's broker word", { "x-gyredeck-token": h.token, "x-gyredeck-broker": "e4".repeat(32) }],
    ];
    const compare = async (stage) => {
      for (const target of [FOUNDER, code]) {
        for (const [why, headers] of keyless) {
          const loner = await postAs(h, target, LONER, `as the loner, ${stage}, ${why}`, headers);
          const joiner = await postAs(h, target, JOINER, `as the joiner, ${stage}, ${why}`, headers);
          const at = `${stage}, to ${target === code ? "the room" : "a mailbox"}, ${why}`;
          assert.equal(loner.status, 403, `${at}: ${loner.text}`);
          assert.equal(JSON.parse(loner.text).error, "not_your_key", at);
          assert.equal(joiner.status, loner.status, at);
          assert.equal(unnamed(joiner.text, JOINER), unnamed(loner.text, LONER), at);
          assert.equal(joiner.text.length, loner.text.length, `${at}: size`);
          for (const key of [founderKey, ...Object.values(keys)]) assert.ok(!joiner.text.includes(key) && !loner.text.includes(key), `${at}: no key in the answer`);
        }
      }
    };
    await compare("before join");
    await letIn(h, code, JOINER);
    await compare("as a member");
    await letOut(h, code, JOINER);
    await compare("after leaving");
    const published = [...(await landed(h, FOUNDER)), ...(await h.call("GET", `/mail/${code}?as=${FOUNDER}&since=0`, null, { "x-gyredeck-token": h.token, "x-gyredeck-member": founderKey })).body.messages.map((m) => `${m.from}:${m.text}`)];
    assert.deepEqual(published.filter((line) => line.startsWith(`${LONER}:`) || line.startsWith(`${JOINER}:`)), [], "nothing was published in either name");
  } finally {
    await h.stop();
  }
});

test("#403 F2 invariant 2: a session's own key, or the broker's word, posts in its name — member or not", async () => {
  const h = await startBridge();
  try {
    const code = await openRoom(h);
    await letIn(h, code, JOINER);
    const keys = { [LONER]: await keyOfSession(h, LONER), [JOINER]: await keyOfSession(h, JOINER) };
    for (const as of [LONER, JOINER]) {
      const own = await postAs(h, FOUNDER, as, `${as} by its own key`, { "x-gyredeck-token": h.token, "x-gyredeck-member": keys[as] });
      assert.equal(own.status, 202, own.text);
      const broker = await postAs(h, FOUNDER, as, `${as} by the broker's word`, { "x-gyredeck-token": h.token, "x-gyredeck-broker": APP_WORD });
      assert.equal(broker.status, 202, broker.text);
      const other = as === LONER ? JOINER : LONER;
      const crossed = await postAs(h, FOUNDER, as, `${as} by ${other}'s key`, { "x-gyredeck-token": h.token, "x-gyredeck-member": keys[other] });
      assert.equal(crossed.status, 403, `another session's key never posts: ${crossed.text}`);
    }
    assert.deepEqual((await landed(h, FOUNDER)).filter((line) => !line.startsWith("gyredeck-room:")), [
      `${LONER}:${LONER} by its own key`, `${LONER}:${LONER} by the broker's word`,
      `${JOINER}:${JOINER} by its own key`, `${JOINER}:${JOINER} by the broker's word`,
    ]);
    assert.equal((await postAs(h, code, JOINER, "in the room by its own key", { "x-gyredeck-member": keys[JOINER] })).status, 202, "the member's key posts in its room too");
  } finally {
    await h.stop();
  }
});

test("#403 audit M2: a session in no room loses its key to a new process of itself; a late report from the old one changes nothing", async () => {
  const h = await startBridge();
  try {
    const bound = (generation) => h.call("POST", "/broker/bound", { conversationId: LONER, generation });
    const mail = (text, key) => postAs(h, FOUNDER, LONER, text, { "x-gyredeck-token": h.token, "x-gyredeck-member": key });
    assert.equal((await bound(1)).status, 200);
    const old = await keyOfSession(h, LONER);
    assert.equal((await mail("first process", old)).status, 202, "premise: the first process's key posts");
    assert.equal((await bound(2)).status, 200);
    assert.equal((await mail("old key after a new process", old)).status, 403, "the old process's key dies");
    const fresh = await keyOfSession(h, LONER);
    assert.notEqual(fresh, old, "the new process is handed a new key");
    assert.equal((await mail("new process", fresh)).status, 202);
    assert.equal((await bound(1)).status, 200);
    assert.equal((await mail("after a late report from the old process", fresh)).status, 202, "a late, lower generation kills nothing");
    assert.equal((await mail("old key after the late report", old)).status, 403, "nor brings the old key back");
  } finally {
    await h.stop();
  }
});

test("#403 F2 invariant 3: a key handed before joining still posts and watches after joining, and posts after leaving", async () => {
  const h = await startBridge();
  try {
    const code = await openRoom(h);
    const before = await keyOfSession(h, LONER);
    const withKey = { "x-gyredeck-token": h.token, "x-gyredeck-member": before };
    assert.equal((await postAs(h, FOUNDER, LONER, "before joining", withKey)).status, 202);
    await letIn(h, code, LONER);
    assert.equal(await keyOfSession(h, LONER), before, "joining mints nothing new");
    assert.equal((await watch(h, code, LONER, withKey)).status, 200, "the key from before joining watches the room");
    assert.equal((await postAs(h, code, LONER, "in the room", { "x-gyredeck-member": before })).status, 202, "and posts in it");
    assert.equal((await postAs(h, FOUNDER, LONER, "as a member", withKey)).status, 202, "and still posts to a mailbox");
    await letOut(h, code, LONER);
    assert.equal(await keyOfSession(h, LONER), before, "leaving takes nothing away");
    assert.equal((await postAs(h, FOUNDER, LONER, "after leaving", withKey)).status, 202);
    assert.deepEqual((await landed(h, FOUNDER)).filter((line) => line.startsWith(`${LONER}:`)), [`${LONER}:before joining`, `${LONER}:as a member`, `${LONER}:after leaving`]);
  } finally {
    await h.stop();
  }
});

test("#403 F2 invariant 6: nothing a keyless reader can see carries a session's key, member or not", async () => {
  const h = await startBridge();
  try {
    const code = await openRoom(h);
    await letIn(h, code, JOINER);
    const keys = [await keyOfSession(h, LONER), await keyOfSession(h, JOINER), await keyOfSession(h, FOUNDER)];
    for (const as of [LONER, JOINER]) await plant(h, as, "to be read keyless");
    const surfaces = {};
    for (const as of [LONER, JOINER]) {
      for (const path of [`/mail/inbox?as=${as}`, `/mail/inbox?as=${as}&collect=1`, `/mail/wait?as=${as}&timeout=1`, `/mail/${as}?as=${as}&since=0`, `/usage?as=${as}`, `/sync/rooms?as=${as}`]) {
        surfaces[`${path} keyless`] = (await h.raw(path, keylessOnly(h))).text;
      }
      surfaces[`${as}'s keyless stream`] = (await watch(h, as, as, keylessOnly(h), 300)).text;
      surfaces[`${as}'s refused post`] = (await postAs(h, FOUNDER, as, "keyless", keylessOnly(h))).text;
    }
    surfaces["the room's keyless watch"] = (await watch(h, code, JOINER, keylessOnly(h), 300)).text;
    surfaces["the event log"] = await readFile(join(h.home, ...CONFIG_DIR, "gyredeck.events.ndjson"), "utf8").catch(() => "");
    surfaces["bridge stderr"] = h.log.stderr;
    surfaces["bridge stdout"] = h.log.stdout;
    assert.ok(surfaces[`/mail/inbox?as=${LONER} keyless`].includes("to be read keyless"), "premise: the keyless read was served");
    for (const [where, text] of Object.entries(surfaces)) {
      for (const key of keys) assert.ok(!text.includes(key), `a key in ${where}`);
    }
  } finally {
    await h.stop();
  }
});
