# Agent Activity

<p align="center">
  <img src="apps/desktop/assets/agent-activity-app-icon.png" alt="Agent Activity app icon" width="128" height="128" />
</p>

<p align="center">
  A local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, local services, and GitHub repo/CI/PR monitoring, in a popover from the menu bar.
</p>

<p align="center">
  <strong>Local-first</strong> · <strong>Menu-bar popover</strong> · <strong>Claude Code &amp; Codex</strong>
</p>

---

## Install

macOS (Apple Silicon or Intel). Paste this into a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/j-kizt/agent-activity/main/scripts/install.sh | bash
```

It downloads the latest release, installs **Agent Activity.app** to `/Applications`, and opens it. The app is self-signed (not Apple-notarized), so the installer clears the quarantine flag for you; after that, updates are handled in-app via **Settings → Update**.

Prefer to do it by hand? Download `Agent.Activity_*.app.tar.gz` from the [latest release](https://github.com/j-kizt/agent-activity/releases/latest), unpack it, and drag the app into `/Applications` (first launch: right-click → Open).

## Overview

Agent Activity is a native macOS menu-bar app that turns AI coding-agent activity into a compact live surface. Click the menu-bar icon and a popover drops down showing what your **Claude Code** (and, more coarsely, **Codex**) sessions are doing right now — plus provider usage, locally listening services, and the state of the GitHub repos you care about.

It is built for people who keep multiple agent sessions and terminals open at once. It listens to trusted local agent events (Claude Code hooks / Codex notify), keeps recent sessions visible with truthful activity state, and adds a few local utilities — without a hosted dashboard and without scraping terminal text.

It does **not** require Letta. Everything runs locally on `127.0.0.1`.

## Surfaces

| Tab | What it shows |
| --- | --- |
| **Sessions** | Workspace-grouped agent sessions with live activity (turn / tool / compaction / done / needs-input), recent-activity detail, clear/dismiss, and a Focus button that jumps to the matching terminal |
| **Usage** | Local quota/token views for known providers (Claude Code, Codex, Cursor, Antigravity), in-use providers first; truthful unavailable/offline states |
| **Services** | Locally listening TCP/HTTP services grouped into web frontends and other listeners, with open-in-browser and guarded stop controls |
| **GitHub** | Per-repo latest commit, GitHub Actions status, and open PRs for repos you add from a picker of the current `gh` account; switch `gh` accounts inline |

**Settings** (gear) is grouped into **Connection**, **Display**, **Plugins** (Claude Code hooks install), and **Update** (current version + check/install updates). It also holds the **Terminal** picker (iTerm2 / Ghostty) used by session Focus, and Keep-display-awake.

## Architecture

```text
Claude Code hooks  ─┐
Codex notify       ─┼─→  adapter (.mjs)  ─→  POST /ingest  ─→  local bridge (127.0.0.1:47621)
                    │                                              │
                    └────────────────────────────────────→   SSE /events
                                                                   │
                                                        Tauri menu-bar popover
                                                        (Sessions · Usage · Services · GitHub)
```

- The **bridge** is a small local HTTP server (`adapters/bridge/agent-activity-bridge.mjs`). The desktop app supervises a bundled copy automatically. Endpoints: `GET /health`, `GET /snapshot`, `GET /events` (SSE), `POST /ingest`, `POST /hook/stop`, `POST /hook/attention`.
- The **Claude Code adapter** (`adapters/claude/agent-activity-claude-hook.mjs`) maps hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Notification`, `Stop`, `SubagentStop`, `SessionEnd`) into protocol-v2 events.
- The **Codex adapter** (`adapters/codex/agent-activity-codex-notify.mjs`) maps the Codex `notify` `agent-turn-complete` event into a coarse turn-completion signal (Codex has no tool-level hooks).
- Local state lives under `~/.config/agent-activity/` (`agent-activity.config.json`, `agent-activity.ingest-token`, `agent-activity.events.ndjson`).

## Install

Requirements: macOS · Node 22 · pnpm 10 · Rust + the Tauri toolchain (for desktop builds) · GitHub CLI (`gh`) for the GitHub tab.

```bash
pnpm install
pnpm desktop:install          # build + install /Applications/Agent Activity.app
```

Then connect your agents:

```bash
pnpm hooks:install            # install the Claude Code hook into ~/.claude/settings.json
```

Or install the hook from inside the app: **Settings → Plugins → Claude Code hooks → Install**, then start a new Claude Code session. Restart Claude Code (or open a new session) so it loads the hook.

Codex (optional, coarse turn-level presence): copy `adapters/codex/agent-activity-codex-notify.mjs` to `~/.config/agent-activity/` and add to `~/.codex/config.toml`:

```toml
notify = ["node", "/Users/<you>/.config/agent-activity/agent-activity-codex-notify.mjs"]
```

## Development

```bash
pnpm check              # typecheck root + desktop
pnpm desktop:dev        # run the Tauri app in dev mode (menu-bar popover)
pnpm desktop:web        # browser-only demo/dev server (no native features)
pnpm mod:tail           # tail the local NDJSON event log
pnpm test:demo          # browser demo Playwright suite
```

Native Rust checks:

```bash
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The menu-bar popover, tray toggle, terminal focus, notifications, and real event streams must be validated in the installed/native app — the browser demo is only for layout and interaction checks.

## Auto-update

Releases are published to GitHub Releases and the app updates itself via `tauri-plugin-updater`:

- Signed update artifacts + `latest.json` are built and uploaded by `.github/workflows/release.yml` when a `v*` tag is pushed.
- The app checks on launch and from **Settings → Update**, shows the release notes, and installs on demand.
- CI signing needs two repo secrets: `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## Project layout

```text
adapters/bridge/     Local standalone event bridge
adapters/claude/     Claude Code hook adapter + installer
adapters/codex/      Codex notify adapter
packages/protocol/   Shared event and presence model
apps/desktop/        Tauri menu-bar popover (src = React/TS, src-tauri = Rust)
apps/viewer/         Terminal event viewer
scripts/             Install/build helpers
```

## Privacy

- Bridge traffic stays on `127.0.0.1`; nothing is uploaded.
- The bridge stores tool status and output length, not raw tool output; user-text previews are off by default.
- The GitHub tab reads the local `gh` CLI of the machine it runs on; account switching affects `gh` system-wide.

## Known boundaries

- Real "end session" control is not exposed (no stable scoped API from Claude Code).
- Subagents fold into their parent session — Claude Code hooks carry only the parent `session_id`.
- Codex presence is turn-level only.
- Terminal Focus matches iTerm2 or Ghostty by cwd/title; it is not a process/session-control API.

## Credits

- **Origin:** [agent-halo](https://github.com/mahirocoko/agent-halo) by Mahiro — the local bridge, presence protocol, and desktop shell this project is built on.
- **This fork:** Letta-free rebuild by J-Kitz — Claude Code / Codex / Antigravity hook adapters, GitHub repo/CI/PR monitor, menu-bar window, and signed auto-update.
- Local usage-provider research is informed by [OpenUsage](https://github.com/robinebers/openusage).
