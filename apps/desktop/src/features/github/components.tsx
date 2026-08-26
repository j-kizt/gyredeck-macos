import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronsUpDown, Copy, Download, GitBranch, GitCommit, GitPullRequest, LogIn, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitProvider, GithubRepoState, IGithubRun } from "./types";
import type { IGithubMonitor } from "./useGithubMonitor";
import { Tooltip } from "../../Tooltip";

const PROVIDERS: { id: GitProvider; label: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "gitlab", label: "GitLab" },
];

const webBase = (provider: GitProvider): string =>
  provider === "gitlab" ? "https://gitlab.com" : "https://github.com";

const repoUrl = (provider: GitProvider, repo: string): string => `${webBase(provider)}/${repo}`;

const requestsUrl = (provider: GitProvider, repo: string): string =>
  provider === "gitlab"
    ? `${webBase(provider)}/${repo}/-/merge_requests`
    : `${webBase(provider)}/${repo}/pulls`;

const commitUrl = (provider: GitProvider, repo: string, sha: string): string =>
  provider === "gitlab"
    ? `${webBase(provider)}/${repo}/-/commit/${sha}`
    : `${webBase(provider)}/${repo}/commit/${sha}`;

const requestNoun = (provider: GitProvider): string => (provider === "gitlab" ? "MR" : "PR");

// Brand marks (lucide dropped its Github/Gitlab icons), drawn with currentColor.
export const ProviderIcon = ({ provider, size = 13 }: { provider: GitProvider; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
    {provider === "gitlab" ? (
      <path d="m23.6 9.593-.033-.086L20.3.98a.851.851 0 0 0-.336-.405.875.875 0 0 0-1 .054.875.875 0 0 0-.29.44l-2.205 6.748H7.537L5.332 1.07a.857.857 0 0 0-.29-.442.875.875 0 0 0-1-.053.858.858 0 0 0-.336.405L.433 9.502l-.033.086a6.066 6.066 0 0 0 2.012 7.01l.011.009.03.021 4.976 3.727 2.462 1.863 1.5 1.132a1.008 1.008 0 0 0 1.22 0l1.499-1.132 2.462-1.863 5.006-3.749.012-.01a6.068 6.068 0 0 0 2.01-7.003Z" />
    ) : (
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    )}
  </svg>
);

const relativeTime = (iso: string): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const runState = (run: IGithubRun): { symbol: string; tone: string; label: string } => {
  if (run.status !== "completed") return { symbol: "●", tone: "running", label: run.status.replace(/_/g, " ") || "running" };
  switch (run.conclusion) {
    case "success":
      return { symbol: "✓", tone: "ok", label: "passed" };
    case "failure":
    case "timed_out":
    case "startup_failure":
      return { symbol: "✗", tone: "error", label: run.conclusion.replace(/_/g, " ") };
    case "cancelled":
      return { symbol: "⊘", tone: "muted", label: "cancelled" };
    default:
      return { symbol: "•", tone: "muted", label: run.conclusion ?? "done" };
  }
};

const openExternal = (url: string) => void invoke("open_external_url", { url }).catch(() => undefined);

interface IRepoCardProps {
  repo: string;
  provider: GitProvider;
  state: GithubRepoState | undefined;
  onRemove: (repo: string) => void;
}

const RepoCard = ({ repo, provider, state, onRemove }: IRepoCardProps) => {
  const data = state && (state.status === "ready" || state.status === "error") ? state.data : undefined;
  const latestRun = data?.runs[0];
  const run = latestRun ? runState(latestRun) : null;
  const noun = requestNoun(provider);
  return (
    <div className="gh-card">
      <div className="gh-card-head">
        <button className="gh-repo-name" type="button" onClick={() => openExternal(repoUrl(provider, repo))} title={`Open ${repo}`}>
          {repo}
        </button>
        <button className="gh-icon-btn gh-remove" type="button" aria-label={`Stop tracking ${repo}`} onClick={() => onRemove(repo)}>
          <Trash2 size={12} strokeWidth={2.3} />
        </button>
      </div>
      {state?.status === "loading" && !data ? (
        <div className="gh-card-line muted">Loading…</div>
      ) : (
        <>
          {run ? (
            <Tooltip label={`CI ${run.label}${latestRun?.name ? ` · ${latestRun.name}` : ""}`}>
              <div className="gh-card-line">
                <span className={`gh-dot ${run.tone}`}>{run.symbol}</span> CI {run.label}
                {latestRun?.name ? <span className="muted"> · {latestRun.name}</span> : null}
              </div>
            </Tooltip>
          ) : data ? (
            <div className="gh-card-line muted">No workflow runs</div>
          ) : null}
          {data ? (
            <Tooltip label={data.pulls[0]?.title ?? `${data.open_pr_count} open ${noun}${data.open_pr_count === 1 ? "" : "s"}`}>
              <button className="gh-card-line gh-link" type="button" onClick={() => openExternal(requestsUrl(provider, repo))}>
                <GitPullRequest size={12} strokeWidth={2.3} /> {data.open_pr_count} open {noun}{data.open_pr_count === 1 ? "" : "s"}
                {data.pulls[0] ? <span className="muted"> · {data.pulls[0].title}</span> : null}
              </button>
            </Tooltip>
          ) : null}
          {data?.commit ? (
            <Tooltip label={data.commit.message}>
              <button className="gh-card-line gh-link" type="button" onClick={() => data.commit && openExternal(commitUrl(provider, repo, data.commit.sha))}>
                <GitCommit size={12} strokeWidth={2.3} /> {data.commit.sha} {data.commit.message}
                <span className="muted"> · {relativeTime(data.commit.committed_at)}</span>
              </button>
            </Tooltip>
          ) : data ? (
            <div className="gh-card-line muted">No commits yet</div>
          ) : null}
          {state?.status === "error" ? <div className="gh-card-line error">{state.message}</div> : null}
        </>
      )}
    </div>
  );
};

interface IAddRepoProps {
  tracked: string[];
  onAdd: (repo: string) => void;
  loadRepos: () => Promise<string[]>;
}

const AddRepo = ({ tracked, onAdd, loadRepos }: IAddRepoProps) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setFilter("");
  }, []);

  // Dismiss the picker on Escape or a click outside it.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRepos(await loadRepos());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [loadRepos]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && repos.length === 0) void load();
  };

  const candidates = repos
    .filter((r) => !tracked.includes(r))
    .filter((r) => r.toLowerCase().includes(filter.trim().toLowerCase()))
    .slice(0, 50);

  return (
    <div className="gh-add" ref={containerRef}>
      <button className="pill-btn accent" type="button" onClick={toggle}>
        <Plus size={12} strokeWidth={2.3} /> Add repo
      </button>
      {open ? (
        <div className="gh-picker">
          <input
            className="gh-filter"
            type="text"
            placeholder="Filter accessible repos…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            autoFocus
          />
          {loading ? <div className="gh-card-line muted">Loading repos…</div> : null}
          {error ? <div className="gh-card-line error">{error}</div> : null}
          {!loading && !error && candidates.length === 0 ? (
            <div className="gh-card-line muted">No matching repos</div>
          ) : null}
          <div className="gh-picker-list">
            {candidates.map((repo) => (
              <button
                key={repo}
                className="gh-picker-item"
                type="button"
                onClick={() => {
                  onAdd(repo);
                  close();
                }}
              >
                {repo}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

interface IGithubPanelProps {
  monitor: IGithubMonitor;
  canUseNativeControls: boolean;
}

const providerLabel = (provider: GitProvider): string => (provider === "gitlab" ? "GitLab" : "GitHub");

const DeviceFlowPrompt = ({ monitor }: { monitor: IGithubMonitor }) => {
  const [copied, setCopied] = useState(false);
  const flow = monitor.deviceFlow;
  if (flow.status === "idle") return null;
  if (flow.status === "starting") {
    return <div className="gh-device muted"><RefreshCw className="gh-spin" size={12} strokeWidth={2.3} /> Starting sign-in…</div>;
  }
  if (flow.status === "error") {
    return <div className="gh-card-line error">{flow.message}</div>;
  }
  const label = providerLabel(flow.provider);
  return (
    <div className="gh-device-panel">
      <div className="gh-device">
        <RefreshCw className="gh-spin" size={12} strokeWidth={2.3} />
        <span>Enter this code on {label}:</span>
        <button className="gh-code" type="button" title="Copy code" onClick={() => void navigator.clipboard?.writeText(flow.userCode).catch(() => undefined)}>
          {flow.userCode}
        </button>
        <button
          className="gh-icon-btn gh-code-copy"
          type="button"
          title="Copy code"
          aria-label="Copy code"
          onClick={() => {
            void navigator.clipboard?.writeText(flow.userCode).catch(() => undefined);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={12} strokeWidth={2.6} /> : <Copy size={12} strokeWidth={2.3} />}
        </button>
      </div>
      <div className="gh-device-actions">
        <button className="pill-btn" type="button" onClick={() => openExternal(flow.verificationUri)}>Open {label}</button>
        <button className="pill-btn" type="button" onClick={() => monitor.cancelDeviceFlow()}>Cancel</button>
      </div>
    </div>
  );
};

const AddAccount = ({ monitor, signingIn, onDone }: { monitor: IGithubMonitor; signingIn: boolean; onDone?: () => void }) => {
  const [provider, setProvider] = useState<GitProvider>("github");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [onDone]);

  const signIn = useCallback((p: GitProvider) => {
    void monitor.startDeviceFlow(p).then((ok) => {
      if (ok) onDone?.();
    });
  }, [monitor, onDone]);

  return (
    <div className="gh-add-account">
      <div className="gh-provider-tabs" role="tablist" aria-label="Provider">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={provider === p.id}
            className="gh-provider-tab"
            data-active={provider === p.id}
            onClick={() => { setProvider(p.id); setError(null); }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="gh-onboard-actions">
        {provider === "github" ? (
          <>
            <button className="pill-btn accent" type="button" disabled={signingIn} onClick={() => signIn("github")}>
              <LogIn size={12} strokeWidth={2.3} /> Sign in with GitHub
            </button>
            <button className="pill-btn" type="button" disabled={busy} onClick={() => void run(() => monitor.importFromGh())}>
              {busy ? <RefreshCw className="gh-spin" size={12} strokeWidth={2.3} /> : <Download size={12} strokeWidth={2.3} />} Import from gh CLI
            </button>
          </>
        ) : (
          <>
            <button className="pill-btn accent" type="button" disabled={signingIn} onClick={() => signIn("gitlab")}>
              <LogIn size={12} strokeWidth={2.3} /> Sign in with GitLab
            </button>
            <button className="pill-btn" type="button" disabled={busy} onClick={() => void run(() => monitor.importFromGlab())}>
              {busy ? <RefreshCw className="gh-spin" size={12} strokeWidth={2.3} /> : <Download size={12} strokeWidth={2.3} />} Import from glab CLI
            </button>
          </>
        )}
      </div>
      {error ? <div className="gh-card-line error">{error}</div> : null}
      <DeviceFlowPrompt monitor={monitor} />
    </div>
  );
};

const AccountSelect = ({ monitor }: { monitor: IGithubMonitor }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // The trigger shows the account being viewed (may differ from active when
  // sync is off); the list marks the active (pinned) account.
  const viewing =
    monitor.accounts.find((a) => a.provider === monitor.viewingProvider && a.login === monitor.viewingAccount) ??
    monitor.accounts.find((a) => a.active) ??
    monitor.accounts[0];

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="gh-account-select-wrap" ref={ref}>
      <button
        className="gh-account-trigger"
        type="button"
        disabled={monitor.switching}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Active account"
        onClick={() => setOpen((o) => !o)}
      >
        {viewing ? (
          <>
            <ProviderIcon provider={viewing.provider} />
            <span className="gh-account-login">{viewing.login}</span>
          </>
        ) : (
          <span className="gh-account-login muted">Select account</span>
        )}
        <ChevronsUpDown className="gh-account-caret" size={12} strokeWidth={2.3} />
      </button>
      {open ? (
        <div className="gh-picker gh-account-menu" role="listbox">
          <div className="gh-picker-list">
            {monitor.accounts.map((account) => {
              const isViewing = account.provider === viewing?.provider && account.login === viewing?.login;
              return (
                <button
                  key={`${account.provider}:${account.login}`}
                  className="gh-picker-item gh-account-option"
                  type="button"
                  role="option"
                  aria-selected={isViewing}
                  onClick={() => {
                    if (!isViewing) void monitor.switchTo(account.provider, account.login);
                    setOpen(false);
                  }}
                >
                  <ProviderIcon provider={account.provider} />
                  <span className="gh-account-login">{account.login}</span>
                  {account.active ? <Check className="gh-account-check" size={12} strokeWidth={2.6} /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export const GithubPanel = ({ monitor, canUseNativeControls }: IGithubPanelProps) => {
  const signingIn = monitor.deviceFlow.status === "starting" || monitor.deviceFlow.status === "awaiting";
  const [addingAccount, setAddingAccount] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const viewingProvider: GitProvider = monitor.viewingProvider ?? monitor.activeProvider ?? "github";

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    // Guarantee the spinner is visible even when the refresh returns instantly
    // (e.g. no tracked repos).
    const minSpin = new Promise((resolve) => window.setTimeout(resolve, 500));
    try {
      await Promise.all([monitor.refresh(), monitor.refreshAccounts(), minSpin]);
    } finally {
      setRefreshing(false);
    }
  }, [monitor]);

  if (!canUseNativeControls) {
    return <div className="gh-empty">Git monitoring needs the desktop runtime.</div>;
  }

  if (monitor.accounts.length === 0) {
    return (
      <div className="gh-panel">
        <div className="gh-onboard">
          <span className="gh-onboard-badge"><GitBranch size={22} strokeWidth={2} /></span>
          <div className="gh-onboard-title">No accounts yet</div>
          <div className="gh-onboard-sub">Connect GitHub or GitLab to track repos, CI, and PRs/MRs.</div>
          <AddAccount monitor={monitor} signingIn={signingIn} />
        </div>
      </div>
    );
  }

  return (
    <div className="gh-panel">
      <div className="gh-account-bar">
        <GitBranch size={13} strokeWidth={2.3} />
        <AccountSelect monitor={monitor} />
        <button className="gh-icon-btn" type="button" aria-label="Refresh" disabled={refreshing} onClick={() => void handleRefresh()}>
          <RefreshCw className={refreshing ? "gh-spin" : undefined} size={12} strokeWidth={2.3} />
        </button>
        <button className="gh-icon-btn" type="button" data-active={addingAccount} aria-label="Add another account" aria-pressed={addingAccount} title="Add another account" onClick={() => setAddingAccount((open) => !open)}>
          <Plus size={12} strokeWidth={2.3} />
        </button>
      </div>
      {addingAccount ? <AddAccount monitor={monitor} signingIn={signingIn} onDone={() => setAddingAccount(false)} /> : null}
      {monitor.switching ? (
        <div className="gh-card-line muted"><RefreshCw className="gh-spin" size={12} strokeWidth={2.3} /> Switching account…</div>
      ) : null}
      {!addingAccount ? (
        <>
          <DeviceFlowPrompt monitor={monitor} />
          <span className="gh-account-note muted">
            {monitor.syncEnabled
              ? "Switching updates Gyredeck and your global git identity."
              : "View-only · switching won't change your system git identity."}
          </span>

          <AddRepo key={monitor.viewingAccount ?? "none"} tracked={monitor.trackedRepos} onAdd={monitor.addRepo} loadRepos={monitor.listAvailableRepos} />

          <div className="gh-cards">
            {monitor.trackedRepos.length === 0 ? (
              <div className="gh-empty">No repositories tracked yet. Add one accessible to the current account.</div>
            ) : (
              monitor.trackedRepos.map((repo) => (
                <RepoCard key={repo} repo={repo} provider={viewingProvider} state={monitor.statuses[repo]} onRemove={monitor.removeRepo} />
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
};
