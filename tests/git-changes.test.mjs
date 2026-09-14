import assert from "node:assert/strict";
import test from "node:test";

const module = new URL(
  "../apps/desktop/src/features/notifications/gitChanges.ts",
  import.meta.url,
);
const { gitChangesBetween, markOf } = await import(module.href);

/** A repo snapshot in the shape the Git monitor returns one. */
const repoWith = ({ runs = [], pulls = [], sha = "aaaaaaa1", message = "first" } = {}) => ({
  repo: "j-kizt/gyredeck-macos",
  commit: { sha, message, author: "someone", committed_at: "2026-09-14T09:00:00Z" },
  runs,
  open_pr_count: pulls.length,
  pulls,
  error: null,
});

const run = (overrides) => ({
  name: "check",
  status: "completed",
  conclusion: "success",
  branch: "main",
  created_at: "2026-09-14T09:00:00Z",
  ...overrides,
});

test("a first look is not news", () => {
  // There is no before to compare against, and announcing every repo's existing state
  // at launch is how a person learns to dismiss these without reading them.
  const status = repoWith({ runs: [run({ conclusion: "failure" })] });
  assert.deepEqual(gitChangesBetween(undefined, status), []);
});

test("a run that is still going is not reported until it concludes", () => {
  const before = markOf(repoWith({ runs: [] }));
  const running = repoWith({ runs: [run({ status: "in_progress", conclusion: null })] });
  assert.deepEqual(gitChangesBetween(before, running), []);

  const finished = repoWith({ runs: [run({ conclusion: "failure" })] });
  const [change] = gitChangesBetween(markOf(running), finished);
  assert.equal(change.kind, "ci-failed");
  assert.match(change.title, /CI failed/);
});

test("a failure is reported once, not every poll while it stays broken", () => {
  // A poll returns the current state every minute; "currently failing" would notify
  // sixty times an hour for one broken run.
  const failed = repoWith({ runs: [run({ conclusion: "failure" })] });
  const mark = markOf(failed);
  assert.equal(gitChangesBetween(mark, failed).length, 0);
});

test("a re-run of the same workflow is news again", () => {
  // Same name, later timestamp: somebody pushed a fix, and how that went is the thing
  // being waited on. Keying on name alone would swallow it.
  const first = repoWith({ runs: [run({ conclusion: "failure" })] });
  const second = repoWith({
    runs: [run({ conclusion: "success", created_at: "2026-09-14T09:30:00Z" })],
  });
  const [change] = gitChangesBetween(markOf(first), second);
  assert.equal(change.kind, "ci-passed");
});

test("a new pull request is reported, and an existing one is not", () => {
  const before = markOf(repoWith({ pulls: [{ number: 1, title: "one", author: "a", updated_at: "x" }] }));
  const after = repoWith({
    pulls: [
      { number: 1, title: "one", author: "a", updated_at: "x" },
      { number: 2, title: "two", author: "b", updated_at: "y" },
    ],
  });
  const changes = gitChangesBetween(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "pull-opened");
  assert.match(changes[0].body, /#2 two/);

  // A pull request closing is not something to interrupt anyone for.
  assert.deepEqual(gitChangesBetween(markOf(after), repoWith({ pulls: [] })), []);
});

test("a new commit is reported with its subject", () => {
  const before = markOf(repoWith({ sha: "aaaaaaa1" }));
  const after = repoWith({ sha: "bbbbbbb2", message: "fix: the thing\n\nbody text" });
  const [change] = gitChangesBetween(before, after);
  assert.equal(change.kind, "commit-landed");
  assert.match(change.body, /^bbbbbbb fix: the thing$/);
});

test("several things at once are reported separately", () => {
  // They ask for different actions, so they are not collapsed into one banner.
  const before = markOf(repoWith({ sha: "aaaaaaa1", runs: [], pulls: [] }));
  const after = repoWith({
    sha: "bbbbbbb2",
    runs: [run({ conclusion: "failure" })],
    pulls: [{ number: 9, title: "nine", author: "c", updated_at: "z" }],
  });
  const kinds = gitChangesBetween(before, after).map((change) => change.kind).sort();
  assert.deepEqual(kinds, ["ci-failed", "commit-landed", "pull-opened"]);
});
