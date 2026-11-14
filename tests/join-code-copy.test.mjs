import assert from "node:assert/strict";
import test from "node:test";

const module = new URL("../apps/desktop/src/features/mail/copyJoinCode.ts", import.meta.url);
const { copyJoinCode } = await import(module.href);

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test("#331 a join code minted for A is never copied once B is shown", async () => {
  let shown = "A";
  const mint = deferred();
  const written = [];
  const run = copyJoinCode({
    forSession: "A",
    shownSession: () => shown,
    mint: () => mint.promise,
    write: async (text) => { written.push(text); },
  });
  shown = "B";
  mint.resolve("CODE_FOR_A");
  assert.equal(await run, "stale");
  assert.deepEqual(written, []);
});

test("#331 a selection change during the clipboard write is never announced as copied", async () => {
  let shown = "A";
  const write = deferred();
  const run = copyJoinCode({
    forSession: "A",
    shownSession: () => shown,
    mint: async () => "CODE_FOR_A",
    write: () => write.promise,
  });
  await new Promise((r) => setImmediate(r));
  shown = "B";
  write.resolve();
  assert.equal(await run, "stale");
});

test("#331 a denied clipboard offers the code only while its own session is shown", async () => {
  let shown = "A";
  const denied = async () => { throw new Error("denied"); };
  assert.deepEqual(
    await copyJoinCode({ forSession: "A", shownSession: () => shown, mint: async () => "C", write: denied }),
    { fallback: "C" },
  );
  const late = copyJoinCode({
    forSession: "A",
    shownSession: () => shown,
    mint: async () => "C",
    write: async () => { shown = "B"; throw new Error("denied"); },
  });
  assert.equal(await late, "stale");
});

test("#331 the same session shown throughout copies, and no code copies nothing", async () => {
  const written = [];
  const write = async (text) => { written.push(text); };
  assert.equal(await copyJoinCode({ forSession: "A", shownSession: () => "A", mint: async () => "C", write }), "copied");
  assert.equal(await copyJoinCode({ forSession: "A", shownSession: () => "A", mint: async () => null, write }), "none");
  assert.deepEqual(written, ["C"]);
});
