import assert from "node:assert/strict";
import test from "node:test";

import {
  ORPHANED_ROOM_REASON,
  roomHasLostItsFounder,
  sweepRooms,
} from "../adapters/bridge/gyredeck-bridge.mjs";

/**
 * The net under the three paths that take a member out of a room.
 *
 * Each of them closes the room when the member leaving is its founder, and that is three
 * places remembering the same rule — which is how the fault arrived: one of them did not.
 * The sweep asks this question instead, so a fourth path added later is covered without
 * having to know about it.
 *
 * Imported rather than restated: a copy of the rule here would go on agreeing with itself
 * after the bridge stopped asking.
 */
const room = ({ createdBy = "founder", members = ["founder"] } = {}) => ({
  createdBy,
  members: new Map(members.map((id) => [id, { confirmed: true }])),
});

test("a room still holding its founder is left alone", () => {
  assert.equal(roomHasLostItsFounder(room()), false);
  assert.equal(roomHasLostItsFounder(room({ members: ["founder", "peer"] })), false);
});

test("a room whose founder is gone is over, whoever else is in it", () => {
  // The case that matters: somebody is still there, so nothing else would clear it. What
  // is left cannot be joined — `/passwords` answers `not_the_founder` to everyone
  // remaining — and cannot be closed, because the app asks as itself and is refused too.
  assert.equal(roomHasLostItsFounder(room({ members: ["peer"] })), true);
  assert.equal(roomHasLostItsFounder(room({ members: [] })), true);
});

test("a mailbox has no founder and is not judged by this", () => {
  // A private mailbox is named after one session and `createdBy` is null. Reading that as
  // "the founder is missing" would delete mail nobody had read yet.
  assert.equal(roomHasLostItsFounder(room({ createdBy: null, members: [] })), false);
  assert.equal(roomHasLostItsFounder({ createdBy: undefined, members: new Map() }), false);
});

/**
 * The pass itself, not the question it asks.
 *
 * The three tests above go on passing with `sweepRooms` deleted, or with its founder
 * check moved below the members test where it can never fire — which is the shape of the
 * original bug. Codex named that in review; these run the real pass.
 */
const sweepable = ({ createdBy = "founder", members = ["founder"], clients = 0, touchedAt = Date.now() } = {}) => ({
  ...room({ createdBy, members }),
  clients: new Set(Array.from({ length: clients }, () => ({}))),
  touchedAt,
});

const sweepWith = (rooms, now = Date.now(), idleMs = 3_600_000) => {
  const closed = [];
  sweepRooms(rooms, now, {
    close: (name, r, why) => {
      closed.push({ name, why });
      rooms.delete(name);
    },
    idleMs,
  });
  return closed;
};

test("the sweep closes a room whose founder has gone, while a peer is still in it", () => {
  const rooms = new Map([["sync-ab12", sweepable({ members: ["peer"] })]]);
  const closed = sweepWith(rooms);
  assert.deepEqual(closed.map((c) => c.name), ["sync-ab12"]);
  assert.equal(closed[0].why, ORPHANED_ROOM_REASON);
  assert.equal(rooms.has("sync-ab12"), false);
});

test("the sweep leaves a room that still holds its founder", () => {
  const rooms = new Map([["sync-ab12", sweepable({ members: ["founder", "peer"] })]]);
  assert.deepEqual(sweepWith(rooms), []);
  assert.equal(rooms.has("sync-ab12"), true);
});

test("the sweep never closes a private mailbox, however long it has sat", () => {
  // `createdBy` is null for a mailbox, so the founder rule must not reach it. An idle one
  // is still forgotten — deleted, not closed, because there is nobody to tell.
  const idle = new Map([["session-1", sweepable({ createdBy: null, members: [], touchedAt: 0 })]]);
  assert.deepEqual(sweepWith(idle, 3_600_001), []);
  assert.equal(idle.has("session-1"), false);

  const held = new Map([["session-2", sweepable({ createdBy: null, members: [], clients: 1, touchedAt: 0 })]]);
  assert.deepEqual(sweepWith(held, 3_600_001), []);
  assert.equal(held.has("session-2"), true, "a mailbox somebody is streaming is not swept");
});
