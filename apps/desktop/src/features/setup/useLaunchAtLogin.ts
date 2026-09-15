import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

export interface ILaunchAtLoginState {
  enabled: boolean;
  busy: boolean;
  /** Why the last attempt failed, or null. Shown rather than swallowed. */
  error: string | null;
  set: (enabled: boolean) => Promise<void>;
}

/**
 * Whether Gyredeck starts when the machine is unlocked.
 *
 * Read from the system rather than remembered. It is a login item, and a person can
 * remove one in System Settings without telling the app — a value cached here would go
 * on claiming whatever it was last told. The notification permission had exactly that
 * fault, and it hid the one message that would have explained what to do.
 *
 * Re-read on focus for the same reason, since that is both the moment it is about to be
 * looked at and the moment somebody returns from having changed it elsewhere.
 */
export const useLaunchAtLogin = (canUseNativeControls: boolean): ILaunchAtLoginState => {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canUseNativeControls) return;
    let cancelled = false;

    const read = async () => {
      try {
        const current = await invoke<boolean>("launch_at_login_enabled");
        if (!cancelled) setEnabled(current);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };

    void read();
    // Taken from the DOM rather than Tauri's window events: the same code then runs in
    // the browser demo, where a Tauri-only call throws inside the effect.
    const onWake = () => { if (document.visibilityState !== "hidden") void read(); };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [canUseNativeControls]);

  const set = useCallback(async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      // The command answers with what the system holds afterwards, not with what was
      // asked for, so a refusal leaves the switch showing the truth.
      setEnabled(await invoke<boolean>("set_launch_at_login", { enabled: next }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      try {
        setEnabled(await invoke<boolean>("launch_at_login_enabled"));
      } catch {
        // Both calls failed; the error already on screen is the honest answer.
      }
    } finally {
      setBusy(false);
    }
  }, []);

  return { enabled, busy, error, set };
};
