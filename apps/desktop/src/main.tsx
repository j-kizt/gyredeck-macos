import { invoke } from "@tauri-apps/api/core";
import { BarChart3, ChevronLeft, Focus, GitBranch, List, Server, Settings, Trash2 } from "lucide-react";
import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ErrorInfo, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { GyredeckPresenceStatus } from "@gyredeck/protocol";
import { SessionContextSummary, StatusGlyph, WorkspaceSessionGroupItem } from "./features/session/components";
import {
  formatTime,
  getEventActivity,
  getEventDetail,
  projectName,
  shortenPath,
} from "./features/session/activity";
import { DONE_SIGNAL_MS, STALE_AFTER_MS } from "./features/session/constants";
import { getUniqueSortedEvents } from "./features/session/eventRegistry";
import {
  isDeletedAfter,
  isDismissedAfter,
  readDeletedSessionIds,
  readDismissedSessionIds,
  writeDeletedSessionIds,
  writeDismissedSessionIds,
  writeSessionEventRegistry,
} from "./features/session/persistence";
import {
  buildSessionDetail,
  buildSessionSummaries,
  buildWorkspaceSessionGroups,
  shouldKeepDisplayAwakeForActivity,
} from "./features/session/selectors";
import type { DeletedSessionRegistry, DismissedSessionRegistry, ISessionDetail, ISessionSummary, IWorkspaceSessionGroup } from "./features/session/types";
import { useGyredeckPresence } from "./features/presence/useGyredeckPresence";
import { SetupPanel } from "./features/setup/SetupPanel";
import { useUpdater } from "./features/updater/useUpdater";
import { readUsageSettings, writeUsageSettings } from "./features/usage/adapters";
import { AgentUsageList } from "./features/usage/components";
import type { IUsageSettings } from "./features/usage/types";
import { useAgentUsageList } from "./features/usage/useAgentUsageList";
import { useRuntimeMonitor } from "./features/runtime/useRuntimeMonitor";
import { GithubPanel } from "./features/github/components";
import { useGithubMonitor } from "./features/github/useGithubMonitor";
import { Tooltip } from "./Tooltip";
import "./styles.css";

const KEEP_AWAKE_STORAGE_KEY = "gyredeck.keep-awake-while-working";
const SEARCH_PARAMS = new URLSearchParams(window.location.search);
const DEMO_MODE = SEARCH_PARAMS.has("demo");
const DEMO_SCENARIO = SEARCH_PARAMS.get("demoScenario");
const LocalServicesPanel = lazy(async () => {
  const module = await import("./features/runtime/components");
  return { default: module.LocalServicesPanel };
});
const KEEP_AWAKE_RETRY_DELAYS_MS = [750, 2_500] as const;
interface INativeActionState {
  bridgeOnline: boolean | null;
  message: string | null;
}

interface ISessionActionState {
  ok: boolean | null;
  message: string | null;
}

interface IHookStatus {
  path: string | null;
  installed: boolean | null;
}

type MainPanelTab = "sessions" | "usage" | "services" | "github";

interface IStatusView {
  status: GyredeckPresenceStatus | "stale";
  label: string;
  isStale: boolean;
  staleForMs: number;
}

const getGlyphStatus = (status: IStatusView["status"]): ISessionSummary["status"] => {
  if (status === "thinking" || status === "tool-running") return "working";
  if (status === "stale") return "inactive";
  if (status === "attention") return "attention";
  if (status === "closed") return "done";
  if (status === "error" || status === "offline") return "error";
  return "idle";
};

const readKeepAwakeEnabled = (): boolean => {
  try { return window.localStorage.getItem(KEEP_AWAKE_STORAGE_KEY) === "true"; } catch { return false; }
};
const writeKeepAwakeEnabled = (enabled: boolean) => {
  try { window.localStorage.setItem(KEEP_AWAKE_STORAGE_KEY, `${enabled}`); } catch { /* current runtime still owns state */ }
};

const TERMINAL_STORAGE_KEY = "gyredeck.terminal";
export type TerminalChoice = "iterm" | "ghostty" | "terminal";
const readTerminalChoice = (): TerminalChoice => {
  try { const stored = window.localStorage.getItem(TERMINAL_STORAGE_KEY); return stored === "ghostty" || stored === "terminal" ? stored : "iterm"; } catch { return "iterm"; }
};
const writeTerminalChoice = (choice: TerminalChoice) => {
  try { window.localStorage.setItem(TERMINAL_STORAGE_KEY, choice); } catch { /* current runtime still owns state */ }
};

const getGroupRemovalId = (groupKey: string, group: IWorkspaceSessionGroup) => [groupKey, ...group.sessions.map((session) => session.conversationId).sort()].join("\n");

const App = () => {
  const { capabilities, connection, lastLiveEvent, now, presence, recentEvents, refreshCapabilities, sessionEventRegistry, setSessionEventRegistry, view } = useGyredeckPresence({ demoMode: DEMO_MODE, demoScenario: DEMO_SCENARIO });
  const [usageSettings, setUsageSettings] = useState<IUsageSettings>(readUsageSettings);
  const { refresh: refreshAgentUsage, usages: agentUsages } = useAgentUsageList(usageSettings, DEMO_MODE);
  const [acknowledgedConversationId, setAcknowledgedConversationId] = useState<string | null>(null);
  const [nativeAction, setNativeAction] = useState<INativeActionState>({ bridgeOnline: null, message: null });
  const [sessionAction, setSessionAction] = useState<ISessionActionState>({ ok: null, message: null });
  const [activeMainTab, setActiveMainTab] = useState<MainPanelTab>("sessions");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [hookStatus, setHookStatus] = useState<IHookStatus>({ path: null, installed: null });
  const [agyStatus, setAgyStatus] = useState<IHookStatus>({ path: null, installed: null });
  const [dismissedSessionIds, setDismissedSessionIds] = useState<DismissedSessionRegistry>(readDismissedSessionIds);
  const [deletedSessionIds, setDeletedSessionIds] = useState<DeletedSessionRegistry>(readDeletedSessionIds);
  const [keepAwakeEnabled, setKeepAwakeEnabled] = useState(readKeepAwakeEnabled);
  const [keepAwakeActive, setKeepAwakeActive] = useState(false);
  const [keepAwakeError, setKeepAwakeError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<TerminalChoice>(readTerminalChoice);
  const [expandedSessionGroupKeys, setExpandedSessionGroupKeys] = useState<Set<string>>(() => new Set());
  const [clearCompletedArmed, setClearCompletedArmed] = useState(false);
  const [pendingRemoveHistoryId, setPendingRemoveHistoryId] = useState<string | null>(null);
  const [pendingGroupHistoryRemoval, setPendingGroupHistoryRemoval] = useState<string | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const sheetInnerRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const returnSessionIdRef = useRef<string | null>(null);
  const shouldFocusPanelRef = useRef(false);
  const keyboardNavigationRef = useRef(false);
  const keepAwakeRequestRef = useRef<Promise<unknown>>(Promise.resolve());
  const displayView =
    isDeletedAfter(deletedSessionIds, presence.conversationId, presence.lastEventAt) ||
    (view.status === "closed" && (acknowledgedConversationId === presence.conversationId || isDismissedAfter(dismissedSessionIds, presence.conversationId, presence.lastEventAt)))
      ? ({ ...view, status: "idle", label: "idle" } satisfies IStatusView)
      : view;
  const canUseNativeControls = typeof window.__TAURI_INTERNALS__ !== "undefined";
  const updater = useUpdater();
  const isConnected = connection.status === "connected";
  const connectionTitle = DEMO_MODE ? "Demo mode" : (connection.message ?? connection.status);
  const workspace = shortenPath(presence.cwd);
  const project = projectName(presence.cwd);
  const model = presence.model?.split("/").slice(-1)[0] ?? "Claude Code";
  const allSessions = useMemo(
    () =>
      buildSessionSummaries(sessionEventRegistry, presence, now).filter(
        (session) =>
          !isDeletedAfter(deletedSessionIds, session.conversationId, session.lastActivityAt),
      ),
    [deletedSessionIds, now, presence, sessionEventRegistry],
  );
  const sessions = useMemo(
    () =>
      allSessions.filter(
        (session) =>
          !isDismissedAfter(dismissedSessionIds, session.conversationId, session.lastActivityAt) ||
          (session.conversationId === presence.conversationId && !["idle", "closed"].includes(displayView.status)),
      ),
    [allSessions, dismissedSessionIds, displayView.status, presence.conversationId],
  );
  const selectedSession = useMemo(
    () => buildSessionDetail(selectedSessionId, sessions, sessionEventRegistry, presence),
    [presence, selectedSessionId, sessionEventRegistry, sessions],
  );
  const selectedSessionActivityEvents = useMemo(() => {
    if (!selectedSession) return [];
    const fallbackEvents = recentEvents.filter((event) => event.conversationId === selectedSession.conversationId);
    return getUniqueSortedEvents([...selectedSession.events, ...fallbackEvents]).slice(0, 16);
  }, [recentEvents, selectedSession]);
  const sessionGroups = useMemo(() => buildWorkspaceSessionGroups(sessions), [sessions]);
  const activeSessionGroups = useMemo(
    () => buildWorkspaceSessionGroups(sessions.filter((session) => session.status !== "done")),
    [sessions],
  );
  const completedSessions = useMemo(() => sessions.filter((session) => session.status === "done"), [sessions]);
  const completedSessionGroups = useMemo(() => buildWorkspaceSessionGroups(completedSessions), [completedSessions]);
  const runtimeMonitor = useRuntimeMonitor({
    canUseNativeControls,
    demoMode: DEMO_MODE,
    registry: sessionEventRegistry,
    servicesActive: activeMainTab === "services" && !setupOpen && !selectedSessionId,
    sessions: allSessions,
  });
  const githubMonitor = useGithubMonitor({
    active: activeMainTab === "github" && !setupOpen && !selectedSessionId,
    canUseNativeControls,
  });

  useEffect(() => {
    if (!clearCompletedArmed) return undefined;
    const timer = window.setTimeout(() => setClearCompletedArmed(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [clearCompletedArmed]);

  useEffect(() => {
    if (!pendingGroupHistoryRemoval) return undefined;
    const timer = window.setTimeout(() => setPendingGroupHistoryRemoval(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [pendingGroupHistoryRemoval]);

  useEffect(() => setPendingGroupHistoryRemoval(null), [activeMainTab]);

  useEffect(() => {
    setPendingRemoveHistoryId(null);
    setPendingGroupHistoryRemoval(null);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!presence.conversationId) return;
    if (acknowledgedConversationId !== presence.conversationId) return;
    if (view.status !== "thinking" && view.status !== "tool-running" && view.status !== "attention" && view.status !== "stale") return;
    setAcknowledgedConversationId(null);
  }, [acknowledgedConversationId, presence.conversationId, view.status]);

  useEffect(() => {
    if (!lastLiveEvent?.conversationId) return;
    if (!["turn_start", "tool_start", "tool_end", "compact_start", "compact_end", "llm_start", "llm_end", "turn_stop", "turn_complete", "attention_requested"].includes(lastLiveEvent.type)) return;

    setDismissedSessionIds((current) => {
      const conversationId = lastLiveEvent.conversationId ?? "";
      if (typeof current[conversationId] !== "number" || isDismissedAfter(current, conversationId, lastLiveEvent.timestamp)) return current;
      const { [conversationId]: _removed, ...next } = current;
      writeDismissedSessionIds(next);
      return next;
    });

    setDeletedSessionIds((current) => {
      const conversationId = lastLiveEvent.conversationId ?? "";
      if (typeof current[conversationId] !== "number" || isDeletedAfter(current, conversationId, lastLiveEvent.timestamp)) return current;
      const { [conversationId]: _removed, ...next } = current;
      writeDeletedSessionIds(next);
      return next;
    });
  }, [lastLiveEvent]);
  const headerLabel = setupOpen
    ? "Settings"
    : selectedSession
      ? selectedSession.project
      : activeMainTab === "usage"
        ? "Usage"
        : activeMainTab === "services"
          ? "Services"
        : activeMainTab === "github"
          ? "GitHub"
          : sessionGroups.length === 0
          ? "Gyredeck"
          : sessionGroups.length === 1
            ? sessionGroups[0].sessions.length === 1 ? "1 session" : `${sessionGroups[0].sessions.length} sessions`
            : `${sessionGroups.length} workspaces`;
  const activitySession =
    sessions.find((session) => session.status === "attention") ??
    sessions.find((session) => session.status === "error" && now.getTime() - Date.parse(session.lastActivityAt) <= STALE_AFTER_MS) ??
    sessions.find((session) => session.status === "working") ??
    sessions.find(
      (session) =>
        session.status === "done" &&
        session.conversationId !== acknowledgedConversationId &&
        now.getTime() - Date.parse(session.lastActivityAt) <= DONE_SIGNAL_MS,
    ) ??
    null;
  const fallbackActivityStatus = getGlyphStatus(displayView.status);
  const hasRecentUnscopedDone =
    !lastLiveEvent?.conversationId &&
    (lastLiveEvent?.type === "turn_complete" || lastLiveEvent?.type === "turn_stop") &&
    now.getTime() - Date.parse(lastLiveEvent.timestamp) <= DONE_SIGNAL_MS;
  const hasRecentFallbackError = fallbackActivityStatus === "error" && presence.lastEventAt !== null && now.getTime() - Date.parse(presence.lastEventAt) <= STALE_AFTER_MS;
  const activityStatus = activitySession?.status ?? (hasRecentUnscopedDone ? "done" : fallbackActivityStatus === "working" || fallbackActivityStatus === "attention" || hasRecentFallbackError ? fallbackActivityStatus : "idle");
  const activityViewStatus: IStatusView["status"] = (() => {
    if (activityStatus === "working") return "tool-running";
    if (activityStatus === "attention") return "attention";
    if (activityStatus === "inactive") return "stale";
    if (activityStatus === "done") return "closed";
    if (activityStatus === "error") return "error";
    return displayView.status;
  })();
  const glyphStatus = getGlyphStatus(activityViewStatus);
  const isWorkingActivity = activityStatus === "working";
  const hasWorkingActivity = shouldKeepDisplayAwakeForActivity(
    sessions,
    fallbackActivityStatus,
  );
  const hasAgentLiveActivity = isWorkingActivity || activityStatus === "attention" || activityStatus === "done" || activityStatus === "error";

  useEffect(() => {
    if (!canUseNativeControls) {
      setKeepAwakeActive(false);
      setKeepAwakeError(null);
      return undefined;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    const requestedActive = keepAwakeEnabled && hasWorkingActivity;
    const syncNativeState = (attempt: number) => {
      const request = keepAwakeRequestRef.current
        .catch(() => undefined)
        .then(() => invoke<boolean>("set_keep_awake", { active: requestedActive }))
        .then((active) => {
          if (active !== requestedActive) {
            throw new Error("Native keep-awake state did not match the requested state");
          }
          return active;
        });
      keepAwakeRequestRef.current = request;
      void request
        .then((active) => {
          if (cancelled) return;
          setKeepAwakeActive(active);
          setKeepAwakeError(null);
        })
        .catch((error) => {
          if (cancelled) return;
          const retryDelay = KEEP_AWAKE_RETRY_DELAYS_MS[attempt];
          if (retryDelay !== undefined) {
            retryTimer = window.setTimeout(() => syncNativeState(attempt + 1), retryDelay);
            return;
          }
          setKeepAwakeActive(false);
          setKeepAwakeError(error instanceof Error ? error.message : String(error || "Keep awake unavailable"));
        });
    };
    setKeepAwakeError(null);
    syncNativeState(0);

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [canUseNativeControls, hasWorkingActivity, keepAwakeEnabled]);

  const setupGuidance = (() => {
    if (!canUseNativeControls) {
      return {
        title: "Open desktop runtime",
        detail: DEMO_MODE ? "Browser demo cannot install or check hooks" : "Use pnpm desktop:dev for native setup",
      };
    }

    if (hookStatus.installed === false) {
      return {
        title: "Install Claude Code hooks",
        detail: "Writes the hook and wires ~/.claude/settings.json",
      };
    }

    if (hookStatus.installed === true && !isConnected) {
      return {
        title: "Restart Claude Code",
        detail: "Restart Claude Code after install, then Check",
      };
    }

    if (isConnected) {
      return {
        title: "Ready",
        detail: "Bridge streaming lifecycle, turn, and tool events",
      };
    }

    return {
      title: "Checking setup",
      detail: canUseNativeControls ? "Reading local hook and bridge state" : "Waiting for runtime",
    };
  })();

  useEffect(() => {
    if (!canUseNativeControls) return;
    void updater.check();
  }, [canUseNativeControls, updater.check]);

  useEffect(() => {
    const enterKeyboardMode = (event: KeyboardEvent) => {
      if (["Tab", "Enter", " ", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        keyboardNavigationRef.current = true;
      }
    };
    const leaveKeyboardMode = () => {
      keyboardNavigationRef.current = false;
    };
    window.addEventListener("keydown", enterKeyboardMode, true);
    window.addEventListener("pointerdown", leaveKeyboardMode, true);
    return () => {
      window.removeEventListener("keydown", enterKeyboardMode, true);
      window.removeEventListener("pointerdown", leaveKeyboardMode, true);
    };
  }, []);

  useEffect(() => {
    if (!shouldFocusPanelRef.current) return;
    shouldFocusPanelRef.current = false;
    window.requestAnimationFrame(() => {
      const target = sheetInnerRef.current?.querySelector<HTMLElement>("[data-panel-focus-target]");
      target?.focus({ preventScroll: true });
    });
  }, [activeMainTab, selectedSessionId, setupOpen]);

  const rememberFocusOrigin = () => {
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      returnFocusRef.current = document.activeElement;
    }
  };

  const restoreFocusOrigin = () => {
    window.requestAnimationFrame(() => {
      const target = returnFocusRef.current?.isConnected
        ? returnFocusRef.current
        : returnSessionIdRef.current
          ? surfaceRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(returnSessionIdRef.current)}"]`)
          : surfaceRef.current?.querySelector<HTMLElement>('.session-row-main, .header-tab[data-active="true"], .header-tab');
      target?.focus({ preventScroll: true });
      returnFocusRef.current = null;
      returnSessionIdRef.current = null;
    });
  };

  const openSession = (conversationId: string) => {
    rememberFocusOrigin();
    returnSessionIdRef.current = conversationId;
    shouldFocusPanelRef.current = true;
    setSetupOpen(false);
    setActiveMainTab("sessions");
    setSessionAction({ ok: null, message: null });
    setSelectedSessionId(conversationId);
  };

  const openSetup = () => {
    rememberFocusOrigin();
    returnSessionIdRef.current = null;
    shouldFocusPanelRef.current = true;
    setSelectedSessionId(null);
    setSetupOpen(true);
  };

  const activateMainTab = (tab: MainPanelTab) => {
    setSetupOpen(false);
    setSelectedSessionId(null);
    setActiveMainTab(tab);
    window.requestAnimationFrame(() => {
      const scrollOwner = document.querySelector<HTMLElement>(".sheet-body");
      if (scrollOwner) scrollOwner.scrollTop = 0;
    });
  };

  const handleMainTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, currentTab: MainPanelTab) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs: MainPanelTab[] = ["sessions", "usage", "services", "github"];
    const currentIndex = tabs.indexOf(currentTab);
    const nextTab = event.key === "Home"
      ? tabs[0]
      : event.key === "End"
        ? tabs.at(-1) ?? tabs[0]
        : tabs[(currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    activateMainTab(nextTab);
    window.requestAnimationFrame(() => document.getElementById(`main-tab-${nextTab}`)?.focus());
  };

  const handleSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    if (!selectedSessionId && !setupOpen) return;
    event.preventDefault();
    backToSessions();
  };

  const updateUsageSettings = (settings: IUsageSettings) => {
    setUsageSettings(settings);
    writeUsageSettings(settings);
  };

  const updateKeepAwakeEnabled = (enabled: boolean) => {
    setKeepAwakeEnabled(enabled);
    writeKeepAwakeEnabled(enabled);
  };

  const backToSessions = () => {
    setSelectedSessionId(null);
    setSetupOpen(false);
    setActiveMainTab("sessions");
    restoreFocusOrigin();
  };

  const dismissSession = (conversationId: string) => {
    setDismissedSessionIds((current) => {
      const next = { ...current, [conversationId]: Date.now() };
      writeDismissedSessionIds(next);
      return next;
    });
    if (conversationId === presence.conversationId) setAcknowledgedConversationId(conversationId);
    if (selectedSessionId === conversationId) setSelectedSessionId(null);
  };

  const clearCompletedSessionGroup = (group: IWorkspaceSessionGroup) => {
    const completed = group.sessions.filter((session) => session.status === "done");
    if (completed.length === 0) return;
    const clearedAt = Date.now();
    setDismissedSessionIds((current) => {
      const next = { ...current };
      for (const session of completed) next[session.conversationId] = clearedAt;
      writeDismissedSessionIds(next);
      return next;
    });
    if (selectedSessionId && completed.some((session) => session.conversationId === selectedSessionId)) setSelectedSessionId(null);
  };

  const clearCompletedSessions = () => {
    if (!clearCompletedArmed) {
      setClearCompletedArmed(true);
      return;
    }

    const clearedAt = Date.now();
    setDismissedSessionIds((current) => {
      const next = { ...current };
      for (const session of completedSessions) next[session.conversationId] = clearedAt;
      writeDismissedSessionIds(next);
      return next;
    });
    setAcknowledgedConversationId(null);
    if (selectedSessionId && completedSessions.some((session) => session.conversationId === selectedSessionId)) setSelectedSessionId(null);
    setClearCompletedArmed(false);
  };

  const toggleSessionGroup = (groupKey: string) => {
    setExpandedSessionGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const deleteSessions = (conversationIds: string[]) => {
    const removing = new Set(conversationIds);
    if (removing.size === 0) return;
    const deletedAt = Date.now();
    setSessionAction({ ok: null, message: null });
    setSessionEventRegistry((current) => {
      const next = { ...current };
      for (const conversationId of removing) delete next[conversationId];
      writeSessionEventRegistry(next);
      return next;
    });
    setDismissedSessionIds((current) => {
      const next = { ...current };
      for (const conversationId of removing) delete next[conversationId];
      writeDismissedSessionIds(next);
      return next;
    });
    setDeletedSessionIds((current) => {
      const next = { ...current };
      for (const conversationId of removing) next[conversationId] = deletedAt;
      writeDeletedSessionIds(next);
      return next;
    });
    if (acknowledgedConversationId && removing.has(acknowledgedConversationId)) setAcknowledgedConversationId(null);
    if (selectedSessionId && removing.has(selectedSessionId)) setSelectedSessionId(null);
  };

  const deleteSession = (conversationId: string) => {
    deleteSessions([conversationId]);
  };

  const requestRemoveSessionHistory = (conversationId: string) => {
    if (pendingRemoveHistoryId !== conversationId) {
      setPendingRemoveHistoryId(conversationId);
      return;
    }
    deleteSession(conversationId);
    setPendingRemoveHistoryId(null);
  };

  const requestRemoveInactiveSessionGroup = (groupKey: string, group: IWorkspaceSessionGroup) => {
    if (!group.sessions.every((session) => session.status === "inactive")) return;
    const removalId = getGroupRemovalId(groupKey, group);
    if (pendingGroupHistoryRemoval !== removalId) {
      setPendingGroupHistoryRemoval(removalId);
      return;
    }
    deleteSessions(group.sessions.map((session) => session.conversationId));
    setPendingGroupHistoryRemoval(null);
  };

  const handleSessionGroupAction = (groupKey: string, group: IWorkspaceSessionGroup) => {
    if (group.sessions.every((session) => session.status === "done")) clearCompletedSessionGroup(group);
    else requestRemoveInactiveSessionGroup(groupKey, group);
  };

  const loadHookStatus = async () => {
    if (!canUseNativeControls) {
      setHookStatus({ path: null, installed: null });
      return;
    }

    try {
      const [path, installed] = await invoke<[string, boolean]>("claude_hook_status");
      setHookStatus({ path, installed });
    } catch {
      setHookStatus({ path: null, installed: null });
    }
  };

  const loadAgyStatus = async () => {
    if (!canUseNativeControls) {
      setAgyStatus({ path: null, installed: null });
      return;
    }

    try {
      const [path, installed] = await invoke<[string, boolean]>("agy_hook_status");
      setAgyStatus({ path, installed });
    } catch {
      setAgyStatus({ path: null, installed: null });
    }
  };

  const checkBridge = async () => {
    if (!canUseNativeControls) {
      setNativeAction({ bridgeOnline: null, message: "Native controls need Tauri runtime" });
      return;
    }

    try {
      const online = await invoke<boolean>("bridge_health");
      const refreshed = online ? await refreshCapabilities() : false;
      setNativeAction({ bridgeOnline: online, message: online ? (refreshed ? "Bridge reachable · capabilities synced" : "Bridge reachable") : "Bridge offline" });
    } catch (error) {
      setNativeAction({ bridgeOnline: false, message: error instanceof Error ? error.message : "Native bridge check unavailable" });
    }
  };

  const installHook = async () => {
    if (!canUseNativeControls) {
      setNativeAction({ bridgeOnline: nativeAction.bridgeOnline, message: "Open with pnpm desktop:dev" });
      return;
    }

    try {
      const path = await invoke<string>("install_claude_hook");
      setHookStatus({ path, installed: true });
      setNativeAction({ bridgeOnline: nativeAction.bridgeOnline, message: `Installed → ${shortenPath(path)} · restart Claude Code` });
    } catch (error) {
      setNativeAction({
        bridgeOnline: nativeAction.bridgeOnline,
        message: error instanceof Error ? error.message : "Claude Code hook install failed",
      });
    }
  };

  const installAgy = async () => {
    if (!canUseNativeControls) {
      setNativeAction({ bridgeOnline: nativeAction.bridgeOnline, message: "Open with pnpm desktop:dev" });
      return;
    }

    try {
      const path = await invoke<string>("install_agy_hook");
      setAgyStatus({ path, installed: true });
      setNativeAction({ bridgeOnline: nativeAction.bridgeOnline, message: `Installed → ${shortenPath(path)} · restart Antigravity` });
    } catch (error) {
      setNativeAction({
        bridgeOnline: nativeAction.bridgeOnline,
        message: error instanceof Error ? error.message : "Antigravity hook install failed",
      });
    }
  };

  const focusSelectedSession = async (session: ISessionDetail | ISessionSummary) => {
    if (!canUseNativeControls) {
      setSessionAction({ ok: false, message: "Focus needs the desktop runtime" });
      return;
    }

    try {
      const message = await invoke<string>("focus_terminal", {
        conversationId: session.conversationId,
        cwd: "cwd" in session ? session.cwd : session.workspacePath,
        terminal,
      });
      const exactMatch = message.startsWith("Focused iTerm ·") || message.startsWith("Focused Ghostty ·") || message.startsWith("Focused Terminal ·");
      setSessionAction({ ok: exactMatch, message });
    } catch (error) {
      setSessionAction({ ok: false, message: error instanceof Error ? error.message : "Terminal focus failed" });
    }
  };

  useEffect(() => {
    if (setupOpen) {
      void loadHookStatus();
      void loadAgyStatus();
      void checkBridge();
    }
  }, [setupOpen]);

  return (
    <main className="overlay-root" data-live={hasAgentLiveActivity ? "true" : "false"} data-running={isWorkingActivity ? "true" : "false"} data-status={activityViewStatus}>
        <div
          ref={surfaceRef}
          className="halo-surface"
          data-state="open"
          onKeyDown={handleSurfaceKeyDown}
          role="region"
          aria-label="Gyredeck panel"
          data-tauri-drag-region="false"
        >
          <div className="sheet-inner" ref={sheetInnerRef}>
            {setupOpen ? (
              <div className="sheet-header detail-header" data-tauri-drag-region="false">
                <button className="gear-btn" type="button" onClick={backToSessions} data-panel-focus-target data-tauri-drag-region="false" title="Back to sessions">
                  <ChevronLeft size={14} strokeWidth={2.3} />
                </button>
                <span className="status-slot"><Settings className="setup-icon" size={14} strokeWidth={2.3} /></span>
                <span className="header-title">{headerLabel}</span>
                <span className="spacer" />
                {DEMO_MODE ? <span className="agent-badge">DEMO</span> : null}
              </div>
            ) : selectedSession ? (
              <div className="sheet-header detail-header" data-tauri-drag-region="false">
                <StatusGlyph status={selectedSession.status} />
                <span className="header-title">{headerLabel}</span>
                <span className="spacer" />
              </div>
            ) : (
              <div className="sheet-header" data-tauri-drag-region="false">
                <StatusGlyph status={glyphStatus} />
                <span className="header-title">{headerLabel}</span>
                {DEMO_MODE ? <span className="agent-badge">DEMO</span> : null}
                <span className="spacer" />
                <span className="bridge-dot" data-connected={isConnected} title={connectionTitle} />
                <div className="header-tabs">
                  <div className="header-tablist" role="tablist" aria-label="Gyredeck sections">
                    <button id="main-tab-sessions" className="header-tab" data-active={activeMainTab === "sessions"} data-panel-focus-target={activeMainTab === "sessions" ? "true" : undefined} type="button" role="tab" aria-label="Sessions" aria-selected={activeMainTab === "sessions"} aria-controls="main-panel-sessions" tabIndex={activeMainTab === "sessions" ? 0 : -1} onKeyDown={(event) => handleMainTabKeyDown(event, "sessions")} onClick={(event) => { event.stopPropagation(); activateMainTab("sessions"); }} data-tauri-drag-region="false" title="Sessions">
                      <List size={13} strokeWidth={2.3} />
                    </button>
                    <button id="main-tab-usage" className="header-tab" data-active={activeMainTab === "usage"} data-panel-focus-target={activeMainTab === "usage" ? "true" : undefined} type="button" role="tab" aria-label="Usage" aria-selected={activeMainTab === "usage"} aria-controls="main-panel-usage" tabIndex={activeMainTab === "usage" ? 0 : -1} onKeyDown={(event) => handleMainTabKeyDown(event, "usage")} onClick={(event) => { event.stopPropagation(); activateMainTab("usage"); }} data-tauri-drag-region="false" title="Usage">
                      <BarChart3 size={13} strokeWidth={2.3} />
                    </button>
                    <button id="main-tab-services" className="header-tab" data-active={activeMainTab === "services"} data-panel-focus-target={activeMainTab === "services" ? "true" : undefined} type="button" role="tab" aria-label="Services" aria-selected={activeMainTab === "services"} aria-controls="main-panel-services" tabIndex={activeMainTab === "services" ? 0 : -1} onKeyDown={(event) => handleMainTabKeyDown(event, "services")} onClick={(event) => { event.stopPropagation(); activateMainTab("services"); }} data-tauri-drag-region="false" title="Services">
                      <Server size={13} strokeWidth={2.3} />
                    </button>
                    <button id="main-tab-github" className="header-tab" data-active={activeMainTab === "github"} data-panel-focus-target={activeMainTab === "github" ? "true" : undefined} type="button" role="tab" aria-label="GitHub" aria-selected={activeMainTab === "github"} aria-controls="main-panel-github" tabIndex={activeMainTab === "github" ? 0 : -1} onKeyDown={(event) => handleMainTabKeyDown(event, "github")} onClick={(event) => { event.stopPropagation(); activateMainTab("github"); }} data-tauri-drag-region="false" title="GitHub">
                      <GitBranch size={13} strokeWidth={2.3} />
                    </button>
                  </div>
                  <button className="header-tab" type="button" aria-label="Settings" onClick={(event) => { event.stopPropagation(); openSetup(); }} data-tauri-drag-region="false" title="Settings">
                    <Settings size={13} strokeWidth={2.3} />
                  </button>
                </div>
              </div>
            )}
            <div className="sheet-divider" />

            <div
              className="sheet-body"
              data-view={activeMainTab === "usage" && !setupOpen && !selectedSession ? "usage" : "default"}
              id={!setupOpen && !selectedSession ? `main-panel-${activeMainTab}` : undefined}
              role={!setupOpen && !selectedSession ? "tabpanel" : undefined}
              aria-labelledby={!setupOpen && !selectedSession ? `main-tab-${activeMainTab}` : undefined}
            >
              {setupOpen ? (
                <SetupPanel
                  capabilities={capabilities}
                  canUseNativeControls={canUseNativeControls}
                  connectionTitle={connectionTitle}
                  guidance={setupGuidance}
                  isConnected={isConnected}
                  keepAwakeActive={keepAwakeActive}
                  keepAwakeEnabled={keepAwakeEnabled}
                  keepAwakeError={keepAwakeError}
                  hookStatus={hookStatus}
                  agyStatus={agyStatus}
                  nativeAction={nativeAction}
                  onCheckBridge={() => void checkBridge()}
                  onInstallHook={() => void installHook()}
                  onInstallAgy={() => void installAgy()}
                  onKeepAwakeChange={updateKeepAwakeEnabled}
                  terminal={terminal}
                  onTerminalChange={(choice) => { setTerminal(choice); writeTerminalChoice(choice); }}
                  updater={updater}
                />
              ) : selectedSession ? (
                <div className="detail-body session-context-view" data-status={selectedSession.status}>
                  <SessionContextSummary session={selectedSession} />
                  <div className="detail-path" title={selectedSession.cwd}>{shortenPath(selectedSession.cwd)}</div>
                  {canUseNativeControls ? (
                    <div className="capability-note">Focus matches iTerm terminal cwd/title and selects its session</div>
                  ) : (
                    <div className="capability-note">Focus needs the desktop runtime</div>
                  )}
                  {sessionAction.message ? (
                    <div className="notice-row compact" data-online={sessionAction.ok === true} role="status" aria-live="polite">{sessionAction.message}</div>
                  ) : null}
                  <div className="detail-section-label">Recent activity</div>
                  {selectedSessionActivityEvents.length === 0 ? (
                    <div className="empty-text small">No events captured yet</div>
                  ) : (
                    <div className="action-list">
                      {selectedSessionActivityEvents.map((event) => {
                        const activity = getEventActivity(event);

                        return (
                          <div className="action-row" data-kind={activity.kind} key={event.id}>
                            <span className="action-mark" aria-hidden="true" />
                            <span className="action-tool">{activity.label}</span>
                            <Tooltip label={activity.detail}><span className="action-detail">{activity.detail}</span></Tooltip>
                            <span className="session-time">{formatTime(event.timestamp)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : activeMainTab === "usage" ? (
                <AgentUsageList usages={agentUsages} onRefresh={refreshAgentUsage} settings={usageSettings} onSettingsChange={updateUsageSettings} />
              ) : activeMainTab === "services" ? (
                <Suspense fallback={<div className="empty-text small">Loading Services…</div>}>
                  <LocalServicesPanel monitor={runtimeMonitor} />
                </Suspense>
              ) : activeMainTab === "github" ? (
                <GithubPanel monitor={githubMonitor} canUseNativeControls={canUseNativeControls} />
              ) : sessions.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-glyph">◌</div>
                  <div className="empty-text">Waiting for Claude Code</div>
                  <button className="btn accent" type="button" onClick={(event) => { event.stopPropagation(); openSetup(); }} data-tauri-drag-region="false">
                    <Settings size={13} strokeWidth={2.3} />
                    Open setup
                  </button>
                </div>
              ) : (
                <>
                  {sessionAction.message ? (
                    <div className="notice-row compact session-focus-notice" data-online={sessionAction.ok === true} role="status" aria-live="polite">{sessionAction.message}</div>
                  ) : null}
                  <div className="session-sections">
                    {activeSessionGroups.length > 0 ? (
                      <section className="session-section" aria-labelledby="active-session-heading">
                        <div className="session-section-head">
                          <span id="active-session-heading">Active</span>
                          <span className="session-section-count">{activeSessionGroups.reduce((count, group) => count + group.sessions.length, 0)}</span>
                        </div>
                        <ul className="session-list">
                          {activeSessionGroups.map((group) => {
                            const groupKey = `active:${group.key}`;
                            return (
                              <WorkspaceSessionGroupItem
                                expanded={expandedSessionGroupKeys.has(groupKey)}
                                group={group}
                                groupKey={groupKey}
                                removeGroupArmed={pendingGroupHistoryRemoval === getGroupRemovalId(groupKey, group)}
                                onClear={dismissSession}
                                onFocus={(session) => void focusSelectedSession(session)}
                                onGroupAction={handleSessionGroupAction}
                                onOpen={openSession}
                                onToggle={toggleSessionGroup}
                                key={groupKey}
                              />
                            );
                          })}
                        </ul>
                      </section>
                    ) : null}
                    {completedSessionGroups.length > 0 ? (
                      <section className="session-section completed-section" aria-labelledby="completed-session-heading">
                        <div className="session-section-head">
                          <span id="completed-session-heading">Completed</span>
                          <span className="session-section-count">{completedSessions.length}</span>
                          <span className="spacer" />
                          <button
                            className="session-section-action"
                            data-armed={clearCompletedArmed}
                            type="button"
                            onClick={clearCompletedSessions}
                            data-tauri-drag-region="false"
                          >
                            {clearCompletedArmed ? `Confirm clear ${completedSessions.length}` : "Clear completed"}
                          </button>
                        </div>
                        <ul className="session-list">
                          {completedSessionGroups.map((group) => {
                            const groupKey = `completed:${group.key}`;
                            return (
                              <WorkspaceSessionGroupItem
                                expanded={expandedSessionGroupKeys.has(groupKey)}
                                group={group}
                                groupKey={groupKey}
                                removeGroupArmed={pendingGroupHistoryRemoval === getGroupRemovalId(groupKey, group)}
                                onClear={dismissSession}
                                onFocus={(session) => void focusSelectedSession(session)}
                                onGroupAction={handleSessionGroupAction}
                                onOpen={openSession}
                                onToggle={toggleSessionGroup}
                                key={groupKey}
                              />
                            );
                          })}
                        </ul>
                      </section>
                    ) : null}
                  </div>

                  <div className="sheet-divider soft" />

                  <div className="event-list" aria-label="Recent Gyredeck events">
                    {recentEvents.slice(0, 4).map((event) => (
                      <div className="event-row" key={event.id}>
                        <span className="event-time">{formatTime(event.timestamp)}</span>
                        <span className="event-type">{event.type}</span>
                        <Tooltip label={getEventDetail(event)}><span className="event-detail">{getEventDetail(event)}</span></Tooltip>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className={`sheet-footer ${selectedSession ? "session-context-footer" : "copyright-footer"}`}>
                {selectedSession ? (
                  <>
                    <button
                      className="session-context-return"
                      type="button"
                      onClick={backToSessions}
                      data-tauri-drag-region="false"
                      aria-label={`Back to all ${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`}
                    >
                      <ChevronLeft size={12} strokeWidth={2.3} />
                      <span>Back to sessions</span>
                    </button>
                    <div className="session-context-actions">
                    <button className="pill-btn accent context-icon-btn" type="button" onClick={() => void focusSelectedSession(selectedSession)} data-tauri-drag-region="false" title="Focus matching terminal" aria-label="Focus matching terminal">
                      <Focus size={13} strokeWidth={2.3} />
                    </button>
                    <button
                      className={`pill-btn danger session-history-action ${pendingRemoveHistoryId === selectedSession.conversationId ? "is-armed" : ""}`}
                      type="button"
                      onClick={() => requestRemoveSessionHistory(selectedSession.conversationId)}
                      data-tauri-drag-region="false"
                      title="Remove this session's locally stored activity"
                      aria-label={pendingRemoveHistoryId === selectedSession.conversationId ? "Confirm remove" : "Remove history"}
                    >
                      <Trash2 size={13} strokeWidth={2.3} />
                      {pendingRemoveHistoryId === selectedSession.conversationId ? "Confirm remove" : null}
                    </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="footer-copyright">© 2026 Gyredeck · J-Kitz</span>
                    <span className="footer-version">{updater.currentVersion ? `v${updater.currentVersion}` : ""}</span>
                  </>
                )}
              </div>
          </div>
        </div>
    </main>
  );
};

declare global {
  interface Window {
    __GYREDECK_HOME__?: string;
    __TAURI_INTERNALS__?: unknown;
  }
}

// Final safety net: a render error in any child must never leave the popover blank.
// Show a minimal recoverable fallback instead of an empty (black) webview.
class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Gyredeck render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="app-error">
          <p>Something went wrong rendering the panel.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
