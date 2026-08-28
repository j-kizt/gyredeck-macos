Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.6.0 — New mark, blue accent

### Changed

- **New app and menu-bar icon.** The old mark stacked five overlapping arcs, which turned to mush at the 16–22px the menu bar actually renders. It is now an open gyre around a still core — one shape that stays readable at every size. The status-bar variant is drawn separately rather than scaled down: the app icon's margin exists for its rounded plate, and reusing those proportions left the status item at 59% of the frame, visibly smaller than its neighbours.
- **The interface accent moved from orange to blue** to match the new mark. Warm colours stay where they carry meaning — waiting and error states are unchanged.
- **Async controls in Settings now show they are working.** Reconnect, the Claude Code and Antigravity hook installers, the git identity sync toggle, and the updater's Check/Update buttons previously sat inert while a slow native call ran, so a working button was indistinguishable from a dead one. Each now disables and spins for the duration.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
