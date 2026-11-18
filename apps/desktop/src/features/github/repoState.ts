import type { GithubRepoState, IGithubRepoStatus } from "./types";

/**
 * What a repo's card shows after a refresh (#379). The backend reports a problem it can name — an
 * expired token, an account no longer added — as an `error` on an otherwise empty status, so that
 * one failing repo does not fail the tab. Read as ready, that status told the person their repo had
 * no runs, no PRs and no commits; it is the error state, keeping whatever the card showed before.
 */
export const settledRepoState = (
  previous: GithubRepoState | undefined,
  outcome: { data: IGithubRepoStatus } | { message: string },
  now: number,
): GithubRepoState => {
  const message = "message" in outcome ? outcome.message : outcome.data.error;
  if (!message && "data" in outcome) return { status: "ready", data: outcome.data, updatedAt: now };
  const carried = previous && "data" in previous && previous.data ? { data: previous.data, updatedAt: previous.updatedAt } : {};
  return { status: "error", message: message ?? "", ...carried };
};

/** While a refresh runs, the card keeps what it shows — data, or an error the person has to act on. */
export const pendingRepoState = (previous: GithubRepoState | undefined): GithubRepoState =>
  previous ?? { status: "loading" };

/** "8y ago": ages go on past days to months and years (#379), where "3234d ago" said nothing. */
export const relativeTime = (iso: string, now = Date.now()): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const elapsed = Math.max(0, now - then);
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  // Whole days, so 29.5 is not yet a month nor 364.5 a year.
  const days = Math.max(1, Math.floor(elapsed / 86_400_000));
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};
