# #199 Discord relay journal: every write site

The rule is durable-before-effect. No external effect may happen before the journal record that justifies it is in the journal. External effects are: a line or closing line handed to the child, a `Disconnect`, a relay-ack or events-open to the bridge, and deleting a journal. A retry after a refused write keeps the same record, the same id and the same order.

This table describes the tree `feat/199-discord-follow` at `e341d5a` plus the r6b change, written 2026-11-01, and was updated for r7 (on `122ed19`). Line numbers are r6b's and may have moved by a few lines. Short names:

- `rs` = `apps/desktop/src-tauri/src/discord.rs`
- `jr` = `apps/desktop/src-tauri/src/discord/journal.rs`

## How the count was taken

Every `.append(`, `OpenOptions`, `fs::write` and `File::create` in `rs` and `jr` was grepped. There are two hits:

- `rs:524`, inside `append_once`, which is the one appender.
- `jr:407`, inside `Dir::create`, which is `#[cfg(test)]` only.

Every Hub record therefore goes through `append_once`, reached from `write_now` (`rs:1039`) or from `flush_pending` (`rs:1060`). The `pending.push_back` sites are `rs:918`, `rs:1030` (`record`) and `rs:1319`.

**The count is 8 Hub call sites, which matches r6's 8.** However, `take_in` (`rs:788`) serves four logical writers. r6's table tested only two of them: the line and the quit loss. The gap notice and the dropped-prefix notice were untested, and they are now rows in the test table.

## Record sites (Hub)

| # | Site | Data written | Synced where | External effect that follows | Id/order reused on retry | Recovery at launch |
|---|---|---|---|---|---|---|
| 1 | `connect` → `write_now(Open)` `rs:758` | `open{code,createdAt,members,v}` | First reader open, `rs:2332` | `Connect` to the child (`rs:781`). It is sent only if the write returned. | A refused header makes `finish()` remove the file and the Connect is refused. A retried Connect creates the file again with the same header. | A header-only file becomes a tail with an `Ended` close. A torn header with no newline is deleted (`jr:487-492`). |
| 2a | `forward` → `take_in` → `write_now(Line)` `rs:800` | `line{seq,…}` | Reader open `rs:2332`; `flush_ack` `rs:2417`; quit `sync_all` `rs:1179` | The line is handed (`queue_feed` `rs:815`). An open or relay-ack waits for the sync (I1). | `take_in` takes in each record as it lands (r7): a refused record and everything after it are not taken in, and the bridge sends them again. What did land is in memory, so a retry is computed from the journal's prefix. | It is replayed as a batch item. |
| 2b | `forward` gap notice, same path | `line{kind:notice}` at `base+1` | as 2a | as 2a | If the notice landed and its line was refused, the notice is taken in (`skip` moves to the seq it counts through), and the retry computes any further gap after it. A different record at a seq already written is refused by `append_once`, never skipped (r7). | as 2a |
| 2c | `on_dropped` `rs:848` → `take_in` | Dropped or unfollowed notices | as 2a | as 2a; `skip` moves only after the write | Same notices, same seqs | as 2a |
| 2d | `lose_unread` `rs:878` → `take_in(force)`, up to `QUIT_LOSS_TRIES` | `loss{seq,n,label}` | Quit `sync_all` | The loss line is handed | The same record is tried each time | Replayed as the tail's last item |
| 3 | `lose_unread` fallback: `write_loss` `jr:514`, then `pending.push_back` `rs:918` | `.loss` file (synced whole, with a dir sync) + a pending `loss` | `flush_pending` syncs it before `LossLanded` (`rs:1079`) | The loss line is handed and the fallback is unlinked, only after the append **and** the sync | The same pending entry is used. `append_once` skips the append only when the file's last written record is this exact record, written before the sync failed. | `merge_loss` `rs:1335-1362` merges it into a new tail, before that tail's close |
| 4 | `disconnect` → `record(Close)` `rs:960` | `close{id,reason,at}` | `sync_all` | `Disconnect{id}` once the close has landed (`Then::CloseLanded` `rs:1114`). The fold at `rs:943-948` re-sends a durable owed close only when nothing of the file is pending (r6b). | The id is minted once and stays in `Pending`, so it is not minted again | A journalled close keeps its id (`install` `rs:1324`) |
| 5 | `ack` → `record(Ack)` `rs:998` | `ack{seq,msg}` | `sync_all` / next sync | None outside the process. The relay-ack is gated by the line sync (I1), not by this record. | Same seq and msg (`site_ack`) | Watermark and anchor; `resume` |
| 6 | `closed` → `record(Closeack)` `rs:1021` | `closeack{id}` | `settle` syncs before `finish` (`rs:1160`) | The journal is deleted only after the closeack is written **and** synced | `close_acking` stops a second closeack from being queued | Parse drops an acked close. A file that is all done is deleted (`jr:494-500`). |
| 7 | `install` merged loss → `pending.push_back` `rs:1319` | `loss` from the fallback | `flush_pending` `rs:1079` | Loss line handed and fallback unlinked after append + sync | Same entry (as row 3) | `merge_loss` decides between already present (drop the fallback), conflicting (refuse) and new |
| 8 | `install` ended close → `record(Close Ended)` `rs:1327` | `close{id,ended,at}` for an open tail | `sync_all` | `Disconnect` on `CloseLanded`, behind a merged loss | The id is minted once and kept in `Pending` | A journalled close keeps its id |

## Effects that are not record writes

| Effect | Site | Gated by |
|---|---|---|
| `Disconnect` re-planned at attach | `rs:685` | `close_durable && close_pending`. `flush_pending` runs first (`attach`). |
| `Disconnect` of a journalled close at launch (the "~1309" suspect) | `rs:1324` | The close is in the file. `merge_loss` always starts a fresh tail after the last close, so a pending loss is never in a batch whose close is already journalled. |
| `Disconnect` folded over an owed close | `rs:943-948` | **r6b:** the fold applies only when `!waiting(file)` and the owed close is durable. Otherwise the connection becomes its own batch, with its own close behind what is pending. |
| events-open to the bridge | `rs:2332` | `file.sync()` must succeed |
| relay-ack to the bridge | `rs:2417` | `file.sync()` must succeed |
| Journal delete | `settle` `rs:1160` | `!waiting(file)`, no feeds of the instance left, then sync, then unlink |
| Fallback unlink | `LossLanded` `rs:1129`; `merge_loss` `rs:1353` | The loss is synced in the journal, or is already present there |

## File-level writes outside records

| Write | Site | Note |
|---|---|---|
| Fallback `.loss` | `jr:514` | `O_EXCL\|O_NOFOLLOW`, written whole, `F_FULLFSYNC`, dir fsync; unlinked if any step fails |
| Torn-tail cut | `jr:505` | `set_len(valid_len)` + full sync before any append |
| Compaction | `jr:762` | Temp + full sync + `renameat` + dir sync. It is not on the effect path. |
| `finish` / `discard` / `drop_loss` / stale temp and done-file unlinks | `jr:802`, `jr:568`, `jr:559`, `jr:432/489/499` | Delete only |
| Short-write cut-back | inside `append`, `jr:677` | A partial record is truncated back to the last whole record, or the file is marked `broken` |

## Tests (in `src/discord/tests.rs`)

- Every row from 1 to 8, plus 2b and 2c, under a failed append and under a short write. Each case then retries in the same process, crashes and relaunches. Test: `every_write_site_refused_once_lets_nothing_out_and_retries_the_same_record`, 22 cases.
- Sync refused: `r6b_a_refused_sync_*` covers rows 3 and 7, row 6, the open and the relay-ack.
- The suspect and the fold: `r6b_launch_replay_never_closes_a_post_ahead_of_its_loss`, `r6b_a_quit_never_folds_its_close_over_a_loss_still_waiting_for_the_journal`, `r6b_a_folded_quit_crashed_before_its_loss_landed_says_it_once_at_launch`.

## In-memory state, and what rebuilds it (r8 sweep, 2026-11-01, on `d489351`)

Every piece of Hub, feed, File and reader state that lives only in memory is listed below, with what rebuilds it after each of these four paths:

- **(a)** The app relaunches while the bridge is still alive and replaying from the relay's old floor.
- **(b)** The app relaunches with a fresh bridge, so the old instance is gone and a new `createdAt` starts.
- **(c)** The child restarts within one app life.
- **(d)** Disconnect, then Connect of the same instance within one life, for either reason.

Liveness means the path reaches new lines. Safety means no line is lost or doubled.

**Where the tests are:**

- `L` = `r8_every_rejoin_passes_over_the_replay_and_reaches_a_new_line`. It covers paths a, b, c, d(Disconnected) and d(Closed). Each case replays the old seqs plus one new line, and checks the journal and the next child's wire.
- `R` = `r8_a_relaunch_with_the_bridge_alive_reaches_the_next_new_line`, which runs the real reader through path (a).

| State | Lost at | (a) relaunch, bridge alive | (b) relaunch, fresh bridge | (c) child restart | (d) Disconnect → Connect | Test |
|---|---|---|---|---|---|---|
| `File::last` (last record written) | relaunch | Not rebuilt, and not needed: since r8 a feed starts at `written_through`, so a replayed seq never reaches `append_once`. A different record at a written seq is still refused (r7). | new file | kept | kept | L, `r7_a_different_record…` |
| `File::written` / `synced` / `dirty` | relaunch | `written = synced = parsed.last_seq` (`Inner::new`) | new file | kept | kept | L |
| `File::broken` | relaunch | The torn tail is cut at recovery (`set_len` + sync) | — | kept | kept | `r6b_a_torn_tail…` |
| feed `last_seq` / `skip` | relaunch; Closed reconnect | **r8:** `connect` starts at `max(resume, file.written_through())` | starts at 0, with a new instance and new file | the feed is kept | Disconnected: the `resume` map. Closed: **r8** `written_through`. | L, R |
| feed `floor` (relayFrom) | relaunch / reconnect | `event: dropped` on every open | same | kept | same | `a_reconnect_says_the_unfollowed_gap…` |
| feed `acked` | relaunch / reconnect | **r8:** from `progress`, which is rebuilt from the journal's ACKs | 0 (new instance) | kept | **r8:** from `progress` | L (acked == 1) |
| `progress` (watermark, `lastMsgId`) | relaunch | `install` from the parsed journal | new instance: none | kept | kept | L (resume `lastAcked` 1 at the next attach) |
| feed `handed` | every attach | set to 0. Everything unacked is handed again, and the child dedupes by `lastSeq` (I7). | same | same | new feed | L (each line once per child) |
| feed `unacked` / `bytes` | relaunch | The old instance becomes a draining batch from the journal's items and is replayed before the live feed | old batch replayed; new feed empty | kept | moved to draining with its close | L, `quit_offline…` |
| feed `bridge_seq` | relaunch | `refresh_names` on the next roster read. Until then a quit with a failed roster says "unknown", which is true. | same | kept | kept | `auditor_quit_records_unread_loss_when_roster_query_fails` |
| `close_id` / `close_pending` / `close_durable` | relaunch | From `close` / `closeack` records. An open tail gets one `Ended` close. | same | kept | kept | site table (relaunch step), `r6b_launch_replay…` |
| `close_acking` | relaunch | Lost with its pending closeack, so the close is told again with the same id and the next `closed` finishes it | same | kept; a late `closed` from the old epoch is ignored | kept | `r6b_a_close_ack_after_restarts…` |
| `pending` (records not yet in the journal) | relaunch | Their effects never happened (durable-before-effect). A close is minted again as `Ended`, a loss comes back from the fallback, an ack makes the child dedupe. | same | flushed first by attach | waits; `waiting(file)` holds folds and appends behind it | site table (relaunch step), `r6b_a_refused_sync…`, `r6b_a_folded_quit…` |
| `resume` map | relaunch | replaced by `written_through` (r8) | n/a | kept | Disconnected only; Closed uses `written_through` (r8) | L |
| `epoch` | relaunch | a new state; the old child's pipe is gone | same | +1 per spawn; stale events are ignored | kept | `stale_events_and_reordered_acks…`, `r6b_a_close_ack_after_restarts…` |
| `outbox` / `writer` | attach | rebuilt by `attach` | same | same | n/a | L |
| `journal_errors` | relaunch | `journal_corrupt` is derived again at recovery; `journal_blocked` comes back at the next refusal. The d18 case where both writes are refused is the accepted exception (#282). | same | kept | kept | `remove_deletes_a_journal_refused_as_corrupt` |
| `refused` / `parked` | relaunch | `scan` + the launch window | same | kept | `connect` loads a parked journal of the same instance first | `journals_past_the_launch_window…` |
| reader `acked_sent` / `ack_at` | new reader | starts at 0 and acks again (the bridge is idempotent), after a sync | same | n/a | same | `r6b_a_refused_sync_acks…` |
| `dropped` / `dropped_lines` / `leaving` | relaunch | Remove status only (C3); outside the journal path and not changed by #199 option B | — | kept | kept | — |
| `ready` / `bot` / `forums` / `pairing` / `owner` | relaunch / restart | the child's `ready`; the owner from the Keychain | same | `forget_child` + `ready` | n/a | existing pairing and ready tests |

**Known bounds, none of them a lost or doubled line:**

- **The gap a notice counts is not in the journal.** The record holds the notice's seq, not the seq it counts through (`skip`). Suppose a crash comes after a gap notice lands and before its line does. After relaunch, the next gap can then count a seq that the earlier notice already counted, so the count is too high. It is never too low.
- **A recovered file counts as synced.** Recovery sets `synced = last_seq`, but bytes from a process that crashed may still be only in the OS cache. A power loss after the relaunch could lose them after the bridge was told. This is the power-loss edge, which does not block.

## r9 (2026-11-01): how far a record accounts for, and recovered files

- A gap notice or a loss that accounts for seqs past its own carries `through` (Line/Loss records); `lose_unread` sets it to the room's seq, or to the bridge's last answer on the "at least" branch. A compaction carries the reach over in the header's `covered`. A reattached feed resumes with `skip = covered`, so a relaunch never counts the same gap or loss twice.
- A record without `through` is read as reaching its own seq. Journals written by dev builds before r9 can still recount a gap once; no released build ever wrote this format, so the journal version is not bumped (agreed with Codex, r9).
- A recovered file counts nothing as synced: `synced = 0`, `dirty = size > 0`, so the first events-open or relay-ack after a relaunch waits for a real sync in this life.
- r9 stand-in sweep (S1–S4): every position check reads `RoomFeed::seen_through()` — last taken, reach, and what the journal now holds — so a record that landed for another feed of the instance (a held fallback loss) is passed over, not refused (forward, on_dropped, lose_unread, the Disconnected resume). A file started again for an instance already followed writes the resume position as the header's `covered`. A fallback `.loss` already present in the journal is dropped only after this life syncs the journal. A compaction whose directory sync failed leaves the rename owed, so the next `sync()` syncs the directory before anything counts as synced.
