import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deviceStart,
  devicePoll,
  fetchAccounts,
  fetchRepoStatus,
  importFromGh as importFromGhCmd,
  readStatusCache,
  readTrackedRepos,
  switchAccount,
  takeLegacyTrackedRepos,
  writeStatusCache,
  writeTrackedRepos,
} from "./adapter";
import type { GithubRepoState, IGhAccount } from "./types";

const POLL_INTERVAL_MS = 45_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

export type DeviceFlowState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "awaiting"; userCode: string; verificationUri: string }
  | { status: "error"; message: string };

interface IUseGithubMonitorOptions {
  active: boolean;
  canUseNativeControls: boolean;
}

export interface IGithubMonitor {
  trackedRepos: string[];
  statuses: Record<string, GithubRepoState>;
  accounts: IGhAccount[];
  activeAccount: string | null;
  switching: boolean;
  addRepo: (repo: string) => void;
  removeRepo: (repo: string) => void;
  refresh: () => void;
  refreshAccounts: () => Promise<void>;
  switchTo: (user: string) => Promise<void>;
  importFromGh: () => Promise<void>;
  deviceFlow: DeviceFlowState;
  startDeviceFlow: () => Promise<void>;
  cancelDeviceFlow: () => void;
}

export const useGithubMonitor = ({ active, canUseNativeControls }: IUseGithubMonitorOptions): IGithubMonitor => {
  const [trackedRepos, setTrackedRepos] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<Record<string, GithubRepoState>>(() => {
    const cache = readStatusCache();
    const initial: Record<string, GithubRepoState> = {};
    for (const [repo, data] of Object.entries(cache)) {
      initial[repo] = { status: "ready", data, updatedAt: 0 };
    }
    return initial;
  });
  const [accounts, setAccounts] = useState<IGhAccount[]>([]);
  const [switching, setSwitching] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowState>({ status: "idle" });
  const deviceSessionRef = useRef<{ cancelled: boolean }>({ cancelled: true });

  const activeAccount = accounts.find((account) => account.active)?.login ?? null;
  const activeAccountRef = useRef(activeAccount);
  activeAccountRef.current = activeAccount;
  const trackedRef = useRef(trackedRepos);
  trackedRef.current = trackedRepos;

  const refreshRepo = useCallback(async (repo: string) => {
    setStatuses((current) => ({
      ...current,
      [repo]: current[repo]?.status === "ready"
        ? current[repo]
        : { status: "loading" },
    }));
    try {
      const data = await fetchRepoStatus(repo);
      setStatuses((current) => ({ ...current, [repo]: { status: "ready", data, updatedAt: Date.now() } }));
      const cache = readStatusCache();
      cache[repo] = data;
      writeStatusCache(cache);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatuses((current) => {
        const previous = current[repo];
        const carried = previous && previous.status === "ready" ? { data: previous.data, updatedAt: previous.updatedAt } : {};
        return { ...current, [repo]: { status: "error", message, ...carried } };
      });
    }
  }, []);

  const refresh = useCallback(() => {
    if (!canUseNativeControls) return;
    for (const repo of trackedRef.current) void refreshRepo(repo);
  }, [canUseNativeControls, refreshRepo]);

  const refreshAccounts = useCallback(async () => {
    if (!canUseNativeControls) return;
    try {
      setAccounts(await fetchAccounts());
    } catch {
      setAccounts([]);
    }
  }, [canUseNativeControls]);

  const addRepo = useCallback((repo: string) => {
    const trimmed = repo.trim();
    setTrackedRepos((current) => {
      if (current.includes(trimmed)) return current;
      const next = [...current, trimmed];
      writeTrackedRepos(activeAccountRef.current, next);
      return next;
    });
    void refreshRepo(trimmed);
  }, [refreshRepo]);

  const removeRepo = useCallback((repo: string) => {
    setTrackedRepos((current) => {
      const next = current.filter((r) => r !== repo);
      writeTrackedRepos(activeAccountRef.current, next);
      return next;
    });
    setStatuses((current) => {
      const { [repo]: _removed, ...rest } = current;
      return rest;
    });
    const cache = readStatusCache();
    delete cache[repo];
    writeStatusCache(cache);
  }, []);

  const importFromGh = useCallback(async () => {
    await importFromGhCmd();
    await refreshAccounts();
  }, [refreshAccounts]);

  const cancelDeviceFlow = useCallback(() => {
    deviceSessionRef.current.cancelled = true;
    setDeviceFlow({ status: "idle" });
  }, []);

  // GitHub OAuth device flow: request a user code, open the verification page,
  // then poll until the user authorizes (or the code expires / is cancelled).
  const startDeviceFlow = useCallback(async () => {
    deviceSessionRef.current.cancelled = true; // cancel any prior loop
    const session = { cancelled: false };
    deviceSessionRef.current = session;
    setDeviceFlow({ status: "starting" });

    let start;
    try {
      start = await deviceStart();
    } catch (error) {
      if (!session.cancelled) setDeviceFlow({ status: "error", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (session.cancelled) return;

    setDeviceFlow({ status: "awaiting", userCode: start.user_code, verificationUri: start.verification_uri });
    void invoke("open_external_url", { url: start.verification_uri }).catch(() => undefined);

    const deadline = Date.now() + start.expires_in * 1000;
    const intervalMs = Math.max(start.interval, 5) * 1000;
    while (!session.cancelled && Date.now() < deadline) {
      await delay(intervalMs);
      if (session.cancelled) return;
      try {
        const result = await devicePoll(start.device_code);
        if (result.status === "success") {
          setDeviceFlow({ status: "idle" });
          await refreshAccounts();
          return;
        }
      } catch (error) {
        if (!session.cancelled) setDeviceFlow({ status: "error", message: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    if (!session.cancelled) setDeviceFlow({ status: "error", message: "Code expired — try signing in again." });
  }, [refreshAccounts]);

  const switchTo = useCallback(async (user: string) => {
    setSwitching(true);
    try {
      await switchAccount(user);
      await refreshAccounts();
    } finally {
      setSwitching(false);
    }
  }, [refreshAccounts]);

  // Load the tracked-repo list for the active account (migrating any legacy list once).
  useEffect(() => {
    if (!canUseNativeControls) return;
    if (!activeAccount) {
      setTrackedRepos([]);
      return;
    }
    const repos = takeLegacyTrackedRepos(activeAccount) ?? readTrackedRepos(activeAccount);
    setTrackedRepos(repos);
    for (const repo of repos) void refreshRepo(repo);
  }, [activeAccount, canUseNativeControls, refreshRepo]);

  useEffect(() => {
    if (!active || !canUseNativeControls) return undefined;
    void refreshAccounts();
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, canUseNativeControls, refresh, refreshAccounts]);

  return {
    trackedRepos,
    statuses,
    accounts,
    activeAccount,
    switching,
    addRepo,
    removeRepo,
    refresh,
    refreshAccounts,
    switchTo,
    importFromGh,
    deviceFlow,
    startDeviceFlow,
    cancelDeviceFlow,
  };
};
