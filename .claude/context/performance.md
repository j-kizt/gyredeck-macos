# Performance budgets

Agent Activity treats performance claims as local regression evidence, not universal guarantees. Measure on the same machine, with the same deterministic workloads, and compare medians/p95 rather than one run.

`pnpm test:performance` builds the desktop web bundle and then runs three evidence layers:

```
pnpm desktop:web:build
  && node scripts/check-performance-budget.mjs
  && node scripts/benchmark-session-model.mjs --assert
  && node scripts/benchmark-bridge.mjs --events=5000 --assert
```

## 1. Bundle budget — `scripts/check-performance-budget.mjs`

Gzips the largest CSS and JavaScript assets in `apps/desktop/dist/assets/`, walks `dist/` for total size, and fails on any regression past these ceilings:

| Budget | Ceiling |
| --- | ---: |
| Largest CSS asset (gzip) | 13,650 bytes |
| Largest JavaScript asset (gzip) | 105,500 bytes |
| Core `dist/` (total, minus separately-budgeted asset trees) | 575,500 bytes |

It also fails if any `dist/` path contains `session-cat` (a forbidden legacy asset tree).

> Note: the script still declares separate ceilings for `dist/mascots/...` (Halo Bot / Haloform) and `dist/mediapipe` (movement pose runtime). Those asset trees are from removed features and are not produced by the current build — `dist/` only contains `assets/`, `provider-icons/`, and `index.html`. Those budget lines are vestigial and should be dropped from the script; they are not a live part of the product.

## 2. Session model — `scripts/benchmark-session-model.mjs`

Loads `apps/desktop/src/features/session/model.ts` in a headless Chromium page and benchmarks the pure session-derivation functions against a deterministic workload (100 conversations, 3,200 existing + 500 incoming events, 1,000 sessions for grouping). With `--assert` it enforces p95 ceilings:

| Operation | p95 ceiling |
| --- | ---: |
| `mergeSessionEvents` (merge 500 events) | 2.5ms |
| `buildSessionSummaries` (derive summaries) | 0.5ms |
| `buildWorkspaceSessionGroups` (group 1,000 sessions) | 1.5ms |

## 3. Bridge — `scripts/benchmark-bridge.mjs`

Starts the bridge under a temporary `HOME`, publishes N deterministic events (5,000 in `test:performance`, 20,000 for `pnpm benchmark:bridge`), and asserts a real temporary NDJSON log was written. With `--assert` it enforces:

| Budget | Threshold |
| --- | ---: |
| Startup | ≤ 100ms |
| Throughput | ≥ 20,000 events/s |
| Persisted log | > 0 bytes |

> Note: this script currently imports the bridge under the path `mods/agent-activity.js`, which does not exist in this tree — the standalone bridge lives at `adapters/bridge/agent-activity-bridge.mjs`. The `--ref`/`--mod` plumbing (comparing against a Git ref) still points at the old Letta mod path. Until the script is updated to target the standalone bridge, treat the bridge layer of `pnpm test:performance` as needing a fix rather than a working budget.

## Commands

```bash
pnpm benchmark:sessions      # session-model microbenchmark (no assert)
pnpm benchmark:bridge        # bridge throughput, 20,000 events
pnpm test:performance        # build + all three asserted layers
```

Higher-risk work — asynchronous/buffered NDJSON writes, log rotation, or replacing the persistence engine — requires a separate durability/retention decision. Do not trade away event order or crash/reload recovery for a synthetic throughput win.
