Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.4.1 — Git account fixes

### Fixes

- **Deleting or switching a git account could hang** — the `gh`/`glab` CLI logout/switch no longer inherit stdin, so an interactive CLI prompt can never block the operation.
- **Removing / setting-active now always works** — these no longer hard-fail on a strict name check, so an account with an odd or legacy-tagged name can still be managed and removed.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
