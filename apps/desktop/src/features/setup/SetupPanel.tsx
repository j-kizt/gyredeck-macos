import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { ArrowRight, Bell, Check, Coffee, DoorClosed, Download, Focus, Gauge, KeyRound, Link2, Lock, MessageSquareDashed, Monitor as MonitorIcon, MoreVertical, Pencil, PlugZap, Power, Puzzle, RefreshCw, ShieldCheck, Trash2, type LucideIcon } from "lucide-react";
import type { IGyredeckBridgeCapabilities } from "@gyredeck/protocol";
import type { INotificationsState, NotificationPermission } from "../notifications/useNotifications";
import { shortenPath } from "../session/activity";
import type { IUseUpdater } from "../updater/useUpdater";
import { ProviderIcon } from "../github/components";
import type { GitProvider, IGhAccount } from "../github/types";
import { useGitCredentialHelper } from "./useGitCredentialHelper";
import HeavyPatternsRow from "./HeavyPatternsRow";
import { useHeavyRuns } from "./useHeavyRuns";
import { codexTrustCopy, hookNeedsAttention, hookSettled, type IHookStatus } from "./hookStatus";
import { useDiscord, type IUseDiscord } from "./useDiscord";
import { DiscordLogo, DiscordRows, heldLine } from "./DiscordRows";
import { offerDisconnectAll, showSyncRooms, stillHeld } from "./disconnectAll";
import { ReleaseNotes } from "./ReleaseNotes";
import { MfaRow } from "./MfaRow";

export type SyncAgent = "claude" | "agy";

// Alphabetical by label (owner, 2026-11-09), so a new tab has one right place. The tabs are drawn
// from this list and the arrow keys walk it, because a roving tabstop that jumps somewhere other
// than the next tab on screen is a bug.
const SETUP_CATEGORIES = [
  { id: "connection", label: "Connection", icon: PlugZap },
  { id: "display", label: "Display", icon: MonitorIcon },
  { id: "git", label: "Git", icon: KeyRound },
  { id: "notification", label: "Notification", icon: Bell },
  { id: "permission", label: "Permission", icon: ShieldCheck },
  { id: "plugins", label: "Plugins", icon: Puzzle },
  { id: "sync", label: "Sync", icon: Link2 },
  { id: "update", label: "Update", icon: Download },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: LucideIcon }>;
type SetupCategory = (typeof SETUP_CATEGORIES)[number]["id"];

// Terminals Focus can jump to. Add a row here (plus its AppleScript in the native
// focus_terminal handler) to support another terminal.
type TerminalChoice = "iterm" | "ghostty" | "terminal";
const TERMINAL_OPTIONS: Array<{ value: TerminalChoice; label: string }> = [
  { value: "ghostty", label: "Ghostty" },
  { value: "iterm", label: "iTerm2" },
  { value: "terminal", label: "Terminal" },
];

/**
 * One agent integration, as a row that says where it stands and offers the one action
 * that changes it.
 *
 * A component rather than four near-identical lines: the last change to this rule was
 * made to three of the four and the fourth went unnoticed, because nothing in TypeScript
 * can see that four lines were meant to agree. There is now one place for it to be wrong.
 */
const PluginRow = ({ title, status, canUseNativeControls, busy, onInstall, onRecheck, rechecking = false }: {
  title: string;
  status: IHookStatus;
  canUseNativeControls: boolean;
  busy: boolean;
  onInstall: () => void;
  /** Codex hooks only: ask Codex again, after the person has been to `/hooks`. */
  onRecheck?: () => void;
  rechecking?: boolean;
}) => {
  // Out of date comes first: that one is fixed here, by installing, and installing is what
  // changes the hook Codex was asked to approve — so approval is only worth reading once
  // the hook is the current one.
  // `trust` is absent on every row but Codex's, and `codexTrustCopy(undefined)` says nothing.
  const trustCopy = status.installed === true && status.stale === false && status.trust !== undefined
    ? codexTrustCopy(status.trust)
    : null;
  const detail =
    status.stale === true ? "Out of date · install again so it keeps reporting"
    : status.installed === true && status.stale === null ? "Installed · could not check whether it is current"
    : trustCopy ? trustCopy.detail
    : status.installed === true && status.trust === "approved" ? `Installed · approved in Codex`
    : status.installed === true ? `Installed · ${shortenPath(status.path)}`
    : status.installed === false ? `Not installed · ${shortenPath(status.path)}`
    : canUseNativeControls ? "Checking install state"
    : "Tauri runtime needed";
  // Settled is the only state with nothing to do or find out. An unknown currency keeps its
  // button, because the way to find out is to install again; an approval still being read
  // keeps the checkmark off until Codex has answered.
  const settled = hookSettled(status);
  // What Codex has not approved is not fixed by installing again, so the button asks
  // Codex again instead of offering a reinstall that would change nothing.
  const recheck = trustCopy !== null && onRecheck !== undefined;
  const checking = rechecking || (recheck && status.trust === null);
  return (
    <div className="setup-row"><span className="status-slot"><Download className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">{title}</span><span className="setup-detail">{detail}</span>{trustCopy?.step ? <span className="setup-detail">{trustCopy.step}</span> : null}</span>{settled ? (<span className="setup-installed"><Check size={12} strokeWidth={2.6} />Installed</span>) : recheck ? (<button className="pill-btn accent" type="button" disabled={checking} onClick={onRecheck} data-tauri-drag-region="false"><RefreshCw className={checking ? "setup-spin" : undefined} size={12} strokeWidth={2.3} />{checking ? "Checking…" : "Recheck"}</button>) : (<button className="pill-btn accent" type="button" disabled={busy} onClick={onInstall} data-tauri-drag-region="false">{busy ? <RefreshCw className="setup-spin" size={12} strokeWidth={2.3} /> : <Download size={12} strokeWidth={2.3} />}{busy ? "Installing…" : status.installed === true ? "Reinstall" : "Install"}</button>)}</div>
  );
};

export interface ISetupPanelProps {
  capabilities: IGyredeckBridgeCapabilities;
  canUseNativeControls: boolean;
  connectionTitle: string;
  guidance: { title: string; detail: string };
  isConnected: boolean;
  launchAtLogin: { enabled: boolean; busy: boolean; error: string | null; set: (enabled: boolean) => Promise<void> };
  /** What holds the Mac awake now, as Rust says; null while nothing does. */
  keepAwakeWhy?: string | null;
  keepAwakeEnabled: boolean;
  keepAwakeError: string | null;
  hookStatus: IHookStatus;
  /** Rooms the bridge currently holds, keyed by code. Only ones with members are shown. */
  mailRooms: Record<string, { room: string; members: string[]; pending: number; founder: string | null; sessions?: number | null }>;
  notifications: INotificationsState;
  onCloseRoom: (room: string, founder: string) => Promise<void>;
  /** Per agent; null or absent while unknown, so a switch does not claim "off" before it has looked; a string is why it could not look. */
  syncRepliesAllowed: Partial<Record<SyncAgent, boolean | string | null>>;
  syncRepliesBusy: boolean;
  onSyncRepliesChange: (agent: SyncAgent, next: boolean) => Promise<void>;
  agyStatus: IHookStatus;
  codexStatus: IHookStatus;
  codexNotifyStatus: IHookStatus;
  onInstallCodexNotify: () => Promise<void> | void;
  nativeAction: { bridgeOnline: boolean | null; message: string | null };
  onCheckBridge: () => Promise<void> | void;
  onInstallHook: () => Promise<void> | void;
  onInstallAgy: () => Promise<void> | void;
  onInstallCodex: () => Promise<void> | void;
  onRecheckCodexTrust: () => Promise<void> | void;
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

const menuItems = (wrap: HTMLElement | null) =>
  Array.from(wrap?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

/**
 * A row's ⋮ menu closes on a click outside it or on Escape: one rule for every such menu. The
 * returned handler goes on the menu's wrapper: an Escape pressed inside an open menu closes the
 * menu only, and does not also reach the surface, where Escape closes Settings.
 *
 * It is also the keyboard of a menu button, since the trigger says aria-haspopup="menu": opening
 * moves focus to the first item, the arrows, Home and End move between the items that can be
 * pressed, and Escape hands focus back to the trigger (#376 audit).
 */
const useMenuDismiss = (open: boolean, ref: RefObject<HTMLElement | null>, close: () => void) => {
  const latestClose = useRef(close);
  latestClose.current = close;
  useEffect(() => {
    if (open) menuItems(ref.current)[0]?.focus();
  }, [open, ref]);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) latestClose.current();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") latestClose.current(); };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, ref]);
  return (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      latestClose.current();
      ref.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
      return;
    }
    const items = menuItems(ref.current);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    items[(next + items.length) % items.length].focus();
  };
};

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
  const onMenuKeyDown = useMenuDismiss(open, ref, close);

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
      <div className="setup-account-menu-wrap" ref={ref} onKeyDown={onMenuKeyDown}>
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

type MailRoom = ISetupPanelProps["mailRooms"][string];

/**
 * One sync room, laid out like a Git account, with its actions in the same ⋮ menu (#376).
 *
 * Closing ends the room for everyone in it, so it is asked as the founder, the same hand that
 * gave out the password. It is not instant either: every member is told and every stream is cut
 * before the room goes, so the ⋮ button spins and stays shut until the close has finished,
 * rather than offering a second close of a room already going. The state is the row's own, so
 * two rooms closing at once each keep theirs.
 */
const SyncRoomRow = ({ entry, discord, discordReady, onCloseRoom }: {
  entry: MailRoom;
  discord: IUseDiscord;
  discordReady: boolean;
  onCloseRoom: (room: string, founder: string) => Promise<void>;
}) => {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  const onMenuKeyDown = useMenuDismiss(open, ref, close);
  const followed = discord.status?.connectedRooms.includes(entry.room) === true;
  const held = heldLine(discord.status, entry.room);
  const founder = entry.founder;
  // Discord takes no session's place (#456), so the count and Connect leave it out.
  const sessions = entry.sessions ?? entry.members.length;
  const failed = discord.failedOn?.room === entry.room ? discord.failure : null;
  const failedLine = !failed ? null
    : discord.failedOn?.command !== "discord_connect" ? `Couldn't disconnect from Discord: ${failed}`
    : `Couldn't connect to Discord: ${failed}`;
  return (
    <div className="setup-account-row" data-closing={closing} data-held={held || failedLine ? "true" : undefined}>
      <span className="setup-account-icon"><Link2 size={15} strokeWidth={2.3} /></span>
      <span className="setup-account-main">
        <span className="setup-account-login">
          {entry.room}
          {followed ? <span className="setup-room-discord" role="img" aria-label="Connected to Discord"><DiscordLogo size={12} /></span> : null}
        </span>
        <span className="setup-account-tags">
          {/* A count, not a roster: which sessions are in a room is answered in
              their own detail panels, and naming them here made every row as tall
              as the number of members. */}
          <span className="setup-detail">
            {sessions === 1 ? "1 session" : `${sessions} sessions`}
          </span>
        </span>
      </span>
      {entry.pending > 0 ? (
        <span className="setup-account-active" title={`${entry.pending} waiting to be collected`}>
          {entry.pending} waiting
        </span>
      ) : null}
      <div className="setup-account-menu-wrap" ref={ref} onKeyDown={onMenuKeyDown}>
        <button className="gh-icon-btn" type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${entry.room}`} aria-busy={closing} title={closing ? "Closing…" : "Room actions"} disabled={closing} data-tauri-drag-region="false" onClick={() => setOpen((o) => !o)}>
          {closing ? <RefreshCw className="setup-spin" size={12} strokeWidth={2.4} /> : <MoreVertical size={12} strokeWidth={2.3} />}
        </button>
        {open ? (
          <div className="setup-menu" role="menu">
            {/* Offered only once a post has somewhere to go and someone to answer to, and only for a
                room this Mac founded, as before #376. */}
            {founder && discordReady ? (
              <button className="setup-menu-item" type="button" role="menuitem" disabled={discord.busy} aria-label={followed ? "Disconnect from Discord" : "Connect to Discord"} onClick={() => { close(); void discord.run(followed ? "discord_disconnect" : "discord_connect", { code: entry.room }); }}>
                <DiscordLogo size={12} /> {followed ? "Disconnect" : "Connect"}
              </button>
            ) : null}
            {/* The founder is the input sync_close needs; a bridge that names none gets no close to send. */}
            <button className="setup-menu-item danger" type="button" role="menuitem" aria-disabled={!founder || undefined} aria-label={founder ? undefined : "Close room: this room's founder is not known"} title={founder ? "Close this room for everyone in it" : "This room's founder is not known"} onClick={() => {
              if (!founder) return;
              close();
              setClosing(true);
              void onCloseRoom(entry.room, founder).finally(() => setClosing(false));
            }}>
              <DoorClosed size={12} strokeWidth={2.3} /> Close room
            </button>
          </div>
        ) : null}
      </div>
      {held ? <span className="setup-detail setup-account-held" role="status" data-discord="room-held">{held}</span> : null}
      {failedLine ? <span className="setup-detail setup-account-held" role="status" data-discord="room-failed">{failedLine}</span> : null}
    </div>
  );
};

/**
 * The sync rooms the bridge is holding, laid out like the account list, and shown only
 * while there are any.
 *
 * Only rooms with members: a plain mailbox exists for every session that has ever been
 * sent anything, and listing those would bury the two or three that mean something.
 * A room is joined and left from a session's own detail panel, where the person can see
 * which session they are acting on.
 */
// The rooms that get a row under Sync → Rooms; a held room outside it is said under Remote access instead (#199).
const openRooms = (rooms: ISetupPanelProps["mailRooms"]) => Object.values(rooms).filter((entry) => entry.members.length > 0);

const SyncRoomList = ({
  rooms,
  canUseNativeControls,
  onCloseRoom,
  discord,
}: {
  rooms: Record<string, MailRoom>;
  canUseNativeControls: boolean;
  onCloseRoom: (room: string, founder: string) => Promise<void>;
  discord: IUseDiscord;
}) => {
  // `ready`, not a bot name: a name can be left over from a connector whose token was since refused.
  const discordReady = Boolean(discord.status?.ready && discord.status.forumId && discord.status.owner);
  if (!canUseNativeControls) return null;
  const open = openRooms(rooms);
  // Every room at once lives here, on the Mac, never in Discord: a post acts on its own room
  // only (owner, 2026-11-02). The set is the rooms connected at the press.
  const connected = discord.status?.connectedRooms ?? [];
  const held = stillHeld(discord.stillConnected, { connectedRooms: connected, leaving: discord.status?.leaving });
  const still = held.connected;
  // Absent rather than empty. A room exists only while people are using one, so "none
  // open" is the ordinary state and a row saying so would sit under Sync permanently,
  // describing nothing — unless Discord still follows a room or failed to leave one.
  if (!showSyncRooms(open.length, connected, held)) return null;
  return (
    <>
      <div className="setup-subheading setup-subheading-row">
        <span>Rooms</span>
        {connected.length > 0 ? (
          // The visible words no longer say Discord; the logo and the accessible name do.
          <button className="pill-btn danger" type="button" disabled={discord.busy} onClick={() => void discord.disconnectAll(connected)} data-tauri-drag-region="false" aria-label="Disconnect all from Discord">
            <DiscordLogo size={12} />Disconnect all
          </button>
        ) : null}
      </div>
      {offerDisconnectAll(connected, held) && (still.length > 0 || held.leaving.length > 0) ? (
        <span className="setup-row-actions full">
          {still.length > 0 ? (
            <>
              <span className="setup-detail" role="status">
                Still connected: {still.map((f) => `${f.code} (${f.reason})`).join(", ")}
              </span>
              <button className="pill-btn" type="button" disabled={discord.busy} onClick={() => void discord.disconnectAll(still.map((f) => f.code))} data-tauri-drag-region="false">
                Try again
              </button>
            </>
          ) : null}
          {held.leaving.length > 0 ? (
            <span className="setup-detail" role="status">Not all left Discord: see "Discord is still in room" under Permission.</span>
          ) : null}
        </span>
      ) : null}
      <div className="setup-account-list">
        {open.map((entry) => (
          <SyncRoomRow key={entry.room} entry={entry} discord={discord} discordReady={discordReady} onCloseRoom={onCloseRoom} />
        ))}
      </div>
    </>
  );
};

/** "40s", "12 min", "1h 5m" — how long a run has held the slot or waited for it. */
const heavyElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};


/** The session's own name: the bridge labels a run "Provider / Name", and the card has room for the name only. */
const sessionName = (label: string | null | undefined, as: string): string => {
  const text = label ?? as;
  const slash = text.indexOf(" / ");
  return slash === -1 ? text : text.slice(slash + 3);
};

/**
 * The machine's one heavy-run slot (#223), folded into the Heavy commands card (#376): the run
 * holding it, the runs outside the helper, and who is waiting. When nothing runs, the card says
 * nothing about the slot. The app may free a stuck slot and take a waiting run out of the line
 * (#376), and nothing more — no reordering, no jumping the line.
 */
const HeavyRunLines = ({ heavy }: { heavy: ReturnType<typeof useHeavyRuns> }) => {
  // Asked here, in the row: the macOS webview implements no window.confirm (#243 audit). The
  // confirmation is keyed by the run it was asked about, so a run that took the slot since is
  // never the one killed.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const holder = heavy.status?.holder ?? null;
  // A run recorded before #243 was never verified as the helper's, so the app cannot stop it.
  const stoppable = holder !== null && holder.verified !== false;
  const confirming = holder !== null && stoppable && confirmingId === holder.id;
  const queue = heavy.status?.queue ?? [];
  const observed = heavy.status?.observed ?? [];
  if (!holder && observed.length === 0 && queue.length === 0) return null;
  return (
    <div className="setup-runs" data-heavy-holder={holder?.as ?? ""} title={heavy.status?.limit}>
      {holder ? (
        <div className="setup-run" data-heavy-run="holder">
          <span className="setup-run-copy">
            <span className="setup-detail setup-run-what">{holder.what}</span>
            <span className="setup-detail">
              {`${sessionName(holder.label, holder.as)} · ${heavyElapsed(holder.elapsedMs)}${holder.state === "reserved" ? " · starting" : ""}${holder.loadSkipped ? " · started under load" : ""}`}
            </span>
            {holder.helperGone ? <span className="setup-detail">Helper gone, command still running</span> : null}
            {!stoppable ? <span className="setup-detail">Started before this version — stop it from its terminal.</span> : null}
          </span>
          {confirming ? (
            <span className="setup-row-actions">
              <button className="pill-btn" type="button" onClick={() => setConfirmingId(null)} data-tauri-drag-region="false">Cancel</button>
              <button className="pill-btn danger" type="button" disabled={heavy.releasing} onClick={() => { setConfirmingId(null); void heavy.stop(holder.id); }} data-tauri-drag-region="false" aria-label={`Kill ${holder.what} now`}>
                {heavy.releasing ? <RefreshCw className="setup-spin" size={12} strokeWidth={2.3} /> : null}
                Kill
              </button>
            </span>
          ) : stoppable ? (
            <button className="pill-btn danger" type="button" disabled={heavy.releasing} onClick={() => setConfirmingId(holder.id)} data-tauri-drag-region="false" aria-label={`Kill ${holder.what}`}>
              {heavy.releasing ? <RefreshCw className="setup-spin" size={12} strokeWidth={2.3} /> : null}
              Kill
            </button>
          ) : null}
        </div>
      ) : null}
      {/* No Kill here: an observed run is never the app's to end (#245, Q18). */}
      {observed.map((run) => (
        <div className="setup-run" key={`observed-${run.pid}`} data-heavy-observed={run.pid} title={run.cwd ?? undefined}>
          <span className="setup-run-copy">
            <span className="setup-detail setup-run-what">{run.pattern}</span>
            <span className="setup-detail">{`${run.label} · ${heavyElapsed(run.elapsedMs)} · outside the queue`}</span>
          </span>
        </div>
      ))}
      {queue.map((entry) => (
        <div className="setup-run" key={entry.id ?? `${entry.position}-${entry.as}`} data-heavy-queued={entry.position}>
          <span className="setup-detail">{`${entry.position} · ${entry.what} · ${sessionName(entry.label, entry.as)}`}</span>
          {/* An entry from a bridge older than #245 carries no id, so it cannot be named. */}
          {entry.id ? (
            <button className="pill-btn danger" type="button" disabled={heavy.removing !== null} onClick={() => { if (entry.id) void heavy.remove(entry.id); }} data-tauri-drag-region="false" aria-label={`Remove ${entry.what} from the queue`}>
              {heavy.removing === entry.id ? <RefreshCw className="setup-spin" size={12} strokeWidth={2.3} /> : null}
              Remove
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
};

const HeavyRuns = ({ canUseNativeControls }: { canUseNativeControls: boolean }) => {
  const heavy = useHeavyRuns(canUseNativeControls);
  if (!canUseNativeControls) return null;
  return (
    <>
      <div className="setup-subheading">Heavy runs</div>
      <HeavyPatternsRow canUseNativeControls={canUseNativeControls}>
        {heavy.error ? <span className="setup-detail" role="alert">{heavy.error}</span> : null}
        <HeavyRunLines heavy={heavy} />
      </HeavyPatternsRow>
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

/** What macOS currently allows, said plainly enough to act on. */
const notificationPermissionDetail = (
  permission: NotificationPermission,
  canUseNativeControls: boolean,
): string => {
  if (!canUseNativeControls) return "Desktop runtime required";
  switch (permission) {
    case "authorized":
    case "provisional":
    case "ephemeral":
      return "Allowed · banners will appear while the window is closed";
    // Not a state this can change: macOS only asks once, and after a refusal the answer
    // lives in System Settings. Saying so beats a button that silently does nothing.
    case "denied":
      return "Refused · turn Gyredeck back on in System Settings › Notifications";
    case "unsupported":
      return "Unavailable · notifications need the installed app, not a dev build";
    default:
      return "Not asked yet";
  }
};

export const SetupPanel = ({ capabilities, canUseNativeControls, connectionTitle, guidance, isConnected, launchAtLogin, keepAwakeWhy, keepAwakeEnabled, keepAwakeError, hookStatus, mailRooms, notifications, onCloseRoom, syncRepliesAllowed, syncRepliesBusy, onSyncRepliesChange, agyStatus, codexStatus, nativeAction, onCheckBridge, onInstallHook, onInstallAgy, onInstallCodex, onRecheckCodexTrust, codexNotifyStatus, onInstallCodexNotify, onKeepAwakeChange, bridgePort, onApplyBridgePort, gitAccounts, onRemoveGitAccount, onSetActiveGitAccount, syncGitIdentity, onSyncGitIdentityChange, terminal, onTerminalChange, updater }: ISetupPanelProps) => {
  const [activeCategory, setActiveCategory] = useState<SetupCategory>("connection");
  // Provisional and ephemeral deliver too; only these three mean a banner can appear.
  const notificationsAllowed =
    notifications.permission === "authorized" ||
    notifications.permission === "provisional" ||
    notifications.permission === "ephemeral";
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia("(max-width: 380px)").matches);
  const credentialHelper = useGitCredentialHelper(canUseNativeControls);
  const discord = useDiscord(canUseNativeControls);
  const [portField, setPortField] = useState(String(bridgePort));
  const [portBusy, setPortBusy] = useState(false);
  const [portStatus, setPortStatus] = useState<string | null>(null);
  const [editingPort, setEditingPort] = useState(false);
  // Which async Settings action is in flight, so its own control can show progress.
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const pluginsNeedAttention = [hookStatus, agyStatus, codexStatus, codexNotifyStatus].some(hookNeedsAttention);

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
    const currentIndex = SETUP_CATEGORIES.findIndex((category) => category.id === current);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? SETUP_CATEGORIES.length - 1 : (currentIndex + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + SETUP_CATEGORIES.length) % SETUP_CATEGORIES.length;
    const next = SETUP_CATEGORIES[nextIndex]?.id ?? "connection";
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
          {SETUP_CATEGORIES.map(({ id, label, icon: Icon }) => (
            <button key={id} className="setup-side-tab" data-flag={id === "plugins" ? pluginsNeedAttention : undefined} id={`setup-tab-${id}`} type="button" role="tab" aria-selected={activeCategory === id} aria-controls={`setup-panel-${id}`} tabIndex={activeCategory === id ? 0 : -1} data-active={activeCategory === id} onClick={() => selectCategory(id)} onKeyDown={(event) => handleCategoryKeyDown(event, id)}><Icon size={12} strokeWidth={2.2} /><span>{label}</span></button>
          ))}
        </div>

        <div className="setup-category-panel" id={`setup-panel-${activeCategory}`} role="tabpanel" aria-labelledby={`setup-tab-${activeCategory}`}>
          {activeCategory === "connection" ? (
            <>
              <div className="setup-section-heading"><span>Connection</span><small>Bridge and agent integration</small></div>
              <div className="setup-row"><span className="bridge-dot" data-connected={isConnected} title={connectionTitle} /><span className="setup-copy"><span className="setup-title">Bridge</span><span className="setup-detail">{connectionTitle}</span></span>{!isConnected ? <button className="pill-btn" type="button" disabled={pendingAction === "bridge"} onClick={() => void runAction("bridge", onCheckBridge)} data-tauri-drag-region="false" aria-label="Reconnect bridge">{pendingAction === "bridge" ? <RefreshCw className="setup-spin" size={12} strokeWidth={2.3} /> : <PlugZap size={12} strokeWidth={2.3} />}{pendingAction === "bridge" ? "Reconnecting…" : "Reconnect"}</button> : null}</div>
              <div className="setup-row setup-row-stack"><div className="setup-row-main"><span className="status-slot"><PlugZap className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Bridge port</span><span className="setup-detail">{!canUseNativeControls ? "Desktop runtime required" : portStatus ?? `Local bridge port · ${bridgePort}`}</span></span>{canUseNativeControls ? <button className="pill-btn" type="button" onClick={toggleEditPort} data-tauri-drag-region="false" aria-expanded={editingPort} aria-label="Edit bridge port"><Pencil size={12} strokeWidth={2.3} />Edit</button> : null}</div>{editingPort ? <span className="setup-row-actions full"><input className="setup-input" type="number" min={MIN_BRIDGE_PORT} max={MAX_BRIDGE_PORT} value={portField} onChange={(event) => setPortField(event.target.value)} disabled={portBusy} data-tauri-drag-region="false" aria-label="Bridge port" autoFocus /><button className="pill-btn accent" type="button" onClick={() => void applyPort()} disabled={!canApplyPort} data-tauri-drag-region="false"><Check size={12} strokeWidth={2.3} />Apply</button></span> : null}</div>
              <div className="setup-row passive"><span className="status-slot"><ArrowRight className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">{guidance.title}</span><span className="setup-detail">{guidance.detail}</span></span></div>
              {nativeAction.message ? <div className="notice-row" data-online={nativeAction.bridgeOnline === true} role="status" aria-live="polite">{nativeAction.message}</div> : null}
              <div className="setup-subheading">Security</div>
              <MfaRow canUseNativeControls={canUseNativeControls} />
            </>
          ) : null}

          {activeCategory === "sync" ? (
            <>
              <div className="setup-section-heading"><span>Sync</span><small>Rooms and heavy runs</small></div>
              <SyncRoomList rooms={mailRooms} canUseNativeControls={canUseNativeControls} onCloseRoom={onCloseRoom} discord={discord} />
              <HeavyRuns canUseNativeControls={canUseNativeControls} />
            </>
          ) : null}

          {activeCategory === "notification" ? (
            <>
              <div className="setup-section-heading"><span>Notification</span><small>What is worth interrupting you for</small></div>
              {/* One or the other, never both. Until macOS has granted permission there is
                  exactly one thing to do and nothing to choose — switches sitting there in
                  the on position would be claiming something the app cannot do, and after a
                  refusal may never be able to do. Once granted, the permission row has
                  nothing left to say, so it gets out of the way of the choices. */}
              {notificationsAllowed ? (
                <>
                  <div className="setup-subheading">Git</div>
                  <div className="setup-row"><span className="status-slot"><KeyRound className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">When a watched repo moves</span><span className="setup-detail">CI finishing, a pull request opening, a commit landing</span></span><button className="switch-toggle" type="button" role="switch" aria-checked={notifications.git} data-on={notifications.git} onClick={() => notifications.setGit(!notifications.git)} data-tauri-drag-region="false" aria-label="Notify when a watched repo moves"><span className="switch-thumb" /></button></div>
                  <div className="setup-subheading">Sessions</div>
                  <div className="setup-row"><span className="status-slot"><MessageSquareDashed className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">When an agent needs an answer</span><span className="setup-detail">A question or an approval it cannot carry on without</span></span><button className="switch-toggle" type="button" role="switch" aria-checked={notifications.attention} data-on={notifications.attention} onClick={() => notifications.setAttention(!notifications.attention)} data-tauri-drag-region="false" aria-label="Notify when an agent needs an answer"><span className="switch-thumb" /></button></div>
                  <div className="setup-row"><span className="status-slot"><MessageSquareDashed className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">When a sync room reply arrives</span><span className="setup-detail">Only what was addressed to one of your sessions</span></span><button className="switch-toggle" type="button" role="switch" aria-checked={notifications.roomMessage} data-on={notifications.roomMessage} onClick={() => notifications.setRoomMessage(!notifications.roomMessage)} data-tauri-drag-region="false" aria-label="Notify when a sync room reply arrives"><span className="switch-thumb" /></button></div>
                  <div className="setup-subheading">Usage</div>
                  <div className="setup-row"><span className="status-slot"><Gauge className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">When a quota runs low</span><span className="setup-detail">At 20% left, at 10%, and when it runs out — once each, not while it stays there</span></span><button className="switch-toggle" type="button" role="switch" aria-checked={notifications.quota} data-on={notifications.quota} onClick={() => notifications.setQuota(!notifications.quota)} data-tauri-drag-region="false" aria-label="Notify when a provider quota runs low"><span className="switch-thumb" /></button></div>
                  <div className="setup-row"><span className="status-slot"><Gauge className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Heavy runs</span><span className="setup-detail">When one starts, when someone has to wait, and when one ends</span></span><button className="switch-toggle" type="button" role="switch" aria-checked={notifications.heavy} data-on={notifications.heavy} onClick={() => notifications.setHeavy(!notifications.heavy)} data-tauri-drag-region="false" aria-label="Notify about heavy runs"><span className="switch-thumb" /></button></div>
                  <div className="setup-row passive"><span className="status-slot"><ArrowRight className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Only while the window is closed</span><span className="setup-detail">A banner for something already on screen is how notifications get switched off</span></span></div>
                </>
              ) : (
                <div className="setup-row passive"><span className="status-slot"><Bell className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">macOS permission</span><span className="setup-detail">{notificationPermissionDetail(notifications.permission, canUseNativeControls)}</span></span>{canUseNativeControls && notifications.permission === "notDetermined" ? <button className="pill-btn" type="button" onClick={() => void notifications.requestPermission()} data-tauri-drag-region="false">Allow</button> : null}{canUseNativeControls && notifications.permission === "denied" ? <button className="pill-btn" type="button" onClick={() => void notifications.openSettings()} data-tauri-drag-region="false">Settings</button> : null}</div>
              )}
              {notifications.error ? <div className="notice-row" role="status" aria-live="polite">{notifications.error}</div> : null}
            </>
          ) : null}

          {activeCategory === "permission" ? (
            <>
              <div className="setup-section-heading"><span>Permission</span><small>What an agent may do unprompted</small></div>
              {/* One row per agent, from one markup (#261): each switch governs only its own agent. */}
              {([["claude", "Claude Code", hookStatus], ["agy", "Antigravity", agyStatus]] as const).map(([agent, name, status]) => {
                const allowed = syncRepliesAllowed[agent];
                return <div className="setup-row" key={agent} data-sync-agent={agent}><span className="status-slot"><MessageSquareDashed className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">{name}: answer rooms without asking</span><span className="setup-detail">{!canUseNativeControls ? "Desktop runtime required" : !status.installed ? `Needs the ${name} hook — install it under Plugins` : allowed == null ? "Checking…" : typeof allowed == "string" ? `Can't check ${name}'s settings: ${allowed}` : allowed ? `On: ${name} replies and listens in its room with no prompt each time.` : "Off: Gyredeck's rules are removed; rules you added yourself still apply."}</span></span>{!status.installed ? (
                  // Shown but locked rather than hidden: the setting exists and its state
                  // is worth seeing. A padlock says why it cannot be moved, where a greyed
                  // switch would only say that it cannot.
                  <span className="setup-locked" title={`Install the ${name} hook first`}><Lock size={12} strokeWidth={2.4} /></span>
                ) : (
                  <button className="switch-toggle" type="button" role="switch" aria-checked={allowed === true} data-on={allowed === true} disabled={!canUseNativeControls || syncRepliesBusy || typeof allowed != "boolean"} onClick={() => void onSyncRepliesChange(agent, !allowed)} data-tauri-drag-region="false" aria-label={`${allowed === true ? "Stop letting" : "Let"} ${name} answer rooms without asking`}><span className="switch-thumb" /></button>
                )}</div>;
              })}
              <DiscordRows discord={discord} canUseNativeControls={canUseNativeControls} syncRooms={openRooms(mailRooms).map((entry) => entry.room)} />
            </>
          ) : null}

          {activeCategory === "plugins" ? (
            <>
              <div className="setup-section-heading"><span>Plugins</span><small>Agent integrations</small></div>
              <PluginRow title="Antigravity hooks" status={agyStatus} canUseNativeControls={canUseNativeControls} busy={pendingAction === "agy"} onInstall={() => void runAction("agy", onInstallAgy)} />
              <PluginRow title="Codex hooks" status={codexStatus} canUseNativeControls={canUseNativeControls} busy={pendingAction === "codex"} onInstall={() => void runAction("codex", onInstallCodex)} onRecheck={() => void runAction("codexTrust", onRecheckCodexTrust)} rechecking={pendingAction === "codexTrust"} />
              <PluginRow title="Codex notify" status={codexNotifyStatus} canUseNativeControls={canUseNativeControls} busy={pendingAction === "codexNotify"} onInstall={() => void runAction("codexNotify", onInstallCodexNotify)} />
              <PluginRow title="Claude Code hooks" status={hookStatus} canUseNativeControls={canUseNativeControls} busy={pendingAction === "hook"} onInstall={() => void runAction("hook", onInstallHook)} />
            </>
          ) : null}

          {activeCategory === "display" ? (
            <>
              <div className="setup-section-heading"><span>Display</span><small>Screen and focus behavior</small></div>
              <div className="setup-row"><span className="status-slot"><Coffee className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Keep awake while working</span><span className="setup-detail">{!keepAwakeEnabled && !keepAwakeError ? "Off · display follows macOS idle settings" : !canUseNativeControls ? "Desktop runtime required" : keepAwakeError ? `Unavailable · ${keepAwakeError}` : keepAwakeWhy ? `Active · ${keepAwakeWhy}` : "On · stays awake for agents, Discord rooms and heavy runs"}</span></span><button className="switch-toggle" type="button" role="switch" aria-checked={keepAwakeEnabled} data-on={keepAwakeEnabled} disabled={!canUseNativeControls} data-dimmed={keepAwakeEnabled && keepAwakeError ? "" : undefined} onClick={() => onKeepAwakeChange(!keepAwakeEnabled)} data-tauri-drag-region="false" aria-label={`${keepAwakeEnabled ? "Disable" : "Enable"} keep display awake`}><span className="switch-thumb" /></button></div>
              <div className="setup-row"><span className="status-slot"><Focus className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Terminal</span><span className="setup-detail">Focus jumps to this terminal at the session cwd</span></span><select className="setup-select" value={terminal} onChange={(event) => onTerminalChange(event.target.value as TerminalChoice)} data-tauri-drag-region="false" aria-label="Focus terminal">{TERMINAL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
              <div className="setup-row"><span className="status-slot"><Power className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">Start when you log in</span><span className="setup-detail">{launchAtLogin.error ?? (canUseNativeControls ? "Opens hidden in the menu bar, not on screen" : "Needs the desktop runtime")}</span></span><button className="switch-toggle" type="button" role="switch" aria-checked={launchAtLogin.enabled} data-on={launchAtLogin.enabled} disabled={!canUseNativeControls || launchAtLogin.busy} onClick={() => void launchAtLogin.set(!launchAtLogin.enabled)} data-tauri-drag-region="false" aria-label="Start Gyredeck when you log in"><span className="switch-thumb" /></button></div>
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
              <div className="setup-row"><span className="status-slot"><Download className="setup-icon" size={14} strokeWidth={2.3} /></span><span className="setup-copy"><span className="setup-title">App updates</span><span className="setup-detail" data-tone={canUseNativeControls && updater.status === "error" ? "warn" : undefined}>{!canUseNativeControls ? "Desktop runtime required" : updater.status === "error" ? (updater.message ?? UPDATER_DETAIL.error) : updater.status === "available" ? `${UPDATER_DETAIL.available}${updater.version ? ` · v${updater.version}` : ""}` : updater.status === "downloading" ? UPDATER_DETAIL.downloading : UPDATER_DETAIL[updater.status]}</span></span>{updater.status === "available" || updater.status === "downloading" ? (<button className="pill-btn accent" type="button" disabled={!canUseNativeControls || updater.status === "downloading"} onClick={() => void updater.installAndRelaunch()} data-tauri-drag-region="false">{updater.status === "downloading" ? <RefreshCw className="setup-spin" size={12} strokeWidth={2.3} /> : <Download size={12} strokeWidth={2.3} />}{updater.status === "downloading" ? "Downloading…" : "Update"}</button>) : (<button className="pill-btn" type="button" disabled={!canUseNativeControls || updater.status === "checking"} onClick={() => void updater.check()} data-tauri-drag-region="false"><RefreshCw className={updater.status === "checking" ? "setup-spin" : undefined} size={12} strokeWidth={2.3} />{updater.status === "checking" ? "Checking…" : "Check"}</button>)}</div>
              {updater.status === "available" ? (
                <div className="update-notes">
                  <div className="update-notes-head"><span>Release notes{updater.version ? ` · v${updater.version}` : ""}</span>{updater.date ? <span className="update-notes-date">{updater.date.slice(0, 10)}</span> : null}</div>
                  <div className="update-notes-body">{updater.notes?.trim() ? <ReleaseNotes text={updater.notes.trim()} /> : "No release notes provided."}</div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};
