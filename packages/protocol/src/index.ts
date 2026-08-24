export const AGENT_ACTIVITY_PROTOCOL_VERSION = 2 as const;


export interface IAgentActivityBridgeCapabilities {
  events: {
    lifecycle: boolean;
    turns: boolean;
    tools: boolean;
    compact: boolean;
    llm: boolean;
  };
  endpoints: {
    health: boolean;
    snapshot: boolean;
    sse: boolean;
    hookStop: boolean;
    hookAttention: boolean;
    ingest: boolean;
  };
  sessionActions: {
    focusTerminal: boolean;
    endSession: boolean;
    dismissEnded: boolean;
  };
}

export const createDefaultBridgeCapabilities = (): IAgentActivityBridgeCapabilities => ({
  events: {
    lifecycle: false,
    turns: false,
    tools: false,
    compact: false,
    llm: false,
  },
  endpoints: {
    health: true,
    snapshot: true,
    sse: true,
    hookStop: true,
    hookAttention: true,
    ingest: true,
  },
  sessionActions: {
    focusTerminal: false,
    endSession: false,
    dismissEnded: true,
  },
});

export type AgentActivityEventType =
  | "bridge_ready"
  | "conversation_open"
  | "conversation_close"
  | "turn_start"
  | "turn_stop"
  | "turn_complete"
  | "attention_requested"
  | "tool_start"
  | "tool_end"
  | "compact_start"
  | "compact_end"
  | "llm_start"
  | "llm_end"
  | "bridge_error";

export interface IAgentActivityEventRuntime {
  sourcePid: number;
  sourcePpid: number | null;
  sourceStartedAtMs: number;
  sourceKind: "agyHost" | "hookRelay" | "unknown" | string;
}

export interface IAgentActivityBaseEvent {
  version: typeof AGENT_ACTIVITY_PROTOCOL_VERSION;
  id: string;
  type: AgentActivityEventType;
  timestamp: string;
  agentId: string | null;
  agentName?: string | null;
  conversationId: string | null;
  cwd?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  runtime?: IAgentActivityEventRuntime | null;
}

export interface IAgentActivityBridgeReadyEvent extends IAgentActivityBaseEvent {
  type: "bridge_ready";
  data: {
    port: number;
    logFile: string;
    ssePath: "/events";
    healthPath: "/health";
  };
}

export interface IAgentActivityConversationOpenEvent extends IAgentActivityBaseEvent {
  type: "conversation_open";
  data: {
    reason: "startup" | "new" | "resume" | "fork" | string;
    previousConversationId?: string | null;
  };
}

export interface IAgentActivityConversationCloseEvent extends IAgentActivityBaseEvent {
  type: "conversation_close";
  data: {
    durationMs: number | null;
    messageCount: number | null;
    reason: "quit" | "new" | "resume" | "fork" | string;
    toolCallCount: number | null;
  };
}

export interface IAgentActivityTurnStartEvent extends IAgentActivityBaseEvent {
  type: "turn_start";
  data: {
    inputCount: number;
    userTextPreview?: string | null;
  };
}

export interface IAgentActivityTurnStopEvent extends IAgentActivityBaseEvent {
  type: "turn_stop";
  data: {
    hookEventName: "Stop" | string;
    source: "hook" | string;
    message?: string | null;
  };
}

export interface IAgentActivityTurnCompleteEvent extends IAgentActivityBaseEvent {
  type: "turn_complete";
  data: {
    hookEventName: "Stop" | string;
    source: "hook" | string;
    message?: string | null;
  };
}

export interface IAgentActivityAttentionRequestedEvent extends IAgentActivityBaseEvent {
  type: "attention_requested";
  data: {
    hookEventName: "PermissionRequest" | "AskUserQuestion" | string;
    source: "hook" | "tool" | string;
    kind: "approval" | "question" | string;
    toolName?: string | null;
    message?: string | null;
  };
}

export interface IAgentActivityToolStartEvent extends IAgentActivityBaseEvent {
  type: "tool_start";
  data: {
    toolCallId: string | null;
    toolName: string;
    argKeys: string[];
  };
}

export interface IAgentActivityToolEndEvent extends IAgentActivityBaseEvent {
  type: "tool_end";
  data: {
    toolCallId: string | null;
    toolName: string;
    status: "success" | "error" | string;
    outputLength: number | null;
  };
}

export interface IAgentActivityCompactStartEvent extends IAgentActivityBaseEvent {
  type: "compact_start";
  data: {
    trigger: "manual" | "context_window_overflow" | "context_window_limit" | string;
  };
}

export interface IAgentActivityCompactEndEvent extends IAgentActivityBaseEvent {
  type: "compact_end";
  data: {
    trigger: "manual" | "context_window_overflow" | "context_window_limit" | string;
    messagesBefore: number | null;
    messagesAfter: number | null;
    contextTokensBefore: number | null;
    contextTokensAfter: number | null;
  };
}

export interface IAgentActivityLlmStartEvent extends IAgentActivityBaseEvent {
  type: "llm_start";
  data: {
    model: string;
    messageCount: number | null;
    contextWindow: number | null;
  };
}

export interface IAgentActivityLlmEndError {
  message: string;
  errorType: "llm_error" | "local_backend_error" | string;
  retryable: boolean | null;
}

export interface IAgentActivityLlmEndEvent extends IAgentActivityBaseEvent {
  type: "llm_end";
  data: {
    model: string;
    stopReason: string | null;
    durationMs: number | null;
    usage: {
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
    } | null;
    error?: IAgentActivityLlmEndError;
  };
}

export interface IAgentActivityBridgeErrorEvent extends IAgentActivityBaseEvent {
  type: "bridge_error";
  data: {
    message: string;
    code?: string;
  };
}

export type AgentActivityEvent =
  | IAgentActivityBridgeReadyEvent
  | IAgentActivityConversationOpenEvent
  | IAgentActivityConversationCloseEvent
  | IAgentActivityTurnStartEvent
  | IAgentActivityTurnStopEvent
  | IAgentActivityTurnCompleteEvent
  | IAgentActivityAttentionRequestedEvent
  | IAgentActivityToolStartEvent
  | IAgentActivityToolEndEvent
  | IAgentActivityCompactStartEvent
  | IAgentActivityCompactEndEvent
  | IAgentActivityLlmStartEvent
  | IAgentActivityLlmEndEvent
  | IAgentActivityBridgeErrorEvent;

export type {
  AgentActivityPresenceStatus,
  IAgentActivityPresence,
  IAgentActivityPresenceView,
} from "./presence.js";
export { createInitialPresence, getPresenceView, reducePresence } from "./presence.js";
