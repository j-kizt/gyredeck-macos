# Gyredeck Architecture

## Goal

Gyredeck is a local presence layer for AI coding agents. It shows what your agents are doing — conversation lifecycle, model turns, and tool usage — without parsing terminal output as the source of truth. It surfaces this in a macOS menu-bar window alongside provider usage, locally listening ports, and GitHub/GitLab repo/CI/PR status.

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
  - four tabs: Sessions · Usage · Listening Ports · Git Monitor
```

## Components

### Adapters (`adapters/`)

Each adapter is a small Node script (`.mjs`) invoked by an agent's hook mechanism. It translates that agent's native hook payload into a protocol-v2 `GyredeckEvent` and POSTs it to the bridge. Adapters never block the host agent (they exit fast and, for hooks that gate execution, always return "allow").

| Adapter | File | sourceKind | Fidelity |
| --- | --- | --- | --- |
| Claude Code | `adapters/claude/gyredeck-claude-hook.mjs` | `claudeCodeHook` | Rich: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Notification`, `Stop`/`SubagentStop`, `SessionEnd`. Reads `model` from the tail of the transcript JSONL. |
| Codex | `adapters/codex/gyredeck-codex-notify.mjs` | `codex-notify` | Coarse: Codex only invokes a `notify` program, so only `agent-turn-complete` is mapped, into a turn-completion signal. |
| Antigravity (AGY) | `adapters/antigravity/gyredeck-agy-hook.mjs` | `agyHost` | Registers all five Antigravity hooks (`~/.gemini/config/hooks.json`): `PreToolUse`, `PostToolUse`, `PreInvocation` (first invocation opens the conversation; every invocation starts a turn), `PostInvocation`, `Stop`. Reads `model` from the hook payload. Each event answers its own documented response shape — `PreToolUse` must return the full `{decision:"allow", reason, permissionOverrides}` (a bare `{}` reads as *deny* and would block every tool call), `PreInvocation`/`PostInvocation` return `injectSteps`, `Stop` returns `{decision:"continue"}`. `PostInvocation` emits no Gyredeck event: a turn can span several invocations, so only `Stop` reports completion. This is also the adapter for the new Antigravity CLI, which replaced Gemini CLI in June 2026 and shares the same agent harness and hooks. |

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
- **Git Monitor** (`github.rs`) — per-repo latest commit, CI status (GitHub Actions / GitLab pipelines), and open PRs/MRs for **GitHub and GitLab** via their REST APIs, using an own provider-tagged token store (`~/.config/gyredeck/github-accounts.json`, `0600`). Accounts are added via OAuth 2.0 device flow (GitLab tokens carry a refresh token + expiry and auto-refresh) or imported from the optional `gh`/`glab` CLIs. A built-in git credential helper (`gyredeck-desktop git-credential`) serves `git push`/`pull` without those CLIs, per-host (A1: fills only hosts with no existing gh/glab helper); GitLab uses username `oauth2`. An optional "Sync git identity" toggle writes the global `user.name`/`user.email` (+ `gh auth switch`) on account switch; with it off, switching is view-only.
- **Display / keep-awake** — persisted display selection and a keep-display-awake toggle.
- **Hook installers** — `install_claude_hook` / `install_agy_hook` copy the adapter and register it, reporting install status back to Settings → Plugins.

### Renderer (`apps/desktop/src`)

Protocol-driven React. `src/main.tsx` orchestrates the window and tab state; feature modules under `src/features/` own focused behavior:

- `session` — reduces the bridge event stream into per-conversation sessions, workspace grouping, and session detail.
- `presence` — presence ingestion from `GET /events` / `GET /snapshot`.
- `usage` — provider usage views.
- `runtime` — the Listening Ports panel (`LocalServicesPanel`) and its polling hook.
- `github` — Git Monitor (GitHub + GitLab): account/device-flow logic, repo status, and the account dropdown.
- `setup` — Settings and hook installers.
- `updater` — in-app update check/install.

Ordered files under `src/styles/` preserve CSS cascade ownership.

## The four tabs

| Tab | Source | What it shows |
| --- | --- | --- |
| **Sessions** | bridge events → presence model | Workspace-grouped agent sessions with live activity (turn / tool / compaction / done / needs-input), recent-activity detail, clear/dismiss, and a Focus button that jumps to the matching terminal. |
| **Usage** | native provider commands | Local quota/token views for Claude Code, Codex, Cursor, and Antigravity; truthful unavailable/offline states. |
| **Listening Ports** | native `lsof` scan | Locally listening TCP/HTTP services named from their command line, with open-in-browser and guarded stop controls. |
| **Git Monitor** | GitHub/GitLab REST APIs (own token store; OAuth device flow or `gh`/`glab` import) | Per-repo latest commit, CI status (Actions/pipelines), and open PRs/MRs across GitHub & GitLab; inline account management, optional git-identity sync, and a built-in credential helper for push. |

**Settings** is grouped into Connection (bridge status + configurable local port), Display, Git (credential helper, account list, git-identity sync), Plugins (agent hook installers), and Update, plus the Terminal picker (iTerm2 / Ghostty) used by session Focus and a keep-display-awake toggle.

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
