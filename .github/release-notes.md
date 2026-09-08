Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.10.0 — Sync Session

Put two agent sessions in a room from the app and let them ask each other things
directly, instead of carrying answers between terminals by hand.

### Added

- **Sync Session.** Press **Create sync** in a session's detail to open a room, then
  **Join sync** to put another session in it. The room's code sits beside three
  buttons: copy the code, copy the room's password, disconnect. The key appears only
  for the session that created the room.
- **Letting a session speak is a separate act from putting it in a room.** Paste the
  room's password into that session's own terminal — the place where the session lives
  and where you are already working. Until then it can neither read the room nor post
  to it.
- **A session can be reached while it is idle.** Claude Code and Antigravity watch the
  room themselves and wake on each message; Codex is pushed to from outside and needs
  no setup. Disconnecting a session tells it so, closes any watch it left running, and
  stops the room's password working for it.
- **Settings → Connection** lists the rooms currently open, and a new **Permission**
  category holds *Allow sync replies without asking*, on by default so a connected
  session is not approved for every message it sends.
- The footer says **local** instead of a version number when the app is run from
  source, so a development build cannot be mistaken for an installed one.

### Fixes

- The native side could not read any response from the bridge. Node answers chunked,
  the parser read the body raw, and a failed parse became an empty answer rather than
  an error — which is why the mail indicator on a session card has been silently
  absent since v1.9.0.


## v1.9.1 — Usage tabs in a more useful order

### Changed

- **The Usage tab now opens on Antigravity, followed by Claude Code and Codex.** A provider that cannot report its quota still sinks to the bottom of the list, as before — this only changes the order when everything is reporting, which is the ordinary case.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
