import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowRight, Check, Coffee, Download, Focus, KeyRound, Link2, Lock, MessageSquareDashed, Monitor as MonitorIcon, MoreVertical, Pencil, PlugZap, Puzzle, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import type { IGyredeckBridgeCapabilities } from "@gyredeck/protocol";
import { shortenPath } from "../session/activity";
import type { IUseUpdater } from "../updater/useUpdater";
import { ProviderIcon } from "../github/components";
import type { GitProvider, IGhAccount } from "../github/types";
import { useGitCredentialHelper } from "./useGitCredentialHelper";

type SetupCategory = "connection" | "permission" | "plugins" | "display" | "git" | "update";
// Alphabetical. Arrow-key order and the visible order are the same list, because a
// roving tabstop that jumps somewhere else is a bug.
const SETUP_CATEGORIES: SetupCategory[] = ["connection", "display", "git", "permission", "plugins", "update"];

// Terminals Focus can jump to. Add a row here (plus its AppleScript in the native
// focus_terminal handler) to support another terminal.
type TerminalChoice = "iterm" | "ghostty" | "terminal";
const TERMINAL_OPTIONS: Array<{ value: TerminalChoice; label: string }> = [
  { value: "ghostty", label: "Ghostty" },
  { value: "iterm", label: "iTerm2" },
  { value: "terminal", label: "Terminal" },
];

export interface ISetupPanelProps {
  capabilities: IGyredeckBridgeCapabilities;
  canUseNativeControls: boolean;
  connectionTitle: string;
  guidance: { title: string; detail: string };
  isConnected: boolean;
  keepAwakeActive: boolean;
  keepAwakeEnabled: boolean;
  keepAwakeError: string | null;
  hookStatus: { path: string | null; installed: boolean | null };
  /** Rooms the bridge currently holds, keyed by code. Only ones with members are shown. */
  mailRooms: Record<string, { room: string; members: string[]; pending: number; founder: string | null }>;
  onCloseRoom: (room: string, founder: string) => Promise<void>;
  /** Null while unknown, so the switch does not claim "off" before it has looked. */
  syncRepliesAllowed: boolean | null;
  syncRepliesBusy: boolean;
  onSyncRepliesChange: (next: boolean) => Promise<void>;
  agyStatus: { path: string | null; installed: boolean | null };
  codexStatus: { path: string | null; installed: boolean | null };
  nativeAction: { bridgeOnline: boolean | null; message: string | null };
  onCheckBridge: () => Promise<void> | void;
  onInstallHook: () => Promise<void> | void;
  onInstallAgy: () => Promise<void> | void;
  onInstallCodex: () => Promise<void> | void;
  onKeepAwakeChange: (enabled: boolean) => void;
  bridgePort: number;
  onApplyBridgePort: (port: number) => Promise<void> | void;
  gitAccounts: IGhAccount[];
  onRemoveGitAccount: (provider: GitProvider, user: string) => Promise<void> | void;
  onSetActiveGitAccount: (provider: GitProvider, user: string) => Promise<void> | void;
  syncGitIdentity: boolean;
  onSyncGitIdentityChange: (enabled: boolean) => Promise<void> | void;
  terminal: TerminalChoice;
  onTerminalChange: (choice: TerminalChoice) => void;
  updater: IUseUpdater;
}

const GitAccountRow = ({ account, isHelper, onSetActive, onRemove }: {
  account: IGhAccount;
  isHelper: boolean;
  onSetActive: (provider: GitProvider, user: string) => Promise<void> | void;
  onRemove: (provider: GitProvider, user: string) => Promise<void> | void;
}) => {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const close = () => { setOpen(false); setConfirming(false); };

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const run = async (fn: () => Promise<void> | void) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); close(); }
  };

  return (
    <div className="setup-account-row">
      <span className="setup-account-icon"><ProviderIcon provider={account.provider} size={14} /></span>
      <div className="setup-account-main">
        <span className="setup-account-login">{account.login}</span>
        {account.active || isHelper ? (
          <div className="setup-account-tags">
            {account.active ? <span className="setup-account-active">Active</span> : null}
            {isHelper ? <span className="setup-account-helper" title="git push on this host uses this account">helper</span> : null}
          </div>
        ) : null}
      </div>
      <div className="setup-account-menu-wrap" ref={ref}>
        <button className="gh-icon-btn" type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${account.login}`} title="Account actions" data-tauri-drag-region="false" onClick={() => setOpen((o) => !o)}>
          <MoreVertical size={12} strokeWidth={2.3} />
        </button>
        {open ? (
          <div className="setup-menu" role="menu">
            <button className="setup-menu-item" type="button" role="menuitem" disabled={account.active || busy} onClick={() => void run(() => onSetActive(account.provider, account.login))}>
              <Check size={12} strokeWidth={2.3} /> Set active
            </button>
            <button className={`setup-menu-item danger${confirming ? " armed" : ""}`} type="button" role="menuitem" disabled={busy} title="Removes the account and signs out of its CLI (gh/glab)" onClick={() => { if (!confirming) { setConfirming(true); return; } void run(() => onRemove(account.provider, account.login)); }}>
              <Trash2 size={12} strokeWidth={2.3} /> {confirming ? "Confirm delete" : "Delete"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

const GitAccountList = ({ accounts, canUseNativeControls, onSetActive, onRemove }: { accounts: IGhAccount[]; canUseNativeControls: boolean; onSetActive: (provider: GitProvider, user: string) => Promise<void> | void; onRemove: (provider: GitProvider, user: string) => Promise<void> | void }) => {
  if (!canUseNativeControls) return null;
  if (accounts.length === 0) {
    return <div className="setup-row passive"><span className="status-slot"><KeyRound className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Accounts</span><span className="setup-detail">No accounts yet — add one in Git Monitor</span></span></div>;
  }
  // The account the credential helper resolves to per provider: the active
  // account for the active provider, otherwise the first account of that provider.
  const activeProvider = accounts.find((a) => a.active)?.provider ?? null;
  const helperKeys = new Set(
    Array.from(new Set(accounts.map((a) => a.provider)))
      .map((provider) => {
        const acc =
          (provider === activeProvider ? accounts.find((a) => a.active) : undefined) ??
          accounts.find((a) => a.provider === provider);
        return acc ? `${acc.provider}:${acc.login}` : null;
      })
      .filter((k): k is string => k !== null),
  );
  return (
    <div className="setup-account-list">
      {accounts.map((account) => {
        const key = `${account.provider}:${account.login}`;
        return (
          <GitAccountRow key={key} account={account} isHelper={helperKeys.has(key)} onSetActive={onSetActive} onRemove={onRemove} />
        );
      })}
    </div>
  );
};

/**
 * The sync rooms the bridge is holding, laid out like the account list, and shown only
 * while there are any.
 *
 * Only rooms with members: a plain mailbox exists for every session that has ever been
 * sent anything, and listing those would bury the two or three that mean something.
 * Read-only on purpose — a room is joined and left from a session's own detail panel,
 * where the person can see which session they are acting on.
 */
const SyncRoomList = ({
  rooms,
  canUseNativeControls,
  onCloseRoom,
}: {
  rooms: Record<string, { room: string; members: string[]; pending: number; founder: string | null }>;
  canUseNativeControls: boolean;
  onCloseRoom: (room: string, founder: string) => Promise<void>;
}) => {
  const [closing, setClosing] = useState<string | null>(null);
  if (!canUseNativeControls) return null;
  const open = Object.values(rooms).filter((entry) => entry.members.length > 0);
  // Absent rather than empty. A room exists only while people are using one, so "none
  // open" is the ordinary state and a row saying so would sit under Connection
  // permanently, describing nothing.
  if (open.length === 0) return null;
  return (
    <>
      <div className="setup-subheading">Sync rooms</div>
      <div className="setup-account-list">
      {open.map((entry) => (
        <div className="setup-account-row" key={entry.room} data-closing={closing === entry.room}>
          <span className="setup-account-icon"><Link2 size={15} strokeWidth={2.3} /></span>
          <span className="setup-account-main">
            <span className="setup-account-login">{entry.room}</span>
            <span className="setup-account-tags">
              {/* A count, not a roster: which sessions are in a room is answered in
                  their own detail panels, and naming them here made every row as tall
                  as the number of members. */}
              <span className="setup-detail">
                {entry.members.length === 1 ? "1 session" : `${entry.members.length} sessions`}
              </span>
            </span>
          </span>
          {entry.pending > 0 ? (
            <span className="setup-account-active" title={`${entry.pending} waiting to be collected`}>
              {entry.pending} waiting
            </span>
          ) : null}
          {entry.founder ? (
            // Closing ends the room for everyone in it, so it belongs to whoever opened
            // it — the same hand that gave out the password. It is not instant either:
            // every member is told and every stream is cut before the room goes, so the
            // button says it is working rather than sitting dead until the row leaves.
            <button
              className="gh-icon-btn danger"
              type="button"
              disabled={closing === entry.room}
              onClick={() => {
                setClosing(entry.room);
                void onCloseRoom(entry.room, entry.founder ?? "").finally(() => setClosing(null));
              }}
              data-tauri-drag-region="false"
              title={closing === entry.room ? "Closing…" : "Close this room for everyone in it"}
              aria-label={closing === entry.room ? `Closing room ${entry.room}` : `Close room ${entry.room}`}
            >
              {closing === entry.room ? (
                <RefreshCw className="setup-spin" size={13} strokeWidth={2.4} />
              ) : (
                <Trash2 size={13} strokeWidth={2.3} />
              )}
            </button>
          ) : null}
        </div>
        ))}
      </div>
    </>
  );
};

const UPDATER_DETAIL: Record<IUseUpdater["status"], string> = {
  idle: "Check for the latest release",
  checking: "Checking for updates…",
  available: "Update available",
  downloading: "Downloading update…",
  upToDate: "You're on the latest version",
  error: "Update check failed",
};

const MIN_BRIDGE_PORT = 1024;
const MAX_BRIDGE_PORT = 65535;

export const SetupPanel = ({ capabilities, canUseNativeControls, connectionTitle, guidance, isConnected, keepAwakeActive, keepAwakeEnabled, keepAwakeError, hookStatus, mailRooms, onCloseRoom, syncRepliesAllowed, syncRepliesBusy, onSyncRepliesChange, agyStatus, codexStatus, nativeAction, onCheckBridge, onInstallHook, onInstallAgy, onInstallCodex, onKeepAwakeChange, bridgePort, onApplyBridgePort, gitAccounts, onRemoveGitAccount, onSetActiveGitAccount, syncGitIdentity, onSyncGitIdentityChange, terminal, onTerminalChange, updater }: ISetupPanelProps) => {
  const [activeCategory, setActiveCategory] = useState<SetupCategory>("connection");
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia("(max-width: 380px)").matches);
  const credentialHelper = useGitCredentialHelper(canUseNativeControls);
  const [portField, setPortField] = useState(String(bridgePort));
  const [portBusy, setPortBusy] = useState(false);
  const [portStatus, setPortStatus] = useState<string | null>(null);
  const [editingPort, setEditingPort] = useState(false);
  // Which async Settings action is in flight, so its own control can show progress.
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const runAction = async (key: string, action: () => Promise<void> | void): Promise<void> => {
    setPendingAction(key);
    try {
      await action();
    } finally {
      setPendingAction(null);
    }
  };

  useEffect(() => { setPortField(String(bridgePort)); }, [bridgePort]);

  const parsedPort = Number(portField);
  const portValid = Number.isInteger(parsedPort) && parsedPort >= MIN_BRIDGE_PORT && parsedPort <= MAX_BRIDGE_PORT;
  const canApplyPort = canUseNativeControls && portValid && parsedPort !== bridgePort && !portBusy;

  const toggleEditPort = (): void => {
    setPortField(String(bridgePort));
    setPortStatus(null);
    setEditingPort((open) => !open);
  };

  const applyPort = async (): Promise<void> => {
    if (!canApplyPort) return;
    setPortBusy(true);
    setPortStatus(null);
    try {
      await onApplyBridgePort(parsedPort);
      setPortStatus(`Applied · reconnecting on ${parsedPort}`);
      setEditingPort(false);
    } catch (error) {
      setPortStatus(typeof error === "string" ? error : error instanceof Error ? error.message : "Could not change port");
    } finally {
      setPortBusy(false);
    }
  };

  const selectCategory = (category: SetupCategory): void => {
    setActiveCategory(category);
  };

  const handleCategoryKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, current: SetupCategory): void => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = SETUP_CATEGORIES.indexOf(current);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? SETUP_CATEGORIES.length - 1 : (currentIndex + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + SETUP_CATEGORIES.length) % SETUP_CATEGORIES.length;
    const next = SETUP_CATEGORIES[nextIndex] ?? "connection";
    selectCategory(next);
    window.requestAnimationFrame(() => document.getElementById(`setup-tab-${next}`)?.focus());
  };

  useEffect(() => {
    const query = window.matchMedia("(max-width: 380px)");
    const update = () => setCompactNavigation(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return (
    <div className="setup-body">
      <div className="setup-layout">
        <div className="setup-sidebar" role="tablist" aria-label="Setup sections" aria-orientation={compactNavigation ? "horizontal" : "vertical"}>
          <button className="setup-side-tab" id="setup-tab-connection" type="button" role="tab" aria-selected={activeCategory === "connection"} aria-controls="setup-panel-connection" tabIndex={activeCategory === "connection" ? 0 : -1} data-active={activeCategory === "connection"} onClick={() => selectCategory("connection")} onKeyDown={(event) => handleCategoryKeyDown(event, "connection")}><PlugZap size={12} strokeWidth={2.2} /><span>Connection</span></button>
          <button className="setup-side-tab" id="setup-tab-display" type="button" role="tab" aria-selected={activeCategory === "display"} aria-controls="setup-panel-display" tabIndex={activeCategory === "display" ? 0 : -1} data-active={activeCategory === "display"} onClick={() => selectCategory("display")} onKeyDown={(event) => handleCategoryKeyDown(event, "display")}><MonitorIcon size={12} strokeWidth={2.2} /><span>Display</span></button>
          <button className="setup-side-tab" id="setup-tab-git" type="button" role="tab" aria-selected={activeCategory === "git"} aria-controls="setup-panel-git" tabIndex={activeCategory === "git" ? 0 : -1} data-active={activeCategory === "git"} onClick={() => selectCategory("git")} onKeyDown={(event) => handleCategoryKeyDown(event, "git")}><KeyRound size={12} strokeWidth={2.2} /><span>Git</span></button>
          <button className="setup-side-tab" id="setup-tab-permission" type="button" role="tab" aria-selected={activeCategory === "permission"} aria-controls="setup-panel-permission" tabIndex={activeCategory === "permission" ? 0 : -1} data-active={activeCategory === "permission"} onClick={() => selectCategory("permission")} onKeyDown={(event) => handleCategoryKeyDown(event, "permission")}><ShieldCheck size={12} strokeWidth={2.2} /><span>Permission</span></button>
          <button className="setup-side-tab" id="setup-tab-plugins" type="button" role="tab" aria-selected={activeCategory === "plugins"} aria-controls="setup-panel-plugins" tabIndex={activeCategory === "plugins" ? 0 : -1} data-active={activeCategory === "plugins"} onClick={() => selectCategory("plugins")} onKeyDown={(event) => handleCategoryKeyDown(event, "plugins")}><Puzzle size={12} strokeWidth={2.2} /><span>Plugins</span></button>
          <button className="setup-side-tab" id="setup-tab-update" type="button" role="tab" aria-selected={activeCategory === "update"} aria-controls="setup-panel-update" tabIndex={activeCategory === "update" ? 0 : -1} data-active={activeCategory === "update"} onClick={() => selectCategory("update")} onKeyDown={(event) => handleCategoryKeyDown(event, "update")}><Download size={12} strokeWidth={2.2} /><span>Update</span></button>
        </div>

        <div className="setup-category-panel" id={`setup-panel-${activeCategory}`} role="tabpanel" aria-labelledby={`setup-tab-${activeCategory}`}>
          {activeCategory === "connection" ? (
            <>
              <div className="setup-section-heading"><span>Connection</span><small>Bridge and agent integration</small></div>
              <div className="setup-row"><span className="bridge-dot" data-connected={isConnected} title={connectionTitle} /><span className="setup-copy"><span className="setup-title">Bridge</span><span className="setup-detail">{connectionTitle}</span></span>{!isConnected ? <button className="pill-btn" type="button" disabled={pendingAction === "bridge"} onClick={() => void runAction("bridge", onCheckBridge)} data-tauri-drag-region="false" aria-label="Reconnect bridge">{pendingAction === "bridge" ? <RefreshCw className="setup-spin" size={12} strokeWidth={2.3} /> : <PlugZap size={12} strokeWidth={2.3} />}{pendingAction === "bridge" ? "Reconnecting…" : "Reconnect"}</button> : null}</div>
              <div className="setup-row setup-row-stack"><div className="setup-row-main"><span className="status-slot"><PlugZap className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Bridge port</span><span className="setup-detail">{!canUseNativeControls ? "Desktop runtime required" : portStatus ?? `Local bridge port · ${bridgePort}`}</span></span>{canUseNativeControls ? <button className="pill-btn" type="button" onClick={toggleEditPort} data-tauri-drag-region="false" aria-expanded={editingPort} aria-label="Edit bridge port"><Pencil size={12} strokeWidth={2.3} />Edit</button> : null}</div>{editingPort ? <span className="setup-row-actions full"><input className="setup-input" type="number" min={MIN_BRIDGE_PORT} max={MAX_BRIDGE_PORT} value={portField} onChange={(event) => setPortField(event.target.value)} disabled={portBusy} data-tauri-drag-region="false" aria-label="Bridge port" autoFocus /><button className="pill-btn accent" type="button" onClick={() => void applyPort()} disabled={!canApplyPort} data-tauri-drag-region="false"><Check size={12} strokeWidth={2.3} />Apply</button></span> : null}</div>
              <div className="setup-row passive"><span className="status-slot"><ArrowRight className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">{guidance.title}</span><span className="setup-detail">{guidance.detail}</span></span></div>
              {nativeAction.message ? <div className="notice-row" data-online={nativeAction.bridgeOnline === true} role="status" aria-live="polite">{nativeAction.message}</div> : null}
              <SyncRoomList rooms={mailRooms} canUseNativeControls={canUseNativeControls} onCloseRoom={onCloseRoom} />
            </>
          ) : null}

          {activeCategory === "permission" ? (
            <>
              <div className="setup-section-heading"><span>Permission</span><small>What an agent may do unprompted</small></div>
              <div className="setup-row"><span className="status-slot"><MessageSquareDashed className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Allow sync replies without asking</span><span className="setup-detail">{!canUseNativeControls ? "Desktop runtime required" : !hookStatus.installed ? "Needs the Claude Code hook — install it under Plugins" : syncRepliesAllowed === null ? "Checking…" : syncRepliesAllowed ? "On · a session answers its room without a prompt each time" : "Off · Claude Code asks before every reply and every wait"}</span></span>{!hookStatus.installed ? (
                // Shown but locked rather than hidden: the setting exists and its state
                // is worth seeing. A padlock says why it cannot be moved, where a greyed
                // switch would only say that it cannot.
                <span className="setup-locked" title="Install the Claude Code hook first"><Lock size={12} strokeWidth={2.4} /></span>
              ) : (
                <button className="switch-toggle" type="button" role="switch" aria-checked={syncRepliesAllowed === true} data-on={syncRepliesAllowed === true} disabled={!canUseNativeControls || syncRepliesBusy || syncRepliesAllowed === null} onClick={() => void onSyncRepliesChange(!syncRepliesAllowed)} data-tauri-drag-region="false" aria-label={`${syncRepliesAllowed ? "Stop allowing" : "Allow"} sync replies without asking`}><span className="switch-thumb" /></button>
              )}</div>
            </>
          ) : null}

          {activeCategory === "plugins" ? (
            <>
              <div className="setup-section-heading"><span>Plugins</span><small>Agent integrations</small></div>
              <div className="setup-row"><span className="status-slot"><Download className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Antigravity hooks</span><span className="setup-detail">{agyStatus.installed === true ? `Installed · ${shortenPath(agyStatus.path)}` : agyStatus.installed === false ? `Not installed · ${shortenPath(agyStatus.path)}` : canUseNativeControls ? "Checking install state" : "Tauri runtime needed"}</span></span>{agyStatus.installed ? (<span className="setup-installed"><Check size={12} strokeWidth={2.6} />Installed</span>) : (<button className="pill-btn accent" type="button" disabled={pendingAction === "agy"} onClick={() => void runAction("agy", onInstallAgy)} data-tauri-drag-region="false">{pendingAction === "agy" ? <RefreshCw className="setup-spin" size={12} strokeWidth={2.3} /> : <Download size={12} strokeWidth={2.3} />}{pendingAction === "agy" ? "Installing…" : "Install"}</button>)}</div>
              <div className="setup-row"><span className="status-slot"><Download className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Codex hooks</span><span className="setup-detail">{codexStatus.installed === true ? `Installed · ${shortenPath(codexStatus.path)}` : codexStatus.installed === false ? `Not installed · ${shortenPath(codexStatus.path)}` : canUseNativeControls ? "Checking install state" : "Tauri runtime needed"}</span></span>{codexStatus.installed ? (<span className="setup-installed"><Check size={12} strokeWidth={2.6} />Installed</span>) : (<button className="pill-btn accent" type="button" disabled={pendingAction === "codex"} onClick={() => void runAction("codex", onInstallCodex)} data-tauri-drag-region="false">{pendingAction === "codex" ? <RefreshCw className="setup-spin" size={12} strokeWidth={2.3} /> : <Download size={12} strokeWidth={2.3} />}{pendingAction === "codex" ? "Installing…" : "Install"}</button>)}</div>
              <div className="setup-row"><span className="status-slot"><Download className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Claude Code hooks</span><span className="setup-detail">{hookStatus.installed === true ? `Installed · ${shortenPath(hookStatus.path)}` : hookStatus.installed === false ? `Not installed · ${shortenPath(hookStatus.path)}` : canUseNativeControls ? "Checking install state" : "Tauri runtime needed"}</span></span>{hookStatus.installed ? (<span className="setup-installed"><Check size={12} strokeWidth={2.6} />Installed</span>) : (<button className="pill-btn accent" type="button" disabled={pendingAction === "hook"} onClick={() => void runAction("hook", onInstallHook)} data-tauri-drag-region="false">{pendingAction === "hook" ? <RefreshCw className="setup-spin" size={12} strokeWidth={2.3} /> : <Download size={12} strokeWidth={2.3} />}{pendingAction === "hook" ? "Installing…" : "Install"}</button>)}</div>
            </>
          ) : null}

          {activeCategory === "display" ? (
            <>
              <div className="setup-section-heading"><span>Display</span><small>Screen and focus behavior</small></div>
              <div className="setup-row"><span className="status-slot"><Coffee className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Keep awake while working</span><span className="setup-detail">{!keepAwakeEnabled ? "Off · display follows macOS idle settings" : !canUseNativeControls ? "Desktop runtime required" : keepAwakeError ? `Unavailable · ${keepAwakeError}` : keepAwakeActive ? "Active · agent working — display won't sleep" : "On · will stay awake only while an agent is working"}</span></span><button className="switch-toggle" type="button" role="switch" aria-checked={keepAwakeEnabled} data-on={keepAwakeEnabled} disabled={!canUseNativeControls} onClick={() => onKeepAwakeChange(!keepAwakeEnabled)} data-tauri-drag-region="false" aria-label={`${keepAwakeEnabled ? "Disable" : "Enable"} keep display awake`}><span className="switch-thumb" /></button></div>
              <div className="setup-row"><span className="status-slot"><Focus className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Terminal</span><span className="setup-detail">Focus jumps to this terminal at the session cwd</span></span><select className="setup-select" value={terminal} onChange={(event) => onTerminalChange(event.target.value as TerminalChoice)} data-tauri-drag-region="false" aria-label="Focus terminal">{TERMINAL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
            </>
          ) : null}

          {activeCategory === "git" ? (
            <>
              <div className="setup-section-heading"><span>Git</span><small>Credential helper · GitHub &amp; GitLab</small></div>
              <div className="setup-row"><span className="status-slot"><KeyRound className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Use Gyredeck for git auth</span><span className="setup-detail">{!canUseNativeControls ? "Desktop runtime required" : credentialHelper.error ? credentialHelper.error : credentialHelper.installed === null ? "Checking…" : credentialHelper.installed ? "On · git push/pull uses your active account" : "Off · git uses its default helper (e.g. osxkeychain)"}</span></span><button className="switch-toggle" type="button" role="switch" aria-checked={credentialHelper.installed === true} data-on={credentialHelper.installed === true} disabled={!canUseNativeControls || credentialHelper.busy || credentialHelper.installed === null} onClick={() => void credentialHelper.setEnabled(!credentialHelper.installed)} data-tauri-drag-region="false" aria-label={`${credentialHelper.installed ? "Disable" : "Enable"} Gyredeck git credential helper`}><span className="switch-thumb" /></button></div>
              <div className="setup-row"><span className="status-slot"><RefreshCw className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Sync git identity</span><span className="setup-detail">{!canUseNativeControls ? "Desktop runtime required" : syncGitIdentity ? "On · switching sets your global git identity & gh" : "Off · switching only changes what you view — system git untouched"}</span></span><button className="switch-toggle" type="button" role="switch" aria-checked={syncGitIdentity} data-on={syncGitIdentity} disabled={!canUseNativeControls || pendingAction === "sync"} onClick={() => void runAction("sync", () => onSyncGitIdentityChange(!syncGitIdentity))} data-tauri-drag-region="false" aria-label={`${syncGitIdentity ? "Disable" : "Enable"} git identity sync`}><span className="switch-thumb" /></button></div>
              <div className="setup-subheading">Accounts</div>
              <GitAccountList accounts={gitAccounts} canUseNativeControls={canUseNativeControls} onSetActive={onSetActiveGitAccount} onRemove={onRemoveGitAccount} />
              <div className="setup-row passive"><span className="status-slot"><ArrowRight className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">How it works</span><span className="setup-detail">Points git at Gyredeck in your global ~/.gitconfig, so HTTPS pushes follow the account you pick on the Git Monitor tab — no gh CLI needed. Turn off to restore your previous helper.</span></span></div>
            </>
          ) : null}

          {activeCategory === "update" ? (
            <>
              <div className="setup-section-heading"><span>Update</span><small>App version and updates</small></div>
              <div className="setup-row passive"><span className="status-slot"><Check className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Current version</span><span className="setup-detail">{updater.currentVersion ? `v${updater.currentVersion}` : canUseNativeControls ? "Reading version…" : "Desktop runtime required"}</span></span></div>
              <div className="setup-row"><span className="status-slot"><Download className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">App updates</span><span className="setup-detail">{!canUseNativeControls ? "Desktop runtime required" : updater.status === "error" ? (updater.message ?? UPDATER_DETAIL.error) : updater.status === "available" ? `${UPDATER_DETAIL.available}${updater.version ? ` · v${updater.version}` : ""}` : updater.status === "downloading" ? UPDATER_DETAIL.downloading : UPDATER_DETAIL[updater.status]}</span></span>{updater.status === "available" || updater.status === "downloading" ? (<button className="pill-btn accent" type="button" disabled={!canUseNativeControls || updater.status === "downloading"} onClick={() => void updater.installAndRelaunch()} data-tauri-drag-region="false">{updater.status === "downloading" ? <RefreshCw className="setup-spin" size={12} strokeWidth={2.3} /> : <Download size={12} strokeWidth={2.3} />}{updater.status === "downloading" ? "Downloading…" : "Update"}</button>) : (<button className="pill-btn" type="button" disabled={!canUseNativeControls || updater.status === "checking"} onClick={() => void updater.check()} data-tauri-drag-region="false"><RefreshCw className={updater.status === "checking" ? "setup-spin" : undefined} size={12} strokeWidth={2.3} />{updater.status === "checking" ? "Checking…" : "Check"}</button>)}</div>
              {updater.status === "available" ? (
                <div className="update-notes">
                  <div className="update-notes-head"><span>Release notes{updater.version ? ` · v${updater.version}` : ""}</span>{updater.date ? <span className="update-notes-date">{updater.date.slice(0, 10)}</span> : null}</div>
                  <div className="update-notes-body">{updater.notes?.trim() ? updater.notes.trim() : "No release notes provided."}</div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};
