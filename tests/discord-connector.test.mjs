// #199: the Discord connector child, against an in-memory Discord. No network, no real token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChannelType, Collection, DiscordAPIError, DiscordjsErrorCodes } from "discord.js";
import { createConnector, RETENTION_MS } from "../adapters/discord/connector.mjs";
import { loadState, saveState } from "../adapters/discord/state.mjs";
import { createDiscordJs, FIND_PAGES_MAX } from "../adapters/discord/discord-js.mjs";
import { createFakeDiscord, fakeClock, flush, kindError } from "./discord/fake.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "../adapters/discord/gyredeck-discord.mjs");
const BUNDLE = join(here, "../adapters/discord/dist/gyredeck-discord.mjs");
const CHILD = join(here, "discord/child.mjs");
const TOKEN = "MTIz.fake-bot-token.SECRET-0123456789";
const NO_MENTIONS = { parse: [] };

function tmpState() {
  return join(mkdtempSync(join(tmpdir(), "gd-discord-")), "discord-state.json");
}

async function boot({ fake = createFakeDiscord(), clock = fakeClock(), statePath = tmpState(), forumId = "F1" } = {}) {
  const lines = [];
  const c = createConnector({ discord: fake, clock, out: (l) => lines.push(l) });
  c.handle({ t: "hello", v: 1, token: TOKEN, forumId, ownerId: null, statePath });
  await flush();
  const of = (t) => lines.map((l) => JSON.parse(l)).filter((m) => m.t === t);
  return { c, fake, clock, statePath, lines, of };
}

function message(room, seq, extra = {}) {
  return { t: "message", room, seq, sender: "Gyre", to: "everyone", kind: "tell", text: `m${seq}`, ts: 0, ...extra };
}

const texts = (fake) => fake.sent.map((s) => s.content.split("\n").at(-1));

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test("messages reach a room's post one at a time, in seq order", async () => {
  const { c, fake } = await boot();
  const held = [];
  fake.gate = async (op) => {
    if (op !== "send") return;
    const d = deferred();
    held.push(d);
    await d.promise;
  };
  c.handle({ t: "connect", room: "ROOM1", members: ["Gyre", "Codex"] , createdAt: 1 });
  await flush();
  for (const seq of [1, 2, 3]) c.handle(message("ROOM1", seq));
  await flush();
  // Premise: the first send is in flight and unresolved.
  assert.equal(held.length, 1, "only one send may be in flight for a room");
  const attempts = () => fake.log.filter((e) => e.op === "attempt").map((e) => e.content.split("\n").at(-1));
  assert.deepEqual(attempts(), ["m1"]);
  while (held.length) {
    held.shift().resolve();
    await flush();
  }
  assert.deepEqual(texts(fake), ["m1", "m2", "m3"]);
  await c.close();
});

test("a message over 2000 characters is split into ordered parts, header on the first only", async () => {
  const { c, fake, of } = await boot();
  c.handle({ t: "connect", room: "R", members: [] , createdAt: 1 });
  const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
  c.handle(message("R", 1, { text: words, to: "Codex", kind: "ask" }));
  await flush();
  const parts = fake.sent.map((s) => s.content);
  assert.ok(parts.length >= 3, `expected several parts, got ${parts.length}`);
  for (const p of parts) assert.ok(p.length <= 2000, `part of ${p.length} chars`);
  assert.equal(parts.join(""), `→ Codex · ask\n${words}`, "parts rejoin to the exact text, in order");
  assert.equal(parts.filter((p) => p.startsWith("→")).length, 1);
  assert.deepEqual(of("posted"), [{ t: "posted", room: "R", seq: 1, createdAt: 1, msgId: fake.log.filter((e) => e.op === "send").at(-1).id }]);
  await c.close();
});

test("every post the connector makes carries allowed_mentions {parse: []}", async () => {
  const { c, fake, clock } = await boot();
  c.handle({ t: "connect", room: "R", members: [] , createdAt: 1 });
  c.handle(message("R", 1, { text: "@everyone <@123> <@&456> hi" }));
  c.handle(message("R", 2, { kind: "notice", text: "@here notice" }));
  c.handle({ t: "disconnect", room: "R", reason: "closed" });
  await flush();
  await clock.advance(60_000);
  c.handle({ t: "connect", room: "R", members: [] , createdAt: 1 });
  await flush();
  assert.ok(fake.sent.length >= 4, "premise: message, notice, close line and divider were posted");
  for (const s of fake.sent) assert.deepEqual(s.allowedMentions, NO_MENTIONS);
  await c.close();
});

test("discord.js adapter passes allowed_mentions {parse: []} to webhook, post and client", async () => {
  const seen = {};
  const forum = fakeForum({ tags: [{ id: "t1", name: "open" }, { id: "t2", name: "closed" }] });
  forum.fetchWebhooks = async () => new Collection();
  forum.createWebhook = async () => ({ send: async (body) => (seen.webhook = body) });
  forum.threads = { create: async (opts) => ((seen.post = opts), { id: "T9" }) };
  const { discord, options } = await adapterWith(forum);
  await discord.createPost("F1", { name: "Room R", content: "x", appliedTags: [] });
  await discord.sendWebhook({ forumId: "F1", threadId: "T9", username: "Gyre", content: "@everyone", allowedMentions: { parse: [] } });
  assert.deepEqual(seen.webhook.allowedMentions, NO_MENTIONS);
  assert.equal(seen.webhook.threadId, "T9");
  assert.deepEqual(seen.post.message.allowedMentions, NO_MENTIONS);
  assert.deepEqual(options.allowedMentions, NO_MENTIONS);
});

test("a 429 waits retry_after and keeps the order", async () => {
  const { c, fake, clock, of } = await boot();
  c.handle({ t: "connect", room: "R", members: [] , createdAt: 1 });
  await flush();
  let limited = false;
  fake.gate = async (op, args) => {
    if (op === "send" && args.content.endsWith("m1") && !limited) {
      limited = true;
      throw kindError("rate", { retryAfter: 5000 });
    }
  };
  c.handle(message("R", 1));
  c.handle(message("R", 2));
  await flush();
  assert.ok(limited, "premise: the first send was refused with 429");
  await clock.advance(4999);
  assert.deepEqual(texts(fake), [], "nothing may go out before retry_after");
  await clock.advance(1);
  assert.deepEqual(texts(fake), ["m1", "m2"]);
  assert.equal(of("error").filter((e) => e.code === "rate_limited").length, 1);
  await c.close();
});

test("while Discord is unreachable messages queue, then flush in order", async () => {
  const { c, fake, clock, of } = await boot();
  c.handle({ t: "connect", room: "R", members: [] , createdAt: 1 });
  await flush();
  fake.emit("offline");
  for (const seq of [1, 2, 3]) c.handle(message("R", seq));
  await clock.advance(30_000);
  assert.deepEqual(texts(fake), [], "nothing is sent while offline");
  fake.emit("online");
  await flush();
  assert.deepEqual(texts(fake), ["m1", "m2", "m3"]);
  let failed = false;
  fake.gate = async (op, args) => {
    if (op === "send" && args.content.endsWith("m4") && !failed) {
      failed = true;
      throw kindError("network");
    }
  };
  c.handle(message("R", 4));
  c.handle(message("R", 5));
  await flush();
  assert.ok(failed, "premise: a send failed on the network");
  await clock.advance(1000);
  assert.deepEqual(texts(fake), ["m1", "m2", "m3", "m4", "m5"]);
  assert.ok(of("error").some((e) => e.code === "discord_down"));
  await c.close();
});

test("an item held more than 60 s is marked (delayed) on its first line", async () => {
  const { c, fake, clock } = await boot();
  c.handle({ t: "connect", room: "R", members: [] , createdAt: 1 });
  await flush();
  fake.emit("offline");
  c.handle(message("R", 1));
  c.handle(message("R", 2, { kind: "notice", text: "notice" }));
  await clock.advance(61_000);
  c.handle(message("R", 3));
  await clock.advance(59_000);
  fake.emit("online");
  await flush();
  const firstLines = fake.sent.map((s) => s.content.split("\n")[0]);
  assert.deepEqual(firstLines, ["→ everyone · tell (delayed)", "(delayed)", "→ everyone · tell"]);
  await c.close();
});

test("dedupe by (room, seq) holds across a restart through the state file", async () => {
  const statePath = tmpState();
  const fake = createFakeDiscord();
  const first = await boot({ fake, statePath });
  first.c.handle({ t: "connect", room: "R", members: [] , createdAt: 1 });
  first.c.handle(message("R", 1));
  first.c.handle(message("R", 2));
  await flush();
  await first.c.close();
  assert.deepEqual(texts(fake), ["m1", "m2"]);

  const second = await boot({ fake, statePath });
  second.c.handle({ t: "connect", room: "R", members: [] , createdAt: 1 });
  for (const seq of [1, 2, 3]) second.c.handle(message("R", seq));
  await flush();
  const after = texts(fake).slice(2).filter((t) => !t.startsWith("—"));
  assert.deepEqual(after, ["m3"], "m1 and m2 were already posted before the restart");
  // Every seq handed over is acknowledged, the two it skipped included: the app trims what it
  // holds for a restarted child only by these (#199).
  assert.deepEqual(second.of("posted").map((p) => [p.room, p.seq]), [["R", 1], ["R", 2], ["R", 3]]);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).rooms.R.lastSeq, 3);
  await second.c.close();
});

test("reconnecting the same room reuses its post: unarchive, tag open, divider", async () => {
  const { c, fake, clock, of, statePath } = await boot();
  c.handle({ t: "connect", room: "R", members: ["Gyre"] , createdAt: 1 });
  c.handle(message("R", 1));
  c.handle({ t: "disconnect", room: "R", reason: "closed" });
  await flush();
  const [{ threadId }] = of("connected");
  const t = fake.threads.get(threadId);
  assert.equal(t.archived, true);
  assert.deepEqual(t.appliedTags, ["tag-closed"]);
  assert.equal(fake.sent.at(-1).content, "Room closed");
  assert.equal(fake.sent.at(-1).username, "Room");
  assert.ok(JSON.parse(readFileSync(statePath, "utf8")).rooms.R.closedAt);
  c.handle(message("R", 2));
  assert.equal(of("error").at(-1).code, "room_unknown", "a closed room takes no messages");

  await clock.advance(2 * 3_600_000);
  c.handle({ t: "connect", room: "R", members: ["Gyre"] , createdAt: 1 });
  await flush();
  assert.equal(fake.log.filter((e) => e.op === "createPost").length, 1, "no second post");
  assert.deepEqual(of("connected").at(-1), { t: "connected", room: "R", threadId, reopened: true });
  assert.equal(t.archived, false);
  assert.deepEqual(t.appliedTags, ["tag-open"]);
  assert.equal(fake.sent.at(-1).content, "— Reconnected (away 2 h) —");
  assert.equal(fake.sent.at(-1).threadId, threadId);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).rooms.R.closedAt, null);
  await c.close();
});

test("a connect with a different createdAt is a new room: new post, fresh seqs, old post left to its 30-day delete", async () => {
  const { c, fake, clock, of, statePath } = await boot();
  c.handle({ t: "connect", room: "R", members: [], createdAt: 1000 });
  c.handle(message("R", 1, { text: "old one" }));
  c.handle(message("R", 2, { text: "old two" }));
  await flush();
  const oldThread = of("connected")[0].threadId;
  c.handle({ t: "connect", room: "R", members: [], createdAt: 2000 });
  c.handle(message("R", 1, { text: "new one" }));
  await flush();
  assert.equal(fake.log.filter((e) => e.op === "createPost").length, 2, "a second post for the new room");
  const latest = of("connected").at(-1);
  assert.equal(latest.reopened, false);
  assert.notEqual(latest.threadId, oldThread);
  assert.equal(fake.sent.at(-1).threadId, latest.threadId);
  assert.equal(fake.sent.at(-1).content.split("\n").at(-1), "new one", "seq 1 of the new room is not deduped");
  const rooms = JSON.parse(readFileSync(statePath, "utf8")).rooms;
  assert.equal(rooms.R.createdAt, 2000);
  assert.equal(rooms.R.lastSeq, 1);
  assert.equal(rooms["R@1000"].threadId, oldThread);
  assert.ok(rooms["R@1000"].closedAt, "the old post is dated for deletion");
  await clock.advance(RETENTION_MS + 24 * 3_600_000);
  const deleted = fake.log.filter((e) => e.op === "deleteThread").map((e) => e.id);
  assert.deepEqual(deleted, [oldThread]);
  assert.ok(fake.threads.has(latest.threadId));
  await c.close();
});

test("the same createdAt reopens the same post; a connect without one is refused", async () => {
  const { c, fake, of } = await boot();
  c.handle({ t: "connect", room: "R", members: [], createdAt: 1000 });
  c.handle(message("R", 1));
  c.handle({ t: "disconnect", room: "R", reason: "disconnected" });
  c.handle({ t: "connect", room: "R", members: [], createdAt: 1000 });
  c.handle(message("R", 1));
  c.handle(message("R", 2));
  await flush();
  assert.equal(fake.log.filter((e) => e.op === "createPost").length, 1);
  assert.deepEqual(of("connected").map((m) => m.reopened), [false, true]);
  assert.deepEqual(texts(fake).filter((t) => /^m\d$/.test(t)), ["m1", "m2"]);
  // Without the room's instance the post it belongs in cannot be told, so nothing is done.
  c.handle({ t: "connect", room: "Q", members: [] });
  await flush();
  assert.deepEqual(of("error").map((e) => [e.code, e.room]), [["room_unknown", "Q"]]);
  assert.equal(fake.log.filter((e) => e.op === "createPost").length, 1);
  await c.close();
});

test("a stored post with no instance is never taken for a named room instance", async () => {
  const statePath = tmpState();
  const fake = createFakeDiscord();
  fake.threads.set("T7", { forumId: "F1", archived: true, content: "Room R\nMembers: —\ngyredeck-room: R · -" });
  writeFileSync(statePath, JSON.stringify({ v: 1, rooms: { R: { threadId: "T7", forumId: "F1", lastSeq: 4, openedAt: 1, closedAt: Date.UTC(2026, 9, 27, 8, 0, 0), createdAt: null } } }));
  const { c } = await boot({ fake, statePath });
  // Premise: the old post is still there, inside its 30 days.
  assert.ok(fake.threads.has("T7"));
  c.handle({ t: "connect", room: "R", members: [], createdAt: 200 });
  c.handle(message("R", 1));
  await flush();
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.notEqual(state.rooms.R.threadId, "T7", "the new room got its own post");
  assert.equal(fake.sent.filter((s) => s.threadId === "T7").length, 0, "nothing of the new room went into the old post");
  await c.close();
});

test("closed posts older than 30 days are deleted at start and on the daily tick", async () => {
  const clock = fakeClock();
  const fake = createFakeDiscord();
  fake.threads.set("OLD", { archived: true });
  fake.threads.set("NEARLY", { archived: true });
  fake.threads.set("LIVE", { archived: false });
  const statePath = tmpState();
  const now = clock.now();
  writeFileSync(
    statePath,
    JSON.stringify({
      v: 1,
      rooms: {
        OLD: { threadId: "OLD", lastSeq: 4, openedAt: 0, closedAt: now - RETENTION_MS - 1 },
        NEARLY: { threadId: "NEARLY", lastSeq: 4, openedAt: 0, closedAt: now - RETENTION_MS + 3_600_000 },
        LIVE: { threadId: "LIVE", lastSeq: 4, openedAt: 0, closedAt: null },
      },
    }),
  );
  const { c } = await boot({ fake, clock, statePath });
  const deleted = () => fake.log.filter((e) => e.op === "deleteThread").map((e) => e.id);
  assert.deepEqual(deleted(), ["OLD"], "deleted at start");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(statePath, "utf8")).rooms).sort(), ["LIVE", "NEARLY"]);
  await clock.advance(24 * 3_600_000 - 1);
  assert.deepEqual(deleted(), ["OLD"], "premise: NEARLY is past 30 days now but the tick has not come");
  await clock.advance(1);
  assert.deepEqual(deleted(), ["OLD", "NEARLY"], "deleted on the daily tick");
  assert.ok(fake.threads.has("LIVE"));
  await c.close();
  assert.equal(clock.pending(), 0, "the daily timer is cleared on close");
});

test("forum tags open/closed are created when missing, and left alone when present", async () => {
  const forum = fakeForum({ tags: [{ id: "t0", name: "bug" }] });
  const { discord } = await adapterWith(forum);
  const ids = await discord.ensureTags("F1", ["open", "closed"]);
  assert.equal(forum.setCalls.length, 1);
  assert.deepEqual(forum.setCalls[0].map((t) => t.name), ["bug", "open", "closed"]);
  assert.ok(ids.open && ids.closed && ids.open !== ids.closed);
  await discord.ensureTags("F1", ["open", "closed"]);
  assert.equal(forum.setCalls.length, 1, "present tags are not re-created");
});

test("pairing accepts only the exact code, in a DM, within 10 minutes, once", async () => {
  const { c, fake, clock, of } = await boot();
  const dm = (text, userId = "U1") => fake.emit("dm", { userId, username: `user-${userId}`, text });
  c.handle({ t: "pair", code: "482913" , round: "0000000000000001" });
  dm("482913 ");
  dm(" 482913");
  dm("48291");
  dm("4829130");
  dm("code 482913");
  assert.deepEqual(of("paired"), [], "near misses are refused");
  c.handle({ t: "pair", code: "482913" , round: "0000000000000002" });
  await clock.advance(10 * 60_000 + 1);
  dm("482913");
  assert.deepEqual(of("paired"), [], "an expired code is refused");

  c.handle({ t: "pair", code: "482913" , round: "0000000000000003" });
  await clock.advance(9 * 60_000);
  dm("482913", "U7");
  assert.deepEqual(of("paired"), [{ t: "paired", ownerId: "U7", username: "user-U7", round: "0000000000000003" }]);
  dm("482913", "U8");
  assert.equal(of("paired").length, 1, "a code pairs once");
  await c.close();
});

test("paired echoes the round of the pair line that opened its window, never an earlier one", async () => {
  const { c, fake, of } = await boot();
  const dm = (text) => fake.emit("dm", { userId: "U1", username: "owner", text });
  c.handle({ t: "pair", code: "111111", round: "aaaaaaaaaaaaaaaa" });
  c.handle({ t: "pair", code: "222222", round: "bbbbbbbbbbbbbbbb" });
  dm("111111");
  assert.deepEqual(of("paired"), [], "the replaced code no longer pairs");
  dm("222222");
  assert.deepEqual(of("paired").map((p) => p.round), ["bbbbbbbbbbbbbbbb"]);
  c.handle({ t: "pair", code: "333333" });
  assert.equal(of("error").at(-1)?.code, "internal", "a pair line without its round is refused");
  await c.close();
});

test("five wrong codes in one pairing window lock it; a new pair starts afresh", async () => {
  const { c, fake, of } = await boot();
  const dm = (text) => fake.emit("dm", { userId: "U1", username: "owner", text });
  const wrong = (n) => { for (let i = 0; i < n; i++) dm(`00000${i}`); };
  c.handle({ t: "pair", code: "482913" , round: "0000000000000004" });
  wrong(4);
  c.handle({ t: "pair", code: "482913" , round: "0000000000000005" });
  wrong(4);
  dm("482913");
  assert.equal(of("paired").length, 1, "four misses per window are allowed, and a new pair resets the count");
  assert.deepEqual(of("error"), []);

  c.handle({ t: "pair", code: "771204" , round: "0000000000000006" });
  wrong(5);
  assert.deepEqual(of("error").map((e) => e.code), ["pairing_locked"]);
  dm("771204");
  wrong(5);
  assert.equal(of("paired").length, 1, "a locked window accepts nothing");
  assert.equal(of("error").length, 1, "locked once");

  c.handle({ t: "pair", code: "771204" , round: "0000000000000007" });
  dm("771204");
  assert.equal(of("paired").length, 2);
  await c.close();
});

test("the discord.js adapter reports only direct messages from people as DMs", async () => {
  const forum = fakeForum({ tags: [] });
  const { discord, client } = await adapterWith(forum);
  const got = [];
  discord.on("dm", (d) => got.push(d.text));
  const msg = (extra) => ({ content: "482913", author: { id: "U1", username: "u", bot: false }, guildId: null, ...extra });
  client.emit("messageCreate", msg({ guildId: "G1" }));
  client.emit("messageCreate", msg({ author: { id: "B2", username: "b", bot: true } }));
  client.emit("messageCreate", msg({ webhookId: "W1" }));
  assert.deepEqual(got, []);
  client.emit("messageCreate", msg());
  assert.deepEqual(got, ["482913"]);
});

test("the token never reaches stdout, the state file or stderr", async () => {
  const fake = createFakeDiscord();
  fake.loginError = kindError("other");
  fake.loginError.message = `request failed: Authorization Bot ${TOKEN}`;
  const { c, lines, statePath } = await boot({ fake });
  assert.ok(lines.length > 0, "premise: an error line was written");
  for (const l of lines) assert.ok(!l.includes(TOKEN), l);
  await c.close();

  const ok = await boot();
  ok.c.handle({ t: "connect", room: "R", members: [] , createdAt: 1 });
  ok.c.handle(message("R", 1, { text: `paste ${TOKEN}` }));
  await flush();
  const state = readFileSync(ok.statePath, "utf8");
  assert.ok(state.includes('"R"'), "premise: the state file was written");
  assert.ok(!state.includes(TOKEN));
  assert.equal(statSync(ok.statePath).mode & 0o777, 0o600);
  await ok.c.close();
  assert.ok(!existsSync(statePath) || !readFileSync(statePath, "utf8").includes(TOKEN));

  const r = await runChild(SOURCE, { mode: "throw-token" });
  assert.notEqual(r.code, 0, "premise: the child died on the uncaught error");
  assert.ok(r.stderr.includes("exploded holding"), `premise: stderr carried the error: ${r.stderr}`);
  assert.ok(!r.stderr.includes(TOKEN) && !r.stdout.includes(TOKEN), r.stderr);
});

test("a refused token reports error bad_token", async () => {
  const fake = createFakeDiscord();
  fake.loginError = kindError("bad_token");
  const { c, of } = await boot({ fake });
  assert.deepEqual(of("error").map((e) => e.code), ["bad_token"]);
  assert.deepEqual(of("ready"), []);
  await c.close();

  for (const how of ["reject", 4004]) {
    const { discord } = await adapterWith(fakeForum({ tags: [] }), { login: how === "reject" ? "TokenInvalid" : how });
    await assert.rejects(withTimeout(discord.login(TOKEN)), (e) => e.kind === "bad_token");
  }
});

test("a bot without the Message Content intent reports error missing_intent", async () => {
  const { discord } = await adapterWith(fakeForum({ tags: [] }), { login: 4014 });
  const fake = createFakeDiscord();
  fake.login = () => withTimeout(discord.login(TOKEN));
  const { c, of } = await boot({ fake });
  await flush();
  assert.deepEqual(of("error").map((e) => e.code), ["missing_intent"]);
  await c.close();
});

test("ready carries v, bot, applicationId and forums", async () => {
  const { c, of } = await boot();
  assert.deepEqual(of("ready"), [
    { t: "ready", v: 1, bot: { id: "B1", username: "gyre-bot" }, applicationId: "A1", forums: [{ id: "F1", name: "rooms", guildId: "G1", guildName: "Home" }] },
  ]);
  await c.close();
});

for (const [name, entry] of [["source", SOURCE], ["bundle", BUNDLE]]) {
  test(`stdin end shuts the ${name} child down cleanly with no timers left`, async () => {
    assert.ok(existsSync(entry), `${entry} missing — run pnpm discord:build`);
    const r = await runChild(entry, { endAfterReady: true });
    assert.ok(r.ready, `premise: the child reached ready (${r.stdout})`);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.afterEndMs < 1500, `exited ${r.afterEndMs} ms after stdin ended; a live timer or socket held it`);
  });
}

function withTimeout(promise, ms = 2000) {
  let timer;
  const timeout = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("timed out")), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function fakeForum({ tags }) {
  const forum = {
    id: "F1",
    type: ChannelType.GuildForum,
    availableTags: tags,
    setCalls: [],
    async setAvailableTags(list) {
      forum.setCalls.push(list);
      forum.availableTags = list.map((t, i) => ({ id: t.id ?? `new${i}`, name: t.name }));
      return forum;
    },
  };
  return forum;
}

async function adapterWith(forum, { login = "ready" } = {}) {
  let client;
  let options;
  const discord = createDiscordJs({
    makeClient(opts) {
      options = opts;
      client = new EventEmitter();
      client.user = { id: "B1", username: "gyre-bot" };
      client.channels = { fetch: async (id) => (id === forum.id ? forum : null) };
      client.guilds = { cache: new Map() };
      client.destroy = async () => {};
      client.login = async () => {
        if (login === "TokenInvalid") throw Object.assign(new Error("An invalid token was provided."), { code: DiscordjsErrorCodes.TokenInvalid });
        setImmediate(() => {
          if (typeof login === "number") client.emit("shardDisconnect", { code: login }, 0);
          else client.emit("clientReady", { user: client.user, application: { id: "A1" } });
        });
        return "ok";
      };
      return client;
    },
  });
  if (login === "ready") await discord.login(TOKEN);
  return { discord, get client() { return client; }, get options() { return options; } };
}

function runChild(entry, { mode, endAfterReady = false } = {}) {
  return new Promise((resolve) => {
    const args = [CHILD, entry, ...(mode ? [mode] : [])];
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let ready = false;
    let endedAt = 0;
    const kill = setTimeout(() => child.kill("SIGKILL"), 8000);
    child.stdout.on("data", (d) => {
      stdout += d;
      if (!ready && stdout.includes('"t":"ready"')) {
        ready = true;
        if (endAfterReady) {
          endedAt = Date.now();
          child.stdin.end();
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => {
      clearTimeout(kill);
      resolve({ code, stdout, stderr, ready, afterEndMs: endedAt ? Date.now() - endedAt : -1 });
    });
    child.stdin.write(`${JSON.stringify({ t: "hello", v: 1, token: TOKEN, forumId: null, ownerId: null, statePath: tmpState() })}\n`);
  });
}

test("the state file is never read or written through a planted link", () => {
  const dir = mkdtempSync(join(tmpdir(), "gd-discord-link-"));
  const path = join(dir, "discord-state.json");
  const target = join(dir, "victim.json");
  const victim = `${JSON.stringify({ v: 1, rooms: { VICTIM: { threadId: "T", lastSeq: 9 } } })}\n`;
  writeFileSync(target, victim);

  // At the temp name the old writer used, predictable from the pid.
  symlinkSync(target, `${path}.${process.pid}.tmp`);
  saveState(path, { v: 1, rooms: { R: { lastSeq: 1 } } });
  assert.equal(readFileSync(target, "utf8"), victim, "the link's target is untouched");
  assert.equal(loadState(path).rooms.R.lastSeq, 1, "premise: the state was written");
  assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
  assert.equal((statSync(path).mode & 0o777), 0o600);

  // At the state path itself: refused on read, replaced (not followed) on write.
  const linked = join(dir, "linked-state.json");
  symlinkSync(target, linked);
  assert.deepEqual(loadState(linked), { v: 1, rooms: {} }, "a symlinked state file is not read");
  saveState(linked, { v: 1, rooms: { S: { lastSeq: 2 } } });
  assert.equal(readFileSync(target, "utf8"), victim);
  assert.ok(!lstatSync(linked).isSymbolicLink(), "the link itself was replaced");
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp") && !name.includes(String(process.pid))), [], "no temp left behind");
});

test("a restart resumes a split message after the last part saved, and resends no part Discord already took", async () => {
  const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
  const run = async ({ dropSave }) => {
    const statePath = tmpState();
    const fake = createFakeDiscord();
    const first = await boot({ fake, statePath });
    first.c.handle({ t: "connect", room: "R", members: [] , createdAt: 1 });
    await flush();
    let before = null;
    let sends = 0;
    fake.gate = async (op) => {
      if (op !== "send") return;
      sends += 1;
      // The state as it was before part 1 was accepted, to stand for a save that never landed.
      if (sends === 1) before = readFileSync(statePath, "utf8");
      if (sends === 2) await new Promise(() => {}); // the process dies here, part 2 unsent
    };
    first.c.handle(message("R", 1, { text: words, to: "Codex", kind: "ask" }));
    await flush();
    const parts = fake.sent.map((s) => s.content);
    assert.equal(parts.length, 1, "premise: part 1 was accepted and part 2 never was");
    if (dropSave) writeFileSync(statePath, before);

    fake.gate = null;
    const second = await boot({ fake, statePath });
    second.c.handle({ t: "connect", room: "R", members: [] , createdAt: 1 });
    second.c.handle(message("R", 1, { text: words, to: "Codex", kind: "ask" }));
    await flush();
    const all = fake.sent.map((s) => s.content).filter((content) => !content.startsWith("—"));
    await second.c.close();
    return all;
  };

  const saved = await run({ dropSave: false });
  assert.equal(saved.join(""), `→ Codex · ask\n${words}`, "every part once, in order: part 1 is not resent");
  assert.equal(new Set(saved).size, saved.length);

  // The crash came after Discord accepted part 1 and before its save: the intent is on disk,
  // so the restart reads part 1 back — past the divider it posts first — and does not resend it.
  const unsaved = await run({ dropSave: true });
  assert.equal(unsaved.join(""), `→ Codex · ask\n${words}`, "every part once, in order");
  assert.equal(new Set(unsaved).size, unsaved.length, "no part sent twice");
});

test("an unknown Discord error keeps the message at the head: retried, delivered once, nothing overtakes", async () => {
  const { c, fake, clock, of } = await boot();
  c.handle({ t: "connect", room: "R", members: [] , createdAt: 1 });
  await flush();
  let failed = 0;
  fake.gate = async (op, args) => {
    if (op === "send" && args.content.endsWith("m1") && failed === 0) {
      failed += 1;
      throw kindError("other");
    }
  };
  c.handle(message("R", 1));
  c.handle(message("R", 2));
  await flush();
  assert.equal(failed, 1, "premise: the first send failed");
  assert.deepEqual(texts(fake), [], "m2 does not overtake the held m1");
  assert.equal(of("error").at(-1)?.room, "R", "the room says it is held up");
  await clock.advance(1000);
  assert.deepEqual(texts(fake), ["m1", "m2"]);
  assert.deepEqual(of("posted").map((p) => p.seq), [1, 2]);
  await c.close();
});

test("a state save that fails once is retried: nothing is lost or sent twice", async () => {
  const statePath = tmpState();
  const { c, fake, clock, of } = await boot({ statePath });
  c.handle({ t: "connect", room: "R", members: [] , createdAt: 1 });
  await flush();
  let broke = false;
  fake.gate = async (op, args) => {
    if (op === "send" && args.content.endsWith("m1") && !broke) {
      broke = true;
      chmodSync(dirname(statePath), 0o500);
    }
  };
  c.handle(message("R", 1));
  c.handle(message("R", 2));
  await flush();
  assert.ok(broke, "premise: the save after m1 could not be written");
  assert.deepEqual(texts(fake), ["m1"]);
  assert.deepEqual(of("posted"), [], "not acknowledged while unsaved");
  chmodSync(dirname(statePath), 0o700);
  await clock.advance(1000);
  assert.deepEqual(texts(fake), ["m1", "m2"], "m1 is not sent again, m2 follows");
  assert.deepEqual(of("posted").map((p) => p.seq), [1, 2]);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).rooms.R.lastSeq, 2);
  await c.close();
});

test("content Discord refuses three times is replaced by one line, and the next seq follows", async () => {
  const { c, fake, clock, of } = await boot();
  c.handle({ t: "connect", room: "R", members: [] , createdAt: 1 });
  await flush();
  let refused = 0;
  fake.gate = async (op, args) => {
    if (op === "send" && args.content.endsWith("m1")) {
      refused += 1;
      throw Object.assign(kindError("rejected"), { message: "Invalid Form Body" });
    }
  };
  c.handle(message("R", 1));
  c.handle(message("R", 2));
  await clock.advance(1000);
  assert.equal(refused, 3);
  assert.deepEqual(fake.sent.map((s) => s.content), ["(message #1 from Gyre could not be posted: Invalid Form Body)", "→ everyone · tell\nm2"]);
  assert.deepEqual(of("posted").map((p) => p.seq), [1, 2]);
  await c.close();
});

test("a post created by a run that died before saving it is adopted, never made twice", async () => {
  const statePath = tmpState();
  const fake = createFakeDiscord();
  const first = await boot({ fake, statePath });
  fake.gate = async (op) => {
    if (op === "createPost") {
      // Discord makes the post; the save that would record it never lands.
      chmodSync(dirname(statePath), 0o500);
    }
  };
  first.c.handle({ t: "connect", room: "R", members: ["Gyre"], createdAt: 1700 });
  await flush();
  chmodSync(dirname(statePath), 0o700);
  assert.deepEqual([...fake.threads.keys()], ["T101"], "premise: one post was created");
  assert.equal(existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).rooms.R : undefined, undefined, "premise: and not recorded");
  fake.gate = null;

  const second = await boot({ fake, statePath });
  second.c.handle({ t: "connect", room: "R", members: ["Gyre"], createdAt: 1700 });
  await flush();
  assert.deepEqual([...fake.threads.keys()], ["T101"], "no T102");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).rooms.R.threadId, "T101");
  assert.ok(fake.threads.get("T101").content.endsWith("\ngyredeck-room: R · 1700"));
  await second.c.close();
});

test("two posts for one room instance: the oldest is kept, the other closed for its 30-day delete", async () => {
  const statePath = tmpState();
  const fake = createFakeDiscord();
  const marker = "Room R\nMembers: —\ngyredeck-room: R · 1700";
  fake.threads.set("T50", { forumId: "F1", archived: false, content: marker, createdAt: 50 });
  fake.threads.set("T40", { forumId: "F1", archived: true, content: marker, createdAt: 40 });
  const { c } = await boot({ fake, statePath });
  c.handle({ t: "connect", room: "R", members: [], createdAt: 1700 });
  await flush();
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.rooms.R.threadId, "T40", "the oldest is the room's post");
  assert.equal(fake.threads.get("T40").archived, false);
  assert.equal(fake.threads.get("T50").archived, true);
  assert.deepEqual(fake.threads.get("T50").appliedTags, ["tag-closed"]);
  assert.ok(Object.values(state.rooms).some((r) => r.threadId === "T50" && r.closedAt), "recorded for the 30-day delete");
  assert.equal(fake.threads.size, 2, "nothing new created");
  await c.close();
});

/** A forum whose archived posts come in pages of 100, newest first, each archived a second apart. */
function forumWithArchive({ pages, match = null, endless = false, tieAt = null }) {
  const forum = fakeForum({ tags: [] });
  const starters = { fetched: [] };
  const thread = (id, name, at, content = "Room other\nMembers: —\ngyredeck-room: other · 1") => ({
    id, name, parentId: "F1", ownerId: "B1", archived: true, archiveTimestamp: at, createdTimestamp: at,
    fetchStarterMessage: async () => (starters.fetched.push(id), { content }),
  });
  const all = [];
  for (let page = 0; page < pages; page++) {
    for (let i = 0; i < 100; i++) {
      const n = page * 100 + i;
      // `tieAt`: this post was archived in the same millisecond as the one before it.
      const at = 1_000_000_000 - (tieAt !== null && n >= tieAt ? n - 1 : n) * 1000;
      all.push(match && match.at === n ? thread(`A${n}`, match.name, at, match.content) : thread(`A${n}`, "Room other", at));
    }
  }
  forum.threads = {
    fetchActive: async () => ({ threads: new Collection() }),
    fetchArchived: async ({ before }) => {
      const older = all.filter((t) => before === undefined || t.archiveTimestamp < before).slice(0, 100);
      return { threads: new Collection(older.map((t) => [t.id, t])), hasMore: endless || all.indexOf(older.at(-1)) < all.length - 1 };
    },
  };
  return { forum, starters };
}

test("findPosts fetches only posts with the room's name, and finds one far back in the archive", async () => {
  const marker = "gyredeck-room: R · 1700";
  const { forum, starters } = forumWithArchive({ pages: 14, match: { at: 1234, name: "Room R", content: `Room R\nMembers: —\n${marker}` } });
  const { discord } = await adapterWith(forum);
  const { found, complete } = await discord.findPosts("F1", { name: "Room R", marker });
  assert.deepEqual(found.map((p) => p.id), ["A1234"], "found on page 13, past the old 1,000");
  assert.equal(complete, true);
  assert.deepEqual(starters.fetched, ["A1234"], "only the post with the room's name had its first message fetched");
});

test("findPosts says when the safety cap stopped it short", async () => {
  const { forum } = forumWithArchive({ pages: FIND_PAGES_MAX + 2, endless: true });
  const { discord } = await adapterWith(forum);
  const { complete } = await discord.findPosts("F1", { name: "Room R", marker: "gyredeck-room: R · 1" });
  assert.equal(complete, false);
});

test("an incomplete search still connects, and says so for the room", async () => {
  const fake = createFakeDiscord();
  fake.findIncomplete = true;
  const { c, of } = await boot({ fake });
  c.handle({ t: "connect", room: "R", members: [], createdAt: 1700 });
  await flush();
  assert.deepEqual(of("error").map((e) => [e.code, e.room]), [["reconcile_incomplete", "R"]]);
  assert.equal(of("connected").length, 1, "the room is still followed");
  await c.close();
});

test("a short write never replaces the state: the old bytes stay and the save throws", () => {
  const path = tmpState();
  saveState(path, { v: 1, rooms: { R: { lastSeq: 7 } } });
  const before = readFileSync(path);
  // A disk that takes ten bytes, then no more.
  let given = 0;
  const short = (fd, buffer, offset, length) => {
    const n = Math.max(0, Math.min(length, 10 - given));
    given += n;
    return n;
  };
  assert.throws(() => saveState(path, { v: 1, rooms: { R: { lastSeq: 8 }, S: { lastSeq: 1 } } }, { writeSync: short }));
  assert.ok(given > 0, "premise: some bytes went out before the disk filled");
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp")), [], "no temp left behind");
});

test("a corrupt state file is kept aside and said, not read as empty in silence", async () => {
  const statePath = tmpState();
  writeFileSync(statePath, '{"v":1,"rooms":{"R":');
  const { c, of } = await boot({ statePath });
  const aside = readdirSync(dirname(statePath)).filter((name) => name.includes(".bad-"));
  assert.equal(aside.length, 1, "the bad file is kept");
  assert.equal(readFileSync(join(dirname(statePath), aside[0]), "utf8"), '{"v":1,"rooms":{"R":');
  assert.equal(of("error").filter((e) => e.code === "internal" && /kept aside/.test(e.message)).length, 1);
  await c.close();
});

test("an ACK names the room instance its message belonged to, even when it lands after a reconnect", async () => {
  const { c, fake, of } = await boot();
  const held = deferred();
  fake.gate = async (op, args) => {
    if (op === "send" && args.content.endsWith("m1")) await held.promise;
  };
  c.handle({ t: "connect", room: "R", members: [], createdAt: 100 });
  c.handle(message("R", 1));
  await flush();
  c.handle({ t: "disconnect", room: "R", reason: "closed" });
  c.handle({ t: "connect", room: "R", members: [], createdAt: 200 });
  held.resolve();
  await flush();
  assert.deepEqual(of("posted").map((p) => [p.seq, p.createdAt]), [[1, 100]]);
  await c.close();
});

test("with saves failing, no part goes out: the intent is durable first, so a restart repeats none", async () => {
  const words = Array.from({ length: 1400 }, (_, i) => `word${i}`).join(" ");
  const statePath = tmpState();
  const fake = createFakeDiscord();
  const first = await boot({ fake, statePath });
  first.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  await flush();
  chmodSync(dirname(statePath), 0o500);
  first.c.handle(message("R", 1, { text: words, to: "Codex", kind: "ask" }));
  await first.clock.advance(10_000);
  await first.clock.advance(10_000);
  const sentWhileFailing = fake.sent.length;
  chmodSync(dirname(statePath), 0o700);
  assert.ok(first.of("error").length >= 1, "premise: the failing save was reported");
  assert.equal(sentWhileFailing, 0, "no part goes out before its intent is on disk");

  const second = await boot({ fake, statePath });
  second.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  second.c.handle(message("R", 1, { text: words, to: "Codex", kind: "ask" }));
  await flush();
  const parts = fake.sent.map((s) => s.content).filter((content) => !content.startsWith("—"));
  const repeats = parts.length - new Set(parts).size;
  assert.equal(repeats, 0, `${repeats} parts repeated`);
  assert.equal(parts.join(""), `→ Codex · ask\n${words}`);
  await second.c.close();
});

test("a state file that cannot be read is reported and never saved over", async () => {
  const statePath = tmpState();
  const bytes = `${JSON.stringify({ v: 1, rooms: { R: { threadId: "T1", lastSeq: 17 } } })}\n`;
  writeFileSync(statePath, bytes);
  chmodSync(statePath, 0o000);
  try {
    const { c, of } = await boot({ statePath });
    c.handle({ t: "connect", room: "S", members: [], createdAt: 1 });
    c.handle(message("S", 1));
    await flush();
    assert.ok(of("error").some((e) => e.code === "storage_blocked" && /could not be read/.test(e.message)), JSON.stringify(of("error")));
    await c.close();
  } finally {
    chmodSync(statePath, 0o600);
  }
  assert.equal(readFileSync(statePath, "utf8"), bytes, "the bytes are as they were");
});

test("Discord is told paired only after the app accepts that round", async () => {
  const { c, fake, of } = await boot();
  const replies = [];
  const dm = (text) => fake.emit("dm", { userId: "U1", username: "owner", text, reply: async (line) => replies.push(line) });
  c.handle({ t: "pair", code: "111111", round: "aaaaaaaaaaaaaaaa" });
  dm("111111");
  assert.equal(of("paired").length, 1);
  assert.deepEqual(replies, ["Code received — check Gyredeck."]);
  c.handle({ t: "owner", ownerId: "U1", round: "bbbbbbbbbbbbbbbb" });
  assert.deepEqual(replies, ["Code received — check Gyredeck."], "another round's owner line says nothing");
  c.handle({ t: "owner", ownerId: "U1", round: "aaaaaaaaaaaaaaaa" });
  assert.deepEqual(replies, ["Code received — check Gyredeck.", "Paired with Gyredeck."]);
  await c.close();
});

test("findPosts finds a post archived in the same millisecond as the end of a page", async () => {
  const marker = "gyredeck-room: R · 1700";
  // Post 100 opens page 2 and shares post 99's millisecond, the last of page 1.
  const { forum } = forumWithArchive({ pages: 3, tieAt: 100, match: { at: 100, name: "Room R", content: `Room R\nMembers: —\n${marker}` } });
  const { discord } = await adapterWith(forum);
  const { found, complete } = await discord.findPosts("F1", { name: "Room R", marker });
  assert.deepEqual(found.map((p) => p.id), ["A100"]);
  assert.equal(complete, true);
});

test("with the state file blocked nothing is connected or posted, so nothing can repeat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gd-discord-blocked-"));
  const statePath = join(dir, "discord-state.json");
  writeFileSync(join(dir, "elsewhere.json"), `${JSON.stringify({ v: 1, rooms: {} })}\n`);
  symlinkSync(join(dir, "elsewhere.json"), statePath);
  const fake = createFakeDiscord();
  const { c, of } = await boot({ fake, statePath });
  const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
  c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  c.handle(message("R", 1, { text: words, to: "Codex", kind: "ask" }));
  await flush();
  assert.equal(fake.sent.length, 0, "not one part went out");
  assert.equal(fake.log.filter((e) => e.op === "createPost").length, 0, "nor a post");
  assert.deepEqual(of("posted"), [], "and nothing is acknowledged");
  assert.ok(of("error").some((e) => e.room === "R" && /nothing is posted/.test(e.message)), JSON.stringify(of("error")));
  await c.close();
});

// ── ported from the r4 and r5 stand-in audits ──
const auditLine = (s) => s.content.split("\n").at(-1).replace(/^— Reconnected.*—$/, "— Reconnected —");
const auditTexts = (fake) => fake.sent.map(auditLine);
const dividerState = join(mkdtempSync(join(tmpdir(), "gd-standin-")), "discord-state.json");

test("(ported from the r5 stand-in) a restarted child replays two draining batches of one instance in order, every seq ACKed once", async () => {
  const { c, fake, of } = await boot();
  // What Hub::attach sends for draining [(m1), (m2)] then the connected room with m3.
  c.handle({ t: "connect", room: "R", members: ["Gyre"], createdAt: 1 });
  c.handle(message("R", 1));
  c.handle({ t: "disconnect", room: "R", reason: "disconnected" });
  c.handle({ t: "connect", room: "R", members: ["Gyre"], createdAt: 1 });
  c.handle(message("R", 2));
  c.handle({ t: "disconnect", room: "R", reason: "disconnected" });
  c.handle({ t: "connect", room: "R", members: ["Gyre"], createdAt: 1 });
  c.handle(message("R", 3));
  await flush();
  assert.equal(fake.log.filter((e) => e.op === "createPost").length, 1, "one post for one instance");
  assert.deepEqual(auditTexts(fake), ["m1", "Disconnected", "— Reconnected —", "m2", "Disconnected", "— Reconnected —", "m3"]);
  assert.deepEqual(of("posted").map((p) => [p.seq, p.createdAt]), [[1, 1], [2, 1], [3, 1]]);
  assert.deepEqual(of("error"), []);
  await c.close();
});

test("(ported from the r5 stand-in) draining batches of an earlier instance go to the old post, the current room to its own", async () => {
  const { c, fake, of, statePath } = await boot();
  c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  c.handle(message("R", 1));
  c.handle({ t: "disconnect", room: "R", reason: "closed" });
  c.handle({ t: "connect", room: "R", members: [], createdAt: 2 });
  c.handle(message("R", 1));
  c.handle({ t: "disconnect", room: "R", reason: "disconnected" });
  c.handle({ t: "connect", room: "R", members: [], createdAt: 2 });
  c.handle(message("R", 2));
  await flush();
  assert.equal(fake.log.filter((e) => e.op === "createPost").length, 2, "one post per instance");
  const [oldPost, newPost] = of("connected").map((e) => e.threadId);
  assert.notEqual(oldPost, newPost);
  assert.deepEqual(fake.sent.filter((s) => s.threadId === oldPost).map(auditLine), ["m1", "Room closed"]);
  assert.deepEqual(fake.sent.filter((s) => s.threadId === newPost).map(auditLine), ["m1", "Disconnected", "— Reconnected —", "m2"]);
  assert.deepEqual(of("posted").map((p) => [p.seq, p.createdAt]), [[1, 1], [1, 2], [2, 2]]);
  const saved = JSON.parse(readFileSync(statePath, "utf8")).rooms;
  assert.equal(saved.R.createdAt, 2);
  assert.equal(saved["R@1"].threadId, oldPost);
  await c.close();
});

/** Child 1 left: instance A (100) closed with post TA; instance B (200) live with post TB and m1 posted. */
function seedReused() {
  const fake = createFakeDiscord();
  fake.threads.set("TA", { forumId: "F1", archived: true, content: "Room R\nMembers: —\ngyredeck-room: R · 100" });
  fake.threads.set("TB", { forumId: "F1", archived: false, content: "Room R\nMembers: —\ngyredeck-room: R · 200" });
  const statePath = tmpState();
  writeFileSync(statePath, JSON.stringify({ v: 1, rooms: {
    // Closed an hour before the fake clock's start, well inside the 30-day retention.
    "R@100": { threadId: "TA", forumId: "F1", lastSeq: 5, openedAt: 1, closedAt: Date.UTC(2026, 9, 27, 8, 0, 0), createdAt: 100 },
    R: { threadId: "TB", forumId: "F1", lastSeq: 1, openedAt: 3, closedAt: null, createdAt: 200 },
  } }));
  return { fake, statePath };
}

test("(ported from the r4 stand-in) control: without a draining replay the saved progress dedupes B's seq 1", async () => {
  const { fake, statePath } = seedReused();
  const { c } = await boot({ fake, statePath });
  c.handle({ t: "connect", room: "R", members: [], createdAt: 200 });
  c.handle(message("R", 1));
  c.handle(message("R", 2));
  await flush();
  const toB = fake.sent.filter((s) => s.threadId === "TB").map((s) => s.content.split("\n").at(-1)).filter((t) => /^m\d$/.test(t));
  assert.deepEqual(toB, ["m2"], "premise: the state file's lastSeq 1 keeps m1 off Discord");
  await c.close();
});

test("(ported from the r4 stand-in) a draining replay of the code's earlier instance must not lose the live instance's progress", async () => {
  const { fake, statePath } = seedReused();
  const { c, of } = await boot({ fake, statePath });
  // Exactly Rust Hub::attach for draining {R: A} then rooms {R: B}.
  c.handle({ t: "connect", room: "R", members: [], createdAt: 100 });
  c.handle(message("R", 6));
  c.handle({ t: "disconnect", room: "R", reason: "closed" });
  c.handle({ t: "connect", room: "R", members: [], createdAt: 200 });
  c.handle(message("R", 1));
  c.handle(message("R", 2));
  await flush();
  const toA = fake.sent.filter((s) => s.threadId === "TA").map((s) => s.content.split("\n").at(-1));
  const toB = fake.sent.filter((s) => s.threadId === "TB").map((s) => s.content.split("\n").at(-1)).filter((t) => /^m\d$/.test(t));
  assert.ok(toA.includes("m6") && toA.includes("Room closed"), `premise: A's last line and close reached TA: ${JSON.stringify(toA)}`);
  assert.deepEqual(of("posted").map((p) => [p.seq, p.createdAt]), [[6, 100], [1, 200], [2, 200]]);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.rooms.R.threadId, "TB", "B is back on its own post");
  const problems = [];
  if (state.rooms["R@200"] !== undefined) problems.push(`B's live post is recorded as closed (for the 30-day delete): ${JSON.stringify(state.rooms["R@200"])}`);
  if (JSON.stringify(toB) !== JSON.stringify(["m2"])) problems.push(`B's seq 1 was already on Discord, so only m2 may follow; got ${JSON.stringify(toB)}`);
  assert.deepEqual(problems, []);
  await c.close();
});

test("(ported from the r4 stand-in) while the state cannot be saved, the open retries post no second divider", async () => {
  const fake = createFakeDiscord();
  const clock = fakeClock();
  const lines = [];
  const c = createConnector({ discord: fake, clock, out: (l) => lines.push(l) });
  c.handle({ t: "hello", v: 1, token: TOKEN, forumId: "F1", ownerId: null, statePath: dividerState });
  await flush();
  chmodSync(dirname(dividerState), 0o500);
  try {
    c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
    await flush();
    assert.equal(fake.log.filter((e) => e.op === "createPost").length, 1, "premise: the post was created");
    assert.ok(lines.some((l) => /"code":"internal"/.test(l)), "premise: the failed save was reported");
    // Retry ticks: 1 s, 2 s, 4 s, 8 s.
    for (const ms of [1000, 2000, 4000, 8000]) await clock.advance(ms);
    const dividers = fake.sent.filter((s) => /^— Reconnected/.test(s.content));
    assert.equal(fake.log.filter((e) => e.op === "createPost").length, 1, "still one post");
    assert.equal(dividers.length, 0, `${dividers.length} "— Reconnected —" lines went into the post while nothing was reconnected`);
  } finally {
    chmodSync(dirname(dividerState), 0o700);
    await c.close();
  }
});

test("with storage blocked each room says why once, and no room_unknown buries it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gd-discord-blocked2-"));
  const statePath = join(dir, "discord-state.json");
  writeFileSync(join(dir, "elsewhere.json"), `${JSON.stringify({ v: 1, rooms: {} })}\n`);
  symlinkSync(join(dir, "elsewhere.json"), statePath);
  const { c, of } = await boot({ statePath });
  c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  for (const seq of [1, 2, 3]) c.handle(message("R", seq));
  await flush();
  assert.deepEqual(of("error").map((e) => [e.code, e.room ?? null]), [["storage_blocked", null], ["storage_blocked", "R"]]);
  await c.close();
});

test("an earlier instance replayed for its last lines leaves the live one open, not marked for deletion", async () => {
  const { fake, statePath } = seedReused();
  const { c } = await boot({ fake, statePath });
  c.handle({ t: "connect", room: "R", members: [], createdAt: 100 });
  c.handle(message("R", 6));
  c.handle({ t: "disconnect", room: "R", reason: "closed" });
  await flush();
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.rooms["R@200"]?.threadId, "TB", "premise: the live instance was set aside while the earlier one drained");
  assert.equal(state.rooms["R@200"].closedAt, null, "and is not closed, so the 30-day sweep never takes it");
  await c.close();
});

// ── #199 r7: the invariants the audit found open (199-invariants.md §5), one proof each ──

test("I19: a forum missing at open parks the room; the forum line wakes it and nothing handed over is lost", async () => {
  const fake = createFakeDiscord();
  fake.gate = async (op) => { if (op === "ensureTags") throw kindError("missing"); };
  const b = await boot({ fake });
  b.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  await flush();
  b.c.handle(message("R", 1));
  b.c.handle(message("R", 2));
  await flush();
  assert.deepEqual(b.of("error").map((e) => e.code), ["no_forum"], "said once, and the lines behind it are taken, not refused");
  fake.gate = null;
  b.c.handle({ t: "forum", forumId: "F1" });
  await flush(4);
  assert.deepEqual(texts(fake), ["m1", "m2"]);
  assert.deepEqual(b.of("posted").map((p) => p.seq), [1, 2]);
});

test("I19: a forum that comes back without a forum line is found by the retry", async () => {
  const fake = createFakeDiscord();
  let missing = true;
  fake.gate = async (op) => { if (op === "ensureTags" && missing) throw kindError("missing"); };
  const b = await boot({ fake });
  b.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  b.c.handle(message("R", 1));
  await flush();
  missing = false;
  await b.clock.advance(2_000);
  await flush(4);
  assert.deepEqual(texts(fake), ["m1"]);
});

test("I12: a close taken just before stdin ends is finished: closing line, archive, closedAt, and `closed` said", async () => {
  const b = await boot();
  b.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  await flush();
  b.c.handle(message("R", 1));
  await flush();
  assert.deepEqual(texts(b.fake), ["m1"], "premise");
  const { editThread, sendWebhook } = b.fake;
  const released = deferred();
  b.fake.sendWebhook = async (args) => { await released.promise; if (b.fake.destroyed) throw kindError("network"); return sendWebhook(args); };
  b.fake.editThread = async (...a) => { if (b.fake.destroyed) throw kindError("network"); return editThread(...a); };
  b.c.handle({ t: "disconnect", room: "R", reason: "closed" });
  await flush(2);
  const closing = b.c.close();
  released.resolve();
  await closing;
  await flush();
  assert.deepEqual(texts(b.fake).slice(1), ["Room closed"]);
  assert.ok(loadState(b.statePath).rooms.R?.closedAt, "closedAt is durable, so the post is deleted after 30 days");
  assert.deepEqual(b.of("closed"), [{ t: "closed", room: "R", createdAt: 1, id: null }]);
});

test("I12: a close of a post an earlier run already closed is said done without posting again", async () => {
  const statePath = tmpState();
  const first = await boot({ statePath });
  first.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  await flush();
  first.c.handle({ t: "disconnect", room: "R", reason: "closed" });
  await flush(4);
  assert.equal(first.of("closed").length, 1, "premise");
  await first.c.close();
  const next = await boot({ statePath, fake: first.fake });
  const sent = first.fake.sent.length;
  next.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  next.c.handle({ t: "disconnect", room: "R", reason: "closed" });
  await flush(4);
  assert.deepEqual(next.of("closed"), [{ t: "closed", room: "R", createdAt: 1, id: null }]);
  assert.ok(!first.fake.sent.slice(sent).some((s) => s.content === "Room closed"), "no second closing line");
});

test("I21: at the relay's end, what is still queued is said once, by seq and sender, before the close", async () => {
  const fake = createFakeDiscord();
  const b = await boot({ fake });
  b.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  await flush();
  const held = deferred();
  fake.gate = async (op) => { if (op === "send") await held.promise; };
  b.c.handle(message("R", 40));
  for (const [seq, sender] of [[41, "Codex"], [42, "Gyre Assistant"], [43, "Codex"], [47, "Codex"]]) b.c.handle(message("R", seq, { sender }));
  b.c.handle({ t: "disconnect", room: "R", reason: "closed" });
  b.c.handle({ t: "end" });
  fake.gate = null;
  held.resolve();
  await flush(6);
  assert.deepEqual(texts(fake), ["m40", "4 messages not relayed: #41–#43, #47 from Codex, Gyre Assistant", "Room closed"]);
  assert.deepEqual(b.of("posted").map((p) => p.seq), [40, 47], "taken, so the app does not count them again");
  assert.equal(loadState(b.statePath).rooms.R.lastSeq, 47);
});

// ── #199 option B (199-invariants-v2.md §7.3, §8): postOnce, the durable close, recovery ──

/** Discord takes the first post `match` picks, and the reply to it is lost on the way back. */
function loseReplyOnce(fake, match) {
  const seen = { lost: false };
  fake.after = async (op, args) => {
    if (op === "send" && !seen.lost && match(args.content)) {
      seen.lost = true;
      throw kindError("network");
    }
  };
  return seen;
}

const count = (fake, pred) => fake.sent.filter((s) => pred(s.content)).length;

test("postOnce, every site: a post Discord took whose reply was lost is read back, not made again", async () => {
  const sites = {
    async line(b) {
      const seen = loseReplyOnce(b.fake, (t) => t.endsWith("m1"));
      b.c.handle(message("R", 1));
      await b.clock.advance(2_000);
      return [seen, (t) => t.endsWith("m1")];
    },
    async divider(b) {
      b.c.handle({ t: "disconnect", room: "R", reason: "closed" });
      await flush();
      await b.clock.advance(60_000);
      const seen = loseReplyOnce(b.fake, (t) => t.startsWith("— Reconnected"));
      b.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
      await b.clock.advance(2_000);
      return [seen, (t) => t.startsWith("— Reconnected")];
    },
    async close(b) {
      const seen = loseReplyOnce(b.fake, (t) => t === "Room closed");
      b.c.handle({ t: "disconnect", room: "R", reason: "closed", id: "c1" });
      await b.clock.advance(2_000);
      assert.deepEqual(b.of("closed").map((e) => e.id), ["c1"]);
      return [seen, (t) => t === "Room closed"];
    },
    async lost(b) {
      const held = deferred();
      b.fake.gate = async (op) => { if (op === "send") await held.promise; };
      b.c.handle(message("R", 40));
      b.c.handle(message("R", 41));
      b.c.handle({ t: "disconnect", room: "R", reason: "closed", id: "c1" });
      b.c.handle({ t: "end" });
      b.fake.gate = null;
      const seen = loseReplyOnce(b.fake, (t) => t.includes("not relayed"));
      held.resolve();
      await b.clock.advance(2_000);
      return [seen, (t) => t.includes("not relayed")];
    },
    async instead(b) {
      b.fake.gate = async (op, args) => {
        if (op === "send" && args.content.endsWith("m1")) throw Object.assign(kindError("rejected"), { message: "Invalid Form Body" });
      };
      const seen = loseReplyOnce(b.fake, (t) => t.startsWith("(message #1"));
      b.c.handle(message("R", 1));
      await b.clock.advance(5_000);
      return [seen, (t) => t.startsWith("(message #1")];
    },
  };
  for (const [name, run] of Object.entries(sites)) {
    const b = await boot();
    b.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
    await flush();
    const [seen, pick] = await run(b);
    assert.ok(seen.lost, `${name}: premise, Discord took the post and its reply was lost`);
    assert.equal(count(b.fake, pick), 1, `${name}: posted once`);
    assert.ok(b.fake.log.some((e) => e.op === "fetchMessages"), `${name}: it was read back`);
    await b.c.close();
  }
});

test("T8 (ported from the r7 audit): a closing line taken before the archive failed is not posted again by the next child", async () => {
  const statePath = tmpState();
  const fake = createFakeDiscord();
  const first = await boot({ fake, statePath });
  first.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  await flush();
  let failed = false;
  fake.gate = async (op) => {
    if (op === "editThread" && !failed) { failed = true; throw kindError("network"); }
  };
  first.c.handle({ t: "disconnect", room: "R", reason: "closed", id: "c1" });
  await flush();
  assert.equal(count(fake, (t) => t === "Room closed"), 1, "premise: close line accepted");
  assert.equal(loadState(statePath).rooms.R.closedAt, null, "premise: close not durable");
  fake.gate = null;
  const next = await boot({ fake, statePath });
  next.c.handle({ t: "connect", room: "R", members: [], createdAt: 1, resume: { lastAcked: 0, lastMsgId: null } });
  next.c.handle({ t: "disconnect", room: "R", reason: "closed", id: "c1" });
  await flush();
  assert.equal(count(fake, (t) => t === "Room closed"), 1, "one closing line");
  assert.equal(count(fake, (t) => t.startsWith("— Reconnected")), 0, "a post being closed is not reopened to finish its close");
  assert.ok(loadState(statePath).rooms.R.closedAt);
  assert.deepEqual(next.of("closed"), [{ t: "closed", room: "R", createdAt: 1, id: "c1" }]);
});

test("T8: a close cut off after Discord took it, after its save failed, or after its archive, says one closing line across restarts", async () => {
  for (const cut of ["reply", "save", "archive"]) {
    const statePath = tmpState();
    const fake = createFakeDiscord();
    const first = await boot({ fake, statePath });
    first.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
    await flush();
    if (cut === "reply") loseReplyOnce(fake, (t) => t === "Room closed");
    if (cut === "save") fake.after = async (op) => { if (op === "send") chmodSync(dirname(statePath), 0o500); };
    if (cut === "archive") fake.gate = async (op) => { if (op === "editThread") chmodSync(dirname(statePath), 0o500); };
    first.c.handle({ t: "disconnect", room: "R", reason: "closed", id: "c1" });
    await flush();
    chmodSync(dirname(statePath), 0o700);
    fake.after = null;
    fake.gate = null;
    assert.equal(count(fake, (t) => t === "Room closed"), 1, `${cut}: premise, Discord took the closing line`);
    if (cut === "archive") assert.ok(fake.log.some((e) => e.op === "editThread" && e.archived), "archive: premise, the post was archived");
    assert.deepEqual(first.of("closed"), [], `${cut}: premise, the close was not finished`);
    for (let run = 0; run < 2; run++) {
      const next = await boot({ fake, statePath });
      next.c.handle({ t: "connect", room: "R", members: [], createdAt: 1, resume: { lastAcked: 0, lastMsgId: null } });
      next.c.handle({ t: "disconnect", room: "R", reason: "closed", id: "c1" });
      await flush();
      assert.deepEqual(next.of("closed").map((e) => e.id), ["c1"], `${cut}: restart ${run} finishes the close`);
      await next.c.close();
    }
    assert.equal(count(fake, (t) => t === "Room closed"), 1, `${cut}: one closing line in all`);
  }
});

test("T8: with read-back refused, a recovery repeats at most one closing line and says readback_unavailable", async () => {
  const statePath = tmpState();
  const fake = createFakeDiscord();
  const first = await boot({ fake, statePath });
  first.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  await flush();
  loseReplyOnce(fake, (t) => t === "Room closed");
  first.c.handle({ t: "disconnect", room: "R", reason: "closed", id: "c1" });
  await flush();
  fake.after = null;
  assert.equal(count(fake, (t) => t === "Room closed"), 1, "premise: Discord took the closing line");
  fake.gate = async (op) => { if (op === "fetchMessages") throw kindError("permission"); };
  const counts = [];
  for (let run = 0; run < 2; run++) {
    const next = await boot({ fake, statePath });
    next.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
    next.c.handle({ t: "disconnect", room: "R", reason: "closed", id: "c1" });
    await flush();
    counts.push(count(fake, (t) => t === "Room closed"));
    if (run === 0) assert.deepEqual(next.of("error").map((e) => e.code), ["readback_unavailable"]);
    assert.deepEqual(next.of("closed").map((e) => e.id), ["c1"]);
    await next.c.close();
  }
  assert.deepEqual(counts, [2, 2], "one repeat for the one recovery that could not read back, none after");
});

test("T9 (ported from the r7 audit): a child whose state was lost reads back what the app still owes, and posts it once", async () => {
  const path = tmpState();
  const fake = createFakeDiscord();
  const first = await boot({ fake, statePath: path });
  const ts = new Date(first.clock.now()).toISOString();
  first.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  first.c.handle(message("R", 1, { sender: "Codex", text: "one", ts }));
  await flush();
  assert.equal(count(fake, (t) => t.endsWith("one")), 1, "premise: Discord accepted line 1");
  assert.ok(first.of("posted").some((x) => x.seq === 1), "premise: ACK emitted, but could die before Rust reads it");
  await first.c.close();
  writeFileSync(path, "{", "utf8");
  // Relaunched five minutes later: the line is now older than the "(delayed)" mark's 60 s.
  const next = await boot({ fake, statePath: path, clock: fakeClock(first.clock.now() + 5 * 60_000) });
  next.c.handle({ t: "connect", room: "R", members: [], createdAt: 1, resume: { lastAcked: 0, lastMsgId: null } });
  next.c.handle(message("R", 1, { sender: "Codex", text: "one", ts }));
  await flush();
  assert.equal(count(fake, (t) => t.endsWith("one")), 1, "one copy");
  assert.deepEqual(next.of("posted").map((p) => p.seq), [1]);
});

test("T9: lost state × (ACK applied or not) × (read-back or refused): no copy where it can read back, at most one extra per owed line where not", async () => {
  for (const applied of [false, true]) {
    for (const refused of [false, true]) {
      const label = `applied=${applied} refused=${refused}`;
      const statePath = tmpState();
      const fake = createFakeDiscord();
      const first = await boot({ fake, statePath });
      const ts = new Date(first.clock.now()).toISOString();
      first.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
      first.c.handle(message("R", 1, { ts }));
      first.c.handle(message("R", 2, { ts }));
      await flush();
      const ids = Object.fromEntries(first.of("posted").map((p) => [p.seq, p.msgId]));
      assert.ok(ids[1] && ids[2], `${label}: premise, both lines posted with their message ids`);
      await first.c.close();
      writeFileSync(statePath, "{", "utf8");
      if (refused) fake.gate = async (op) => { if (op === "fetchMessages") throw kindError("permission"); };
      // Relaunched five minutes later, so the owed lines would now render "(delayed)".
      const next = await boot({ fake, statePath, clock: fakeClock(first.clock.now() + 5 * 60_000) });
      const resume = applied ? { lastAcked: 1, lastMsgId: ids[1] } : { lastAcked: 0, lastMsgId: null };
      next.c.handle({ t: "connect", room: "R", members: [], createdAt: 1, resume });
      for (const seq of applied ? [2, 3] : [1, 2, 3]) next.c.handle(message("R", seq, { ts: seq === 3 ? new Date(next.clock.now()).toISOString() : ts }));
      await flush();
      const n = (seq) => count(fake, (t) => t.endsWith(`m${seq}`));
      assert.equal(n(3), 1, `${label}: the new line once`);
      assert.equal(n(1), applied || !refused ? 1 : 2, `${label}: m1`);
      assert.equal(n(2), refused ? 2 : 1, `${label}: m2`);
      assert.deepEqual(next.of("posted").map((p) => p.seq), applied ? [2, 3] : [1, 2, 3], `${label}: every owed line ACKed`);
      assert.equal(next.of("error").some((e) => e.code === "readback_unavailable"), refused, `${label}: said when it could not read back`);
      await next.c.close();
    }
  }
});

test("T14: a close on a post someone deleted finishes as closed and does not hold the room", async () => {
  const b = await boot();
  b.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  await flush();
  const threadId = b.of("connected")[0].threadId;
  b.fake.threads.delete(threadId);
  b.c.handle({ t: "disconnect", room: "R", reason: "closed", id: "c1" });
  await b.clock.advance(2_000);
  assert.deepEqual(b.of("closed"), [{ t: "closed", room: "R", createdAt: 1, id: "c1" }]);
  const rs = loadState(b.statePath).rooms.R;
  assert.ok(rs.closedAt, "closedAt saved, so the sweep forgets it");
  assert.equal(rs.closing, undefined);
  b.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  b.c.handle(message("R", 1));
  await b.clock.advance(2_000);
  assert.deepEqual(texts(b.fake), ["m1"], "the queue behind it moves");
  await b.c.close();
});

test("T15: a recovered batch with no post known, none found and no lines creates no post, and its close is said done", async () => {
  const b = await boot();
  b.c.handle({ t: "connect", room: "R", members: [], createdAt: 1, resume: { lastAcked: 0, lastMsgId: null } });
  b.c.handle({ t: "disconnect", room: "R", reason: "ended", id: "c9" });
  await flush();
  assert.ok(b.fake.log.some((e) => e.op === "findPosts"), "premise: it looked for the post");
  assert.equal(b.fake.log.filter((e) => e.op === "createPost").length, 0);
  assert.deepEqual(b.fake.sent, []);
  assert.deepEqual(b.of("closed"), [{ t: "closed", room: "R", createdAt: 1, id: "c9" }]);
  await b.c.close();
});

test("a close with reason ended says the app stopped, and `closed` and `posted` carry the close id and message id", async () => {
  const b = await boot();
  b.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  b.c.handle(message("R", 1));
  b.c.handle({ t: "disconnect", room: "R", reason: "ended", id: "e1" });
  await flush();
  assert.deepEqual(texts(b.fake), ["m1", "Room ended — Gyredeck stopped"]);
  const sends = b.fake.log.filter((e) => e.op === "send");
  assert.deepEqual(b.of("posted"), [{ t: "posted", room: "R", seq: 1, createdAt: 1, msgId: sends[0].id }]);
  assert.deepEqual(b.of("closed"), [{ t: "closed", room: "R", createdAt: 1, id: "e1" }]);
  assert.equal(loadState(b.statePath).rooms.R.lastMsgId, sends[1].id, "the anchor is the last message Discord took");
  await b.c.close();
});

test("a line the room said more than 60 s ago, handed over at the next launch, is marked (delayed) at once", async () => {
  const { c, fake, clock } = await boot();
  c.handle({ t: "connect", room: "R", members: [], createdAt: 1, resume: { lastAcked: 0, lastMsgId: null } });
  c.handle(message("R", 1, { ts: new Date(clock.now() - 3_600_000).toISOString() }));
  c.handle(message("R", 2, { ts: new Date(clock.now() - 1_000).toISOString() }));
  c.handle(message("R", 3, { ts: "not a time" }));
  await flush();
  assert.deepEqual(fake.sent.map((s) => s.content.split("\n")[0]), ["→ everyone · tell (delayed)", "→ everyone · tell", "→ everyone · tell"]);
  await c.close();
});

test("discord.js adapter: sendWebhook returns the message id; fetchMessages reads after an id, oldest first; a 403 is a permission", async () => {
  const forum = fakeForum({ tags: [] });
  forum.fetchWebhooks = async () => new Collection();
  forum.createWebhook = async () => ({ send: async () => ({ id: "1002", content: "x" }) });
  const asked = [];
  const msg = (id, webhookId, username, content) => [id, { id, webhookId, author: { username }, content }];
  const thread = {
    id: "900",
    messages: {
      fetch: async (opts) => {
        asked.push(opts);
        return new Collection([msg("1003", "W1", "Gyre", "b"), msg("1001", null, "someone", "a")]);
      },
    },
  };
  const a = await adapterWith(forum);
  a.client.channels.fetch = async (id) => (id === "F1" ? forum : id === "900" ? thread : null);
  assert.deepEqual(await a.discord.sendWebhook({ forumId: "F1", threadId: "900", username: "Gyre", content: "x", allowedMentions: NO_MENTIONS }), { id: "1002" });
  assert.deepEqual(await a.discord.fetchMessages("900", { after: "1000", limit: 100 }), [
    { id: "1001", webhookId: null, username: "someone", content: "a" },
    { id: "1003", webhookId: "W1", username: "Gyre", content: "b" },
  ]);
  assert.deepEqual(asked, [{ after: "1000", limit: 100, cache: false }]);
  thread.messages.fetch = async () => {
    throw new DiscordAPIError({ code: 50001, message: "Missing Access" }, 50001, 403, "GET", "/channels/900/messages", {});
  };
  await assert.rejects(a.discord.fetchMessages("900", { after: "1000" }), (e) => e.kind === "permission");
  await assert.rejects(a.discord.fetchMessages("901", { after: "1000" }), (e) => e.kind === "missing");
});

test("AUDIT-A (ported): a line Discord took before its save is read back after a plain restart, though the divider posts first", async () => {
  const statePath = tmpState();
  const fake = createFakeDiscord();
  const first = await boot({ fake, statePath });
  first.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  await flush();
  fake.after = async (op, args) => { if (op === "send" && args.content.endsWith("m1")) await new Promise(() => {}); };
  first.c.handle(message("R", 1));
  await flush();
  assert.equal(count(fake, (t) => t.endsWith("m1")), 1, "premise: Discord took m1");
  assert.equal(loadState(statePath).rooms.R.pending?.key, "line:1:0", "premise: the intent is durable, the result is not");
  fake.after = null;
  const next = await boot({ fake, statePath });
  next.c.handle({ t: "connect", room: "R", members: [], createdAt: 1, resume: { lastAcked: 0, lastMsgId: null } });
  next.c.handle(message("R", 1));
  next.c.handle(message("R", 2));
  await flush();
  assert.deepEqual(texts(fake), ["m1", "— Reconnected —", "m2"]);
  assert.deepEqual(next.of("posted").map((p) => [p.seq, p.msgId]), [[1, fake.log.find((e) => e.op === "send").id], [2, fake.log.filter((e) => e.op === "send").at(-1).id]]);
});

test("AUDIT-C (Node half): a seq an earlier run posted is ACKed with the last message known to be ours, never with no id", async () => {
  const statePath = tmpState();
  const fake = createFakeDiscord();
  const first = await boot({ fake, statePath });
  first.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  first.c.handle(message("R", 1));
  first.c.handle(message("R", 2));
  await flush();
  const last = first.of("posted").at(-1).msgId;
  assert.ok(last, "premise: posted");
  first.c.handle(message("R", 1));
  await flush();
  assert.deepEqual(first.of("posted").slice(2).map((p) => [p.seq, p.msgId]), [[1, last]], "a seq handed again in the same run");
  await first.c.close();
  const next = await boot({ fake, statePath });
  next.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  next.c.handle(message("R", 1));
  next.c.handle(message("R", 2));
  await flush();
  const posted = next.of("posted");
  assert.deepEqual(posted.map((p) => p.seq), [1, 2], "premise: both re-handed seqs ACKed without posting");
  assert.ok(posted.every((p) => typeof p.msgId === "string"), JSON.stringify(posted));
});

test("AUDIT-C (Node half): a seq posted earlier and handed again after an instance switch is ACKed with its post's anchor", async () => {
  const b = await boot();
  b.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  b.c.handle(message("R", 1));
  b.c.handle(message("R", 2));
  b.c.handle({ t: "connect", room: "R", members: [], createdAt: 2 });
  b.c.handle(message("R", 1));
  b.c.handle({ t: "connect", room: "R", members: [], createdAt: 1 });
  b.c.handle(message("R", 2));
  await flush();
  const first = b.of("connected")[0].threadId;
  const posted = b.of("posted");
  assert.deepEqual(posted.map((p) => [p.seq, p.createdAt]), [[1, 1], [2, 1], [1, 2], [2, 1]], "premise: seq 2 of instance 1 ACKed again");
  assert.equal(b.fake.sent.filter((s) => s.content.endsWith("m2")).length, 1, "premise: not posted again");
  const lastInFirst = b.fake.log.filter((e) => e.op === "send" && e.threadId === first).at(-1).id;
  assert.equal(posted.at(-1).msgId, lastInFirst);
  await b.c.close();
});
