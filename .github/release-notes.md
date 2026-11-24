Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## Codex keeps its room through an update, and no longer loses mail it never took — (v1.39.4)

### Fixes

- **A Codex thread now has an hour to come back to its sync room.** When Codex updates itself,
  it ends the running thread and resumes it under the same id. v1.38.2 held the thread's place
  for 60 seconds after such an end, and a resume that came later than that cost the thread its
  place, to be let back in by hand. A Codex thread that ends without a deliberate reason (such
  as a logout or a clear) now keeps its place for one hour. A deliberate end still takes the member
  out at once, other sessions still get 15 seconds, and a thread that is not back within the
  hour leaves as before. Until then, a thread that has really gone stays listed in the room.
- **Mail pushed into a Codex thread counts as read only once Codex took it.** Gyredeck hands
  room mail to Codex with `codex queue`. The mail was marked read whether or not the push
  succeeded, so mail in a push that Codex refused, that failed, or that hung was lost without a
  sign. A message sent straight to a Codex member was also marked read as soon as its push was
  queued. Mail now counts as read only when `codex queue` exits successfully; anything else
  stays unread and is pushed again on the thread's next wake. A thread's pushes into one room now go one at a time, in the
  order the mail was said. A push that runs past 60 seconds is stopped and counts as not taken,
  even if it then exits successfully. Because of that, a message Codex had already taken before
  its push was stopped can arrive twice.
- **Leaving or closing a room drops its waiting pushes.** Pushes still waiting for a Codex
  thread are dropped when that member leaves the room, when the room closes, and when the room
  has already trimmed the message. A push that had already started can still reach the thread.
