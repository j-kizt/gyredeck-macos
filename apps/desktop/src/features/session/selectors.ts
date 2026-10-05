import { sessionGroupKey } from "./grouping";
import { shouldRetireFromList } from "./retirement";
import type { GyredeckEvent, IGyredeckPresence } from "@gyredeck/protocol";
import {
  getEventActivity,
  getEventSessionStatus,
  projectName,
  providerLabel,
  shortenPath,
} from "./activity";
import type {
  ISessionDetail,
  ISessionSummary,
  IWorkspaceSessionGroup,
  SessionEventRegistry,
} from "./types";

const SESSION_STATUS_PRIORITY: Record<ISessionSummary["status"], number> = {
  attention: 6,
  error: 5,
  working: 4,
  done: 3,
  idle: 2,
  inactive: 1,
};

const compareActivity = (a: ISessionSummary, b: ISessionSummary) =>
  Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);

export const shouldKeepDisplayAwakeForActivity = (
  sessions: Pick<ISessionSummary, "status">[],
  fallbackStatus: ISessionSummary["status"],
) =>
  fallbackStatus === "working" ||
  sessions.some((session) => session.status === "working");

const isInternalWorkspacePath = (path: string | null | undefined) =>
  Boolean(
    path &&
      (path.includes("/.letta/lc-local-backend/memfs/") ||
        path.includes("/.letta/mod-cache/") ||
        path.endsWith("/.letta/mods") ||
        path.endsWith("/memory")),
  );

const getSessionWorkspacePath = (
  events: GyredeckEvent[],
  fallback?: string | null,
): string | null =>
  events.find((event) => event.cwd && !isInternalWorkspacePath(event.cwd))?.cwd ??
  (fallback && !isInternalWorkspacePath(fallback) ? fallback : null);

const isInternalOnlySession = (events: GyredeckEvent[]) =>
  events.length > 0 &&
  events.every((event) => !event.cwd || isInternalWorkspacePath(event.cwd));

export const buildWorkspaceSessionGroups = (
  sessions: ISessionSummary[],
): IWorkspaceSessionGroup[] => {
  const grouped = new Map<string, ISessionSummary[]>();
  for (const session of sessions) {
    const key = sessionGroupKey(session);
    const group = grouped.get(key);
    if (group) group.push(session);
    else grouped.set(key, [session]);
  }

  return [...grouped.entries()]
    .map(([key, groupSessions]) => {
      let primarySession = groupSessions[0];
      let latestSession = groupSessions[0];
      let activeCount = 0;
      let doneCount = 0;

      for (const session of groupSessions) {
        const sessionPriority = SESSION_STATUS_PRIORITY[session.status];
        const primaryPriority = SESSION_STATUS_PRIORITY[primarySession.status];
        if (
          sessionPriority > primaryPriority ||
          (sessionPriority === primaryPriority && compareActivity(session, primarySession) < 0)
        ) {
          primarySession = session;
        }
        if (compareActivity(session, latestSession) < 0) latestSession = session;
        if (session.status === "working" || session.status === "attention") activeCount += 1;
        if (session.status === "done") doneCount += 1;
      }

      return {
        key,
        // A named session is a group of one, and the name is the whole reason it is not
        // in the group it would otherwise be in — so it is what the row says.
        project: primarySession.displayName ?? primarySession.project,
        workspace: primarySession.workspace,
        workspacePath: primarySession.workspacePath,
        status: primarySession.status,
        activityKind: primarySession.activityKind,
        detail:
          activeCount > 0
            ? `${activeCount} active · ${groupSessions.length} sessions`
            : doneCount === groupSessions.length
              ? `${doneCount} done sessions`
              : `${groupSessions.length} sessions`,
        lastActivityAt: latestSession.lastActivityAt,
        primarySession,
        sessions: [...groupSessions].sort(compareActivity),
      };
    })
    .sort(
      (a, b) =>
        SESSION_STATUS_PRIORITY[b.status] - SESSION_STATUS_PRIORITY[a.status] ||
        Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
    );
};

export const buildSessionSummaries = (
  registry: SessionEventRegistry,
  presence: IGyredeckPresence,
  now: Date,
  /**
   * The session whose detail is open, if one is.
   *
   * A finished one-shot is kept on screen for a few seconds so that it can be seen — and
   * seen means it can be clicked. Retiring it on a timer regardless would throw the
   * person out of the very row the grace period invited them into.
   */
  selectedConversationId: string | null,
): ISessionSummary[] => {
  const sessions = new Map<string, ISessionSummary>();

  for (const [conversationId, sessionEvents] of Object.entries(registry)) {
    if (conversationId === "default" && isInternalOnlySession(sessionEvents)) continue;
    const latest = sessionEvents[0];
    if (!latest) continue;
    // A `codex exec` that has finished is not a session anybody can go back to — unless
    // they are already in it, in which case it stays until they leave.
    if (shouldRetireFromList(conversationId, sessionEvents, now, selectedConversationId)) continue;

    const activity = getEventActivity(latest);
    const workspacePath = getSessionWorkspacePath(sessionEvents, latest.cwd);
    sessions.set(conversationId, {
      conversationId,
      project: projectName(workspacePath ?? latest.cwd),
      displayName: null,
      workspace: shortenPath(workspacePath ?? latest.cwd),
      workspacePath,
      detail: activity.detail,
      activityKind: activity.kind,
      provider: providerLabel(
        latest.runtime?.sourceKind ??
          sessionEvents.find((event) => event.runtime?.sourceKind)?.runtime?.sourceKind,
      ),
      model: sessionEvents.find((event) => event.model)?.model ?? "",
      status: getEventSessionStatus(latest, now),
      lastActivityAt: latest.timestamp,
    });
  }

  if (presence.conversationId && !sessions.has(presence.conversationId)) {
    const eventsForSession = registry[presence.conversationId] ?? [];
    const current = eventsForSession[0]
      ? ({ ...eventsForSession[0], cwd: presence.cwd } as GyredeckEvent)
      : null;
    const workspacePath = getSessionWorkspacePath(
      current ? [current, ...eventsForSession] : eventsForSession,
      presence.cwd,
    );
    sessions.set(presence.conversationId, {
      conversationId: presence.conversationId,
      project: projectName(workspacePath ?? presence.cwd),
      displayName: null,
      workspace: shortenPath(workspacePath ?? presence.cwd),
      workspacePath,
      detail: "idle",
      activityKind: "session",
      provider: providerLabel(
        eventsForSession.find((event) => event.runtime?.sourceKind)?.runtime?.sourceKind,
      ),
      model: presence.model ?? "",
      status: "idle",
      lastActivityAt: presence.lastEventAt ?? new Date(0).toISOString(),
    });
  }

  return [...sessions.values()];
};

export const buildSessionDetail = (
  conversationId: string | null,
  sessions: ISessionSummary[],
  registry: SessionEventRegistry,
  presence: IGyredeckPresence,
): ISessionDetail | null => {
  if (!conversationId) return null;
  const summary = sessions.find((session) => session.conversationId === conversationId);
  if (!summary) return null;

  const sessionEvents = registry[conversationId] ?? [];
  const latest = sessionEvents[0];
  const current = presence.conversationId === conversationId;
  const workspacePath =
    summary.workspacePath ?? getSessionWorkspacePath(sessionEvents, latest?.cwd);

  return {
    ...summary,
    agentName: (current ? presence.agentName : latest?.agentName) ?? "Claude Code",
    cwd: workspacePath ?? (current ? presence.cwd : latest?.cwd) ?? "No workspace",
    model: (current ? presence.model : latest?.model) ?? "",
    permissionMode: (current ? presence.permissionMode : latest?.permissionMode) ?? "—",
    events: sessionEvents,
  };
};
