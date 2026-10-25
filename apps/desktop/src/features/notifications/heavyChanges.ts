import type { IHeavyStatus } from "../setup/useHeavyRuns";

/** Something about the heavy-run slot worth a banner (#244). */
export interface IHeavyChange {
  kind: "started" | "waiting" | "ended";
  /** Names this run, or this wait, and nothing else: the banner's slot. */
  key: string;
  title: string;
  body: string;
}

interface IMarkedRun {
  label: string;
  what: string;
  elapsedMs: number;
}

/** What the last look saw: the runs holding the slot, and who was waiting. */
export interface IHeavyMark {
  runs: Record<string, IMarkedRun>;
  waiting: string[];
}

/** "40s", "4m 12s", "1h 5m": how long a run took, as the room notices say it. */
export const heavyDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/**
 * Every run on the slot, keyed by what makes it that run: a helper run by its holder id
 * (a new run of the same session is a new id), an observed run by pid and start. A
 * reservation has run nothing yet, so it is not a run.
 */
const runsOf = (state: IHeavyStatus): Record<string, IMarkedRun> => {
  const runs: Record<string, IMarkedRun> = {};
  const holder = state.holder;
  if (holder && holder.state === "active") {
    runs[`helper.${holder.id ?? `${holder.as}.${holder.since ?? ""}`}`] = { label: holder.label ?? holder.as, what: holder.what, elapsedMs: holder.elapsedMs };
  }
  for (const run of state.observed ?? []) {
    runs[`observed.${run.pid}.${run.startedAtMs ?? ""}`] = { label: run.label, what: run.pattern, elapsedMs: run.elapsedMs };
  }
  return runs;
};

const waitKey = (entry: IHeavyStatus["queue"][number]) => `wait.${entry.id ?? `${entry.as}.${entry.what}`}`;

export const heavyMarkOf = (state: IHeavyStatus): IHeavyMark => ({ runs: runsOf(state), waiting: state.queue.map(waitKey) });

/**
 * What changed on the slot between two looks: a run that started, somebody who joined the
 * line, a run that ended. Compared, never reported: the slot is read every five seconds and
 * a run holding it for ten minutes is one start and one end.
 *
 * Nothing is reported against a first look. Opening the app to find a run already going is
 * a state, not an event.
 */
export const heavyChangesBetween = (before: IHeavyMark | undefined, state: IHeavyStatus): IHeavyChange[] => {
  if (!before) return [];
  const now = runsOf(state);
  const changes: IHeavyChange[] = [];
  for (const [key, run] of Object.entries(now)) {
    if (key in before.runs) continue;
    changes.push({ kind: "started", key, title: `${run.label} started a heavy run`, body: run.what });
  }
  const holderNow = Object.values(now)[0];
  for (const entry of state.queue) {
    const key = waitKey(entry);
    if (before.waiting.includes(key)) continue;
    const who = entry.label ?? entry.as;
    const behind = holderNow
      ? `behind ${holderNow.label}`
      : state.load !== null && state.load > state.loadLimit
        ? `for the load to drop (${Math.round(state.load * 10) / 10} > ${state.loadLimit})`
        : "for the slot";
    changes.push({ kind: "waiting", key, title: `${who} is waiting ${behind}`, body: entry.what });
  }
  for (const [key, run] of Object.entries(before.runs)) {
    if (key in now) continue;
    changes.push({ kind: "ended", key, title: `${run.what} finished (${heavyDuration(run.elapsedMs)})`, body: run.label });
  }
  return changes;
};
