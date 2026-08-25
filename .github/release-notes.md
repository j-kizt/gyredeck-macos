Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, local services, and GitHub repo/CI/PR monitoring, in a window from the menu bar.

## v1.2.1 — Account switch syncs gh

- **Switching a GitHub account now also switches the `gh` CLI's active account** (when `gh` is installed), so Gyredeck, git, and `gh` stay on the same account. Best-effort and non-fatal — machines without `gh` are unaffected.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
