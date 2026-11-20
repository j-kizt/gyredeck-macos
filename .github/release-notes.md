Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## Heavy runs stay out of the owner's Discord post — (v1.39.1)

### Fixes

- **A room's heavy-run notices are no longer posted to Discord.** Sync rooms are told about heavy
  runs on this machine, including runs from other projects' sessions: a run that has gone on for
  more than 30 seconds, someone waiting behind another session's run or for the machine's load to drop, and the end of a run whose
  start was told. A room followed in Discord posted each of those notices to its post, so the post
  filled with runs that had nothing to do with the room's work. They are now left out of the
  post, and no gap line ("went by unfollowed") appears where they were. The agents in the room
  still read them, since they use them to decide when to start heavy work, and the room's other
  notices, such as who joined or left, are still posted. A heavy-run notice that the previous
  version had already queued for Discord, and not yet posted, may still be posted once after
  the update.

## Settings, Usage and Ports get a tidier look, and a waiting heavy run can be taken out of line — (v1.39.0)

### Added

- **Remove a heavy run that is still waiting.** Under Settings → Sync, a heavy run waiting in
  the queue now has a red Remove button, shown for each waiting run the bridge names with an id
  (runs queued by an older bridge carry none and show no button). Removing it takes that run out
  of the line without touching the run that is going. Only the app can do this. When the
  waiting helper is told it was removed, it says the Gyredeck app removed it, runs nothing and
  exits with code 75. A removed run that retries is refused while the bridge still remembers the
  removal: it keeps the last 128 in memory, and forgets them when it restarts. As before, a
  helper that cannot reach the bridge at all runs its command outside the queue.
- **Sync rooms read like Git accounts.** Each room under Settings → Sync is one row with its
  session count, and its actions (Connect or Disconnect for Discord, and Close room) sit in a ⋮
  menu, as an account's do. A room followed in Discord shows the Discord mark after its name.
- **The ⋮ menus work from the keyboard.** Opening one puts focus on its first item, the arrow
  keys, Home and End move between the items that can be pressed, and Escape closes the menu and
  puts focus back on ⋮, without closing Settings. This holds for room and Git account menus alike.
- **The approval code is now Multi-factor authentication, in a row of its own.** The
  authenticator code that approves a merge or a release from Discord used to sit among the
  Discord rows as "Approval code". It is now under Settings → Connection → Security.

### Fixes

- **A refused Kill now stays said.** When Kill on a running heavy run was refused, the reason
  was shown and then wiped at once by the status read that followed it, so nothing was left on
  screen. The reason now stays until the next Kill or Remove is pressed, while the status keeps
  refreshing. Remove, new in this release, behaves the same way.

## A Codex thread gets longer to come back to its sync room — (v1.38.2)

### Fixes

- **A Codex thread now has 60 seconds to come back before it leaves its room.** When Codex
  updates itself, it ends the running thread and resumes it shortly after under the same id.
  Gyredeck held a member's place for 15 seconds after an end. On 2026-11-20 a Codex member was
  taken out of its room after an update whose resume came 16 seconds after the end, and had to be
  let back in by hand. The end's reason was not recorded then, so the 15-second hold is the likely
  cause rather than a confirmed one. A Codex thread that ends for a reason other than a deliberate
  one (such as a logout or a clear) now keeps its place for 60 seconds. Other sessions still get
  15 seconds, and a deliberate end still takes the member out at once. A thread that is not back
  within the 60 seconds leaves as before, and coming back needs a fresh confirmation.
- **A session's end is kept with a known reason only.** Gyredeck's event log records why a
  session ended, so a member leaving can be explained afterwards. The reason came straight from
  the agent's hook. Gyredeck now keeps it only when it is one of the known reasons, and stores
  anything else as `other`. Of the rest of what the hook sends, only the duration and the message
  and tool counts are kept, as numbers.
