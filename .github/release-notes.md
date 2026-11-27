Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## Reconnect Discord from Settings — (v1.40.0)

### Added

- **A Discord connector that stopped reaching Discord can be started again from its row.** Until
  now it could only be left to retry on its own, up to a minute apart, or removed and set up again
  with its token.
  - Settings → Remote access shows a Reconnect button (a circular-arrow icon) before Remove
    while Discord reports an error it can recover from. It is not shown for a refused token or a
    missing Message Content Intent: reconnecting cannot fix those, and their own advice stays.
  - Pressing it stops the connector and starts a new one at once, without waiting out the retry
    delay. Rooms followed from Discord stay followed.
  - While it tries, the icon spins, the row reads "Reconnecting…", and Reconnect and Remove wait.
    Once Discord is reached the button goes away. If it still cannot connect, the row says
    "Tried again at HH:MM — still can't reach Discord. Check this Mac's internet, then try
    again." and the button is there to press again. That line is not kept when the app restarts.
