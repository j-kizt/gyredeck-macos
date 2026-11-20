Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## A Codex thread gets longer to come back to its sync room — (v1.38.2)

### Fixes

- **A Codex thread now has 60 seconds to come back before it leaves its room.** When Codex
  updates itself, it ends the running thread and resumes it shortly after under the same id.
  Gyredeck held a member's place for 15 seconds after an end. On 2026-11-20 a Codex member was
  taken out of its room after an update whose resume came 16 seconds after the end, and had to be
  let back in by hand. The end's reason was not recorded then, so the 15-second hold is the likely
  cause rather than a confirmed one. A Codex thread that ends for a reason other than a deliberate
  one (such as a logout or a clear) now keeps its place for 60 seconds. Other sessions still get
  15 seconds, and a deliberate end still takes the member out at once. A thread that is not back
  within the 60 seconds leaves as before, and coming back needs a fresh confirmation.
- **A session's end is kept with a known reason only.** Gyredeck's event log records why a
  session ended, so a member leaving can be explained afterwards. The reason came straight from
  the agent's hook. Gyredeck now keeps it only when it is one of the known reasons, and stores
  anything else as `other`. Of the rest of what the hook sends, only the duration and the message
  and tool counts are kept, as numbers.
