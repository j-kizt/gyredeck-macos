Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.5.1 — Build maintenance

### Fixes

- **Release builds reuse a cached dependency tree again.** Actions caches are scoped per ref, so the cache written by one release tag was invisible to the next one and every release recompiled everything from scratch. The cache is now warmed on the default branch, which every ref can read.

No user-facing behavior changes.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
