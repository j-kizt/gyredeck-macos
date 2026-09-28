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

/**
 * Whether a Codex session can be offered a sync room at all.
 *
 * Codex is the one agent that cannot present a room's password itself — its sandbox
 * refuses the socket — so the password a person types at its prompt is carried by its
 * `notify` adapter. Nothing else can carry it: reading the password out in the app used
 * to confirm Codex sessions as a side effect, and that is gone, because a credential that
 * admits whoever holds it the moment it is copied is not a credential.
 *
 * So the hook alone is not enough to offer Sync. Updating the app does not update what is
 * installed in `~/.config/gyredeck` — that happens when the person installs from Plugins —
 * and an old or missing notify would leave them pasting a password into a session that
 * goes quiet for good. Offering nothing, with the Plugins row already pointing at what is
 * out of date, is the honest answer.
 *
 * Null while anything is still unknown, so the panel stays hidden rather than flickering
 * into a refusal it may be about to take back.
 */
export const codexCanSync = (hook: IHookStatus, notify: IHookStatus): boolean | null => {
  if (hook.installed === null || notify.installed === null) return null;
  if (hook.installed !== true || notify.installed !== true) return false;
  if (notify.stale === null) return null;
  return notify.stale === false;
};
