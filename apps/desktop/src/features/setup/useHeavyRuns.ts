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
    since?: string;
    elapsedMs: number;
    loadSkipped: boolean;
    helperGone: boolean;
    /** False for a run recorded before #243: the app may not stop it. Absent from older bridges. */
    verified?: boolean;
  } | null;
  queue: Array<{ id?: string; position: number; as: string; label?: string | null; what: string; waitedMs: number }>;
  /** Heavy runs the app sees outside the helper (#245): what matched, never the command line. Absent from older bridges. */
  observed?: Array<{ pid: number; pattern: string; exe: string; cwd: string | null; label: string; startedAtMs?: number; elapsedMs: number }>;
  load: number | null;
  loadLimit: number;
  limit: string;
}

export interface IUseHeavyRuns {
  status: IHeavyStatus | null;
  error: string | null;
  releasing: boolean;
  stop: (holderId: string) => Promise<void>;
  /** The queue entry id being removed, while the bridge is asked. */
  removing: string | null;
  remove: (entryId: string) => Promise<void>;
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
  const [removing, setRemoving] = useState<string | null>(null);

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

  // Kept apart from the status read's error (#376 audit): a refused Kill or Remove is said until
  // the next one is pressed, and a status read that succeeds a moment later does not erase it.
  const [actionError, setActionError] = useState<string | null>(null);
  const act = useCallback(async (command: string, args: Record<string, unknown>) => {
    setActionError(null);
    try {
      await invoke(command, args);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
    await read();
  }, [read]);

  const stop = useCallback(async (holderId: string) => {
    setReleasing(true);
    try {
      await act("heavy_stop", { holderId });
    } finally {
      setReleasing(false);
    }
  }, [act]);

  const remove = useCallback(async (entryId: string) => {
    setRemoving(entryId);
    try {
      await act("heavy_remove", { entryId });
    } finally {
      setRemoving(null);
    }
  }, [act]);

  return { status, error: actionError ?? error, releasing, stop, removing, remove };
};

