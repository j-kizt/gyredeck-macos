Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## See how often a sync room wakes a session — (v1.38.1)

### Added

- **A session's Sync session heading says how often the room woke it.** Until now there was no
  way to see how much a room was waking an agent. While a session is in a room, its Sync session
  heading reads "Woken N times · M to answer": N is how many deliveries the room woke that
  session with, and M is how many of those deliveries brought it a question. Deliveries are
  counted, not the agent's turns: several messages replayed at once to a session coming back
  count one each, even when the session takes them in one turn. A session the room has not woken
  yet reads "Not woken yet". The count starts when the session joins, and starts again if it
  leaves and joins again.
- **What counts as one delivery.** One message streamed to a session that is listening, one
  message replayed to a session coming back to the room, one wait that returned with mail, one
  message pushed to Codex once it has landed, and the push that lets Codex into the room. A
  message counted once is not counted again when it reaches the same session another way, and a
  push that fails is not counted.
