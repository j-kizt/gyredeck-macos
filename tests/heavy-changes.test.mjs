import assert from "node:assert/strict";
import test from "node:test";

const { heavyChangesBetween, heavyMarkOf, heavyDuration } = await import(
  new URL("../apps/desktop/src/features/notifications/heavyChanges.ts", import.meta.url).href
);

/** `GET /heavy` (and the native `heavy_state` event) in the shape the bridge answers. */
const state = ({ holder = null, queue = [], observed = [], load = 1 } = {}) => ({ ok: true, v: 1, load, loadLimit: 5, holder, queue, observed, waiting: queue.length, limit: "" });
const helperRun = (overrides = {}) => ({ id: "a1a1a1a1a1a1a1a1", as: "s-gyre", label: "Claude Code / Gyre Assistant", what: "test:hooks", state: "active", since: "2026-10-26T01:00:00Z", elapsedMs: 252_000, loadSkipped: false, helperGone: false, ...overrides });
const observedRun = (overrides = {}) => ({ pid: 4242, pattern: "cargo test|build|check", exe: "cargo", cwd: "/tmp/p", label: "Terminal", startedAtMs: 1_790_000_000_000, elapsedMs: 65_000, ...overrides });
const waiter = (overrides = {}) => ({ id: "c3c3c3c3c3c3c3c3", position: 1, as: "s-audit", label: "Codex / Gyredesk Audit", what: "cargo check", waitedMs: 3_000, ...overrides });

/** Each step's changes, the mark carried from one look to the next as the hook carries it. */
const walk = (looks) => {
  let mark;
  return looks.map((look) => {
    const changes = heavyChangesBetween(mark, look);
    mark = heavyMarkOf(look);
    return changes.map((change) => `${change.kind}: ${change.title} — ${change.body}`);
  });
};

test("C1: a first look is never news, whatever it holds", () => {
  const busy = state({ holder: helperRun(), queue: [waiter()], observed: [observedRun()] });
  // Premise: the same state against an empty mark is three pieces of news.
  assert.equal(heavyChangesBetween(heavyMarkOf(state()), busy).length, 3);
  assert.deepEqual(heavyChangesBetween(undefined, busy), []);
});

test("C2 and C3: one start and one end per run, for helper and observed runs alike — table", () => {
  const cases = [
    {
      name: "a helper run starts, holds, ends",
      looks: [state(), state({ holder: helperRun() }), state({ holder: helperRun({ elapsedMs: 257_000 }) }), state()],
      want: [[], ["started: Claude Code / Gyre Assistant started a heavy run — test:hooks"], [], ["ended: test:hooks finished (4m 17s) — Claude Code / Gyre Assistant"]],
    },
    {
      name: "a reservation that never ran is not a run",
      looks: [state(), state({ holder: helperRun({ state: "reserved" }) }), state()],
      want: [[], [], []],
    },
    {
      name: "the same session's next run is a new start (a new holder id)",
      looks: [state(), state({ holder: helperRun() }), state({ holder: helperRun({ id: "b2b2b2b2b2b2b2b2", since: "2026-10-26T01:10:00Z", elapsedMs: 1_000 }) })],
      want: [[], ["started: Claude Code / Gyre Assistant started a heavy run — test:hooks"], ["started: Claude Code / Gyre Assistant started a heavy run — test:hooks", "ended: test:hooks finished (4m 12s) — Claude Code / Gyre Assistant"]],
    },
    {
      name: "an observed run gets the same messages, named as Settings names it",
      looks: [state(), state({ observed: [observedRun()] }), state({ observed: [observedRun({ elapsedMs: 70_000 })] }), state()],
      want: [[], ["started: Terminal started a heavy run — cargo test|build|check"], [], ["ended: cargo test|build|check finished (1m 10s) — Terminal"]],
    },
    {
      name: "a reused pid with another start is another observed run",
      looks: [state(), state({ observed: [observedRun()] }), state({ observed: [observedRun({ startedAtMs: 1_790_000_600_000, label: "Codex", elapsedMs: 2_000 })] })],
      want: [[], ["started: Terminal started a heavy run — cargo test|build|check"], ["started: Codex started a heavy run — cargo test|build|check", "ended: cargo test|build|check finished (1m 5s) — Terminal"]],
    },
    {
      name: "someone waits behind the holder, once",
      looks: [state({ holder: helperRun() }), state({ holder: helperRun(), queue: [waiter()] }), state({ holder: helperRun(), queue: [waiter({ waitedMs: 8_000 })] })],
      want: [[], ["waiting: Codex / Gyredesk Audit is waiting behind Claude Code / Gyre Assistant — cargo check"], []],
    },
    {
      name: "someone waits behind an observed run",
      looks: [state({ observed: [observedRun()] }), state({ observed: [observedRun()], queue: [waiter()] })],
      want: [[], ["waiting: Codex / Gyredesk Audit is waiting behind Terminal — cargo check"]],
    },
    {
      name: "someone waits for the load to drop (Q23)",
      looks: [state({ load: 6.14 }), state({ load: 6.14, queue: [waiter()] })],
      want: [[], ["waiting: Codex / Gyredesk Audit is waiting for the load to drop (6.1 > 5) — cargo check"]],
    },
  ];
  for (const { name, looks, want } of cases) assert.deepEqual(walk(looks), want, name);
});

test("C4: a mark taken every look releases no backlog when the toggle comes back on", () => {
  // The hook takes the mark on every look, toggle or not, and reports only while on.
  const looks = [state(), state({ holder: helperRun() }), state(), state({ observed: [observedRun()] }), state({ observed: [observedRun()] })];
  const on = [true, false, false, false, true];
  let mark;
  const reported = looks.map((look, index) => {
    const changes = heavyChangesBetween(mark, look);
    mark = heavyMarkOf(look);
    return on[index] ? changes.length : 0;
  });
  // Premise: three things happened while the toggle was off.
  assert.equal(walk(looks).slice(1, 4).flat().length, 3);
  assert.deepEqual(reported, [0, 0, 0, 0, 0], "turning it back on says nothing about what came and went");
});

test("durations read as the room notices say them", () => {
  assert.equal(heavyDuration(40_000), "40s");
  assert.equal(heavyDuration(252_000), "4m 12s");
  assert.equal(heavyDuration(3_900_000), "1h 5m");
});
