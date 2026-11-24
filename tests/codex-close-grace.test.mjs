import assert from "node:assert/strict";
import test from "node:test";

import { codexCloseGraceMs } from "../adapters/bridge/gyredeck-bridge.mjs";

test("#380: a Codex thread keeps its room seat for an hour after an unexplained close, unless overridden", () => {
  assert.equal(codexCloseGraceMs({}), 60 * 60 * 1000, "the default grace is one hour");
  assert.equal(codexCloseGraceMs({ GYREDECK_CODEX_CLOSE_GRACE_MS: "3000" }), 3000, "the override wins");
  assert.equal(codexCloseGraceMs({ GYREDECK_CODEX_CLOSE_GRACE_MS: "nonsense" }), 60 * 60 * 1000, "a bad override falls back to the hour");
});
