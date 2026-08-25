import { useCallback, useEffect, useRef, useState } from "react";
import {
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
  };
};
