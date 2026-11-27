Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## A question for you on Discord is one you can answer — (v1.39.9)

### Fixes

- **A yes/no question sent to your Discord without its ✅/❌ marker could not be answered with a
  tap.** You can answer ✅ or ❌ from Discord only when the agent marks its ask as a yes/no
  question. When it forgot, you saw the question, tapped an answer, and were told it needed a
  typed reply, while the agent heard nothing. Now the bridge refuses such an ask when its wording
  reads as yes/no (`ใช่/ไม่`, `yes/no`, `y/n`, `✅/❌`, `❌/✅`) and sends nothing. The agent is told to
  send it again with the marker, or to reword it as a question that needs a typed reply.
  - Any other unmarked ask to you is still sent, and the agent's receipt reminds it that you can
    answer only by typing.
  - The check reads the wording only. A yes/no question worded some other way gets through
    unmarked, and still needs a typed answer.
  - Codex's own short routing line is not checked: refusing a reply Codex has already ended its
    turn on would lose it.
  - An ask for your 6-digit approval code, and the app's own messages, are neither checked nor
    given the reminder.
- **A Claude Code session could stop on a question in the terminal while you were following from
  your phone.** A question picker in the terminal cannot be seen or answered from Discord, so the
  session waited on a question nobody could reach. Now, while its room has your Discord in it, a
  Claude Code session that has been let into that room and tries to open the picker is refused and told to ask you in the room
  instead.
  - It is refused even when you are at the Mac: the app cannot tell whether you are there.
  - It applies only once the session's Claude Code hook is updated. If Settings shows the Claude
    Code hook needs an update, reinstall it from Plugins.
  - Your Discord counts once it has joined the room. Until then, or if the app cannot say who is
    in the room at that moment, the picker opens as before.
