import { invoke } from "@tauri-apps/api/core";
import type {
  IDeviceCodeStart,
  IDevicePollResult,
  IGhAccount,
  IGithubRepoStatus,
} from "./types";

const TRACKED_REPOS_KEY = "gyredeck.github.tracked-repos";
const STATUS_CACHE_KEY = "gyredeck.github.status-cache";

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export const isValidRepo = (repo: string): boolean => REPO_PATTERN.test(repo.trim());

export const fetchRepoStatus = (repo: string): Promise<IGithubRepoStatus> =>
  invoke<IGithubRepoStatus>("github_repo_status", { repo });

export const fetchAvailableRepos = (): Promise<string[]> =>
  invoke<string[]>("github_available_repos");

export const fetchAccounts = (): Promise<IGhAccount[]> =>
  invoke<IGhAccount[]>("github_accounts");

export const switchAccount = (user: string): Promise<string> =>
  invoke<string>("github_switch_account", { user });

export const deviceStart = (): Promise<IDeviceCodeStart> =>
  invoke<IDeviceCodeStart>("github_device_start");

export const devicePoll = (deviceCode: string): Promise<IDevicePollResult> =>
  invoke<IDevicePollResult>("github_device_poll", { deviceCode });

const readJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (key: string, value: unknown): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable — the in-memory state still holds */
  }
};

const LEGACY_TRACKED_KEY = "__legacy__";
type TrackedMap = Record<string, string[]>;

// Tracked repos are stored per gh account: { "<login>": ["owner/repo", ...] }.
// A legacy flat array (older builds) is surfaced under LEGACY_TRACKED_KEY so it
// can be migrated onto the active account once.
const readTrackedMap = (): TrackedMap => {
  const raw = readJson<unknown>(TRACKED_REPOS_KEY, {});
  if (Array.isArray(raw)) {
    return { [LEGACY_TRACKED_KEY]: raw.filter((r): r is string => typeof r === "string" && isValidRepo(r)) };
  }
  if (raw && typeof raw === "object") {
    const map: TrackedMap = {};
    for (const [account, repos] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(repos)) map[account] = repos.filter((r): r is string => typeof r === "string" && isValidRepo(r));
    }
    return map;
  }
  return {};
};

export const readTrackedRepos = (account: string | null): string[] => {
  if (!account) return [];
  return readTrackedMap()[account] ?? [];
};

export const writeTrackedRepos = (account: string | null, repos: string[]): void => {
  if (!account) return;
  const map = readTrackedMap();
  delete map[LEGACY_TRACKED_KEY];
  map[account] = repos;
  writeJson(TRACKED_REPOS_KEY, map);
};

/** One-time adoption of a legacy flat list onto an account that has none yet. */
export const takeLegacyTrackedRepos = (account: string | null): string[] | null => {
  if (!account) return null;
  const map = readTrackedMap();
  const legacy = map[LEGACY_TRACKED_KEY];
  if (!legacy || legacy.length === 0 || (map[account]?.length ?? 0) > 0) return null;
  writeTrackedRepos(account, legacy);
  return legacy;
};

export const readStatusCache = (): Record<string, IGithubRepoStatus> =>
  readJson<Record<string, IGithubRepoStatus>>(STATUS_CACHE_KEY, {});

export const writeStatusCache = (cache: Record<string, IGithubRepoStatus>): void =>
  writeJson(STATUS_CACHE_KEY, cache);
