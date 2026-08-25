# Gyredeck Architecture

## Goal

Gyredeck is a local presence layer for AI coding agents. It shows what your agents are doing — conversation lifecycle, model turns, and tool usage — without parsing terminal output as the source of truth. It surfaces this in a macOS menu-bar window alongside provider usage, locally listening services, and GitHub repo/CI/PR status.

It is local-first: everything runs on `127.0.0.1` and nothing is uploaded.

## Data flow

```text
Claude Code hooks     Codex notify        Antigravity (AGY) hooks
  Pre/PostToolUse       agent-turn-          PreToolUse / PostToolUse
  UserPromptSubmit      complete             PreInvocation / Stop
  Stop / Notification        |                       |
        |                    |                       |
        v                    v                       v
adapters/claude/…    adapters/codex/…       adapters/antigravity/…
  claude-hook.mjs      codex-notify.mjs       agy-hook.mjs
  (rich per-tool)      (coarse turn-level)    (per-tool + turn)
        |                    |                       |
        +---- POST /ingest, /hook/stop, /hook/attention ----+
        |
        v
Gyredeck Bridge  (adapters/bridge/gyredeck-bridge.mjs)
  127.0.0.1:47621
  - normalizes and carries scope (agent/conversation/cwd/model) per source
  - appends NDJSON audit log
  - serves GET /health, GET /snapshot, GET /events (SSE)
        |
        v  GET /events (SSE) + GET /snapshot hydrate
Tauri menu-bar window  (apps/desktop)
  - React renderer subscribes to the bridge, reduces events into presence
  - four tabs: Sessions · Usage · Services · GitHub
```

## Components

### Adapters (`adapters/`)

Each adapter is a small Node script (`.mjs`) invoked by an agent's hook mechanism. It translates that agent's native hook payload into a protocol-v2 `GyredeckEvent` and POSTs it to the bridge. Adapters never block the host agent (they exit fast and, for hooks that gate execution, always return "allow").

| Adapter | File | sourceKind | Fidelity |
| --- | --- | --- | --- |
| Claude Code | `adapters/claude/gyredeck-claude-hook.mjs` | `claudeCodeHook` | Rich: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Notification`, `Stop`/`SubagentStop`, `SessionEnd`. Reads `model` from the tail of the transcript JSONL. |
| Codex | `adapters/codex/gyredeck-codex-notify.mjs` | `codex-notify` | Coarse: Codex only invokes a `notify` program, so only `agent-turn-complete` is mapped, into a turn-completion signal. |
| Antigravity (AGY) | `adapters/antigravity/gyredeck-agy-hook.mjs` | `agyHost` | `PreToolUse`, `PostToolUse`, `PreInvocation` (first invocation opens the conversation; every invocation starts a turn), `Stop`. Reads `model` from the hook payload. |

### Bridge (`adapters/bridge/gyredeck-bridge.mjs`)

A self-contained Node HTTP server bound to `127.0.0.1:47621`. Responsibilities:

- **Fan-in** — `POST /ingest` accepts events from any adapter; `POST /hook/stop` and `POST /hook/attention` accept coarse hook relays and convert them to `turn_complete` / `attention_requested`.
- **Scope carry-forward** — remembers the last-seen scope (`agentId`, `conversationId`, `cwd`, `model`, `permissionMode`, `runtime`) per conversation (falling back to cwd) so fields like `model` never bleed between sources — an Antigravity turn cannot stamp its model onto a Claude conversation.
- **Hook correlation** — attaches an unscoped `Stop`/attention relay to a recent scope only when exactly one recent scope matches the requested cwd/agent, within a bounded window; ambiguous matches stay unscoped.
- **Fan-out** — `GET /events` streams Server-Sent Events; `GET /snapshot` returns recent events plus capabilities; `GET /health` returns identity and capabilities.
- **Audit log** — appends every event as newline-delimited JSON to `~/.config/gyredeck/gyredeck.events.ndjson` (local diagnostics, not telemetry).
- **Trust** — forwarded `runtime` identity is trusted only when the request carries the machine-local `x-gyredeck-token` (a `0600` file under `~/.config/gyredeck/`); otherwise the `runtime` field is stripped before storage.

The desktop app supervises a bundled standalone bridge: at startup it probes `127.0.0.1:47621/health`; a healthy existing bridge is reused, an unrelated listener fails closed, and only an explicitly refused connection starts the bundled bridge. A parent stdio lease plus native exit cleanup prevent the child from becoming a permanent daemon.

### Native desktop (`apps/desktop/src-tauri/src/lib.rs`)

Tauri v2 shell. Native responsibilities:

- **Tray + window** — a menu-bar tray icon with Show / Hide / Quit; clicking it toggles a standard menu-bar utility window (`show_main_window` / `hide_main_window` / `toggle_main_window`). This is an ordinary titled window, not a notch or popover.
- **Terminal focus** — `focus_terminal` activates the matching iTerm2 or Ghostty window by cwd/title via AppleScript (`osascript`). This is best-effort UI focus, not process/session control.
- **Usage providers** — `codex_usage`, `claude_usage`, `cursor_usage`, `agy_usage` run provider CLIs/HTTP off the renderer invoke path (blocking worker pool).
- **Services scan** (`local_services.rs`) — enumerates listening TCP sockets via `lsof`, probes HTTP roots, and exposes a guarded stop/force-kill control for eligible current-user listeners. See `services.md`.
- **GitHub** (`github.rs`) — repo latest commit, GitHub Actions status, and open PRs via the GitHub REST API, using an own token store (`~/.config/gyredeck/github-accounts.json`, `0600`); the `gh` CLI is an optional token importer. Switching the active account also best-effort syncs the global git identity (`user.name`/`user.email`).
- **Display / keep-awake** — persisted display selection and a keep-display-awake toggle.
- **Hook installers** — `install_claude_hook` / `install_agy_hook` copy the adapter and register it, reporting install status back to Settings → Plugins.

### Renderer (`apps/desktop/src`)

Protocol-driven React. `src/main.tsx` orchestrates the window and tab state; feature modules under `src/features/` own focused behavior:

- `session` — reduces the bridge event stream into per-conversation sessions, workspace grouping, and session detail.
- `presence` — presence ingestion from `GET /events` / `GET /snapshot`.
- `usage` — provider usage views.
- `runtime` — the Services panel (`LocalServicesPanel`) and its polling hook.
- `github` — GitHub monitor.
- `setup` — Settings and hook installers.
- `updater` — in-app update check/install.

Ordered files under `src/styles/` preserve CSS cascade ownership.

## The four tabs

| Tab | Source | What it shows |
| --- | --- | --- |
| **Sessions** | bridge events → presence model | Workspace-grouped agent sessions with live activity (turn / tool / compaction / done / needs-input), recent-activity detail, clear/dismiss, and a Focus button that jumps to the matching terminal. |
| **Usage** | native provider commands | Local quota/token views for Claude Code, Codex, Cursor, and Antigravity; truthful unavailable/offline states. |
| **Services** | native `lsof` scan | Locally listening TCP/HTTP services named from their command line, with open-in-browser and guarded stop controls. |
| **GitHub** | GitHub REST API (own token store; `gh` optional import) | Per-repo latest commit, GitHub Actions status, and open PRs for repos you add; inline account switching that also syncs the global git identity. |

**Settings** is grouped into Connection, Display, Plugins (agent hook installers), and Update, plus the Terminal picker (iTerm2 / Ghostty) used by session Focus and a keep-display-awake toggle.

## Presence model

Raw bridge events are normalized into a UI-facing presence state in `packages/protocol/src/presence.ts`, so every surface shares one set of state transitions. See `presence-model.md` and `event-protocol.md`.

## Boundaries

- Only the adapter layer knows about an agent's provider-specific hook payloads; the bridge and UI stay provider-agnostic.
- Keep bridge state local and explicit.
- Do not capture raw user text by default; text preview is opt-in at the bridge config level and off by default.
- Treat the NDJSON log as local diagnostics, not canonical telemetry.
- The desktop UI consumes the protocol package; it does not infer fields from adapter or bridge implementation details.

## Demo mode

The renderer supports `?demo=1` plus focused `demoScenario` values so the UI can be inspected without a live bridge. Demo events run through the same presence reducer, selectors, components, and CSS as live mode.
