import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ROOM_RULES_VERSION, roomRules } from "../adapters/bridge/gyredeck-bridge.mjs";

/**
 * The Discord relay member (#199): the app puts it in a room it founded, it is labelled
 * "Discord", it is handed the whole room on its watch and it can never post. The rules
 * tell every agent not to address it.
 */
const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CONFIG_DIR = [".config", "gyredeck"];
const APP_WORD = "c7".repeat(32);

const freePort = async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
};

const startBridge = async () => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-discord-"));
  await mkdir(join(home, ...CONFIG_DIR), { recursive: true });
  const port = await freePort();
  await writeFile(join(home, ...CONFIG_DIR, "gyredeck.config.json"), JSON.stringify({ host: "127.0.0.1", port }));
  let stderr = "";
  const bridge = spawn(
    process.execPath,
    ["adapters/bridge/gyredeck-bridge.mjs", "--port", String(port), "--host", "127.0.0.1", "--parent-stdio", "--broker-handshake"],
    { cwd: repoRoot, env: { ...process.env, HOME: home, GYREDECK_NO_AGENT_SPAWN: "1" }, stdio: ["pipe", "pipe", "pipe"] },
  );
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
  const stop = async () => {
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  return { base, call, stop, token };
};

/** Read a room's watch until a frame with `seq` arrives, or fail after `ms`. */
/** `credential` is a room password, or the headers the app reads with. */
/** `frames` holds the mail; `frames.events` every data frame in order, with its event name. */
// A member's own read key (#274), as the broker's collect hands it: the app's word, no collect.
const keyOf = async (h, as) => (await h.call("GET", `/mail/inbox?as=${as}`)).body.memberKey;
const asMember = async (h, as, password) => ({ "x-gyredeck-token": password, "x-gyredeck-member": await keyOf(h, as) });

const watchUntil = async (base, code, as, credential, done, onOpen = async () => {}, ms = 3000, since = "0") => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const frames = [];
  frames.events = [];
  let event = "message";
  try {
    const response = await fetch(`${base}/mail/${code}/events?as=${as}&since=${since}`, {
      headers: typeof credential === "string" ? { "x-gyredeck-token": credential } : credential,
      signal: controller.signal,
    });
    assert.equal(response.status, 200, "the relay may watch the room");
    await onOpen();
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (const line of buffer.split("\n").slice(0, -1)) {
        if (line.startsWith("event: ")) event = line.slice(7);
        if (line.startsWith("data: ")) {
          const data = JSON.parse(line.slice(6));
          frames.events.push({ event, data });
          if (event === "mail" || event === "message") frames.push(data);
        }
        if (line === "") event = "message";
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
      if (done(frames)) break;
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return frames;
};

test("an ordinary member's watch is as it was: resume from its stream cursor, a push is not a read", async () => {
  const h = await startBridge();
  try {
    const { room: code, password } = (await h.call("POST", "/sync/rooms", { conversationId: "founder-1" })).body;
    await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: "peer-a" });
    await h.call("POST", `/sync/rooms/${code}/confirm`, { conversationId: "peer-a", password }, { "content-type": "application/json" });
    const post = (text) => fetch(`${h.base}/mail/${code}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gyredeck-token": password },
      body: JSON.stringify({ from: "founder-1", to: "peer-a", kind: "tell", text }),
    }).then((response) => response.json());
    let sent = null;
    const first = await watchUntil(h.base, code, "peer-a", await asMember(h, "peer-a", password), (seen) => sent && seen.some((f) => f.seq === sent.seq), async () => { sent = await post("hello a"); }, 3000, "resume");
    assert.ok(first.some((frame) => frame.seq === sent.seq), "premise: the push arrived");
    const pending = (await h.call("GET", `/sync/rooms?as=peer-a`)).body.members.find((m) => m.conversationId === "peer-a").pending;
    assert.ok(pending >= 1, "a push does not move an ordinary member's read position");
    const reopened = await watchUntil(h.base, code, "peer-a", await asMember(h, "peer-a", password), () => false, async () => {}, 300, "resume");
    assert.deepEqual(reopened.filter((frame) => frame.seq === sent.seq), [], "resume starts after what was pushed");
  } finally {
    await h.stop();
  }
});

test("rules from v13 tell every agent the Discord member only relays and never answers", () => {
  assert.ok(ROOM_RULES_VERSION >= 13);
  const rules = roomRules("http://127.0.0.1:47621");
  assert.match(rules, new RegExp(`^# Gyredeck room rules — v${ROOM_RULES_VERSION}\n`));
  assert.ok(
    rules.includes("A member labelled `Discord` only relays the room to the owner's Discord. It never answers and cannot post, so do not address it, ask it anything, or wait on it."),
    rules,
  );
});

test("the app's relay joins as Discord, hears the whole room, moves its read position and cannot post", async () => {
  const h = await startBridge();
  try {
    const created = await h.call("POST", "/sync/rooms", { conversationId: "founder-1" });
    assert.equal(created.status, 201);
    const { room: code, password } = created.body;
    const relayId = `discord-${code}`;

    for (const peer of ["peer-a", "peer-b"]) {
      assert.equal((await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: peer })).status, 200);
      assert.equal((await h.call("POST", `/sync/rooms/${code}/confirm`, { conversationId: peer, password }, { "content-type": "application/json" })).status, 200);
    }

    // Only the app says a member is a relay: without its word the join is refused.
    const unvouched = await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: relayId, relay: "discord" }, { "content-type": "application/json", "x-gyredeck-token": h.token });
    assert.equal(unvouched.status, 401);
    assert.equal((await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: relayId, relay: "slack" })).status, 400);

    const joined = await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: relayId, relay: "discord" });
    assert.equal(joined.status, 200);
    const relay = joined.body.members.find((member) => member.conversationId === relayId);
    assert.equal(relay.provider, "Discord");
    assert.equal(relay.confirmed, true, "Connect in the app is the consent; no password step");
    // The room instance, so a code reused after a restart is a new post.
    assert.equal(typeof joined.body.createdAt, "number");
    assert.equal(joined.body.createdAt, created.body.createdAt);
    // A second Connect is the same answer; an agent naming the relay as a plain member is not.
    assert.equal((await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: relayId, relay: "discord" })).status, 200);
    assert.equal((await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: relayId })).status, 409);

    // A message between two other members: an ordinary member's watch would never carry it.
    const post = (from, body) => fetch(`${h.base}/mail/${code}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gyredeck-token": password },
      body: JSON.stringify({ from, ...body }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    const between = await post("peer-a", { to: "peer-b", kind: "ask", text: "only for b" });
    assert.equal(between.status, 202, JSON.stringify(between.body));

    // Both stream paths: the replay of what came before the watch, and a live push.
    let live = null;
    const app = { "x-gyredeck-token": h.token, "x-gyredeck-broker": APP_WORD };
    const frames = await watchUntil(
      h.base, code, relayId, app,
      (seen) => live !== null && seen.some((frame) => frame.seq === live.body.seq),
      async () => {
        live = await post("peer-b", { to: "peer-a", kind: "tell", text: "live, only for a" });
        assert.equal(live.status, 202, JSON.stringify(live.body));
      },
    );
    assert.ok(frames.every((frame) => frame.seq > joined.body.seq - 1), `nothing from before the relay joined: ${JSON.stringify(frames.map((f) => [f.seq, f.text]))}`);
    const replayed = frames.find((frame) => frame.seq === between.body.seq);
    assert.ok(replayed, `the relay is replayed a message addressed to someone else: ${JSON.stringify(frames)}`);
    assert.equal(replayed.to, "peer-b");
    assert.equal(replayed.text, "only for b");
    const pushed = frames.find((frame) => frame.seq === live.body.seq);
    assert.ok(pushed, `the relay is pushed a message addressed to someone else: ${JSON.stringify(frames)}`);
    assert.equal(pushed.text, "live, only for a");

    // A frame written is not a frame read: the relay's read position — the room's trim
    // floor — is still where its open said, so nothing it was written can be trimmed yet.
    const pendingOf = async (id) => (await h.call("GET", `/sync/rooms?as=${relayId}`)).body.members.find((member) => member.conversationId === id).pending;
    assert.ok(await pendingOf(relayId) >= 2, "the writes did not move the relay's read position");

    // The connection dropped before the live frame was read: reopening from the seq before it
    // hands it over again.
    const again = await watchUntil(h.base, code, relayId, app, (seen) => seen.some((frame) => frame.seq === live.body.seq), async () => {}, 3000, String(live.body.seq - 1));
    assert.deepEqual(again.map((frame) => frame.seq), [live.body.seq], "exactly the seq after the one named");
    // And the open is the read: presented with the last seq, the position catches up.
    await watchUntil(h.base, code, relayId, app, () => true, async () => {}, 300, String(live.body.seq));
    assert.equal(await pendingOf(relayId), 0);

    // Reading as the relay moves the room's floor, so it is the app's act alone: a member
    // holding the room's password — or the machine token, or either without the other — is
    // refused on every read path, and the relay's position does not move.
    const third = await post("peer-a", { to: "everyone", kind: "tell", text: "not yet on Discord" });
    assert.equal(third.status, 202);
    const held = await pendingOf(relayId);
    assert.equal(held, 1, "premise: one message the relay has not taken in");
    const tries = [
      [`/mail/${code}/events?as=${relayId}&since=999999`, { "x-gyredeck-token": password }],
      [`/mail/${code}/events?as=${relayId}&since=999999`, { "x-gyredeck-token": password, "x-gyredeck-broker": APP_WORD }],
      [`/mail/${code}/events?as=${relayId}&since=999999`, { "x-gyredeck-token": h.token }],
      [`/mail/${code}?as=${relayId}&since=999999&collect=1`, { "x-gyredeck-token": password }],
      [`/mail/${code}?as=${relayId}&since=0&collect=1`, { "x-gyredeck-token": h.token }],
      [`/mail/inbox?as=${relayId}&collect=1`, { "x-gyredeck-token": h.token }],
      [`/mail/wait?as=${relayId}&timeout=1`, { "x-gyredeck-token": h.token }],
    ];
    for (const [path, headers] of tries) {
      // A read that is let in streams or waits; bounded, so it fails here instead of hanging.
      const response = await fetch(`${h.base}${path}`, { headers, signal: AbortSignal.timeout(2000) }).catch((error) => ({ status: `let in (${error.name})`, text: async () => "" }));
      const body = await response.text();
      assert.equal(response.status, 403, `${path} ${JSON.stringify(Object.keys(headers))}: ${body}`);
      assert.match(body, /app_only/);
    }
    assert.equal(await pendingOf(relayId), held, "the floor did not move");

    // The app's own ACK past the room's end is clamped to what exists.
    await watchUntil(h.base, code, relayId, app, () => true, async () => {}, 300, "999999");
    assert.equal(await pendingOf(relayId), 0);
    assert.equal((await post("peer-b", { to: "everyone", kind: "tell", text: "after the clamp" })).status, 202);
    assert.equal(await pendingOf(relayId), 1, "a message after the clamped ACK is still owed to the relay");

    // It never speaks, with the password or without.
    const spoke = await post(relayId, { to: "everyone", kind: "tell", text: "hello" });
    assert.equal(spoke.status, 403);
    assert.equal(spoke.body.error, "relay_only");
  } finally {
    await h.stop();
  }
});

test("the app's ACK keeps a busy room open within one stream; nobody else may ACK", async () => {
  const h = await startBridge();
  try {
    const { room: code, password } = (await h.call("POST", "/sync/rooms", { conversationId: "founder-1" })).body;
    const relayId = `discord-${code}`;
    assert.equal((await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: relayId, relay: "discord" })).status, 200);
    // The founder takes in what the room said so far, so the relay alone holds the floor.
    await fetch(`${h.base}/mail/${code}?as=founder-1&since=0&collect=1`, { headers: { "x-gyredeck-token": password } });
    const app = { "content-type": "application/json", "x-gyredeck-token": h.token, "x-gyredeck-broker": APP_WORD };
    const ack = (seq, headers = app) => fetch(`${h.base}/mail/${code}/relay-ack`, { method: "POST", headers, body: JSON.stringify({ as: relayId, seq }) });

    // Not the room's password, not the machine token alone.
    assert.equal((await ack(1, { "content-type": "application/json", "x-gyredeck-token": password })).status, 403);
    assert.equal((await ack(1, { "content-type": "application/json", "x-gyredeck-token": h.token })).status, 403);
    // The app's own ACK past the room's end is clamped to what exists.
    const roomSeq = (await h.call("GET", `/sync/rooms?as=${relayId}`)).body.seq;
    const beyond = await ack(999999);
    assert.equal(beyond.status, 200);
    const { readSeq } = await beyond.json();
    assert.ok(readSeq <= roomSeq, `readSeq ${readSeq} is within the room's ${roomSeq}`);

    const controller = new AbortController();
    const response = await fetch(`${h.base}/mail/${code}/events?as=${relayId}&since=0`, { headers: app, signal: controller.signal });
    const seen = [];
    const reading = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          for (const line of buffer.split("\n").slice(0, -1)) if (line.startsWith("data: ") && JSON.parse(line.slice(6)).seq) seen.push(JSON.parse(line.slice(6)).seq);
          buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
        }
      } catch {}
    })();
    const statuses = new Set();
    const sent = [];
    for (let i = 0; i < 650; i += 1) {
      const posted = await fetch(`${h.base}/mail/${code}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gyredeck-token": password },
        body: JSON.stringify({ from: "founder-1", to: "everyone", kind: "tell", text: `busy ${i}` }),
      });
      statuses.add(posted.status);
      const body = await posted.json();
      if (body.seq) sent.push(body.seq);
      // Discord takes each batch at once: the app ACKs the highest seq the child posted.
      if (i % 50 === 49 && seen.length) assert.equal((await ack(Math.max(...seen))).status, 200);
    }
    controller.abort();
    await reading;
    assert.deepEqual([...statuses], [202], "more than the room's cap went through one stream with no room_full");
    assert.ok(sent.every((seq) => seen.includes(seq)), "and every one reached the relay");
  } finally {
    await h.stop();
  }
});

test("T12b: the relay's stream opens with what the room dropped and where the relay joined; a member's never does", async () => {
  const h = await startBridge();
  try {
    const { room: code, password } = (await h.call("POST", "/sync/rooms", { conversationId: "founder-1" })).body;
    await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: "peer-a" });
    await h.call("POST", `/sync/rooms/${code}/confirm`, { conversationId: "peer-a", password }, { "content-type": "application/json" });
    const relayId = `discord-${code}`;
    const joined = await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: relayId, relay: "discord" });
    assert.equal(joined.status, 200);
    const app = { "x-gyredeck-token": h.token, "x-gyredeck-broker": APP_WORD };
    const post = (text) => fetch(`${h.base}/mail/${code}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gyredeck-token": password },
      body: JSON.stringify({ from: "founder-1", to: "everyone", kind: "tell", text }),
    }).then((response) => response.json());
    const first = await post("after the join");

    const opened = await watchUntil(h.base, code, relayId, app, (seen) => seen.some((f) => f.seq === first.seq));
    const relayFrom = opened.events[0]?.data?.relayFrom;
    assert.deepEqual(opened.events[0], { event: "dropped", data: { droppedThroughSeq: 0, relayFrom } }, "the first frame, before any line");
    assert.ok(Number.isInteger(relayFrom) && relayFrom > 0 && relayFrom < first.seq, `relayFrom ${relayFrom} is where it joined`);
    assert.equal(opened.events.filter((e) => e.event === "dropped").length, 1);
    assert.ok(opened.some((f) => f.seq === first.seq), "premise: the line after it arrived");

    const member = await watchUntil(h.base, code, "peer-a", await asMember(h, "peer-a", password), (seen) => seen.some((f) => f.seq === first.seq), async () => {}, 3000, "resume");
    assert.ok(member.some((f) => f.seq === first.seq), "premise: the member's watch carried the line");
    assert.deepEqual(member.events.filter((e) => e.event === "dropped"), [], "never to a member");

    // Room notices the relay never read, past their ceiling: the oldest go, and the next open says so.
    for (let i = 0; i < 80; i += 1) {
      const peer = `churn-${i}`;
      await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: peer });
      await h.call("POST", `/sync/rooms/${code}/confirm`, { conversationId: peer, password }, { "content-type": "application/json" });
      await h.call("DELETE", `/sync/rooms/${code}/members/${peer}`);
    }
    const again = await watchUntil(h.base, code, relayId, app, () => false, async () => {}, 500, String(relayFrom));
    const [head, ...rest] = again.events;
    assert.equal(head.event, "dropped");
    assert.equal(head.data.relayFrom, relayFrom);
    assert.ok(head.data.droppedThroughSeq > relayFrom, `premise: the room dropped notices the relay was owed (${JSON.stringify(head.data)})`);
    assert.ok(rest.length > 0 && rest.every((e) => e.event === "mail" && e.data.seq > head.data.droppedThroughSeq), "every line after it is past the drop");
  } finally {
    await h.stop();
  }
});
