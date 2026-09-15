import assert from "node:assert/strict";
import test from "node:test";

const module = new URL(
  "../apps/desktop/src/features/mail/useRoomInbox.ts",
  import.meta.url,
);
const { recordMessage, retainedRegistry, unreadIn } = await import(module.href);

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
