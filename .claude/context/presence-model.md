# Gyredeck Presence Model

The bridge emits raw events. The presence model converts those events into a small UI-facing state so every viewer shares one set of rules instead of inventing its own.

## State shape

```ts
type GyredeckPresenceStatus =
  | "offline"
  | "idle"
  | "thinking"
  | "tool-running"
  | "attention"
  | "closed"
  | "error";
```

The reducer lives in `packages/protocol/src/presence.ts`.

## Transitions

| Event | Status | Notes |
| --- | --- | --- |
| `bridge_ready` | `idle` | Bridge is alive even if no conversation event has arrived yet (keeps current status if a conversation already exists). |
| `conversation_open` | `idle` | Clears active tool and counts. |
| `turn_start` | `thinking` | A user turn entered the model path. |
| `llm_start` | `thinking` | A provider request started. |
| `tool_start` | `tool-running` | Captures `activeToolName`; no arguments are stored. |
| `tool_end` | `thinking` / `error` | Clears active tool; `status: "error"` becomes error, otherwise returns to thinking. |
| `compact_start` | `tool-running` | Context compaction shown as active work with `activeToolName = "compact"`. |
| `compact_end` | `thinking` | Returns to thinking. |
| `llm_end` | `closed` / `thinking` / `error` | Terminal stop reasons close the turn; provider errors enter error state; otherwise thinking. |
| `attention_requested` | `attention` | User input is required; persists until later tool/turn/completion activity resolves it. |
| `turn_complete` / legacy `turn_stop` | `closed` | `Stop` hook signal: the assistant turn finished and should show as done/sticky. |
| `conversation_close` | `closed` | Captures message/tool counts when available. |
| `bridge_error` | `error` | Reserved for bridge/runtime errors. |

## Staleness and completion fallback

`getPresenceView` marks a `thinking`/`tool-running` state as `stale` after `staleAfterMs` (default 30000ms) without a new event, so a viewer never shows in-flight work forever when a terminal event never arrives.

Because not every source emits every event, the `Stop` hook relay via `POST /hook/stop` is the reliable turn-finished fallback: Claude Code and Antigravity both emit a `Stop` hook, and Codex only emits a coarse turn-completion signal. The desktop treats an expired in-flight state as inactive history rather than a user wait — only `attention_requested` means the agent actually needs input.

## Derived activity kind

The Sessions UI derives a smaller "activity kind" from raw events for recent-activity rows. This is a UI derivation, not a new protocol field, and it never invents task content or exposes tool arguments/output.

| Raw event | Activity kind | Meaning |
| --- | --- | --- |
| `turn_start` / `llm_start` | `thinking` / `model` | Model turn or provider request started. |
| `tool_start` + plan/goal tools | `planning` / `goal` | Planning work, no fabricated task content. |
| `tool_start` + shell/task/skill tools | `shell` / `tool` / `skill` | Generic execution, arguments/output not exposed. |
| `tool_start` + edit/patch tools | `editing` | Code/file edit activity. |
| `tool_start` + agent/task tools | `delegating` | Subagent activity, no fabricated hierarchy. |
| `tool_start` + memory/compaction | `memory` / `compact` | Memory/context work, content not exposed. |
| `tool_end` | derived tool kind | History keeps the latest truthful activity; no fake running claim. |
| `attention_requested` | `attention` | User input required; persists until later activity resolves it. |
| `turn_complete` / `turn_stop` / `conversation_close` | `done` | Completed row remains sticky until explicit clear/dismiss. |
| `bridge_error` | `error` | Error state; safe detail stays textual. |
| lifecycle / idle | `session` / `bridge` | Identity stays visible without a false activity claim. |

Important limitation: there is no native `plan_start`, `thinking_delta`, or assistant-text event. "Planning" is inferred from plan/goal tools, "thinking" from `turn_start`/`llm_start`, and active work from tool/model/compaction lifecycle until a terminal event or inactivity.

## Privacy stance

The presence model should be enough for ambient UI:

- agent / conversation identity
- cwd / model / permission mode
- current status
- active tool name
- event timestamps

It should not need raw prompts, full tool args, transcript contents, or secrets. Text preview is opt-in at the bridge config level and disabled by default.
