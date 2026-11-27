Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## The room inbox and two caches move out of localStorage — (v1.39.10)

### Fixes

- **The room inbox, the GitHub status cache and the usage readings grew the app's storage until
  a restart.** They were kept in the window's localStorage and rewritten often, and WebKit did not
  fold its log back while the app ran, so every rewrite added to it. Now each is kept in its own
  file in the app's data folder, written whole to a new file and swapped in, as session history
  already is, so rewriting them no longer adds to that log. How much smaller the app's storage
  stays has not been measured on an installed app yet.
  - The first run of this version moves what you had into the file, and removes the old copy only
    once the file holds it.
  - Changes are saved only when something changed, and normally gathered into one save every 2
    seconds. When the window's page is unloaded, a waiting save is sent at once instead. A change
    made in the last 2 seconds before the app quits can still be lost.
  - If the app cannot read one of these files when it starts, or gets no answer within 3
    seconds, it works from memory for that run and saves nothing, so the file is
    never replaced by something made without it. What changes in that run, such as messages marked
    read in the room inbox, is lost when the app quits.
  - Running an older version after this one and then coming back: what the older version saved is
    discarded, and the file is used.
