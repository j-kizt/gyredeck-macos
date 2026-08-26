Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.4.2 — Credential helper toggle fix

### Fixes

- **"Use Gyredeck for git auth" can now be turned on/off any time** — it is a persisted preference, no longer tied to whether a helper line already exists. Previously it could refuse to turn on when there was nothing to install (e.g. only GitHub accounts with the `gh` CLI already handling GitHub, or no accounts at all). Adding an account later re-applies the helper automatically.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
