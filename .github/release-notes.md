Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## A finished one-off command stops pretending to be a session — (v1.18.3)

**Reinstall the Codex plugins from Settings for this one.** Only Codex's notify adapter is
told which kind of Codex ran, and an update does not replace what is in your config folder.

### Fixes

- **A `codex exec` no longer leaves a session behind it.** Run one and it would open a real
  Codex session, take its turn and close again, all inside about two seconds — and the row
  would stay, marked done, looking exactly like a session you had open. Script a few dozen
  commands and the list is mostly ghosts. A one-off is now shown while it runs, kept a few
  seconds afterwards so you can see it finished, and then it goes. A session you are sitting
  in is untouched: those still wait for you to clear them, the way they always have.
- **A finished one-off you have opened stays open.** Those few seconds are there so you can
  see it — and seeing it means you can click it. It stays until you go back to the list.
- **Gyredeck no longer guesses.** Where nothing has said which kind of Codex ran — an older
  adapter, or the notify plugin not installed — the row is left exactly where it was. The
  only thing that can retire a row is being told, not being old.

Rows left behind by earlier versions cannot be told apart from real sessions after the fact.
**Clear completed** removes them in one go.

## Renaming a session moved to where its name is — (v1.18.2)

The name field arrived in v1.18.0 in the worst possible place: the space the sync-room
buttons live in. It is now a pencil beside the session's own title.

### Fixes

- **Create sync and Join sync are back.** The name field had taken their space, and with it
  the only way into a sync room from a session. Renaming moved up to the title, where the
  name already is: a pencil turns the title into a field with Save and Cancel beside it, the
  way joining a room already looks. The name the session would go by on its own stays in
  faint parentheses behind the one you gave it, so a row can still be matched against the
  window it belongs to.
- **Escape while renaming no longer throws you out of the session.** It was closing the whole
  detail view and going back to the list. It now abandons the edit and leaves you where you
  are.
- **Cancelling a rename no longer cancels the next one.** Press Cancel, open the field again,
  type a name, press Save — and the save was quietly discarded. Nothing told you; the old name
  simply stayed.
- **A rename cannot be typed over while it is being saved.** The field reopened before the
  save had finished, so what you typed second could be replaced by the answer to the first.

## A Codex turn is filed under the session that took it — (v1.18.1)

**If Settings shows Codex notify needing an update, reinstall it from Plugins.** Updating
Gyredeck does not replace what is installed in your config folder, and this fix lives in that
file.

### Fixes

- **Sessions stopped appearing in projects nobody had opened.** A row called after some other
  checkout, with no agent behind it, sitting beside the real one. Codex tells Gyredeck which
  session finished a turn and where it was working, and the part of Gyredeck that listens was
  ignoring both — it reported its own working directory instead, which belongs to a background
  process Codex keeps running from wherever it first started. A turn taken in one project was
  filed against another, under a session that did not exist.
- **Two reports of the same finished turn are matched by session rather than by folder.** Two
  Codex sessions in one checkout share a folder and not a turn, so the folder was never quite
  the right thing to match on. Where an out-of-date copy of the adapter still says nothing but
  the folder, Gyredeck matches it only when nobody else is working there — a repeated turn is
  something you can see and fix by reinstalling; a turn that quietly vanished is not.

## Name a session yourself — (v1.18.0)

A session has been named after the folder it is working in, and that moves: send an agent
into a subdirectory and the row you were watching is suddenly called something else. You can
give it a name of your own now.

### Added

- **A name field at the top of a session's detail.** Type what you call it — "the audit one",
  "the long refactor" — and that is what the list shows. The placeholder is the name it is
  going by now, so you can see what you are replacing; clear the field and that name comes
  back. A named session sits on its own rather than folded into its project's group, because
  being able to pick it out is the point. Names are kept by Gyredeck itself, so they survive
  a restart and an update.

### Fixes

- **Sessions in a sync room are no longer all called "Agent".** Two of them could have the
  same name and no way to tell which was which. Gyredeck knows what each session is from the
  events its agent sends, but it only remembered while those events were recent — and it
  restarts with every update, so anything that had been quiet for a while came back nameless
  through no fault of its own. That is written down now. Where it still genuinely does not
  know, the session is named after its folder from the start rather than taking the bare word
  and leaving the next one to be told apart.

## The room's password is the thing that lets a session in — (v1.17.3)

**If Settings shows Codex notify needing an update, reinstall it from Plugins before using a
sync room.** Updating Gyredeck does not replace what is installed in your config folder, and
after this release a Codex session whose notify is out of date cannot be let into a room at
all. Gyredeck will not offer Sync for such a session rather than let you paste a password
into one that has gone quiet — but the fix is one press in Plugins.

### Fixes

- **Copying a room's password no longer lets people in by itself.** It used to confirm every
  Codex session sitting in the room the moment you pressed the button, which made the press
  the thing that granted access and the password decoration. It also meant the order decided:
  press before a session joined and it was stranded, press after and you had just admitted
  whoever happened to be there. Now the password does what a password is for — a session is
  in once it has been given one, and not before.
- **Gyredeck stops offering a sync room to a Codex session it could not actually let in.**
  The password reaches Codex through its notify adapter, so a copy of that adapter from before
  v1.17.2 has nowhere to put it. The Sync panel now waits for that adapter to be installed and
  current, and Plugins already shows you which one is behind.

## Pasting a room's password into Codex finally does something — (v1.17.2)

If you have ever added Codex to a sync room and watched it sit there asking for a password it
had already been given, this is that. It was not confused: nothing you did could reach it.

### Fixes

- **A session added to a room after you pressed Copy password was stuck for good.** That
  button quietly confirms the Codex sessions that are in the room at the moment you press it,
  and nothing ever ran that again — so adding Codex afterwards left it in the room, unable to
  read a word or say one, with no way out but pressing the button a second time. Nothing said
  so. Messages sent to it still reported success, its own answers were read and thrown away,
  and both sides concluded the other was ignoring them.
- **Pasting the password at the Codex prompt now works, which is what the app told you to do
  all along.** It never had: Codex's hook deliberately forwards only that a turn began, never
  what you typed, and Codex itself cannot reach Gyredeck from inside its sandbox. The password
  now travels by the one channel that is neither — Codex's notify program — and only a value
  that is already exactly the shape of a room password is ever sent. Nothing else you type
  leaves the session.
- **What was said to a session while it was waiting is now delivered when it is let in.**
  Before, it was simply gone: an audit request left waiting for Codex had no way to arrive
  even after the password was finally accepted.
- **Codex's answer to the password itself no longer lands in the room.** It replies before
  Gyredeck learns the password was typed, so a room's first word from Codex used to be it
  wondering aloud whether you had sent it an MD5 hash.
- **A room will not take mail it could not hand over.** Everything held for a session that
  has not been let in yet has to leave in one piece, and that piece has a size limit the room
  itself does not. Such a message is now refused when you send it, with a sentence naming who
  is still waiting for the password — rather than accepted and quietly dropped later.

## The first release signed with the new key — (v1.17.1)

Nothing in Gyredeck behaves differently. This exists to prove the key replaced in v1.17.0 is
the one signing releases now, on a version where being wrong costs an afternoon rather than
an outage — and because the old key is not deleted until a release signed by the new one has
been seen to install cleanly.

If Update offers you this and installs it, that is the proof. If it refuses, say so: it means
a copy somewhere did not take v1.17.0, and the fix is one manual download.

## The log stops growing, and the key that signs updates is replaced — (v1.17.0)

**Install this one before the next release comes out.** It is what hands your copy the new
key updates are signed with from here on. Take it and everything afterwards works as normal;
still be on an older version when the next release lands and that one will refuse to install,
leaving a manual download as the only way forward — Update has no way to offer you an earlier
version instead.

### Changed

- **The event log no longer grows without limit.** `gyredeck.events.ndjson` records what each
  agent was doing and where, and nothing had ever shortened it — it had reached 21 MB here,
  and every start read the whole of it. It is now moved aside past 8 MiB, one previous copy
  is kept, and startup reads only the end of it. If it ever cannot be moved aside, Gyredeck
  stops writing to disk and says so rather than growing anyway.
- **The key that signs updates has been replaced.** The old one had no passphrase and, until
  this week, was readable by anything on the machine — which means anyone who had been on
  your Mac could have signed an update Gyredeck would have accepted. There is no sign that
  anybody did; it is being replaced because it could not be ruled out. The new one is
  passphrase-protected and the passphrase is kept in the macOS Keychain.

This release is still signed with the old key, which is what lets your current copy accept
it. The switch happens in a later release, once everyone has this one.

## Nothing you can see, and that is the point — (v1.16.4)

Housekeeping only. Nothing this release changes is visible while using the app, and it is
published so the work is not left sitting unreleased rather than because there is anything
to go and look at.

### Changed

- **Three pieces of the bridge that could not be tested now can be.** The part that lifts
  Codex's answers out of its own log lived somewhere no test could reach it, which is why
  two faults in it last release had to be accepted on the strength of reading the code
  rather than proving them. It is exactly the same code in the same order, in a place tests
  can call.
- **Two tests that failed occasionally now fail only for real reasons.** One depended on
  where a twenty-four second demo cycle happened to be when it clicked; the other asserted
  an outcome that a busy machine sometimes cannot produce an answer for at all. Neither was
  ever a fault in the app, and no behaviour was changed to settle them.

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
