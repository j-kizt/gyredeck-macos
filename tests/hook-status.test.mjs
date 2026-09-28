import assert from "node:assert/strict";
import test from "node:test";

const module = new URL("../apps/desktop/src/features/setup/hookStatus.ts", import.meta.url);
const { hookNeedsAttention } = await import(module.href);

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
