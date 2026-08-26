Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, local services, and GitHub repo/CI/PR monitoring, in a window from the menu bar.

## v1.3.1 — Security maintenance

### Fixes

- **Patched vulnerable dependencies** — bumped `quinn-proto` (0.11.14 → 0.11.17) to pick up upstream remote-memory-exhaustion fixes, and refreshed build-time tooling (`nanoid`, `postcss`).
- **Hardened the release pipeline** — GitHub Actions are now pinned to commit SHAs.

No user-facing behavior changes.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
