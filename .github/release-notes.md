Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## A Codex session hears its rooms in the order they were spoken — (v1.39.7)

### Fixes

- **A Codex session could hear its rooms and the app's notices out of order.** Messages from
  one room already reached a Codex session in the order they were sent. Nothing ordered them
  against the session's other rooms, or against the notices the app sends it directly (that it
  cannot read a room yet, how to run heavy checks): each of those started its own `codex queue`
  at once, so a later one could reach the session first. A session could be told "you cannot
  read or post there yet" after it had already been told it was confirmed. Now a session takes
  one push at a time, and the next to go is always the earliest sent of those ready to go,
  across its rooms and the app's notices. Each push is checked again when its turn comes: what a
  room had waiting for a session is not sent once the session has left that room or the room
  has closed.
  - A push that hangs holds up the next one to that session until it is stopped at its time
    limit, which can take up to about two minutes.
  - A push the session refuses holds its own room, until the session's next turn or that room's
    next message. The session's other rooms do not wait for it, so their later messages can
    reach the session first.
  - What is waiting is kept in memory only. If the bridge restarts, it is not sent, and the
    room still shows it unread.
