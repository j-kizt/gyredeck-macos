import assert from "node:assert/strict";
import test from "node:test";

const module = new URL(
  "../apps/desktop/src/features/notifications/usageAlerts.ts",
  import.meta.url,
);
const { bandOf, markOf, quotaAlertsBetween } = await import(module.href);

/** A provider reading in the shape the usage list holds one. */
const usageWith = (metrics, overrides = {}) => ({
  providerId: "claude",
  status: "online",
  stale: false,
  message: null,
  fetchedAt: "2026-09-15T09:00:00Z",
  metrics: metrics.map((metric) => ({
    label: "Weekly limit",
    groupLabel: null,
    groupModels: [],
    limitLabel: null,
    value: metric.leftPercent,
    resetLabel: null,
    statusLevel: "ok",
    statusLabel: "Available",
    remainingLabel: null,
    ...metric,
  })),
  ...overrides,
});

test("bands break at the three thresholds, and nowhere else", () => {
  assert.equal(bandOf(100), null);
  assert.equal(bandOf(21), null);
  assert.equal(bandOf(20), 20);
  assert.equal(bandOf(11), 20);
  assert.equal(bandOf(10), 10);
  assert.equal(bandOf(1), 10);
  assert.equal(bandOf(0), 0);
  // A metric the provider gave no figure for cannot have crossed anything.
  assert.equal(bandOf(null), null);
});

test("running out is its own crossing, and is said once", () => {
  const before = markOf(usageWith([{ leftPercent: 6 }]));
  const [alert] = quotaAlertsBetween(before, usageWith([{ leftPercent: 0 }]), "Antigravity");
  assert.equal(alert.threshold, 0);
  assert.equal(alert.leftPercent, 0);

  // Still empty on the next poll, and every poll after: there is nothing below zero to
  // cross into, so the same mechanism that stops the other bands repeating covers this.
  const empty = usageWith([{ leftPercent: 0 }]);
  assert.deepEqual(quotaAlertsBetween(markOf(empty), empty, "Antigravity"), []);
});

test("emptying from full says only that it is empty", () => {
  const before = markOf(usageWith([{ leftPercent: 100 }]));
  const alerts = quotaAlertsBetween(before, usageWith([{ leftPercent: 0 }]), "Antigravity");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].threshold, 0);
});

test("a first look is not news", () => {
  // Opening the app to find quota already spent is a state, not an event.
  const usage = usageWith([{ leftPercent: 4 }]);
  assert.deepEqual(quotaAlertsBetween(undefined, usage, "Claude Code"), []);
});

test("crossing into a band is reported once, not on every poll after", () => {
  const before = markOf(usageWith([{ leftPercent: 25 }]));
  const crossed = usageWith([{ leftPercent: 18 }]);
  const [alert] = quotaAlertsBetween(before, crossed, "Claude Code");
  assert.equal(alert.threshold, 20);
  assert.equal(alert.leftPercent, 18);
  assert.equal(alert.providerLabel, "Claude Code");

  // Still falling, still in the same band: a poller returns the figure every fifteen
  // minutes, and "currently low" would interrupt four times an hour.
  const lower = usageWith([{ leftPercent: 12 }]);
  assert.deepEqual(quotaAlertsBetween(markOf(crossed), lower, "Claude Code"), []);
});

test("the second threshold is its own crossing", () => {
  const before = markOf(usageWith([{ leftPercent: 15 }]));
  const [alert] = quotaAlertsBetween(before, usageWith([{ leftPercent: 9 }]), "Claude Code");
  assert.equal(alert.threshold, 10);
});

test("two thresholds crossed at once report the lower one alone", () => {
  // The answer to "how bad is it" is 10%; a second banner saying 20% only argues.
  const before = markOf(usageWith([{ leftPercent: 60 }]));
  const alerts = quotaAlertsBetween(before, usageWith([{ leftPercent: 3 }]), "Claude Code");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].threshold, 10);
});

test("quota refilling is silent, and arms the next crossing", () => {
  const spent = usageWith([{ leftPercent: 5 }]);
  const reset = usageWith([{ leftPercent: 100 }]);
  assert.deepEqual(quotaAlertsBetween(markOf(spent), reset, "Claude Code"), []);

  const [alert] = quotaAlertsBetween(markOf(reset), usageWith([{ leftPercent: 17 }]), "Claude Code");
  assert.equal(alert.threshold, 20);
});

test("a stale reading never fires, however low it reads", () => {
  // Three paths set `stale`, and in all of them the number is real but old. Old is not
  // evidence that quota has just fallen.
  const before = markOf(usageWith([{ leftPercent: 80 }]));
  for (const overrides of [
    { stale: true },
    { status: "error" },
    { status: "loading" },
  ]) {
    const usage = usageWith([{ leftPercent: 2 }], overrides);
    assert.deepEqual(quotaAlertsBetween(before, usage, "Claude Code"), [], JSON.stringify(overrides));
  }
});

test("a metric seen for the first time is a first look of its own", () => {
  // Providers add and rename metrics; one appearing already low has not crossed.
  const before = markOf(usageWith([{ label: "Weekly limit", leftPercent: 90 }]));
  const after = usageWith([
    { label: "Weekly limit", leftPercent: 90 },
    { label: "Five hour limit", leftPercent: 4 },
  ]);
  assert.deepEqual(quotaAlertsBetween(before, after, "Claude Code"), []);
});

test("each metric is judged on its own, and named with its group", () => {
  const before = markOf(usageWith([
    { label: "Weekly limit", leftPercent: 50 },
    { label: "Five hour limit", leftPercent: 50 },
  ]));
  const after = usageWith([
    { label: "Weekly limit", leftPercent: 50 },
    { label: "Five hour limit", leftPercent: 8, groupLabel: "Gemini models" },
  ]);
  const alerts = quotaAlertsBetween(before, after, "Antigravity");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].threshold, 10);
  assert.equal(alerts[0].metricLabel, "Gemini models · Five hour limit");
});

test("a metric that stops reporting a figure says nothing", () => {
  const before = markOf(usageWith([{ leftPercent: 30 }]));
  const after = usageWith([{ leftPercent: null }]);
  assert.deepEqual(quotaAlertsBetween(before, after, "Claude Code"), []);
});
