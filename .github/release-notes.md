Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.6.1 — Panel crash fix

### Fixes

- **A stored-account read that came back empty no longer takes down the whole panel.** The Git Monitor account load treated its result as a list without checking, so a null answer surfaced as "Something went wrong rendering the panel." — losing Sessions, Usage and Listening Ports along with it, not just Git Monitor. The value is now checked where it arrives.

No other user-facing behavior changes: the rest of this release is build tooling and test maintenance.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
