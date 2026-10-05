import assert from "node:assert/strict";
import test from "node:test";

const module = new URL("../apps/desktop/src/features/setup/hookStatus.ts", import.meta.url);
const { codexTrustCopy, hookNeedsAttention, hookSettled } = await import(module.href);

const status = (installed, stale) => ({ path: "/Users/x/.config/gyredeck/hook.mjs", installed, stale });

test("a current install is not something to point at", () => {
  assert.equal(hookNeedsAttention(status(true, false)), false);
});

test("an out-of-date install is", () => {
  assert.equal(hookNeedsAttention(status(true, true)), true);
});

test("an install whose currency could not be worked out is too", () => {
  // The reason `stale` has three states. Reading unknown as fine collapses it back into a
  // boolean and hides exactly the case the third state was added for: a hook that is
  // there, cannot be compared against what this build ships, and may well be stale.
  assert.equal(hookNeedsAttention(status(true, null)), true);
});

test("nothing installed is nothing to reinstall", () => {
  // Not installed is an offer, not a warning — the row already says Install.
  assert.equal(hookNeedsAttention(status(false, null)), false);
  // Still being looked up, which every status is for the first moment of every launch.
  // Flagging it would put a red dot on the gear every time the window opens.
  assert.equal(hookNeedsAttention(status(null, null)), false);
});

const { codexCanSync } = await import(module.href);
const notify = (installed, stale) => ({ path: "/Users/x/.config/gyredeck/notify.mjs", installed, stale });

test("Codex is offered sync only when the adapter that carries the password is current", () => {
  assert.equal(codexCanSync(status(true, false), notify(true, false)), true);
});

test("a Codex hook alone is not enough", () => {
  // The hook never sees a prompt. Without notify there is no way for a typed password to
  // reach the bridge, and the room the person opens would never let the session speak.
  assert.equal(codexCanSync(status(true, false), notify(false, null)), false);
});

test("an out-of-date notify is not enough either", () => {
  // Updating the app does not replace what is installed in ~/.config/gyredeck. A notify
  // from before this existed has no confirm path in it, and fails exactly as silently.
  assert.equal(codexCanSync(status(true, false), notify(true, true)), false);
});

test("nothing is decided while anything is still unknown", () => {
  assert.equal(codexCanSync(status(null, null), notify(true, false)), null);
  assert.equal(codexCanSync(status(true, false), notify(null, null)), null);
  assert.equal(codexCanSync(status(true, false), notify(true, null)), null);
});

// ── Codex approval ───────────────────────────────────────────────────────────────────

const codex = (trust) => ({ ...status(true, false), trust });

test("a Codex hook Codex has approved is not something to point at", () => {
  assert.equal(hookNeedsAttention(codex("approved")), false);
});

test("one Codex has not approved is, however current the install", () => {
  // The false green this exists to remove: installed and current, and skipped by Codex
  // without a word because nobody approved it in /hooks.
  for (const trust of ["untrusted", "modified", "disabled"]) {
    assert.equal(hookNeedsAttention(codex(trust)), true, trust);
  }
});

test("an approval that could not be read keeps the checkmark off, without the danger dot", () => {
  // The dot is drawn in the danger colour, and one timeout from a slow app-server is not
  // evidence that a hook is broken. The row still withholds its checkmark — Recheck is
  // right there — but nothing turns red over a question that went unanswered.
  assert.equal(hookNeedsAttention(codex("unknown")), false);
  assert.equal(hookSettled(codex("unknown")), false);
});

test("while Codex is being asked, the row is not settled — this is the false green the work removes", () => {
  // Straight after Install the row used to read installed-and-current and draw a
  // checkmark while the question was still on its way to Codex. Being asked is neither
  // a finding nor a pass.
  assert.equal(hookSettled(codex(null)), false);
  assert.equal(hookNeedsAttention(codex(null)), false);
});

test("only an approved Codex hook is settled", () => {
  assert.equal(hookSettled(codex("approved")), true);
  for (const trust of ["untrusted", "modified", "disabled", "unknown", null]) {
    assert.equal(hookSettled(codex(trust)), false, String(trust));
  }
});

test("rows that have no approval to ask about are settled as before", () => {
  assert.equal(hookSettled(status(true, false)), true);
  assert.equal(hookSettled(status(true, true)), false);
});

test("every state that is not approved tells the person what to do, and it is never reinstall", () => {
  for (const trust of ["untrusted", "modified", "disabled", "unknown"]) {
    const copy = codexTrustCopy(trust);
    assert.ok(copy, trust);
    assert.match(copy.step, /\/hooks/, `${trust} points at where approval happens`);
    assert.doesNotMatch(copy.step, /reinstall/i, `${trust} — reinstalling changes nothing, or makes it worse`);
  }
  assert.equal(codexTrustCopy("approved"), null);
  assert.match(codexTrustCopy(null).detail, /checking/i, "being asked says so");
});
