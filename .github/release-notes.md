Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## A read without a key no longer says who is in a room — (v1.40.2)

### Fixes

- **A read with only the machine token no longer tells an agent whether a session is in a sync
  room.** Every agent on this machine holds that token. A read of a session's own mailbox, or of
  its usage, answered `403 not_your_key` when the session was a room member and `200` when it was
  in none, so any agent could check any session id it knew. Now a read with neither the member's
  key nor the broker's word gets one answer for both: the session's private mail only, the room
  never named and no room notices, and a short line saying room mail takes the member's key. Such
  a read never moves the member's own place in its mail. `/usage` answers `200` to any credential,
  since a usage figure belongs to the provider account, not to the room.
- **A room member whose reads lose the broker is told why the room has gone quiet.** If a session
  that has read with its key starts reading without it, the Claude Code and Antigravity hooks say on every turn that room mail
  takes its key, even with nothing to deliver. This lasts until the broker is back or the bridge
  restarts. Both hooks also say it on the turn a room password is accepted, if that turn's
  read is keyless. Otherwise a session that has never read with its key is not told.
- **An Antigravity session whose pasted room password is refused is still told it is blocked**,
  also on a turn that delivers private mail at the same time.
