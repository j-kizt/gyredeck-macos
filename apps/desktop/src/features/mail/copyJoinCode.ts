export type CopyJoinCodeResult = "copied" | "none" | "stale" | { fallback: string };

/**
 * Mint a session's one-time join code and put it on the clipboard (#331). The detail view is
 * reused across sessions, so the person may select another one while the mint or the write is
 * in flight. A code for session A must then never be offered, or announced as copied, on
 * session B's panel: B would refuse it. So the selection is checked after each await.
 */
export const copyJoinCode = async ({
  forSession,
  shownSession,
  mint,
  write,
}: {
  forSession: string;
  shownSession: () => string;
  mint: () => Promise<string | null>;
  write: (text: string) => Promise<void>;
}): Promise<CopyJoinCodeResult> => {
  const code = await mint();
  if (!code) return "none";
  if (shownSession() !== forSession) return "stale";
  try {
    await write(code);
  } catch {
    // Denied clipboard access would leave the code minted and unusable, so the caller shows it.
    return shownSession() === forSession ? { fallback: code } : "stale";
  }
  return shownSession() === forSession ? "copied" : "stale";
};
