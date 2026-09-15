/** What one agent integration's install looks like from the app's side. */
export interface IHookStatus {
  path: string | null;
  installed: boolean | null;
  /** Installed, but not the copy this build ships — it needs installing again. */
  stale: boolean | null;
}

/**
 * Whether an installed hook is one to look at.
 *
 * `stale !== false` rather than `=== true`: unknown is the whole reason the value has
 * three states, and reading it as fine here would collapse it back into a boolean. A
 * hook whose currency could not be worked out is one to check, not one to assume about.
 *
 * Exported so the dot on the Settings button and the row inside it cannot disagree about
 * what they are pointing at.
 */
export const hookNeedsAttention = (status: IHookStatus): boolean =>
  status.installed === true && status.stale !== false;
