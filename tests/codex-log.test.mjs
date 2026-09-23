import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { codexReplyFromLine, readCodexLog, readCodexReplies } from "../adapters/bridge/gyredeck-bridge.mjs";

/**
 * The byte arithmetic behind harvesting Codex's answers out of its own rollout log.
 *
 * Two faults lived here and neither could be tested while this was inside `startBridge`:
 * a cursor kept per batch stepped over a reply the room had refused, and a rotated log
 * left the cursor above the end of the new file, so every pass re-read it from the top.
 * Both were fixed on the strength of reading the code. These are the tests that were owed.
 */
const withLog = (run) => {
  const dir = mkdtempSync(join(tmpdir(), "gyredeck-rollout-"));
  try {
    run(join(dir, "rollout.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const turn = (text, at = new Date()) => `${JSON.stringify({
  type: "event_msg",
  timestamp: at.toISOString(),
  payload: { type: "task_complete", turn_id: text, last_agent_message: text },
})}\n`;

test("a line that is not a finished turn is not a reply", () => {
  assert.equal(codexReplyFromLine("", 0), null);
  assert.equal(codexReplyFromLine("not json", 0), null);
  assert.equal(codexReplyFromLine(JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }), 0), null);
  assert.equal(codexReplyFromLine(JSON.stringify({
    type: "event_msg", payload: { type: "task_complete", last_agent_message: "   " },
  }), 0), null, "a turn that said nothing is not an answer");

  const real = codexReplyFromLine(turn("hello").trim(), 0);
  assert.equal(real.text, "hello");
});

test("the last reply ends exactly where the read does", () => {
  // `endsAt` is what lets the harvest stop the cursor between two replies. If it drifts
  // from the read's own offset, the cursor lands mid-line and the next read starts inside
  // a JSON object.
  withLog((path) => {
    writeFileSync(path, turn("first") + turn("second"));
    const read = readCodexLog(path, 0, 0);
    assert.equal(read.from, 0);
    assert.deepEqual(read.replies.map((reply) => reply.text), ["first", "second"]);
    assert.equal(read.replies.at(-1).endsAt, read.offset);

    // And resuming from the first reply's end hands back exactly the rest.
    const rest = readCodexLog(path, read.replies[0].endsAt, 0);
    assert.deepEqual(rest.replies.map((reply) => reply.text), ["second"]);
  });
});

test("a log truncated or rewritten shorter is read from its beginning, and says where that was", () => {
  // Shorter than the cursor pointing into it is the only case an offset can detect. The
  // reader restarts at zero; the caller has to be told, or it keeps the old offset and
  // reads the new file from the top on every pass until it outgrows the old one.
  //
  // What this does **not** cover, and the bridge does not claim to: a log replaced by a
  // different file of the same size or larger, which would be read from the middle. That
  // needs the file's identity kept beside the cursor. Codex writes one rollout per session
  // and never reuses a path, so it has not arisen.
  withLog((path) => {
    writeFileSync(path, turn("before-the-rewrite") + turn("also-before"));
    const whole = readCodexLog(path, 0, 0);
    assert.ok(whole.offset > 0);

    writeFileSync(path, turn("after-the-rewrite"));
    const rotated = readCodexLog(path, whole.offset, 0);

    assert.equal(rotated.from, 0, "a log smaller than the cursor is read from its start");
    assert.ok(readCodexLog(path, whole.offset + 10_000, 0).from === 0, "and so is one read with a cursor well past its end");
    assert.deepEqual(rotated.replies.map((reply) => reply.text), ["after-the-rewrite"]);
    assert.equal(rotated.replies.at(-1).endsAt, rotated.offset);
  });
});

test("a line still being written is left for the next read", () => {
  // Codex appends; a read can catch the file mid-write. Consuming a partial line would
  // both lose it and leave the cursor inside a JSON object.
  withLog((path) => {
    writeFileSync(path, turn("complete"));
    appendFileSync(path, '{"type":"event_msg","payload":{"type":"task_comp');

    const read = readCodexLog(path, 0, 0);
    assert.deepEqual(read.replies.map((reply) => reply.text), ["complete"]);
    assert.equal(read.offset, read.replies[0].endsAt, "the cursor stops in front of the partial line");

    // Finished later, it is read then.
    writeFileSync(path, turn("complete") + turn("finished-later"));
    const after = readCodexLog(path, read.offset, 0);
    assert.deepEqual(after.replies.map((reply) => reply.text), ["finished-later"]);
  });
});

test("what Codex said before a time is filtered out, by time and not by position", () => {
  withLog((path) => {
    const old = new Date(Date.now() - 86_400_000);
    writeFileSync(path, turn("yesterday", old) + turn("just-now"));
    const since = Date.now() - 3_600_000;

    const filtered = readCodexLog(path, 0, since);
    assert.deepEqual(filtered.replies.map((reply) => reply.text), ["just-now"]);
    assert.equal(filtered.offset, readCodexLog(path, 0, 0).offset, "filtering changes what is returned, not how far the read got");

    assert.deepEqual(readCodexReplies(path, since).map((reply) => reply.text), ["just-now"]);
  });
});

test("offsets are bytes, so a log in Thai does not shift the cursor", () => {
  // `endsAt` accumulates the byte length of each line. Counting characters instead would
  // put the cursor short by two thirds on this file, inside the next JSON object.
  withLog((path) => {
    const thai = "รับทราบครับ ห้องนี้ปิด audit แล้ว";
    writeFileSync(path, turn(thai) + turn("after"));

    const read = readCodexLog(path, 0, 0);
    assert.deepEqual(read.replies.map((reply) => reply.text), [thai, "after"]);
    assert.equal(read.replies.at(-1).endsAt, read.offset);

    const rest = readCodexLog(path, read.replies[0].endsAt, 0);
    assert.deepEqual(rest.replies.map((reply) => reply.text), ["after"], "the cursor landed on a line break, not inside a character");
  });
});

test("a cursor past the end of a file that has not moved reads nothing", () => {
  withLog((path) => {
    writeFileSync(path, turn("only"));
    const read = readCodexLog(path, 0, 0);
    const again = readCodexLog(path, read.offset, 0);
    assert.deepEqual(again.replies, []);
    assert.equal(again.offset, read.offset, "and does not wind the cursor back");
  });
});

test("a log that is not there yet is not an error", () => {
  withLog((path) => {
    const read = readCodexLog(path, 0, 0);
    assert.deepEqual(read.replies, []);
    assert.deepEqual(readCodexReplies(path, 0), []);
  });
});
