Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.11.0 — Sync Session, after meeting three real agents

Mostly repair. v1.10.0 shipped Sync Session and it did not survive contact with three
agents talking to each other: a room had to be closed twice in one afternoon. Eleven
defects were found by running it, none by reading it. If you are on v1.10.0, update.

### Added

- **A message says who it is for and what it is for.** `to` names a member or everyone;
  `kind` is `ask`, `tell`, `reaction` or `notice`. An ask wants an answer, a tell may draw
  a reaction, and **nothing answers a reaction** — that is where an exchange stops. Being
  in a room no longer means being interrupted by everything said in it: two sessions
  working something out address each other and leave the third alone.
- **A watch you can run rather than build.** Sessions are handed the exact command,
  which resumes from where their stream left off and stops itself when the room is gone.
  Three sessions previously wrote three broken loops from the old description, in one day.
- **The refresh icon in Usage turns while a refresh is running.** The numbers on screen
  are the previous reading and stay put deliberately, so nothing used to show that a press
  had registered.

### Changed

- **A member's name is chosen when it joins and never changes.** Whoever arrives first
  keeps the short one. Names used to be recomputed from whoever was present, so one
  session collected several across a transcript with nothing linking them.
- Closing a room tells every member, cuts every stream, and only then drops the room —
  in that order, or there is nobody left to tell.
- Context use is shown to one decimal place, and **Codex now has a context meter**, read
  from its own rollout log.

### Fixes

- **Codex could say something and reach nobody.** Its replies were only collected while a
  message was being pushed *to* it, so a Codex session told by its own user to speak wrote
  a perfectly good reply that went nowhere. Its log is now read whenever it finishes a
  turn.
- **A message sent to a room that had ended answered `ok` with a seq.** After a restart
  rooms are gone, and the send side was the half still being told everything was fine.
- **A session was woken by its own messages**, and again by acknowledgements and room
  notices every time its watch reconnected — for as long as the room stayed open, because
  catching up never recorded that it had.
- **Being confirmed was announced to the room and not to the session it confirmed**, which
  left Codex asking for a password it had already been given.
- The Create and Join buttons vanished from sessions that were fully hooked, whenever the
  node binary was spelled differently from the way the app expected — including after any
  nvm switch.
- Two sessions addressing each other privately still landed in a third session's turn.


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
