import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CODEX_LINE_MAX_BYTES, CODEX_READ_CHUNK_BYTES, codexEntryFromLine, codexPushTarget, findCodexPrompt, codexReplyFromLine, readCodexLog, readTail } from "../adapters/bridge/gyredeck-bridge.mjs";

/**
 * The byte arithmetic behind harvesting Codex's answers out of its own rollout log.
 *
 * Two faults lived here and neither could be tested while this was inside `startBridge`:
 * a cursor kept per batch stepped over a reply the room had refused, and a rotated log
 * left the cursor above the end of the new file, so every pass re-read it from the top.
 * Both were fixed on the strength of reading the code. These are the tests that were owed.
 */
const withLog = async (run) => {
  const dir = mkdtempSync(join(tmpdir(), "gyredeck-rollout-"));
  try {
    await run(join(dir, "rollout.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const turn = (text, at = new Date()) => `${JSON.stringify({
  type: "event_msg",
  timestamp: at.toISOString(),
  payload: { type: "task_complete", turn_id: text, last_agent_message: text },
})}\n`;

test("a line that is not a finished turn is not a reply", async () => {
  assert.equal(codexReplyFromLine("", 0), null);
  assert.equal(codexReplyFromLine("not json", 0), null);
  assert.equal(codexReplyFromLine(JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }), 0), null);
  assert.equal(codexReplyFromLine(JSON.stringify({
    type: "event_msg", payload: { type: "task_complete", last_agent_message: "   " },
  }), 0), null, "a turn that said nothing is not an answer");

  const real = codexReplyFromLine(turn("hello").trim(), 0);
  assert.equal(real.text, "hello");
});

test("the last reply ends exactly where the read does", async () => {
  // `endsAt` is what lets the harvest stop the cursor between two replies. If it drifts
  // from the read's own offset, the cursor lands mid-line and the next read starts inside
  // a JSON object.
  await withLog(async (path) => {
    writeFileSync(path, turn("first") + turn("second"));
    const read = await readCodexLog(path, 0, 0);
    assert.equal(read.from, 0);
    assert.deepEqual(read.replies.map((reply) => reply.text), ["first", "second"]);
    assert.equal(read.replies.at(-1).endsAt, read.offset);

    // And resuming from the first reply's end hands back exactly the rest.
    const rest = await readCodexLog(path, read.replies[0].endsAt, 0);
    assert.deepEqual(rest.replies.map((reply) => reply.text), ["second"]);
  });
});

test("a log truncated or rewritten shorter is read from its beginning, and says where that was", async () => {
  // Shorter than the cursor pointing into it is the only case an offset can detect. The
  // reader restarts at zero; the caller has to be told, or it keeps the old offset and
  // reads the new file from the top on every pass until it outgrows the old one.
  //
  // What this does **not** cover, and the bridge does not claim to: a log replaced by a
  // different file of the same size or larger, which would be read from the middle. That
  // needs the file's identity kept beside the cursor. Codex writes one rollout per session
  // and never reuses a path, so it has not arisen.
  await withLog(async (path) => {
    writeFileSync(path, turn("before-the-rewrite") + turn("also-before"));
    const whole = await readCodexLog(path, 0, 0);
    assert.ok(whole.offset > 0);

    writeFileSync(path, turn("after-the-rewrite"));
    const rotated = await readCodexLog(path, whole.offset, 0);

    assert.equal(rotated.from, 0, "a log smaller than the cursor is read from its start");
    assert.ok((await readCodexLog(path, whole.offset + 10_000, 0)).from === 0, "and so is one read with a cursor well past its end");
    assert.deepEqual(rotated.replies.map((reply) => reply.text), ["after-the-rewrite"]);
    assert.equal(rotated.replies.at(-1).endsAt, rotated.offset);
  });
});

test("a line still being written is left for the next read", async () => {
  // Codex appends; a read can catch the file mid-write. Consuming a partial line would
  // both lose it and leave the cursor inside a JSON object.
  await withLog(async (path) => {
    writeFileSync(path, turn("complete"));
    appendFileSync(path, '{"type":"event_msg","payload":{"type":"task_comp');

    const read = await readCodexLog(path, 0, 0);
    assert.deepEqual(read.replies.map((reply) => reply.text), ["complete"]);
    assert.equal(read.offset, read.replies[0].endsAt, "the cursor stops in front of the partial line");

    // Finished later, it is read then.
    writeFileSync(path, turn("complete") + turn("finished-later"));
    const after = await readCodexLog(path, read.offset, 0);
    assert.deepEqual(after.replies.map((reply) => reply.text), ["finished-later"]);
  });
});

test("what Codex said before a time is filtered out, by time and not by position", async () => {
  await withLog(async (path) => {
    const old = new Date(Date.now() - 86_400_000);
    writeFileSync(path, turn("yesterday", old) + turn("just-now"));
    const since = Date.now() - 3_600_000;

    const filtered = await readCodexLog(path, 0, since);
    assert.deepEqual(filtered.replies.map((reply) => reply.text), ["just-now"]);
    assert.equal(filtered.offset, (await readCodexLog(path, 0, 0)).offset, "filtering changes what is returned, not how far the read got");
  });
});

test("offsets are bytes, so a log in Thai does not shift the cursor", async () => {
  // `endsAt` accumulates the byte length of each line. Counting characters instead would
  // put the cursor short by two thirds on this file, inside the next JSON object.
  await withLog(async (path) => {
    const thai = "รับทราบครับ ห้องนี้ปิด audit แล้ว";
    writeFileSync(path, turn(thai) + turn("after"));

    const read = await readCodexLog(path, 0, 0);
    assert.deepEqual(read.replies.map((reply) => reply.text), [thai, "after"]);
    assert.equal(read.replies.at(-1).endsAt, read.offset);

    const rest = await readCodexLog(path, read.replies[0].endsAt, 0);
    assert.deepEqual(rest.replies.map((reply) => reply.text), ["after"], "the cursor landed on a line break, not inside a character");
  });
});

test("a cursor past the end of a file that has not moved reads nothing", async () => {
  await withLog(async (path) => {
    writeFileSync(path, turn("only"));
    const read = await readCodexLog(path, 0, 0);
    const again = await readCodexLog(path, read.offset, 0);
    assert.deepEqual(again.replies, []);
    assert.equal(again.offset, read.offset, "and does not wind the cursor back");
  });
});

test("a log that is not there yet is not an error", async () => {
  await withLog(async (path) => {
    const read = await readCodexLog(path, 0, 0);
    assert.deepEqual(read.replies, []);
    assert.equal(readTail(path, 1024), "");
  });
});

test("the tail of a log starts at a whole line, and reads only the tail", async () => {
  await withLog(async (path) => {
    // A first line long enough that the window has to cut through it.
    writeFileSync(path, turn("x".repeat(5_000)) + turn("second") + turn("last"));
    const tail = readTail(path, 600);
    const lines = tail.split("\n").filter(Boolean);
    assert.ok(lines.length >= 1 && lines.length <= 2, "only what fits in the window");
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), "no line cut in half");
    assert.equal(JSON.parse(lines.at(-1)).payload.last_agent_message, "last");
    assert.ok(!tail.includes("xxxxx"), "the cut first line is dropped, not returned in pieces");
  });
});

test("a tail wider than the file is the whole file", async () => {
  await withLog(async (path) => {
    // One line, built once: `turn` stamps the time, and two calls a millisecond apart are
    // two different lines.
    const only = turn("only");
    writeFileSync(path, only);
    assert.equal(readTail(path, 1_000_000), only);
  });
});

test("a tail that starts inside a Thai character still decodes cleanly", async () => {
  // Reading from an arbitrary byte can land inside a three-byte character. Only the first
  // line of the window can hold that, and it is the line that is dropped.
  await withLog(async (path) => {
    const thai = "ภาษาไทย".repeat(200);
    writeFileSync(path, turn(thai) + turn("after"));
    for (let window = 100; window < 400; window += 7) {
      const tail = readTail(path, window);
      assert.ok(!tail.includes("\uFFFD"), `window ${window} decoded a broken character`);
    }
  });
});

const prompt = (turnId, text, at = new Date()) => `${JSON.stringify({
  type: "event_msg",
  timestamp: at.toISOString(),
  payload: {
    type: "item_completed",
    turn_id: turnId,
    item: { type: "UserMessage", id: "msg", content: [{ type: "text", text }] },
  },
})}\n`;

test("a pushed message comes back as a prompt carrying its turn, and the answer carries the same turn", async () => {
  // This is the whole of what binds an answer to the question that asked for it, so the
  // shape is pinned here: Codex writes what it was given verbatim, under the turn it opened.
  const asked = codexEntryFromLine(prompt("turn-1", "[Gyredeck: hello]").trim(), 0);
  assert.deepEqual({ kind: asked.kind, turnId: asked.turnId, text: asked.text }, { kind: "prompt", turnId: "turn-1", text: "[Gyredeck: hello]" });
  assert.ok(Number.isFinite(asked.at), "a prompt says when it was written");

  const answered = codexEntryFromLine(JSON.stringify({
    type: "event_msg", timestamp: new Date().toISOString(),
    payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "hi" },
  }), 0);
  assert.deepEqual({ kind: answered.kind, turnId: answered.turnId, text: answered.text }, { kind: "reply", turnId: "turn-1", text: "hi" });

  // Other items a turn completes are not prompts, and a prompt with no turn binds nothing.
  assert.equal(codexEntryFromLine(JSON.stringify({
    type: "event_msg", payload: { type: "item_completed", turn_id: "turn-1", item: { type: "AgentMessage", content: [{ type: "Text", text: "hi" }] } },
  }), 0), null);
  assert.equal(codexEntryFromLine(JSON.stringify({
    type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "no turn" }] } },
  }), 0), null);
  // A prompt is not subject to the time floor: it is matched to a push by the reader, which
  // knows when the push was made; the floor is for replies the room never asked about.
  const old = new Date(Date.now() - 86_400_000);
  assert.equal(codexEntryFromLine(prompt("turn-0", "yesterday", old).trim(), Date.now()).kind, "prompt");
});

test("prompts and replies come back in file order with their own byte positions", async () => {
  await withLog(async (path) => {
    writeFileSync(path, prompt("t1", "q1") + turn("a1") + prompt("t2", "q2") + turn("a2"));
    const read = await readCodexLog(path, 0, 0);
    assert.deepEqual(read.prompts.map((entry) => [entry.turnId, entry.text]), [["t1", "q1"], ["t2", "q2"]]);
    assert.deepEqual(read.replies.map((entry) => entry.text), ["a1", "a2"]);
    assert.ok(read.prompts[0].endsAt < read.replies[0].endsAt && read.replies[0].endsAt < read.prompts[1].endsAt);
    assert.equal(read.replies.at(-1).endsAt, read.offset);
  });
});

test("a log read in small chunks reads the same as one read whole", async () => {
  // Chunk boundaries fall wherever the arithmetic puts them: mid-line, mid-character, on a
  // line break. None of those may change what is read or where the cursor lands.
  await withLog(async (path) => {
    const thai = "ภาษาไทย".repeat(300);
    const lines = [turn("first"), prompt("t", thai), turn(thai), turn("x".repeat(3_000)), turn("last")];
    writeFileSync(path, lines.join(""));
    const whole = await readCodexLog(path, 0, 0);
    assert.ok(statSync(path).size > 4 * CODEX_READ_CHUNK_BYTES / 64, "the fixture is bigger than the small chunks below");
    for (const chunkBytes of [1, 7, 64, 1_000, 4_096, CODEX_READ_CHUNK_BYTES]) {
      const chunked = await readCodexLog(path, 0, 0, { chunkBytes });
      assert.deepEqual(chunked, whole, `chunk size ${chunkBytes}`);
      assert.ok(!JSON.stringify(chunked).includes("\uFFFD"), `chunk size ${chunkBytes} broke a character`);
    }
    // And resuming between two of them, chunked, is the same read as whole.
    const rest = await readCodexLog(path, whole.replies[1].endsAt, 0, { chunkBytes: 5 });
    assert.deepEqual(rest, await readCodexLog(path, whole.replies[1].endsAt, 0));
    assert.deepEqual(rest.replies.map((entry) => entry.text.length), [3_000, 4]);
  });
});

test("a read gives the event loop back between chunks", async () => {
  // The reason the read is chunked at all. A timer armed before the read must fire while
  // the read is still going, which it cannot if the read holds the loop to the end.
  await withLog(async (path) => {
    writeFileSync(path, turn("x".repeat(100)).repeat(20_000));
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 1);
    try {
      const read = await readCodexLog(path, 0, 0, { chunkBytes: 64 * 1024 });
      assert.equal(read.replies.length, 20_000);
    } finally {
      clearInterval(ticker);
    }
    assert.ok(ticks >= 5, `the loop ran ${ticks} times during the read`);
  });
});

test("a line longer than the cap is skipped unread, and the lines around it are not", async () => {
  // A tool's output is one JSON line, and one of 48 MiB cost 2.3 s and 2.8 GiB to assemble
  // and parse — Codex measured it. Nothing the bridge acts on is that long, so such a line
  // is passed over byte by byte, and the read says how many it passed.
  await withLog(async (path) => {
    const huge = JSON.stringify({
      type: "response_item", payload: { type: "function_call_output", output: "y".repeat(CODEX_LINE_MAX_BYTES + 1) },
    }) + "\n";
    writeFileSync(path, turn("before") + huge + turn("after"));
    const read = await readCodexLog(path, 0, 0, { chunkBytes: 64 * 1024 });
    assert.deepEqual(read.replies.map((reply) => reply.text), ["before", "after"]);
    assert.equal(read.skipped, 1);
    assert.equal(read.offset, statSync(path).size);
    assert.equal(read.replies.at(-1).endsAt, read.offset);

    // One still being written when the file ends: the read stops inside it and the next
    // read resumes there, dropping the rest of it as the fragment it is.
    appendFileSync(path, huge.slice(0, -1));
    const inside = await readCodexLog(path, read.offset, 0, { chunkBytes: 64 * 1024 });
    assert.deepEqual(inside.replies, []);
    assert.equal(inside.skipped, 1);
    assert.equal(inside.offset, statSync(path).size);
    appendFileSync(path, "\n" + turn("later"));
    const later = await readCodexLog(path, inside.offset, 0, { chunkBytes: 64 * 1024 });
    assert.deepEqual(later.replies.map((reply) => reply.text), ["later"]);
    assert.equal(later.skipped, 0, "the fragment is not a line, and is not counted as one");
    assert.equal(later.offset, statSync(path).size);
  });
});

test("a line just under the cap is still read whole across chunks", async () => {
  await withLog(async (path) => {
    // Built by hand: `turn` repeats its text as the turn id, which would double the line.
    const long = `${JSON.stringify({
      type: "event_msg", timestamp: new Date().toISOString(),
      payload: { type: "task_complete", turn_id: "long", last_agent_message: "z".repeat(CODEX_LINE_MAX_BYTES - 200) },
    })}\n`;
    assert.ok(Buffer.byteLength(long) < CODEX_LINE_MAX_BYTES && Buffer.byteLength(long) > CODEX_LINE_MAX_BYTES - 200);
    writeFileSync(path, long + turn("after"));
    const read = await readCodexLog(path, 0, 0, { chunkBytes: 64 * 1024 });
    assert.deepEqual(read.replies.map((reply) => reply.text.length), [CODEX_LINE_MAX_BYTES - 200, 5]);
    assert.equal(read.skipped, 0);
  });
});

test("a read that ended inside an overlong line says so, and the next read discards to its end", async () => {
  // The fragment cannot be trusted to fail to parse: a line that is a megabyte of spaces
  // followed by a valid object parses perfectly from where the first read stopped. Codex
  // found this one.
  await withLog(async (path) => {
    writeFileSync(path, turn("before") + " ".repeat(CODEX_LINE_MAX_BYTES + 1));
    const first = await readCodexLog(path, 0, 0, { chunkBytes: 64 * 1024 });
    assert.deepEqual(first.replies.map((reply) => reply.text), ["before"]);
    assert.equal(first.skipped, 1);
    assert.equal(first.skipping, true, "the read stopped inside a line it is not keeping");
    assert.equal(first.offset, statSync(path).size);

    appendFileSync(path, turn("SHOULD-STAY-SKIPPED"));
    const second = await readCodexLog(path, first.offset, 0, { chunkBytes: 64 * 1024, skipping: first.skipping });
    assert.deepEqual(second.replies, [], "the rest of the overlong line is not a line of its own");
    assert.equal(second.skipping, false);
    assert.equal(second.offset, statSync(path).size);

    appendFileSync(path, turn("after"));
    const third = await readCodexLog(path, second.offset, 0, { chunkBytes: 64 * 1024, skipping: second.skipping });
    assert.deepEqual(third.replies.map((reply) => reply.text), ["after"]);
    assert.equal(third.skipping, false);
  });
});

test("skipping is only honoured for the cursor it was reported with", async () => {
  // A log rewritten shorter restarts at zero, and a flag about the old file's tail must
  // not swallow the new file's first line.
  await withLog(async (path) => {
    writeFileSync(path, turn("x".repeat(100)).repeat(50));
    const whole = await readCodexLog(path, 0, 0);
    writeFileSync(path, turn("fresh"));
    const rotated = await readCodexLog(path, whole.offset, 0, { skipping: true });
    assert.equal(rotated.from, 0);
    assert.deepEqual(rotated.replies.map((reply) => reply.text), ["fresh"]);
  });
});

test("where a pushed message's answer goes is written on the message", () => {
  assert.deepEqual(codexPushTarget("[Gyredeck · room sync-q468 — how to answer: write your reply…]\n\nhello"), { kind: "room", name: "sync-q468" });
  assert.deepEqual(codexPushTarget("[Gyredeck: you are now in sync room sync-q468 — someone put you in it.]"), { kind: "mailbox" });
  assert.deepEqual(codexPushTarget("[Gyredeck · mailbox — a message to you alone, from Claude Code.]\n\nhi"), { kind: "mailbox" });
  assert.equal(codexPushTarget("please summarise the build log"), null, "typed by the user");
  assert.equal(codexPushTarget("Gyredeck says hi"), null);
  assert.equal(codexPushTarget("[Gyredeck · room not-a-code — x]")?.kind, "mailbox", "a room name that is not one is not a room");
});

test("an aborted turn is an entry too, and entries keep file order", async () => {
  await withLog(async (path) => {
    const aborted = `${JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "turn_aborted", turn_id: "t2", reason: "interrupted" } })}\n`;
    writeFileSync(path, prompt("t1", "q1") + turn("a1") + prompt("t2", "q2") + aborted + prompt("t3", "q3") + turn("a3"));
    const read = await readCodexLog(path, 0, 0);
    assert.deepEqual(read.entries.map((entry) => `${entry.kind}:${entry.turnId}`), ["prompt:t1", "reply:a1", "prompt:t2", "aborted:t2", "prompt:t3", "reply:a3"]);
    assert.ok(read.entries.every((entry, index) => index === 0 || entry.endsAt > read.entries[index - 1].endsAt));
    assert.deepEqual(read.replies.map((reply) => reply.text), ["a1", "a3"]);
    assert.deepEqual(read.prompts.map((entry) => entry.turnId), ["t1", "t2", "t3"]);
  });
});

test("a turn's prompt is found by reading back from its answer, across chunk boundaries", async () => {
  await withLog(async (path) => {
    const filler = turn("f".repeat(3_000));
    writeFileSync(path, prompt("t-old", "old question") + turn("old answer") + prompt("t-x", "[Gyredeck · mailbox — hi]\n\nthe question") + filler.repeat(40) + turn("the answer"));
    const read = await readCodexLog(path, 0, 0);
    const answer = read.replies.at(-1);
    // Down to one byte, so a chunk begins on a line break — which once looped forever.
    for (const chunkBytes of [1, 7, 64, 1_000, 4_096, CODEX_READ_CHUNK_BYTES]) {
      const found = await findCodexPrompt(path, "t-x", answer.endsAt, { chunkBytes });
      assert.deepEqual(found, { found: true, text: "[Gyredeck · mailbox — hi]\n\nthe question" }, `chunk size ${chunkBytes}`);
    }
    assert.deepEqual(await findCodexPrompt(path, "t-missing", answer.endsAt, { chunkBytes: 64 }), { found: false, complete: true }, "searched to the start, and it is not there");
    assert.deepEqual(await findCodexPrompt(path, "t-old", answer.endsAt, { chunkBytes: 64 }), { found: true, text: "old question" }, "the first line of the file is a line too");
  });
});

test("a prompt further back than the lookback, or on a line too long to assemble, is not found", async () => {
  await withLog(async (path) => {
    writeFileSync(path, prompt("t-far", "far") + turn("x".repeat(20_000)) + turn("the answer"));
    const read = await readCodexLog(path, 0, 0);
    const answer = read.replies.at(-1);
    assert.deepEqual(await findCodexPrompt(path, "t-far", answer.endsAt, { chunkBytes: 1_000, lookbackBytes: 10_000 }), { found: false, complete: false }, "beyond the lookback: not found, and not everything was searched");
    assert.deepEqual(await findCodexPrompt(path, "t-far", answer.endsAt, { chunkBytes: 1_000, lookbackBytes: 100_000 }), { found: true, text: "far" }, "within it");

    writeFileSync(path, prompt("t-long", "l".repeat(CODEX_LINE_MAX_BYTES + 10)) + turn("the answer"));
    const long = await readCodexLog(path, 0, 0);
    assert.deepEqual(await findCodexPrompt(path, "t-long", long.offset, { chunkBytes: 64 * 1024 }), { found: false, complete: false }, "a line past the cap is not assembled, and the search does not claim to have covered it");
  });
});

test("looking a prompt up through a long stretch of short lines stays cheap and keeps yielding", async () => {
  // 4 MiB of `{}` lines, a prompt that is not there: the search has to cut every line.
  // Searching for the turn id past each line's end — to the chunk's end — re-read the lines
  // already cut, once per line: 7 s and a 442 ms stall on this fixture. Codex measured it.
  await withLog(async (path) => {
    writeFileSync(path, "{}\n".repeat((4 * 1024 * 1024) / 3));
    const size = statSync(path).size;
    let ticks = 0;
    let worstGap = 0;
    let last = Date.now();
    const ticker = setInterval(() => { const now = Date.now(); worstGap = Math.max(worstGap, now - last); last = now; ticks += 1; }, 1);
    const started = Date.now();
    let result;
    try {
      result = await findCodexPrompt(path, "0123456789abcdef0123456789abcdef", size);
    } finally {
      clearInterval(ticker);
    }
    const took = Date.now() - started;
    assert.deepEqual(result, { found: false, complete: true });
    assert.ok(took < 2_500, `took ${took} ms`);
    assert.ok(worstGap < 150, `the loop was held for ${worstGap} ms at worst`);
    assert.ok(ticks >= 5);
  });
});
