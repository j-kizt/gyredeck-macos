import type { GyredeckEvent } from "@gyredeck/protocol";

export type ActivityKind =
  | "session" | "thinking" | "planning" | "tool" | "shell" | "editing"
  | "delegating" | "visual" | "memory" | "asking" | "skill" | "goal"
  | "compact" | "model" | "attention" | "done" | "error" | "bridge";

export interface IActivityDescriptor {
  kind: ActivityKind;
  label: string;
  detail: string;
}

export interface ISessionSummary {
  conversationId: string;
  project: string;
  workspace: string;
  workspacePath: string | null;
  detail: string;
  activityKind: ActivityKind;
  provider: string;
  /**
   * The name the person typed for this session, if they typed one.
   *
   * Beside `project` rather than instead of it: `project` is what the session *is* —
   * the checkout it belongs to — and other things read it as that, the local services
   * list among them. This is only what to draw where a person reads a name.
   */
  displayName: string | null;
  model: string;
  status: "idle" | "working" | "attention" | "inactive" | "done" | "error";
  lastActivityAt: string;
}

export interface ISessionDetail extends ISessionSummary {
  agentName: string;
  cwd: string;
  permissionMode: string;
  events: GyredeckEvent[];
}

export interface IWorkspaceSessionGroup {
  key: string;
  project: string;
  workspace: string;
  workspacePath: string | null;
  status: ISessionSummary["status"];
  activityKind: ActivityKind;
  detail: string;
  lastActivityAt: string;
  primarySession: ISessionSummary;
  sessions: ISessionSummary[];
}

export type SessionEventRegistry = Record<string, GyredeckEvent[]>;
export type DismissedSessionRegistry = Record<string, number>;
export type DeletedSessionRegistry = Record<string, number>;
