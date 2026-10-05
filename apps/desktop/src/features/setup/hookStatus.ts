/**
 * Whether Codex will run Gyredeck's hooks, as Codex's own app-server reports it.
 *
 * Installing a hook and Codex agreeing to run it are separate facts: Codex runs only the
 * hooks a person has approved in `/hooks`, and skips the rest without a word.
 * `unknown` means the question was asked and could not be answered — no `codex`, an
 * app-server that would not answer, a shape not recognised — and is never read as fine.
 */
export type CodexHookTrust = "approved" | "untrusted" | "modified" | "disabled" | "unknown";

/** What one agent integration's install looks like from the app's side. */
export interface IHookStatus {
  path: string | null;
  installed: boolean | null;
  /** Installed, but not the copy this build ships — it needs installing again. */
  stale: boolean | null;
  /**
   * Codex hooks only; absent on every other row. `null` while Codex is being asked or has
   * not been asked yet — which is not a finding, so it lights no dot, and is not a pass
   * either, so the row shows no checkmark.
   */
  trust?: CodexHookTrust | null;
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
  status.installed === true &&
  (status.stale !== false || (status.trust != null && CODEX_TRUST_TO_FIX.has(status.trust)));

/**
 * Approval states with something for the person to go and do — and only those light the
 * dot, which is drawn in the danger colour.
 *
 * `unknown` is left out on purpose. It means the question could not be answered — a slow
 * app-server, a Codex too old to have the method — and one timeout is not evidence that a
 * hook is broken. It still keeps the checkmark off the row, where Recheck is one press away.
 */
const CODEX_TRUST_TO_FIX = new Set<CodexHookTrust>(["untrusted", "modified", "disabled"]);

/**
 * Whether a row has nothing left to show: installed, current, and — for the Codex row —
 * approved by Codex. Not the negation of `hookNeedsAttention`, because a row can be still
 * finding out (being asked, or not answerable) without that being something to fix.
 */
export const hookSettled = (status: IHookStatus): boolean =>
  status.installed === true &&
  !hookNeedsAttention(status) &&
  (status.trust === undefined || status.trust === "approved");

/**
 * What the Codex hooks row says about approval, and what the person has to do about it.
 *
 * Null when there is nothing to say beyond "installed". The fix is in Codex, never a
 * reinstall: reinstalling an unapproved hook leaves it unapproved, and reinstalling an
 * approved one is what turns it into a changed one.
 */
export const codexTrustCopy = (
  trust: CodexHookTrust | null | undefined,
): { detail: string; step: string | null } | null => {
  switch (trust) {
    case null:
      return { detail: "Installed · checking approval in Codex…", step: null };
    case "untrusted":
      return { detail: "Installed · waiting for approval in Codex", step: "Open Codex → type /hooks → approve the Gyredeck hooks" };
    case "modified":
      return { detail: "Installed · changed since you approved it", step: "Open Codex → type /hooks → approve the Gyredeck hooks again" };
    case "disabled":
      return { detail: "Installed · turned off in Codex", step: "Open Codex → type /hooks → turn the Gyredeck hooks back on" };
    case "unknown":
      return { detail: "Installed · could not check approval in Codex", step: "To check by hand: open Codex → type /hooks" };
    default:
      return null;
  }
};

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
