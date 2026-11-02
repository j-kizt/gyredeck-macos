import assert from "node:assert/strict";
import test from "node:test";

const { MAX_STORED_CONVERSATIONS, pruneSessionEventRegistry, pruneTombstones, SESSION_RETENTION_MS } = await import(
  new URL("../apps/desktop/src/features/session/retention.ts", import.meta.url).href
);

/**
 * Stored session data is bounded by age and count, and clearing a tombstone never brings a
 * session back (#280).
 */
const NOW = new Date("2026-11-02T03:00:00.000Z");
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const events = (...timestamps) => timestamps.map((timestamp, index) => ({ id: `e${index}`, timestamp }));

test("a conversation whose newest event is past 30 days goes; one with any event inside stays", () => {
  const registry = {
    old: events(ago(31 * DAY), ago(40 * DAY)),
    edge: events(ago(SESSION_RETENTION_MS)),
    mixed: events(ago(29 * DAY), ago(90 * DAY)),
    fresh: events(ago(60_000)),
    undated: events("not a date"),
  };
  assert.deepEqual(Object.keys(pruneSessionEventRegistry(registry, NOW)).sort(), ["edge", "fresh", "mixed"]);
});

test("at most 200 conversations are kept, the newest, deterministically", () => {
  const registry = Object.fromEntries(
    Array.from({ length: 250 }, (_, index) => [`c${String(index).padStart(3, "0")}`, events(ago(index * 60_000))]),
  );
  const kept = Object.keys(pruneSessionEventRegistry(registry, NOW)).sort();
  assert.equal(kept.length, MAX_STORED_CONVERSATIONS);
  assert.deepEqual(kept, Object.keys(registry).slice(0, MAX_STORED_CONVERSATIONS));
});

test("nothing to clear hands back the same object, so an unchanged registry is not saved again", () => {
  const registry = { fresh: events(ago(1000)) };
  assert.equal(pruneSessionEventRegistry(registry, NOW), registry);
  const tombstones = { a: NOW.getTime() };
  assert.equal(pruneTombstones(tombstones, NOW, new Set()), tombstones);
});

test("a tombstone past 30 days is cleared, unless its conversation is still known", () => {
  const tombstones = { gone: NOW.getTime() - 31 * DAY, known: NOW.getTime() - 31 * DAY, recent: NOW.getTime() - DAY, legacy: 0 };
  assert.deepEqual(Object.keys(pruneTombstones(tombstones, NOW, new Set(["known"]))).sort(), ["known", "recent"]);
});

test("no resurrection: a cleared tombstone only ever hid a conversation the registry clears too", () => {
  // A tombstone hides a conversation while it is at or after its newest event. Every
  // conversation such a stale tombstone could hide has its newest event before the cutoff.
  const dismissedAt = NOW.getTime() - 31 * DAY;
  const hidden = { quiet: events(ago(35 * DAY)) };
  assert.deepEqual(pruneSessionEventRegistry(hidden, NOW), {}, "the data it hid is cleared with it");
  assert.deepEqual(pruneTombstones({ quiet: dismissedAt }, NOW, new Set(Object.keys(pruneSessionEventRegistry(hidden, NOW)))), {});
  // A conversation with a newer event was never hidden by that tombstone, so it shows either way.
  const active = { busy: events(ago(DAY)) };
  assert.ok(Date.parse(active.busy[0].timestamp) > dismissedAt);
  // And while anything still names it, the tombstone stays.
  assert.deepEqual(Object.keys(pruneTombstones({ busy: dismissedAt }, NOW, new Set(["busy"]))), ["busy"]);
});

test("inside a kept conversation, events past 30 days go too", () => {
  const kept = pruneSessionEventRegistry({ mixed: events(ago(DAY), ago(40 * DAY)) }, NOW);
  assert.deepEqual(kept.mixed.map((event) => event.id), ["e0"]);
});

test("a timestamp more than a day ahead is not believed: it keeps nothing alive", () => {
  const kept = pruneSessionEventRegistry({ future: events("9999-01-01T00:00:00.000Z"), soon: events(ago(-60 * 60 * 1000)) }, NOW);
  assert.deepEqual(Object.keys(kept), ["soon"], "an hour ahead is clock skew; year 9999 is not");
});

test("the open conversation is kept whole, whatever its age or rank", () => {
  const registry = Object.fromEntries(
    Array.from({ length: 201 }, (_, index) => [`c${String(index).padStart(3, "0")}`, events(ago(index * 60_000))]),
  );
  registry.old = events(ago(90 * DAY));
  const kept = pruneSessionEventRegistry(registry, NOW, "c200");
  assert.ok("c200" in kept, "the 201st, open, stays");
  assert.equal(Object.keys(kept).length, MAX_STORED_CONVERSATIONS);
  assert.ok(!("c199" in kept), "it takes a place, it does not add one");
  assert.deepEqual(pruneSessionEventRegistry(registry, NOW, "old").old, registry.old, "an old open one stays whole");
});
