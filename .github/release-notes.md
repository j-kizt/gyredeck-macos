Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, local services, and GitHub repo/CI/PR monitoring, in a window from the menu bar.

## v1.2.0 — Sign in without gh, git credential helper, per-turn tokens

### What's new

- **Sign in to GitHub without the gh CLI.** The GitHub tab now has a "Sign in with GitHub" device-flow login — no `gh` required. Importing from the `gh` CLI is still available as a shortcut.
- **Gyredeck as a git credential helper.** New Settings → Git toggle points `git` at your active Gyredeck account, so HTTPS `git push`/`pull` follows the account you pick — no `gh`, no keychain juggling. Off by default.
- **Per-turn token usage.** Completed Claude Code turns now show their token cost in Recent activity (e.g. `done · 1.3K out · 2 in · 417K cached`).
- **Terminal.app support.** Focus can now jump to the built-in macOS Terminal, alongside iTerm2 and Ghostty (now a dropdown).
- **Hover tooltips everywhere.** Truncated text (commit messages, PR titles, paths, service endpoints, models) reveals in full on hover; Settings descriptions wrap instead of clipping.

### Fixes

- **No more duplicated activity.** Upgrading from the old Agent Activity brand left its hook registered alongside Gyredeck, doubling every event. Installing the hook now removes the stale registration automatically.
- **Subagent turns are distinct.** A subagent finishing no longer shows as a second "done" or flips a still-working session to complete — it's labeled "subagent".

### Polish

- Keep-awake and git credential helper are now switch toggles; Settings gains a Git section with alphabetized tabs.
- Session detail footer redesigned (Focus + Delete on one row); clearer "Keep awake while working" copy; readable detail badges.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
