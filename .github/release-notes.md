Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## Nothing said in a sync room goes missing without saying so — (v1.16.3)

Two ways a room could lose your messages quietly, and one way it could pretend to still
be there after it had ended.

### Fixes

- **A room refuses a message rather than eating one nobody has read.** Rooms have always
  had a limit, and past it the oldest message was simply dropped — whether or not the
  session it was addressed to had collected it, and with nothing anywhere saying so. The
  reader was handed a shorter list, which looks exactly like nothing more having been
  said. A room now spends its space in one direction only: a message may go once everyone
  has read it, and when everything left is still owed to somebody the sender is told the
  room is full and who it is waiting on. The limit is also counted in bytes now as well as
  messages, which the old one was not — it counted characters of a kind that do not
  correspond to space, so for Thai it was out by more than double.
- **Answering is no longer treated as reading.** A session that replied without collecting
  its mail looked caught up, so the room felt free to spend what had been addressed to it.
  This is the one that bites during a long review, where one side is busy thinking.
- **A sync room code that is no longer open says so.** Reading a room that had ended
  answered like an open room with nothing in it, so a session kept watching a code that no
  longer existed and saw only quiet. Worth knowing: updating the app restarts the bridge,
  and every open room ends with it.

## Two files that were wider open than they should have been — (v1.16.2)

Both of these are about something outliving what it belonged to: a room without the
person who made it, and a log file keeping the permissions of whichever process happened
to create it first.

### Fixes

- **A sync room cannot outlive the session that created it.** A founder could leave
  through a path that forgot to close the room — and what was left could not be joined,
  because only the founder can let anyone in, and could not be closed either, because the
  app asks as itself and gets the same refusal. It was a code that could only be
  abandoned. The bridge now asks the question of the whole room table instead of relying
  on each way out to remember: a room whose founder is no longer in it is over, whoever
  else is still there, and everyone in it is told.
- **The event log is no longer readable by anything on the machine.**
  `~/.config/gyredeck/gyredeck.events.ndjson` records what each agent was doing and
  where — a conversation id, a working directory, a model — and it was created by
  whichever process appended to it first, which left it world-readable while the token
  beside it was not. Gyredeck now opens it itself, refuses to follow a symlink standing
  in its place, narrows a log an older version left open, and **stops writing to disk
  entirely** rather than append to a file it could not make private, saying so once
  instead of going quiet about it.

## A room ends when the person who made it leaves — (v1.16.1)

Three faults in sync rooms, two of them found by using the thing. A room outlived the
session that created it, the unread count outlived its room, and the room's password —
the one thing you hand over by reading it out loud — was given to anything that asked.

### Fixes

- **Leaving a room you created ends it.** It used to remove you and leave the room
  standing, which sounds harmless and is not: everything a room is for afterwards runs
  through its founder, so what was left behind was a code nobody could be let into and
  nobody could close. Now everyone in it is told, every watch is cut, and the room is
  gone — the same as pressing Close, because leaving as the founder is the same act. A
  session simply ending counts as leaving, which is the half that was missed the first
  time. An ordinary member leaving is still just leaving.
- **The message count on a session card goes when its room goes.** It was only ever
  cleared for the session whose detail was open, which is not where the count is shown —
  so a room closing while its session sat unopened in the list left a badge claiming
  messages for a conversation that had ended, until you happened to click that session.
- **A room's password is no longer handed to whoever asks for it.** Two calls returned
  it — one on joining, one on confirming a session that was already confirmed — without
  asking who was calling, and neither needed a credential to reach. Anything running on
  this machine could name a session and be given the password a person is supposed to
  read out by hand. Presenting the password is what earns it back now, and presenting a
  wrong one is refused: it used to answer as though it had worked, so the terminal was
  told a wrong password had been accepted.
- **An access token could be sent unencrypted to another machine.** The check that
  decided whether a URL was safe read the address by splitting the text, which takes a
  username for a hostname — so a URL shaped like `http://localhost@elsewhere` passed as
  local while the request went elsewhere. It reads the address properly now. Redirects
  are refused as well, on both the usage and the local-service paths: a redirect is a
  destination nobody checked, and the one that carries a refresh token keeps it across
  the hop.
- **Room codes are drawn evenly.** The first eight letters of the alphabet came up about
  an eighth more often than the rest. Nothing depended on it — a code is a name, not a
  secret — but it is free to do properly.

### Notes

- Running the test suite no longer starts your agents. It launched the real `codex` to
  deliver a test message, against a temporary home directory it was also deleting.
- A patch, not a minor: none of this is something the app could not do before. The
  versioning note that made v1.16.0 a minor on the strength of "would a user notice?" has
  been corrected — repairing something broken always changes what a user sees, so that
  question cannot be what separates the two.

## v1.16.0 — The local bridge stops taking everybody's word for it

The bridge listens on `127.0.0.1` and, until now, believed most of what reached it. The
machine token it has always handed out was advisory: the routes that mattered read it only
to decide how much of a payload to trust, and one of them never read it at all. Past the
door, a page you happened to have open in a browser could talk to it. This release closes
all of that.

**If an agent hook stops reporting after this update, reinstall it** from Settings →
Plugins. Hooks shipped before v1.15.0 do not send the token, and the bridge now refuses
them rather than half-believing them — the refusal says so in as many words.

### Changed

- **Every mutation now needs the machine token.** `POST /ingest`, the stop relay and the
  attention relay are refused with `401` without it, and the refusal names the fix rather
  than leaving a person to find it. Before this, any process on the machine could write
  into your session list and your event log; the token only decided whether the `runtime`
  field beside the event was believed, and the attention relay did not look at it at all.
- **Reading a sync room needs that room's password and a confirmed member to read as** —
  the rule its live stream always applied, and which the read beside it applied not at
  all. A whole room's history could be fetched by anything that sent the header
  non-empty, and asking for it with `collect=1` also moved the read position, so the
  member it was addressed to never saw the mail. Speaking in a room is checked before
  `from` is read, so a confirmed member can no longer be spoken for.
- **The bridge answers the app's own pages and nothing else in a browser.** The origin
  policy was `*`: any page open in any tab could reach a server on your own loopback,
  which is the one thing a same-origin policy exists to stop. A foreign origin is now
  turned away before the route runs — not merely blocked in the browser afterwards, which
  for anything that changes state is too late. Requests that carry no origin at all are
  unaffected: those are the adapters and the app itself, which are processes, not pages.

### Fixes

- **A hook installed somewhere else no longer reports itself as installed.** The
  Antigravity status asked only whether a registration existed, not whether it named the
  adapter this build manages — so an install left by an older version read as *Installed*
  while Antigravity went on running the older copy, and the out-of-date check compared a
  file nothing was using. It now compares the registered command against the installed
  path, as the Claude Code and Codex statuses already did. Two smaller versions of the
  same mistake are fixed with it: a backup file sitting beside the adapter counted as the
  adapter, and a malformed registration was read as a valid one.

## v1.15.0 — Codex notify installed from the app, and hooks that admit their age

### Added

- **Settings → Plugins installs Codex notify.** It was the one adapter still wired by
  hand-editing `~/.codex/config.toml`. The installer edits that file without disturbing
  its comments or ordering, and refuses — before touching anything — if `notify` already
  points somewhere else: Codex runs one notify program, and replacing it would silently
  disconnect whatever was there.
- **An out-of-date hook says so.** Each installed adapter is compared against the copy
  this build ships; one left behind by an update shows *Out of date* with a Reinstall
  button instead of quietly going stale. A red dot on the Settings control and on the
  Plugins tab points there while any needs the visit. An install whose currency cannot
  be checked is flagged too — unknown is not the same as fine.

### Fixes

- **One Codex turn no longer arrives twice.** With both the full Codex hooks and Codex
  notify installed, a finished turn was reported by each under a different identity, so
  the session list grew a phantom and one ending interrupted twice. The bridge now pairs
  the two stops, whichever order they arrive in, and keeps the one that knows the real
  session — while a Codex with no hooks at all still reports through notify, which is
  what it is for. Naming a runtime on a stop is believed only with the machine token,
  so nothing unauthenticated can claim to be a hook and silence the real one.

## v1.14.1 — Messages that end with their room

### Fixes

- **A sync room's replies no longer outlive the room.** They were filed under the session
  alone, so leaving a room left them there — counted as unread, shown in a tab, for a
  conversation that had ended — and mixed in with the next room's if one was joined. The
  Messages tab now appears only while there is a room to have messages in.
- **Opening a session no longer deletes what it was opened to read.** The check for "is
  this session in a room" ran before the answer had arrived and read the blank as "no
  room", clearing the session's messages every time its detail was opened.
- **One session's room no longer appears on another.** An answer arriving after the
  selection moved on was applied to whichever session was on screen by then, briefly
  showing the wrong room code — and offering a Disconnect that would have acted on it.
- **The bundle size ceiling is enforced in CI**, which it never was. It had been exceeded
  for four merges without anything saying so, v1.14.0 among them. The limit is now a
  number chosen with a reason rather than one that happened not to have been crossed.

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
