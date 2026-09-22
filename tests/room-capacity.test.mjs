import assert from "node:assert/strict";
import test from "node:test";

import {
  MAIL_MAX_MESSAGES,
  MAIL_MAX_NOTICES,
  MAIL_MAX_ROOM_BYTES,
  messageBytes,
  roomBytes,
  ROOM_SENDER,
  roomIsFull,
  trimRoomNotices,
  slowestReaderSeq,
  slowestReaders,
  trimRoomMessages,
} from "../adapters/bridge/gyredeck-bridge.mjs";

/**
 * A room used to drop its oldest message the moment it passed a count, whether or not
 * anybody had read it. Nothing said so: the reader was handed a shorter list, which reads
 * exactly like "that was all there was".
 *
 * Imported rather than restated — a copy of the rule here would agree with itself long
 * after the bridge stopped asking.
 */
const room = ({ messages = [], members = {}, readSeq = 0 } = {}) => ({
  name: "sync-ab12",
  seq: messages.length,
  readSeq,
  droppedThroughSeq: 0,
  messages,
  members: new Map(Object.entries(members).map(([id, seq]) => [id, { readSeq: seq, confirmed: true }])),
});

const say = (seq, text = "x") => ({ seq, from: "peer", to: "everyone", kind: "tell", text });
const fill = (count, text) => Array.from({ length: count }, (_, i) => say(i + 1, text));

test("bytes are counted as bytes, not as whatever length says", () => {
  // The cap was a count of UTF-16 code units, which is where "100 × 4096 = 13 MB" came
  // from. Thai is three bytes a character and one unit, so the two disagree by 3×.
  const thai = "ห้อง";
  assert.equal(thai.length, 4);
  assert.equal(messageBytes(say(1, thai)), Buffer.byteLength(thai, "utf8"));
  assert.ok(messageBytes(say(1, thai)) > thai.length, "or the budget is measuring the wrong thing");
});

test("the slowest reader is the one that decides what may be dropped", () => {
  const r = room({ messages: fill(3), members: { fast: 3, slow: 1 }, readSeq: 3 });
  assert.equal(slowestReaderSeq(r), 1);
  assert.deepEqual(slowestReaders(r), ["slow"]);
});

test("a mailbox with no members uses its own read position", () => {
  const r = room({ messages: fill(3), readSeq: 2 });
  assert.equal(slowestReaderSeq(r), 2);
});

test("trimming takes only what everyone has read, oldest first", () => {
  const r = room({ messages: fill(MAIL_MAX_MESSAGES + 10), members: { peer: MAIL_MAX_MESSAGES + 10 }, readSeq: MAIL_MAX_MESSAGES + 10 });
  const dropped = trimRoomMessages(r);
  assert.equal(dropped, 10);
  assert.equal(r.messages.length, MAIL_MAX_MESSAGES);
  assert.equal(r.messages[0].seq, 11, "the oldest went first");
  assert.equal(r.droppedThroughSeq, 10, "and the room remembers how far it lost");
});

test("trimming stops at the first message somebody is still owed", () => {
  // The whole point. `slow` has read three, so four onwards is theirs and the room may
  // not spend it to make space — even though it is over the cap.
  const r = room({ messages: fill(MAIL_MAX_MESSAGES + 10), members: { fast: MAIL_MAX_MESSAGES + 10, slow: 3 }, readSeq: MAIL_MAX_MESSAGES + 10 });
  assert.equal(trimRoomMessages(r), 3);
  assert.equal(r.messages[0].seq, 4);
  assert.equal(r.droppedThroughSeq, 3);
});

test("a room over its byte budget is trimmed even well under the message count", () => {
  const fat = "x".repeat(200_000);
  const messages = Array.from({ length: 10 }, (_, i) => say(i + 1, fat));
  const r = room({ messages, members: { peer: 10 }, readSeq: 10 });
  assert.ok(roomBytes(r) > MAIL_MAX_ROOM_BYTES, "the fixture has to be over budget");
  trimRoomMessages(r);
  assert.ok(roomBytes(r) <= MAIL_MAX_ROOM_BYTES);
  assert.ok(r.messages.length < 10 && r.messages.length > 0);
});

test("a room full of mail nobody has read is full, and says so instead of eating it", () => {
  const r = room({ messages: fill(MAIL_MAX_MESSAGES), members: { slow: 0 } });
  assert.equal(roomIsFull(r), true);
  assert.equal(r.messages.length, MAIL_MAX_MESSAGES, "and nothing was dropped on the way to finding out");
  assert.deepEqual(slowestReaders(r), ["slow"]);
});

test("a room whose readers have caught up is never full", () => {
  const r = room({ messages: fill(MAIL_MAX_MESSAGES), members: { peer: MAIL_MAX_MESSAGES }, readSeq: MAIL_MAX_MESSAGES });
  assert.equal(roomIsFull(r), false);
});

test("an ordinary room is neither full nor trimmed", () => {
  const r = room({ messages: fill(26, "a code review's worth"), members: { peer: 10 } });
  assert.equal(roomIsFull(r), false);
  assert.equal(trimRoomMessages(r), 0);
  assert.equal(r.droppedThroughSeq, 0);
  assert.equal(r.messages.length, 26);
});

/**
 * The three faults Codex found in the first version of this, each reproduced against the
 * real functions before being fixed.
 */

test("a big message needs enough reclaimable space, not merely a droppable head", () => {
  // Codex's reproduction. The room sits one byte under budget; only its first message —
  // one byte — has been read. Freeing that frees one byte, which is not room for 4,000.
  const messages = [say(1, "x")];
  let total = 1;
  let seq = 2;
  while (total < MAIL_MAX_ROOM_BYTES - 575) {
    const size = Math.min(4_000, MAIL_MAX_ROOM_BYTES - 575 - total);
    messages.push(say(seq, "x".repeat(size)));
    seq += 1;
    total += size;
  }
  const r = room({ messages, members: { slow: 1 } });
  assert.ok(roomBytes(r) <= MAIL_MAX_ROOM_BYTES, "the fixture starts inside the budget");
  assert.equal(roomIsFull(r, 4_000), true, "4,000 more would not fit and cannot be made to fit");

  // And the room is left as it was: asking must not spend anything.
  assert.equal(r.messages.length, messages.length);
});

test("asking whether a room is full does not change the room", () => {
  // It used to trim as a side effect of being asked, which made the answer depend on how
  // often it had been asked before.
  const r = room({ messages: fill(MAIL_MAX_MESSAGES + 10), members: { peer: MAIL_MAX_MESSAGES + 10 }, readSeq: MAIL_MAX_MESSAGES + 10 });
  const before = r.messages.length;
  assert.equal(roomIsFull(r, 10), false);
  assert.equal(r.messages.length, before, "asking is not spending");
  assert.equal(r.droppedThroughSeq, 0);
});

test("the room's own voice is kept to its own allowance", () => {
  // A notice cannot be refused — it is how a session learns it was removed — so it was
  // exempt from the capacity check, and Codex pointed out that joining and leaving
  // repeatedly while somebody is not reading then grows the room without limit.
  const messages = [];
  for (let seq = 1; seq <= 200; seq += 1) {
    messages.push({ seq, from: seq % 2 ? "gyredeck-room" : "peer", to: "everyone", kind: seq % 2 ? "notice" : "tell", text: "x" });
  }
  const r = room({ messages, members: { unread: 0 } });
  const mailBefore = r.messages.filter((m) => m.kind !== "notice").length;

  const dropped = trimRoomNotices(r);

  assert.equal(r.messages.filter((m) => m.kind === "notice").length, MAIL_MAX_NOTICES);
  assert.equal(dropped, 100 - MAIL_MAX_NOTICES);
  assert.equal(
    r.messages.filter((m) => m.kind !== "notice").length,
    mailBefore,
    "and not one message anybody was owed went with them — nobody has read a thing here",
  );
  assert.equal(r.messages.filter((m) => m.kind === "notice").at(-1).seq, 199, "the newest roster is the true one");
});

test("a room under its notice allowance is left alone", () => {
  const messages = Array.from({ length: MAIL_MAX_NOTICES }, (_, i) => ({
    seq: i + 1, from: "gyredeck-room", to: "everyone", kind: "notice", text: "x",
  }));
  const r = room({ messages, members: { unread: 0 } });
  assert.equal(trimRoomNotices(r), 0);
  assert.equal(r.messages.length, MAIL_MAX_NOTICES);
});

test("the room's own voice is bounded wherever it speaks, not only when it says notice", () => {
  // `tellJoined`, `tellConfirmed` and `partWithMember` put system messages in a session's
  // private mailbox as `kind: "tell"`, not `notice`. They are exempt from the capacity
  // refusal like every ROOM_SENDER message, so joining and leaving repeatedly while a
  // session does not read its mailbox grew it without limit. Codex found that the
  // allowance was matching on the wrong field.
  const messages = [];
  for (let seq = 1; seq <= 100; seq += 1) {
    messages.push({ seq, from: ROOM_SENDER, to: "me", kind: "tell", text: "you are now in sync room ..." });
  }
  messages.push({ seq: 101, from: "peer", to: "me", kind: "tell", text: "OWED" });
  const r = room({ messages, members: {} });

  trimRoomNotices(r);

  assert.equal(r.messages.filter((m) => m.from === ROOM_SENDER).length, MAIL_MAX_NOTICES);
  assert.ok(r.messages.some((m) => m.text === "OWED"), "and a real message is never spent for it");
});

