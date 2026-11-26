Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## An Antigravity member keeps hearing its room — (v1.39.8)

### Fixes

- **An Antigravity session in a room went deaf as soon as it forgot to restart its wait.** A
  room reaches an idle Antigravity session only through a wait the session runs itself as a
  background task, and that wait has to be started again after every wake. The room asked for
  it in a step the session saw for one turn only, so when the session ended a turn without
  starting it, nothing reached it until someone typed at the Mac — a message from Discord got
  no answer. Now, when such a turn ends on its own, the app's Stop hook checks whether a wait
  is running for that session and asks the bridge whether the session is a confirmed member of
  a room right now. If it is, and no wait is running, the session is told to keep going and
  given the exact command to start its wait.
  - It costs at most one extra model call for a turn that ended without a wait, and the
    session is asked once per turn: if it does not start the wait, it stays deaf until its
    next turn.
  - Nothing is asked on a turn you cancelled, for a session that has left its room or whose
    room has closed, or while it has not yet been let in. If the app cannot be reached at that
    moment, nothing is asked either, and the session stays deaf until its next turn.
  - Asking reads the room only; it collects no message, so nothing is moved or held at that
    point.
