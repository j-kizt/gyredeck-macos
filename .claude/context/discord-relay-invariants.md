# #199 Discord relay: invariant table v2 (option B, a disk journal in Rust)

Written 2026-10-27 by Gyre Worker (subagent, Claude Opus 5.5). This is design only: no source was changed and no git write was run. The tree is `feat/199-discord-follow` at HEAD `5fa75a0`, read from the checkout. Every `file:line` below is at `5fa75a0`. Short names: `rs` = `apps/desktop/src-tauri/src/discord.rs`, `cn` = `adapters/discord/connector.mjs`, `dj` = `adapters/discord/discord-js.mjs`, `st` = `adapters/discord/state.mjs`, `br` = `adapters/bridge/gyredeck-bridge.mjs`, `sb` = `apps/desktop/src-tauri/src/standalone_bridge.rs`.

**Inputs:** v1 (`199-invariants.md`, written at 5b00f72), Codex r7 (`199-r7.md`, 5 findings), Codex's option-B checklist (`199-B-checklist.md`, 14 items; mapped in §8b), Codex's audit-only repros (`/private/tmp/gyre-199-r7-audit.bVg4ri/tests/_audit199.test.mjs`, plus 2 tests prepended to its `src/discord/tests.rs`), and `knowledge/lessons.md` (the #230 writer class, "one helper per class", neuter every test).

**I21 at 5fa75a0** (`rs:10-16`, `ToChild::End` `rs:151-153`, `cn:569-600`). When the app quits, or Remove stops the relay, while Discord has not taken some lines, those lines are not held past that end. The post says so once, before its close: "N messages not relayed: #41–#43 from Codex, Gyre Assistant". When the child cannot post that line, Remove's `dropped`/`dropped_lines` status carries the same seqs and senders (`rs:964-968`). The count comes from what Rust holds (unacked + draining). Lines the bridge still held unread for the relay are not counted. Codex finding 4 breaks it: at quit with Discord offline, no line gets posted and nothing durable is left behind.

---

## 0. Where the approved direction had to change, and why

| # | Approved | Changed to | Why the code forces it |
|---|---|---|---|
| C1 | fsync before any relay-ack | **write(2) before the line can be handed to the child. F_FULLFSYNC before any relay-ack *and before every events-open*.** | The events-open moves the relay floor too: `since` → `markRead` (`br:7897-7900`, `rs:1425-1426`), not only `relay-ack` (`rs:1478-1487`). A process crash loses nothing that write(2) has returned. Only power loss or a kernel panic needs the sync, so the sync can be batched without widening the process-crash window. |
| C2 | At quit, `undelivered` + bridge-unread go into a `loss` record | **`loss` = bridge-unread only (`roster.seq − last_seq`), plus any line the journal failed to write.** `undelivered` stays as `line` records and is delivered at the next launch. | Writing the held lines as loss and also replaying them would count them twice: the post would say "not relayed" and then show them. The bridge already returns `seq` in `/sync/rooms` (`describeRoom` `br:4416-4418`), so this needs no bridge change. Only `Roster` must parse it (`rs:1816-1819`). |
| C3 | Quit keeps I21's "N not relayed" path | **Quit no longer sends `End`.** Remove still does, and Remove deletes the journals after its drain. | After quit the lines are not lost; they are late. After Remove there is no token left to deliver them later, so the I21 "not relayed" path stays the right end for Remove. |
| C4 | Close intent + read-back of a *marked* closing line | **One `postOnce` helper for every post (line part, divider, closing line, loss line, rejected-line stand-in).** The intent `pending` is saved before the post. Read-back looks at messages *after the last confirmed message id* (`lastMsgId`) and compares webhook author + exact content. **No visible marker is needed.** | The same one-post window exists at 5 sites (`cn:463-466`, `:520-526`, `:554-566`, `:579-586`, `:616-623`). Fixing only the close repeats the #230 lesson (one site per round). A marker on "Room closed" does not tell close #1 from close #2 of the same instance; scoping by `lastMsgId` does. |
| C5 | `resume{lastAcked}` narrows the child's dedupe | **`resume{lastAcked, lastMsgId}`, used as the read-back anchor after a lost child state.** | Rust already never re-hands an acked line (`rs:496-498`), so `lastAcked` alone dedupes nothing. Codex's P3 repro has the ACK emitted but *not* applied, so `lastAcked` = 0. The window is the lines after the anchor, and only a Discord message id lets the child read exactly that window back. `posted` therefore carries `msgId` (the last part's id), and Rust journals it. |
| C6 | Journal per instance with records line/ack/close/loss | **Add `open{members}` (the header) and `closeack{id}`. A close carries a Rust-minted random `id`.** The file exists from Connect until its last close is acked. | A file that holds only unacked lines is deleted whenever the room is caught up. A crash then leaves the post open with no record, which loses I12 across a crash. Two closes of one instance (Disconnect, Connect, Disconnect) need distinct ids for `closed` to clear the right one. Today `closed` matches "the first close_pending of that instance" (`rs:523`). |
| C7 | Reason "app ended" on launch | **The reason is the one journalled in `close`. `Ended` is used only for the open tail of a journal that has no close** (crash). | A quit already journals `close{reason: closed}` (`shutdown` → `disconnect(Closed)`, `rs:822-824`). |
| C8 | Memory window, rest on disk | **Within one app life, the per-code budget is the window, so nothing is ever evicted to disk. At launch, journals load oldest-first up to a global window; the rest stay parked on disk until the window drains.** | Within one life, budget backpressure means nothing past the budget is ever read, so there is no "rest" to evict. A rest exists only at launch (many journals). |
| C9 | (not in the direction) | **A close or post to a thread that no longer exists finishes as closed** (`closedAt` saved, `closed` sent). | At 5fa75a0 a `missing` on a close falls through to "retry forever" (`cn:356-383`: `missing` is handled only for `send`/`open`). With durable closes, one deleted thread would wedge that code's queue on every launch. |

---

## 1. Identities and holders

| Thing | Identity | Minted by | Carried |
|---|---|---|---|
| Room instance | `code` + `createdAt` | bridge `mailRoomFor` `br:4023-4074` | roster `rs:1818` → `Connect.created_at` `rs:148` → child `w.createdAt` `cn:684` → post marker `cn:64-66` → **journal file name `<code>@<createdAt>.jsonl`** |
| Line | (`code`,`createdAt`,`seq`) | bridge `room.seq += 1` `br:5156` | `Message.seq` `rs:149` → `posted{room,seq,createdAt,`**`msgId`**`}` → **`line`/`ack` records** |
| Loss notice | synthetic `seq` inside a gap (never carried by a real line) | Rust | as a line; **`line{kind:"notice"}` record** |
| Part | (`seq`,`k`) | child `splitContent` `cn:23-38` | **`pending{seq,k,delayed}` + `lastMsgId` in state** |
| Discord message | snowflake | Discord | **`sendWebhook` returns it (today discarded, `dj:246`)** |
| Close | **(`code`,`createdAt`,`id`)**, `id` = 64-bit random from Rust | Rust `Hub::disconnect` | `Disconnect{room,reason,`**`id`**`}` → child state `closing{id,reason}` → `closed{room,createdAt,id}` → **`close`/`closeack` records** |
| Child epoch | `Hub.epoch` `rs:355`, +1 per spawn `rs:1195-1199` | supervisor | stdout reader `rs:1309` |
| Bridge generation | `sb:34-37,833` | Rust | `RoomReader.generation` `rs:1417` |

| Holder | What | Lifetime | Durable |
|---|---|---|---|
| Bridge | `room.messages`, `readSeq`, `relayFrom`, `droppedThroughSeq` | ≤ app, for the bridge the app spawns (`sb:847` `--parent-stdio`; stdin end = stop `br:8117`) | no |
| Rust Hub | in-memory window of every journal: feeds, batches, outbox cursors | app | no |
| **Rust journal** | `~/.config/gyredeck/discord-journal/<code>@<createdAt>.jsonl` | **from Connect until the instance's last `closeack` is synced, across launches** | **process crash: yes once write(2) returns. Power loss: yes once synced.** |
| Child | queue, in-flight item | one child | no |
| Child state | `rooms[code] = {threadId, lastSeq, `**`lastMsgId, pending, closing`**`, closedAt, …}` | disk, `st:57-85` | yes |
| Discord | posts and messages | 30 d after `closedAt` | yes |

**Lifetimes, re-derived.** Before: bridge ⊆ app ⊇ child. Now it is **bridge ⊆ app ⊆ journal ⊇ child state**. A line now outlives the app as soon as its record is written. The bridge still dies with the app, so S0–S1 lines (published but never read by Rust) cannot be held past the app. They can only be *counted* (`loss`, C2). One unverified point: `port_available_for_bridge` accepts a Gyredeck bridge that is already listening (`sb:653-661`). I did not check whether the app then reads a bridge it did not spawn. If it does, that bridge can outlive the app. The sync → relay-ack order (I1) is what keeps that case safe, which is why C1 keeps it.

---

## 2. State machine

### 2.1 Per line

| # | State | Where | Durable | Entered by |
|---|---|---|---|---|
| S0 | published | bridge | no | `br:5156` |
| S1 | streamed | socket | no | `br:7910-7925` |
| **S2j** | **journalled**: `line` written (write(2) returned) and in the Hub window | Rust + file | process crash ✓, power ✗ | `Hub::forward` |
| **S2s** | **synced**: covered by the last F_FULLFSYNC | file | ✓ | `Journal::sync` (batch) |
| S3 | handed: the writer pulled it and wrote it to the pipe | pipe | no | stdin writer pull |
| S4 | queued in child | child | no | `cn:689-707` |
| **S5i** | **intent**: `pending{seq,k,delayed}` saved | state | ✓ | `postOnce` |
| S5 | part k accepted, `lastMsgId` not yet saved | Discord | half | webhook 2xx |
| S6 | part k durable (`lastPart`, `lastMsgId`) | state | ✓ | save |
| S7 | `lastSeq` durable | state | ✓ | `cn:561-565` |
| S8 | `posted{…,msgId}` on stdout | pipe | no | `cn:566` |
| **S9j** | **`ack{seq,msg}` written**; popped from the window | Rust + file | ✓ (process) | `Hub::ack` |
| S10 | relay-acked (bridge floor ≥ seq) | bridge | no | `flush_ack`, **after S2s** |
| S11 | trimmed | — | — | `br:1362-1378` |
| **L** | **counted lost**: `loss{n,label}` record, not yet said | file | ✓ | quit / journal-write failure / dropped prefix |

### 2.2 Per close

| # | State | Where | Entered by |
|---|---|---|---|
| C0 | **`close{id,reason}` written** | journal | `Hub::disconnect` |
| C1 | handed (`disconnect{id}`) | pipe | writer |
| **C2** | **intent saved**: `closing{id,reason}` + `pending{kind:"close"}` | state | `closePost` |
| C3 | closing line accepted, `lastMsgId` unsaved | Discord | webhook 2xx |
| C4 | archived | Discord | `editThread` |
| C5 | `closedAt` saved, `closing` cleared | state | save |
| C6 | `closed{room,createdAt,id}` sent | pipe | `done()` |
| **C7** | **`closeack{id}` written** | journal | `Hub::closed` |
| **C8** | **journal deleted** (when every line is acked, every close is acked, and no loss is pending) | dir | `Journal::finish` |

---

## 3. Transitions and preconditions

| From → To | Precondition | Site to change |
|---|---|---|
| S1 → S2j | Room budget not exceeded (I14). `line` record write(2) returned **before** the line is in the window. **A write error means the line is not taken in:** the reader stops (backpressure), and status shows `journal_blocked`. | `Hub::forward` `rs:428-461` |
| S2j → S2s | Batched: at most `ACK_EVERY` (2 s) per instance, plus at disconnect and at quit | new `Journal::sync` |
| S2s → S10 | **relay-ack(seq) requires sync ≥ seq. events-open(since) requires sync ≥ since.** | `flush_ack` `rs:1478-1487`; `RoomReader::run` before `open` `rs:1425-1426` |
| S2j → S3 | Writer pulls in outbox order. Never more than one line is resolved out of the Hub at a time. | replaces `ChildChannel` queue `rs:161-214` |
| S4 → S5i → S5 | `settle()` passed; `pending` saved with the current `lastMsgId` | `cn:552-559` via `postOnce` |
| S5 → S6 | save `lastPart`, `lastMsgId = id`, then `pending` for k+1 (one save) | `postOnce` |
| recovery at S5i | `pending` set → `fetchMessages(thread, after=lastMsgId)` → a webhook message with the same content and username = accepted (take its id). Otherwise post. **Read-back error → retry the read-back; never post blind.** If the read-back is refused for permission (403) → post once and say `readback_unavailable` (I9 bound b). | `postOnce` |
| S7 → S8 | as v1 (ACK after save) | `cn:565-566` |
| S8 → S9j | epoch current; instance matches; `ack` record written; window popped | `Hub::ack` `rs:489-512` |
| — → C0 | `close` record written **before** `disconnect` goes into the outbox | `Hub::disconnect` `rs:463-484` |
| C1 → C2 | if `rs.closedAt` is set and `closing` is empty → straight to C6 (already closed) | `closePost` `cn:602-625` |
| C2 → C3 | `postOnce(kind:"close")` | `closePost` |
| C3 → C4 → C5 | `editThread`. `missing` → thread gone → go to C5 (C9). | `closePost`, `attempt` `cn:356-368` |
| C5 → C6 → C7 | `closed` carries `id`. Rust: epoch current, the instance and the id match a pending close. | `Hub::closed` `rs:516-530` |
| C7 → C8 | `closeack` written **and synced**, then unlinkat, then fsync the dir. A file that comes back after a power loss proves itself done when replayed (every line is acked, the close is acked), so replaying it does nothing. | `Journal::finish` |
| quit | readers stop → for each room: `roster.seq − last_seq` → `loss{n,"unread when Gyredeck quit"}` → `close{id,closed}` → **sync all** → `wait_drained(QUIT_DRAIN)` → stop the child. **No `End`.** | `shutdown` `rs:817-829` |
| launch | scan the dir → parse each file (§7.1) → load as draining batches, up to the window → the outbox hands them oldest-first: `connect{…,resume}`, lines, `loss`, `disconnect{id}` | `DiscordState::with`/`start` `rs:743-770`, `Hub::attach` `rs:377-411` |
| compaction | the file is over `2 × budget_bytes` and over half of its records are acked → write header + open lines + pending closes + loss to a temp, sync it, renameat over the file, fsync the dir (§7.1) | `Journal::compact` |

---

## 4. Disturbances

d1–d17 are as in v1 §4, with these changes. **d2** (quit): the required outcome is now "every held line is in the journal and synced, the unread count is a `loss` record, and the next launch delivers both". **d3** (app crash): "every line whose write(2) returned is delivered at the next launch; the close is said with reason `Ended`". **d16**: no queue to overflow; replay runs at the pipe's pace.

| Id | Disturbance | Required outcome |
|---|---|---|
| **d18** | quit while Discord is offline | Lines, closes and unread counts are all durable before the child is stopped. The next launch with Discord up posts the lines (labelled delayed), says one loss line, and closes each post once. Nothing is counted twice: held lines are not in `loss`. **A loss record that the journal refuses** is retried 3 times, then written to `<code>@<createdAt>.loss` and merged into the journal at the next launch, before its close. **Limit:** if both the journal and the fallback are refused (a disk that refuses every write), the loss count is lost at exit; while the app runs it shows `journal_blocked`. |
| **d19** | Disconnect/Connect repeated while Discord is down | In memory, live + draining for a code stays ≤ budget. A Connect while over budget is accepted but its reader starts paused (no open, so the bridge floor holds and publishers get the bridge's 409). Disk use is ≤ budget per code. |
| **d20** | corrupt or truncated journal, or corrupt child state | A truncated **last** line is ignored, and every earlier record stands. Any other malformation makes that journal **refused**: the file is left untouched, the error is shown, the instance is not replayed, and other journals are unaffected. Corrupt child state: `st` sets it aside (as today). The child is told `resume{lastAcked,lastMsgId}` and reads back after the anchor (I9b). |
| **d21** | symlink or hardlink planted at a journal path, the temp path, or the directory | No write ever reaches the target. A planted dir or file is refused and shown. The target's bytes are unchanged. |
| **d22** | the post's thread was deleted by a person while lines or a close are pending | Lines: a new post (`needsPost`, as today `cn:356-359`). Close: finished as closed (C9). Nothing wedges. |
| **d23** | crash between the `pending` save and the post, or between the post and the `lastMsgId` save | Read-back decides. The duplicate bound is I9. |
| **d24** | power loss during compaction or delete | The old file, or the new one, is complete. A temp left behind is removed at launch. |
| **d25** | journal disk full / EIO | The reader stops taking lines in (backpressure); `journal_blocked` is shown; held lines keep flowing to Discord. |
| **d26** | journals from many launches and many codes | The window holds at most `LAUNCH_WINDOW` lines in memory; the rest stay parked on disk; all are drained in order. |

---

## 5. Invariants

K = kept, Ch = changed, N = new.

| # | | Invariant, with the exact strength |
|---|---|---|
| I1 | Ch | *Trim floor.* The bridge may trim a seq only once (a) Discord accepted it, or (b) its `line` record is **synced** in the journal. Rust never tells the bridge a position (relay-ack or events-open `since`) beyond its last journal sync. |
| I2 | K | *Identity.* A line is (`code`,`createdAt`,`seq`). An ACK, close or loss applies only to its own instance's journal and feeds. |
| I3 | Ch | *Hold until ACK, across launches.* Every forwarded seq stays in the journal until a matching ACK is written. A new child (in this life, or at the next launch) is handed every unacked line, oldest batch first. **Strength:** a process crash loses nothing that write(2) returned. A power loss loses at most the lines forwarded since the last sync (≤ 2 s per instance), and those are lines the bridge was never told about. |
| I4 | Ch | *Forward once, in order; every gap said.* A seq is forwarded at most once per instance, increasing. On each open the feed learns its floor `max(since, relayFrom)` from `event: dropped`. Then it says: "N went by unfollowed" for a resume gap below `relayFrom`; "N lines the room dropped" for `droppedThroughSeq > floor`; and "N went by unfollowed" for any jump after that. **Nothing at or below `relayFrom` on the first join is ever said** (pre-join history). |
| I5 | K | Reopen from the last seq journalled, never from the bridge's write cursor. (`since` ≤ the sync watermark, I1.) |
| I6 | Ch | Per code FIFO; the head never leaves on failure. **Exception, by rule: a close or post to a thread that is gone finishes (C9).** |
| I7 | K | A child dedupes by durable `lastSeq` of the same instance. |
| I8 | Ch | Part k+1 is not sent until part k's acceptance **and its message id** are durable. `pending` is durable before every post. |
| I9 | Ch | *Duplicate bound.* **(a) Intact state, read-back possible:** a post is repeated only if Discord accepted it after the read-back looked (a request that outlived its timeout). **(b) Read-back unavailable** (403 or permission): at most **one post (one part or one closing line) per recovery** per room, and said (`readback_unavailable`). **(c) Child state lost or corrupt:** the read-back is anchored at Rust's journalled `lastMsgId`. The bound is (a) over the lines after that anchor when read-back works. **When read-back is also unavailable, it is one repeat per line**: every line posted after the anchor whose ACK Rust had not applied may repeat once, so the bound is per line and not per recovery. This was corrected 2026-10-27 after the deep audit; T9 asserts m1 ×2 and m2 ×2. **Precondition: the Rust journal for that instance is intact.** If both the state and the journal are corrupt, the bound is the instance's whole unacked window, and that is said (`journal_corrupt`). Read-back covers up to 5 pages × 100 messages after the anchor. A longer tail falls back to (b). |
| I10 | K | One post per instance (marker adoption). **Added:** a recovery batch with no post known, none found, and no lines creates no post; its close is acked at once. |
| I11 | K | Epoch: a stale child changes nothing, journal included. |
| I12 | Ch | *Close durable until done.* Every close has a `close{id}` record from the moment it is decided until `closeack{id}`. It is replayed to every child until acked, across launches. Its closing line is posted **at most once under I9(a), at most once per recovery under I9(b)**, and `closedAt` becomes durable. **Not "exactly once":** the webhook has no idempotency key (`dj:242-252`). |
| I13 | K | Nothing silent: `behind`, `dropped`, `leaving`, `error`. **Added:** `journal_blocked`, `journal_corrupt` (names the file), `readback_unavailable`, and `held` (lines parked from earlier launches). |
| I14 | Ch | *One budget per code.* `live.unacked + Σ draining.unacked ≤ cap` (lines) and `≤ cap_bytes`. Over it: the reader does not read, and a Connect starts paused. No stage drops a line to make room. Memory per code ≤ the budget. At launch, loaded journals ≤ `LAUNCH_WINDOW`; the rest stay on disk. |
| I15 | Ch | *Lifetimes.* bridge ⊆ app ⊆ journal. A generation change is Closed for every followed room. **S0–S1 at the app's end are counted (`loss`), never held.** |
| I16 | K | Disconnect keeps: unacked lines move to draining with their close. A second Disconnect appends. **Plus a journal `close{id}`.** |
| I17 | K | Instance switch in the child keeps both records. |
| I18 | Ch | *Pull, not push.* Rust → child is pulled by the stdin writer at the pipe's pace. No line is ever copied into a queue. The outbox holds references (≤ 2 + 2 × batches entries). "Stuck" = a write blocked past `CHILD_STUCK`. |
| I19 | K | No forum ≠ no room (`cn:360-368`, `rs:910-931`). |
| I20 | Ch | *Notices are lines, and a prefix loss is said.* Every line the relay was owed reaches Discord or is said as a count with a truthful label, **including the prefix the bridge dropped before the first frame** (`event: dropped`, I4). |
| I21 | Ch | *What will not be delivered is said, durably.* **Quit:** held lines are *not* lost (I3). Lines the bridge held unread (`roster.seq − last_seq`) and lines the journal failed to write become a `loss{n,label}` record before the child is stopped (journal, after up to 3 tries; else the `.loss` fallback file). It is not durable when the disk refuses both (see d18). The next launch posts one loss line per batch before its close. **Remove:** as at 5fa75a0 (`End` → "N not relayed", or `dropped` status); then the journals are deleted. A `loss` record leaves the journal only after its line is acked (`posted` for the loss's synthetic seq). |

---

## 6. Codex r7 findings, closed

| # | Finding | Closed by | Sequence that broke it → now |
|---|---|---|---|
| 1 | P1: closing line twice | I12, I9, I8 | **Before:** "Room closed" accepted → `editThread` network error → child restart → `item.said` gone → posted again (`cn:616-623`). **Now:** `closing{id}` + `pending{close}` saved (C2) → post accepted, id unsaved → restart → `pending` set → `fetchMessages(after=lastMsgId)` finds the webhook "Room closed" → no post → archive → `closedAt` → `closed{id}` → `closeack`. One line. |
| 2 | P2: dropped prefix silent | I20, I4 | **Before:** 133 notices, relay at 0 → `droppedThroughSeq` = 5 → first frame seq 6 → `last_seq == 0` so nothing is said (`rs:443`). **Now:** the stream opens with `event: dropped {droppedThroughSeq:5, relayFrom:0}` → floor 0 → notice "5 lines the room dropped" at seq 1 → seq 6. With `relayFrom` = 5 (joined later): floor 5, dropped = 5 ≤ floor, so nothing is said. |
| 3 | P2: cycles evade the cap | I14, I18 | **Before:** cap 3, 4 cycles → 12 held (`rs:463-483`, `rs:1525`), attach clones all of them into a `Vec` → unbounded channel (`rs:389-404`, `rs:176`). **Now:** the 2nd Connect finds owed(code) = 3 ≥ cap → the reader starts paused → nothing is read → held ≤ 3. Attach pushes references only. |
| 4 | P2: offline quit loses the loss line | I21, I3, I15 | **Before:** quit → `QUIT_DRAIN` → `End` → kill at 2 s with Discord offline → no line posted, nothing durable (`rs:817-828`, `rs:1229-1237`). **Now:** quit → `loss{unread}` + `close` → sync → kill. Next launch → lines posted (delayed), "N lines were unread when Gyredeck quit", then "Room closed". |
| 5 | P3: corrupt state doubles a line | I9(c) | **Before:** seq 1 posted, ACK not applied, state `{` → set aside → seq 1 posted again. **Now:** Rust's journal has no `ack` for 1, but it has `msg` = the starter id (or the last acked id) → `resume{lastAcked:0,lastMsgId}` → the child reads back after the anchor → finds seq 1's part → acks without posting. Holds while the Rust journal is intact (precondition). |

---

## 7. Build spec

### 7.1 Rust: new `apps/desktop/src-tauri/src/discord/journal.rs`

**Records** (one JSON object per line, `\n`-terminated):

```
{"t":"open","code","createdAt","members":[…],"v":1}         first record, always
{"t":"line","seq","sender","to","kind","text","ts"}          seq strictly increasing in the file
{"t":"ack","seq","msg"}                                      watermark; msg = Discord id of the last part (nullable)
{"t":"close","id","reason":"closed|disconnected|ended","at":<last_seq>}
{"t":"closeack","id"}
{"t":"loss","seq","n","label"}                               seq = a synthetic seq for the loss line
```

**Parser `load(bytes) -> Result<Recovered, Corrupt>`:** split on `\n`. If the last chunk has no `\n`, it is a torn tail and is ignored. Every complete line must parse and pass the rules below, or the result is `Corrupt{line_no, why}`.

- `open` comes first, and only once, and its code and createdAt match the file name.
- `line.seq` is strictly increasing.
- `ack.seq` may be any value; the watermark is the max.
- `close.id` is unique.
- `closeack.id` must name an earlier `close`.
- A `line` identical to an earlier one is a duplicate and is ignored. A `line` with the same seq but different text is corrupt.

Rebuilding from the file: the batches are the lines, split at each `close` in file order. Each `close` keeps its batch. The tail after the last close, when there is one, becomes a batch with reason `Ended`. Acked lines, acked closes and acked losses are dropped.

**Writers, every one with exact flags:**

| Writer | Call | Flags | Checks after open |
|---|---|---|---|
| journal dir | `mkdir(dir, 0700)`, then `open(dir)` | `O_RDONLY\|O_DIRECTORY\|O_NOFOLLOW\|O_CLOEXEC` | fstat: a directory, uid = geteuid, `mode & 0o077 == 0`. Otherwise refuse (`journal_blocked`, "not a private directory"). The dir fd is held for the app's life. |
| new instance file | `openat(dirfd, "<code>@<createdAt>.jsonl", …, 0600)` | `O_WRONLY\|O_APPEND\|O_CREAT\|O_EXCL\|O_NOFOLLOW\|O_CLOEXEC` | fstat: regular file, `nlink == 1`, uid. `EEXIST` → refuse (only a planted file can exist: our own fd stays open for the instance's whole life). |
| recovered file | `openat(dirfd, name, …)` | `O_RDWR\|O_APPEND\|O_NOFOLLOW\|O_CLOEXEC` (no `O_CREAT`) | as above, **`nlink == 1`** (a planted hardlink); reads go through the same fd |
| compaction temp | `openat(dirfd, "<name>.<16 hex>.tmp", …, 0600)` | `O_WRONLY\|O_CREAT\|O_EXCL\|O_NOFOLLOW\|O_CLOEXEC` | write all → `fcntl(F_FULLFSYNC)` → `renameat(dirfd,tmp,dirfd,name)` → `fsync(dirfd)` → swap the fd to the temp's fd. On error: `unlinkat` the temp only if this call created it. |
| finish | `unlinkat(dirfd, name, 0)` → `fsync(dirfd)` | — | only after `closeack` has been written and synced |
| stale temps at launch | `unlinkat` | — | name matches `*.<16 hex>.tmp`; fstatat with `AT_SYMLINK_NOFOLLOW` shows a regular file |

There is no `O_TRUNC` anywhere, and no write through a path; every write goes through `*at` on the held dir fd. Sync is `fcntl(fd, F_FULLFSYNC)`, called explicitly. I believe std's `sync_all` already does this on Apple, but I did not re-check it here, so the spec calls it directly. The existing helpers `replace_file`/`read_no_follow` (`sb:449-480`) are path-based and are **not** reused, because they follow a symlinked parent directory.

**API:** `Journal::open_dir(path) -> Result<Dir>`, `Dir::create(code, created_at, members) -> Result<File>`, `Dir::recover() -> (Vec<Recovered>, Vec<Corrupt>)`, `File::append(&Record) -> io::Result<()>` (one `write_all` of the whole line), `File::sync()`, `File::compact(&Live)`, `File::finish()`.

### 7.2 Rust: `discord.rs`

| Change | Where at 5fa75a0 |
|---|---|
| `ToChild::Connect` + `resume: Option<Resume{last_acked:u64,last_msg_id:Option<String>}>`; `ToChild::Disconnect` + `id: String`; `DisconnectReason::Ended` (child text: "Room ended — Gyredeck stopped"); `ToChild::Message` unchanged | `rs:125-154` |
| `FromChild::Posted` + `msg_id: Option<String>`; `FromChild::Closed` + `id: Option<String>` | `rs:240-245` |
| `RoomFeed` + `journal: Arc<journal::File>`, `last_msg_id`, `close_id: Option<String>`, `handed: u64` (the cursor for the current child), `bytes: usize`; `floor: u64` (relayFrom) | `rs:306-328` |
| `Hub` + `journal_dir: Option<journal::Dir>`, `outbox: VecDeque<Out>` where `enum Out { Control(ToChild), Feed{room, created_at, batch: Option<usize>} }`, `wake: Arc<Condvar>`, `parked: Vec<journal::Recovered>` | `rs:331-365` |
| **`ChildChannel` replaced:** the writer thread loops `lock hub → Hub::next_line() → unlock → write_all → flush`, and waits on the Condvar when there is nothing. `send()` becomes `Hub::push(Out::Control)`. Stuck detection is kept (`writing_since`). The unbounded `mpsc::channel` is removed. | `rs:156-214` |
| `Hub::next_line()`: pop the outbox head; for `Feed`, find the first unacked line with seq > `handed`, serialize it, advance `handed`. When none is left, pop the entry. | new |
| `Hub::attach`: reset every `handed` to 0; outbox = `hello`, then per batch (oldest first) `Connect{resume}`/`Feed`/`Disconnect{id}`, then per live feed `Connect{resume}`/`Feed`. **No clone of the lines.** | `rs:377-411` |
| `Hub::connect`: `journal.create` (header) **before** the `Connect` push. An error → refuse the Connect (`journal_blocked`). | `rs:413-425` |
| `Hub::forward`: budget check (`owed_in(code)`); `journal.append(line)` before the push. An error → return `Err(Blocked)`, and the reader stops. The loss notices of I4 go through the same path. | `rs:428-461` |
| `Hub::on_dropped(room, dropped_through, relay_from, since)`: sets the floor, emits the I4 notices | new; called from `follow` on `event: dropped` `rs:1519-1539` |
| `Hub::disconnect`: mint `id` (`SecRandom`, 8 bytes hex), `journal.append(close)` **before** pushing `Disconnect{id}` | `rs:463-484` |
| `Hub::ack`: append `ack{seq,msg}`; store `last_msg_id`; when done → `finish()`; when over the size limit → `compact()` | `rs:489-512` |
| `Hub::closed`: match **by id**; append `closeack`; `finish()` when done | `rs:516-530` |
| `Hub::owed_in(code)` (live + every draining batch); `backlog()` is replaced by it in `wait_for_room` and `follow`'s Full check | `rs:566-568`, `rs:1496`, `rs:1525` |
| `DiscordState::connect`: when `owed_in(code) ≥ cap`, the reader is spawned straight into `wait_for_room` (paused) | `rs:996-1064`, reader `rs:1411-1463` |
| `RoomReader::run`: `journal.sync()` before `open(since)`; `flush_ack`: `sync()` before `source.ack` | `rs:1425-1426`, `rs:1478-1487` |
| `Roster` + `seq: Option<u64>` parsed from `/sync/rooms` | `rs:631-634`, `rs:1816-1819` |
| `shutdown`: as in the §3 quit row; `End` is removed from quit | `rs:817-829` |
| `stop_following` (Remove / token lost): keep `End`; after the drain, `finish()` every journal (Remove's choice, C3) | `rs:950-972` |
| `DiscordState::with`/`start`: open the dir, `recover()`, load batches up to `LAUNCH_WINDOW`, put the rest in `parked`, put `journal_corrupt` errors into status (I13) | `rs:743-770` |
| `DiscordStatus` + `held`, plus the new error codes | `rs:272-298` |

New constants: `ROOM_BUDGET_BYTES = 4 MiB`, `LAUNCH_WINDOW = 2 × UNACKED_CAP`, `JOURNAL_COMPACT_FACTOR = 2`.

### 7.3 Child

| Change | Where |
|---|---|
| `postOnce(w, rs, {kind, username, content, seq?, part?})`: save `pending` (with `lastMsgId`) → read back when `pending` was already set on entry → `sendWebhook` → `rs.lastMsgId = id; delete pending; save()`. Used by `relay`, `postInstead`, `sayLost`, `closePost`, and the reopen divider. | `cn:401-409`, `:463`, `:520`, `:554`, `:579`, `:617` |
| `relay`: save `partDelayed` in the first `pending` (so a restart cuts the same parts); `acked()` carries `msgId` | `cn:529-567`, `:150-154` |
| `closePost`: `closing{id,reason}` + `postOnce` → `editThread` → `closedAt`, `delete closing` → `closed{…,id}`. `missing` → treat as done (C9). | `cn:602-625`, `attempt` `cn:356-368` |
| `handle("connect")`: store `msg.resume`. When the instance has no record (state set aside or new) and `resume.lastMsgId` is given, seed `rs.lastMsgId` from it and set `pending = {kind:"replay"}`, so the first send reads back. | `cn:673-688` |
| `handle("disconnect")`: carry `id`; reason `ended` | `cn:710-715` |
| `openPost` with `resume`/recovery: no lines and nothing found → do not create a post (I10) | `cn:411-498` |
| reason text `ended` | `cn:617` |

`discord-js.mjs`: `sendWebhook` returns `{id}` from `webhook.send` (discord.js sends with `wait=true`, so it returns the message. I believe this but did not run it). New `fetchMessages(threadId, {after, limit:100})` → `[{id, webhookId, username: author.username, content}]` through `thread.messages.fetch`. This needs Read Message History, which is already in `INVITE_PERMISSIONS` (`rs:78-79`, bit 16), and Message Content for webhook content; the intent is required at login (`dj:95`, fatal `cn:230-231`). A 403 on the fetch → `kind: "permission"` → I9(b).

`tests/discord/fake.mjs`: message ids on `sendWebhook`, and `fetchMessages`.

### 7.4 Bridge

The events route, for a relay watcher only, writes `event: dropped\ndata: {"droppedThroughSeq":N,"relayFrom":M}\n\n` as the first frame, before the replay loop. This goes after `markRead` at `br:7900`, before `br:7909`. `trimRoomNotices`/`trimRoomMessages` are unchanged.

### 7.5 Wire protocol, all additions

| Direction | Message | New fields |
|---|---|---|
| Rust → child | `connect` | `resume: {lastAcked, lastMsgId} \| null` |
| Rust → child | `disconnect` | `id`, reason `ended` |
| Rust → child | `end` | quit no longer sends it (Remove still does) |
| child → Rust | `posted` | `msgId` |
| child → Rust | `closed` | `id` |
| child → Rust | `error` | codes `readback_unavailable` |
| bridge → Rust | SSE | `event: dropped` |
| bridge → Rust | `/sync/rooms` | `seq` (already sent, `br:4418`) |

Per the IPC lesson, one test drives the real child and the real Rust parser through every message type (T-IPC).

---

## 8. Tests (each must be red at 5fa75a0 and green after; each is neutered and restored with a fresh mtime)

| T | Covers | Test | File |
|---|---|---|---|
| T1 | I1, ck1 | `relay_ack_and_events_open_never_pass_the_journal_sync`: a fake journal records the order of sync and ack/open | `src/discord/tests.rs` |
| T2 | I3, ck1, d3 | `kill_before_sync_and_after_sync`: spawn a helper process (test binary `--journal-writer`) that appends N, syncs at k, and is SIGKILLed at each boundary; recover gives exactly the written prefix, and no line ≤ an acked seq is absent | `src/discord/journal/tests.rs` |
| T3 | ck2, d20 | `a_torn_tail_is_ignored` / `a_malformed_middle_record_refuses_the_file_and_says_so` / `seq_going_backwards_is_corrupt` / `a_duplicate_line_is_ignored_a_conflicting_one_is_corrupt` / `closeack_without_close_is_corrupt`; the corrupt file's bytes are unchanged | `journal/tests.rs` |
| T4 | ck3, d21 | `a_symlink_at_the_file_temp_or_dir_is_refused_and_the_target_unchanged`; `a_hardlink_is_refused`; `a_dir_with_group_bits_is_refused`; check the mode is 0600 | `journal/tests.rs` |
| T5 | ck12, d24 | `compaction_crash_boundaries`: the helper is killed before the temp sync, after it, after the rename and before the dir fsync, and after the unlink; every case recovers without omission; stale temps are removed | `journal/tests.rs` |
| T6 | I2, ck4 | `two_instances_of_one_code_recover_apart`: lines, ACKs, loss and close apply to their own file only | `tests.rs` |
| T7 | I21, ck5, d18 | `quit_offline_leaves_lines_loss_and_close_durable_and_relaunch_says_each_once`: fixture with no child and roster `seq`; relaunch with a child; assert the line seqs, one loss line (`n = seq − last_seq`), one close | `tests.rs` |
| T8 | I12, I9, ck6, finding 1 | Codex's `audit: accepted close line…` ported (passing the close `id`): 1 closing line; plus failures after the post / after `editThread` / after the save; `fetchMessages` 403 → at most 1 per recovery and `readback_unavailable` | `tests/discord-connector.test.mjs` |
| T9 | I9(c), ck7, finding 5 | Codex's `audit: corrupt state…` ported with `resume.lastMsgId`: 1 copy; plus a 2×2 grid (ACK applied or not × read-back ok or 403) with the bounds asserted | `tests/discord-connector.test.mjs` |
| T10 | I14, ck8, d19, finding 3 | Codex's `audit_repeated_disconnect_cycles…` with the assertion flipped: `owed_in ≤ 3` after 4 cycles; the 2nd Connect's reader does not open | `tests.rs` |
| T11 | I18, ck9 | `attach_holds_references_not_lines`: 50k lines journalled, child never reads → outbox length ≤ 2 + 2 × batches, resident serialized lines ≤ 1; then read one at a time, in order | `tests.rs` |
| T12 | I20, I4, ck10, finding 2 | `the_dropped_prefix_is_said_before_the_first_line` (dropped 5, relayFrom 0, first frame 6 → notice then 6); `a_pre_join_prefix_is_not_said` (relayFrom 5); `a_reconnect_says_the_unfollowed_gap_and_the_drop_apart`; Codex's Rust audit test, adapted to feed `event: dropped` first | `tests.rs` |
| T12b | I20 | the bridge writes `event: dropped` first to a relay and never to a member | `tests/room-discord.test.mjs` |
| T13 | I11, ck11 | stale-epoch `posted`/`closed` change no journal; ACKs out of order or duplicated → the watermark is monotone; a duplicate `closed` is a no-op; the file is deleted only after the last `closeack` | `tests.rs` |
| T14 | I6, C9, d22 | `a_close_on_a_deleted_thread_finishes` | `discord-connector.test.mjs` |
| T15 | I10 | `a_recovered_batch_with_no_post_and_no_lines_creates_none` | `discord-connector.test.mjs` |
| T16 | d25 | `a_journal_write_error_stops_the_reader_and_is_shown` | `tests.rs` |
| T17 | d26 | `journals_past_the_launch_window_stay_on_disk_and_drain_in_order` | `tests.rs` |
| T-IPC | all wire | the real child with a fake Discord + the real `read_child`: every new field round-trips | `tests.rs` (the `node()` helper at `tests.rs:559`) |
| T18 | I21 (Remove) | the existing `i21_remove_says_which_lines…` still passes, and the journals are deleted afterwards | `tests.rs` |

### 8b. Codex option-B checklist → invariant → test

| ck | Item | Invariant(s) | Test(s) | File |
|---|---|---|---|---|
| 1 | durability boundary | I1, I3 | T1, T2 | `tests.rs`, `journal/tests.rs` |
| 2 | parsing and corruption: **non-tail = fail closed with a diagnostic, never set aside** | I3, I13 (`journal_corrupt`) | T3 | `journal/tests.rs` |
| 3 | path safety | d21 (writer table §7.1) | T4, T5 | `journal/tests.rs` |
| 4 | instance isolation | I2, I11 | T6, T13 | `tests.rs` |
| 5 | offline quit + loss accounting (no double count, C2) | I21, I3, I15 | T7 | `tests.rs` |
| 6 | close idempotency; **bound without read-back = 1 per recovery** | I12, I9(b) | T8 | `discord-connector.test.mjs` |
| 7 | corrupt child state; **bound without read-back = one repeat per unacked line after the anchor** (corrected) | I9(c) | T9 | `discord-connector.test.mjs` |
| 8 | one budget | I14 | T10 | `tests.rs` |
| 9 | pull replay | I18 | T11 | `tests.rs` |
| 10 | dropped prefix | I20, I4 | T12, T12b | `tests.rs`, `room-discord.test.mjs` |
| 11 | ACK/close/epoch, deletion last | I11, I12, I2 | T13 | `tests.rs` |
| 12 | compaction crash, **dir fsync** | I3 (C7 → C8 order), d24 | T5 | `journal/tests.rs` |
| 13 | matrix completeness | §4 d18–d26, §5 | this table plus §8 | — |
| 14 | gates | all | the Codex r7 imports run red at 5fa75a0 first (T8, T9, T10, T12); then the commands in ck14 through the heavy helper | — |

---

## 9. Owner questions

1. **Quit labels:** held lines arrive at the next launch marked "(delayed)". Is that the wording you want, or should a launch post one header line first ("Delivered after Gyredeck restarted")?
2. **Read-back without permission (I9b):** post and say `readback_unavailable` (as specified), or hold the room until the permission is granted?
3. **Remove deletes the journals (C3):** agreed? The alternative keeps them until a token is added again.
4. **Budget size:** keep 1000 lines per code plus 4 MiB, with a launch window of 2000 lines?

---

## 10. Estimate and risks

| Part | Output tokens |
|---|---|
| `journal.rs` (writers, parser, compaction) | 25–35k |
| Hub refactor (pull writer, outbox, budget, journal calls, recovery, quit) | 35–50k |
| Child (`postOnce`, close intent, resume, C9) + discord-js + fake | 15–25k |
| Bridge `event: dropped` | 2–4k |
| Tests (§8, ~35 cases, including the kill-helper harness) | 45–65k |
| Fixes for 2 audit rounds | 30–50k |
| **Total output** | **≈ 150–230k** (≈ 1.0–1.6M tokens consumed in total, at this card's ratio) |

| Risk | Note |
|---|---|
| The Hub refactor (push → pull) touches every send path | It is the largest change; T11 and T-IPC must land first |
| `F_FULLFSYNC` cost | ~5–30 ms per call. It is batched per instance at ≤ 1 per 2 s; I have not measured it here |
| discord.js `webhook.send` return value and `messages.fetch` on archived forum threads | Believed, not run; check with a live bot before the audit |
| A read-back that races a request which outlived its timeout | Cannot be closed (no idempotency key); stated in I9(a) |
| A foreign bridge outliving the app (`sb:653-661`) | Not verified whether it happens; I1 covers it |
| Kill-at-boundary tests need a helper process | Without one, the crash tests prove nothing (lessons: prove the premise) |
