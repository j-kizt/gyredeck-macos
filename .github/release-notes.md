Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.9.1 — Usage tabs in a more useful order

### Changed

- **The Usage tab now opens on Antigravity, followed by Claude Code and Codex.** A provider that cannot report its quota still sinks to the bottom of the list, as before — this only changes the order when everything is reporting, which is the ordinary case.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
