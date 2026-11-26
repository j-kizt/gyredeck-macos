Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## A Codex session hears its rooms in the order they were spoken — (v1.39.7)

### Fixes

- **Messages pushed to a Codex session could arrive out of order.** Every message the app
  pushed to a Codex session started its own `codex queue` at once, and nothing made one wait
  for the one before, so a later message could reach the session first. A session could be told "you cannot read
  or post there yet" after it had already been told it was confirmed. Now a session takes one
  push at a time, in the order the app sent them, across all its rooms and the app's own notices
  to it. Each push is checked again when its turn comes: what a room had waiting for a session is
  not sent once the session has left that room or the room has closed.
  - A push that hangs holds up the next one to that session until it is stopped at its time
    limit, which can take up to about two minutes.
  - A push the session refuses holds only its own room, until the session's next turn or that
    room's next message; the session's other rooms carry on.
  - What is waiting is kept in memory only. If the bridge restarts, it is not sent, and the
    room still shows it unread.
