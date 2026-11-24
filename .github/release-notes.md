Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## Codex gets longer to come back to its room, and a failed push no longer marks mail read — (v1.39.4)

### Fixes

- **A Codex thread now has an hour to come back to its sync room.** When Codex updated itself on
  2026-11-20, it ended the running thread and resumed it under the same id. v1.38.2 held the
  thread's place for 60 seconds after an end like that, so a resume that came later cost the
  thread its place, to be let back in by hand. A Codex thread that ends without a deliberate
  reason (such as a logout or a clear) now keeps its place for one hour. A deliberate end still
  takes the member out at once, other sessions still get 15 seconds, and a thread that is not
  back within the hour leaves as before. Until then, a thread that has really gone stays listed
  in the room.
- **Mail pushed into a Codex thread counts as read only once Codex took it.** Gyredeck hands
  room mail to Codex with `codex queue`. The mail was marked read whether or not the push
  succeeded, so mail in a push that Codex refused, that failed, or that hung was lost without a
  sign. A message sent straight to a Codex member was also marked read as soon as its push was
  queued. Mail now counts as read only when `codex queue` exits successfully. A push that fails
  while the bridge keeps running is tried again on the thread's next wake. The waiting pushes
  live in memory only: if the bridge restarts first, the mail stays unread but is not pushed
  again by itself. When the bridge cannot find Codex at all, nothing is pushed. A thread's pushes into one room go one at a time, in the order the mail was
  said. A push that runs past 60 seconds is stopped and counts as not taken, even if it then
  exits successfully, so a message Codex had already taken before its push was stopped can
  arrive twice.
- **Leaving or closing a room drops its waiting pushes.** Pushes still waiting for a Codex
  thread are dropped when that member leaves the room or the room closes. A waiting push of one
  of the room's own notices is also dropped once the room no longer holds that notice. A push
  that had already started can still reach the thread.
