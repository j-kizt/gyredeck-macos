import assert from "node:assert/strict";
import test from "node:test";

const module = new URL("../apps/desktop/src/features/setup/disconnectAll.ts", import.meta.url);
const { disconnectAll, offerDisconnectAll, showSyncRooms, stillHeld } = await import(module.href);

test("#205 Disconnect all acts on the rooms connected when it was pressed, never on one that joins meanwhile", async () => {
  const connected = ["sync-aaaa", "sync-bbbb"];
  const asked = [];
  // The live list itself: the function must keep its own copy.
  const result = await disconnectAll(connected, async (code) => {
    asked.push(code);
    if (code === "sync-aaaa") connected.push("sync-cccc");
  });
  assert.deepEqual(asked, ["sync-aaaa", "sync-bbbb"]);
  assert.deepEqual(result, { done: ["sync-aaaa", "sync-bbbb"], failed: [] });
});

test("#205 Disconnect all says which rooms are still connected when some fail, and a retry asks only those", async () => {
  const failing = new Set(["sync-bbbb"]);
  const one = async (code) => {
    if (failing.has(code)) throw new Error("the bridge refused");
  };
  const first = await disconnectAll(["sync-aaaa", "sync-bbbb", "sync-cccc"], one);
  assert.deepEqual(first.done, ["sync-aaaa", "sync-cccc"]);
  assert.deepEqual(first.failed, [{ code: "sync-bbbb", reason: "the bridge refused" }]);
  assert.ok(!first.done.includes("sync-bbbb"), "a failed room is never reported done");
  failing.clear();
  const retry = await disconnectAll(first.failed.map((f) => f.code), one);
  assert.deepEqual(retry, { done: ["sync-bbbb"], failed: [] });
});

test("#205 a room that failed is never off the screen: still connected → Try again here, could not leave → its leaving row", async () => {
  const failed = [
    { code: "sync-aaaa", reason: "Not a room code" },
    { code: "sync-bbbb", reason: "the bridge refused the leave" },
  ];
  // sync-bbbb was taken out of connectedRooms before its leave failed: it is in `leaving` now.
  const status = { connectedRooms: ["sync-aaaa"], leaving: { "sync-bbbb": "the bridge refused the leave" } };
  assert.deepEqual(stillHeld(failed, status), { connected: [failed[0]], leaving: ["sync-bbbb"] });
  const none = { connectedRooms: [], leaving: { "sync-bbbb": "the bridge refused the leave" } };
  assert.deepEqual(stillHeld([failed[1]], none), { connected: [], leaving: ["sync-bbbb"] }, "with no room connected it is still named");
  const asked = [];
  await disconnectAll(stillHeld(failed, status).connected.map((f) => f.code), async (code) => asked.push(code));
  assert.deepEqual(asked, ["sync-aaaa"], "Try again asks only the room still connected; the leaving row retries its own");
});

test("#205 Disconnect all is offered while rooms are connected even with the connector not ready; never with nothing to do", () => {
  const status = { ready: false, connectedRooms: ["sync-aaaa"] };
  const none = { connected: [], leaving: [] };
  assert.equal(offerDisconnectAll(status.connectedRooms, stillHeld([], status)), true);
  assert.equal(offerDisconnectAll([], none), false);
  assert.equal(offerDisconnectAll([], { connected: [], leaving: ["sync-bbbb"] }), true, "a room that could not leave keeps the notice");
});

test("#205 the Sync rooms section shows for Disconnect all even with no open room; hidden only with nothing at all", () => {
  const none = { connected: [], leaving: [] };
  assert.equal(showSyncRooms(0, ["sync-aaaa"], none), true, "Discord still follows a room nobody is in");
  assert.equal(showSyncRooms(0, [], { connected: [], leaving: ["sync-bbbb"] }), true);
  assert.equal(showSyncRooms(2, [], none), true);
  assert.equal(showSyncRooms(0, [], none), false);
});
