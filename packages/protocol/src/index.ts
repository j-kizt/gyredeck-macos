export const GYREDECK_PROTOCOL_VERSION = 2 as const;


export interface IGyredeckBridgeCapabilities {
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
    mail: boolean;
  };
  sessionActions: {
    focusTerminal: boolean;
    endSession: boolean;
    dismissEnded: boolean;
  };
}

export const createDefaultBridgeCapabilities = (): IGyredeckBridgeCapabilities => ({
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
    mail: false,
  },
  sessionActions: {
    focusTerminal: false,
    endSession: false,
    dismissEnded: true,
  },
});

export type GyredeckEventType =
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

export interface IGyredeckEventRuntime {
  sourcePid: number;
  sourcePpid: number | null;
  sourceStartedAtMs: number;
  sourceKind: "agyHost" | "claudeCodeHook" | "hookRelay" | "unknown" | string;
}

export interface IGyredeckBaseEvent {
  version: typeof GYREDECK_PROTOCOL_VERSION;
  id: string;
  type: GyredeckEventType;
  timestamp: string;
  agentId: string | null;
  agentName?: string | null;
  conversationId: string | null;
  cwd?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  runtime?: IGyredeckEventRuntime | null;
}

export interface IGyredeckBridgeReadyEvent extends IGyredeckBaseEvent {
  type: "bridge_ready";
  data: {
    port: number;
    logFile: string;
    ssePath: "/events";
    healthPath: "/health";
  };
}

export interface IGyredeckConversationOpenEvent extends IGyredeckBaseEvent {
  type: "conversation_open";
  data: {
    reason: "startup" | "new" | "resume" | "fork" | string;
    previousConversationId?: string | null;
  };
}

export interface IGyredeckConversationCloseEvent extends IGyredeckBaseEvent {
  type: "conversation_close";
  data: {
    durationMs: number | null;
    messageCount: number | null;
    reason: "quit" | "new" | "resume" | "fork" | string;
    toolCallCount: number | null;
  };
}

export interface IGyredeckTurnStartEvent extends IGyredeckBaseEvent {
  type: "turn_start";
  data: {
    inputCount: number;
    userTextPreview?: string | null;
  };
}

export interface IGyredeckTurnStopEvent extends IGyredeckBaseEvent {
  type: "turn_stop";
  data: {
    hookEventName: "Stop" | string;
    source: "hook" | string;
    message?: string | null;
  };
}

export interface IGyredeckTurnUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

export interface IGyredeckTurnCompleteEvent extends IGyredeckBaseEvent {
  type: "turn_complete";
  data: {
    hookEventName: "Stop" | string;
    source: "hook" | string;
    message?: string | null;
    usage?: IGyredeckTurnUsage | null;
  };
}

export interface IGyredeckAttentionRequestedEvent extends IGyredeckBaseEvent {
  type: "attention_requested";
  data: {
    hookEventName: "PermissionRequest" | "AskUserQuestion" | string;
    source: "hook" | "tool" | string;
    kind: "approval" | "question" | string;
    toolName?: string | null;
    message?: string | null;
  };
}

export interface IGyredeckToolStartEvent extends IGyredeckBaseEvent {
  type: "tool_start";
  data: {
    toolCallId: string | null;
    toolName: string;
    argKeys: string[];
  };
}

export interface IGyredeckToolEndEvent extends IGyredeckBaseEvent {
  type: "tool_end";
  data: {
    toolCallId: string | null;
    toolName: string;
    status: "success" | "error" | string;
    outputLength: number | null;
  };
}

export interface IGyredeckCompactStartEvent extends IGyredeckBaseEvent {
  type: "compact_start";
  data: {
    trigger: "manual" | "context_window_overflow" | "context_window_limit" | string;
  };
}

export interface IGyredeckCompactEndEvent extends IGyredeckBaseEvent {
  type: "compact_end";
  data: {
    trigger: "manual" | "context_window_overflow" | "context_window_limit" | string;
    messagesBefore: number | null;
    messagesAfter: number | null;
    contextTokensBefore: number | null;
    contextTokensAfter: number | null;
  };
}

export interface IGyredeckLlmStartEvent extends IGyredeckBaseEvent {
  type: "llm_start";
  data: {
    model: string;
    messageCount: number | null;
    contextWindow: number | null;
  };
}

export interface IGyredeckLlmEndError {
  message: string;
  errorType: "llm_error" | "local_backend_error" | string;
  retryable: boolean | null;
}

export interface IGyredeckLlmEndEvent extends IGyredeckBaseEvent {
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
    error?: IGyredeckLlmEndError;
  };
}

export interface IGyredeckBridgeErrorEvent extends IGyredeckBaseEvent {
  type: "bridge_error";
  data: {
    message: string;
    code?: string;
  };
}

export type GyredeckEvent =
  | IGyredeckBridgeReadyEvent
  | IGyredeckConversationOpenEvent
  | IGyredeckConversationCloseEvent
  | IGyredeckTurnStartEvent
  | IGyredeckTurnStopEvent
  | IGyredeckTurnCompleteEvent
  | IGyredeckAttentionRequestedEvent
  | IGyredeckToolStartEvent
  | IGyredeckToolEndEvent
  | IGyredeckCompactStartEvent
  | IGyredeckCompactEndEvent
  | IGyredeckLlmStartEvent
  | IGyredeckLlmEndEvent
  | IGyredeckBridgeErrorEvent;

export type {
  GyredeckPresenceStatus,
  IGyredeckPresence,
  IGyredeckPresenceView,
} from "./presence.js";
export { createInitialPresence, getPresenceView, reducePresence } from "./presence.js";
