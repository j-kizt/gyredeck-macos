import assert from "node:assert/strict";
import test from "node:test";

const { pendingRepoState, relativeTime, settledRepoState } = await import(
  new URL("../apps/desktop/src/features/github/repoState.ts", import.meta.url).href
);

const status = (fields = {}) => ({ repo: "a/b", commit: null, runs: [], open_pr_count: 0, pulls: [], error: null, ...fields });
const expired = "GitHub token expired or invalid — re-add the account";

test("an empty status carrying the backend's error is the error state, not an empty repo (#379)", () => {
  const settled = settledRepoState(undefined, { data: status({ error: expired }) }, 5);
  assert.deepEqual(settled, { status: "error", message: expired });
});

test("the error keeps what the card showed before, as a refused call does", () => {
  const before = { status: "ready", data: status({ open_pr_count: 3 }), updatedAt: 1 };
  assert.deepEqual(settledRepoState(before, { data: status({ error: expired }) }, 5), {
    status: "error",
    message: expired,
    data: before.data,
    updatedAt: 1,
  });
  assert.deepEqual(settledRepoState(before, { message: "network down" }, 5), {
    status: "error",
    message: "network down",
    data: before.data,
    updatedAt: 1,
  });
});

test("a status with no error is ready", () => {
  const data = status({ open_pr_count: 2 });
  assert.deepEqual(settledRepoState(undefined, { data }, 5), { status: "ready", data, updatedAt: 5 });
});

test("ages go on to months and years (#379)", () => {
  const now = Date.parse("2026-11-18T00:00:00Z");
  const ago = (days) => new Date(now - days * 86_400_000).toISOString();
  assert.equal(relativeTime(ago(29.5), now), "29d ago");
  assert.equal(relativeTime(ago(29), now), "29d ago");
  assert.equal(relativeTime(ago(30), now), "1mo ago");
  assert.equal(relativeTime(ago(364), now), "12mo ago");
  assert.equal(relativeTime(ago(364.5), now), "12mo ago");
  assert.equal(relativeTime(ago(365), now), "1y ago");
  assert.equal(relativeTime(ago(3234), now), "8y ago");
  assert.equal(relativeTime(new Date(now - 90_000).toISOString(), now), "2m ago");
  assert.equal(relativeTime("not a date", now), "");
});

test("refresh after refresh: a second failure still keeps what the card showed (#379)", () => {
  const before = { status: "ready", data: status({ open_pr_count: 3 }), updatedAt: 1 };
  let state = pendingRepoState(before);
  assert.equal(state, before);
  state = settledRepoState(state, { data: status({ error: expired }) }, 5);
  state = pendingRepoState(state);
  assert.equal(state.status, "error");
  state = settledRepoState(state, { message: "network down" }, 9);
  assert.deepEqual(state, { status: "error", message: "network down", data: before.data, updatedAt: 1 });
  assert.deepEqual(pendingRepoState(undefined), { status: "loading" });
});

test("an error with nothing behind it stays shown while the next refresh runs (#379)", () => {
  let state = settledRepoState(undefined, { data: status({ error: expired }) }, 5);
  state = pendingRepoState(state);
  assert.deepEqual(state, { status: "error", message: expired });
  assert.deepEqual(settledRepoState(state, { message: "network down" }, 9), { status: "error", message: "network down" });
  const data = status({ open_pr_count: 1 });
  assert.deepEqual(settledRepoState(pendingRepoState(state), { data }, 9), { status: "ready", data, updatedAt: 9 });
});
