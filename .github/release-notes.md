Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.14.0 — Told before you run out, and there when you log in

### Added

- **A banner when a quota is running out.** Once when a provider's remaining quota
  crosses 20%, again at 10%, and again when it reaches zero — which says *Quota
  exhausted*, because running out is a different fact from running low rather than a
  sharper warning. Only the crossing is announced: usage is polled every fifteen minutes,
  and "currently low" would interrupt four times an hour for one quota that is simply
  low. Finding quota already spent when the app opens says nothing at all — that is a
  state, not an event. Switched off under Settings → Notification → Usage, where the
  groups are now in alphabetical order.
- **Start when you log in**, under Settings → Display. Read from the system rather than
  remembered, so removing the login item in System Settings is reflected here rather than
  contradicted.

### Fixes

- **A plain `agy` was not recognised as the Antigravity CLI.** Process discovery asked
  for a slash, and `ps` reports a bare invocation as just `agy` — which is how the CLI is
  normally started. The failure was invisible, because the cloud endpoint answered
  instead; the local probe exists for when that one cannot, and it could not have taken
  over.

## v1.13.0 — Follow the CI line to the run

### Added

- **The CI line on a repo card opens the run.** It was the only line on the card that
  could not be followed — the repo name, the pull request count and the commit all went
  somewhere, while the one worth chasing when something breaks sat there as text. The
  link is whatever the provider returned, so it works for a GitHub workflow run and a
  GitLab pipeline alike. A run the provider gave no link for stays plain text rather
  than becoming a button that does nothing.

### Fixes

- **The notification permission is read each time it can be looked at, not once at
  startup.** It lives in System Settings and can be switched off there without telling
  the app, and closing the window hides it rather than closing it — so the first answer
  outlived every chance to notice, and the panel went on saying *Allowed* for a
  permission macOS had already revoked. That also sealed off the refusal notice added in
  v1.11.2: the state never became refused in the app's view, so the sentence explaining
  where to switch it back on, and the button that opens that pane, could not be reached
  by the one person who needed them.

## v1.12.0 — Put the repo you actually watch at the top

Tracked repos sat in the order they were added, which is rarely the order they matter in.
The one checked every hour ends up under three added once and never looked at again.

### Added

- **Drag repo cards into any order you like.** Each card has a grip down its left side;
  dragging it opens an outlined gap where the card will land, so the result is on screen
  before the mouse is released. The list scrolls when you reach either edge, faster the
  further in you go. Only the grip starts a drag — the repo name and the delete button
  keep working as they did. The order is kept per account and survives a restart.

### Fixes

- **Drag and drop could not work at all inside the window.** Tauri turns on a
  window-level handler for files dropped onto the app from outside, and it swallows the
  page's own drop event — a drag would run and end in silence. The app does not accept
  dropped files, so that handler is off.

## v1.11.2 — Notifications, now shown to work

v1.11.1 shipped notifications that had never been seen to fire, and guessed at why: that
macOS ties the permission to a certificate this project does not have. That was wrong.
An ad-hoc signed build is granted the permission perfectly well. Two ordinary bugs were
doing the work, and both are fixed here. All four banners have now been watched arriving.

### Fixes

- **The permission row said "Not asked yet" while macOS held the app as refused.** Once
  refused, every later request returns the same error, so the Allow button could not work
  and the sentence explaining where to undo it could never appear. The request now reports
  the status the system holds rather than whether asking succeeded, and a refusal offers a
  button that opens the pane holding the switch.
- **Sync-room banners had never fired once.** The renderer subscribes to events by name
  and `room_message` was missing from its list, so the events were sent, written to the
  log, and heard by nobody. The list now lives in the protocol package alongside the type,
  with no second copy to fall behind.
- **Every build presented itself to macOS as a different app.** Nothing ran `codesign` on
  the bundle, so the identifier came from the binary name rather than from
  `Info.plist` — meaning a permission granted to one version would not have survived an
  update to the next.

## v1.11.1 — Notifications, landed but unproven

A patch rather than a minor, on purpose. It carries the first notification work, and that
work has never been shown to function: every build it could be tested on locally is
ad-hoc signed, and macOS ties notification permission to a signed bundle id, so the
request fails before any of it is reached. This release exists partly to find out.

If notifications do work for you, Settings → Notification is where they live and the next
release will say so properly.

### Added

- **Settings → Notification.** Two groups: *Sessions* for an agent that needs an answer
  and for a sync room reply addressed to one of your sessions, and *Git* for a watched
  repo moving — CI finishing, a pull request opening, a commit landing. Banners appear
  only while the window is closed; one for something already on screen is how
  notifications become the kind people switch off.
- **The Git monitor keeps watching after you leave its tab**, once a minute instead of
  stopping. The one moment worth being told about — a run failing while you are elsewhere
  — was the one moment nothing was looking.

### Fixes

- The Settings sidebar was a fixed-width column and clipped "Notification" the day that
  category was added. It fits its longest label now, and the window grew by the same
  amount so the panel beside it keeps the room it had.
- Notification switches rendered as bare circles, having been given a class the
  stylesheet does not define.
- Notifications asked macOS to present them with an option deprecated since macOS 11,
  which for an app that never quits meant every one of them was delivered and then shown
  as nothing.

### Notes

- Antigravity still reports no token usage anywhere it can be read — checked in its brain
  directory, its transcript, all five hook payloads, the whole of `~/.gemini`, 992
  collected events, and by asking the agent itself. The adapter now takes counts from
  whatever a payload carries, so a context meter appears by itself on the day one is
  reported. Nothing is estimated from transcript length: a number people believe is worse
  than no number.


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
