import type { IGithubRepoStatus } from "../github/types";

export type GitChangeKind = "ci-failed" | "ci-passed" | "pull-opened" | "commit-landed";

export interface IGitChange {
  kind: GitChangeKind;
  repo: string;
  title: string;
  body: string;
}

/**
 * What a repo looked like last time, kept so the next look can be compared to it.
 *
 * Only the few facts a change is judged on. Holding the whole snapshot would mean every
 * unrelated field — a changed timestamp, a re-ordered list — counted as movement.
 */
export interface IGitMark {
  runKey: string | null;
  runConclusion: string | null;
  commitSha: string | null;
  pullNumbers: number[];
}

/** Which run speaks for the repo: the newest one, since that is the one being waited on. */
const newestRun = (status: IGithubRepoStatus) =>
  [...(status.runs ?? [])].sort((left, right) =>
    Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? ""),
  )[0] ?? null;

export const markOf = (status: IGithubRepoStatus): IGitMark => {
  const run = newestRun(status);
  return {
    // Name and time together: a re-run of the same workflow is a different run to wait
    // on, and its name alone would not say so.
    runKey: run ? `${run.name}@${run.created_at}` : null,
    runConclusion: run ? (run.status === "completed" ? run.conclusion ?? "unknown" : null) : null,
    commitSha: status.commit?.sha ?? null,
    pullNumbers: (status.pulls ?? []).map((pull) => pull.number).sort((a, b) => a - b),
  };
};

const shortSha = (sha: string | null) => (sha ?? "").slice(0, 7);

/**
 * What changed between two looks at one repo, as things worth being told.
 *
 * Compared rather than reported: a poll returns the current state every time, and
 * "currently failing" would notify once a minute for as long as it stays broken. Only
 * the moment it *became* so is news.
 *
 * Nothing is reported against a first look. There is no before to compare with, and
 * treating startup as change would announce every repo's existing state at launch —
 * which is how a person learns to dismiss these without reading them.
 */
export const gitChangesBetween = (
  before: IGitMark | undefined,
  status: IGithubRepoStatus,
): IGitChange[] => {
  if (!before) return [];
  const after = markOf(status);
  const changes: IGitChange[] = [];
  const repo = status.repo;

  // A conclusion this look that was absent last look: either the run finished, or a new
  // run finished. Both are the moment of learning how it went.
  if (after.runConclusion && (after.runKey !== before.runKey || !before.runConclusion)) {
    const failed = after.runConclusion !== "success";
    changes.push({
      kind: failed ? "ci-failed" : "ci-passed",
      repo,
      title: failed ? `CI failed · ${repo}` : `CI passed · ${repo}`,
      body: newestRun(status)?.name ?? after.runConclusion,
    });
  }

  const opened = after.pullNumbers.filter((number) => !before.pullNumbers.includes(number));
  if (opened.length > 0) {
    const first = (status.pulls ?? []).find((pull) => pull.number === opened[0]);
    changes.push({
      kind: "pull-opened",
      repo,
      title: opened.length > 1 ? `${opened.length} new pull requests · ${repo}` : `New pull request · ${repo}`,
      body: first ? `#${first.number} ${first.title}` : `#${opened[0]}`,
    });
  }

  if (after.commitSha && before.commitSha && after.commitSha !== before.commitSha) {
    changes.push({
      kind: "commit-landed",
      repo,
      title: `New commit · ${repo}`,
      body: `${shortSha(after.commitSha)} ${status.commit?.message?.split("\n")[0] ?? ""}`.trim(),
    });
  }

  return changes;
};
