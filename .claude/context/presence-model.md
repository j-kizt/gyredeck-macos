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
| `turn_complete` / `turn_stop` / `conversation_close` | `done` | Completed row remains sticky until explicit clear/dismiss — except a one-shot, below. |
| `bridge_error` | `error` | Error state; safe detail stays textual. |
| lifecycle / idle | `session` / `bridge` | Identity stays visible without a false activity claim. |

## One-shot sessions

`codex exec` opens a real Codex session, takes a turn and closes it, all inside a couple of
seconds. The sticky rule above was written for a session a person is sitting in, and it
turned those two seconds into a row that outlived the command by days — one per command,
beside the session actually in use.

A session is retired from the list when all three are true (`features/session/retirement.ts`):

| | |
| --- | --- |
| It closed | a `conversation_close` event exists for it |
| It is a one-shot | some `turn_complete` carries `data.client` naming a one-shot front end (`codex_exec`) |
| It has been seen | its newest event is at least `ONE_SHOT_GRACE_MS` (8s) old |

`data.client` comes from Codex's `notify` and from nowhere else — no hook is told which
front end ran. **An absent client is never read as one-shot**: a machine without that
adapter keeps every row, which is the failure that loses nothing.

The bridge writes the client down when the notify arrives, *before* the echo and hold
checks that can drop that very event, and stamps it on a completion published in its place
within the next few seconds. That covers the ordering that happens — notify first, the
hook's stop a few milliseconds behind — and not the reverse: a hook stop published before
the notify arrives carries no client, because at that moment nobody has said one. Such a
session simply stays, which is the failure that loses nothing. Closing that half would mean
coalescing the two sides by turn id, which both do carry; it is not done here.

What is remembered is swept after `NOTIFY_STOP_HOLD_MS + CODEX_STOP_ECHO_MS`, the whole of
the gap it exists to bridge. Every `codex exec` is a new session id, so a map that never
forgot would grow for as long as the bridge ran.

Measured order for a one-shot: the hook's `conversation_close` reaches the log first and
the completion naming the client follows about 1.5 seconds later, so the rule reads the
session's events as a set rather than trusting either to arrive first.

## Notify-only threads

Codex's TUI takes helper turns — naming a thread, recapping it — in temporary threads
that inherit `notify` but keep no rollout, fire no hook and are unloaded a minute later
(codex-cli 0.160.1 `start_temporary_thread`; confirmed with Codex, 2026-10-10). Each one
reported itself as a finished Codex session with no model, and 33 of them were under
COMPLETED on the maintainer's machine (#139). The notify payload carries nothing that tells
them apart (`type`, `thread-id`, `turn-id`, `cwd`, `client`, the messages), so the bridge
answers the question the other way round:

| a notify names a thread that… | the bridge does |
| --- | --- |
| a Codex hook has reported, by its own events | publishes it, as before |
| Codex keeps a rollout for under `$CODEX_HOME/sessions` (`~/.codex/sessions` unless set) | publishes it — the notify-only machine's case |
| neither | withholds it: one stderr line per thread ("unclassified; completion withheld"), no event, no session-kinds entry |

"A hook has reported it" is its own fact (`hookReportedSessions`), written only by
`codexCliHook` events and persisted in the session-kinds file as `hookReported: true`.
It is not the provider: a notify-named thread is recorded as `codexCliHook` too, because
that is what the session can do, so the provider would have let every ghost through. A
kinds entry from before the field existed carries no provenance and counts for none. The
provenance shares the kinds file's retention bound: 200 entries, oldest out.

The limit: a notify that arrives before either piece of evidence exists — before the hook
has said anything and before a rollout is discoverable — is dropped, and nothing retries
it. A rollout is expected to be on disk from the session's start, well before its first
turn can end; that is an expectation, not a timing guarantee anyone has measured.

Neither is not "proven internal", only unclassified — and unclassified is not shown. The
same rule runs over the replayed log at start — the persisted provenance is what keeps a
hook-reported session whose hook events have fallen out of the 500-event tail — so a
helper turn recorded before the rule does not come back as a session on every restart.
The legacy `codex:<cwd>` name is not a thread to look up and is left alone. Rows the app
had already persisted are not touched by the bridge; they go with the row's clear button.

Important limitation: there is no native `plan_start`, `thinking_delta`, or assistant-text event. "Planning" is inferred from plan/goal tools, "thinking" from `turn_start`/`llm_start`, and active work from tool/model/compaction lifecycle until a terminal event or inactivity.

## Privacy stance

The presence model should be enough for ambient UI:

- agent / conversation identity
- cwd / model / permission mode
- current status
- active tool name
- event timestamps

It should not need raw prompts, full tool args, transcript contents, or secrets. Text preview is opt-in at the bridge config level and disabled by default.
