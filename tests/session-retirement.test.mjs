import assert from "node:assert/strict";
import test from "node:test";

const { isRetiredOneShot, ONE_SHOT_GRACE_MS, shouldRetireFromList } = await import(
  new URL("../apps/desktop/src/features/session/retirement.ts", import.meta.url).href
);

const AT = "2026-10-05T03:22:40.000Z";
const closeEvent = (timestamp = AT) => ({ type: "conversation_close", timestamp, data: { reason: "other" } });
const completeEvent = (client, timestamp = AT) => ({
  type: "turn_complete",
  timestamp,
  data: { hookEventName: "Stop", source: "codex-notify", client },
});

/** Newest first, the way the registry keeps a session's events. */
const session = (...events) => [...events].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

const justAfter = (events) =>
  new Date(Date.parse(events[0].timestamp) + ONE_SHOT_GRACE_MS + 1);
const during = (events) => new Date(Date.parse(events[0].timestamp) + 1_000);

test("a finished codex exec is kept on screen for its grace, then dropped", () => {
  const events = session(completeEvent("codex_exec"), closeEvent());
  assert.equal(isRetiredOneShot(events, during(events)), false, "gone before anyone could see it");
  assert.equal(isRetiredOneShot(events, justAfter(events)), true);
});

test("a codex-tui session that closed stays, because a completed row is sticky by contract", () => {
  const events = session(completeEvent("codex-tui"), closeEvent());
  assert.equal(isRetiredOneShot(events, justAfter(events)), false);
});

test("the close published before the completion still retires", () => {
  // This is the real order, not a hypothetical: the bridge holds a notify stop, so the
  // hook's own close reaches the log first and the completion that names the client
  // arrives a second and a half later. A rule that read the client off the close event
  // would never fire at all.
  const events = session(
    closeEvent("2026-10-05T03:22:39.836Z"),
    completeEvent("codex_exec", "2026-10-05T03:22:41.318Z"),
  );
  assert.equal(events[0].type, "turn_complete", "the completion is the newest event here");
  assert.equal(isRetiredOneShot(events, justAfter(events)), true);
});

test("a session nothing named the client of is left alone", () => {
  // Only Codex's notify is told which front end ran. A machine without that adapter says
  // nothing, and saying nothing must not be read as "one-shot" — that would retire the
  // sessions of everyone who has not installed it.
  const events = session(completeEvent(null), closeEvent());
  assert.equal(isRetiredOneShot(events, justAfter(events)), false);
});

test("a one-shot that has not closed is still running, however long it takes", () => {
  const events = session(completeEvent("codex_exec"));
  assert.equal(isRetiredOneShot(events, justAfter(events)), false);
});

test("a session with no events is nothing to retire", () => {
  assert.equal(isRetiredOneShot([], new Date()), false);
});

// ── The row a person is reading ──────────────────────────────────────────────────────

test("a one-shot whose detail is open is not retired under the person reading it", () => {
  // The grace exists so the row can be seen, and seeing it means being able to click it.
  // Retiring it on a timer regardless would throw the person out of the row the grace
  // invited them into.
  const events = session(completeEvent("codex_exec"), closeEvent());
  assert.equal(shouldRetireFromList("exec-1", events, justAfter(events), "exec-1"), false);
});

test("and it goes once they leave it", () => {
  const events = session(completeEvent("codex_exec"), closeEvent());
  const later = justAfter(events);
  assert.equal(shouldRetireFromList("exec-1", events, later, null), true);
  // Being in some other session is not being in this one.
  assert.equal(shouldRetireFromList("exec-1", events, later, "someone-else"), true);
});

test("a hook-first turn keeps its row, because nothing ever named its client", () => {
  // The client is only ever told to notify. Where the hook's stop is published first the
  // completion carries no client, and no amount of time may turn that silence into a
  // guess that the session was a one-shot.
  const events = session(completeEvent(undefined), closeEvent());
  assert.equal(shouldRetireFromList("hook-first", events, justAfter(events), null), false);
});
