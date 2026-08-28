Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.5.0 — Resume commands and Antigravity hook conformance

### Changed

- **Copy a ready-to-run resume command** — the copy button in session detail now copies `claude --resume <session-id>` for Claude Code sessions, so it can be pasted straight into a terminal. Codex and Antigravity ids aren't CLI-resumable, so those still copy the raw id.
- **Antigravity hooks now cover all five events** — `PostInvocation` joins `PreToolUse`, `PostToolUse`, `PreInvocation` and `Stop`. It deliberately reports no turn completion of its own: a turn can span several model invocations, so only `Stop` ends a turn.
- Settings → Plugins lists the agent rows alphabetically.

### Fixes

- **Antigravity hooks answer every event with its documented response shape.** `PreToolUse` previously replied with a partial `{"decision":"allow"}` and the other events with a bare `{}` — an answer Antigravity doesn't accept is treated as a *deny*, which can block every tool call. Each event now returns its full documented payload.
- Opening Settings no longer re-renders the panel once per adapter when hook status is unknown; a stray re-render there could drop keyboard focus.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
