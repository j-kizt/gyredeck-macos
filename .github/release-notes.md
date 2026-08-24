Agent Activity is a local macOS menu-bar companion that surfaces live Claude Code / Codex activity, provider usage, local services, and the state of the GitHub repos you track.

### What's new
- **Switching GitHub account now keeps git in sync.** When you switch the active account in the GitHub tab, your global git identity (user.name / user.email) is updated to match, so new commits are authored by the right account. It uses the account's email when available, otherwise the GitHub noreply address.

Note: this updates your **global** git config. Repositories that set their own local user.name/user.email keep it and are unaffected.
