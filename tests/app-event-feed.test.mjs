import assert from "node:assert/strict";
import test from "node:test";

const feed = new URL("../apps/desktop/src/features/presence/appEventFeed.ts", import.meta.url);
const inbox = new URL("../apps/desktop/src/features/mail/useRoomInbox.ts", import.meta.url);
const { createAppEventFeed } = await import(feed.href);
const { recordRoomMessages } = await import(inbox.href);

/** As Rust hands it over: `n` is the order the app received it in. */
const said = (n, room) => ({
  n,
  event: {
    version: 1,
    id: `e${n}`,
    type: "room_message",
    timestamp: "2026-11-15T10:00:00Z",
    conversationId: "s1",
    data: { seq: n, room, from: "codex-1", fromLabel: "Codex", kind: "ask", preview: `m${n}` },
  },
});

test("c391 a live event that lands while the kept ones are read waits behind them", () => {
  const seen = [];
  const appEvents = createAppEventFeed((event) => seen.push(event));
  appEvents.live(said(2, "sync-bbbb"));
  assert.deepEqual(seen, [], "nothing is handed on before what was kept");
  appEvents.kept([said(1, "sync-aaaa"), said(2, "sync-bbbb")]);
  assert.deepEqual(seen.map((event) => event.id), ["e1", "e2"], "in the app's order, each once");

  const registry = recordRoomMessages({}, seen, new Set());
  assert.equal(registry.s1.room, "sync-bbbb", "the inbox ends in the room the session is in now");
});

test("c391 more arriving in the wait than Rust keeps still goes out in order", () => {
  // Live 1–201 while the read is in flight; Rust kept only 2–201 by the time it answered.
  const seen = [];
  const appEvents = createAppEventFeed((event) => seen.push(event));
  for (let n = 1; n <= 201; n += 1) appEvents.live(said(n, n === 1 ? "sync-aaaa" : "sync-bbbb"));
  appEvents.kept(Array.from({ length: 200 }, (_, i) => said(i + 2, "sync-bbbb")));
  assert.deepEqual(seen.map((event) => event.data.seq), Array.from({ length: 201 }, (_, i) => i + 1), "1 to 201, once each");
  assert.equal(recordRoomMessages({}, seen, new Set()).s1.room, "sync-bbbb", "the room switch holds");
});

test("c391 after the kept ones, live events go straight through, and a failed read still lets them out", () => {
  const seen = [];
  const appEvents = createAppEventFeed((event) => seen.push(event.id));
  appEvents.live(said(1, "sync-aaaa"));
  appEvents.kept([]);
  appEvents.live(said(2, "sync-aaaa"));
  appEvents.live(said(2, "sync-aaaa"));
  appEvents.live(said(1, "sync-aaaa"));
  appEvents.kept([said(3, "sync-aaaa")]);
  assert.deepEqual(seen, ["e1", "e2"], "nothing twice, nothing older than the last, a second kept list ignored");
});
