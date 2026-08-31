Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.7.1 — Launching the app opens its window

### Fixes

- **Opening Gyredeck from Finder or Launchpad now shows the window.** It previously placed the tray icon on the menu bar and stopped there, so a launch needed a second click on the tray before anything appeared — and with no Dock icon to bounce, the first click looked like it had done nothing at all. Clicking the icon while the app was *already* running did open the window, which made the behaviour seem inconsistent rather than simply missing.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
