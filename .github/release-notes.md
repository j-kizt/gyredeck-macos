Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## Discord's slash commands are set up again after a network failure — (v1.39.5)

### Fixes

- **Setting up `/disconnect` and `/status` is tried again when the network fails.** After the
  Discord bot logs in, Gyredeck sets up its slash commands. That was tried once: on 2026-11-24
  the Mac woke from sleep, the bot logged in, and the request timed out. The commands were not
  set up, and the Discord row said "The Discord connector stopped on an error" for about 15
  hours while the connector kept running. A network failure there is now tried
  again, waiting a little longer each time, up to a minute between tries. While it waits, the
  Discord row says "Retrying /disconnect setup." The line goes
  once the commands are set up.
- **A refusal ends the retries and stays shown.** If Discord refuses to set up the commands
  (for a missing permission, say), Gyredeck stops trying and shows the refusal in place of
  the retry line. It stays until the connector stops or starts again; a new start tries once
  more.
- **Another error no longer overwrites or clears the commands line.** The state of the slash
  commands is kept apart from the connector's other errors. The Discord row shows one line at
  a time: when both are present, the other error is shown first, and the commands line comes
  back once that one clears.
- **An error the app has no wording for no longer says the connector stopped.** It now reads
  "Discord connector error", since some of these errors, such as a refused command setup,
  leave the connector running.
