import { invoke } from "@tauri-apps/api/core";
import { Download, GitBranch, GitCommit, GitPullRequest, LogIn, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAvailableRepos } from "./adapter";
import type { GithubRepoState, IGithubRun } from "./types";
import type { IGithubMonitor } from "./useGithubMonitor";
import { Tooltip } from "../../Tooltip";

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
  state: GithubRepoState | undefined;
  onRemove: (repo: string) => void;
}

const RepoCard = ({ repo, state, onRemove }: IRepoCardProps) => {
  const data = state && (state.status === "ready" || state.status === "error") ? state.data : undefined;
  const latestRun = data?.runs[0];
  const run = latestRun ? runState(latestRun) : null;
  return (
    <div className="gh-card">
      <div className="gh-card-head">
        <button className="gh-repo-name" type="button" onClick={() => openExternal(`https://github.com/${repo}`)} title={`Open ${repo}`}>
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
            <Tooltip label={data.pulls[0]?.title ?? `${data.open_pr_count} open PR${data.open_pr_count === 1 ? "" : "s"}`}>
              <button className="gh-card-line gh-link" type="button" onClick={() => openExternal(`https://github.com/${repo}/pulls`)}>
                <GitPullRequest size={12} strokeWidth={2.3} /> {data.open_pr_count} open PR{data.open_pr_count === 1 ? "" : "s"}
                {data.pulls[0] ? <span className="muted"> · {data.pulls[0].title}</span> : null}
              </button>
            </Tooltip>
          ) : null}
          {data?.commit ? (
            <Tooltip label={data.commit.message}>
              <button className="gh-card-line gh-link" type="button" onClick={() => openExternal(`https://github.com/${repo}/commit/${data.commit?.sha}`)}>
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
}

const AddRepo = ({ tracked, onAdd }: IAddRepoProps) => {
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
      setRepos(await fetchAvailableRepos());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

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

const DeviceFlowPrompt = ({ monitor }: { monitor: IGithubMonitor }) => {
  const flow = monitor.deviceFlow;
  if (flow.status === "idle") return null;
  if (flow.status === "starting") {
    return <div className="gh-device muted"><RefreshCw className="gh-spin" size={12} strokeWidth={2.3} /> Starting sign-in…</div>;
  }
  if (flow.status === "error") {
    return <div className="gh-card-line error">{flow.message}</div>;
  }
  return (
    <div className="gh-device-panel">
      <div className="gh-device">
        <RefreshCw className="gh-spin" size={12} strokeWidth={2.3} />
        <span>Enter this code on GitHub:</span>
        <button className="gh-code" type="button" title="Copy code" onClick={() => void navigator.clipboard?.writeText(flow.userCode).catch(() => undefined)}>
          {flow.userCode}
        </button>
      </div>
      <div className="gh-device-actions">
        <button className="pill-btn" type="button" onClick={() => openExternal(flow.verificationUri)}>Open GitHub</button>
        <button className="pill-btn" type="button" onClick={() => monitor.cancelDeviceFlow()}>Cancel</button>
      </div>
    </div>
  );
};

export const GithubPanel = ({ monitor, canUseNativeControls }: IGithubPanelProps) => {
  const signingIn = monitor.deviceFlow.status === "starting" || monitor.deviceFlow.status === "awaiting";
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const runImport = useCallback(async () => {
    setImporting(true);
    setImportError(null);
    try {
      await monitor.importFromGh();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  }, [monitor]);

  if (!canUseNativeControls) {
    return <div className="gh-empty">GitHub monitoring needs the desktop runtime.</div>;
  }

  if (monitor.accounts.length === 0) {
    return (
      <div className="gh-panel">
        <div className="gh-onboard">
          <span className="gh-onboard-badge"><GitBranch size={22} strokeWidth={2} /></span>
          <div className="gh-onboard-title">No GitHub accounts yet</div>
          <div className="gh-onboard-sub">Sign in to track your repos, CI, and PRs.</div>
          <div className="gh-onboard-actions">
            <button className="pill-btn accent" type="button" onClick={() => void monitor.startDeviceFlow()} disabled={signingIn}>
              <LogIn size={12} strokeWidth={2.3} /> Sign in with GitHub
            </button>
            <button className="pill-btn" type="button" onClick={() => void runImport()} disabled={importing}>
              {importing ? <RefreshCw className="gh-spin" size={12} strokeWidth={2.3} /> : <Download size={12} strokeWidth={2.3} />} Import from gh CLI
            </button>
          </div>
          {importError ? <div className="gh-card-line error">{importError}</div> : null}
          <DeviceFlowPrompt monitor={monitor} />
        </div>
      </div>
    );
  }

  return (
    <div className="gh-panel">
      <div className="gh-account-bar">
        <GitBranch size={13} strokeWidth={2.3} />
        <select
          className="gh-account-select"
          value={monitor.activeAccount ?? ""}
          disabled={monitor.switching}
          onChange={(event) => void monitor.switchTo(event.target.value)}
          aria-label="Active GitHub account"
        >
          {monitor.accounts.map((account) => (
            <option key={account.login} value={account.login}>
              {account.login}
              {account.active ? " ✓" : ""}
            </option>
          ))}
        </select>
        <button className="gh-icon-btn" type="button" aria-label="Refresh" onClick={() => { monitor.refresh(); void monitor.refreshAccounts(); }}>
          <RefreshCw size={12} strokeWidth={2.3} />
        </button>
        <button className="gh-icon-btn" type="button" aria-label="Sign in with another account" title="Sign in with another account" disabled={signingIn} onClick={() => void monitor.startDeviceFlow()}>
          <Plus size={12} strokeWidth={2.3} />
        </button>
      </div>
      {monitor.switching ? (
        <div className="gh-card-line muted"><RefreshCw className="gh-spin" size={12} strokeWidth={2.3} /> Switching account…</div>
      ) : null}
      <DeviceFlowPrompt monitor={monitor} />
      {monitor.activeAccount ? (
        <span className="gh-account-note muted">Switching updates Gyredeck and your global git identity.</span>
      ) : null}

      <AddRepo key={monitor.activeAccount ?? "none"} tracked={monitor.trackedRepos} onAdd={monitor.addRepo} />

      <div className="gh-cards">
        {monitor.trackedRepos.length === 0 ? (
          <div className="gh-empty">No repositories tracked yet. Add one accessible to the current account.</div>
        ) : (
          monitor.trackedRepos.map((repo) => (
            <RepoCard key={repo} repo={repo} state={monitor.statuses[repo]} onRemove={monitor.removeRepo} />
          ))
        )}
      </div>
    </div>
  );
};
