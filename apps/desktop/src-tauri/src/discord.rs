//! Following a sync room on the owner's Discord (#199).
//!
//! The connector is a child process (`gyredeck-discord.mjs --parent-stdio`) that talks only
//! to Discord. This side holds everything the child must never see — each room's password,
//! the broker's secret, the machine token — reads every connected room's `/events` itself and
//! hands the child finished lines. The one way anything reaches the child's stdin is
//! [`ChildChannel::send`], which takes a [`ToChild`] and nothing else, and no variant of it
//! has a field a password could travel in. The bot token rides only in `hello`.
//!
//! The guarantee (#199, option B): every line Rust takes from a room is written to a disk
//! journal ([`journal`]) before the child can be handed it, and stays there until Discord has
//! taken it, across child restarts and app launches. At quit, lines Rust holds are late, not
//! lost: the next launch delivers them. What the bridge still held unread for the relay dies
//! with the bridge, so it is counted into a `loss` record and said once at the next launch
//! (I21). Remove has no token left to deliver later: there the post gets one "N messages not
//! relayed: #41–#43 from Codex, Gyre Assistant" line before its close, or Remove's `dropped`
//! status carries the same seqs and senders, and the journals are deleted.

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fmt,
    io::{BufRead, BufReader, ErrorKind, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex, MutexGuard, Weak,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::standalone_bridge::{self, SupervisorLog};

mod journal;

pub(crate) const KEYCHAIN_SERVICE: &str = "Gyredeck Discord";
pub(crate) const KEYCHAIN_ACCOUNT: &str = "bot-token";
const CONFIG_FORUM: &str = "discordForumId";
/// The paired owner lives in the Keychain (account `owner`), never in the config file, which
/// any process of this user can write: the owner is who #205 lets give commands. These are
/// the config keys earlier builds kept it under; they are never read, and deleted on start.
const KEYCHAIN_OWNER_ACCOUNT: &str = "owner";
const LEGACY_OWNER_KEYS: [&str; 3] = ["discordOwner", "discordOwnerId", "discordOwnerName"];
/// The sender the bridge uses when the room speaks about itself (`ROOM_SENDER`).
const ROOM_SENDER: &str = "gyredeck-room";
/// The sender of what the person typed into Gyredeck itself.
const APP_SENDER: &str = "gyredeck";
const PAIRING_TTL: Duration = Duration::from_secs(10 * 60);
/// How many of a room's lines may wait for the child's `posted` before the room's stream is
/// closed. Lines are dropped only by an acknowledgement, never by a count: a full room stops
/// reading instead, so the relay's read position holds the bridge's trim floor.
const UNACKED_CAP: usize = 1000;
/// The same budget in bytes of line text, live and draining together, per room code (I14).
const ROOM_BUDGET_BYTES: usize = 4 * 1024 * 1024;
/// How many held lines a launch loads from earlier journals; the rest wait on disk (d26).
const LAUNCH_WINDOW: usize = 2 * UNACKED_CAP;
/// A journal is compacted once it is this many times the byte budget.
const JOURNAL_COMPACT_FACTOR: u64 = 2;
const JOURNAL_DIR: &str = "discord-journal";
const JOURNAL_BLOCKED: &str = "journal_blocked";
const JOURNAL_CORRUPT: &str = "journal_corrupt";
/// The label of the loss a quit leaves: what the bridge held unread for the relay.
const UNREAD_AT_QUIT: &str = "unread when Gyredeck quit";
/// The bridge could not be asked at quit: a count from its last answer, at least.
const UNREAD_AT_QUIT_AT_LEAST: &str = "unread when Gyredeck quit, at least";
/// The bridge could not be asked at quit and never said a count: how many is not known.
const UNREAD_AT_QUIT_UNKNOWN: &str = "unread when Gyredeck quit, unknown";
/// How long one write to the child's stdin may block before the child is judged stuck: it
/// is not reading. A fresh Node child reads nothing for its first half second or so.
const CHILD_STUCK: Duration = Duration::from_secs(20);
const CHILD_LINE_MAX_BYTES: usize = 64 * 1024;
const SUPERVISOR_INTERVAL: Duration = Duration::from_millis(500);
const RESTART_BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A child that ran this long before dying starts the backoff again from one second.
const HEALTHY_RUN: Duration = Duration::from_secs(60);
/// The child's error for a state file it cannot use: it posts nothing until restarted with
/// one it can, so the error stays in status until a new child is attached.
const STORAGE_BLOCKED: &str = "storage_blocked";
/// Errors after which the child idles and is never restarted for the same token.
const FATAL_ERRORS: [&str; 2] = ["bad_token", "missing_intent"];
/// How often the reader tells the bridge what Discord has accepted, coalesced.
const ACK_EVERY: Duration = Duration::from_secs(2);
/// How many times a quit tries to journal its loss record before it uses the fallback file.
const QUIT_LOSS_TRIES: u32 = 3;
const QUIT_LOSS_RETRY: Duration = Duration::from_millis(100);
/// How long Remove, and quitting, wait for the connector to take what it holds to Discord.
const REMOVE_DRAIN: Duration = Duration::from_secs(5);
const QUIT_DRAIN: Duration = Duration::from_secs(2);
const READER_POLL: Duration = Duration::from_millis(250);
const READER_BACKOFF_MAX: Duration = Duration::from_secs(30);

/// View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Manage
/// Threads, Manage Channels (for the forum's tags), Manage Webhooks, Read Message History, and
/// Add Reactions (the prompts of #205). The owner invites once, so it is all asked for now.
pub(crate) const INVITE_PERMISSIONS: u64 =
    (1 << 10) | (1 << 11) | (1 << 38) | (1 << 35) | (1 << 34) | (1 << 4) | (1 << 29) | (1 << 16) | (1 << 6);

// ── what the child is told ──

/// A Discord bot token. Its text is never formatted: `Debug` says only that one is there,
/// and the only way out of this type is the `hello` line.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct BotToken(String);

impl fmt::Debug for BotToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BotToken(<redacted>)")
    }
}

impl Serialize for BotToken {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl BotToken {
    /// A token in the shape Discord issues: three dot-separated base64url parts.
    pub(crate) fn parse(raw: &str) -> Result<Self, String> {
        let token = raw.trim();
        let parts: Vec<&str> = token.split('.').collect();
        let base64url = |part: &str| part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        let shaped = token.len() <= 128
            && parts.len() == 3
            && parts[0].len() >= 17
            && parts[1].len() >= 4
            && parts[2].len() >= 20
            && parts.iter().all(|part| base64url(part));
        if shaped {
            Ok(Self(token.to_string()))
        } else {
            Err("That is not a Discord bot token. Copy it from the Bot page of your application in the Discord Developer Portal".to_string())
        }
    }

    #[cfg(test)]
    fn expose(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DisconnectReason {
    /// The room has ended.
    Closed,
    /// The room goes on; Discord no longer follows it.
    Disconnected,
    /// The app ended under the room without closing it: a journal with no close.
    Ended,
}

/// How far an earlier child got with a room instance: the read-back anchor for a child whose
/// own state is lost (#199 I9c).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Resume {
    pub last_acked: u64,
    pub last_msg_id: Option<String>,
}

/// Every line the child can be sent: the spec's IPC v1, app → child.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub(crate) enum ToChild {
    #[serde(rename_all = "camelCase")]
    Hello { v: u8, token: BotToken, forum_id: Option<String>, owner_id: Option<String>, state_path: String },
    #[serde(rename_all = "camelCase")]
    Forum { forum_id: String },
    #[serde(rename_all = "camelCase")]
    /// `round` names the pairing it accepts, so the child says "Paired" only for that one.
    Owner { owner_id: Option<String>, round: Option<String> },
    /// `round` is fresh for each start; the child echoes it in `paired`.
    Pair { code: String, round: String },
    #[serde(rename_all = "camelCase")]
    Connect { room: String, members: Vec<String>, created_at: Option<u64>, resume: Option<Resume> },
    Message { room: String, seq: u64, sender: String, to: String, kind: String, text: String, ts: String },
    /// `id` names this close, so `closed` clears this one and not another of the instance.
    Disconnect { room: String, reason: DisconnectReason, id: String },
    /// Remove stops the relay: what is still queued will not be delivered, so each closing
    /// room's post says so once before its close (#199 I21). Quitting does not send it.
    End {},
}

/// The child's stdin. One thread owns the pipe and pulls each line from the [`Hub`] only when
/// it can write it, at the pace the child reads: nothing is queued but references to what the
/// Hub already holds, so an attach that hands a restarted child everything held never copies
/// it (#199 I18). Stuck is the child not reading: one write blocked past `CHILD_STUCK`.
pub(crate) struct ChildChannel {
    out: Option<Box<dyn Write + Send>>,
    shared: Arc<ChannelShared>,
    wake: Option<Arc<Condvar>>,
    born: Instant,
    stuck_after: Duration,
}

#[derive(Default)]
struct ChannelShared {
    broken: AtomicBool,
    /// Milliseconds since `born` at which the write in progress began; 0 while idle.
    writing_since: AtomicU64,
    /// The channel was let go: write what the outbox still holds, then close the pipe.
    closing: AtomicBool,
}

impl ChildChannel {
    pub(crate) fn new(out: Box<dyn Write + Send>) -> Self {
        Self::stuck_after(out, CHILD_STUCK)
    }

    pub(crate) fn stuck_after(out: Box<dyn Write + Send>, stuck_after: Duration) -> Self {
        Self { out: Some(out), shared: Arc::default(), wake: None, born: Instant::now(), stuck_after }
    }

    fn is_broken(&self) -> bool {
        if self.shared.broken.load(Ordering::SeqCst) {
            return true;
        }
        let since = self.shared.writing_since.load(Ordering::SeqCst);
        since != 0 && self.born.elapsed().saturating_sub(Duration::from_millis(since - 1)) > self.stuck_after
    }
}

impl Drop for ChildChannel {
    fn drop(&mut self) {
        self.shared.closing.store(true, Ordering::SeqCst);
        if let Some(wake) = &self.wake {
            wake.notify_all();
        }
    }
}

/// The stdin writer: pull one line, write it with the Hub unlocked, repeat. It stops when a
/// newer child is attached, when a write fails, or once let go and the outbox is empty.
fn write_to_child(hub: Arc<Mutex<Hub>>, wake: Arc<Condvar>, writer: u64, shared: Arc<ChannelShared>, born: Instant, mut out: Box<dyn Write + Send>) {
    let mut guard = lock(&hub);
    loop {
        if guard.writer != writer {
            return;
        }
        match guard.next_line() {
            Some(line) => {
                drop(guard);
                shared.writing_since.store(born.elapsed().as_millis() as u64 + 1, Ordering::SeqCst);
                let written = out.write_all(line.as_bytes()).and_then(|()| out.flush());
                shared.writing_since.store(0, Ordering::SeqCst);
                if written.is_err() {
                    shared.broken.store(true, Ordering::SeqCst);
                    return;
                }
                guard = lock(&hub);
            }
            None if shared.closing.load(Ordering::SeqCst) => return,
            None => {
                guard = match wake.wait_timeout(guard, READER_POLL) {
                    Ok((guard, _)) => guard,
                    Err(poisoned) => poisoned.into_inner().0,
                };
            }
        }
    }
}

/// What the stdin writer is to hand over next: a control line, or the next unhanded line of
/// one feed, found in the Hub when it is pulled.
#[derive(Clone, Debug)]
enum Out {
    Control(ToChild),
    Feed { room: String, feed: u64 },
}

// ── what the child says ──

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct Bot {
    pub id: String,
    pub username: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChildForum {
    id: String,
    name: String,
    #[serde(default)]
    guild_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum FromChild {
    #[serde(rename_all = "camelCase")]
    Ready { bot: Bot, application_id: String, #[serde(default)] forums: Vec<ChildForum> },
    #[serde(rename_all = "camelCase")]
    Paired { owner_id: String, username: String, #[serde(default)] round: Option<String> },
    /// `createdAt` is the room instance the message belonged to (#199 r4); `msgId` is the
    /// Discord id of its last part, journalled as the next child's read-back anchor.
    #[serde(rename_all = "camelCase")]
    Posted { room: String, seq: u64, #[serde(default)] created_at: Option<u64>, #[serde(default)] msg_id: Option<String> },
    /// The close `id` of that room instance is said, archived and `closedAt` saved (#199 I12).
    #[serde(rename_all = "camelCase")]
    Closed { room: String, #[serde(default)] created_at: Option<u64>, #[serde(default)] id: Option<String> },
    Connected {},
    Error { code: String, message: String },
}

// ── the shared state ──

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Forum {
    pub id: String,
    pub name: String,
    pub guild_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(crate) struct Owner {
    pub id: String,
    pub username: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(crate) struct DiscordError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscordStatus {
    pub configured: bool,
    pub running: bool,
    /// The child said `ready` and nothing since has undone it: only then can a room be
    /// followed. The UI offers Connect on this, not on a bot name left from an older child.
    pub ready: bool,
    pub bot: Option<Bot>,
    pub forums: Vec<Forum>,
    pub forum_id: Option<String>,
    pub owner: Option<Owner>,
    pub invite_url: Option<String>,
    pub connected_rooms: Vec<String>,
    /// Per connected room, the lines handed to the child that Discord has not yet accepted.
    /// Only rooms with any are listed.
    pub behind: BTreeMap<String, usize>,
    /// Lines Remove had to leave undelivered, per room. Kept after Remove.
    pub dropped: BTreeMap<String, usize>,
    /// Which those were, per room: seq ranges and senders, to find them in the agents' own
    /// transcripts ("#41–#43 from Codex, Gyre Assistant").
    pub dropped_lines: BTreeMap<String, String>,
    /// Rooms whose relay could not be taken out, with why. A later disconnect retries.
    pub leaving: BTreeMap<String, String>,
    pub pairing_code: Option<String>,
    pub error: Option<DiscordError>,
    /// Journals from earlier launches still waiting on disk for room in the launch window,
    /// unread: their lines are not counted until they are loaded.
    pub held: usize,
    /// What the journal refused: `journal_blocked` per room code, `journal_corrupt` per file.
    pub journal_errors: BTreeMap<String, DiscordError>,
}

struct Pairing {
    code: String,
    round: String,
    at: Instant,
}

struct RoomFeed {
    /// Which feed this is, for the outbox's references to it.
    id: u64,
    members: Vec<String>,
    created_at: Option<u64>,
    /// Every line forwarded and not yet acknowledged, in seq order.
    unacked: VecDeque<ToChild>,
    /// The text bytes of `unacked`, for the byte budget.
    bytes: usize,
    last_seq: u64,
    /// The highest seq Discord has accepted (`posted`), which the reader tells the bridge.
    acked: u64,
    /// The highest seq the current child was handed; every attach starts it again at 0.
    handed: u64,
    /// The relay's join point (`relayFrom`): nothing at or below it is ever said as missed.
    floor: u64,
    /// Seqs the bridge said it will never send (pre-join history, a dropped prefix): passed
    /// over without a record. `last_seq` stays the last seq journalled, so no open's `since`
    /// is past the journal's sync (I1).
    skip: u64,
    /// The room's seq as the bridge last reported it: the quit count when it cannot be asked.
    bridge_seq: u64,
    /// Its close record is in the journal, so the child may be told of it (`Then::CloseLanded`).
    close_durable: bool,
    /// Its closeack is on its way to the journal: a repeated `closed` adds nothing.
    close_acking: bool,
    /// A let-go batch whose close the child has not yet said is done (`closed`): it is kept,
    /// replayed and counted until then, like a line (#199 I12). `close_id` names that close.
    close_pending: bool,
    close_id: Option<String>,
    /// The room instance's journal; `None` only for a Hub with no journal directory (tests).
    journal: Option<Arc<journal::File>>,
}

impl RoomFeed {
    /// The last seq this feed has accounted for: what it took, what a notice or loss reached,
    /// and what its journal holds now — a record that landed for another feed of the same
    /// instance (a held fallback loss) counts too, so its replay is passed over (#199 r9).
    fn seen_through(&self) -> u64 {
        let journalled = self.journal.as_ref().map_or(0, |file| file.covered_through());
        self.last_seq.max(self.skip).max(journalled)
    }

    fn new(id: u64, members: Vec<String>, created_at: Option<u64>, last_seq: u64, journal: Option<Arc<journal::File>>) -> Self {
        Self {
            id,
            members,
            created_at,
            unacked: VecDeque::new(),
            bytes: 0,
            last_seq,
            acked: 0,
            handed: 0,
            floor: 0,
            skip: 0,
            bridge_seq: 0,
            close_durable: false,
            close_acking: false,
            close_pending: false,
            close_id: None,
            journal,
        }
    }

    fn done(&self) -> bool {
        self.unacked.is_empty() && !self.close_pending
    }

    /// What it still owes Discord: its lines, and its closing line.
    fn owed(&self) -> usize {
        self.unacked.len() + usize::from(self.close_pending)
    }
}

/// What a journal record authorises once it is in the journal. Nothing leaves the process —
/// a line or a close to the child, a deleted file — before the record that authorises it.
#[derive(Clone, Debug)]
enum Then {
    Nothing,
    /// A close is journalled: the child may be told.
    CloseLanded { room: String, feed: u64 },
    /// A closeack is journalled: the batch is done, and its instance may finish.
    CloseAcked { room: String, at: u64, feed: u64 },
    /// A loss is journalled and synced: its line may be handed on, its fallback deleted.
    LossLanded { room: String, at: u64, feed: u64, line: ToChild },
}

/// A record the journal has not taken yet, with its effect, kept in order per file and
/// retried; never re-minted.
struct Pending {
    room: String,
    file: Arc<journal::File>,
    record: journal::Record,
    then: Then,
}

/// What became of a line offered to a room.
#[derive(Debug, PartialEq, Eq)]
enum Forwarded {
    Taken,
    /// Not this room's, or already forwarded.
    Ignored,
    /// The room's budget is spent: stop reading until Discord catches up (I14).
    Full,
    /// The journal could not write it, so it was not taken in (d25).
    Blocked,
}

fn line_seq(line: &ToChild) -> u64 {
    match line {
        ToChild::Message { seq, .. } => *seq,
        _ => 0,
    }
}

fn line_bytes(line: &ToChild) -> usize {
    match line {
        ToChild::Message { text, .. } => text.len(),
        _ => 0,
    }
}

fn notice(room: &str, seq: u64, text: String) -> ToChild {
    ToChild::Message { room: room.to_string(), seq, sender: "Room".to_string(), to: "everyone".to_string(), kind: "notice".to_string(), text, ts: String::new() }
}

fn plural(count: u64) -> &'static str {
    if count == 1 { "" } else { "s" }
}

fn loss_text(n: u64, label: &str) -> String {
    let lines = format!("{n} line{} {}", plural(n), if n == 1 { "was" } else { "were" });
    match label {
        UNREAD_AT_QUIT_AT_LEAST => return format!("At least {lines} unread when Gyredeck quit; the bridge could not say how many more"),
        UNREAD_AT_QUIT_UNKNOWN => return "Lines the bridge still held when Gyredeck quit may not have been relayed; it could not say how many".to_string(),
        _ => {}
    }
    format!("{n} line{} {} {label}", plural(n), if n == 1 { "was" } else { "were" })
}

fn line_record(line: &ToChild) -> Option<journal::Record> {
    match line.clone() {
        ToChild::Message { seq, sender, to, kind, text, ts, .. } => Some(journal::Record::Line { seq, sender, to, kind, text, ts, through: None }),
        _ => None,
    }
}

fn item_line(room: &str, item: journal::Item) -> ToChild {
    match item {
        journal::Item::Line { seq, sender, to, kind, text, ts, .. } => ToChild::Message { room: room.to_string(), seq, sender, to, kind, text, ts },
        journal::Item::Loss { seq, n, label, .. } => notice(room, seq, loss_text(n, &label)),
    }
}

/// A record into its journal, once. A line or loss at a seq the file already holds is skipped
/// only when it is that very record, written by a try whose sync then failed; any other record
/// at that seq is refused, never taken for written (#199 r7).
fn append_once(file: &journal::File, record: &journal::Record) -> std::io::Result<()> {
    match record {
        journal::Record::Line { seq, .. } | journal::Record::Loss { seq, .. } if file.written_through() >= *seq => {
            if file.last_item().as_ref() == Some(record) {
                Ok(())
            } else {
                Err(std::io::Error::other(format!("the journal already holds another record at seq {seq}")))
            }
        }
        record => file.append(record),
    }
}

fn close_id() -> String {
    random_hex(8).unwrap_or_else(|_| {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|at| at.as_nanos()).unwrap_or_default();
        format!("{:016x}", nanos as u64)
    })
}

#[derive(Default)]
struct Hub {
    channel: Option<ChildChannel>,
    rooms: BTreeMap<String, RoomFeed>,
    forum_id: Option<String>,
    owner: Option<Owner>,
    bot: Option<Bot>,
    application_id: Option<String>,
    forums: Vec<Forum>,
    error: Option<DiscordError>,
    /// The code being offered, its round, and when it was offered.
    pairing: Option<Pairing>,
    /// True only between the current child's `ready` and its exit or a fatal error: the
    /// one state in which a connected room reaches Discord.
    ready: bool,
    /// The last seq forwarded of each room instance Discord stopped following, by code with
    /// its `createdAt`, so a reconnect can say how much it missed. Dropped when it closes.
    /// With it, how far the bridge said it would never send (`skip`), so the same gap is not
    /// counted again by the next reconnect.
    resume: HashMap<String, (Option<u64>, u64, u64)>,
    /// `UNACKED_CAP` unless a test sets a smaller one.
    cap: usize,
    /// `ROOM_BUDGET_BYTES` unless a test sets another.
    cap_bytes: usize,
    /// Rooms Discord no longer follows whose relay member the bridge could not be told to
    /// take out. It is still in the room, unread, holding the room's floor, so it is shown
    /// and every later disconnect or remove tries again.
    leaving: BTreeMap<String, String>,
    /// Which child is current; anything an earlier child says is not news (#199 r4).
    epoch: u64,
    /// Rooms no longer followed whose last lines Discord has not yet taken, with why each was
    /// let go. They are kept, replayed to a restarted child with their `disconnect`, and
    /// trimmed by ACKs like a connected room, so a Disconnect never drops what was queued.
    /// One entry per connection let go, oldest first: a second Disconnect of the same code
    /// before the first was taken adds to the list, never replaces it (#199 r5).
    draining: BTreeMap<String, Vec<(RoomFeed, DisconnectReason)>>,
    /// What Remove had to leave undelivered, per room; shown, never silent.
    dropped: BTreeMap<String, usize>,
    dropped_lines: BTreeMap<String, String>,
    /// The Hub's own handle, for the stdin writer an attach starts.
    me: Weak<Mutex<Hub>>,
    /// Wakes the stdin writer when the outbox has something.
    wake: Arc<Condvar>,
    /// What the current child is handed next, in order: references, never copies (I18).
    outbox: VecDeque<Out>,
    /// Which stdin writer is current; each attach starts a new one.
    writer: u64,
    next_feed: u64,
    /// Per room instance, the ACK watermark and the Discord id of its last part.
    progress: HashMap<(String, u64), (u64, Option<String>)>,
    journal_dir: Option<journal::Dir>,
    /// Why the journal directory could not be used: every Connect is refused until it can.
    journal_down: Option<String>,
    journal_errors: BTreeMap<String, DiscordError>,
    /// Journals recovery refused, by name: left as they are, until Remove deletes them.
    refused: Vec<String>,
    /// Recovered journals past the launch window, oldest first.
    /// Records waiting for their journal, oldest first: the only queue a journal write takes.
    pending: VecDeque<Pending>,
    flushing: bool,
    /// Recovered journal names past the launch window: nothing of them is opened or read.
    parked: VecDeque<String>,
    /// `LAUNCH_WINDOW` unless a test sets a smaller one.
    window: usize,
    /// `JOURNAL_COMPACT_FACTOR × ROOM_BUDGET_BYTES` unless a test sets a smaller one.
    compact_over: u64,
}

impl Hub {
    fn send(&mut self, message: &ToChild) {
        if self.channel.is_some() {
            self.outbox.push_back(Out::Control(message.clone()));
            self.wake.notify_all();
        }
    }

    /// Hand the current child this feed's lines, unless a reference to it is already queued.
    fn queue_feed(&mut self, room: &str, feed: u64) {
        if self.channel.is_none() {
            return;
        }
        if !self.outbox.iter().any(|out| matches!(out, Out::Feed { room: queued, feed: id } if queued == room && *id == feed)) {
            self.outbox.push_back(Out::Feed { room: room.to_string(), feed });
        }
        self.wake.notify_all();
    }

    fn feed_mut(&mut self, room: &str, id: u64) -> Option<&mut RoomFeed> {
        if let Some(feed) = self.rooms.get_mut(room).filter(|feed| feed.id == id) {
            return Some(feed);
        }
        self.draining.get_mut(room)?.iter_mut().map(|(feed, _)| feed).find(|feed| feed.id == id)
    }

    /// The next line for the stdin writer, serialized only now; `None` when nothing waits.
    fn next_line(&mut self) -> Option<String> {
        loop {
            let message = match self.outbox.pop_front()? {
                Out::Control(message) => message,
                Out::Feed { room, feed } => {
                    let Some(entry) = self.feed_mut(&room, feed) else {
                        continue;
                    };
                    let handed = entry.handed;
                    let Some(line) = entry.unacked.iter().find(|line| line_seq(line) > handed).cloned() else {
                        continue;
                    };
                    entry.handed = line_seq(&line);
                    self.outbox.push_front(Out::Feed { room, feed });
                    line
                }
            };
            if let Ok(mut line) = serde_json::to_string(&message) {
                line.push('\n');
                return Some(line);
            }
        }
    }

    fn resume_of(&self, room: &str, created_at: Option<u64>) -> Option<Resume> {
        let (acked, last_msg_id) = self.progress.get(&(room.to_string(), created_at?))?;
        Some(Resume { last_acked: *acked, last_msg_id: last_msg_id.clone() })
    }

    fn connect_line(&self, room: &str, feed: &RoomFeed, replay: bool) -> ToChild {
        let resume = self.resume_of(room, feed.created_at).or_else(|| replay.then(Resume::default));
        ToChild::Connect { room: room.to_string(), members: feed.members.clone(), created_at: feed.created_at, resume }
    }

    /// A fresh child: `hello` first, then every let-go batch with its close, oldest first, then
    /// every connected room. Only references are queued; the lines are read when written.
    fn attach(&mut self, mut channel: ChildChannel, token: BotToken, state_path: String) {
        let hello = ToChild::Hello {
            v: 1,
            token,
            forum_id: self.forum_id.clone(),
            owner_id: self.owner.as_ref().map(|owner| owner.id.clone()),
            state_path,
        };
        self.ready = false;
        self.flush_pending();
        self.writer += 1;
        self.outbox.clear();
        self.outbox.push_back(Out::Control(hello));
        let mut plan = Vec::new();
        for (room, batches) in &self.draining {
            for (feed, reason) in batches {
                plan.push(Out::Control(self.connect_line(room, feed, true)));
                plan.push(Out::Feed { room: room.clone(), feed: feed.id });
                if let Some(id) = feed.close_id.as_ref().filter(|_| feed.close_pending && feed.close_durable) {
                    plan.push(Out::Control(ToChild::Disconnect { room: room.clone(), reason: *reason, id: id.clone() }));
                }
            }
        }
        for (room, feed) in &self.rooms {
            plan.push(Out::Control(self.connect_line(room, feed, true)));
            plan.push(Out::Feed { room: room.clone(), feed: feed.id });
        }
        self.outbox.extend(plan);
        let feeds = self.rooms.values_mut().chain(self.draining.values_mut().flat_map(|batches| batches.iter_mut().map(|(feed, _)| feed)));
        for feed in feeds {
            feed.handed = 0;
        }
        let (Some(out), Some(hub)) = (channel.out.take(), self.me.upgrade()) else {
            channel.shared.broken.store(true, Ordering::SeqCst);
            self.channel = Some(channel);
            return;
        };
        channel.wake = Some(Arc::clone(&self.wake));
        let (wake, writer, shared, born) = (Arc::clone(&self.wake), self.writer, Arc::clone(&channel.shared), channel.born);
        let started = thread::Builder::new()
            .name("gyredeck-discord-stdin".to_string())
            .spawn(move || write_to_child(hub, wake, writer, shared, born, out));
        if started.is_err() {
            channel.shared.broken.store(true, Ordering::SeqCst);
        }
        self.channel = Some(channel);
        // A new child reports its own storage; the last one's refusal is not this one's.
        if self.error.as_ref().is_some_and(|error| error.code == STORAGE_BLOCKED) {
            self.error = None;
        }
        self.wake.notify_all();
    }

    /// The journal this room instance already has open, if any: a reconnect appends to it.
    fn journal_of(&self, room: &str, created_at: u64) -> Option<Arc<journal::File>> {
        let draining = self.draining.get(room).into_iter().flatten().map(|(feed, _)| feed);
        self.rooms
            .get(room)
            .into_iter()
            .chain(draining)
            .filter(|feed| feed.created_at == Some(created_at))
            .find_map(|feed| feed.journal.clone())
    }

    fn journal_blocked(&mut self, room: &str, error: impl fmt::Display) -> String {
        let message = format!("The relay journal for {room} could not be written ({error}), so Discord stops taking its lines in until it can");
        self.journal_errors.insert(room.to_string(), DiscordError { code: JOURNAL_BLOCKED.to_string(), message: message.clone() });
        message
    }

    /// Follow a room: its journal (with its header) exists before the child hears of it.
    fn connect(&mut self, room: &str, members: Vec<String>, created_at: Option<u64>) -> Result<(), String> {
        if let Some(why) = self.journal_down.clone() {
            return Err(self.journal_blocked(room, why));
        }
        if let Some(at) = created_at {
            // A parked journal of this very instance is loaded now, so it is appended to.
            let name = journal::file_name(room, at);
            if let Some(index) = self.parked.iter().position(|parked| *parked == name) {
                self.parked.remove(index);
                self.load(&name);
            }
        }
        // The same room instance followed again picks up its count where it stopped, so the
        // first line after the reconnect says how many went by unfollowed (the gap notice).
        // Read, not taken: a Connect refused below (a header the journal would not take) keeps
        // it for the retry; it goes only once this Connect is in (#199 r9).
        let (mut last_seq, mut skip) = match self.resume.get(room) {
            Some((instance, last, skip)) if instance.is_some() && *instance == created_at => (*last, *skip),
            _ => (0, 0),
        };
        let journal = match (created_at, self.journal_dir.as_ref()) {
            (Some(at), Some(dir)) => match self.journal_of(room, at) {
                Some(file) => Some(file),
                None => match dir.create_bare(room, at) {
                    Ok(file) => {
                        // The header goes through the one write path; refused, the file goes too
                        // and the Connect is refused, so a retry starts it again.
                        let file = Arc::new(file);
                        // A file started again for an instance already followed carries where
                        // that left off, so a crash before the bridge's first frame still says
                        // the gap after it (#199 r9).
                        let covered = Some(last_seq.max(skip)).filter(|reach| *reach > 0);
                        let header = journal::Record::Open { code: room.to_string(), created_at: at, members: members.clone(), v: journal::VERSION, covered };
                        if !self.write_now(room, &file, &header) {
                            let _ = file.finish();
                            return Err(format!("The relay journal for {room} could not be written, so Discord does not follow it yet. Try again"));
                        }
                        Some(file)
                    }
                    Err(error) => return Err(self.journal_blocked(room, error)),
                },
            },
            _ => None,
        };
        // An instance this app has journalled before starts where its journal stands, however
        // the last position was lost (a relaunch, a Closed reconnect): the reader opens the
        // bridge past it, and a replay of what the journal holds is passed over as seen,
        // never offered to the journal again (#199 r8).
        if let Some(file) = &journal {
            last_seq = last_seq.max(file.written_through());
            skip = skip.max(file.covered_through());
        }
        let acked = created_at.and_then(|at| self.progress.get(&(room.to_string(), at))).map_or(0, |(acked, _)| (*acked).min(last_seq));
        self.next_feed += 1;
        let mut feed = RoomFeed::new(self.next_feed, members, created_at, last_seq, journal);
        feed.skip = skip;
        feed.acked = acked;
        let line = self.connect_line(room, &feed, false);
        let id = feed.id;
        self.resume.remove(room);
        self.rooms.insert(room.to_string(), feed);
        self.send(&line);
        self.queue_feed(room, id);
        Ok(())
    }

    /// Take lines into a connected room: each is journalled before it can be handed on, and
    /// none is taken past the room's budget. Each comes with the seq it accounts for through (a
    /// gap notice for the seqs it counts). Taken one record at a time: what the journal took is
    /// taken in even when a later record is refused, so a retry is computed from what the
    /// journal holds and never says another gap or loss at a seq already written (#199 r7).
    fn take_in(&mut self, room: &str, lines: Vec<(ToChild, journal::Record, u64)>, force: bool) -> Forwarded {
        let (owed, owed_bytes, cap) = (self.owed_in(room), self.owed_bytes_in(room), self.cap());
        let cap_bytes = if self.cap_bytes == 0 { ROOM_BUDGET_BYTES } else { self.cap_bytes };
        let Some(feed) = self.rooms.get(room) else {
            return Forwarded::Ignored;
        };
        let bytes: usize = lines.iter().map(|(line, ..)| line_bytes(line)).sum();
        if !force && owed > 0 && (owed + lines.len() > cap || owed_bytes + bytes > cap_bytes) {
            return Forwarded::Full;
        }
        let (journal, id) = (feed.journal.clone(), feed.id);
        let mut taken = Forwarded::Taken;
        let mut any = false;
        for (line, mut record, through) in lines {
            // A notice that accounts for seqs past its own says how far, so a relaunch resumes
            // past them and never counts them again (#199 r9).
            if let journal::Record::Line { seq, through: reach, .. } | journal::Record::Loss { seq, through: reach, .. } = &mut record {
                if through > *seq && reach.is_none() {
                    *reach = Some(through);
                }
            }
            if let Some(journal) = &journal {
                if !self.write_now(room, journal, &record) {
                    taken = Forwarded::Blocked;
                    break;
                }
            }
            let Some(feed) = self.rooms.get_mut(room) else {
                return Forwarded::Ignored;
            };
            feed.last_seq = feed.last_seq.max(line_seq(&line));
            feed.skip = feed.skip.max(through);
            feed.bytes += line_bytes(&line);
            feed.unacked.push_back(line);
            any = true;
        }
        if taken == Forwarded::Taken {
            self.journal_errors.remove(room);
        }
        if any {
            self.queue_feed(room, id);
        }
        taken
    }

    /// Forward one room line, in seq order, once. Nothing is taken for a room not connected.
    fn forward(&mut self, line: ToChild) -> Forwarded {
        let (room, seq) = match &line {
            ToChild::Message { room, seq, .. } => (room.clone(), *seq),
            _ => return Forwarded::Ignored,
        };
        let Some(feed) = self.rooms.get(&room) else {
            return Forwarded::Ignored;
        };
        let base = feed.seen_through();
        if seq <= base {
            return Forwarded::Ignored;
        }
        // The relay is handed every seq but its own, and it never posts; so a jump is what
        // the room dropped before it could be read. Said once, at the first missing seq —
        // which no message will ever carry — rather than skipped in silence.
        let mut lines = Vec::new();
        if base > 0 && seq > base + 1 {
            let missed = seq - base - 1;
            lines.push((notice(&room, base + 1, format!("{missed} line{} went by unfollowed", plural(missed))), seq - 1));
        }
        lines.push((line, seq));
        let lines = lines.into_iter().filter_map(|(line, through)| line_record(&line).map(|record| (line, record, through))).collect();
        self.take_in(&room, lines, false)
    }

    /// The bridge's first frame on every open (`event: dropped`): where the relay joined, and
    /// how far the room has dropped lines owed to it. A resume gap below the join is said as
    /// unfollowed, a drop past it as dropped; history before the first join is never said (I4).
    fn on_dropped(&mut self, room: &str, dropped_through: u64, relay_from: u64) -> Forwarded {
        let Some(feed) = self.rooms.get_mut(room) else {
            return Forwarded::Ignored;
        };
        feed.floor = feed.floor.max(relay_from);
        let last = feed.seen_through();
        let mut lines = Vec::new();
        if last > 0 && relay_from > last {
            let missed = relay_from - last;
            lines.push((notice(room, last + 1, format!("{missed} line{} went by unfollowed", plural(missed))), relay_from));
        }
        let mut through = last.max(relay_from);
        if dropped_through > through {
            let lost = dropped_through - through;
            lines.push((notice(room, through + 1, format!("{lost} line{} the room dropped", plural(lost))), dropped_through));
            through = dropped_through;
        }
        if lines.is_empty() {
            feed.skip = feed.skip.max(through);
            return Forwarded::Taken;
        }
        let lines = lines.into_iter().filter_map(|(line, through)| line_record(&line).map(|record| (line, record, through))).collect();
        self.take_in(room, lines, false)
    }

    /// At quit: what the bridge still held unread for the relay dies with it, so it is counted
    /// into the room's journal as one `loss`, said at the next launch (I21, C2). With no answer
    /// from the bridge now, the count is its last answer's, said as "at least", or said as
    /// unknown: never claimed complete. A loss the journal cannot take is still handed to a
    /// running child, and the refusal is shown.
    fn lose_unread(&mut self, room: &str, room_seq: Option<u64>) {
        let Some(feed) = self.rooms.get(room) else {
            return;
        };
        let through = feed.seen_through().max(feed.floor);
        // `reach`: the last seq this loss accounts for, so a relaunch never counts it again.
        let (n, label, reach) = match room_seq {
            Some(seq) if seq <= through => return,
            Some(seq) => (seq - through, UNREAD_AT_QUIT, seq),
            None if feed.bridge_seq > through => (feed.bridge_seq - through, UNREAD_AT_QUIT_AT_LEAST, feed.bridge_seq),
            None => (0, UNREAD_AT_QUIT_UNKNOWN, through + 1),
        };
        let seq = through + 1;
        let created_at = feed.created_at;
        let line = notice(room, seq, loss_text(n, label));
        let record = journal::Record::Loss { seq, n, label: label.to_string(), through: (reach > seq).then_some(reach) };
        // A write the disk refuses once may land a moment later: tried again within the quit's
        // grace. A failed try leaves no partial record (`File::append`), so a later success is
        // the one record. Past that, the separate fallback file holds it for the next launch.
        let mut taken = Forwarded::Blocked;
        for attempt in 0..QUIT_LOSS_TRIES {
            if attempt > 0 {
                thread::sleep(QUIT_LOSS_RETRY);
            }
            taken = self.take_in(room, vec![(line.clone(), record.clone(), reach)], true);
            if taken != Forwarded::Blocked {
                break;
            }
        }
        if taken != Forwarded::Blocked {
            return;
        }
        // The journal refused it through the quit's grace: the fallback file holds it for the
        // next launch, and it waits in the journal's queue, its line not handed on, so the
        // close queued after it can never be journalled or sent ahead of it.
        let (Some(file), Some(at), Some(feed)) = (self.rooms.get(room).and_then(|feed| feed.journal.clone()), created_at, self.rooms.get(room).map(|feed| feed.id)) else {
            return;
        };
        if let Some(Err(error)) = self.journal_dir.as_ref().map(|dir| dir.write_loss(room, at, &record)) {
            self.journal_blocked(room, error);
        }
        self.pending.push_back(Pending { room: room.to_string(), file, record, then: Then::LossLanded { room: room.to_string(), at, feed, line } });
    }

    fn disconnect(&mut self, room: &str, reason: DisconnectReason) -> bool {
        let Some(mut feed) = self.rooms.remove(room) else {
            if reason == DisconnectReason::Closed {
                self.resume.remove(room);
            }
            return false;
        };
        match reason {
            DisconnectReason::Disconnected => {
                self.resume.insert(room.to_string(), (feed.created_at, feed.last_seq, feed.seen_through()));
            }
            DisconnectReason::Closed | DisconnectReason::Ended => {
                self.resume.remove(room);
            }
        }
        // A connection with nothing to say, let go while the last close of the same instance
        // and reason is still owed, adds no second close: the child is told the same close
        // again (the post it reopened is closed), and nothing is kept or journalled. Empty
        // Disconnect/Connect cycles while Discord is down stay one batch (d19). That close
        // stands in for this connection's own, so it is told only when nothing of the file
        // still waits for the journal — a quit's loss for this connection above all; otherwise
        // the connection is kept and closed behind what waits, as any other (#199 r6b).
        if feed.unacked.is_empty() && !self.waiting(feed.journal.as_ref()) {
            let owed = self.draining.get(room).and_then(|batches| batches.last()).filter(|(last, last_reason)| {
                last.close_pending && last.close_durable && last.created_at == feed.created_at && *last_reason == reason
            });
            if let Some(id) = owed.and_then(|(last, _)| last.close_id.clone()) {
                self.send(&ToChild::Disconnect { room: room.to_string(), reason, id });
                return true;
            }
        }
        // Kept until Discord has taken its lines and the child has said this close is done,
        // so a child that dies before closing the post is followed by one that does (#199 I12).
        // The close is journalled before the child can be told of it.
        let id = close_id();
        feed.close_pending = true;
        feed.close_id = Some(id.clone());
        let (journal, at, feed_id) = (feed.journal.clone(), feed.last_seq, feed.id);
        self.draining.entry(room.to_string()).or_default().push((feed, reason));
        self.record(room, journal, journal::Record::Close { id, reason, at }, Then::CloseLanded { room: room.to_string(), feed: feed_id });
        true
    }

    /// Every feed of one room instance, followed or let go.
    fn instance_feeds(&mut self, room: &str, created_at: u64) -> Vec<&mut RoomFeed> {
        let draining = self.draining.get_mut(room).into_iter().flat_map(|batches| batches.iter_mut().map(|(feed, _)| feed));
        self.rooms.get_mut(room).into_iter().chain(draining).filter(|feed| feed.created_at == Some(created_at)).collect()
    }

    /// Discord accepted every line of this room instance up to `seq`. An ACK naming another
    /// instance — a late one for a code's earlier room — or none is not this room's, and none
    /// reaches past what was forwarded.
    fn ack(&mut self, room: &str, seq: u64, created_at: Option<u64>, msg_id: Option<String>) {
        let Some(at) = created_at else {
            return;
        };
        let mut journal = None;
        let mut through = 0;
        for feed in self.instance_feeds(room, at) {
            let seq = seq.min(feed.last_seq);
            through = through.max(seq);
            feed.acked = feed.acked.max(seq);
            while feed.unacked.front().is_some_and(|held| line_seq(held) <= seq) {
                if let Some(line) = feed.unacked.pop_front() {
                    feed.bytes = feed.bytes.saturating_sub(line_bytes(&line));
                }
            }
            journal = journal.or_else(|| feed.journal.clone());
        }
        let key = (room.to_string(), at);
        let (acked, last_msg_id) = self.progress.get(&key).cloned().unwrap_or_default();
        // A dedupe ACK (`msgId` null) moves the watermark, never the anchor: its record carries
        // no id, so the anchor stays paired with the seq that gave it (AUDIT-C).
        if through > acked || (through == acked && through > 0 && msg_id.is_some() && msg_id != last_msg_id) {
            // An ACK clamped to what was forwarded carries no id: an id stays paired with the
            // seq it came with.
            let msg = msg_id.clone().filter(|_| through == seq);
            self.record(room, journal.clone(), journal::Record::Ack { seq: through, msg }, Then::Nothing);
            journal::point("ack_written");
            self.progress.insert(key, (through, msg_id.or(last_msg_id)));
        }
        self.settle(room, at, journal);
    }

    /// The child closed this room instance's post for the close `id`. Any other id, or one
    /// already closed, changes nothing.
    fn closed(&mut self, room: &str, created_at: Option<u64>, id: Option<String>) {
        let (Some(at), Some(id)) = (created_at, id) else {
            return;
        };
        let Some(batches) = self.draining.get_mut(room) else {
            return;
        };
        let Some((feed, _)) = batches.iter_mut().find(|(feed, _)| {
            feed.close_pending && feed.close_durable && !feed.close_acking && feed.created_at == Some(at) && feed.close_id.as_deref() == Some(id.as_str())
        }) else {
            return;
        };
        feed.close_acking = true;
        let (journal, feed_id) = (feed.journal.clone(), feed.id);
        self.record(room, journal, journal::Record::Closeack { id }, Then::CloseAcked { room: room.to_string(), at, feed: feed_id });
    }

    /// The one way a record reaches a journal when its effect can wait: it is written behind
    /// whatever this file still has pending, and its effect runs only once it is in. A refused
    /// write stays pending with the same record — the same close id — and is retried.
    fn record(&mut self, room: &str, file: Option<Arc<journal::File>>, record: journal::Record, then: Then) {
        match file {
            Some(file) => {
                self.pending.push_back(Pending { room: room.to_string(), file, record, then });
                self.flush_pending();
            }
            None => self.then(then),
        }
    }

    /// The same rule for a record whose item the caller still holds (a line the bridge will
    /// send again, a Connect): written now, behind nothing pending, or refused.
    fn write_now(&mut self, room: &str, file: &Arc<journal::File>, record: &journal::Record) -> bool {
        if self.waiting(Some(file)) {
            self.journal_blocked(room, "earlier records of this room are still waiting for the journal");
            return false;
        }
        match append_once(file, record) {
            Ok(()) => true,
            Err(error) => {
                self.journal_blocked(room, error);
                false
            }
        }
    }

    /// Whether any record of this file still waits for the journal: what it authorises has
    /// not happened, so nothing that must come after it may happen either.
    fn waiting(&self, file: Option<&Arc<journal::File>>) -> bool {
        file.is_some_and(|file| self.pending.iter().any(|pending| Arc::ptr_eq(&pending.file, file)))
    }

    /// Try every pending record, oldest first per file; a file stops at its first refusal.
    fn flush_pending(&mut self) {
        if self.flushing {
            return;
        }
        self.flushing = true;
        let mut refused: Vec<Arc<journal::File>> = Vec::new();
        let mut index = 0;
        while index < self.pending.len() {
            if refused.iter().any(|file| Arc::ptr_eq(file, &self.pending[index].file)) {
                index += 1;
                continue;
            }
            let written = {
                let pending = &self.pending[index];
                // A loss is synced before its fallback may go; anything else is in once
                // write(2) returns (C1).
                match &pending.record {
                    journal::Record::Loss { .. } => append_once(&pending.file, &pending.record).and_then(|()| {
                        journal::point("merge_appended");
                        pending.file.sync()
                    }),
                    record => append_once(&pending.file, record),
                }
            };
            match written {
                Ok(()) => {
                    if let Some(pending) = self.pending.remove(index) {
                        self.then(pending.then);
                    }
                }
                Err(error) => {
                    let (room, file) = (self.pending[index].room.clone(), Arc::clone(&self.pending[index].file));
                    self.journal_blocked(&room, error);
                    journal::point("record_refused");
                    refused.push(file);
                    index += 1;
                }
            }
        }
        self.flushing = false;
    }

    /// What a record authorised, now that it is in.
    fn then(&mut self, then: Then) {
        match then {
            Then::Nothing => {}
            Then::CloseLanded { room, feed } => {
                let Some((feed, reason)) = self.draining.get_mut(&room).and_then(|batches| batches.iter_mut().find(|(entry, _)| entry.id == feed)) else {
                    return;
                };
                feed.close_durable = true;
                journal::point("close_landed");
                if let (true, Some(id)) = (feed.close_pending, feed.close_id.clone()) {
                    let reason = *reason;
                    self.send(&ToChild::Disconnect { room, reason, id });
                }
            }
            Then::CloseAcked { room, at, feed } => {
                let found = self.draining.get_mut(&room).and_then(|batches| batches.iter_mut().find(|(entry, _)| entry.id == feed));
                let Some((feed, _)) = found else {
                    return;
                };
                feed.close_pending = false;
                let journal = feed.journal.clone();
                self.settle(&room, at, journal);
            }
            Then::LossLanded { room, at, feed, line } => {
                journal::point("merge_synced");
                if let Some(dir) = &self.journal_dir {
                    dir.drop_loss(&room, at);
                }
                let draining = self.draining.get_mut(&room).into_iter().flat_map(|batches| batches.iter_mut().map(|(entry, _)| entry));
                let target = self.rooms.get_mut(&room).into_iter().chain(draining).find(|entry| entry.id == feed);
                if let Some(entry) = target {
                    let seq = line_seq(&line);
                    entry.bytes += line_bytes(&line);
                    entry.last_seq = entry.last_seq.max(seq);
                    entry.unacked.push_back(line);
                    let id = entry.id;
                    self.queue_feed(&room, id);
                }
            }
        }
    }

    /// After an ACK or a close: let go of what is done; a room instance with nothing left
    /// followed or draining has its journal synced and deleted, which may make room for a
    /// parked one; one that grew past its size is compacted.
    fn settle(&mut self, room: &str, at: u64, journal: Option<Arc<journal::File>>) {
        self.flush_pending();
        if let Some(batches) = self.draining.get_mut(room) {
            batches.retain(|(feed, _)| !feed.done());
            if batches.is_empty() {
                self.draining.remove(room);
            }
        }
        let Some(file) = journal else {
            return;
        };
        if self.instance_feeds(room, at).is_empty() && !self.waiting(Some(&file)) {
            let finished = file.sync().and_then(|()| file.finish());
            if let Err(error) = finished {
                self.journal_blocked(room, error);
            }
            self.progress.remove(&(room.to_string(), at));
            self.refill();
            return;
        }
        let over = if self.compact_over == 0 { JOURNAL_COMPACT_FACTOR * ROOM_BUDGET_BYTES as u64 } else { self.compact_over };
        if file.size() > over {
            if let Err(error) = file.compact() {
                self.journal_blocked(room, error);
            }
        }
        // An ACK frees room in the window as a finished journal does.
        self.refill();
    }

    /// Sync every journal: before quitting, and before the bridge is told a position (I1).
    fn sync_all(&mut self) {
        self.flush_pending();
        let mut files: Vec<(String, Arc<journal::File>)> = Vec::new();
        let draining = self.draining.iter().flat_map(|(room, batches)| batches.iter().map(move |(feed, _)| (room, feed)));
        for (room, feed) in self.rooms.iter().chain(draining) {
            if let Some(file) = &feed.journal {
                if !files.iter().any(|(_, held)| Arc::ptr_eq(held, file)) {
                    files.push((room.clone(), Arc::clone(file)));
                }
            }
        }
        for (room, file) in files {
            if let Err(error) = file.sync() {
                self.journal_blocked(&room, error);
            }
        }
    }

    /// Remove: nothing will deliver these later, so every journal goes, parked ones included.
    fn discard_journals(&mut self) {
        self.pending.clear();
        let draining = self.draining.values().flatten().map(|(feed, _)| feed);
        let files: Vec<Arc<journal::File>> = self.rooms.values().chain(draining).filter_map(|feed| feed.journal.clone()).collect();
        let mut seen: Vec<Arc<journal::File>> = Vec::new();
        for file in files {
            if !seen.iter().any(|held| Arc::ptr_eq(held, &file)) {
                let _ = file.finish();
                seen.push(file);
            }
        }
        self.progress.clear();
        if let Some(dir) = &self.journal_dir {
            for name in self.parked.drain(..) {
                let _ = dir.discard(&name);
            }
            for name in std::mem::take(&mut self.refused) {
                let _ = dir.discard(&name);
                self.journal_errors.remove(&name);
            }
        }
    }

    fn refuse(&mut self, corrupt: journal::Corrupt) {
        if !corrupt.name.is_empty() && !self.refused.contains(&corrupt.name) {
            self.refused.push(corrupt.name.clone());
        }
        let at = if corrupt.line == 0 { String::new() } else { format!(" at line {}", corrupt.line) };
        self.journal_errors.insert(
            corrupt.name.clone(),
            DiscordError {
                code: JOURNAL_CORRUPT.to_string(),
                message: format!("The relay journal {} is not replayed: {}{at}. It is left as it is", corrupt.name, corrupt.why),
            },
        );
    }

    /// Journals left by earlier launches, by name, oldest first. Only what the window holds is
    /// opened and read; the rest stay names until there is room (d26).
    fn recover(&mut self, names: Vec<String>) {
        self.parked.extend(names);
        self.refill();
    }

    /// Open and read one journal by name, and load it.
    fn load(&mut self, name: &str) {
        let Some(dir) = self.journal_dir.as_ref() else {
            return;
        };
        match dir.recover_one(name) {
            Ok(Some(recovered)) => self.install(recovered.parsed, Arc::new(recovered.file)),
            Ok(None) => {}
            Err(corrupt) => self.refuse(corrupt),
        }
    }

    /// Load parked journals, oldest first, while what is loaded — lines and closes still
    /// owed alike — is below the window. A close-only journal takes room too.
    fn refill(&mut self) {
        let window = if self.window == 0 { LAUNCH_WINDOW } else { self.window };
        while !self.parked.is_empty() {
            let loaded: usize = self.owed(true).values().sum();
            if loaded >= window {
                return;
            }
            if let Some(name) = self.parked.pop_front() {
                self.load(&name);
            }
        }
    }

    /// One recovered journal's batches into `draining`, each with its close: a tail the app
    /// ended under gets an `Ended` close, recorded behind anything still pending for it.
    fn install(&mut self, mut parsed: journal::Parsed, file: Arc<journal::File>) {
        let room = parsed.code.clone();
        let loss = match self.merge_loss(&mut parsed, &file) {
            Ok(loss) => loss,
            Err(corrupt) => {
                // Not replayed and not closed: a close now would say the room ended with its
                // loss unsaid. Both files stay as they are, shown, until Remove.
                self.refuse(corrupt);
                self.refuse(journal::Corrupt { name: journal::file_name(&parsed.code, parsed.created_at), line: 0, why: "its quit's loss record is unreadable".to_string() });
                return;
            }
        };
        self.progress.insert((room.clone(), parsed.created_at), (parsed.acked, parsed.last_msg_id.clone()));
        let tail = parsed.batches.len().saturating_sub(1);
        for (index, batch) in parsed.batches.into_iter().enumerate() {
            self.next_feed += 1;
            let last = batch.items.iter().map(journal::Item::seq).max().unwrap_or(0).max(batch.close.as_ref().map_or(0, |close| close.at));
            let mut feed = RoomFeed::new(self.next_feed, parsed.members.clone(), Some(parsed.created_at), last, Some(Arc::clone(&file)));
            feed.acked = parsed.acked;
            for item in batch.items {
                let line = item_line(&room, item);
                feed.bytes += line_bytes(&line);
                feed.unacked.push_back(line);
            }
            let (id, reason, journalled) = match batch.close {
                Some(close) => {
                    feed.close_pending = !close.acked;
                    feed.close_durable = true;
                    (close.id, close.reason, true)
                }
                None => {
                    feed.close_pending = true;
                    (close_id(), DisconnectReason::Ended, false)
                }
            };
            feed.close_id = Some(id.clone());
            let connect = self.connect_line(&room, &feed, true);
            let (feed_id, pending) = (feed.id, feed.close_pending);
            self.draining.entry(room.clone()).or_default().push((feed, reason));
            if self.channel.is_some() {
                self.send(&connect);
                self.queue_feed(&room, feed_id);
            }
            // The fallback's loss goes into the journal first, its line handed on once it is
            // in; the tail's close is recorded behind it.
            if index == tail {
                if let Some((record, line)) = loss.clone() {
                    let at = parsed.created_at;
                    self.pending.push_back(Pending { room: room.clone(), file: Arc::clone(&file), record, then: Then::LossLanded { room: room.clone(), at, feed: feed_id, line } });
                }
            }
            if journalled {
                if pending {
                    self.send(&ToChild::Disconnect { room: room.clone(), reason, id });
                }
            } else {
                self.record(&room, Some(Arc::clone(&file)), journal::Record::Close { id, reason, at: last }, Then::CloseLanded { room: room.clone(), feed: feed_id });
            }
        }
    }

    /// A quit's loss record left in the fallback file belongs in the journal's open tail, before
    /// the tail's close. Answers it, with its line, when it is still to be written; a fallback
    /// already in the journal (a merge that crashed before the unlink) is let go.
    fn merge_loss(&mut self, parsed: &mut journal::Parsed, file: &journal::File) -> Result<Option<(journal::Record, ToChild)>, journal::Corrupt> {
        let Some(dir) = self.journal_dir.as_ref() else {
            return Ok(None);
        };
        let Some(record) = dir.read_loss(&parsed.code, parsed.created_at)? else {
            return Ok(None);
        };
        let journal::Record::Loss { seq, n, label, through } = record.clone() else {
            return Ok(None);
        };
        let (code, at) = (parsed.code.clone(), parsed.created_at);
        let loss = journal::Item::Loss { seq, n, label, through };
        let refused = |why: &str| journal::Corrupt { name: format!("{code}@{at}.loss"), line: 1, why: why.to_string() };
        if seq <= parsed.last_seq {
            let present = seq <= parsed.acked || parsed.batches.iter().any(|batch| batch.items.contains(&loss));
            if !present {
                return Err(refused("its seq is one the journal already holds, with other content"));
            }
            // The journal's copy may sit in bytes the life that wrote it never synced: the
            // fallback goes only once this life has synced them, and stays for the next launch
            // otherwise (#199 r9).
            if file.sync().is_ok() {
                dir.drop_loss(&code, at);
            }
            return Ok(None);
        }
        // After the last close (acknowledged or not) it starts a tail of its own.
        if parsed.batches.last().is_none_or(|batch| batch.close.is_some()) {
            parsed.batches.push(journal::Batch { items: Vec::new(), close: None });
        }
        Ok(Some((record, item_line(&code, loss))))
    }

    /// Lines handed to the child that Discord has not taken, followed or draining — a close not
    /// yet said counts as its closing line, since waiting for Discord means waiting for it too.
    fn undelivered(&self) -> BTreeMap<String, usize> {
        self.owed(true)
    }

    /// The room's own lines alone: what Remove says it could not send.
    fn undelivered_messages(&self) -> BTreeMap<String, usize> {
        self.owed(false)
    }

    fn owed(&self, closes: bool) -> BTreeMap<String, usize> {
        let mut out: BTreeMap<String, usize> = BTreeMap::new();
        let draining = self.draining.iter().flat_map(|(room, batches)| batches.iter().map(move |(feed, _)| (room, feed)));
        for (room, feed) in self.rooms.iter().chain(draining) {
            let owed = if closes { feed.owed() } else { feed.unacked.len() };
            if owed > 0 {
                *out.entry(room.clone()).or_default() += owed;
            }
        }
        out
    }

    /// Which lines Discord has not taken, per room, as seq ranges and senders (#199 I21).
    fn undelivered_lines(&self) -> BTreeMap<String, String> {
        let mut held: BTreeMap<String, Vec<&ToChild>> = BTreeMap::new();
        let draining = self.draining.iter().flat_map(|(room, batches)| batches.iter().map(move |(feed, _)| (room, feed)));
        for (room, feed) in self.rooms.iter().chain(draining) {
            held.entry(room.clone()).or_default().extend(feed.unacked.iter());
        }
        held.into_iter().filter_map(|(room, lines)| not_relayed(lines).map(|text| (room, text))).collect()
    }

    /// How many of a connected room's lines wait for Discord; `None` once it is not connected.
    #[cfg(test)]
    fn backlog(&self, room: &str) -> Option<usize> {
        self.rooms.get(room).map(|feed| feed.unacked.len())
    }

    /// Every line one room code holds in memory, followed and draining: the one budget (I14).
    fn owed_in(&self, room: &str) -> usize {
        let draining: usize = self.draining.get(room).map_or(0, |batches| batches.iter().map(|(feed, _)| feed.unacked.len()).sum());
        self.rooms.get(room).map_or(0, |feed| feed.unacked.len()) + draining
    }

    fn owed_bytes_in(&self, room: &str) -> usize {
        let draining: usize = self.draining.get(room).map_or(0, |batches| batches.iter().map(|(feed, _)| feed.bytes).sum());
        self.rooms.get(room).map_or(0, |feed| feed.bytes) + draining
    }

    fn cap(&self) -> usize {
        if self.cap == 0 { UNACKED_CAP } else { self.cap }
    }

    fn pairing_code(&self) -> Option<String> {
        self.pairing.as_ref().filter(|pairing| pairing.at.elapsed() < PAIRING_TTL).map(|pairing| pairing.code.clone())
    }

    /// Forget everything the last child said about Discord: its token changed, it failed for
    /// good, or it is gone. Nothing it said holds for the next one until that one is ready.
    fn forget_child(&mut self) {
        self.ready = false;
        self.bot = None;
        self.application_id = None;
        self.forums.clear();
        self.pairing = None;
    }
}

fn lock(hub: &Mutex<Hub>) -> MutexGuard<'_, Hub> {
    hub.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ── what this side depends on, injectable for the tests ──

/// Where the bot token is kept: the Keychain, or a fake in the tests.
pub(crate) trait TokenStore: Send + Sync {
    fn read(&self) -> Option<BotToken>;
    fn write(&self, token: &BotToken) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// The non-secret settings: the forum picked and the paired owner.
pub(crate) trait SettingsStore: Send + Sync {
    fn get(&self, key: &str) -> Option<serde_json::Value>;
    /// Every change in one write, or none of them.
    fn set(&self, changes: &[(&str, Option<serde_json::Value>)]) -> Result<(), String>;
}

fn text(value: Option<serde_json::Value>) -> Option<String> {
    value.and_then(|value| value.as_str().map(ToOwned::to_owned))
}

/// Where the paired owner is kept: one Keychain item, or a fake in the tests.
pub(crate) trait OwnerStore: Send + Sync {
    fn read(&self) -> Option<Owner>;
    /// The whole record in one call.
    fn write(&self, owner: &Owner, paired_at: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// The owner record as stored; one that does not read as one is no owner.
fn owner_from_record(bytes: &[u8]) -> Option<Owner> {
    let record: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let id = record.get("id")?.as_str()?.to_string();
    let username = record.get("username")?.as_str()?.to_string();
    valid_snowflake(&id).then_some(Owner { id, username: Some(username) })
}

/// A room's members, and when this room — not its code — was created.
#[derive(Clone, Debug, Default)]
pub(crate) struct Roster {
    pub members: Vec<RoomMember>,
    pub created_at: Option<u64>,
    /// The room's last seq: what the relay has not read is counted from it at quit (I21).
    pub seq: Option<u64>,
}

/// A member as the room shows it.
#[derive(Clone, Debug)]
pub(crate) struct RoomMember {
    pub id: String,
    pub shown: String,
}

#[derive(Debug)]
pub(crate) enum SourceError {
    /// The room has ended.
    Gone,
    /// The relay is no longer in it, or its password no longer opens it.
    Removed,
    /// Not reachable just now; try again.
    Unavailable,
}

/// The bridge, as the reader needs it.
pub(crate) trait RoomSource: Send + Sync {
    fn members(&self, room: &str, as_id: &str) -> Result<Roster, SourceError>;
    /// The room's stream after `since`, the last seq this side fully read and queued. The
    /// bridge takes it as the relay's read position, and never goes back before the relay
    /// joined, so 0 means "from when it joined".
    ///
    /// Read as the relay, which the bridge allows only on the app's word (`app_word`) with the
    /// machine token: the relay's position is the room's trim floor, and every member holds
    /// the room's password.
    fn open(&self, room: &str, as_id: &str, app_word: &str, since: u64) -> Result<Box<dyn Read + Send>, SourceError>;
    /// Tell the bridge Discord holds the room up to `seq`, so the relay's read position — the
    /// room's trim floor — follows Discord within a stream, not only at the next open.
    fn ack(&self, room: &str, as_id: &str, app_word: &str, seq: u64) -> Result<(), SourceError>;
    /// Which bridge is running; a different answer means every room has ended.
    fn generation(&self) -> u64;
}

/// The app's own acts on a room, which take the broker's secret.
pub(crate) trait RoomActs: Send + Sync {
    fn password(&self, room: &str) -> Option<String>;
    fn join_relay(&self, room: &str, member: &str, app_word: &str) -> Result<(), String>;
    fn leave(&self, room: &str, member: &str, app_word: &str) -> Result<(), String>;
}

pub(crate) struct Deps {
    pub tokens: Box<dyn TokenStore>,
    pub settings: Arc<dyn SettingsStore>,
    pub owners: Arc<dyn OwnerStore>,
    pub source: Arc<dyn RoomSource>,
    pub acts: Box<dyn RoomActs>,
    pub state_path: PathBuf,
    pub log: SupervisorLog,
}

// ── the managed state ──

struct SupervisorHandle {
    stop_tx: mpsc::Sender<()>,
    join: JoinHandle<()>,
}

struct ReaderHandle {
    stop: Arc<AtomicBool>,
    join: JoinHandle<()>,
}

pub(crate) struct DiscordState {
    hub: Arc<Mutex<Hub>>,
    deps: Deps,
    supervisor: Mutex<Option<SupervisorHandle>>,
    readers: Mutex<HashMap<String, ReaderHandle>>,
    launch: Mutex<Option<(PathBuf, PathBuf)>>,
    /// Whether a token is kept, as last read or written — so a status poll never asks the
    /// Keychain.
    configured: AtomicBool,
}

impl Default for DiscordState {
    fn default() -> Self {
        Self::with(Deps {
            tokens: Box::new(KeychainTokens),
            settings: Arc::new(ConfigSettings),
            owners: Arc::new(KeychainOwner),
            source: Arc::new(BridgeSource { target: None }),
            acts: Box::new(BridgeActs),
            state_path: crate::home_dir()
                .map(|home| home.join(".config").join("gyredeck").join("discord-state.json"))
                .unwrap_or_else(|| PathBuf::from("discord-state.json")),
            log: SupervisorLog::at(standalone_bridge::supervisor_log_path()),
        })
    }
}

/// The member id the relay takes in a room: one per room, since a member is in one room.
pub(crate) fn relay_member(room: &str) -> String {
    format!("discord-{room}")
}

fn valid_sync_code(code: &str) -> bool {
    code.len() == 9
        && code.starts_with("sync-")
        && code[5..].bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'9').contains(&b))
}

fn valid_snowflake(id: &str) -> bool {
    (17..=21).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

impl DiscordState {
    pub(crate) fn with(deps: Deps) -> Self {
        // An owner id an earlier build left in the config never counts; it is deleted.
        if LEGACY_OWNER_KEYS.iter().any(|key| deps.settings.get(key).is_some()) {
            let _ = deps.settings.set(&LEGACY_OWNER_KEYS.map(|key| (key, None)));
        }
        let mut hub = Hub {
            forum_id: text(deps.settings.get(CONFIG_FORUM)),
            owner: deps.owners.read(),
            ..Hub::default()
        };
        let journal_path = deps.state_path.parent().map(|dir| dir.join(JOURNAL_DIR)).unwrap_or_else(|| PathBuf::from(JOURNAL_DIR));
        match journal::Dir::open(&journal_path) {
            Ok(dir) => {
                let scanned = dir.scan();
                hub.journal_dir = Some(dir);
                let orphans = hub.journal_dir.as_ref().map(journal::Dir::orphan_losses).unwrap_or_default();
                for orphan in orphans {
                    hub.refuse(orphan);
                }
                match scanned {
                    Ok(names) => hub.recover(names),
                    Err(corrupt) => hub.refuse(corrupt),
                }
            }
            Err(error) => {
                let why = format!("{} is not a private directory this app can use ({error})", journal_path.display());
                hub.journal_errors.insert(String::new(), DiscordError { code: JOURNAL_BLOCKED.to_string(), message: why.clone() });
                hub.journal_down = Some(why);
            }
        }
        let hub = Arc::new(Mutex::new(hub));
        lock(&hub).me = Arc::downgrade(&hub);
        Self {
            hub,
            deps,
            supervisor: Mutex::new(None),
            readers: Mutex::new(HashMap::new()),
            launch: Mutex::new(None),
            configured: AtomicBool::new(false),
        }
    }

    /// Remember how to launch the connector, and launch it if a token is kept. With none,
    /// nothing starts: no process, no thread, no timer.
    pub(crate) fn start(&self, node: PathBuf, script: PathBuf) -> Result<(), String> {
        if let Ok(mut launch) = self.launch.lock() {
            *launch = Some((node, script));
        }
        self.start_supervisor()
    }

    fn start_supervisor(&self) -> Result<(), String> {
        let Some((node, script)) = self.launch.lock().ok().and_then(|launch| launch.clone()) else {
            return Err("The Discord connector is not part of this build".to_string());
        };
        let token = self.deps.tokens.read();
        self.configured.store(token.is_some(), Ordering::SeqCst);
        let Some(token) = token else {
            return Ok(());
        };
        if !script.is_file() {
            return Err(format!("The Discord connector is missing: {}", script.display()));
        }
        let mut supervisor = self
            .supervisor
            .lock()
            .map_err(|_| "The Discord supervisor is unavailable".to_string())?;
        if supervisor.is_some() {
            return Ok(());
        }
        let (stop_tx, stop_rx) = mpsc::channel();
        let hub = Arc::clone(&self.hub);
        let state_path = self.deps.state_path.display().to_string();
        let log = self.deps.log.clone();
        let owners = Arc::clone(&self.deps.owners);
        let join = thread::Builder::new()
            .name("gyredeck-discord-supervisor".to_string())
            .spawn(move || supervise(Launch { node, script, token, state_path, owners }, hub, stop_rx, log))
            .map_err(|error| format!("Could not start the Discord supervisor: {error}"))?;
        *supervisor = Some(SupervisorHandle { stop_tx, join });
        Ok(())
    }

    fn stop_supervisor(&self) {
        let handle = self.supervisor.lock().ok().and_then(|mut slot| slot.take());
        if let Some(handle) = handle {
            let _ = handle.stop_tx.send(());
            let _ = handle.join.join();
        }
    }

    fn is_running(&self) -> bool {
        self.supervisor.lock().map(|slot| slot.is_some()).unwrap_or(false)
    }

    /// The app is quitting, and its bridge — every room — goes with it. What Rust holds is
    /// journalled and stays for the next launch; what the bridge held unread for the relay is
    /// counted as a `loss`; every close is journalled; all of it is synced before the child is
    /// stopped. No `End`: these lines are late, not lost (#199 C3, d18).
    pub(crate) fn shutdown(&self) {
        let rooms: Vec<String> = lock(&self.hub).rooms.keys().cloned().collect();
        self.stop_readers();
        for room in rooms {
            let room_seq = self.deps.source.members(&room, &relay_member(&room)).ok().and_then(|roster| roster.seq);
            let mut hub = lock(&self.hub);
            hub.lose_unread(&room, room_seq);
            hub.disconnect(&room, DisconnectReason::Closed);
        }
        lock(&self.hub).sync_all();
        self.wait_drained(QUIT_DRAIN);
        self.stop_supervisor();
    }

    /// Give a running child up to `limit` to take what it holds to Discord.
    fn wait_drained(&self, limit: Duration) {
        let until = Instant::now() + limit;
        while Instant::now() < until {
            {
                let hub = lock(&self.hub);
                if hub.channel.is_none() || hub.undelivered().is_empty() {
                    return;
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn stop_readers(&self) {
        let readers: Vec<ReaderHandle> = self
            .readers
            .lock()
            .map(|mut readers| readers.drain().map(|(_, handle)| handle).collect())
            .unwrap_or_default();
        for reader in &readers {
            reader.stop.store(true, Ordering::SeqCst);
        }
        for reader in readers {
            let _ = reader.join.join();
        }
    }

    pub(crate) fn status(&self) -> DiscordStatus {
        let configured = self.configured.load(Ordering::SeqCst);
        let hub = lock(&self.hub);
        DiscordStatus {
            configured,
            running: self.is_running() && hub.channel.is_some(),
            ready: hub.ready && hub.channel.is_some(),
            bot: hub.bot.clone(),
            forums: hub.forums.clone(),
            forum_id: hub.forum_id.clone(),
            owner: hub.owner.clone(),
            invite_url: hub.application_id.as_ref().map(|id| {
                format!("https://discord.com/oauth2/authorize?client_id={id}&scope=bot%20applications.commands&permissions={INVITE_PERMISSIONS}")
            }),
            connected_rooms: hub.rooms.keys().cloned().collect(),
            leaving: hub.leaving.clone(),
            behind: hub.undelivered(),
            dropped: hub.dropped.clone(),
            dropped_lines: hub.dropped_lines.clone(),
            pairing_code: hub.pairing_code(),
            error: hub.error.clone(),
            held: hub.parked.len(),
            journal_errors: hub.journal_errors.clone(),
        }
    }

    pub(crate) fn set_token(&self, raw: &str, app_word: Option<&str>) -> Result<DiscordStatus, String> {
        let token = BotToken::parse(raw)?;
        if let Err(error) = self.deps.tokens.write(&token) {
            // A failed replace may have taken the old token with it: believe the Keychain, and
            // stop following every room the way Remove does, relay members out included.
            if self.deps.tokens.read().is_none() {
                self.configured.store(false, Ordering::SeqCst);
                let failed = self.stop_following(app_word);
                if !failed.is_empty() {
                    return Err(format!("{error}; and {}", failed.join("; ")));
                }
            }
            return Err(error);
        }
        self.configured.store(true, Ordering::SeqCst);
        self.stop_supervisor();
        {
            let mut hub = lock(&self.hub);
            hub.error = None;
            hub.dropped.clear();
            hub.dropped_lines.clear();
            hub.forget_child();
        }
        self.start_supervisor()?;
        Ok(self.status())
    }

    pub(crate) fn set_forum(&self, forum_id: &str) -> Result<DiscordStatus, String> {
        if !valid_snowflake(forum_id) {
            return Err("That is not a Discord channel id".to_string());
        }
        self.deps.settings.set(&[(CONFIG_FORUM, Some(serde_json::Value::from(forum_id)))])?;
        let mut hub = lock(&self.hub);
        hub.forum_id = Some(forum_id.to_string());
        hub.send(&ToChild::Forum { forum_id: forum_id.to_string() });
        // Every followed room's `connect` again, so a room the child parked for want of a
        // forum takes up again — a no-op for a room already posting. Its lines are not sent a
        // second time: a seq goes to a child once (I4).
        let again: Vec<ToChild> = hub.rooms.iter().map(|(room, feed)| hub.connect_line(room, feed, false)).collect();
        for line in &again {
            hub.send(line);
        }
        drop(hub);
        Ok(self.status())
    }

    pub(crate) fn start_pairing(&self) -> Result<String, String> {
        let code = pairing_code()?;
        let mut hub = lock(&self.hub);
        if hub.channel.is_none() {
            return Err("Discord is not running. Save a bot token first".to_string());
        }
        let round = random_hex(16)?;
        hub.pairing = Some(Pairing { code: code.clone(), round: round.clone(), at: Instant::now() });
        hub.send(&ToChild::Pair { code: code.clone(), round });
        Ok(code)
    }

    /// Stop following every room, stop the connector, forget the token, the forum and the
    /// owner. The posts already made stay on Discord.
    /// Stop following every room: disconnect each (the relay leaves), let the connector take
    /// what it holds, stop it, and keep what it could not take as `dropped`. The one path for
    /// Remove and for a token the Keychain lost (#199 r6). Answers the leaves that failed.
    fn stop_following(&self, app_word: Option<&str>) -> Vec<String> {
        let rooms: Vec<String> = {
            let hub = lock(&self.hub);
            hub.rooms.keys().chain(hub.leaving.keys()).cloned().collect()
        };
        let mut failed = Vec::new();
        for room in rooms {
            if let Err(error) = self.disconnect(&room, app_word) {
                failed.push(error);
            }
        }
        self.wait_drained(REMOVE_DRAIN);
        lock(&self.hub).send(&ToChild::End {});
        self.stop_supervisor();
        let mut hub = lock(&self.hub);
        let dropped = hub.undelivered_messages();
        hub.dropped.extend(dropped);
        let lines = hub.undelivered_lines();
        hub.dropped_lines.extend(lines);
        // No token is left to deliver them later (C3): the journals go with what was said.
        hub.discard_journals();
        hub.draining.clear();
        hub.forget_child();
        failed
    }

    pub(crate) fn remove(&self, app_word: Option<&str>) -> Result<DiscordStatus, String> {
        let failed = self.stop_following(app_word);
        self.deps.tokens.delete()?;
        self.configured.store(false, Ordering::SeqCst);
        self.deps.owners.delete()?;
        self.deps.settings.set(&[(CONFIG_FORUM, None)])?;
        let mut hub = lock(&self.hub);
        let leaving = std::mem::take(&mut hub.leaving);
        // Whatever Discord had not taken when the connector stopped is said, per room.
        let dropped = std::mem::take(&mut hub.dropped);
        let dropped_lines = std::mem::take(&mut hub.dropped_lines);
        // Epochs only go up, so a dead child's last lines never count as a later one's.
        let epoch = hub.epoch;
        // The journal directory and the stdin writer's bookkeeping outlive the reset: a writer
        // still handing over the last lines (the `end`) finishes them.
        let (me, wake, journal_dir, journal_down, writer, outbox) =
            (hub.me.clone(), Arc::clone(&hub.wake), hub.journal_dir.take(), hub.journal_down.take(), hub.writer, std::mem::take(&mut hub.outbox));
        *hub = Hub { leaving, dropped, dropped_lines, epoch, me, wake, journal_dir, journal_down, writer, outbox, ..Hub::default() };
        drop(hub);
        if !failed.is_empty() {
            return Err(format!("Discord was removed, but {}", failed.join("; ")));
        }
        Ok(self.status())
    }

    /// Follow a room this app founded on Discord: join it as the relay, then read it.
    pub(crate) fn connect(&self, room: &str, app_word: &str) -> Result<DiscordStatus, String> {
        if !valid_sync_code(room) {
            return Err("Not a room code".to_string());
        }
        if !self.configured.load(Ordering::SeqCst) {
            return Err("Discord is not set up. Add a bot token in Settings → Permission".to_string());
        }
        // Holding the password is how this app knows it founded the room; the reader itself
        // reads on the app's word, not the password.
        if self.deps.acts.password(room).is_none() {
            return Err("Only a room this app created can be followed on Discord".to_string());
        }
        {
            let hub = lock(&self.hub);
            if !(hub.ready && hub.channel.is_some()) {
                return Err("Discord is not ready yet. Check the bot token and its Message Content intent in Settings → Permission".to_string());
            }
            if hub.forum_id.is_none() {
                return Err("Pick a Discord forum channel first".to_string());
            }
            if hub.rooms.contains_key(room) {
                return Ok(self.status());
            }
        }
        let member = relay_member(room);
        let generation = self.deps.source.generation();
        self.deps.acts.join_relay(room, &member, app_word)?;
        // Followed again: the member that could not be taken out is the one now reading.
        lock(&self.hub).leaving.remove(room);
        // The room's members and, above all, which room instance it is: without that, a code
        // reused after a restart could be posted into the earlier room's post. No guess is
        // made — the relay is taken out again and the connect fails (#199 r4).
        let roster = match self.deps.source.members(room, &member) {
            Ok(roster) if roster.created_at.is_some() => roster,
            _ => {
                if let Err(error) = self.deps.acts.leave(room, &member, app_word) {
                    lock(&self.hub).leaving.insert(room.to_string(), error);
                }
                return Err("Could not read the room from Gyredeck's bridge, so Discord does not follow it. Try again".to_string());
            }
        };
        let names: HashMap<String, String> =
            roster.members.iter().map(|entry| (entry.id.clone(), entry.shown.clone())).collect();
        let room_seq = roster.seq;
        let connected = lock(&self.hub).connect(room, roster.members.into_iter().map(|entry| entry.shown).collect(), roster.created_at);
        if let Some(feed) = lock(&self.hub).rooms.get_mut(room) {
            feed.bridge_seq = room_seq.unwrap_or(0);
        }
        if let Err(error) = connected {
            if let Err(left) = self.deps.acts.leave(room, &member, app_word) {
                lock(&self.hub).leaving.insert(room.to_string(), left);
            }
            return Err(error);
        }
        // Over the room code's budget already (lines still draining from an earlier connection):
        // the reader starts paused, so nothing is opened and the bridge's floor holds (I14, d19).
        let paused = {
            let hub = lock(&self.hub);
            hub.owed_in(room) >= hub.cap()
        };

        let stop = Arc::new(AtomicBool::new(false));
        let reader = RoomReader {
            room: room.to_string(),
            member,
            app_word: app_word.to_string(),
            generation,
            names,
            shown_checked: HashMap::new(),
            names_stale: false,
            source: Arc::clone(&self.deps.source),
            hub: Arc::clone(&self.hub),
            stop: Arc::clone(&stop),
            acked_sent: 0,
            ack_at: Instant::now(),
            paused,
        };
        let join = thread::Builder::new()
            .name(format!("gyredeck-discord-{room}"))
            .spawn(move || reader.run())
            .map_err(|error| format!("Could not start reading the room: {error}"))?;
        if let Ok(mut readers) = self.readers.lock() {
            if let Some(old) = readers.insert(room.to_string(), ReaderHandle { stop, join }) {
                old.stop.store(true, Ordering::SeqCst);
            }
        }
        Ok(self.status())
    }

    pub(crate) fn disconnect(&self, room: &str, app_word: Option<&str>) -> Result<DiscordStatus, String> {
        if !valid_sync_code(room) {
            return Err("Not a room code".to_string());
        }
        let reader = self.readers.lock().ok().and_then(|mut readers| readers.remove(room));
        if let Some(reader) = reader {
            reader.stop.store(true, Ordering::SeqCst);
            let _ = reader.join.join();
        }
        let (was_connected, was_leaving) = {
            let mut hub = lock(&self.hub);
            (hub.disconnect(room, DisconnectReason::Disconnected), hub.leaving.contains_key(room))
        };
        if !was_connected && !was_leaving {
            return Ok(self.status());
        }
        let left = match app_word {
            Some(word) => self.deps.acts.leave(room, &relay_member(room), word),
            None => Err("Gyredeck could not vouch for itself to its own bridge".to_string()),
        };
        let mut hub = lock(&self.hub);
        match left {
            Ok(()) => {
                hub.leaving.remove(room);
                drop(hub);
                Ok(self.status())
            }
            Err(error) => {
                let said = format!("the Discord member is still in room {room} ({error}). Disconnect it again to retry");
                hub.leaving.insert(room.to_string(), error);
                Err(said)
            }
        }
    }
}

/// "#41–#43, #47 from Codex, Gyre Assistant": the seqs as ranges, then each sender once, in
/// the order they spoke. The child writes the same shape (`notRelayed` in connector.mjs).
fn not_relayed<'a>(lines: impl IntoIterator<Item = &'a ToChild>) -> Option<String> {
    let mut seqs: Vec<u64> = Vec::new();
    let mut senders: Vec<&str> = Vec::new();
    for line in lines {
        if let ToChild::Message { seq, sender, .. } = line {
            seqs.push(*seq);
            if !senders.contains(&sender.as_str()) {
                senders.push(sender);
            }
        }
    }
    seqs.sort_unstable();
    seqs.dedup();
    let mut ranges: Vec<String> = Vec::new();
    let mut index = 0;
    while index < seqs.len() {
        let start = seqs[index];
        while index + 1 < seqs.len() && seqs[index + 1] == seqs[index] + 1 {
            index += 1;
        }
        let end = seqs[index];
        ranges.push(if start == end { format!("#{start}") } else { format!("#{start}–#{end}") });
        index += 1;
    }
    (!ranges.is_empty()).then(|| format!("{} from {}", ranges.join(", "), senders.join(", ")))
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0_u8; bytes];
    security_framework::random::SecRandom::default()
        .copy_bytes(&mut buffer)
        .map_err(|error| format!("No randomness for a pairing round: {error}"))?;
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Six digits from the system's generator, without modulo bias.
fn pairing_code() -> Result<String, String> {
    loop {
        let mut bytes = [0_u8; 4];
        security_framework::random::SecRandom::default()
            .copy_bytes(&mut bytes)
            .map_err(|error| format!("No randomness for a pairing code: {error}"))?;
        let value = u32::from_le_bytes(bytes);
        if value < 4_294_000_000 {
            return Ok(format!("{:06}", value % 1_000_000));
        }
    }
}

// ── the child process ──

struct Launch {
    node: PathBuf,
    script: PathBuf,
    token: BotToken,
    state_path: String,
    owners: Arc<dyn OwnerStore>,
}

fn supervise(launch: Launch, hub: Arc<Mutex<Hub>>, stop_rx: mpsc::Receiver<()>, log: SupervisorLog) {
    let Launch { node, script, token, state_path, owners } = launch;
    let mut child: Option<(Child, Instant)> = None;
    let mut backoff = Duration::from_secs(1);
    let mut next_start = Instant::now();
    loop {
        if let Some((process, started)) = child.as_mut() {
            let broken = lock(&hub).channel.as_ref().map(ChildChannel::is_broken).unwrap_or(true);
            let exited = matches!(process.try_wait(), Ok(Some(_)) | Err(_));
            if exited || broken {
                let ran = started.elapsed();
                let mut fields = serde_json::Map::new();
                fields.insert("pid".to_string(), serde_json::Value::from(process.id()));
                fields.insert("uptimeMs".to_string(), serde_json::Value::from(ran.as_millis() as u64));
                fields.insert("stuck".to_string(), serde_json::Value::Bool(!exited));
                log.record("discord_exited", fields);
                {
                    let mut hub = lock(&hub);
                    hub.channel = None;
                    hub.ready = false;
                }
                let _ = process.kill();
                let _ = process.wait();
                child = None;
                backoff = if ran >= HEALTHY_RUN { Duration::from_secs(1) } else { (backoff * 2).min(RESTART_BACKOFF_MAX) };
                next_start = Instant::now() + backoff;
            }
        }
        // A token Discord refused, or an intent not switched on, is not mended by starting
        // again: the child says so once and idles, and only a new token restarts it.
        let fatal = lock(&hub).error.as_ref().is_some_and(|error| FATAL_ERRORS.contains(&error.code.as_str()));
        if child.is_none() && !fatal && Instant::now() >= next_start {
            let epoch = {
                let mut hub = lock(&hub);
                hub.epoch += 1;
                hub.epoch
            };
            match spawn_child(&node, &script, &hub, &owners, epoch) {
                Ok((process, channel)) => {
                    let mut fields = serde_json::Map::new();
                    fields.insert("pid".to_string(), serde_json::Value::from(process.id()));
                    log.record("discord_started", fields);
                    lock(&hub).attach(channel, token.clone(), state_path.clone());
                    child = Some((process, Instant::now()));
                }
                Err(error) => {
                    let mut fields = serde_json::Map::new();
                    fields.insert("error".to_string(), serde_json::Value::String(error.clone()));
                    log.record("discord_spawn_failed", fields);
                    lock(&hub).error = Some(DiscordError { code: "internal".to_string(), message: error });
                    backoff = (backoff * 2).min(RESTART_BACKOFF_MAX);
                    next_start = Instant::now() + backoff;
                }
            }
        }
        match stop_rx.recv_timeout(SUPERVISOR_INTERVAL) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    // Dropping the channel ends the child's stdin, which is its signal to shut down.
    let channel = lock(&hub).channel.take();
    if let Some((mut process, _)) = child {
        // The writer thread drains what was queued (a closing room's `disconnect`) before
        // the pipe closes; the child gets a moment to tell Discord.
        drop(channel);
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if matches!(process.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let _ = process.kill();
        let _ = process.wait();
    }
}

fn spawn_child(
    node: &Path,
    script: &Path,
    hub: &Arc<Mutex<Hub>>,
    owners: &Arc<dyn OwnerStore>,
    epoch: u64,
) -> Result<(Child, ChildChannel), String> {
    // Nothing of the app's environment goes with it, and the token is not in argv either.
    let mut command = Command::new(node);
    command
        .arg(script)
        .arg("--parent-stdio")
        .env_clear()
        .env("PATH", crate::enriched_cli_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(home) = crate::home_dir() {
        command.env("HOME", home);
    }
    let mut process = command.spawn().map_err(|error| format!("Could not start the Discord connector: {error}"))?;
    let (Some(stdin), Some(stdout)) = (process.stdin.take(), process.stdout.take()) else {
        let _ = process.kill();
        let _ = process.wait();
        return Err("The Discord connector was started without its pipes".to_string());
    };
    let hub = Arc::clone(hub);
    let owners = Arc::clone(owners);
    let _ = thread::Builder::new()
        .name("gyredeck-discord-stdout".to_string())
        .spawn(move || read_child(stdout, &hub, owners.as_ref(), epoch));
    Ok((process, ChildChannel::new(Box::new(stdin))))
}

fn read_child(stdout: impl Read, hub: &Mutex<Hub>, owners: &dyn OwnerStore, epoch: u64) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.by_ref().take(CHILD_LINE_MAX_BYTES as u64).read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if line.last() != Some(&b'\n') {
            // Longer than any line the protocol has: skip to its end.
            let mut rest = Vec::new();
            if reader.read_until(b'\n', &mut rest).unwrap_or(0) == 0 {
                return;
            }
            continue;
        }
        if let Ok(event) = serde_json::from_slice::<FromChild>(&line) {
            on_child_event_from(hub, owners, epoch, event);
        }
    }
}

/// What the current child said; the tests' way in.
#[cfg(test)]
fn on_child_event(hub: &Mutex<Hub>, owners: &dyn OwnerStore, event: FromChild) {
    let epoch = lock(hub).epoch;
    on_child_event_from(hub, owners, epoch, event);
}

/// What child `epoch` said. A child that is no longer the current one is not heard: its late
/// `posted` must not trim a feed the next child was handed.
fn on_child_event_from(hub: &Mutex<Hub>, owners: &dyn OwnerStore, epoch: u64, event: FromChild) {
    let mut hub = lock(hub);
    if epoch != hub.epoch {
        return;
    }
    match event {
        FromChild::Ready { bot, application_id, forums } => {
            hub.ready = true;
            hub.bot = Some(bot);
            hub.application_id = Some(application_id);
            hub.forums = forums
                .into_iter()
                .map(|forum| Forum { id: forum.id, name: forum.name, guild_name: forum.guild_name })
                .collect();
            // Ready does not mean the state file can be stored: that refusal stays shown.
            if hub.error.as_ref().is_none_or(|error| error.code != STORAGE_BLOCKED) {
                hub.error = None;
            }
        }
        FromChild::Paired { owner_id, username, round } => {
            if !valid_snowflake(&owner_id) {
                return;
            }
            // Only the round the app holds now, and only while it is fresh by the app's own
            // clock: a code replaced by "New code", or one past its ten minutes, pairs nobody.
            let current = hub
                .pairing
                .as_ref()
                .is_some_and(|pairing| Some(&pairing.round) == round.as_ref() && pairing.at.elapsed() < PAIRING_TTL);
            if !current {
                eprintln!("Gyredeck ignored a Discord pairing for a round it no longer holds");
                return;
            }
            // Written down first, whole, in one Keychain call: an owner the app forgets at the
            // next launch is not paired, and half an owner is never left behind.
            let paired_at = time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default();
            let saved = owners.write(&Owner { id: owner_id.clone(), username: Some(username.clone()) }, &paired_at);
            if let Err(error) = saved {
                // Whatever the failed replace left is what the app believes — and the child is
                // told, so it does not go on treating a lost owner as paired (#199 r6).
                let had = hub.owner.is_some();
                hub.owner = owners.read();
                hub.pairing = None;
                if had && hub.owner.is_none() {
                    hub.send(&ToChild::Owner { owner_id: None, round: None });
                }
                hub.error = Some(DiscordError {
                    code: "internal".to_string(),
                    message: format!("Pairing could not be saved, so it did not happen: {error}"),
                });
                return;
            }
            hub.owner = Some(Owner { id: owner_id.clone(), username: Some(username) });
            hub.pairing = None;
            hub.send(&ToChild::Owner { owner_id: Some(owner_id), round });
        }
        FromChild::Error { code, message } => {
            // Five wrong codes: this pairing is over, and the owner starts another.
            if code == "pairing_locked" {
                hub.pairing = None;
            }
            if FATAL_ERRORS.contains(&code.as_str()) {
                hub.forget_child();
            }
            hub.error = Some(DiscordError { code, message });
        }
        FromChild::Posted { room, seq, created_at, msg_id } => hub.ack(&room, seq, created_at, msg_id),
        FromChild::Closed { room, created_at, id } => hub.closed(&room, created_at, id),
        FromChild::Connected {} => {}
    }
}

// ── reading a room ──

struct RoomReader {
    room: String,
    member: String,
    app_word: String,
    generation: u64,
    names: HashMap<String, String>,
    /// Each (member, name it was shown under) already checked against the roster, so a
    /// replay of old lines asks the bridge once per name, not once per line.
    shown_checked: HashMap<String, String>,
    /// A roster read a changed name asked for failed: every next line retries it before any
    /// name, sender or recipient, is used.
    names_stale: bool,
    source: Arc<dyn RoomSource>,
    hub: Arc<Mutex<Hub>>,
    stop: Arc<AtomicBool>,
    /// The last ACK the bridge took, and when one was last sent.
    acked_sent: u64,
    ack_at: Instant,
    /// Start in `wait_for_room`: the room code was over its budget at Connect.
    paused: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireDropped {
    #[serde(default)]
    dropped_through_seq: u64,
    #[serde(default)]
    relay_from: u64,
}

#[derive(Deserialize)]
struct WireMessage {
    seq: u64,
    from: String,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    text: String,
    #[serde(default)]
    ts: Option<String>,
    /// The sender as the room showed it when it spoke (#182): its declared name, if any.
    #[serde(default, rename = "fromShown")]
    from_shown: Option<String>,
}

impl RoomReader {
    fn run(mut self) {
        let mut backoff = Duration::from_secs(1);
        if self.paused && !self.wait_for_room() {
            return;
        }
        loop {
            if self.stopped() {
                return;
            }
            if self.source.generation() != self.generation {
                self.end(DisconnectReason::Closed);
                return;
            }
            // Always the last line fully read and forwarded, never the bridge's own idea of how
            // far it wrote: a frame written to a connection that then dropped was never read.
            // After a Disconnect the bridge starts no earlier than the relay's new join, so what
            // went by unfollowed is counted by the gap notice, not replayed.
            let (since, journal) = lock(&self.hub).rooms.get(&self.room).map(|feed| (feed.last_seq, feed.journal.clone())).unwrap_or_default();
            // The open moves the relay's floor to `since` too, so it waits for the sync (I1).
            let opened = match journal.map(|file| file.sync()) {
                Some(Err(error)) => {
                    lock(&self.hub).journal_blocked(&self.room, error);
                    Err(SourceError::Unavailable)
                }
                _ => self.source.open(&self.room, &self.member, &self.app_word, since),
            };
            match opened {
                Ok(stream) => {
                    backoff = Duration::from_secs(1);
                    match self.follow(stream) {
                        FollowEnd::Ended => {}
                        FollowEnd::Closed => {
                            self.end(DisconnectReason::Closed);
                            return;
                        }
                        FollowEnd::Full => {
                            if !self.wait_for_room() {
                                return;
                            }
                        }
                        FollowEnd::Blocked => {
                            if !self.pause(backoff) {
                                return;
                            }
                            backoff = (backoff * 2).min(READER_BACKOFF_MAX);
                        }
                    }
                }
                Err(SourceError::Gone) => {
                    self.end(DisconnectReason::Closed);
                    return;
                }
                Err(SourceError::Removed) => {
                    self.end(DisconnectReason::Disconnected);
                    return;
                }
                Err(SourceError::Unavailable) => {
                    if !self.pause(backoff) {
                        return;
                    }
                    backoff = (backoff * 2).min(READER_BACKOFF_MAX);
                }
            }
        }
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// Wait `backoff`, still telling the bridge what Discord took; false once stopped.
    fn pause(&mut self, backoff: Duration) -> bool {
        let until = Instant::now() + backoff;
        while Instant::now() < until {
            if self.stopped() {
                return false;
            }
            self.flush_ack();
            thread::sleep(READER_POLL.min(until.saturating_duration_since(Instant::now())));
        }
        true
    }

    fn end(&self, reason: DisconnectReason) {
        if !self.stopped() {
            lock(&self.hub).disconnect(&self.room, reason);
        }
    }

    /// With the stream closed, wait until Discord has taken half of what is held. Answers
    /// whether to go on reading; not when stopped or no longer connected.
    /// At most every `ACK_EVERY`, hand the bridge the highest seq Discord has accepted.
    fn flush_ack(&mut self) {
        if self.ack_at.elapsed() < ACK_EVERY {
            return;
        }
        self.ack_at = Instant::now();
        // Records a refused write left pending are tried again on the same beat.
        lock(&self.hub).flush_pending();
        let (acked, journal) = lock(&self.hub).rooms.get(&self.room).map(|feed| (feed.acked, feed.journal.clone())).unwrap_or_default();
        if acked <= self.acked_sent {
            return;
        }
        // Nothing past the last journal sync reaches the bridge (I1).
        if let Some(Err(error)) = journal.map(|file| file.sync()) {
            lock(&self.hub).journal_blocked(&self.room, error);
            return;
        }
        if self.source.ack(&self.room, &self.member, &self.app_word, acked).is_ok() {
            self.acked_sent = acked;
        }
    }

    fn wait_for_room(&mut self) -> bool {
        loop {
            if self.stopped() {
                return false;
            }
            self.flush_ack();
            let hub = lock(&self.hub);
            if !hub.rooms.contains_key(&self.room) {
                return false;
            }
            if hub.owed_in(&self.room) <= hub.cap() / 2 {
                return true;
            }
            drop(hub);
            thread::sleep(READER_POLL);
        }
    }

    /// Read one stream until it ends, the room ends, or the child is too far behind.
    fn follow(&mut self, mut stream: Box<dyn Read + Send>) -> FollowEnd {
        let mut parser = SseParser::default();
        let mut buffer = [0_u8; 8192];
        loop {
            if self.stopped() {
                return FollowEnd::Ended;
            }
            self.flush_ack();
            match stream.read(&mut buffer) {
                Ok(0) => return FollowEnd::Ended,
                Ok(read) => {
                    for event in parser.feed(&buffer[..read]) {
                        match event.name.as_str() {
                            "dropped" => {
                                if let Ok(dropped) = serde_json::from_str::<WireDropped>(&event.data) {
                                    match lock(&self.hub).on_dropped(&self.room, dropped.dropped_through_seq, dropped.relay_from) {
                                        Forwarded::Full => return FollowEnd::Full,
                                        Forwarded::Blocked => return FollowEnd::Blocked,
                                        Forwarded::Taken | Forwarded::Ignored => {}
                                    }
                                }
                            }
                            "mail" => {
                                if let Ok(message) = serde_json::from_str::<WireMessage>(&event.data) {
                                    // What is left in this read is read again from `since`.
                                    match self.relay(message) {
                                        Forwarded::Full => return FollowEnd::Full,
                                        Forwarded::Blocked => return FollowEnd::Blocked,
                                        Forwarded::Taken | Forwarded::Ignored => {}
                                    }
                                }
                                let hub = lock(&self.hub);
                                if hub.owed_in(&self.room) >= hub.cap() {
                                    return FollowEnd::Full;
                                }
                            }
                            "error" => {
                                let fatal = serde_json::from_str::<serde_json::Value>(&event.data)
                                    .ok()
                                    .and_then(|value| value.get("fatal").and_then(serde_json::Value::as_bool))
                                    == Some(true);
                                if fatal {
                                    return FollowEnd::Closed;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted) => {}
                Err(_) => return FollowEnd::Ended,
            }
        }
    }

    /// Whether the roster could be read: a failed read leaves the names as they were.
    fn refresh_names(&mut self) -> bool {
        let Ok(roster) = self.source.members(&self.room, &self.member) else {
            return false;
        };
        if let Some(seq) = roster.seq {
            if let Some(feed) = lock(&self.hub).rooms.get_mut(&self.room) {
                feed.bridge_seq = feed.bridge_seq.max(seq);
            }
        }
        for member in roster.members {
            self.names.insert(member.id, member.shown);
        }
        true
    }

    fn name_of(&mut self, id: &str) -> String {
        match id {
            ROOM_SENDER => return "Room".to_string(),
            APP_SENDER => return "You (via Gyredeck)".to_string(),
            _ => {}
        }
        if !self.names.contains_key(id) {
            self.refresh_names();
        }
        self.names.get(id).cloned().unwrap_or_else(|| "Agent".to_string())
    }

    fn relay(&mut self, message: WireMessage) -> Forwarded {
        // Posted under the name the room showed when it was said, so a name declared after
        // Connect shows in Discord too, and later lines addressed to that member use it.
        // The line names its sender as it was then; who is who now is the roster's to say, so a
        // name unlike the one held sends the reader to the roster, never into the cache.
        if self.names_stale && self.refresh_names() {
            self.names_stale = false;
        }
        let sender = match message.from_shown.as_deref().map(str::trim).filter(|shown| !shown.is_empty()) {
            Some(shown) if message.from != ROOM_SENDER && message.from != APP_SENDER => {
                let held = self.names.get(&message.from).map(String::as_str);
                if held != Some(shown) && self.shown_checked.get(&message.from).map(String::as_str) != Some(shown) {
                    if self.refresh_names() {
                        self.shown_checked.insert(message.from.clone(), shown.to_string());
                    } else {
                        self.names_stale = true;
                    }
                }
                shown.to_string()
            }
            _ => self.name_of(&message.from),
        };
        let to = match message.to.as_deref() {
            None | Some("everyone") => "everyone".to_string(),
            Some(id) if self.names.contains_key(id) || id == APP_SENDER || id == ROOM_SENDER => self.name_of(id),
            Some(other) => {
                self.refresh_names();
                self.names.get(other).cloned().unwrap_or_else(|| other.to_string())
            }
        };
        let kind = match message.kind.as_deref() {
            Some(kind @ ("ask" | "tell" | "reaction" | "notice")) => kind.to_string(),
            _ => "tell".to_string(),
        };
        let from_room = message.from == ROOM_SENDER;
        let forwarded = lock(&self.hub).forward(ToChild::Message {
            room: self.room.clone(),
            seq: message.seq,
            sender,
            to,
            kind,
            text: message.text,
            ts: message.ts.unwrap_or_default(),
        });
        // The room's notices are where joins and departures are said.
        if from_room {
            self.refresh_names();
        }
        forwarded
    }
}

enum FollowEnd {
    /// The stream ended; open it again.
    Ended,
    /// The room said it has ended.
    Closed,
    /// The child holds too much unacknowledged; stop reading until it catches up.
    Full,
    /// The journal refused a write; back off, then read again from `since`.
    Blocked,
}

struct SseEvent {
    name: String,
    data: String,
}

/// Server-sent events from bytes that may arrive cut anywhere.
#[derive(Default)]
struct SseParser {
    pending: Vec<u8>,
    name: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    fn feed(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        self.pending.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = self.pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&raw[..raw.len() - 1]).trim_end_matches('\r').to_string();
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(SseEvent {
                        name: self.name.take().unwrap_or_else(|| "message".to_string()),
                        data: self.data.join("\n"),
                    });
                }
                self.name = None;
                self.data.clear();
            } else if let Some(value) = line.strip_prefix("event:") {
                self.name = Some(value.trim().to_string());
            } else if let Some(value) = line.strip_prefix("data:") {
                self.data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
            }
        }
        events
    }
}

// ── the real dependencies ──

/// Delete any item under this name, then create a fresh one. `set_generic_password` updates an
/// existing item in place, keeping its access list — and an item another process of this user
/// planted could carry an open one. A fresh item is this app's, with its own access list.
/// What remains: such a process can still delete and replant the item while the app is not
/// running, and this API cannot say who created an item it reads. Nor is delete-then-set
/// atomic: a crash between the two leaves no item; the next launch reads the Keychain again
/// and is honest about it, at the cost of one more token entry or pairing.
#[cfg(target_os = "macos")]
fn replace_keychain_item(account: &str, value: &[u8]) -> Result<(), security_framework::base::Error> {
    let previous = security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, account).ok();
    match security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, account) {
        Ok(()) => {}
        Err(error) if error.code() == -25300 => {}
        Err(error) => return Err(error),
    }
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, account, value).inspect_err(|_| {
        // The new value did not land: put the old one back, best effort. The caller reads the
        // Keychain again either way, so what the app believes is what is there.
        if let Some(previous) = previous.as_deref() {
            let _ = security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, account, previous);
        }
    })
}

struct KeychainOwner;

impl OwnerStore for KeychainOwner {
    fn read(&self) -> Option<Owner> {
        #[cfg(target_os = "macos")]
        {
            let bytes = security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_OWNER_ACCOUNT).ok()?;
            owner_from_record(&bytes)
        }
        #[cfg(not(target_os = "macos"))]
        None
    }

    fn write(&self, owner: &Owner, paired_at: &str) -> Result<(), String> {
        let record = serde_json::json!({ "id": owner.id, "username": owner.username, "pairedAt": paired_at }).to_string();
        #[cfg(target_os = "macos")]
        {
            replace_keychain_item(KEYCHAIN_OWNER_ACCOUNT, record.as_bytes())
                .map_err(|error| format!("Could not save the owner in the Keychain: {error}"))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = record;
            Err("Keychain writes require macOS".to_string())
        }
    }

    fn delete(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            match security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_OWNER_ACCOUNT) {
                Ok(()) => Ok(()),
                Err(error) if error.code() == -25300 => Ok(()),
                Err(error) => Err(format!("Could not remove the owner from the Keychain: {error}")),
            }
        }
        #[cfg(not(target_os = "macos"))]
        Ok(())
    }
}

struct KeychainTokens;

impl TokenStore for KeychainTokens {
    fn read(&self) -> Option<BotToken> {
        #[cfg(target_os = "macos")]
        {
            let bytes = security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).ok()?;
            BotToken::parse(&String::from_utf8(bytes).ok()?).ok()
        }
        #[cfg(not(target_os = "macos"))]
        None
    }

    fn write(&self, token: &BotToken) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            replace_keychain_item(KEYCHAIN_ACCOUNT, token.0.as_bytes())
                .map_err(|error| format!("Could not save the token in the Keychain: {error}"))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = token;
            Err("Keychain writes require macOS".to_string())
        }
    }

    fn delete(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            match security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
                Ok(()) => Ok(()),
                // errSecItemNotFound: already gone is what was asked for.
                Err(error) if error.code() == -25300 => Ok(()),
                Err(error) => Err(format!("Could not remove the token from the Keychain: {error}")),
            }
        }
        #[cfg(not(target_os = "macos"))]
        Ok(())
    }
}

struct ConfigSettings;

impl SettingsStore for ConfigSettings {
    fn get(&self, key: &str) -> Option<serde_json::Value> {
        standalone_bridge::config_value(key)
    }

    fn set(&self, changes: &[(&str, Option<serde_json::Value>)]) -> Result<(), String> {
        standalone_bridge::write_config_values(changes)
    }
}

struct BridgeActs;

impl RoomActs for BridgeActs {
    fn password(&self, room: &str) -> Option<String> {
        standalone_bridge::room_password(room)
    }

    fn join_relay(&self, room: &str, member: &str, app_word: &str) -> Result<(), String> {
        standalone_bridge::sync_join_relay(room, member, app_word).map(|_| ())
    }

    fn leave(&self, room: &str, member: &str, app_word: &str) -> Result<(), String> {
        standalone_bridge::sync_leave(room, member, app_word)
    }
}

/// The running bridge; `target` names one a test started, `None` the configured one.
struct BridgeSource {
    target: Option<standalone_bridge::BridgeTarget>,
}

impl BridgeSource {
    fn target(&self) -> Result<standalone_bridge::BridgeTarget, SourceError> {
        match &self.target {
            Some(target) => Ok(target.clone()),
            None => standalone_bridge::BridgeTarget::configured().map_err(|_| SourceError::Unavailable),
        }
    }
}

impl RoomSource for BridgeSource {
    fn members(&self, room: &str, as_id: &str) -> Result<Roster, SourceError> {
        let target = self.target()?;
        let (status, value) = standalone_bridge::bridge_request_to(
            &target,
            "GET",
            &format!("/sync/rooms?as={as_id}"),
            None,
            Duration::from_millis(1500),
            None,
        )
        .map_err(|_| SourceError::Unavailable)?;
        if !(200..300).contains(&status) {
            return Err(SourceError::Unavailable);
        }
        if value.get("room").and_then(serde_json::Value::as_str) != Some(room) {
            return Err(SourceError::Removed);
        }
        Ok(Roster {
            members: parse_members(&value),
            created_at: value.get("createdAt").and_then(serde_json::Value::as_u64),
            seq: value.get("seq").and_then(serde_json::Value::as_u64),
        })
    }

    fn open(&self, room: &str, as_id: &str, app_word: &str, since: u64) -> Result<Box<dyn Read + Send>, SourceError> {
        let target = self.target()?;
        let (port, token) = (target.port, target.token);
        let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(1500)).map_err(|_| SourceError::Unavailable)?;
        let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        // HTTP/1.0, so the stream comes back unchunked and ends when the bridge ends it.
        let request = format!(
            "GET /mail/{room}/events?as={as_id}&since={since} HTTP/1.0\r\nHost: {}:{port}\r\nAccept: text/event-stream\r\nX-Gyredeck-Token: {token}\r\nX-Gyredeck-Broker: {app_word}\r\n\r\n",
            standalone_bridge::BRIDGE_HOST
        );
        stream.write_all(request.as_bytes()).map_err(|_| SourceError::Unavailable)?;
        let mut head = Vec::new();
        let mut byte = [0_u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if head.len() > 16 * 1024 || stream.read(&mut byte).map_err(|_| SourceError::Unavailable)? == 0 {
                return Err(SourceError::Unavailable);
            }
            head.push(byte[0]);
        }
        let status = String::from_utf8_lossy(&head)
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok())
            .unwrap_or(0);
        match status {
            200 => {
                let _ = stream.set_read_timeout(Some(READER_POLL));
                Ok(Box::new(stream))
            }
            // A room with members answers a password it does not hold with 403; 401 is the
            // answer for a code with no room behind it, which is how a closed room is met.
            401 | 404 => Err(SourceError::Gone),
            403 => Err(SourceError::Removed),
            _ => Err(SourceError::Unavailable),
        }
    }

    fn ack(&self, room: &str, as_id: &str, app_word: &str, seq: u64) -> Result<(), SourceError> {
        let target = self.target()?;
        let body = serde_json::json!({ "as": as_id, "seq": seq }).to_string();
        match standalone_bridge::bridge_request_to(&target, "POST", &format!("/mail/{room}/relay-ack"), Some(body), Duration::from_millis(1500), Some(app_word)) {
            Ok((200, _)) => Ok(()),
            Ok((404, _)) => Err(SourceError::Gone),
            Ok(_) | Err(_) => Err(SourceError::Unavailable),
        }
    }

    fn generation(&self) -> u64 {
        // A bridge a test started is not one this app spawns, so its count does not apply.
        if self.target.is_some() {
            return 0;
        }
        standalone_bridge::bridge_generation()
    }
}

/// The room's members as it shows them: the label, then ` / ` and the person's name.
fn parse_members(value: &serde_json::Value) -> Vec<RoomMember> {
    value
        .get("members")
        .and_then(serde_json::Value::as_array)
        .map(|members| {
            members
                .iter()
                .filter_map(|member| {
                    let id = member.get("conversationId")?.as_str()?.to_string();
                    let label = member.get("provider").and_then(serde_json::Value::as_str).unwrap_or("Agent");
                    let shown = match member.get("name").and_then(serde_json::Value::as_str) {
                        Some(name) if !name.is_empty() => format!("{label} / {name}"),
                        _ => label.to_string(),
                    };
                    Some(RoomMember { id, shown })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
