Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## Usage you can see from Discord, and each agent told its own — (v1.42.0)

### Added

- **`/usage` on Discord.** The paired owner can ask for usage from their phone without asking an
  agent or spending its tokens. Gyredeck first runs the same refresh the Usage panel runs (a Claude
  Code login that answered in the last 3 minutes is not asked again; its last answer is shown), then
  answers with the app's own numbers: plan, each window, how much is left (or used, as Usage
  settings → Usage mode says), when it resets, and where and when the reading was taken. The answer
  is visible only to you; /usage itself posts nothing to a room. A provider that could not refresh
  shows its last reading with its age, not as current; if the refresh takes over a minute, /usage
  says usage is not available. After the app restarts, a provider whose refresh fails can show no
  reading at all. Anyone else who tries it is told it is only for the paired owner.
- **Each agent in a room is told its own provider's usage, as Gyredeck last read it, and never
  another provider's.** On joining, each member is told where its usage lives (Codex: its own
  session log, which is the last value Codex recorded, not a live one). Each delivery of new room
  mail an agent collects through the Gyredeck broker carries a one-line reading of its own provider
  (a live watch stream does not, nor does mail held over from an earlier process of the session),
  marked `NOT CURRENT` when it was older than two refresh intervals when collected or has no time,
  or saying `no reading yet`. Claude Code and Antigravity are also shown that line on their next
  delivery after each 10% step down, without being woken. The waking tell now comes at 5% left as
  well as 10%; a drop past both at once is one tell, and a limit hovering around 5% can tell more
  than once.
- **For Claude Code and Codex, the Usage card says when a reading is from the status line or the
  session log.** Antigravity's card still says Updated.

### Fixes

- **Usage could show an older reading over a newer one.** Gyredeck now also reads Claude Code's
  status line and Codex's session log, and shows whichever reading of the same account is newest by
  the time it records, not by when the file was written. Such a reading is shown only once the
  server has answered since Gyredeck started; that answer is what ties it to the account. Claude Code's and Codex's servers are still
  asked on each refresh when they can be (a Claude Code login that answered in the last 3 minutes is
  not asked again). For Claude Code this needs the hook reinstalled: the install sets Claude Code's
  `statusLine` to Gyredeck's script, which runs your own status line after it. There is no button to
  undo it yet; your previous `statusLine` is kept in
  `~/.config/gyredeck/claude-statusline.previous.json`. Antigravity's status-line reading now counts
  as outdated after one refresh interval (was 15 minutes). Auto refresh is now
  5 / 15 / 30 / 60 minutes (default 5); a saved 3 or 10 becomes 5. (#398)
- **Antigravity usage read as decades old, and Refresh could not update it.** agy 1.5.18 writes a
  placeholder for unused quota dated 1970; that date aged the whole reading, so the status line was
  taken as stale and the fallback was tried instead, which fails when it cannot read the Keychain.
  That exact placeholder is now skipped, and the status line is read by its real time again. (#496)
- **Another process on this Mac could post to a mailbox in a session's name.** A post in any
  session's name, in a room or not, now takes that session's own key; without it the bridge answers
  `403 not_your_key`. The reply commands Claude Code and Antigravity are handed carry that key. A
  delivery that carries no key (the bridge read directly, or mail held over from an earlier process)
  comes with no command and one line saying why. Sessions on that direct path can no longer reply at
  all. Keys live only in the bridge's memory: a reply command handed out before a bridge restart is
  refused, and so is one in a batch the broker hands again; new mail delivered through the broker
  after the restart carries a new key. (#403)
- **Antigravity's reply after a wait was refused.** The command printed when a room woke agy posted
  in the room's name instead of the session's own, so the room turned it away. It now posts in the
  session's name; the test runs the printed command and checks the room took it. (#358)

### Reinstall the hooks

Hooks installed before this version print no usage line, their reply command for mail outside a
room lacks the key and is now refused, and Antigravity's reply after a wait is still refused. Settings shows them as Out of date: press Reinstall for
Claude Code and Antigravity. Reinstall for Claude Code is refused while `~/.claude/settings.json` is
a symlink (dotfiles): make it a plain file first.
