import type { AgentActivityEvent } from "@agent-activity/protocol";

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
  model: string;
  status: "idle" | "working" | "attention" | "inactive" | "done" | "error";
  lastActivityAt: string;
}

export interface ISessionDetail extends ISessionSummary {
  agentName: string;
  cwd: string;
  permissionMode: string;
  events: AgentActivityEvent[];
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

export type SessionEventRegistry = Record<string, AgentActivityEvent[]>;
export type DismissedSessionRegistry = Record<string, number>;
export type DeletedSessionRegistry = Record<string, number>;
