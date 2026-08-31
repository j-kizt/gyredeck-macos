Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## v1.7.0 — Context usage per session

### Changed

- **Session detail now shows how full the conversation is.** Claude Code's Stop hook already carried the transcript's token counts; nothing displayed them as a proportion. Opening a session shows the prompt-side total against the model's context window, with a bar and a percentage, plus the cached / new / fresh split.

  Two limits are stated rather than papered over. The number is measured when the Stop hook fires, so it holds steady while an agent works and steps once the turn ends — the row is labelled `last turn`. And the window is never guessed: it comes from a table of published figures per model family, so a model absent from that table shows the token count with no bar.

  This reaches Claude Code sessions only. Antigravity's hook payload carries no token fields and Codex sends a single notify, so those sessions show no meter.

Everything runs locally on `127.0.0.1`; nothing is uploaded and tokens never leave your machine.
