import assert from "node:assert/strict";
import test from "node:test";

const { createRegistryWriter } = await import(
  new URL("../apps/desktop/src/features/session/registryWriter.ts", import.meta.url).href
);

/**
 * The order of saves, failures and retries for the session registry (#280), on a fake clock
 * and a fake store whose saves run one after another, as the app's do.
 */
const harness = ({ failFirst = false } = {}) => {
  const timers = [];
  const store = { kept: null, calls: [], queue: Promise.resolve(), gates: [] };
  const writer = createRegistryWriter({
    delayMs: 2000,
    setTimer: (run) => { timers.push(run); return timers.length; },
    clearTimer: () => {},
    write: (registry) => {
      const call = store.calls.length;
      store.calls.push(registry);
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      store.gates.push(release);
      const done = store.queue.then(() => gate).then(() => {
        if (failFirst && call === 0) return false;
        store.kept = registry;
        return true;
      });
      store.queue = done;
      return done;
    },
  });
  const tick = async () => {
    const due = timers.splice(0);
    for (const run of due) run();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const settle = async (index) => {
    store.gates[index]();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { writer, store, tick, settle };
};

test("a slow save that fails never brings an older registry back over a newer one", async () => {
  const { writer, store, tick, settle } = harness({ failFirst: true });
  writer.ready({});
  const three = { a: [1, 2, 3] };
  const five = { a: [1, 2, 3, 4, 5] };
  writer.update(three);
  await tick(); // save of three starts, and stays in flight
  writer.update(five);
  await tick(); // save of five queues behind it
  await settle(0); // three fails
  await settle(1); // five lands
  for (let round = 0; round < 3; round += 1) {
    await tick();
    for (let index = 2; index < store.gates.length; index += 1) await settle(index);
  }
  assert.equal(store.kept, five, "the newest registry stays kept");
  assert.ok(!store.calls.slice(2).includes(three), "the failed registry is never saved again");
});

test("nothing is saved before the read, and a registry already stored is not saved again", async () => {
  const { writer, store, tick } = harness();
  writer.update({ early: [1] });
  await tick();
  assert.equal(store.calls.length, 0, "not before ready");
  const stored = { kept: [1] };
  writer.ready(stored);
  writer.update(stored);
  await tick();
  assert.equal(store.calls.length, 0, "what is stored is not saved again");
});

test("a failed save on a quiet app is retried until it lands", async () => {
  const { writer, store, tick, settle } = harness({ failFirst: true });
  writer.ready(null);
  const only = { a: [1] };
  writer.update(only);
  await tick();
  await settle(0); // fails
  await tick(); // retry
  await settle(1);
  assert.equal(store.kept, only);
});
