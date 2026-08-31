import { ChevronDown, ChevronRight, Focus, Trash2, X } from "lucide-react";
import { compactNumber, formatRelativeAge, formatTime, shortModelName } from "./activity";
import { buildContextMeter, type IContextUsageSnapshot } from "./contextWindow";
import type { ISessionDetail, ISessionSummary, IWorkspaceSessionGroup } from "./types";
import { Tooltip } from "../../Tooltip";

export const StatusGlyph = ({ status }: { status: ISessionSummary["status"] }) => {
  if (status === "working") return <span className="status-slot"><span className="glyph-pulse">✱</span></span>;
  if (status === "attention") return <span className="status-slot"><span className="glyph-attention">!</span></span>;
  if (status === "done") return <span className="status-slot"><span className="glyph-check">✓</span></span>;
  return <span className="status-slot"><span className={`status-dot status-${status}`} /></span>;
};
const statusLabel = (status: ISessionSummary["status"]) => ({ attention: "Needs input", done: "Done", error: "Error", idle: "Idle", inactive: "Inactive", working: "Working" }[status]);
const shortSessionId = (id: string) => id.replace(/^local-conv-/, "").slice(-8);

export const SessionContextSummary = ({ session }: { session: ISessionDetail }) => {
  const latest = session.events[0];
  const copy = (() => {
    switch (session.status) {
      case "working": return { eyebrow: "Current activity", title: session.activityKind === "thinking" || session.activityKind === "model" ? "Model is working" : "Working", detail: session.detail };
      case "attention": { const kind = latest?.type === "attention_requested" ? latest.data.kind : null; return { eyebrow: "Needs input", title: kind === "question" || session.activityKind === "asking" ? "Question requested" : "Approval requested", detail: session.detail }; }
      case "done": return { eyebrow: "Completed", title: "Turn completed", detail: session.detail };
      case "error": return { eyebrow: "Error", title: "Activity failed", detail: session.detail };
      case "inactive": return { eyebrow: "Inactive", title: "Activity paused", detail: "No recent terminal event" };
      case "idle": return { eyebrow: "Idle", title: "Ready", detail: session.detail };
    }
  })();
  return (
    <section className="session-context-summary" data-status={session.status} aria-labelledby="session-context-title" data-panel-focus-target tabIndex={-1}>
      <StatusGlyph status={session.status} />
      <span className="session-context-copy"><span className="session-context-eyebrow">{copy.eyebrow}</span><span className="session-context-title" id="session-context-title">{copy.title}</span><span className="session-context-detail">{copy.detail}</span></span>
      <span className="session-context-meta"><span className="session-provider">{session.provider}</span>{session.model ? <Tooltip label={session.model}><span className="session-model">{shortModelName(session.model)}</span></Tooltip> : null}<span className="session-age" title={formatTime(session.lastActivityAt)}>{formatRelativeAge(session.lastActivityAt)}</span></span>
    </section>
  );
};

/**
 * Context size as of the last completed turn. Labelled "last turn" because that is
 * literally when the number is measured — usage only reaches Gyredeck when Claude
 * Code's Stop hook fires, so this holds steady mid-turn rather than tracking live.
 * Renders nothing at all unless a turn reported usage; drops the bar (keeping the
 * count) when the model's context window is unknown.
 */
export const SessionContextMeter = ({
  session,
  usage,
}: { session: ISessionDetail; usage: IContextUsageSnapshot | null | undefined }) => {
  const meter = buildContextMeter(usage, session.model);
  if (!meter) return null;
  const percent = meter.ratio === null ? null : Math.round(meter.ratio * 100);
  const breakdown = [
    meter.cacheReadTokens > 0 ? `${compactNumber(meter.cacheReadTokens)} cached` : null,
    meter.cacheCreationTokens > 0 ? `${compactNumber(meter.cacheCreationTokens)} new` : null,
    meter.inputTokens > 0 ? `${compactNumber(meter.inputTokens)} fresh` : null,
  ].filter(Boolean).join(" · ");
  return (
    <section className="session-context-meter" aria-label="Context usage">
      <div className="context-meter-head">
        <span className="context-meter-label">Context</span>
        <span className="context-meter-value">
          {compactNumber(meter.used)}
          {meter.window ? <span className="context-meter-window"> / {compactNumber(meter.window)}</span> : null}
          {percent === null ? null : <span className="context-meter-percent" data-high={percent >= 80}>{percent}%</span>}
        </span>
      </div>
      {meter.ratio === null ? null : (
        <div
          className="context-meter-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? 0}
          aria-valuetext={`${percent}% of context used`}
        >
          <span className="context-meter-fill" data-high={(percent ?? 0) >= 80} style={{ width: `${meter.ratio * 100}%` }} />
        </div>
      )}
      <div className="context-meter-foot">
        {breakdown ? <span>{breakdown}</span> : null}
        <span className="context-meter-note">last turn</span>
      </div>
    </section>
  );
};

export interface ISessionListRowProps { child?: boolean; onClear: (id: string) => void; onFocus: (session: ISessionSummary) => void; onOpen: (id: string) => void; session: ISessionSummary; }
export const SessionListRow = ({ child = false, onClear, onFocus, onOpen, session }: ISessionListRowProps) => (
  <li className={`session-row ${child ? "session-child-row" : ""} ${session.status === "done" ? "ended" : ""}`} data-status={session.status}>
    <button className="session-row-main" type="button" onClick={() => onOpen(session.conversationId)} data-session-id={session.conversationId} data-tauri-drag-region="false" aria-label={`Open ${session.project} session details`}>
      <StatusGlyph status={session.status} />
      <span className="session-label"><span className="session-title-line"><Tooltip label={child ? shortSessionId(session.conversationId) : session.project}><span className="session-project">{child ? shortSessionId(session.conversationId) : session.project}</span></Tooltip><span className={`session-inline-status status-text-${session.status}`}>{statusLabel(session.status)}</span></span><Tooltip label={session.detail}><span className="session-activity">{session.detail}</span></Tooltip><Tooltip label={child ? session.project : session.workspace}><span className="session-folder">{child ? session.project : session.workspace}</span></Tooltip></span>
      <span className="session-row-metadata" title={formatTime(session.lastActivityAt)}><span className="session-provider">{session.provider}</span>{session.model ? <Tooltip label={session.model}><span className="session-model">{shortModelName(session.model)}</span></Tooltip> : null}<span className="session-age">{formatRelativeAge(session.lastActivityAt)}</span></span>
    </button>
    <div className="session-row-actions"><button className="row-btn row-focus" type="button" onClick={() => onFocus(session)} data-tauri-drag-region="false" aria-label={`Focus ${session.project} session in terminal`} title="Focus matching terminal (iTerm2/Ghostty)"><Focus size={11} strokeWidth={2.4} /></button>{session.status === "done" ? <button className="row-btn row-clear" type="button" onClick={() => onClear(session.conversationId)} data-tauri-drag-region="false" aria-label={`Clear completed ${session.project} session`} title="Hide this completed session until it has fresh activity"><X size={12} strokeWidth={2.5} /></button> : null}</div>
  </li>
);

export interface IWorkspaceSessionGroupItemProps { expanded: boolean; group: IWorkspaceSessionGroup; groupKey: string; removeGroupArmed: boolean; onClear: (id: string) => void; onFocus: (session: ISessionSummary) => void; onGroupAction: (groupKey: string, group: IWorkspaceSessionGroup) => void; onOpen: (id: string) => void; onToggle: (key: string) => void; }
export const WorkspaceSessionGroupItem = ({ expanded, group, groupKey, removeGroupArmed, onClear, onFocus, onGroupAction, onOpen, onToggle }: IWorkspaceSessionGroupItemProps) => {
  if (group.sessions.length === 1) return <SessionListRow session={group.sessions[0]} onClear={onClear} onFocus={onFocus} onOpen={onOpen} />;
  const canRemoveInactiveGroup = group.sessions.every((session) => session.status === "inactive");
  return (
    <li className="session-group-block" data-status={group.status}><div className="session-row session-group" data-status={group.status}>
      <button className="session-row-main session-group-main" type="button" onClick={() => onToggle(groupKey)} data-tauri-drag-region="false" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${group.project}, ${group.sessions.length} sessions`}>
        <span className="session-disclosure" aria-hidden="true">{expanded ? <ChevronDown size={12} strokeWidth={2.4} /> : <ChevronRight size={12} strokeWidth={2.4} />}</span><StatusGlyph status={group.status} />
        <span className="session-label"><span className="session-title-line"><Tooltip label={group.project}><span className="session-project">{group.project}</span></Tooltip><span className="session-group-count">×{group.sessions.length}</span><span className={`session-inline-status status-text-${group.status}`}>{statusLabel(group.status)}</span></span><Tooltip label={group.detail}><span className="session-activity">{group.detail}</span></Tooltip><Tooltip label={group.workspace}><span className="session-folder">{group.workspace}</span></Tooltip></span>
        <span className="session-row-metadata" title={formatTime(group.lastActivityAt)}><span className="session-provider">{group.primarySession.provider}</span>{group.primarySession.model ? <Tooltip label={group.primarySession.model}><span className="session-model">{shortModelName(group.primarySession.model)}</span></Tooltip> : null}<span className="session-age">{formatRelativeAge(group.lastActivityAt)}</span></span>
      </button>
      {group.sessions.every((session) => session.status === "done") ? <div className="session-row-actions"><button className="row-btn row-clear" type="button" onClick={() => onGroupAction(groupKey, group)} data-tauri-drag-region="false" aria-label={`Clear completed ${group.project} group`} title="Hide every completed session in this group until it has fresh activity"><X size={12} strokeWidth={2.5} /></button></div> : null}
      {canRemoveInactiveGroup ? <div className="session-row-actions"><button className={`row-btn danger row-remove-group ${removeGroupArmed ? "is-armed" : ""}`} type="button" onClick={() => onGroupAction(groupKey, group)} data-tauri-drag-region="false" aria-label={removeGroupArmed ? `Confirm remove ${group.sessions.length} inactive ${group.project} sessions` : `Remove ${group.sessions.length} inactive ${group.project} sessions`} title="Remove inactive group from local history"><Trash2 size={11} strokeWidth={2.3} />{removeGroupArmed ? <span>Remove {group.sessions.length}</span> : null}</button></div> : null}
    </div>{expanded ? <ul className="session-child-list" aria-label={`${group.project} sessions`}>{group.sessions.map((session) => <SessionListRow child session={session} onClear={onClear} onFocus={onFocus} onOpen={onOpen} key={session.conversationId} />)}</ul> : null}</li>
  );
};
