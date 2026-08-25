Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, local services, and GitHub repo/CI/PR monitoring, in a window from the menu bar.

## v1.1.0 — GitHub without the gh CLI

The GitHub tab no longer needs the `gh` CLI to work.

### What's new

- **Own GitHub sign-in.** Repo commits, Actions status, and open PRs now come straight from the GitHub REST API using a local, `0600` token store — no `gh` required to read data.
- **Import from gh (optional).** If you already use the `gh` CLI, one click imports its accounts and tokens into Gyredeck.
- **Account switching that syncs git.** Switching the active GitHub account in the tab still updates your global git identity (`user.name` / `user.email`) to match, so commits are attributed to the right account.

Everything runs locally on `127.0.0.1`; your token never leaves the machine and is never sent to the UI.
