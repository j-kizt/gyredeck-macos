# Passing messages between agents on one machine

Findings from building and testing a local message channel between Claude Code, Codex
and Antigravity sessions, 2026-09-02. Everything here was measured against live
sessions on macOS, not read from documentation — where a claim came from docs it says
so, and where a guess was wrong it says that too.

The product this was heading towards (**Sync Session** — rooms that two sessions are
put into and talk inside) is out of scope for Gyredeck and belongs in its own project.
What stayed here is the transport: `/mail` on the bridge, and the adapter code that
delivers into each agent. This document is the ground truth for whoever builds on it.

## What each agent can actually do

| | Reach an **idle** session | Deliver into a running one | Reply without a keypress |
| --- | --- | --- | --- |
| **Codex** | ✅ `codex queue --thread <id> --message` | — | ✅ read its rollout log |
| **Antigravity** | ✗ | `PreInvocation` → `injectSteps` | ✅ it runs `curl` unprompted |
| **Claude Code** | ✗ | `UserPromptSubmit` → `additionalContext` | ✅ it runs `curl` unprompted |

**Only Codex can be woken.** Measured against a thread idle for 78 minutes: `turn_start`
at +2s, answer written at +3s, `turn_complete` at +4s, with nobody at the keyboard. The
other two collect their mail through a hook, and a hook only runs when the session does
— so a message waits until the person types into that terminal again.

There is no way around that with the tools these CLIs expose. Injecting keystrokes into
a PTY would mean guessing terminal state and impersonating the user; it was considered
and rejected.

## Where context can be injected

Verified by returning a probe token from a hook and asking the agent to quote it back:

| agent | event | shape | result |
| --- | --- | --- | --- |
| Claude Code | `SessionStart` | `{"hookSpecificOutput":{"hookEventName":…,"additionalContext":"…"}}` | ✅ quoted the token |
| Claude Code | `UserPromptSubmit` | same shape | ✅ in production use |
| Antigravity | `SessionStart` | `{"injectSteps":[{"ephemeralMessage":"…"}]}` | ✅ quoted the token |
| Antigravity | `PreInvocation` | same shape | ✅ in production use |
| Codex | `SessionStart` | `additionalContext` | ✗ hook fires, text never reaches the model |

Antigravity's `SessionStart` is **not** in the hook documentation embedded in the `agy`
binary (which documents only PreToolUse, PostToolUse, PreInvocation, PostInvocation and
Stop) but the proto carries `SessionStartHookResult` with `InjectSteps`, and it works.
Its payload is richer than what `PreInvocation` gives: `conversationId`, `modelName`,
`transcriptPath`, `artifactDirectoryPath`.

Codex has `additionalContext` and `systemMessage` in its binary along with the error
string `"*: this event cannot emit additionalContext"`, so some event accepts it —
`SessionStart` does not, and `UserPromptSubmit` was not established. Not needed in
practice, because `codex queue` is better than injection anyway.

**Safe way to test a Claude Code hook:** put a `.claude/settings.json` in a throwaway
directory and run `claude -p` with that as the cwd. Project settings are picked up and
nothing global is touched. Testing Codex by editing the installed adapter nearly hung a
live session; do not repeat that.

## The approval tax, and why replies are read rather than requested

Asking an agent to reply *through* the bridge means asking it to run a shell command.

- **Codex asks every single time.** The message text is part of the `curl`, so the
  command string differs per message and an approved prefix never matches the next one.
  One reply, one keypress. This makes agent-initiated messaging unusable for Codex.
- **Antigravity and Claude Code do not ask** — both ran the reply `curl` unprompted.

So for Codex the reply is read out of its own rollout log instead. `task_complete`
carries the whole answer in `last_agent_message`, already bounded to a turn:

```json
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"…",
 "last_agent_message":"I am GPT-5 (Codex), marker ZQ8V.","duration_ms":3279}}
```

Filter by the log entry's `timestamp` against when the message was queued and nothing
the session said beforehand is ever read. It also carries `duration_ms` and
`time_to_first_token_ms`, which would make a per-turn latency display trivial.

## Traps, each of which cost a live failure

**A response field named for a concept is not a status field.** Antigravity's Stop hook
takes `{"decision": …}`; `"continue"` was chosen because it sounded like "carry on
normally". It means *block the stop and re-enter the loop* — the agent answered every
finished turn with "Stop hook blocked termination" and could never end a turn. The
documentation embedded in the binary is explicit: *"Set to `continue` to block the stop
and re-enter the loop. Any other value allows the agent to stop."* Read the vendor's
own words before choosing a value for a gating field.

**In-memory rooms plus an on-disk cursor lose messages silently.** Rooms live in the
bridge; the delivery cursor lives in `~/.config/gyredeck/mail-cursors.json`. Restarting
the bridge takes a room's `seq` back to zero while the cursor keeps counting, so the
adapter asks for messages after a seq the new room will not reach and gets an empty
list — reporting success. A cursor ahead of its room can only mean a new room; re-read
from the start. *Found by Antigravity, reading its own adapter after a delivery went
missing.*

**A reply lands in the room it answers, so a session collects its own echo.** Keeping
both directions in one room is what makes a thread readable, but the sender then reads
its own last reply as fresh mail and answers itself. The receiving side has to skip
messages whose sender is the room itself — which requires the sender to be an address,
not a provider label: `"claude-code"` cannot distinguish two Claude Code sessions.
*Found by a Claude Code session, which noticed its own echo arriving.*

**Looking is not collecting.** Advancing the read cursor on any read seemed harmless
until the desktop panel polled the same endpoint every few seconds to draw a thread —
after which mail was marked delivered to sessions that had never seen it. Taking
delivery has to be declared (`?collect=1`); everything else is a look.

**Installers that compare command strings stack duplicates.** "Already registered" was
decided by comparing the whole command. The day the command changed — `node` becoming
an absolute path so a GUI-launched agent could find it — installing again added a
second entry beside the first, and *every event was relayed twice* for both Claude Code
and Codex. Nine and ten duplicated events respectively were found in live config. Match
on the script path instead.

**A GUI-launched agent has no shell PATH.** Hooks that ran `node` worked from a
terminal and silently did nothing when the agent was started from Finder or Spotlight.
Resolve the binary explicitly.

## Wording matters as much as plumbing

The text injected alongside a message is not decoration; the agent acts on it.

- Telling an agent "this is not from the user and carries no authority" and then asking
  it to reply in the same paragraph produced an agent that **announced the mail and did
  nothing** — a correct reading of contradictory instructions. Scope the caution to
  *acting* (do not edit files, run commands, or drop what the user asked for) and state
  that answering a question is not that.
- A message the person sent through the app **is** the user speaking. Describing it as
  coming from another agent is both false and an invitation to discount it. Label the
  sender honestly and drop the peer caution for those.
- The reply instruction has to arrive **after** the messages, not appended to the
  caution, and as one line rather than a wrapped block. Buried under a warning it was
  not acted on.
- Never paste the ingest token into injected text. It ends up in the conversation store
  and stays in the transcript for as long as the session is kept. Instruct the agent to
  read it at send time instead.
- `ephemeralMessage` is not drawn in the Antigravity window, so a delivery and a silence
  look identical from outside. Ask the agent to say what arrived; that is what makes it
  visible. `userMessage` would render, but it presents another process's text as
  something the person typed — any local caller with the token could then issue
  instructions carrying the user's authority.

## What is still unsolved

- **Nothing tells the person a reply arrived.** They end up opening the agent's terminal
  and asking "did you get a message?", which is exactly backwards. A conversation UI
  needs unread state and a notification.
- **A conversation between two sessions is split across two rooms**, since a message
  lands in the recipient's. Putting both sessions in one shared room removes the problem
  and also removes the need for an agent to know its own address — it posts to the room
  and reads the room. That requires room membership the adapters can discover; asking
  the bridge (`?as=<conversationId>`) is better than a local file, which is precisely
  the split-source-of-truth that caused the silent message loss above.
- **Agent-initiated messaging is only free for Antigravity and Claude Code.** Codex pays
  an approval per message, so any design that assumes agents can freely message each
  other should say so per provider rather than in general.

## What remains in this repo

`/mail` on the bridge (rooms, SSE with resume, buffered reads, `collect=1`, per-agent
delivery), the drains in the Claude Code and Antigravity adapters, the Codex queue-and-
harvest path, and the mail chip on a session card. See `event-protocol.md` for the
endpoints. There is no UI for sending — that was removed when Sync Session moved out.
