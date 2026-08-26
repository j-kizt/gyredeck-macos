Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.4.0 — GitLab support

### Changed

- **GitLab in the Git Monitor tab** (renamed from "GitHub") — track GitHub and GitLab side by side: latest commit, CI status (GitHub Actions / GitLab pipelines), and open PRs/MRs. Add accounts via OAuth device flow ("Sign in with GitLab/GitHub") or import from the `gh`/`glab` CLIs.
- **Built-in git credential helper now covers GitLab too** — `git push`/`pull` works without the CLIs. It installs per-host and defers to any existing `gh`/`glab` helper, auto-refreshes expiring OAuth tokens, and uses `oauth2` for GitLab.
- **Settings → Git** — a "Sync git identity" toggle (switching accounts can update your global `user.name`/`user.email`, or stay view-only) and an account list with a per-account actions menu (Set active / Delete, which also signs the account out of its CLI).
- **Configurable bridge port** (Settings → Connection) — set the local port the bridge listens on, applied with a restart.
- **Clearer tab names** — "GitHub" → **Git Monitor**, "Services" → **Listening Ports**, each with its own header icon.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
