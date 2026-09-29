import assert from "node:assert/strict";
import test from "node:test";

const { sessionGroupKey } = await import(
  new URL("../apps/desktop/src/features/session/grouping.ts", import.meta.url).href
);

const session = (conversationId, workspacePath, displayName = null) => ({
  conversationId,
  workspacePath,
  displayName,
});

test("sessions in one checkout share a group", () => {
  assert.equal(
    sessionGroupKey(session("a", "/Users/x/Workspace/thing")),
    sessionGroupKey(session("b", "/Users/x/Workspace/thing")),
  );
});

test("a session the person named stands on its own", () => {
  // The point of naming one is to pick it out. Left in the group its name would show only
  // if the group happened to title itself with it, and otherwise not until it was opened.
  const named = sessionGroupKey(session("b", "/Users/x/Workspace/thing", "the audit one"));
  const rest = sessionGroupKey(session("a", "/Users/x/Workspace/thing"));
  assert.notEqual(named, rest);
  assert.equal(named, "named:b");
});

test("a session with no checkout is already on its own", () => {
  assert.equal(sessionGroupKey(session("a", null)), "session:a");
});
