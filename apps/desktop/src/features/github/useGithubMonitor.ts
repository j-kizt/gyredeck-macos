import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deviceStart,
  devicePoll,
  fetchAccounts,
  fetchAvailableRepos,
  fetchRepoStatus,
  getSyncIdentity,
  importFromGh as importFromGhCmd,
  importFromGlab as importFromGlabCmd,
  readStatusCache,
  readTrackedRepos,
  removeAccount as removeAccountCmd,
  setSyncIdentity,
  switchAccount,
  takeLegacyTrackedRepos,
  writeStatusCache,
  writeTrackedRepos,
} from "./adapter";
import type { GitProvider, GithubRepoState, IGhAccount } from "./types";

interface IAccountRef {
  provider: GitProvider;
  login: string;
}

const POLL_INTERVAL_MS = 45_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

export type DeviceFlowState =
  | { status: "idle" }
  | { status: "starting"; provider: GitProvider }
  | { status: "awaiting"; provider: GitProvider; userCode: string; verificationUri: string }
  | { status: "error"; provider: GitProvider; message: string };

interface IUseGithubMonitorOptions {
  active: boolean;
  canUseNativeControls: boolean;
}

export interface IGithubMonitor {
  trackedRepos: string[];
  statuses: Record<string, GithubRepoState>;
  accounts: IGhAccount[];
  activeAccount: string | null;
  activeProvider: GitProvider | null;
  viewingAccount: string | null;
  viewingProvider: GitProvider | null;
  syncEnabled: boolean;
  setSyncEnabled: (enabled: boolean) => Promise<void>;
  switching: boolean;
  addRepo: (repo: string) => void;
  removeRepo: (repo: string) => void;
  refresh: () => Promise<void>;
  refreshAccounts: () => Promise<void>;
  listAvailableRepos: () => Promise<string[]>;
  switchTo: (provider: GitProvider, user: string) => Promise<void>;
  setActive: (provider: GitProvider, user: string) => Promise<void>;
  removeAccount: (provider: GitProvider, user: string) => Promise<void>;
  importFromGh: () => Promise<void>;
  importFromGlab: () => Promise<void>;
  deviceFlow: DeviceFlowState;
  startDeviceFlow: (provider: GitProvider) => Promise<boolean>;
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
  const [syncEnabled, setSyncEnabledState] = useState(true);
  // The account whose repos are shown. Equals the active account when sync is on;
  // free to roam (view-only) when sync is off.
  const [viewing, setViewing] = useState<IAccountRef | null>(null);
  const deviceSessionRef = useRef<{ cancelled: boolean }>({ cancelled: true });

  const activeAccountObj = accounts.find((account) => account.active) ?? null;
  const activeAccount = activeAccountObj?.login ?? null;
  const activeProvider = activeAccountObj?.provider ?? null;

  // Keep the viewing account in sync: pinned to active while sync is on, and
  // fall back to active if the current viewing account disappears. Returns the
  // same reference when unchanged to avoid a re-render loop.
  useEffect(() => {
    const activeObj = accounts.find((a) => a.active) ?? null;
    if (!activeObj) {
      setViewing((current) => (current == null ? current : null));
      return;
    }
    setViewing((current) => {
      const keepCurrent =
        !syncEnabled &&
        current != null &&
        accounts.some((a) => a.provider === current.provider && a.login === current.login);
      if (keepCurrent) return current;
      if (current && current.provider === activeObj.provider && current.login === activeObj.login) {
        return current;
      }
      return { provider: activeObj.provider, login: activeObj.login };
    });
  }, [syncEnabled, accounts]);

  const viewingAccount = viewing?.login ?? null;
  const viewingProvider = viewing?.provider ?? null;
  // Composite key ("<provider>:<login>") used for per-account local storage.
  const viewingKey = viewing ? `${viewing.provider}:${viewing.login}` : null;
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  const viewingKeyRef = useRef(viewingKey);
  viewingKeyRef.current = viewingKey;
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
      const view = viewingRef.current;
      const data = await fetchRepoStatus(repo, view?.provider, view?.login);
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

  const refresh = useCallback(async () => {
    if (!canUseNativeControls) return;
    await Promise.all(trackedRef.current.map((repo) => refreshRepo(repo)));
  }, [canUseNativeControls, refreshRepo]);

  const refreshAccounts = useCallback(async () => {
    if (!canUseNativeControls) return;
    try {
      // invoke's return type is a compile-time assertion only. A command that
      // resolves to null slips past the catch below and reaches accounts.find(),
      // which throws during render and takes the whole panel down.
      const next = await fetchAccounts();
      setAccounts(Array.isArray(next) ? next : []);
    } catch {
      setAccounts([]);
    }
  }, [canUseNativeControls]);

  const listAvailableRepos = useCallback(() => {
    const view = viewingRef.current;
    return fetchAvailableRepos(view?.provider, view?.login);
  }, []);

  const addRepo = useCallback((repo: string) => {
    const trimmed = repo.trim();
    setTrackedRepos((current) => {
      if (current.includes(trimmed)) return current;
      const next = [...current, trimmed];
      writeTrackedRepos(viewingKeyRef.current, next);
      return next;
    });
    void refreshRepo(trimmed);
  }, [refreshRepo]);

  const removeRepo = useCallback((repo: string) => {
    setTrackedRepos((current) => {
      const next = current.filter((r) => r !== repo);
      writeTrackedRepos(viewingKeyRef.current, next);
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

  const importFromGlab = useCallback(async () => {
    await importFromGlabCmd();
    await refreshAccounts();
  }, [refreshAccounts]);

  const cancelDeviceFlow = useCallback(() => {
    deviceSessionRef.current.cancelled = true;
    setDeviceFlow({ status: "idle" });
  }, []);

  // OAuth device flow (GitHub or GitLab): request a user code, open the
  // verification page, then poll until authorized (or expired / cancelled).
  const startDeviceFlow = useCallback(async (provider: GitProvider) => {
    deviceSessionRef.current.cancelled = true; // cancel any prior loop
    const session = { cancelled: false };
    deviceSessionRef.current = session;
    setDeviceFlow({ status: "starting", provider });

    let start;
    try {
      start = await deviceStart(provider);
    } catch (error) {
      if (!session.cancelled) setDeviceFlow({ status: "error", provider, message: error instanceof Error ? error.message : String(error) });
      return false;
    }
    if (session.cancelled) return false;

    setDeviceFlow({ status: "awaiting", provider, userCode: start.user_code, verificationUri: start.verification_uri });
    void invoke("open_external_url", { url: start.verification_uri }).catch(() => undefined);

    const deadline = Date.now() + start.expires_in * 1000;
    const intervalMs = Math.max(start.interval, 5) * 1000;
    while (!session.cancelled && Date.now() < deadline) {
      await delay(intervalMs);
      if (session.cancelled) return false;
      try {
        const result = await devicePoll(provider, start.device_code);
        if (result.status === "success") {
          setDeviceFlow({ status: "idle" });
          await refreshAccounts();
          return true;
        }
      } catch (error) {
        if (!session.cancelled) setDeviceFlow({ status: "error", provider, message: error instanceof Error ? error.message : String(error) });
        return false;
      }
    }
    if (!session.cancelled) setDeviceFlow({ status: "error", provider, message: "Code expired — try signing in again." });
    return false;
  }, [refreshAccounts]);

  const switchTo = useCallback(async (provider: GitProvider, user: string) => {
    // View-only when sync is off: just change which account's repos are shown.
    if (!syncEnabled) {
      setViewing({ provider, login: user });
      return;
    }
    setSwitching(true);
    try {
      await switchAccount(provider, user);
      await refreshAccounts();
    } finally {
      setSwitching(false);
    }
  }, [refreshAccounts, syncEnabled]);

  const setSyncEnabled = useCallback(async (enabled: boolean) => {
    await setSyncIdentity(enabled);
    setSyncEnabledState(enabled);
    // Turning sync on re-pins the system identity; refresh in case it moved.
    if (enabled) await refreshAccounts();
  }, [refreshAccounts]);

  // Always set the pinned active account (unlike switchTo, which is view-only
  // when sync is off). Used by the Settings account menu.
  const setActive = useCallback(async (provider: GitProvider, user: string) => {
    await switchAccount(provider, user);
    await refreshAccounts();
  }, [refreshAccounts]);

  const removeAccount = useCallback(async (provider: GitProvider, user: string) => {
    await removeAccountCmd(provider, user);
    await refreshAccounts();
  }, [refreshAccounts]);

  // Load the tracked-repo list for the viewing account (migrating any legacy list once).
  useEffect(() => {
    if (!canUseNativeControls) return;
    if (!viewingKey) {
      setTrackedRepos([]);
      return;
    }
    const repos = takeLegacyTrackedRepos(viewingKey) ?? readTrackedRepos(viewingKey);
    setTrackedRepos(repos);
    for (const repo of repos) void refreshRepo(repo);
  }, [viewingKey, canUseNativeControls, refreshRepo]);

  // Load the persisted sync-identity preference + account list on mount so
  // Settings → Git shows accounts without first visiting the Git Monitor tab.
  useEffect(() => {
    if (!canUseNativeControls) return;
    void getSyncIdentity().then(setSyncEnabledState).catch(() => undefined);
    void refreshAccounts();
  }, [canUseNativeControls, refreshAccounts]);

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
    activeProvider,
    viewingAccount,
    viewingProvider,
    syncEnabled,
    setSyncEnabled,
    switching,
    addRepo,
    removeRepo,
    refresh,
    refreshAccounts,
    listAvailableRepos,
    switchTo,
    setActive,
    removeAccount,
    importFromGh,
    importFromGlab,
    deviceFlow,
    startDeviceFlow,
    cancelDeviceFlow,
  };
};
