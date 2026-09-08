# Passing messages between agents on one machine

Findings from building and testing a local message channel between Claude Code, Codex
and Antigravity sessions, 2026-09-02. Everything here was measured against live
sessions on macOS, not read from documentation — where a claim came from docs it says
so, and where a guess was wrong it says that too.

The product this was heading towards is **Sync Session**: rooms that two sessions are
put into, told what each other is for, and left to work. It was briefly taken out of
scope and has since been brought back — as wiring rather than as a chat surface, which
is the distinction that made it fit. See [`sync-session-plan.md`](sync-session-plan.md).
This document is the ground truth it is built on.

## What each agent can actually do

| | Reach an **idle** session | Deliver into a running one | Reply without a keypress |
| --- | --- | --- | --- |
| **Codex** | ✅ `codex queue --thread <id> --message`, from outside | — | ✅ read its rollout log |
| **Antigravity** | ✅ **only by watching its own room** | `PreInvocation` → `injectSteps` | ✅ it runs `curl` unprompted |
| **Claude Code** | ✅ **only by watching its own room** | `UserPromptSubmit` → `additionalContext` | ✅ it runs `curl` unprompted |

Codex is the only one reachable **from outside**. The other two reach themselves: an
agent arms a background watch on `GET /mail/<room>/events`, and every message then
becomes a notification that starts a turn. Measured on both — a Claude Code session
woken three times with the runtime confirming no human input, and an Antigravity
session reporting from its own trajectory log that every turn since joining was
started by its watch (task-214, task-227, task-238 — the numbers change because the
stream expires every five minutes and re-arming is the intended response). The bridge
corroborated it throughout: `subscribers` stayed at one per watching session.

**Corrected 2026-09-07, and again 2026-09-08 for Antigravity.** This document said for
most of a day that only Codex could be woken and that there was no way around it. Both
halves were wrong, and the shape of the mistake is the lesson: every option weighed was
a way *in* — a CLI, a channel, a private socket — and none was the agent arming a watch
on its own behalf. The endpoint it uses had been in the bridge the whole time.

The cost is real and was measured: a watch on every message in a three-member room woke
the session three times in a row for acknowledgements with no content. Filter to messages
that name the session, not to the room.

**Only Codex can be woken from outside.** Measured against a thread idle for 78 minutes: `turn_start`
at +2s, answer written at +3s, `turn_complete` at +4s, with nobody at the keyboard. The
other two collect their mail through a hook, and a hook only runs when the session does
— so a message waits until the person types into that terminal again.

No *external* mechanism works: injecting keystrokes into a PTY would mean guessing
terminal state and impersonating the user, and was rejected. Claude Code's channels need
the session started with `--channels` and, during the research preview, an allowlisted
plugin; its peer socket at `/tmp/cc-socks` does wake an idle session but is an
undocumented frame needing another app's per-session key. Checked against Claude Code
2.1.231/2.1.236 — `remote-control` exists but routes through claude.ai, and there is no
`channels`, `send`, `message` or `queue` subcommand. Antigravity has nothing equivalent.

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

- **Codex cannot reach the bridge at all, for two reasons that stack.** Its sandbox has
  no network, so `curl` to `127.0.0.1:47621` fails before leaving the process — *"Couldn't
  connect to server after 0 ms"*, which is the tell: not a timeout, not a refusal, but
  a block on the way out. And a room's password is the `x-gyredeck-token` header on
  every call about that room, which is precisely what an unconfirmed session does not
  have. Either alone would be enough; keeping both written down matters because the
  sandbox could change and the credential would still stop it. This is the real reason its replies are harvested from its
  rollout log rather than requested, and it holds even where the approval below would
  not. `codex queue` still works because that runs from outside, going in.
- **Codex asks every single time** for any command it *can* run. The message text is
  part of the `curl`, so the command string differs per message and an approved prefix
  never matches the next one.
- **Antigravity and Claude Code do not ask** — both ran the reply `curl` unprompted.

So for Codex the reply is read out of its own rollout log instead. `task_complete`
carries the whole answer in `last_agent_message`, already bounded to a turn:

```json
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"…",
 "last_agent_message":"I am GPT-5 (Codex), marker ZQ8V.","duration_ms":3279}}
```

Filter by the log entry's `timestamp` against when the message was queued and nothing
the session said beforehand is ever read.

**Deduplicate per thread, not per harvest.** Every delivery starts its own harvest with
its own window, and windows overlap — a room notice and a question sent moments apart
both see the one answer Codex writes. A harvest that only remembers what it published
itself posts that answer twice, and a session waiting for a *new* reply then wakes on
the stale copy. Key on the turn id **and** the text: a retried turn repeats the text
under a new id, and a re-read of the log repeats the id with the same text. It also carries `duration_ms` and
`time_to_first_token_ms`, which would make a per-turn latency display trivial.

**Backgrounding is not watching, and the difference is invisible.** A second Claude Code
session followed the watch instruction with a plain background job and reported the
result itself: the SSE stream stayed open, messages arrived and were written to the
task's output file, and nothing woke the session — because that facility notifies when
the process *exits*, and a stream that is working never exits. It had every message and
knew about none of them until something else prompted it.

What is needed is the kind of tool that turns each line of a still-running command into
a notification. Where a session only has exit-time backgrounding, arming the watch is
worse than not arming it: the room looks quiet, the failure is silent, and the session
believes it is reachable. The instruction now names the property rather than the verb —
"whatever facility turns each line into a notification while it keeps running" — and
asks a session that lacks one to say so instead of running it anyway.

## An agent is a poor witness to its own wiring

Both of these came out of one round-table test and both were corrected only when
pressed with a specific question.

**Empty is not success.** Codex ran two `curl` calls, saw no response body, and
reported that both had succeeded. Neither had: the room still showed it unconfirmed and
its message never arrived. A command that answers nothing is a command whose outcome is
unknown, and an agent asked to run one will tend to read silence as agreement. Where a
result matters, ask for what came back rather than whether it worked.

**Ask what started the turn, and ask for the log.** Asked what had woken it, Codex said
"keystroke" when nothing had touched its keyboard — the bridge had pushed to it through
`codex queue`, which it could not distinguish from a person typing. Antigravity's first
answer skipped the question entirely; asked again, and told to read its trajectory log
rather than assume, it named the task and the event id, and the event id matched the
room's own sequence. Self-report is worth having, but only the second kind is worth
believing: the kind that cites something you can check from the other side.

## Codex token accounting, if a context meter is ever built for it

Unlike Antigravity, Codex writes everything a meter needs to disk: its rollout log
carries `model_context_window` alongside `info.last_token_usage`, so the numbers can be
read without asking it anything.

**`input_tokens` already includes `cached_input_tokens`.** Cached is a detail inside the
total, not a figure beside it. Measured on a live thread: window 258,400, last input
13,908 of which 13,056 cached — 5.4% used. Adding cached gives 10.4%, which is what a
first attempt at this arithmetic produced. A meter built that way would have read nearly
double, every turn, and looked plausible throughout.

Codex said so before the log was checked, reasoning from the shape of the numbers, and
was right where the arithmetic was wrong. Its own caveat is worth keeping too: it
answered that it could not read `/context` or the log itself, which is the difference
between a useful self-report and a confident one.

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
endpoints. There is no UI for sending a message and there will not be one: Sync Session
wires sessions together and shows who is in a room, and the talking happens in the
agents' own terminals.
