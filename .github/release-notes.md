Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.9.0 — Every agent can be messaged, and every event is recorded once

### Changed

- **Codex and Claude Code sessions can now receive messages, not just Antigravity.** The local message bus introduced in v1.8.0 could only deliver to one of the three agents. All three now collect their mail: Codex through its own queue command, Claude Code and Antigravity through their hooks. Nothing in the window sends messages — the bus is reached over `127.0.0.1`, and the endpoints are documented in `.claude/context/event-protocol.md`.

- **A message to a Codex session arrives while it is idle.** Codex is the only one of the three that can be reached without the person typing anything: it starts a turn within a couple of seconds and answers on its own. Its reply is read back from its session log rather than requested, because asking it to send a reply would make it ask permission for every single message. Antigravity and Claude Code collect mail the next time their session runs.

- **A session's messages report how far they got.** Sending returns whether the message reached a running session, is waiting for one to run, has nobody to deliver to, or could not find the agent's CLI — so a caller can say what will happen instead of guessing.

- **Notes on what building this taught us** are now in `.claude/context/agent-messaging-findings.md`: which agent can be woken, where context can actually be injected, what an approval prompt costs per message, and the traps that each cost a live failure. Two of the bugs fixed below were reported by the agents themselves, reading the adapter that was mishandling them.

### Fixes

- **Every event was being recorded twice for Claude Code and Codex.** Installing hooks decided "already registered" by comparing the whole command line, so when the command changed — `node` becoming a full path so an agent launched from Finder could find it — installing again added a second copy beside the first instead of replacing it. Both then fired on every event. Reinstalling from Settings → Plugins now clears any older copy of ours first; your own hooks are left alone. If you installed hooks before v1.8.0, reinstall once to clean this up.

- **Messages sent while the bridge restarted are no longer lost.** Rooms live in memory while the delivery position lives on disk, so a restart left the position ahead of the room and every later message was skipped without a trace.

- **A session no longer receives its own reply as new mail.** Replies land in the conversation they answer, which kept them readable in order but meant the sender collected its own last answer on its next turn and replied to itself.

- **Waiting-mail counts are honest again.** Reading a conversation to look at it was counted as collecting from it, so mail could be marked delivered to a session that had never seen it.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
