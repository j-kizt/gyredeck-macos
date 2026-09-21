import assert from "node:assert/strict";
import test from "node:test";

const module = new URL(
  "../apps/desktop/src/features/mail/useRoomInbox.ts",
  import.meta.url,
);
const { recordMessage, retainedRegistry, retainOpenRooms, unreadIn } = await import(module.href);

/** Any listing taken after the fixtures below, which all sit at 10:00:00Z. */
const LATER = Date.parse("2026-09-15T11:00:00Z");

const message = (overrides = {}) => ({
  seq: 1,
  room: "sync-a1b2",
  from: "codex-1",
  fromLabel: "Codex",
  kind: "ask",
  preview: "anything",
  at: "2026-09-15T10:00:00Z",
  ...overrides,
});

test("a message starts the inbox in its own room", () => {
  const next = recordMessage({}, "s1", message());
  assert.equal(next.s1.room, "sync-a1b2");
  assert.equal(next.s1.messages.length, 1);
  assert.equal(next.s1.readAt, null);
});

test("the same message arriving again is not counted twice", () => {
  // A backfill replays what the live stream already delivered.
  const once = recordMessage({}, "s1", message());
  const twice = recordMessage(once, "s1", message());
  assert.equal(twice, once);
  assert.equal(twice.s1.messages.length, 1);
});

test("a message from a different room replaces the list rather than joining it", () => {
  // Otherwise two rooms read as one conversation, and replies nobody here sent are
  // counted as unread.
  const first = recordMessage({}, "s1", message({ seq: 4, preview: "old room" }));
  const second = recordMessage(first, "s1", message({ room: "sync-zzzz", seq: 1, preview: "new room" }));
  assert.equal(second.s1.room, "sync-zzzz");
  assert.equal(second.s1.messages.length, 1);
  assert.equal(second.s1.messages[0].preview, "new room");
});

test("leaving a room ends its messages", () => {
  const held = recordMessage({}, "s1", message());
  const after = retainedRegistry(held, "s1", null);
  assert.deepEqual(after, {});
  assert.equal(unreadIn(after.s1), 0);
});

test("still in the same room keeps everything, and the identity is unchanged", () => {
  const held = recordMessage({}, "s1", message());
  const after = retainedRegistry(held, "s1", "sync-a1b2");
  // Same object: a new one every poll would re-render the list five times a second.
  assert.equal(after, held);
  assert.equal(after.s1.messages.length, 1);
});

test("moving to another room drops what belonged to the last one", () => {
  const held = recordMessage({}, "s1", message());
  const after = retainedRegistry(held, "s1", "sync-other");
  assert.equal(after.s1, undefined);
});

test("one session leaving does not disturb another", () => {
  let held = recordMessage({}, "s1", message());
  held = recordMessage(held, "s2", message({ room: "sync-beta" }));
  const after = retainedRegistry(held, "s1", null);
  assert.equal(after.s1, undefined);
  assert.equal(after.s2.room, "sync-beta");
  assert.equal(after.s2.messages.length, 1);
});

test("a session with nothing held is left alone", () => {
  const empty = {};
  assert.equal(retainedRegistry(empty, "s1", null), empty);
  assert.equal(retainedRegistry(empty, "s1", "sync-a1b2"), empty);
});

test("unread counts only what arrived after the last look", () => {
  let held = recordMessage({}, "s1", message({ seq: 1, at: "2026-09-15T10:00:00Z" }));
  assert.equal(unreadIn(held.s1), 1);

  held = { s1: { ...held.s1, readAt: "2026-09-15T10:30:00Z" } };
  assert.equal(unreadIn(held.s1), 0);

  held = recordMessage(held, "s1", message({ seq: 2, at: "2026-09-15T11:00:00Z" }));
  assert.equal(unreadIn(held.s1), 1);
});

// `retainedRegistry` only ever runs for the session whose detail is open, and the unread
// chip is in the list. A room closing while its session sat unopened left the chip
// counting messages for a conversation that had ended, until somebody happened to click
// that session.
test("a session whose room has ended is dropped, whether or not it is on screen", () => {
  const registry = {
    s1: { room: "sync-a1b2", messages: [message()], readAt: null },
    s2: { room: "sync-c3d4", messages: [message({ room: "sync-c3d4" })], readAt: null },
  };
  const next = retainOpenRooms(registry, new Set(["sync-c3d4"]), LATER);
  assert.equal(next.s1, undefined, "the closed room's session is gone");
  assert.equal(next.s2, registry.s2, "the open one is untouched, object and all");
});

test("nothing to drop leaves the registry exactly as it was", () => {
  // Returned unchanged rather than rebuilt, so the effect that calls this does not write
  // to storage and re-render on every poll.
  const registry = { s1: { room: "sync-a1b2", messages: [message()], readAt: null } };
  assert.equal(retainOpenRooms(registry, new Set(["sync-a1b2"]), LATER), registry);
  const empty = {};
  assert.equal(retainOpenRooms(empty, new Set(), LATER), empty, "nothing held, nothing rebuilt");
});

test("an empty listing ends every room", () => {
  // Only reached once the listing has actually answered. A failed read is not an empty
  // one, and the caller is what keeps the two apart.
  const registry = { s1: { room: "sync-a1b2", messages: [message()], readAt: null } };
  assert.deepEqual(retainOpenRooms(registry, new Set(), LATER), {});
});

test("a private mailbox is not judged by the room listing", () => {
  // A mailbox is named after its own session and is not in the listing to be missing
  // from; treating absence as death would delete mail nobody had read yet.
  const registry = {
    s1: { room: "01a0c1b8-b0ad-7b41-8fde-136e57b52dde", messages: [message({ room: "01a0c1b8-b0ad-7b41-8fde-136e57b52dde" })], readAt: null },
  };
  assert.equal(retainOpenRooms(registry, new Set(), LATER), registry);
});

// The half that render timing cannot be trusted to get right: a listing speaks only for
// the moment it was taken, so a room made after it is missing from it because it did not
// exist yet. Reading that as "the room ended" deletes a brand-new room's first message —
// which is worse than the stale chip this pruning exists to clear.
test("a listing older than the message it would delete leaves it alone", () => {
  const registry = {
    s1: { room: "sync-a1b2", messages: [message({ at: "2026-09-15T10:00:00Z" })], readAt: null },
  };
  const before = Date.parse("2026-09-15T09:59:00Z");
  assert.equal(retainOpenRooms(registry, new Set(), before), registry, "nothing is thrown away");
});

test("a listing newer than every message it holds may end the room", () => {
  const registry = {
    s1: { room: "sync-a1b2", messages: [message({ at: "2026-09-15T10:00:00Z" })], readAt: null },
  };
  const after = Date.parse("2026-09-15T10:00:01Z");
  assert.deepEqual(retainOpenRooms(registry, new Set(), after), {});
});

test("the newest message is what counts, not the oldest", () => {
  // One old message and one that has just arrived: the room is not over.
  const registry = {
    s1: {
      room: "sync-a1b2",
      messages: [
        message({ seq: 1, at: "2026-09-15T09:00:00Z" }),
        message({ seq: 2, at: "2026-09-15T10:30:00Z" }),
      ],
      readAt: null,
    },
  };
  const between = Date.parse("2026-09-15T10:00:00Z");
  assert.equal(retainOpenRooms(registry, new Set(), between), registry);
});
