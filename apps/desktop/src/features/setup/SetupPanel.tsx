import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowRight, Check, Coffee, Download, Focus, KeyRound, Monitor as MonitorIcon, PlugZap, Puzzle, RefreshCw } from "lucide-react";
import type { IGyredeckBridgeCapabilities } from "@gyredeck/protocol";
import { shortenPath } from "../session/activity";
import type { IUseUpdater } from "../updater/useUpdater";
import { useGitCredentialHelper } from "./useGitCredentialHelper";

type SetupCategory = "connection" | "plugins" | "display" | "git" | "update";
const SETUP_CATEGORIES: SetupCategory[] = ["connection", "display", "git", "plugins", "update"];

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
  agyStatus: { path: string | null; installed: boolean | null };
  nativeAction: { bridgeOnline: boolean | null; message: string | null };
  onCheckBridge: () => void;
  onInstallHook: () => void;
  onInstallAgy: () => void;
  onKeepAwakeChange: (enabled: boolean) => void;
  bridgePort: number;
  onApplyBridgePort: (port: number) => Promise<void> | void;
  terminal: TerminalChoice;
  onTerminalChange: (choice: TerminalChoice) => void;
  updater: IUseUpdater;
}

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

export const SetupPanel = ({ capabilities, canUseNativeControls, connectionTitle, guidance, isConnected, keepAwakeActive, keepAwakeEnabled, keepAwakeError, hookStatus, agyStatus, nativeAction, onCheckBridge, onInstallHook, onInstallAgy, onKeepAwakeChange, bridgePort, onApplyBridgePort, terminal, onTerminalChange, updater }: ISetupPanelProps) => {
  const [activeCategory, setActiveCategory] = useState<SetupCategory>("connection");
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia("(max-width: 380px)").matches);
  const credentialHelper = useGitCredentialHelper(canUseNativeControls);
  const [portField, setPortField] = useState(String(bridgePort));
  const [portBusy, setPortBusy] = useState(false);
  const [portStatus, setPortStatus] = useState<string | null>(null);

  useEffect(() => { setPortField(String(bridgePort)); }, [bridgePort]);

  const parsedPort = Number(portField);
  const portValid = Number.isInteger(parsedPort) && parsedPort >= MIN_BRIDGE_PORT && parsedPort <= MAX_BRIDGE_PORT;
  const canApplyPort = canUseNativeControls && portValid && parsedPort !== bridgePort && !portBusy;

  const applyPort = async (): Promise<void> => {
    if (!canApplyPort) return;
    setPortBusy(true);
    setPortStatus(null);
    try {
      await onApplyBridgePort(parsedPort);
      setPortStatus(`Applied · reconnecting on ${parsedPort}`);
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
          <button className="setup-side-tab" id="setup-tab-plugins" type="button" role="tab" aria-selected={activeCategory === "plugins"} aria-controls="setup-panel-plugins" tabIndex={activeCategory === "plugins" ? 0 : -1} data-active={activeCategory === "plugins"} onClick={() => selectCategory("plugins")} onKeyDown={(event) => handleCategoryKeyDown(event, "plugins")}><Puzzle size={12} strokeWidth={2.2} /><span>Plugins</span></button>
          <button className="setup-side-tab" id="setup-tab-update" type="button" role="tab" aria-selected={activeCategory === "update"} aria-controls="setup-panel-update" tabIndex={activeCategory === "update" ? 0 : -1} data-active={activeCategory === "update"} onClick={() => selectCategory("update")} onKeyDown={(event) => handleCategoryKeyDown(event, "update")}><Download size={12} strokeWidth={2.2} /><span>Update</span></button>
        </div>

        <div className="setup-category-panel" id={`setup-panel-${activeCategory}`} role="tabpanel" aria-labelledby={`setup-tab-${activeCategory}`}>
          {activeCategory === "connection" ? (
            <>
              <div className="setup-section-heading"><span>Connection</span><small>Bridge and agent integration</small></div>
              <div className="setup-row"><span className="bridge-dot" data-connected={isConnected} title={connectionTitle} /><span className="setup-copy"><span className="setup-title">Bridge</span><span className="setup-detail">{connectionTitle}</span></span>{!isConnected ? <button className="pill-btn" type="button" onClick={onCheckBridge} data-tauri-drag-region="false" aria-label="Reconnect bridge"><PlugZap size={12} strokeWidth={2.3} />Reconnect</button> : null}</div>
              <div className="setup-row"><span className="status-slot"><PlugZap className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Bridge port</span><span className="setup-detail">{!canUseNativeControls ? "Desktop runtime required" : portStatus ?? `Local port the bridge listens on · ${MIN_BRIDGE_PORT}–${MAX_BRIDGE_PORT}`}</span></span><input className="setup-input" type="number" min={MIN_BRIDGE_PORT} max={MAX_BRIDGE_PORT} value={portField} onChange={(event) => setPortField(event.target.value)} disabled={!canUseNativeControls || portBusy} data-tauri-drag-region="false" aria-label="Bridge port" /><button className="pill-btn accent" type="button" onClick={() => void applyPort()} disabled={!canApplyPort} data-tauri-drag-region="false"><Check size={12} strokeWidth={2.3} />Apply</button></div>
              <div className="setup-row passive"><span className="status-slot"><ArrowRight className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">{guidance.title}</span><span className="setup-detail">{guidance.detail}</span></span></div>
              {nativeAction.message ? <div className="notice-row" data-online={nativeAction.bridgeOnline === true} role="status" aria-live="polite">{nativeAction.message}</div> : null}
            </>
          ) : null}

          {activeCategory === "plugins" ? (
            <>
              <div className="setup-section-heading"><span>Plugins</span><small>Agent integrations</small></div>
              <div className="setup-row"><span className="status-slot"><Download className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Claude Code hooks</span><span className="setup-detail">{hookStatus.installed === true ? `Installed · ${shortenPath(hookStatus.path)}` : hookStatus.installed === false ? `Not installed · ${shortenPath(hookStatus.path)}` : canUseNativeControls ? "Checking install state" : "Tauri runtime needed"}</span></span>{hookStatus.installed ? (<span className="setup-installed"><Check size={12} strokeWidth={2.6} />Installed</span>) : (<button className="pill-btn accent" type="button" onClick={onInstallHook} data-tauri-drag-region="false"><Download size={12} strokeWidth={2.3} />Install</button>)}</div>
              <div className="setup-row"><span className="status-slot"><Download className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Antigravity hooks</span><span className="setup-detail">{agyStatus.installed === true ? `Installed · ${shortenPath(agyStatus.path)}` : agyStatus.installed === false ? `Not installed · ${shortenPath(agyStatus.path)}` : canUseNativeControls ? "Checking install state" : "Tauri runtime needed"}</span></span>{agyStatus.installed ? (<span className="setup-installed"><Check size={12} strokeWidth={2.6} />Installed</span>) : (<button className="pill-btn accent" type="button" onClick={onInstallAgy} data-tauri-drag-region="false"><Download size={12} strokeWidth={2.3} />Install</button>)}</div>
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
              <div className="setup-section-heading"><span>Git</span><small>Credential helper for GitHub</small></div>
              <div className="setup-row"><span className="status-slot"><KeyRound className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Use Gyredeck for git auth</span><span className="setup-detail">{!canUseNativeControls ? "Desktop runtime required" : credentialHelper.error ? credentialHelper.error : credentialHelper.installed === null ? "Checking…" : credentialHelper.installed ? "On · git push/pull uses your active GitHub account" : "Off · git uses its default helper (e.g. osxkeychain)"}</span></span><button className="switch-toggle" type="button" role="switch" aria-checked={credentialHelper.installed === true} data-on={credentialHelper.installed === true} disabled={!canUseNativeControls || credentialHelper.busy || credentialHelper.installed === null} onClick={() => void credentialHelper.setEnabled(!credentialHelper.installed)} data-tauri-drag-region="false" aria-label={`${credentialHelper.installed ? "Disable" : "Enable"} Gyredeck git credential helper`}><span className="switch-thumb" /></button></div>
              <div className="setup-row passive"><span className="status-slot"><ArrowRight className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">How it works</span><span className="setup-detail">Points git at Gyredeck in your global ~/.gitconfig, so HTTPS pushes follow the account you pick on the GitHub tab — no gh CLI needed. Turn off to restore your previous helper.</span></span></div>
            </>
          ) : null}

          {activeCategory === "update" ? (
            <>
              <div className="setup-section-heading"><span>Update</span><small>App version and updates</small></div>
              <div className="setup-row passive"><span className="status-slot"><Check className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Current version</span><span className="setup-detail">{updater.currentVersion ? `v${updater.currentVersion}` : canUseNativeControls ? "Reading version…" : "Desktop runtime required"}</span></span></div>
              <div className="setup-row"><span className="status-slot"><Download className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">App updates</span><span className="setup-detail">{!canUseNativeControls ? "Desktop runtime required" : updater.status === "error" ? (updater.message ?? UPDATER_DETAIL.error) : updater.status === "available" ? `${UPDATER_DETAIL.available}${updater.version ? ` · v${updater.version}` : ""}` : updater.status === "downloading" ? UPDATER_DETAIL.downloading : UPDATER_DETAIL[updater.status]}</span></span>{updater.status === "available" ? (<button className="pill-btn accent" type="button" disabled={!canUseNativeControls} onClick={() => void updater.installAndRelaunch()} data-tauri-drag-region="false"><Download size={12} strokeWidth={2.3} />Update</button>) : (<button className="pill-btn" type="button" disabled={!canUseNativeControls || updater.status === "checking" || updater.status === "downloading"} onClick={() => void updater.check()} data-tauri-drag-region="false"><RefreshCw size={12} strokeWidth={2.3} />Check</button>)}</div>
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
