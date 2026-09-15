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
