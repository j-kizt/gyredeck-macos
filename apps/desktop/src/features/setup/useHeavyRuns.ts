import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

/** `GET /heavy`, as the bridge answers it (#223). */
export interface IHeavyStatus {
  holder: {
    id: string;
    as: string;
    label?: string | null;
    what: string;
    state: "reserved" | "active";
    elapsedMs: number;
    loadSkipped: boolean;
    helperGone: boolean;
    /** False for a run recorded before #243: the app may not stop it. Absent from older bridges. */
    verified?: boolean;
  } | null;
  queue: Array<{ position: number; as: string; label?: string | null; what: string; waitedMs: number }>;
  load: number | null;
  loadLimit: number;
  limit: string;
}

export interface IUseHeavyRuns {
  status: IHeavyStatus | null;
  error: string | null;
  releasing: boolean;
  stop: (holderId: string) => Promise<void>;
}

const HEAVY_POLL_MS = 5_000;

/**
 * The machine's one heavy-run slot, read every five seconds while the row is on screen and
 * the window is visible. Mounted only with the row, so leaving Settings stops the polling.
 */
export const useHeavyRuns = (canUseNativeControls: boolean): IUseHeavyRuns => {
  const [status, setStatus] = useState<IHeavyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);

  const read = useCallback(async () => {
    try {
      setStatus(await invoke<IHeavyStatus>("heavy_status"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!canUseNativeControls) return;
    const tick = () => { if (document.visibilityState === "visible") void read(); };
    tick();
    const timer = window.setInterval(tick, HEAVY_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [canUseNativeControls, read]);

  const stop = useCallback(async (holderId: string) => {
    setReleasing(true);
    try {
      await invoke<string>("heavy_stop", { holderId });
      await read();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await read();
    } finally {
      setReleasing(false);
    }
  }, [read]);

  return { status, error, releasing, stop };
};
