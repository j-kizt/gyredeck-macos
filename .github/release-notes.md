Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## A Codex update no longer drops Codex from its sync room — (v1.38.2)

### Fixes

- **A Codex member stays in its room through a Codex self-update.** When Codex updates itself,
  it ends the running thread and resumes it a few seconds later under the same id. Gyredeck held
  a member's place for 15 seconds after such an end. On 2026-11-20 the resume came after 16
  seconds, so the Codex member was taken out of its room and had to be let back in by hand. A
  Codex thread now keeps its place for 60 seconds. Other sessions still get 15 seconds, and an
  end that was meant, such as a logout or a clear, still takes the member out at once. If the
  thread is not back within the 60 seconds, it leaves as before, and coming back needs a fresh
  confirmation.
- **A session's end is kept with a known reason only.** Gyredeck's event log records why a
  session ended, so a member leaving can be explained afterwards. The reason came straight from
  the agent's hook. Gyredeck now keeps it only when it is one of the known reasons, and stores
  anything else as `other`. Of the rest of what the hook sends, only the duration and the message
  and tool counts are kept, as numbers.
