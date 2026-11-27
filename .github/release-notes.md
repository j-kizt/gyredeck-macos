Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## Discord no longer fills a room, and members are shown by name — (v1.39.11)

### Fixes

- **Discord took one of a sync room's 8 places, so a room with 8 sessions could not be
  followed from Discord.** Connect was refused as "the room is full" until a session left.
  Discord now joins on top of the 8 sessions, so a full room can still be followed. The 8-session
  limit itself is unchanged: a 9th session is still refused, with or without Discord.
  - The room's row in Settings counts sessions only, so 8 sessions plus Discord reads "8
    sessions". The "Room full" tag and its advice line are gone.
- **A named room member was shown with the folder and session id it needed only for
  routing.** A member is now shown as its provider and name, such as `Claude Code / Worker`,
  or as its provider and the last six characters of its id, such as `Claude Code / #0ab12c`,
  until it is named. The same form appears in messages, in the Discord relay and in the room's
  notices. When a member first gives itself a name with a room message, the room says so as
  `Claude Code / #0ab12c is now Claude Code / Worker.`; a name set or changed in the app is not
  announced.
  - When two members of a room have the same provider and name, the first one shown with it
    keeps it plain and the other carries its id after the name, such as `Claude Code / Worker
    #00a002`. A newcomer never changes how an existing member is shown.
  - A message can be addressed to the shown form, to the routing label as before, or to the
    form older versions showed. When a member's shown form reads the same as another member's
    older form, the address goes to the member showing it. An address that still fits two members
    reaches neither: the member API refuses it, and a Codex reply addressed that way goes to the
    whole room. That can only happen when a member is given a name that looks like another
    member's id.
  - A message keeps the sender as the room showed it when it was sent, even after a later
    rename. Messages recorded by an older version still show the routing label.
  - A room message's notification now puts the sender in the title and the room on a
    separate line, so a long room name no longer cuts the sender off.
