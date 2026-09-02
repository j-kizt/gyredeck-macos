Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.8.0 — Codex sessions, a tray that shows when you're needed, and agents that can message each other

### Changed

- **Codex sessions now appear alongside Claude Code and Antigravity.** Codex ships a lifecycle hook system, so Gyredeck installs an adapter into it the same way it does for the others — Settings → Plugins → Install, then restart the CLI. Turns, tool calls, compaction and permission prompts all report, and a session card offers `codex resume <id>` to get back to it. Codex loads its hook configuration when a session starts and requires hooks to be trusted, so a session already running when you install will not report until it is restarted.

- **The tray icon badges when a session needs you.** A dot appears on the menu-bar icon while any session is waiting for input, so an approval prompt or a question no longer sits unnoticed behind other windows. macOS template images are all-or-nothing on colour, so the badge is drawn as a real coloured mark rather than tinted.

- **Antigravity raises attention when it asks you something.** It has no notification hook, so there was no signal for "this turn has stopped and is waiting for you" — the `ask_question` tool call turns out to be exactly that signal, and it now surfaces the same way a Claude Code permission prompt does.

- **Antigravity sessions offer a resume command.** `agy --conversation=<id>`, copied from the session card like the Claude Code and Codex equivalents.

- **Agents running on the same machine can message each other.** The bridge now hosts named mail rooms on the port it already binds — `POST /mail/<room>` to send, an SSE stream to be pushed to, or a plain read to collect what arrived while you were idle. Antigravity receives its mail through its `PreInvocation` hook and can answer with a single `curl`; anything that can make a local HTTP request can take part. Messages require the machine-local ingest token, live only in memory, and are never written to the event log.

- **A session card shows mail that is waiting.** A count while messages sit unread, and a quiet marker once the session has collected them — Antigravity picks its mail up only when it next runs, so without this a delivery and a silence looked identical.

- **The Cursor usage provider is gone.** It never reported anything useful and its absence removes a permanently empty row.

### Fixes

- **Antigravity can finish a turn again.** The Stop hook answered `"continue"`, which Antigravity reads as *keep working* — so every completed reply came back with "Stop hook blocked termination" and the agent re-entered its loop, unable to stop. It now answers `"allow"`, and turn completion still reports as before.

- **Mail sent while the bridge was restarting is no longer lost.** Rooms live in the bridge's memory while the delivery cursor lives on disk, so a restart left the cursor ahead of the room and every subsequent message was skipped silently while the hook reported success.

- **Hooks work when the agent was launched from Finder or Spotlight.** They ran `node` from `PATH`, which a GUI-launched process does not inherit from your shell — so hooks installed fine and then silently did nothing. The installed command now points at the Node binary directly.

- **Antigravity usage no longer breaks the panel when an account is missing.** An unexpected empty response was assumed to be a list, and the resulting error blanked the whole view rather than the one row it belonged to.

- **A self-signed language-server client can no longer be pointed at a remote host,** and an OAuth override must be `https` or loopback. Neither was reachable in practice, but nothing enforced it.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
