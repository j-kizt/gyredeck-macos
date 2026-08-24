# Agent Activity Event Protocol

Protocol version: `2` (`"protocol-v2"`)

Events are newline-delimited JSON in `~/.config/agent-activity/agent-activity.events.ndjson` and Server-Sent Events from `GET /events`. Every adapter emits the same envelope regardless of which agent runtime produced the event.

## Base fields

```ts
{
  version: 2,
  id: string,
  type: string,
  timestamp: string,
  agentId: string | null,
  agentName?: string | null,
  conversationId: string | null,
  cwd?: string | null,
  model?: string | null,
  permissionMode?: string | null,
  runtime?: {
    sourcePid: number,
    sourcePpid: number | null,
    sourceStartedAtMs: number,
    sourceKind: "claudeCodeHook" | "agyHost" | "codex-notify" | string,
  } | null,
  data: object
}
```

`runtime` is optional, additive metadata for local read-only observability. Each adapter stamps its own source process identity and `sourceKind`:

| Source | `sourceKind` | `model` origin |
| --- | --- | --- |
| Claude Code hook | `claudeCodeHook` | tail of the transcript JSONL (`message.model`) |
| Antigravity (AGY) hook | `agyHost` | hook payload `modelName` |
| Codex notify | `codex-notify` (via the `/hook/stop` relay `source` field) | not available |

Forwarded `runtime` identity is trusted only when the `POST /ingest` request carries the machine-local `x-agent-activity-token` (a `0600` file at `~/.config/agent-activity/agent-activity.ingest-token`). Untrusted or older senders stay event-compatible, but their `runtime` field is stripped before storage. Hook-derived signals (`/hook/stop`, `/hook/attention`) reuse a recently correlated scope only when it is unambiguous and inside the bounded active-scope window; an unscoped hook event leaves `runtime` null. Runtime metadata never grants process control and does not expose command arguments.

The bridge keeps carry-forward scope **per conversation** (falling back to cwd), so scoped fields such as `model` never bleed from one agent/source into another — an Antigravity turn cannot stamp its model onto a Claude conversation.

## Bridge endpoints

Bound to `127.0.0.1:47621`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Bridge identity + capabilities. |
| GET | `/snapshot` | `recent: AgentActivityEvent[]` + capabilities. |
| GET | `/events` | Live Server-Sent Events stream. |
| POST | `/ingest` | Multi-provider event fan-in (accepts a full envelope). |
| POST | `/hook/stop` | Turn-completion relay → `turn_complete`. |
| POST | `/hook/attention` | Attention/permission relay → `attention_requested`. |

`GET /health` and `GET /snapshot` include capability metadata so viewers know which event streams and session actions are real:

```ts
{
  ok: true,
  capabilities: {
    events: {
      lifecycle: boolean,
      turns: boolean,
      tools: boolean,
      compact: boolean,
      llm: boolean,
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
      focusTerminal: boolean,
      endSession: boolean,
      dismissEnded: boolean,
    },
  }
}
```

The standalone bridge currently reports every event capability `true`, and `sessionActions: { focusTerminal: false, endSession: false, dismissEnded: true }`. `focusTerminal`/`endSession` stay `false` because no adapter exposes a stable scoped process/session-control API; terminal Focus is a separate best-effort native window action (iTerm2 / Ghostty via AppleScript), not a bridge session action.

`POST /hook/stop` converts a `Stop` hook into `turn_complete`; the legacy `turn_stop` event remains readable. `POST /hook/attention` converts a `PermissionRequest`/`Notification` relay into `attention_requested`. A `Notification` immediately following a completion in the same cwd (within 15s) is suppressed so a "turn done" ping is not re-shown as a fresh user wait. Neither relay carries raw tool arguments or question text.

## conversationId normalization

`conversationId` is passed through from the source (Claude `session_id`, AGY `conversationId`, or `codex:<cwd>` for Codex). Distinct conversations from different agents and projects therefore stay in separate session lanes rather than collapsing into one.

## Event types

### `bridge_ready`

Emitted when the bridge starts.

```json
{
  "type": "bridge_ready",
  "data": {
    "port": 47621,
    "logFile": "~/.config/agent-activity/agent-activity.events.ndjson",
    "ssePath": "/events",
    "healthPath": "/health"
  }
}
```

### `conversation_open`

Emitted from lifecycle hooks (Claude `SessionStart`, AGY first `PreInvocation`).

```json
{
  "type": "conversation_open",
  "data": {
    "reason": "startup",
    "previousConversationId": null
  }
}
```

### `conversation_close`

```json
{
  "type": "conversation_close",
  "data": {
    "durationMs": 120000,
    "messageCount": 12,
    "reason": "quit",
    "toolCallCount": 3
  }
}
```

### `turn_start`

Records counts only. Text previews are disabled unless local config opts in.

```json
{
  "type": "turn_start",
  "data": {
    "inputCount": 1
  }
}
```

### `turn_complete`

Emitted when a `Stop` hook posts to `POST /hook/stop`. One assistant turn finished; not the same as conversation close or process kill. `turn_stop` is retained as a legacy input event.

```json
{
  "type": "turn_complete",
  "data": {
    "hookEventName": "Stop",
    "source": "hook",
    "message": null
  }
}
```

### `attention_requested`

Emitted from a `PermissionRequest`/`Notification` relay. The event carries no raw tool arguments or question text.

```json
{
  "type": "attention_requested",
  "data": {
    "hookEventName": "PermissionRequest",
    "source": "hook",
    "kind": "approval",
    "toolName": "exec_command",
    "message": null
  }
}
```

### `tool_start`

Records argument keys only, never full tool arguments.

```json
{
  "type": "tool_start",
  "data": {
    "toolCallId": "call_123",
    "toolName": "exec_command",
    "argKeys": ["cmd", "yield_time_ms"]
  }
}
```

### `tool_end`

Emitted after a tool finishes. Stores only status and output length, not raw output.

```json
{
  "type": "tool_end",
  "data": {
    "toolCallId": "call_123",
    "toolName": "exec_command",
    "status": "success",
    "outputLength": 1200
  }
}
```

### `compact_start`

Emitted before context compaction starts (Claude `PreCompact`).

```json
{
  "type": "compact_start",
  "data": {
    "trigger": "context_window_overflow"
  }
}
```

### `compact_end`

```json
{
  "type": "compact_end",
  "data": {
    "trigger": "context_window_overflow",
    "messagesBefore": 220,
    "messagesAfter": 120,
    "contextTokensBefore": 190000,
    "contextTokensAfter": 90000
  }
}
```

### `llm_start`

```json
{
  "type": "llm_start",
  "data": {
    "model": "openai/gpt-5.5",
    "messageCount": 120,
    "contextWindow": 200000
  }
}
```

### `llm_end`

Emitted when a provider request finishes. Provider failures also emit `llm_end` with `stopReason: "llm_api_error"`, `usage: null`, and an optional short `error` summary (`message`, `errorType`, `retryable`) — verbose provider details are not stored. When both prompt and completion counts are available, `totalTokens` is normalized to `promptTokens + completionTokens`.

```json
{
  "type": "llm_end",
  "data": {
    "model": "openai/gpt-5.5",
    "stopReason": "end_turn",
    "durationMs": 4200,
    "usage": {
      "promptTokens": 10000,
      "completionTokens": 1200,
      "totalTokens": 11200
    }
  }
}
```

Provider-error shape:

```json
{
  "type": "llm_end",
  "data": {
    "model": "openai/gpt-5.5",
    "stopReason": "llm_api_error",
    "durationMs": 4200,
    "usage": null,
    "error": {
      "message": "provider failed",
      "errorType": "llm_error",
      "retryable": true
    }
  }
}
```

### `bridge_error`

Reserved for bridge/runtime errors; carries a short `message` and optional `code`.

> Note: the protocol type union (`packages/protocol/src/index.ts`) enumerates all event types above. Not every source emits every type — Claude hooks emit lifecycle/turn/tool/compact events, AGY emits tool/turn/lifecycle events, and Codex emits only a coarse turn-completion signal. `compact_end`, `llm_start`, and `llm_end` are part of the protocol for richer sources but are not produced by the current hook adapters.
