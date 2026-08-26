import { invoke } from "@tauri-apps/api/core";
import type {
  GitProvider,
  IDeviceCodeStart,
  IDevicePollResult,
  IGhAccount,
  IGithubRepoStatus,
} from "./types";

const TRACKED_REPOS_KEY = "gyredeck.github.tracked-repos";
const STATUS_CACHE_KEY = "gyredeck.github.status-cache";

// owner/name (GitHub) or namespace/.../project (GitLab nested groups).
const REPO_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/;

export const isValidRepo = (repo: string): boolean => REPO_PATTERN.test(repo.trim());

export const fetchRepoStatus = (repo: string, provider?: GitProvider, login?: string): Promise<IGithubRepoStatus> =>
  invoke<IGithubRepoStatus>("github_repo_status", { repo, provider, login });

export const fetchAvailableRepos = (provider?: GitProvider, login?: string): Promise<string[]> =>
  invoke<string[]>("github_available_repos", { provider, login });

export const getSyncIdentity = (): Promise<boolean> =>
  invoke<boolean>("get_sync_identity");

export const setSyncIdentity = (enabled: boolean): Promise<void> =>
  invoke<void>("set_sync_identity", { enabled });

export const fetchAccounts = (): Promise<IGhAccount[]> =>
  invoke<IGhAccount[]>("github_accounts");

export const switchAccount = (provider: GitProvider, user: string): Promise<string> =>
  invoke<string>("github_switch_account", { provider, user });

export const importFromGh = (): Promise<IGhAccount[]> =>
  invoke<IGhAccount[]>("github_import_from_gh");

export const importFromGlab = (): Promise<IGhAccount[]> =>
  invoke<IGhAccount[]>("import_from_glab");

export const removeAccount = (provider: GitProvider, user: string): Promise<IGhAccount[]> =>
  invoke<IGhAccount[]>("github_remove_account", { provider, user });

export const deviceStart = (provider: GitProvider): Promise<IDeviceCodeStart> =>
  invoke<IDeviceCodeStart>("device_start", { provider });

export const devicePoll = (provider: GitProvider, deviceCode: string): Promise<IDevicePollResult> =>
  invoke<IDevicePollResult>("device_poll", { provider, deviceCode });

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

// Accounts are keyed by "<provider>:<login>". GitHub repos from older builds
// were keyed by the bare login, so fall back to that for GitHub accounts.
const legacyBareLogin = (accountKey: string): string | null =>
  accountKey.startsWith("github:") ? accountKey.slice("github:".length) : null;

export const readTrackedRepos = (accountKey: string | null): string[] => {
  if (!accountKey) return [];
  const map = readTrackedMap();
  if (map[accountKey]) return map[accountKey];
  const bare = legacyBareLogin(accountKey);
  if (bare && map[bare]) return map[bare];
  return [];
};

export const writeTrackedRepos = (accountKey: string | null, repos: string[]): void => {
  if (!accountKey) return;
  const map = readTrackedMap();
  delete map[LEGACY_TRACKED_KEY];
  const bare = legacyBareLogin(accountKey);
  if (bare) delete map[bare]; // fold the old bare-login entry into the new key
  map[accountKey] = repos;
  writeJson(TRACKED_REPOS_KEY, map);
};

/** One-time adoption of a legacy flat list onto an account that has none yet. */
export const takeLegacyTrackedRepos = (accountKey: string | null): string[] | null => {
  if (!accountKey) return null;
  const map = readTrackedMap();
  const legacy = map[LEGACY_TRACKED_KEY];
  if (!legacy || legacy.length === 0 || readTrackedRepos(accountKey).length > 0) return null;
  writeTrackedRepos(accountKey, legacy);
  return legacy;
};

export const readStatusCache = (): Record<string, IGithubRepoStatus> =>
  readJson<Record<string, IGithubRepoStatus>>(STATUS_CACHE_KEY, {});

export const writeStatusCache = (cache: Record<string, IGithubRepoStatus>): void =>
  writeJson(STATUS_CACHE_KEY, cache);
