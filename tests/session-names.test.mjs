import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { SESSION_NAME_MAX, cleanSessionName, readSessionNames } = await import(
  new URL("../adapters/bridge/gyredeck-bridge.mjs", import.meta.url).href
);

test("a name is what is left after trimming", () => {
  assert.equal(cleanSessionName("  the audit one  "), "the audit one");
});

test("nothing is a name", () => {
  // How a person takes a name back: clear the field. There is no separate way out, so
  // empty has to mean this rather than being kept as an empty string nobody can see.
  assert.equal(cleanSessionName(""), null);
  assert.equal(cleanSessionName("   "), null);
  assert.equal(cleanSessionName(undefined), null);
  assert.equal(cleanSessionName(42), null);
});

test("a name cannot break the line it is printed on", () => {
  // A room roster and a session row are both single lines of text. A newline in the
  // middle of a name would have the room appear to say something nobody said.
  assert.equal(cleanSessionName("audit\nsession"), "audit session");
  assert.equal(cleanSessionName("audit\u0000\u001bsession"), "audit session");
  assert.equal(cleanSessionName("audit\t \t session"), "audit session");
});

test("a name is bounded", () => {
  const long = "x".repeat(SESSION_NAME_MAX + 20);
  assert.equal(cleanSessionName(long).length, SESSION_NAME_MAX);
});

test("a file that is not there is no names, not an error", async () => {
  assert.deepEqual([...readSessionNames("/nowhere/at/all.json")], []);
});

test("junk in the file is skipped rather than believed", async () => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-names-"));
  try {
    const path = join(home, "names.json");
    await writeFile(path, JSON.stringify({
      good: "  the audit one  ",
      empty: "   ",
      wrong: 7,
      long: "y".repeat(SESSION_NAME_MAX + 5),
    }));
    const names = readSessionNames(path);
    assert.equal(names.get("good"), "the audit one");
    assert.equal(names.has("empty"), false);
    assert.equal(names.has("wrong"), false);
    assert.equal(names.get("long").length, SESSION_NAME_MAX);

    // A file somebody has edited by hand, or half written, names nobody rather than
    // taking the bridge down on the way up.
    await writeFile(path, "{ not json");
    assert.deepEqual([...readSessionNames(path)], []);
    await writeFile(path, JSON.stringify(["a", "b"]));
    assert.deepEqual([...readSessionNames(path)], []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const { SESSION_KIND_MEMORY, readSessionKinds } = await import(
  new URL("../adapters/bridge/gyredeck-bridge.mjs", import.meta.url).href
);

test("what is known about a session survives a restart, and junk in the file does not", async () => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-kinds-"));
  try {
    const path = join(home, "kinds.json");
    await writeFile(path, JSON.stringify({
      good: { provider: "codexCliHook", cwd: "/Users/x/Workspace/thing" },
      onlyCwd: { cwd: "/Users/x/other" },
      onlyProvider: { provider: "claudeCodeHook" },
      // A provider is a kind name, not free text: it reaches a room's roster, and a
      // roster is a sentence.
      shouty: { provider: "codex\nCliHook", cwd: "/tmp/x" },
      empty: {},
      wrong: "codexCliHook",
    }));
    const kinds = readSessionKinds(path);
    assert.deepEqual(kinds.get("good"), { provider: "codexCliHook", cwd: "/Users/x/Workspace/thing" });
    assert.deepEqual(kinds.get("onlyCwd"), { provider: null, cwd: "/Users/x/other" });
    assert.deepEqual(kinds.get("onlyProvider"), { provider: "claudeCodeHook", cwd: null });
    assert.deepEqual(kinds.get("shouty"), { provider: null, cwd: "/tmp/x" });
    assert.equal(kinds.has("empty"), false);
    assert.equal(kinds.has("wrong"), false);

    await writeFile(path, "{ half writ");
    assert.deepEqual([...readSessionKinds(path)], []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a file that was never written is nothing known, not a failure to start", () => {
  assert.deepEqual([...readSessionKinds("/nowhere/kinds.json")], []);
  assert.ok(SESSION_KIND_MEMORY > 0);
});

const { writePrivateJson } = await import(
  new URL("../adapters/bridge/gyredeck-bridge.mjs", import.meta.url).href
);

test("a private file is replaced, not written into, and never through a symlink", async () => {
  const home = await mkdtemp(join(tmpdir(), "gyredeck-write-"));
  try {
    const path = join(home, "names.json");

    // A file that already exists with the wrong mode: writeFileSync would have left it,
    // because the mode it takes only applies when it creates the file.
    await writeFile(path, JSON.stringify({ a: "one" }));
    await chmod(path, 0o644);
    writePrivateJson(path, { a: "two" });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { a: "two" });

    // A symlink where the file should be: the target must not be written through, and
    // what is left behind must be the real file.
    const target = join(home, "elsewhere.json");
    const link = join(home, "linked.json");
    await writeFile(target, "do not touch");
    await symlink(target, link);
    writePrivateJson(link, { a: "three" });
    assert.equal(await readFile(target, "utf8"), "do not touch");
    assert.equal((await lstat(link)).isSymbolicLink(), false);
    assert.equal((await stat(link)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(link, "utf8")), { a: "three" });

    // And a write that cannot happen leaves what was there.
    await chmod(home, 0o500);
    assert.throws(() => writePrivateJson(path, { a: "four" }));
    await chmod(home, 0o700);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { a: "two" });
  } finally {
    await chmod(home, 0o700).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});
