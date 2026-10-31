use super::*;
use std::{
    fs,
    io::{BufReader, Cursor},
    os::fd::FromRawFd,
    sync::atomic::AtomicU64,
    time::{SystemTime, UNIX_EPOCH},
};

// A made-up token in a real token's shape, put together from parts so a secret scanner does
// not take the test file for a leak.
const TOKEN: &str = concat!("MTIzNDU2Nzg5MDEyMzQ1Njc4", ".", "GaBcDe", ".", "abcdefghijklmnopqrstuvwxyz0123456789AB");
const PASSWORD: &str = "0123456789abcdef0123456789abcdef";
const APP_WORD: &str = "a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5";
const ROOM: &str = "sync-ab23";
/// The room instance the fake bridge reports.
const CREATED: u64 = 1_761_559_200_000;
const OTHER: &str = "sync-cd45";

// ── fakes ──

#[derive(Default)]
struct MemTokens {
    token: Mutex<Option<BotToken>>,
    deleted: AtomicBool,
    /// A replace whose delete landed and whose write — and putting the old one back — did not.
    wipe_on_write: AtomicBool,
    /// A write that failed and left the old token in place.
    fail_write: AtomicBool,
}

impl TokenStore for Arc<MemTokens> {
    fn read(&self) -> Option<BotToken> {
        self.token.lock().unwrap().clone()
    }
    fn write(&self, token: &BotToken) -> Result<(), String> {
        if self.fail_write.load(Ordering::SeqCst) {
            return Err("Could not save the token in the Keychain".to_string());
        }
        if self.wipe_on_write.load(Ordering::SeqCst) {
            *self.token.lock().unwrap() = None;
            return Err("Could not save the token in the Keychain".to_string());
        }
        *self.token.lock().unwrap() = Some(token.clone());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        *self.token.lock().unwrap() = None;
        self.deleted.store(true, Ordering::SeqCst);
        Ok(())
    }
}

/// The owner's Keychain item in memory; `fail` refuses every write.
#[derive(Default)]
struct MemOwner {
    record: Mutex<Option<(Owner, String)>>,
    fail: AtomicBool,
    /// The failed write also took the old item.
    wipe: AtomicBool,
}

impl OwnerStore for MemOwner {
    fn read(&self) -> Option<Owner> {
        self.record.lock().unwrap().as_ref().map(|(owner, _)| owner.clone())
    }
    fn write(&self, owner: &Owner, paired_at: &str) -> Result<(), String> {
        if self.wipe.load(Ordering::SeqCst) {
            *self.record.lock().unwrap() = None;
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err("The user name or passphrase you entered is not correct".to_string());
        }
        *self.record.lock().unwrap() = Some((owner.clone(), paired_at.to_string()));
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        *self.record.lock().unwrap() = None;
        Ok(())
    }
}

/// Settings in memory; a key named in `unwritable` refuses every write.
#[derive(Default)]
struct MemSettings(Mutex<HashMap<String, serde_json::Value>>, Mutex<Vec<String>>);

impl SettingsStore for MemSettings {
    fn get(&self, key: &str) -> Option<serde_json::Value> {
        self.0.lock().unwrap().get(key).cloned()
    }
    /// All or nothing, as the config file is written.
    fn set(&self, changes: &[(&str, Option<serde_json::Value>)]) -> Result<(), String> {
        if changes.iter().any(|(key, _)| self.1.lock().unwrap().iter().any(|blocked| blocked == key)) {
            return Err("Could not write Gyredeck config: Permission denied".to_string());
        }
        let mut map = self.0.lock().unwrap();
        for (key, value) in changes {
            match value {
                Some(value) => map.insert((*key).to_string(), value.clone()),
                None => map.remove(*key),
            };
        }
        Ok(())
    }
}

/// The rooms founded here, and every join and leave, written down.
struct FakeActs {
    fail_leave: AtomicBool,
    founded: Mutex<Vec<String>>,
    joins: Mutex<Vec<(String, String, String)>>,
    leaves: Mutex<Vec<String>>,
}

impl Default for FakeActs {
    fn default() -> Self {
        Self { fail_leave: AtomicBool::new(false), founded: Mutex::new(vec![ROOM.to_string()]), joins: Mutex::default(), leaves: Mutex::default() }
    }
}

impl RoomActs for Arc<FakeActs> {
    fn password(&self, room: &str) -> Option<String> {
        self.founded.lock().unwrap().iter().any(|code| code == room).then(|| PASSWORD.to_string())
    }
    fn join_relay(&self, room: &str, member: &str, app_word: &str) -> Result<(), String> {
        self.joins.lock().unwrap().push((room.to_string(), member.to_string(), app_word.to_string()));
        Ok(())
    }
    fn leave(&self, room: &str, _member: &str, _app_word: &str) -> Result<(), String> {
        self.leaves.lock().unwrap().push(room.to_string());
        if self.fail_leave.load(Ordering::SeqCst) {
            return Err("Bridge is not reachable".to_string());
        }
        Ok(())
    }
}

/// The bridge as a script: each room's streams in order, then nothing reachable. A room
/// given a `log` is served like the bridge serves it instead: everything after `since`.
#[derive(Default)]
struct FakeSource {
    members: Mutex<HashMap<String, Vec<RoomMember>>>,
    streams: Mutex<HashMap<String, VecDeque<Vec<u8>>>>,
    logs: Mutex<HashMap<String, Vec<serde_json::Value>>>,
    opens: Mutex<Vec<(String, String, String)>>,
    sinces: Mutex<Vec<u64>>,
    acks: Mutex<Vec<(String, String, u64)>>,
    roster_fails: AtomicBool,
    dropped: Arc<AtomicU64>,
    generation: AtomicU64,
    /// The room's last seq as `/sync/rooms` reports it.
    room_seq: Mutex<HashMap<String, u64>>,
    /// When set, every open and ACK records how far the room's journal was synced then (I1).
    probe: Mutex<Option<Weak<Mutex<Hub>>>>,
    synced_at: Mutex<Vec<(&'static str, u64, u64)>>,
    /// Streams stay open once their frames are read, as the bridge's do.
    hold: Arc<AtomicBool>,
}

/// A stream that counts being closed, so a test can see the reader let go of it.
struct FakeStream {
    bytes: Cursor<Vec<u8>>,
    dropped: Arc<AtomicU64>,
    hold: Arc<AtomicBool>,
}

impl Read for FakeStream {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.bytes.read(buffer)?;
        if read == 0 && self.hold.load(Ordering::SeqCst) {
            // A stream the bridge keeps open: nothing new yet.
            thread::sleep(Duration::from_millis(50));
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        Ok(read)
    }
}

impl Drop for FakeStream {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}

fn frames(room: &str, messages: &[&serde_json::Value]) -> Vec<u8> {
    let mut bytes = format!(": gyredeck mail room {room} connected\n\n");
    for frame in messages {
        bytes.push_str(&format!("id: {}\nevent: mail\ndata: {}\n\n", frame["seq"], frame));
    }
    bytes.into_bytes()
}

impl RoomSource for Arc<FakeSource> {
    fn members(&self, room: &str, _as_id: &str) -> Result<Roster, SourceError> {
        if self.roster_fails.load(Ordering::SeqCst) {
            return Err(SourceError::Unavailable);
        }
        Ok(Roster {
            members: self.members.lock().unwrap().get(room).cloned().unwrap_or_default(),
            created_at: Some(CREATED),
            seq: self.room_seq.lock().unwrap().get(room).copied(),
        })
    }
    fn open(&self, room: &str, as_id: &str, app_word: &str, since: u64) -> Result<Box<dyn Read + Send>, SourceError> {
        self.probe_synced("open", room, since);
        self.opens.lock().unwrap().push((room.to_string(), as_id.to_string(), app_word.to_string()));
        self.sinces.lock().unwrap().push(since);
        let stream = |bytes| -> Box<dyn Read + Send> { Box::new(FakeStream { bytes: Cursor::new(bytes), dropped: Arc::clone(&self.dropped), hold: Arc::clone(&self.hold) }) };
        if let Some(log) = self.logs.lock().unwrap().get(room) {
            let after: Vec<&serde_json::Value> = log.iter().filter(|m| m["seq"].as_u64().unwrap() > since).collect();
            return if after.is_empty() { Err(SourceError::Unavailable) } else { Ok(stream(frames(room, &after))) };
        }
        match self.streams.lock().unwrap().get_mut(room).and_then(VecDeque::pop_front) {
            Some(bytes) => Ok(stream(bytes)),
            None => Err(SourceError::Unavailable),
        }
    }
    fn ack(&self, room: &str, _as_id: &str, app_word: &str, seq: u64) -> Result<(), SourceError> {
        self.probe_synced("ack", room, seq);
        self.acks.lock().unwrap().push((room.to_string(), app_word.to_string(), seq));
        Ok(())
    }
    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
}

impl FakeSource {
    fn probe_synced(&self, what: &'static str, room: &str, told: u64) {
        let Some(hub) = self.probe.lock().unwrap().as_ref().and_then(Weak::upgrade) else {
            return;
        };
        let synced = lock(&hub).rooms.get(room).and_then(|feed| feed.journal.as_ref().map(|file| file.synced_through())).unwrap_or(0);
        self.synced_at.lock().unwrap().push((what, told, synced));
    }
}

#[derive(Clone, Default)]
struct SharedBuf(Arc<Mutex<Vec<u8>>>);

impl Write for SharedBuf {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl SharedBuf {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
    fn lines(&self) -> Vec<serde_json::Value> {
        self.text().lines().map(|line| serde_json::from_str(line).expect("each line is one JSON object")).collect()
    }
}

struct Fixture {
    state: DiscordState,
    tokens: Arc<MemTokens>,
    settings: Arc<MemSettings>,
    owners: Arc<MemOwner>,
    source: Arc<FakeSource>,
    acts: Arc<FakeActs>,
    dir: PathBuf,
}

fn scratch(name: &str) -> PathBuf {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("gyredeck-discord-{name}-{unique}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn fixture(name: &str, token: Option<&str>) -> Fixture {
    fixture_with(name, token, &[])
}

/// With settings already saved, as a launch finds them.
fn fixture_with(name: &str, token: Option<&str>, saved: &[(&str, &str)]) -> Fixture {
    fixture_owned(name, token, saved, None)
}

/// And with an owner already in the (fake) Keychain.
fn fixture_owned(name: &str, token: Option<&str>, saved: &[(&str, &str)], owner: Option<Owner>) -> Fixture {
    let owners = Arc::new(MemOwner::default());
    *owners.record.lock().unwrap() = owner.map(|owner| (owner, "2026-10-27T00:00:00Z".to_string()));
    let tokens = Arc::new(MemTokens::default());
    if let Some(token) = token {
        *tokens.token.lock().unwrap() = Some(BotToken::parse(token).unwrap());
    }
    let settings = Arc::new(MemSettings::default());
    for (key, value) in saved {
        settings.set(&[(key, Some(serde_json::Value::from(*value)))]).unwrap();
    }
    let source = Arc::new(FakeSource::default());
    let acts = Arc::new(FakeActs::default());
    let dir = scratch(name);
    let state = DiscordState::with(Deps {
        tokens: Box::new(Arc::clone(&tokens)),
        settings: Arc::clone(&settings) as Arc<dyn SettingsStore>,
        owners: Arc::clone(&owners) as Arc<dyn OwnerStore>,
        source: Arc::new(Arc::clone(&source)),
        acts: Box::new(Arc::clone(&acts)),
        state_path: dir.join("discord-state.json"),
        log: SupervisorLog::at(Some(dir.join("supervisor.log"))),
    });
    Fixture { state, tokens, settings, owners, source, acts, dir }
}

impl Fixture {
    /// A child that is only a pipe the test reads, so every line can be inspected.
    fn attach_buffer(&self) -> SharedBuf {
        let buffer = SharedBuf::default();
        self.state.configured.store(true, Ordering::SeqCst);
        lock(&self.state.hub).attach(
            ChildChannel::new(Box::new(buffer.clone())),
            BotToken::parse(TOKEN).unwrap(),
            self.dir.join("discord-state.json").display().to_string(),
        );
        // The child said `ready`, and a forum is picked: a room is followed only into one.
        let mut hub = lock(&self.state.hub);
        hub.ready = true;
        hub.forum_id.get_or_insert_with(|| "223456789012345678".to_string());
        drop(hub);
        buffer
    }

    fn members(&self, room: &str, members: &[(&str, &str)]) {
        self.source.members.lock().unwrap().insert(
            room.to_string(),
            members.iter().map(|(id, shown)| RoomMember { id: id.to_string(), shown: shown.to_string() }).collect(),
        );
    }

    fn stream(&self, room: &str, frames: &[serde_json::Value]) {
        let mut bytes = format!(": gyredeck mail room {room} connected\n\n");
        for frame in frames {
            bytes.push_str(&format!("id: {}\nevent: mail\ndata: {}\n\n", frame["seq"], frame));
        }
        self.source.streams.lock().unwrap().entry(room.to_string()).or_default().push_back(bytes.into_bytes());
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.state.shutdown();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn mail(seq: u64, from: &str, to: &str, kind: &str, text: &str) -> serde_json::Value {
    serde_json::json!({ "seq": seq, "from": from, "to": to, "kind": kind, "text": text, "ts": "2026-10-27T10:00:00.000Z" })
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(20));
    }
}

fn of_kind<'a>(lines: &'a [serde_json::Value], t: &str) -> Vec<&'a serde_json::Value> {
    lines.iter().filter(|line| line["t"] == t).collect()
}

// ── the rules ──

#[test]
fn a_room_this_app_did_not_found_cannot_be_connected() {
    let f = fixture("founder", Some(TOKEN));
    let buffer = f.attach_buffer();

    let refused = f.state.connect(OTHER, APP_WORD);
    assert!(refused.is_err(), "a room whose password this app does not hold is refused");
    assert!(f.acts.joins.lock().unwrap().is_empty(), "nothing joined");
    assert!(f.source.opens.lock().unwrap().is_empty(), "nothing read");
    assert!(of_kind(&buffer.lines(), "connect").is_empty(), "nothing told to the child");

    // Premise: the founded room does connect, through the same path.
    f.state.connect(ROOM, APP_WORD).expect("a founded room connects");
    assert_eq!(f.acts.joins.lock().unwrap()[0], (ROOM.to_string(), relay_member(ROOM), APP_WORD.to_string()));
    wait_until("the connect line", || of_kind(&buffer.lines(), "connect").len() == 1);
}

#[test]
fn nothing_is_read_or_forwarded_for_a_room_that_is_not_connected() {
    let f = fixture("unconnected", Some(TOKEN));
    let buffer = f.attach_buffer();
    f.stream(ROOM, &[mail(1, "peer-a", "everyone", "tell", "in the connected room")]);
    f.stream(OTHER, &[mail(1, "peer-a", "everyone", "tell", "in a room nobody connected")]);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("the connected room's message", || of_kind(&buffer.lines(), "message").len() == 1);

    // A line for a room that is not connected — as a stale reader would produce — goes nowhere.
    lock(&f.state.hub).forward(ToChild::Message {
        room: OTHER.to_string(),
        seq: 1,
        sender: "Codex".to_string(),
        to: "everyone".to_string(),
        kind: "tell".to_string(),
        text: "in a room nobody connected".to_string(),
        ts: String::new(),
    });
    thread::sleep(Duration::from_millis(200));
    assert!(f.source.opens.lock().unwrap().iter().all(|(room, ..)| room == ROOM), "only the connected room is read");
    let lines = buffer.lines();
    assert!(lines.iter().all(|line| line["room"].is_null() || line["room"] == ROOM), "{lines:?}");
    assert!(!buffer.text().contains("in a room nobody connected"));
}

#[test]
fn senders_and_recipients_are_named_as_the_room_shows_them() {
    let f = fixture("names", Some(TOKEN));
    let buffer = f.attach_buffer();
    let relay = relay_member(ROOM);
    f.members(ROOM, &[("founder-1", "Claude Code / Lead"), ("peer-a", "Codex"), (relay.as_str(), "Discord")]);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("the connect line", || !of_kind(&buffer.lines(), "connect").is_empty());
    let connect = of_kind(&buffer.lines(), "connect")[0].clone();
    assert_eq!(connect["members"], serde_json::json!(["Claude Code / Lead", "Codex", "Discord"]));
    assert_eq!(connect["createdAt"], 1_761_559_200_000_u64, "the room instance, not only its code");
    // Premise: the reader found nothing to read yet, so what follows arrives after the
    // connect — with a member the roster read at connect did not have.
    wait_until("a first open", || !f.source.opens.lock().unwrap().is_empty());
    assert!(of_kind(&buffer.lines(), "message").is_empty());
    f.members(ROOM, &[("founder-1", "Claude Code / Lead"), ("peer-a", "Codex"), ("peer-b", "Antigravity"), (relay.as_str(), "Discord")]);
    f.stream(ROOM, &[
        mail(1, "peer-a", "founder-1", "ask", "can you look?"),
        mail(2, "gyredeck-room", "everyone", "notice", "Antigravity joined this room."),
        mail(3, "peer-b", "everyone", "tell", "hello"),
        mail(4, "gyredeck", "peer-a", "tell", "from the app"),
    ]);

    wait_until("four messages", || of_kind(&buffer.lines(), "message").len() == 4);
    let lines = buffer.lines();
    let messages = of_kind(&lines, "message");
    let named: Vec<(String, String, String)> = messages
        .iter()
        .map(|m| (m["sender"].as_str().unwrap().into(), m["to"].as_str().unwrap().into(), m["kind"].as_str().unwrap().into()))
        .collect();
    assert_eq!(
        named,
        vec![
            ("Codex".into(), "Claude Code / Lead".into(), "ask".into()),
            ("Room".into(), "everyone".into(), "notice".into()),
            ("Antigravity".into(), "everyone".into(), "tell".into()),
            ("You (via Gyredeck)".into(), "Codex".into(), "tell".into()),
        ]
    );
    assert_eq!(messages[0]["text"], "can you look?", "the text goes word for word");
}

#[test]
fn order_is_kept_across_a_stream_reconnect_without_duplicates() {
    let f = fixture("order", Some(TOKEN));
    let buffer = f.attach_buffer();
    f.members(ROOM, &[("peer-a", "Codex")]);
    // The stream ends (every 300 s) and the resumed one hands back two already seen.
    f.stream(ROOM, &[mail(1, "peer-a", "everyone", "tell", "one"), mail(2, "peer-a", "everyone", "tell", "two"), mail(3, "peer-a", "everyone", "tell", "three")]);
    f.stream(ROOM, &[mail(2, "peer-a", "everyone", "tell", "two"), mail(3, "peer-a", "everyone", "tell", "three"), mail(4, "peer-a", "everyone", "tell", "four"), mail(5, "peer-a", "everyone", "tell", "five")]);
    f.state.connect(ROOM, APP_WORD).unwrap();
    // Premise: the second stream was opened, i.e. there was a reconnect.
    wait_until("the reconnect", || f.source.opens.lock().unwrap().len() >= 2);
    wait_until("five messages", || of_kind(&buffer.lines(), "message").iter().any(|m| m["seq"] == 5));
    thread::sleep(Duration::from_millis(100));
    let lines = buffer.lines();
    let seqs: Vec<u64> = of_kind(&lines, "message").iter().map(|m| m["seq"].as_u64().unwrap()).collect();
    assert_eq!(seqs, vec![1, 2, 3, 4, 5]);
    // Both opens read as the relay, on the app's word — not on the room's password, which
    // every member holds.
    for (room, as_id, word) in f.source.opens.lock().unwrap().iter() {
        assert_eq!((room.as_str(), as_id.as_str(), word.as_str()), (ROOM, relay_member(ROOM).as_str(), APP_WORD));
    }
}

#[test]
fn a_gap_in_the_room_is_said_once_as_a_count() {
    let f = fixture("gap", Some(TOKEN));
    let buffer = f.attach_buffer();
    f.members(ROOM, &[("peer-a", "Codex")]);
    f.stream(ROOM, &[mail(1, "peer-a", "everyone", "tell", "one"), mail(2, "peer-a", "everyone", "tell", "two")]);
    f.stream(ROOM, &[mail(5, "peer-a", "everyone", "tell", "five"), mail(6, "peer-a", "everyone", "tell", "six")]);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("six", || of_kind(&buffer.lines(), "message").iter().any(|m| m["seq"] == 6));
    let lines = buffer.lines();
    let seen: Vec<(u64, String, String)> = of_kind(&lines, "message")
        .iter()
        .map(|m| (m["seq"].as_u64().unwrap(), m["sender"].as_str().unwrap().into(), m["text"].as_str().unwrap().into()))
        .collect();
    assert_eq!(
        seen,
        vec![
            (1, "Codex".into(), "one".into()),
            (2, "Codex".into(), "two".into()),
            (3, "Room".into(), "2 lines went by unfollowed".into()),
            (5, "Codex".into(), "five".into()),
            (6, "Codex".into(), "six".into()),
        ]
    );
    assert_eq!(of_kind(&lines, "message")[2]["kind"], "notice");
}

#[test]
fn no_line_to_the_child_carries_a_room_password_or_the_apps_word() {
    let f = fixture("secrets", Some(TOKEN));
    let buffer = f.attach_buffer();
    f.members(ROOM, &[("founder-1", "Claude Code"), ("peer-a", "Codex")]);
    f.stream(ROOM, &[mail(1, "peer-a", "founder-1", "ask", "status?"), mail(2, "gyredeck-room", "everyone", "notice", "Codex left this room.")]);
    f.state.connect(ROOM, APP_WORD).unwrap();
    f.state.set_forum("123456789012345678").unwrap();
    let code = f.state.start_pairing().unwrap();
    wait_until("both messages", || of_kind(&buffer.lines(), "message").len() == 2);
    f.state.disconnect(ROOM, Some(APP_WORD)).unwrap();
    wait_until("the disconnect", || !of_kind(&buffer.lines(), "disconnect").is_empty());

    let lines = buffer.lines();
    // Premise: the whole protocol went through this pipe.
    let kinds: Vec<&str> = lines.iter().map(|line| line["t"].as_str().unwrap()).collect();
    for kind in ["hello", "connect", "message", "forum", "pair", "disconnect"] {
        assert!(kinds.contains(&kind), "{kind} was written: {kinds:?}");
    }
    assert_eq!(of_kind(&lines, "pair")[0]["code"], code);
    for (index, line) in buffer.text().lines().enumerate() {
        assert!(!line.contains(PASSWORD), "line {index} carries the room password: {line}");
        assert!(!line.contains(APP_WORD), "line {index} carries the app's word: {line}");
        assert_eq!(line.contains(TOKEN), index == 0 && lines[0]["t"] == "hello", "the token rides in hello alone: {line}");
    }
    assert_eq!(lines[0]["token"], TOKEN);
    assert_eq!(of_kind(&lines, "disconnect")[0]["reason"], "disconnected");
}

#[test]
fn every_connected_room_is_told_closed_when_the_bridge_restarts() {
    let f = fixture("restart", Some(TOKEN));
    let buffer = f.attach_buffer();
    f.acts.founded.lock().unwrap().push(OTHER.to_string());
    f.state.connect(ROOM, APP_WORD).unwrap();
    f.state.connect(OTHER, APP_WORD).unwrap();
    wait_until("both readers to have tried the bridge", || {
        let opens = f.source.opens.lock().unwrap();
        opens.iter().any(|(room, ..)| room == ROOM) && opens.iter().any(|(room, ..)| room == OTHER)
    });
    assert!(of_kind(&buffer.lines(), "disconnect").is_empty(), "premise: nothing closed before the restart");

    f.source.generation.fetch_add(1, Ordering::SeqCst);
    wait_until("both rooms closed", || of_kind(&buffer.lines(), "disconnect").len() == 2);
    let lines = buffer.lines();
    let mut closed: Vec<(String, String)> = of_kind(&lines, "disconnect")
        .iter()
        .map(|line| (line["room"].as_str().unwrap().into(), line["reason"].as_str().unwrap().into()))
        .collect();
    closed.sort();
    assert_eq!(closed, vec![(ROOM.into(), "closed".into()), (OTHER.into(), "closed".into())]);
    assert!(f.state.status().connected_rooms.is_empty());
}

// ── the child process ──

fn connector_script(dir: &Path) -> PathBuf {
    let script = dir.join("connector.mjs");
    fs::write(
        &script,
        r#"import { appendFileSync, writeFileSync } from 'node:fs'
const out = process.argv[1]
appendFileSync(out + '.spawns', JSON.stringify({ argv: process.argv, env: process.env }) + '\n')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf('\n')) >= 0) { appendFileSync(out + '.lines', buffer.slice(0, at + 1)); buffer = buffer.slice(at + 1) }
})
process.stdin.on('end', () => { appendFileSync(out + '.eof', 'eof\n'); process.exit(0) })
process.stdout.write(JSON.stringify({ t: 'ready', v: 1, bot: { id: '42', username: 'Gyre Bot' }, applicationId: '123456789012345678', forums: [{ id: '223456789012345678', name: 'rooms', guildId: '1', guildName: 'Mine' }] }) + '\n')
"#,
    )
    .unwrap();
    script
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn node() -> PathBuf {
    standalone_bridge::find_node_binary().expect("these tests need Node.js, as the app does")
}

#[test]
fn the_token_never_reaches_argv_env_or_the_log_and_rides_only_in_hello() {
    let f = fixture("token", Some(TOKEN));
    let script = connector_script(&f.dir);
    f.state.start(node(), script.clone()).unwrap();
    let lines_path = PathBuf::from(format!("{}.lines", script.display()));
    wait_until("hello", || read(&lines_path).lines().count() >= 1);
    wait_until("ready", || f.state.status().bot.is_some());
    let status = f.state.status();
    assert!(status.running && status.configured);
    assert_eq!(status.bot, Some(Bot { id: "42".into(), username: "Gyre Bot".into() }));
    assert_eq!(
        status.invite_url.as_deref(),
        Some("https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot%20applications.commands&permissions=326954454096")
    );
    f.state.shutdown();
    wait_until("the child's stdin to end", || !read(&PathBuf::from(format!("{}.eof", script.display()))).is_empty());

    let spawns = read(&PathBuf::from(format!("{}.spawns", script.display())));
    assert_eq!(spawns.lines().count(), 1);
    let spawn: serde_json::Value = serde_json::from_str(spawns.lines().next().unwrap()).unwrap();
    assert_eq!(spawn["argv"][2], "--parent-stdio");
    assert!(!spawns.contains(TOKEN), "the token is in neither argv nor env");
    let env_keys: Vec<&String> = spawn["env"].as_object().unwrap().keys().collect();
    assert!(env_keys.iter().all(|key| ["PATH", "HOME"].contains(&key.as_str()) || key.starts_with("__CF")), "nothing else of the app's environment: {env_keys:?}");
    let log = read(&f.dir.join("supervisor.log"));
    assert!(log.contains("discord_started"), "premise: the log was written: {log}");
    assert!(!log.contains(TOKEN));
    let lines = read(&lines_path);
    let first: serde_json::Value = serde_json::from_str(lines.lines().next().unwrap()).unwrap();
    assert_eq!(first["t"], "hello");
    assert_eq!(first["token"], TOKEN);
    assert_eq!(lines.lines().filter(|line| line.contains(TOKEN)).count(), 1);
    assert_eq!(format!("{:?}", BotToken::parse(TOKEN).unwrap()), "BotToken(<redacted>)");
}

#[test]
fn no_child_is_spawned_when_the_keychain_has_no_token() {
    let f = fixture("notoken", None);
    let script = connector_script(&f.dir);
    f.state.start(node(), script.clone()).unwrap();
    thread::sleep(Duration::from_millis(1500));
    assert!(read(&PathBuf::from(format!("{}.spawns", script.display()))).is_empty(), "no process");
    assert!(!f.state.is_running(), "no supervisor thread, so no timer");
    let status = f.state.status();
    assert!(!status.configured && !status.running);
    assert!(f.state.connect(ROOM, APP_WORD).is_err(), "and no room can be followed");
    assert!(f.acts.joins.lock().unwrap().is_empty());

    // Premise: the same fixture with a token does spawn.
    f.state.set_token(TOKEN, Some(APP_WORD)).unwrap();
    wait_until("a spawn once a token is saved", || !read(&PathBuf::from(format!("{}.spawns", script.display()))).is_empty());
    assert_eq!(f.tokens.read().map(|token| token.expose().to_string()).as_deref(), Some(TOKEN));
}

#[test]
fn a_refused_token_is_not_restarted_in_a_loop_and_a_new_token_restarts() {
    let f = fixture("badtoken", Some(TOKEN));
    let script = f.dir.join("connector.mjs");
    fs::write(
        &script,
        r#"import { appendFileSync } from 'node:fs'
appendFileSync(process.argv[1] + '.spawns', 'spawn\n')
process.stdout.write(JSON.stringify({ t: 'error', code: 'bad_token', message: 'Discord refused the token' }) + '\n', () => process.exit(1))
"#,
    )
    .unwrap();
    let spawns = PathBuf::from(format!("{}.spawns", script.display()));
    f.state.start(node(), script.clone()).unwrap();
    wait_until("the refusal", || f.state.status().error.is_some());
    assert_eq!(f.state.status().error.unwrap().code, "bad_token");
    // A dead child is otherwise restarted after one second; this one is left alone.
    thread::sleep(Duration::from_millis(3000));
    assert_eq!(read(&spawns).lines().count(), 1, "started once");

    f.state.set_token(TOKEN, Some(APP_WORD)).unwrap();
    wait_until("a restart on a new token", || read(&spawns).lines().count() == 2);
}

#[test]
fn remove_deletes_the_keychain_item_stops_the_child_and_clears_the_settings() {
    let f = fixture_owned(
        "remove",
        Some(TOKEN),
        &[(CONFIG_FORUM, "123456789012345678")],
        Some(Owner { id: "323456789012345678".into(), username: Some("owner".into()) }),
    );
    let script = connector_script(&f.dir);
    f.state.start(node(), script.clone()).unwrap();
    let lines_path = PathBuf::from(format!("{}.lines", script.display()));
    wait_until("hello", || !read(&lines_path).is_empty());
    let hello: serde_json::Value = serde_json::from_str(read(&lines_path).lines().next().unwrap()).unwrap();
    assert_eq!((hello["forumId"].as_str(), hello["ownerId"].as_str()), (Some("123456789012345678"), Some("323456789012345678")));

    let status = f.state.remove(Some(APP_WORD)).unwrap();
    assert!(f.tokens.deleted.load(Ordering::SeqCst) && f.tokens.read().is_none(), "the Keychain item is deleted");
    assert!(f.settings.get(CONFIG_FORUM).is_none(), "the forum is cleared");
    assert!(f.owners.read().is_none(), "and the owner's Keychain item deleted");
    assert!(!status.configured && !status.running && status.forum_id.is_none() && status.owner.is_none());
    wait_until("the child's stdin to end", || !read(&PathBuf::from(format!("{}.eof", script.display()))).is_empty());
    assert!(!f.state.is_running(), "the supervisor is gone");
    thread::sleep(Duration::from_millis(1500));
    assert_eq!(read(&PathBuf::from(format!("{}.spawns", script.display()))).lines().count(), 1, "and nothing started it again");
}

#[test]
fn the_paired_owner_and_its_name_survive_a_relaunch() {
    let f = fixture("paired", Some(TOKEN));
    let buffer = f.attach_buffer();
    f.state.start_pairing().unwrap();
    let round = current_round(&f);
    paired_in(&f, Some(&round));
    let owner = Some(Owner { id: "323456789012345678".into(), username: Some("jkp".into()) });
    assert_eq!(f.state.status().owner, owner);
    wait_until("the owner line", || of_kind(&buffer.lines(), "owner").len() == 1);

    // A relaunch: a new state over the same saved settings.
    let relaunched = DiscordState::with(Deps {
        tokens: Box::new(Arc::clone(&f.tokens)),
        settings: Arc::clone(&f.settings) as Arc<dyn SettingsStore>,
        owners: Arc::clone(&f.owners) as Arc<dyn OwnerStore>,
        source: Arc::new(Arc::clone(&f.source)),
        acts: Box::new(Arc::clone(&f.acts)),
        state_path: f.dir.join("discord-state.json"),
        log: SupervisorLog::at(None),
    });
    assert_eq!(relaunched.status().owner, owner);
}

// ── what Discord has not yet taken ──

fn message_seqs(buffer: &SharedBuf) -> Vec<u64> {
    of_kind(&buffer.lines(), "message").iter().map(|m| m["seq"].as_u64().unwrap()).collect()
}

fn ack(f: &Fixture, room: &str, seq: u64) {
    on_child_event(&f.state.hub, f.owners.as_ref(), FromChild::Posted { room: room.to_string(), seq, created_at: Some(CREATED), msg_id: None });
}

/// The child says the oldest close it was handed of this room instance is done.
fn closed(f: &Fixture, room: &str) {
    let id = pending_close(f, room);
    on_child_event(&f.state.hub, f.owners.as_ref(), FromChild::Closed { room: room.to_string(), created_at: Some(CREATED), id });
}

fn pending_close(f: &Fixture, room: &str) -> Option<String> {
    let hub = lock(&f.state.hub);
    let batches = hub.draining.get(room)?;
    batches.iter().map(|(feed, _)| feed).find(|feed| feed.close_pending && feed.created_at == Some(CREATED)).and_then(|feed| feed.close_id.clone())
}

fn log_of(f: &Fixture, room: &str, seqs: std::ops::RangeInclusive<u64>) {
    f.source.logs.lock().unwrap().insert(room.to_string(), seqs.map(|seq| mail(seq, "peer-a", "everyone", "tell", &format!("m{seq}"))).collect());
}

#[test]
fn an_ack_trims_exactly_the_seqs_it_names() {
    let f = fixture("ack", Some(TOKEN));
    let _first = f.attach_buffer();
    lock(&f.state.hub).connect(ROOM, vec![], Some(CREATED)).unwrap();
    for seq in 1..=5 {
        lock(&f.state.hub).forward(ToChild::Message {
            room: ROOM.into(), seq, sender: "Codex".into(), to: "everyone".into(), kind: "tell".into(), text: format!("m{seq}"), ts: String::new(),
        });
    }
    assert_eq!(f.state.status().behind.get(ROOM), Some(&5));
    ack(&f, ROOM, 3);
    assert_eq!(f.state.status().behind.get(ROOM), Some(&2));
    ack(&f, ROOM, 2);
    ack(&f, OTHER, 5);
    assert_eq!(f.state.status().behind.get(ROOM), Some(&2), "a stale or foreign ack trims nothing");
    // A child started now is handed exactly what was not acknowledged, in order.
    let second = SharedBuf::default();
    lock(&f.state.hub).attach(ChildChannel::new(Box::new(second.clone())), BotToken::parse(TOKEN).unwrap(), String::new());
    wait_until("the replay", || message_seqs(&second).len() == 2);
    assert_eq!(message_seqs(&second), vec![4, 5]);
    ack(&f, ROOM, 5);
    assert!(f.state.status().behind.is_empty());
}

#[test]
fn a_full_buffer_closes_the_stream_and_resumes_from_the_last_seq_forwarded() {
    let f = fixture("full", Some(TOKEN));
    let buffer = f.attach_buffer();
    lock(&f.state.hub).cap = 2;
    log_of(&f, ROOM, 1..=5);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("the stream to be let go", || f.source.dropped.load(Ordering::SeqCst) == 1);
    thread::sleep(Duration::from_millis(600));
    assert_eq!(message_seqs(&buffer), vec![1, 2], "nothing past the cap is read");
    assert_eq!(f.source.opens.lock().unwrap().len(), 1, "and the stream is not reopened while full");
    assert_eq!(f.state.status().behind.get(ROOM), Some(&2));

    ack(&f, ROOM, 2);
    wait_until("the rest", || message_seqs(&buffer) == vec![1, 2, 3, 4]);
    assert_eq!(f.source.sinces.lock().unwrap()[..2], [0, 2], "reopened from the last seq forwarded");
}

#[test]
fn more_than_the_cap_pending_across_a_child_death_all_arrives_in_order() {
    let f = fixture("death", Some(TOKEN));
    let first = f.attach_buffer();
    lock(&f.state.hub).cap = 4;
    log_of(&f, ROOM, 1..=10);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("the cap", || message_seqs(&first).len() == 4 && f.source.dropped.load(Ordering::SeqCst) == 1);

    // The child dies having acknowledged nothing; a new one starts.
    lock(&f.state.hub).channel = None;
    let second = SharedBuf::default();
    lock(&f.state.hub).attach(ChildChannel::new(Box::new(second.clone())), BotToken::parse(TOKEN).unwrap(), String::new());
    wait_until("the replay", || message_seqs(&second) == vec![1, 2, 3, 4]);
    // It acknowledges selectively: up to 3, then up to 7, then everything.
    ack(&f, ROOM, 3);
    wait_until("five to seven", || message_seqs(&second).len() == 7);
    ack(&f, ROOM, 7);
    wait_until("all ten", || message_seqs(&second).len() == 10);
    ack(&f, ROOM, 10);
    assert_eq!(message_seqs(&second), (1..=10).collect::<Vec<_>>(), "every seq, once, in order");
    assert_eq!(f.source.sinces.lock().unwrap()[..3], [0, 4, 7]);
    assert!(f.state.status().behind.is_empty());
}

#[test]
fn a_stream_cut_mid_frame_reopens_from_the_last_frame_read_whole() {
    let f = fixture("cut", Some(TOKEN));
    let buffer = f.attach_buffer();
    f.members(ROOM, &[("peer-a", "Codex")]);
    let mut bytes = frames(ROOM, &[&mail(1, "peer-a", "everyone", "tell", "one"), &mail(2, "peer-a", "everyone", "tell", "two")]);
    let third = frames(ROOM, &[&mail(3, "peer-a", "everyone", "tell", "three")]);
    // The connection drops halfway through seq 3's frame.
    bytes.extend_from_slice(&third[..third.len() - 20]);
    f.source.streams.lock().unwrap().entry(ROOM.to_string()).or_default().push_back(bytes);
    f.stream(ROOM, &[mail(3, "peer-a", "everyone", "tell", "three")]);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("three", || message_seqs(&buffer) == vec![1, 2, 3]);
    assert_eq!(f.source.sinces.lock().unwrap()[..2], [0, 2], "reopened after the last whole frame, not from the bridge's cursor");
}

#[test]
fn what_discord_accepted_is_told_to_the_bridge_coalesced_on_the_apps_word() {
    let f = fixture("relay-ack", Some(TOKEN));
    let buffer = f.attach_buffer();
    log_of(&f, ROOM, 1..=5);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("five", || message_seqs(&buffer).len() == 5);
    {
        // Four ACKs inside one lock, so no flush can fall between them.
        let mut hub = lock(&f.state.hub);
        for seq in 1..=4 {
            hub.ack(ROOM, seq, Some(CREATED), None);
        }
    }
    wait_until("an ack to the bridge", || !f.source.acks.lock().unwrap().is_empty());
    assert_eq!(f.source.acks.lock().unwrap()[0], (ROOM.to_string(), APP_WORD.to_string(), 4), "the highest, once, not one per seq");
    ack(&f, ROOM, 5);
    wait_until("the next", || f.source.acks.lock().unwrap().len() == 2);
    assert_eq!(f.source.acks.lock().unwrap()[1].2, 5);
    thread::sleep(Duration::from_millis(2500));
    assert_eq!(f.source.acks.lock().unwrap().len(), 2, "nothing new, nothing sent");
}

#[test]
fn a_late_ack_for_a_codes_earlier_room_never_trims_its_new_room() {
    let f = fixture("stale-ack", Some(TOKEN));
    let _buffer = f.attach_buffer();
    let line = |seq: u64| ToChild::Message { room: ROOM.into(), seq, sender: "Codex".into(), to: "everyone".into(), kind: "tell".into(), text: format!("m{seq}"), ts: String::new() };
    {
        let mut hub = lock(&f.state.hub);
        hub.connect(ROOM, vec![], Some(100)).unwrap();
        hub.forward(line(100));
        hub.disconnect(ROOM, DisconnectReason::Closed);
        hub.connect(ROOM, vec![], Some(200)).unwrap();
        hub.forward(line(1));
    }
    // The old child finishes the old room's send late.
    on_child_event(&f.state.hub, f.owners.as_ref(), FromChild::Posted { room: ROOM.into(), seq: 100, created_at: Some(100), msg_id: None });
    assert_eq!(lock(&f.state.hub).backlog(ROOM), Some(1), "the new room still holds its seq 1");
    on_child_event(&f.state.hub, f.owners.as_ref(), FromChild::Posted { room: ROOM.into(), seq: 100, created_at: None, msg_id: None });
    assert_eq!(lock(&f.state.hub).backlog(ROOM), Some(1), "an ACK naming no room instance trims nothing");
    // Its own ACK, even one past what was forwarded, trims only what exists.
    on_child_event(&f.state.hub, f.owners.as_ref(), FromChild::Posted { room: ROOM.into(), seq: 100, created_at: Some(200), msg_id: None });
    assert_eq!(lock(&f.state.hub).backlog(ROOM), Some(0));
    assert_eq!(lock(&f.state.hub).rooms.get(ROOM).unwrap().acked, 1, "clamped to the forwarded range");
    // A child that is no longer current is not heard at all.
    lock(&f.state.hub).forward(line(2));
    let stale = lock(&f.state.hub).epoch.wrapping_sub(1);
    on_child_event_from(&f.state.hub, f.owners.as_ref(), stale, FromChild::Posted { room: ROOM.into(), seq: 2, created_at: Some(200), msg_id: None });
    assert_eq!(lock(&f.state.hub).backlog(ROOM), Some(1));
}

#[test]
fn a_room_whose_instance_cannot_be_read_is_not_followed_and_the_relay_is_taken_out() {
    let f = fixture("no-roster", Some(TOKEN));
    let buffer = f.attach_buffer();
    f.source.roster_fails.store(true, Ordering::SeqCst);
    assert!(f.state.connect(ROOM, APP_WORD).is_err());
    assert_eq!(f.acts.joins.lock().unwrap().len(), 1, "premise: the relay had joined");
    assert_eq!(f.acts.leaves.lock().unwrap().as_slice(), [ROOM.to_string()], "and was taken out again");
    thread::sleep(Duration::from_millis(100));
    assert!(of_kind(&buffer.lines(), "connect").is_empty(), "no connect without the room's instance");
    assert!(f.state.status().connected_rooms.is_empty());
}

#[test]
fn a_disconnect_keeps_what_discord_has_not_taken_and_a_new_child_gets_it() {
    let f = fixture("drain", Some(TOKEN));
    let _first = f.attach_buffer();
    log_of(&f, ROOM, 1..=3);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("three forwarded", || lock(&f.state.hub).rooms.get(ROOM).is_some_and(|feed| feed.last_seq == 3));
    f.state.disconnect(ROOM, Some(APP_WORD)).unwrap();
    assert_eq!(f.state.status().behind.get(ROOM), Some(&4), "still owed to Discord after the disconnect: three lines and the close");
    // The child dies with the lines only in its queue; a new one is handed them, then the close.
    lock(&f.state.hub).channel = None;
    let second = SharedBuf::default();
    lock(&f.state.hub).attach(ChildChannel::new(Box::new(second.clone())), BotToken::parse(TOKEN).unwrap(), String::new());
    wait_until("the replay", || of_kind(&second.lines(), "disconnect").len() == 1);
    let kinds: Vec<String> = second.lines().iter().map(|line| line["t"].as_str().unwrap().to_string()).collect();
    assert_eq!(kinds, ["hello", "connect", "message", "message", "message", "disconnect"]);
    ack(&f, ROOM, 3);
    closed(&f, ROOM);
    assert!(f.state.status().behind.is_empty(), "taken by Discord and closed, so let go");
}

#[test]
fn a_second_disconnect_before_the_first_was_taken_keeps_both() {
    let f = fixture("two-disconnects", Some(TOKEN));
    let _first = f.attach_buffer();
    let line = |seq: u64| ToChild::Message { room: ROOM.into(), seq, sender: "Codex".into(), to: "everyone".into(), kind: "tell".into(), text: format!("m{seq}"), ts: String::new() };
    {
        let mut hub = lock(&f.state.hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(line(1));
        hub.disconnect(ROOM, DisconnectReason::Disconnected);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(line(2));
        hub.disconnect(ROOM, DisconnectReason::Disconnected);
    }
    assert_eq!(f.state.status().behind.get(ROOM), Some(&4), "two lines, two closes");
    // The child dies; a new one is handed both batches, in order, each with its close.
    lock(&f.state.hub).channel = None;
    let second = SharedBuf::default();
    lock(&f.state.hub).attach(ChildChannel::new(Box::new(second.clone())), BotToken::parse(TOKEN).unwrap(), String::new());
    wait_until("both batches", || of_kind(&second.lines(), "disconnect").len() == 2);
    let replay: Vec<String> = second.lines().iter().skip(1).map(|line| format!("{}{}", line["t"].as_str().unwrap(), line["seq"].as_u64().map(|seq| seq.to_string()).unwrap_or_default())).collect();
    assert_eq!(replay, ["connect", "message1", "disconnect", "connect", "message2", "disconnect"]);
    ack(&f, ROOM, 1);
    closed(&f, ROOM);
    assert_eq!(f.state.status().behind.get(ROOM), Some(&2), "the second batch's line and close");
    ack(&f, ROOM, 2);
    closed(&f, ROOM);
    assert!(f.state.status().behind.is_empty());
}

#[test]
fn a_token_write_that_lost_the_old_one_leaves_the_app_not_configured() {
    let f = fixture("token-wiped", Some(TOKEN));
    let script = connector_script(&f.dir);
    f.state.start(node(), script.clone()).unwrap();
    assert!(f.state.is_running() && f.state.status().configured, "premise: running on the old token");
    f.tokens.wipe_on_write.store(true, Ordering::SeqCst);
    assert!(f.state.set_token(&TOKEN.replace('G', "H"), Some(APP_WORD)).is_err());
    let status = f.state.status();
    assert!(!status.configured, "the Keychain has no token, so neither does the app");
    assert!(!f.state.is_running(), "and the connector is stopped");
}

#[test]
fn an_owner_write_that_lost_the_old_owner_leaves_the_app_not_paired() {
    let f = fixture_owned("owner-wiped", Some(TOKEN), &[], Some(Owner { id: "423456789012345678".into(), username: Some("old".into()) }));
    let _buffer = f.attach_buffer();
    f.owners.fail.store(true, Ordering::SeqCst);
    f.owners.wipe.store(true, Ordering::SeqCst);
    ack_paired(&f);
    let status = f.state.status();
    assert_eq!(status.owner, None, "the Keychain has no owner, so neither does the app");
    assert!(status.error.is_some());
}

#[test]
fn remove_says_what_discord_had_not_taken_when_it_stopped() {
    let f = fixture("dropped", Some(TOKEN));
    let _buffer = f.attach_buffer();
    log_of(&f, ROOM, 1..=2);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("two forwarded", || lock(&f.state.hub).rooms.get(ROOM).is_some_and(|feed| feed.last_seq == 2));
    let status = f.state.remove(Some(APP_WORD)).unwrap();
    assert_eq!(status.dropped.get(ROOM), Some(&2), "not silent: {:?}", status.dropped);
}

// ── leaving and pairing that did not happen ──

#[test]
fn a_leave_the_bridge_refused_is_shown_and_retried() {
    let f = fixture("leave", Some(TOKEN));
    let _buffer = f.attach_buffer();
    f.state.connect(ROOM, APP_WORD).unwrap();
    f.acts.fail_leave.store(true, Ordering::SeqCst);
    assert!(f.state.disconnect(ROOM, Some(APP_WORD)).is_err(), "the failure reaches the caller");
    let status = f.state.status();
    assert!(status.connected_rooms.is_empty());
    assert!(status.leaving.contains_key(ROOM), "the relay still in the room is shown: {:?}", status.leaving);
    // Without the app's word there is no leave at all; that too stays shown.
    assert!(f.state.disconnect(ROOM, None).is_err());
    assert!(f.state.status().leaving.contains_key(ROOM));

    f.acts.fail_leave.store(false, Ordering::SeqCst);
    f.state.disconnect(ROOM, Some(APP_WORD)).expect("the retry succeeds");
    assert!(f.state.status().leaving.is_empty());
    assert_eq!(f.acts.leaves.lock().unwrap().len(), 2, "tried, then retried");
}

#[test]
fn remove_reports_a_relay_it_could_not_take_out() {
    let f = fixture("remove-leave", Some(TOKEN));
    let _buffer = f.attach_buffer();
    f.state.connect(ROOM, APP_WORD).unwrap();
    f.acts.fail_leave.store(true, Ordering::SeqCst);
    assert!(f.state.remove(Some(APP_WORD)).is_err());
    assert!(f.state.status().leaving.contains_key(ROOM));
    f.acts.fail_leave.store(false, Ordering::SeqCst);
    f.state.disconnect(ROOM, Some(APP_WORD)).expect("a later disconnect retries");
    assert!(f.state.status().leaving.is_empty());
}

#[test]
fn a_pairing_that_cannot_be_saved_does_not_pair() {
    let f = fixture("pair-unsaved", Some(TOKEN));
    let buffer = f.attach_buffer();
    f.owners.fail.store(true, Ordering::SeqCst);
    ack_paired(&f);
    let status = f.state.status();
    assert_eq!(status.owner, None);
    assert!(status.error.as_ref().is_some_and(|error| error.message.contains("Pairing could not be saved")), "{:?}", status.error);
    thread::sleep(Duration::from_millis(100));
    assert!(of_kind(&buffer.lines(), "owner").is_empty(), "the child is not told of an owner");

    // Nor after a relaunch: nothing half-written reads as an owner.
    assert_eq!(relaunch(&f).status().owner, None);
    // Premise: with the Keychain writable, the same event pairs.
    f.owners.fail.store(false, Ordering::SeqCst);
    ack_paired(&f);
    assert!(f.state.status().owner.is_some());
}

fn relaunch(f: &Fixture) -> DiscordState {
    DiscordState::with(Deps {
        tokens: Box::new(Arc::clone(&f.tokens)),
        settings: Arc::clone(&f.settings) as Arc<dyn SettingsStore>,
        owners: Arc::clone(&f.owners) as Arc<dyn OwnerStore>,
        source: Arc::new(Arc::clone(&f.source)),
        acts: Box::new(Arc::clone(&f.acts)),
        state_path: f.dir.join("discord-state.json"),
        log: SupervisorLog::at(None),
    })
}

#[test]
fn the_owner_comes_only_from_the_keychain_never_from_the_config_file() {
    // Any process of this user can write the config: an id there is not an owner, and the
    // keys earlier builds used are deleted on start.
    let f = fixture_with("config-owner", Some(TOKEN), &[("discordOwner", "323456789012345678"), ("discordOwnerId", "323456789012345678"), ("discordOwnerName", "planted")]);
    assert_eq!(f.state.status().owner, None, "a config owner is not paired");
    for key in LEGACY_OWNER_KEYS {
        assert!(f.settings.get(key).is_none(), "{key} is deleted");
    }
    let _buffer = f.attach_buffer();
    f.state.start_pairing().unwrap();
    let round = current_round(&f);
    paired_in(&f, Some(&round));
    let (owner, paired_at) = f.owners.record.lock().unwrap().clone().expect("one Keychain record");
    assert_eq!(owner, Owner { id: "323456789012345678".into(), username: Some("jkp".into()) });
    assert!(paired_at.starts_with("20"));
    assert!(LEGACY_OWNER_KEYS.iter().all(|key| f.settings.get(key).is_none()), "nothing written to the config");
    assert_eq!(relaunch(&f).status().owner, Some(owner), "and it is read back from the Keychain");
}

fn ack_paired(f: &Fixture) {
    if lock(&f.state.hub).pairing.is_none() {
        f.state.start_pairing().unwrap();
    }
    let round = current_round(f);
    paired_in(f, Some(&round));
}

fn current_round(f: &Fixture) -> String {
    lock(&f.state.hub).pairing.as_ref().map(|pairing| pairing.round.clone()).expect("a pairing is held")
}

fn paired_in(f: &Fixture, round: Option<&str>) {
    on_child_event(
        &f.state.hub,
        f.owners.as_ref(),
        FromChild::Paired { owner_id: "323456789012345678".into(), username: "jkp".into(), round: round.map(str::to_string) },
    );
}

#[test]
fn only_the_round_held_now_and_fresh_pairs() {
    let f = fixture("rounds", Some(TOKEN));
    let buffer = f.attach_buffer();
    f.state.start_pairing().unwrap();
    let a = current_round(&f);
    f.state.start_pairing().unwrap();
    let b = current_round(&f);
    assert_ne!(a, b, "each start draws its own round");
    wait_until("both pair lines", || of_kind(&buffer.lines(), "pair").len() == 2);
    let pairs = of_kind(&buffer.lines(), "pair").iter().map(|line| line["round"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(pairs, vec![a.clone(), b.clone()], "the child is told each round");

    // A's pairing arrives after "New code": the replaced code pairs nobody.
    paired_in(&f, Some(&a));
    assert_eq!(f.state.status().owner, None);
    paired_in(&f, None);
    assert_eq!(f.state.status().owner, None, "nor does a pairing that names no round");
    // B's does.
    paired_in(&f, Some(&b));
    assert!(f.state.status().owner.is_some());

    // A round past its ten minutes, by the app's clock, pairs nobody either.
    let g = fixture("rounds-expired", Some(TOKEN));
    let _buffer = g.attach_buffer();
    g.state.start_pairing().unwrap();
    let c = current_round(&g);
    lock(&g.state.hub).pairing.as_mut().unwrap().at = Instant::now() - PAIRING_TTL - Duration::from_secs(1);
    paired_in(&g, Some(&c));
    assert_eq!(g.state.status().owner, None);
}

#[test]
fn a_reconnect_says_how_many_went_by_while_discord_was_not_following() {
    let f = fixture("rejoin", Some(TOKEN));
    let buffer = f.attach_buffer();
    f.members(ROOM, &[("peer-a", "Codex")]);
    f.stream(ROOM, &[mail(1, "peer-a", "everyone", "tell", "one"), mail(2, "peer-a", "everyone", "tell", "two"), mail(3, "peer-a", "everyone", "tell", "three")]);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("three", || message_seqs(&buffer) == vec![1, 2, 3]);
    f.state.disconnect(ROOM, Some(APP_WORD)).unwrap();
    // Seqs 4..6 go by unfollowed; the rejoined relay is handed its own join notice first.
    f.source.streams.lock().unwrap().clear();
    f.stream(ROOM, &[mail(7, "gyredeck-room", "everyone", "notice", "Discord joined this room."), mail(8, "peer-a", "everyone", "tell", "eight")]);
    let opened_before = f.source.sinces.lock().unwrap().len();
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("eight", || message_seqs(&buffer).contains(&8));
    let lines = buffer.lines();
    let after: Vec<(u64, String)> = of_kind(&lines, "message")
        .iter()
        .skip(3)
        .map(|m| (m["seq"].as_u64().unwrap(), m["text"].as_str().unwrap().to_string()))
        .collect();
    assert_eq!(
        after,
        vec![(4, "3 lines went by unfollowed".into()), (7, "Discord joined this room.".into()), (8, "eight".into())]
    );
    assert_eq!(f.source.sinces.lock().unwrap()[opened_before], 3, "the last seq it read; the bridge starts no earlier than the new join");
}

#[test]
fn connect_is_refused_until_the_current_child_is_ready_and_a_refused_token_undoes_it() {
    let f = fixture("ready", Some(TOKEN));
    let _buffer = f.attach_buffer();
    on_child_event(
        &f.state.hub,
        f.owners.as_ref(),
        FromChild::Ready { bot: Bot { id: "42".into(), username: "Gyre Bot".into() }, application_id: "123456789012345678".into(), forums: vec![] },
    );
    assert!(f.state.status().ready, "premise: a good token is ready");
    // The token changes and the new one is refused.
    on_child_event(&f.state.hub, f.owners.as_ref(), FromChild::Error { code: "bad_token".into(), message: "refused".into() });
    let status = f.state.status();
    assert!(!status.ready);
    assert_eq!((status.bot, status.invite_url), (None, None), "nothing of the old child is left showing");
    assert!(f.state.connect(ROOM, APP_WORD).is_err(), "Connect is refused");
    assert!(f.acts.joins.lock().unwrap().is_empty(), "and nothing joined");
}

// ── pieces ──

#[test]
fn server_sent_events_cut_anywhere_come_out_whole() {
    let stream = b": hello\n\nid: 1\nevent: mail\ndata: {\"seq\":1}\n\nevent: error\ndata: {\"fatal\":true}\r\n\r\n";
    for cut in 1..stream.len() {
        let mut parser = SseParser::default();
        let mut events = parser.feed(&stream[..cut]);
        events.extend(parser.feed(&stream[cut..]));
        let seen: Vec<(String, String)> = events.into_iter().map(|event| (event.name, event.data)).collect();
        assert_eq!(seen, vec![("mail".into(), "{\"seq\":1}".into()), ("error".into(), "{\"fatal\":true}".into())], "cut at {cut}");
    }
}

#[test]
fn a_token_is_checked_for_shape_before_it_is_kept() {
    assert!(BotToken::parse(TOKEN).is_ok());
    assert!(BotToken::parse(&format!("  {TOKEN}\n")).is_ok());
    for bad in ["", "abc", "a.b.c", &format!("{TOKEN}.x"), &TOKEN.replace('G', " "), &TOKEN.replace('a', "+")] {
        assert!(BotToken::parse(bad).is_err(), "{bad:?}");
    }
}

// ── against a real bridge ──

/// The app's acts against a bridge this test started.
struct LiveActs {
    target: standalone_bridge::BridgeTarget,
    password: String,
    room: String,
}

impl RoomActs for LiveActs {
    fn password(&self, room: &str) -> Option<String> {
        (room == self.room).then(|| self.password.clone())
    }
    fn join_relay(&self, room: &str, member: &str, app_word: &str) -> Result<(), String> {
        standalone_bridge::sync_join_relay_to(&self.target, room, member, app_word).map(|_| ())
    }
    fn leave(&self, _room: &str, _member: &str, _app_word: &str) -> Result<(), String> {
        Ok(())
    }
}

struct LiveBridge {
    child: Child,
    home: PathBuf,
}

impl Drop for LiveBridge {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

#[test]
fn a_real_bridge_room_reaches_the_child_in_order_named_and_closes() {
    let port = {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.local_addr().unwrap().port()
    };
    let home = scratch("live-bridge");
    fs::create_dir_all(home.join(".config/gyredeck")).unwrap();
    fs::write(home.join(".config/gyredeck/gyredeck.config.json"), format!("{{\"host\":\"127.0.0.1\",\"port\":{port}}}")).unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../adapters/bridge/gyredeck-bridge.mjs");
    let mut child = Command::new(node())
        .arg(&script)
        .args(["--port", &port.to_string(), "--host", "127.0.0.1", "--parent-stdio", "--broker-handshake"])
        .env("HOME", &home)
        .env("GYREDECK_NO_AGENT_SPAWN", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start the bridge");
    child.stdin.as_mut().unwrap().write_all(format!("broker-secret {APP_WORD}\nbroker-ready\n").as_bytes()).unwrap();
    let bridge = LiveBridge { child, home: home.clone() };
    let token_path = home.join(".config/gyredeck/gyredeck.ingest-token");
    wait_until("the bridge to serve", || {
        token_path.exists() && TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_ok()
    });
    let app = standalone_bridge::BridgeTarget { port, token: fs::read_to_string(&token_path).unwrap().trim().to_string() };
    let call = |target: &standalone_bridge::BridgeTarget, method: &str, path: &str, body: serde_json::Value, word: Option<&str>| {
        standalone_bridge::bridge_request_to(target, method, path, Some(body.to_string()), Duration::from_secs(2), word).unwrap()
    };

    let (status, created) = call(&app, "POST", "/sync/rooms", serde_json::json!({ "conversationId": "founder-1" }), Some(APP_WORD));
    assert_eq!(status, 201, "{created}");
    let room = created["room"].as_str().unwrap().to_string();
    let password = created["password"].as_str().unwrap().to_string();
    for peer in ["peer-a", "peer-b"] {
        assert_eq!(call(&app, "POST", &format!("/sync/rooms/{room}/members"), serde_json::json!({ "conversationId": peer }), Some(APP_WORD)).0, 200);
        assert_eq!(call(&app, "POST", &format!("/sync/rooms/{room}/confirm"), serde_json::json!({ "conversationId": peer, "password": password }), None).0, 200);
    }

    let tokens = Arc::new(MemTokens::default());
    *tokens.token.lock().unwrap() = Some(BotToken::parse(TOKEN).unwrap());
    let state = DiscordState::with(Deps {
        tokens: Box::new(tokens),
        settings: Arc::new(MemSettings::default()),
        owners: Arc::new(MemOwner::default()),
        source: Arc::new(BridgeSource { target: Some(app.clone()) }),
        acts: Box::new(LiveActs { target: app.clone(), password: password.clone(), room: room.clone() }),
        state_path: home.join("discord-state.json"),
        log: SupervisorLog::at(None),
    });
    let buffer = SharedBuf::default();
    state.configured.store(true, Ordering::SeqCst);
    lock(&state.hub).attach(ChildChannel::new(Box::new(buffer.clone())), BotToken::parse(TOKEN).unwrap(), String::new());
    lock(&state.hub).ready = true;
    lock(&state.hub).forum_id = Some("223456789012345678".to_string());
    state.connect(&room, APP_WORD).expect("connect through the real join");
    wait_until("the connect line", || !of_kind(&buffer.lines(), "connect").is_empty());
    let connect = of_kind(&buffer.lines(), "connect")[0].clone();
    assert_eq!(connect["members"], serde_json::json!(["Agent", "Agent #peer-a", "Agent #peer-b", "Discord"]));
    assert!(connect["createdAt"].as_u64().is_some());

    let speaker = standalone_bridge::BridgeTarget { port, token: password.clone() };
    let post = |from: &str, to: &str, kind: &str, text: &str| {
        let (status, body) = call(&speaker, "POST", &format!("/mail/{room}"), serde_json::json!({ "from": from, "to": to, "kind": kind, "text": text }), None);
        assert_eq!(status, 202, "{body}");
    };
    post("peer-a", "peer-b", "ask", "first, between two others");
    post("peer-b", "peer-a", "reaction", "second");
    post("founder-1", "everyone", "tell", "third, to everyone\nwith a second line");

    wait_until("three messages", || of_kind(&buffer.lines(), "message").iter().filter(|m| m["sender"] != "Room").count() == 3);
    let lines = buffer.lines();
    let said: Vec<(String, String, String, String)> = of_kind(&lines, "message")
        .iter()
        .filter(|m| m["sender"] != "Room")
        .map(|m| {
            (m["sender"].as_str().unwrap().into(), m["to"].as_str().unwrap().into(), m["kind"].as_str().unwrap().into(), m["text"].as_str().unwrap().into())
        })
        .collect();
    assert_eq!(
        said,
        vec![
            ("Agent #peer-a".into(), "Agent #peer-b".into(), "ask".into(), "first, between two others".into()),
            ("Agent #peer-b".into(), "Agent #peer-a".into(), "reaction".into(), "second".into()),
            ("Agent".into(), "everyone".into(), "tell".into(), "third, to everyone\nwith a second line".into()),
        ]
    );
    let seqs: Vec<u64> = of_kind(&lines, "message").iter().map(|m| m["seq"].as_u64().unwrap()).collect();
    assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]), "in seq order: {seqs:?}");

    let (status, _) = standalone_bridge::bridge_request_to(&app, "DELETE", &format!("/sync/rooms/{room}?as=founder-1"), None, Duration::from_secs(2), Some(APP_WORD)).unwrap();
    assert_eq!(status, 200);
    wait_until("the room closed", || !of_kind(&buffer.lines(), "disconnect").is_empty());
    assert_eq!(of_kind(&buffer.lines(), "disconnect")[0]["reason"], "closed");
    assert!(state.status().connected_rooms.is_empty());
    drop(bridge);
}

// ── ported from the r4 and r5 stand-in audits ──

#[test]
fn standin_a_room_closed_while_no_child_runs_is_still_closed_by_the_next_child() {
    let f = fixture("standin-lost-close", Some(TOKEN));
    let _first = f.attach_buffer();
    {
        let mut hub = lock(&f.state.hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(ToChild::Message { room: ROOM.into(), seq: 1, sender: "Codex".into(), to: "everyone".into(), kind: "tell".into(), text: "m1".into(), ts: String::new() });
        hub.ack(ROOM, 1, Some(CREATED), None);
        assert_eq!(hub.backlog(ROOM), Some(0), "premise: nothing owed to Discord");
        // The child is gone (died, or its pipe filled) and the room ends before the next is up.
        hub.channel = None;
        assert!(hub.disconnect(ROOM, DisconnectReason::Closed), "premise: the room was followed");
    }
    let second = SharedBuf::default();
    lock(&f.state.hub).attach(ChildChannel::new(Box::new(second.clone())), BotToken::parse(TOKEN).unwrap(), String::new());
    wait_until("hello", || !second.lines().is_empty());
    thread::sleep(Duration::from_millis(150));
    let kinds: Vec<String> = second.lines().iter().map(|line| line["t"].as_str().unwrap().to_string()).collect();
    assert!(kinds.iter().any(|kind| kind == "disconnect"), "the next child is never told the room closed, so its post stays open: {kinds:?}");
}

#[test]
fn standin_remove_keeps_the_child_epoch() {
    let f = fixture("standin-epoch", Some(TOKEN));
    let _buffer = f.attach_buffer();
    lock(&f.state.hub).epoch = 3;
    f.state.remove(Some(APP_WORD)).unwrap();
    assert_eq!(lock(&f.state.hub).epoch, 3, "a reset epoch lets a dead child's last lines count as the next child's");
}

fn audit_line(seq: u64) -> ToChild {
    ToChild::Message { room: ROOM.into(), seq, sender: "Codex".into(), to: "everyone".into(), kind: "tell".into(), text: format!("m{seq}"), ts: String::new() }
}

#[test]
fn audit_a_disconnect_then_a_close_keep_both_batches_and_one_ack_trims_both() {
    let f = fixture("audit-two-batches", Some(TOKEN));
    let _first = f.attach_buffer();
    {
        let mut hub = lock(&f.state.hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(audit_line(1));
        hub.disconnect(ROOM, DisconnectReason::Disconnected);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        // Resumed at 1: seq 3 queues a gap notice (seq 2) ahead of it.
        hub.forward(audit_line(3));
        hub.disconnect(ROOM, DisconnectReason::Closed);
    }
    assert_eq!(f.state.status().behind.get(ROOM), Some(&5), "m1, close | notice2, m3, close");
    assert_eq!(lock(&f.state.hub).draining.get(ROOM).map(|b| b.len()), Some(2));
    assert!(!lock(&f.state.hub).resume.contains_key(ROOM), "Closed drops the resume point");
    on_child_event(&f.state.hub, f.owners.as_ref(), FromChild::Posted { room: ROOM.into(), seq: 3, created_at: Some(CREATED + 1), msg_id: None });
    assert_eq!(f.state.status().behind.get(ROOM), Some(&5), "another instance's ACK trims nothing");
    on_child_event(&f.state.hub, f.owners.as_ref(), FromChild::Posted { room: ROOM.into(), seq: 3, created_at: None, msg_id: None });
    assert_eq!(f.state.status().behind.get(ROOM), Some(&5), "an ACK naming no instance trims nothing");
    ack(&f, ROOM, 3);
    assert_eq!(f.state.status().behind.get(ROOM), Some(&2), "one ACK for the last seq trims both batches' lines; their closes wait");
    closed(&f, ROOM);
    closed(&f, ROOM);
    assert!(f.state.status().behind.is_empty());
    assert!(lock(&f.state.hub).draining.is_empty());
}

#[test]
fn audit_three_batches_replay_oldest_first_and_an_ack_in_the_middle_keeps_the_rest() {
    let f = fixture("audit-three-batches", Some(TOKEN));
    let _first = f.attach_buffer();
    {
        let mut hub = lock(&f.state.hub);
        for seq in 1..=3 {
            hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
            hub.forward(audit_line(seq));
            hub.disconnect(ROOM, DisconnectReason::Disconnected);
        }
    }
    assert_eq!(f.state.status().behind.get(ROOM), Some(&6), "three lines, three closes");
    ack(&f, ROOM, 2);
    closed(&f, ROOM);
    closed(&f, ROOM);
    assert_eq!(f.state.status().behind.get(ROOM), Some(&2));
    assert_eq!(lock(&f.state.hub).draining.get(ROOM).map(|b| b.len()), Some(1), "the two taken and closed batches are gone");
    lock(&f.state.hub).channel = None;
    let second = SharedBuf::default();
    lock(&f.state.hub).attach(ChildChannel::new(Box::new(second.clone())), BotToken::parse(TOKEN).unwrap(), String::new());
    wait_until("the replay", || of_kind(&second.lines(), "disconnect").len() == 1);
    let replay: Vec<String> = second.lines().iter().skip(1).map(|line| format!("{}{}", line["t"].as_str().unwrap(), line["seq"].as_u64().map(|seq| seq.to_string()).unwrap_or_default())).collect();
    assert_eq!(replay, ["connect", "message3", "disconnect"]);
}

#[test]
fn audit_a_token_write_that_failed_but_kept_the_old_one_leaves_the_app_configured_and_running() {
    let f = fixture("audit-token-kept", Some(TOKEN));
    let script = connector_script(&f.dir);
    f.state.start(node(), script).unwrap();
    assert!(f.state.is_running() && f.state.status().configured, "premise");
    f.tokens.fail_write.store(true, Ordering::SeqCst);
    assert!(f.state.set_token(&TOKEN.replace('G', "H"), Some(APP_WORD)).is_err());
    assert!(f.state.status().configured, "the Keychain still has the old token");
    assert!(f.state.is_running(), "and the connector on it keeps going");
    assert_eq!(f.tokens.read().map(|t| t.expose().to_string()), Some(TOKEN.to_string()));
}

#[test]
fn audit_an_owner_write_that_failed_but_kept_the_old_owner_leaves_it_paired_to_the_old_one() {
    let old = Owner { id: "423456789012345678".into(), username: Some("old".into()) };
    let f = fixture_owned("audit-owner-kept", Some(TOKEN), &[], Some(old.clone()));
    let _buffer = f.attach_buffer();
    f.owners.fail.store(true, Ordering::SeqCst);
    ack_paired(&f);
    let status = f.state.status();
    assert_eq!(status.owner, Some(old));
    assert!(status.error.is_some());
}


#[test]
fn a_wiped_token_stops_following_every_room_the_way_remove_does() {
    let f = fixture("token-wiped-rooms", Some(TOKEN));
    let _buffer = f.attach_buffer();
    log_of(&f, ROOM, 1..=1);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("forwarded", || lock(&f.state.hub).rooms.get(ROOM).is_some_and(|feed| feed.last_seq == 1));
    f.tokens.wipe_on_write.store(true, Ordering::SeqCst);
    assert!(f.state.set_token(&TOKEN.replace('G', "H"), Some(APP_WORD)).is_err());
    let status = f.state.status();
    assert!(!status.configured);
    assert!(status.connected_rooms.is_empty(), "no room is followed under \"not set up\"");
    assert_eq!(f.acts.leaves.lock().unwrap().as_slice(), [ROOM.to_string()], "the relay was taken out");
    assert_eq!(status.dropped.get(ROOM), Some(&1), "and what Discord had not taken is said");
}

#[test]
fn after_a_wiped_owner_the_child_is_told_and_the_round_is_let_go() {
    let old = Owner { id: "423456789012345678".into(), username: Some("old".into()) };
    let f = fixture_owned("owner-child", Some(TOKEN), &[], Some(old));
    let buffer = f.attach_buffer();
    f.owners.fail.store(true, Ordering::SeqCst);
    f.owners.wipe.store(true, Ordering::SeqCst);
    ack_paired(&f);
    wait_until("the owner line", || !of_kind(&buffer.lines(), "owner").is_empty());
    let lines = buffer.lines();
    assert!(of_kind(&lines, "owner")[0]["ownerId"].is_null(), "the child is told there is no owner");
    assert!(lock(&f.state.hub).pairing.is_none(), "and the failed round is not held");
}

#[test]
fn the_owner_line_names_the_round_it_accepts() {
    let f = fixture("owner-round", Some(TOKEN));
    let buffer = f.attach_buffer();
    f.state.start_pairing().unwrap();
    let round = current_round(&f);
    paired_in(&f, Some(&round));
    wait_until("the owner line", || !of_kind(&buffer.lines(), "owner").is_empty());
    assert_eq!(of_kind(&buffer.lines(), "owner")[0]["round"].as_str(), Some(round.as_str()));
}

#[test]
fn a_storage_refusal_stays_shown_through_ready() {
    let f = fixture("storage-sticky", Some(TOKEN));
    let _buffer = f.attach_buffer();
    on_child_event(&f.state.hub, f.owners.as_ref(), FromChild::Error { code: "storage_blocked".into(), message: "The Discord state file could not be read".into() });
    on_child_event(
        &f.state.hub,
        f.owners.as_ref(),
        FromChild::Ready { bot: Bot { id: "42".into(), username: "Gyre Bot".into() }, application_id: "123456789012345678".into(), forums: vec![] },
    );
    assert_eq!(f.state.status().error.map(|error| error.code).as_deref(), Some("storage_blocked"));
}

// ── #199 r7: the invariants the audit found open (199-invariants.md §5), one proof each ──

fn held_line(seq: u64, sender: &str) -> ToChild {
    ToChild::Message { room: ROOM.to_string(), seq, sender: sender.into(), to: "everyone".into(), kind: "tell".into(), text: "x".repeat(1024), ts: String::new() }
}

/// I18: an attach hands a fresh child everything held, however much, at the pace it reads.
#[test]
fn i18_an_attach_of_more_lines_than_any_queue_held_keeps_the_channel_while_the_child_starts() {
    let f = fixture("i18-attach", Some(TOKEN));
    let held = 5096;
    {
        let mut hub = lock(&f.state.hub);
        hub.cap = held + 1;
        // Five megabytes of text: past the byte budget, which this attach is not about.
        hub.cap_bytes = usize::MAX;
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        for seq in 1..=held as u64 {
            hub.forward(held_line(seq, "a"));
        }
        assert_eq!(hub.backlog(ROOM), Some(held), "premise: every line is held for the next child");
    }
    let mut process = Command::new("sh").arg("-c").arg("sleep 0.5; wc -l").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let stdin = process.stdin.take().unwrap();
    lock(&f.state.hub).attach(ChildChannel::new(Box::new(stdin)), BotToken::parse(TOKEN).unwrap(), "state".to_string());
    let channel = lock(&f.state.hub).channel.take();
    assert!(channel.as_ref().is_some_and(|channel| !channel.is_broken()), "the attach burst of {held} lines broke the channel");
    drop(channel);
    let mut counted = String::new();
    process.stdout.take().unwrap().read_to_string(&mut counted).unwrap();
    let _ = process.wait();
    assert_eq!(counted.trim().parse::<usize>().unwrap(), held + 2, "hello, connect and every held line reached the child");
}

/// I18: stuck is the child not reading — one write blocked past the bound — never the size.
#[test]
fn i18_a_child_that_never_reads_is_judged_stuck_by_the_blocked_write() {
    let mut process = Command::new("sh").arg("-c").arg("sleep 30").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let hub = Arc::new(Mutex::new(Hub::default()));
    lock(&hub).me = Arc::downgrade(&hub);
    let channel = ChildChannel::stuck_after(Box::new(process.stdin.take().unwrap()), Duration::from_millis(300));
    lock(&hub).attach(channel, BotToken::parse(TOKEN).unwrap(), String::new());
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        for seq in 1..=200 {
            assert_eq!(hub.forward(held_line(seq, "a")), Forwarded::Taken, "a line is never refused for being many");
        }
    }
    wait_until("the blocked pipe write is judged stuck", || lock(&hub).channel.as_ref().is_some_and(ChildChannel::is_broken));
    let _ = process.kill();
    let _ = process.wait();
}

/// I12: a close handed to a child is not done until the child says `closed`; a child that
/// dies in between is followed by one that is handed the close again.
#[test]
fn i12_a_close_is_kept_and_replayed_until_the_child_says_it_is_done() {
    let f = fixture("i12-close", Some(TOKEN));
    let first = f.attach_buffer();
    {
        let mut hub = lock(&f.state.hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(held_line(1, "a"));
        hub.ack(ROOM, 1, Some(CREATED), None);
        assert!(hub.disconnect(ROOM, DisconnectReason::Closed));
    }
    wait_until("the first child was handed the close", || of_kind(&first.lines(), "disconnect").len() == 1);
    assert_eq!(f.state.status().behind.get(ROOM), Some(&1), "the closing line is owed, and counted");
    {
        let mut hub = lock(&f.state.hub);
        hub.channel = None;
        hub.ready = false;
    }
    let next = f.attach_buffer();
    wait_until("the next child is handed the close", || of_kind(&next.lines(), "disconnect").len() == 1);
    let id = pending_close(&f, ROOM);
    on_child_event(&f.state.hub, f.owners.as_ref(), FromChild::Closed { room: ROOM.into(), created_at: Some(CREATED + 1), id });
    assert_eq!(f.state.status().behind.get(ROOM), Some(&1), "another instance's close is not this one's");
    closed(&f, ROOM);
    assert!(f.state.status().behind.is_empty() && lock(&f.state.hub).draining.is_empty(), "said, so let go");
}

/// I19: a room is followed only into a forum, and picking one re-sends every followed room's
/// `connect` (never its lines, I4), so a room the child parked takes up again.
#[test]
fn i19_connect_needs_a_forum_and_set_forum_hands_each_room_over_again() {
    let f = fixture("i19-forum", Some(TOKEN));
    let buffer = f.attach_buffer();
    lock(&f.state.hub).forum_id = None;
    let error = f.state.connect(ROOM, APP_WORD).unwrap_err();
    assert!(error.contains("forum"), "{error}");
    {
        let mut hub = lock(&f.state.hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(held_line(1, "a"));
        hub.forward(held_line(2, "a"));
        hub.ack(ROOM, 1, Some(CREATED), None);
    }
    f.state.set_forum("323456789012345678").unwrap();
    wait_until("the room handed over again", || of_kind(&buffer.lines(), "connect").len() == 2);
    let after: Vec<String> = buffer.lines().iter().skip_while(|line| line["t"] != "forum").map(|line| format!("{}{}", line["t"].as_str().unwrap(), line["seq"].as_u64().map(|seq| seq.to_string()).unwrap_or_default())).collect();
    assert_eq!(after, ["forum", "connect"]);
}

/// I20: a jump in seq is said for what it is, whatever dropped the lines.
#[test]
fn i20_a_jump_says_the_lines_went_by_unfollowed() {
    let f = fixture("i20-gap", Some(TOKEN));
    let buffer = f.attach_buffer();
    {
        let mut hub = lock(&f.state.hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(held_line(1, "a"));
        hub.forward(held_line(9, "a"));
    }
    // The stdin writer hands lines over on its own thread.
    wait_until("three lines", || of_kind(&buffer.lines(), "message").len() == 3);
    let texts: Vec<String> = of_kind(&buffer.lines(), "message").iter().map(|line| line["text"].as_str().unwrap().to_string()).collect();
    assert_eq!(texts[1], "7 lines went by unfollowed");
}

/// I21: what Remove could not hand to Discord is said with its seqs and senders, and the
/// child is told the relay is ending before its stdin closes.
#[test]
fn i21_remove_says_which_lines_were_not_relayed_and_tells_the_child_it_is_the_end() {
    let f = fixture("i21-dropped", Some(TOKEN));
    let buffer = f.attach_buffer();
    {
        let mut hub = lock(&f.state.hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        for (seq, who) in [(41, "Codex"), (42, "Gyre Assistant"), (43, "Codex"), (47, "Codex")] {
            hub.forward(held_line(seq, who));
        }
    }
    f.state.remove(Some(APP_WORD)).unwrap();
    // The stdin writer hands the last lines over on its own thread, after Remove returns.
    wait_until("the end line", || !of_kind(&buffer.lines(), "end").is_empty());
    let kinds: Vec<String> = buffer.lines().iter().map(|line| line["t"].as_str().unwrap().to_string()).collect();
    assert_eq!(kinds.iter().rev().take(2).collect::<Vec<_>>(), ["end", "disconnect"], "{kinds:?}");
    let status = f.state.status();
    assert_eq!(status.dropped.get(ROOM), Some(&5), "four lines and the gap notice at 44; the close is not a room message");
    assert_eq!(status.dropped_lines.get(ROOM).map(String::as_str), Some("#41–#44, #47 from Codex, Gyre Assistant, Room"));
}

// ── #199 option B: the journal, the one budget, pull replay, the dropped prefix (v2 §8) ──

fn journal_path(f: &Fixture) -> PathBuf {
    f.dir.join(JOURNAL_DIR)
}

fn journal_names(path: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(path).map(|dir| dir.filter_map(|entry| entry.ok()?.file_name().into_string().ok()).collect()).unwrap_or_default();
    names.sort();
    names
}

fn journal_of(path: &Path, room: &str, created_at: u64) -> journal::Parsed {
    let name = journal::file_name(room, created_at);
    journal::parse(&name, &fs::read(path.join(&name)).unwrap()).unwrap()
}

/// A Hub over its own journal directory, as `DiscordState::with` builds one.
fn journal_hub(name: &str) -> (Arc<Mutex<Hub>>, PathBuf) {
    let path = scratch(name).join(JOURNAL_DIR);
    let hub = Arc::new(Mutex::new(Hub { journal_dir: Some(journal::Dir::open(&path).unwrap()), ..Hub::default() }));
    lock(&hub).me = Arc::downgrade(&hub);
    (hub, path)
}

fn recovered_hub(path: &Path, window: usize) -> Arc<Mutex<Hub>> {
    let dir = journal::Dir::open(path).unwrap();
    let names = dir.scan().unwrap();
    let hub = Arc::new(Mutex::new(Hub { journal_dir: Some(dir), window, ..Hub::default() }));
    lock(&hub).me = Arc::downgrade(&hub);
    lock(&hub).recover(names);
    hub
}

fn line_in(room: &str, seq: u64) -> ToChild {
    ToChild::Message { room: room.into(), seq, sender: "Codex".into(), to: "everyone".into(), kind: "tell".into(), text: format!("m{seq}"), ts: "2026-10-27T10:00:00.000Z".into() }
}

fn held_seqs(hub: &Hub, room: &str) -> Vec<u64> {
    let draining = hub.draining.get(room).into_iter().flatten().map(|(feed, _)| feed);
    hub.rooms.get(room).into_iter().chain(draining).flat_map(|feed| feed.unacked.iter().map(line_seq)).collect()
}

fn texts_of(hub: &Hub, room: &str) -> Vec<(u64, String)> {
    hub.rooms[room].unacked.iter().map(|line| match line {
        ToChild::Message { seq, text, .. } => (*seq, text.clone()),
        _ => unreachable!(),
    }).collect()
}

/// T1 (I1, ck1): the bridge is never told a position — an events-open `since` or a relay-ack —
/// past what the journal has synced.
#[test]
fn relay_ack_and_events_open_never_pass_the_journal_sync() {
    let f = fixture("b-sync-order", Some(TOKEN));
    let buffer = f.attach_buffer();
    *f.source.probe.lock().unwrap() = Some(Arc::downgrade(&f.state.hub));
    log_of(&f, ROOM, 1..=5);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("five", || message_seqs(&buffer).len() == 5);
    wait_until("a reopen from 5", || f.source.sinces.lock().unwrap().contains(&5));
    for seq in 1..=5 {
        ack(&f, ROOM, seq);
    }
    wait_until("the relay-ack", || f.source.acks.lock().unwrap().iter().any(|(_, _, seq)| *seq == 5));
    let seen = f.source.synced_at.lock().unwrap().clone();
    assert!(seen.iter().any(|(what, told, _)| *what == "open" && *told == 5), "premise: an open from 5 was probed: {seen:?}");
    assert!(seen.iter().any(|(what, told, _)| *what == "ack" && *told == 5), "premise: the ACK was probed: {seen:?}");
    for (what, told, synced) in &seen {
        assert!(told <= synced, "{what} told the bridge {told} with the journal synced only through {synced}: {seen:?}");
    }
}

/// T6 (I2, ck4): two instances of one code keep two journals, and recover apart.
#[test]
fn two_instances_of_one_code_recover_apart() {
    let (hub, path) = journal_hub("b-two-instances");
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec!["Codex".into()], Some(100)).unwrap();
        hub.forward(line_in(ROOM, 1));
        hub.forward(line_in(ROOM, 2));
        hub.ack(ROOM, 1, Some(100), Some("900000000000000001".into()));
        hub.disconnect(ROOM, DisconnectReason::Closed);
        hub.connect(ROOM, vec![], Some(200)).unwrap();
        for seq in 1..=3 {
            hub.forward(line_in(ROOM, seq));
        }
        hub.ack(ROOM, 2, Some(200), None);
    }
    assert_eq!(journal_names(&path), vec![journal::file_name(ROOM, 100), journal::file_name(ROOM, 200)]);
    // The app ends; the next launch finds both.
    let next = recovered_hub(&path, 0);
    let mut next = lock(&next);
    let batches: Vec<(Option<u64>, Vec<u64>, DisconnectReason)> =
        next.draining[ROOM].iter().map(|(feed, reason)| (feed.created_at, feed.unacked.iter().map(line_seq).collect(), *reason)).collect();
    assert_eq!(batches, vec![(Some(100), vec![2], DisconnectReason::Closed), (Some(200), vec![3], DisconnectReason::Ended)]);
    assert_eq!(next.resume_of(ROOM, Some(100)), Some(Resume { last_acked: 1, last_msg_id: Some("900000000000000001".into()) }));
    assert_eq!(next.resume_of(ROOM, Some(200)), Some(Resume { last_acked: 2, last_msg_id: None }));
    // An ACK and a close of one instance touch only its own.
    next.ack(ROOM, 3, Some(200), None);
    let id = next.draining[ROOM][1].0.close_id.clone();
    next.closed(ROOM, Some(200), id);
    assert_eq!(journal_names(&path), vec![journal::file_name(ROOM, 100)], "only instance 200's journal is done");
    assert_eq!(held_seqs(&next, ROOM), vec![2], "instance 100 still owes its line 2");
    assert_eq!(journal_of(&path, ROOM, 100).acked, 1);
}

/// T7 (I21, ck5, d18): a quit while Discord is offline leaves the held lines, the unread
/// count and the close on disk; the next launch says each once, and counts nothing twice.
#[test]
fn quit_offline_leaves_lines_loss_and_close_durable_and_relaunch_says_each_once() {
    let f = fixture("b-quit-offline", Some(TOKEN));
    let _first = f.attach_buffer();
    log_of(&f, ROOM, 1..=3);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("three forwarded", || lock(&f.state.hub).rooms.get(ROOM).is_some_and(|feed| feed.last_seq == 3));
    // Discord is unreachable: the child is gone, and the room has said two more lines the
    // relay has not read.
    lock(&f.state.hub).channel = None;
    f.source.room_seq.lock().unwrap().insert(ROOM.to_string(), 5);
    f.state.shutdown();

    let path = journal_path(&f);
    let on_disk = journal_of(&path, ROOM, CREATED);
    assert_eq!(on_disk.batches.len(), 1);
    let items: Vec<String> = on_disk.batches[0].items.iter().map(|item| format!("{item:?}")).collect();
    assert_eq!(on_disk.batches[0].items.len(), 4, "{items:?}");
    assert_eq!(on_disk.batches[0].items[3], journal::Item::Loss { seq: 4, n: 2, label: UNREAD_AT_QUIT.into(), through: Some(5) }, "the unread two, not the held three");
    assert_eq!(on_disk.batches[0].close.as_ref().map(|close| close.reason), Some(DisconnectReason::Closed));

    let next = relaunch(&f);
    let buffer = SharedBuf::default();
    lock(&next.hub).attach(ChildChannel::new(Box::new(buffer.clone())), BotToken::parse(TOKEN).unwrap(), String::new());
    wait_until("the replay", || !of_kind(&buffer.lines(), "disconnect").is_empty());
    let lines = buffer.lines();
    let shape: Vec<String> = lines.iter().map(|line| format!("{}{}", line["t"].as_str().unwrap(), line["seq"].as_u64().map(|seq| seq.to_string()).unwrap_or_default())).collect();
    assert_eq!(shape, ["hello", "connect", "message1", "message2", "message3", "message4", "disconnect"]);
    assert_eq!(lines[1]["resume"], serde_json::json!({ "lastAcked": 0, "lastMsgId": null }), "a replay always carries resume");
    assert_eq!((lines[5]["kind"].as_str(), lines[5]["text"].as_str()), (Some("notice"), Some("2 lines were unread when Gyredeck quit")));
    assert_eq!(lines[2]["ts"], "2026-10-27T10:00:00.000Z", "ts is replayed as the bridge stamped it");
    assert_eq!(lines[6]["reason"], "closed");
    let id = lines[6]["id"].as_str().unwrap().to_string();
    on_child_event(&next.hub, f.owners.as_ref(), FromChild::Posted { room: ROOM.into(), seq: 4, created_at: Some(CREATED), msg_id: Some("900000000000000004".into()) });
    on_child_event(&next.hub, f.owners.as_ref(), FromChild::Closed { room: ROOM.into(), created_at: Some(CREATED), id: Some(id) });
    assert!(journal_names(&path).is_empty(), "every line, the loss and the close taken: the journal is gone");
}

/// T10 (I14, ck8, d19, Codex r7 finding 3, its repro with the assertion flipped): repeated
/// Disconnect/Connect while Discord takes nothing never holds more than the one budget.
#[test]
fn audit_repeated_disconnect_cycles_stay_inside_the_one_budget() {
    let mut hub = Hub { cap: 3, ..Hub::default() };
    for cycle in 0..4_u64 {
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        for seq in cycle * 3 + 1..=cycle * 3 + 3 {
            hub.forward(ToChild::Message { room: ROOM.into(), seq, sender: "Codex".into(), to: "everyone".into(), kind: "tell".into(), text: "x".into(), ts: String::new() });
        }
        hub.disconnect(ROOM, DisconnectReason::Disconnected);
    }
    assert!(hub.owed_in(ROOM) <= 3, "live and draining together: {}", hub.owed_in(ROOM));
    assert_eq!(hub.undelivered_messages().get(ROOM), Some(&3));
}

#[test]
fn a_connect_over_the_budget_starts_its_reader_paused() {
    let f = fixture("b-paused", Some(TOKEN));
    let _buffer = f.attach_buffer();
    lock(&f.state.hub).cap = 3;
    log_of(&f, ROOM, 1..=10);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("the cap", || lock(&f.state.hub).owed_in(ROOM) == 3 && f.source.dropped.load(Ordering::SeqCst) == 1);
    f.state.disconnect(ROOM, Some(APP_WORD)).unwrap();
    let opens = f.source.opens.lock().unwrap().len();
    f.state.connect(ROOM, APP_WORD).unwrap();
    thread::sleep(Duration::from_millis(800));
    assert_eq!(f.source.opens.lock().unwrap().len(), opens, "the second Connect's reader does not open while the code is over its budget");
    assert_eq!(lock(&f.state.hub).owed_in(ROOM), 3);
    ack(&f, ROOM, 3);
    closed(&f, ROOM);
    wait_until("the reader resumes once there is room", || f.source.opens.lock().unwrap().len() > opens);
}

/// T11 (I18, ck9): a replay of a large backlog to a child that is not reading holds
/// references, never the lines; then each line arrives once, in order, as it reads.
#[test]
fn attach_holds_references_not_lines() {
    let f = fixture("b-pull", Some(TOKEN));
    let held = 50_000_u64;
    {
        let mut hub = lock(&f.state.hub);
        hub.cap = held as usize + 1;
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        for seq in 1..=held {
            assert_eq!(hub.forward(ToChild::Message { room: ROOM.into(), seq, sender: "a".into(), to: "everyone".into(), kind: "tell".into(), text: "x".into(), ts: String::new() }), Forwarded::Taken);
        }
        hub.disconnect(ROOM, DisconnectReason::Disconnected);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    }
    let mut fds = [0; 2];
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    let (read_end, write_end) = unsafe { (fs::File::from_raw_fd(fds[0]), fs::File::from_raw_fd(fds[1])) };
    lock(&f.state.hub).attach(ChildChannel::new(Box::new(write_end)), BotToken::parse(TOKEN).unwrap(), String::new());
    wait_until("the writer blocked on the full pipe", || lock(&f.state.hub).channel.as_ref().is_some_and(|channel| channel.shared.writing_since.load(Ordering::SeqCst) != 0));
    {
        let hub = lock(&f.state.hub);
        let batches = hub.draining.values().map(Vec::len).sum::<usize>() + hub.rooms.len();
        assert!(hub.outbox.len() <= 2 + 2 * batches, "the outbox holds {} entries for {batches} batches", hub.outbox.len());
        assert!(hub.outbox.iter().all(|out| !matches!(out, Out::Control(ToChild::Message { .. }))), "no line is copied into the outbox");
    }
    let mut seqs = Vec::new();
    for line in BufReader::new(read_end).lines() {
        let line: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        if let Some(seq) = line["seq"].as_u64() {
            seqs.push(seq);
        }
        if line["t"] == "disconnect" {
            break;
        }
    }
    assert_eq!(seqs.len(), held as usize);
    assert!(seqs.iter().copied().eq(1..=held), "every line once, in order");
    lock(&f.state.hub).channel = None;
}

/// T12 (I20, I4, ck10, Codex r7 finding 2): the prefix the bridge dropped before the first
/// frame is said before it; pre-join history is not; a reconnect says gap and drop apart.
#[test]
fn the_dropped_prefix_is_said_before_the_first_line() {
    let mut hub = Hub::default();
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.on_dropped(ROOM, 5, 0);
    hub.forward(line_in(ROOM, 6));
    assert_eq!(texts_of(&hub, ROOM), vec![(1, "5 lines the room dropped".into()), (6, "m6".into())]);
    hub.on_dropped(ROOM, 5, 0);
    assert_eq!(hub.rooms[ROOM].unacked.len(), 2, "the same watermark on the next open says nothing again");
}

#[test]
fn a_pre_join_prefix_is_not_said() {
    let mut hub = Hub::default();
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.on_dropped(ROOM, 5, 5);
    hub.forward(line_in(ROOM, 6));
    assert_eq!(texts_of(&hub, ROOM), vec![(6, "m6".into())]);
}

#[test]
fn a_reconnect_says_the_unfollowed_gap_and_the_drop_apart() {
    let mut hub = Hub::default();
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    for seq in 1..=3 {
        hub.forward(line_in(ROOM, seq));
    }
    hub.ack(ROOM, 3, Some(CREATED), None);
    hub.disconnect(ROOM, DisconnectReason::Disconnected);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.on_dropped(ROOM, 8, 6);
    hub.forward(line_in(ROOM, 9));
    assert_eq!(texts_of(&hub, ROOM), vec![(4, "3 lines went by unfollowed".into()), (7, "2 lines the room dropped".into()), (9, "m9".into())]);
}

/// Codex's Rust repro, adapted: the bridge's `event: dropped` frame comes first on the stream.
#[test]
fn audit_first_relay_frame_after_a_notice_cap_drop_reports_the_missing_prefix() {
    let f = fixture("b-dropped-frame", Some(TOKEN));
    let buffer = f.attach_buffer();
    let mut bytes = format!(": gyredeck mail room {ROOM} connected\n\nevent: dropped\ndata: {{\"droppedThroughSeq\":5,\"relayFrom\":0}}\n\n").into_bytes();
    bytes.extend(frames(ROOM, &[&mail(6, "gyredeck-room", "everyone", "notice", "n6")])[(": gyredeck mail room  connected\n\n".len() + ROOM.len())..].iter());
    f.source.streams.lock().unwrap().entry(ROOM.to_string()).or_default().push_back(bytes);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("six", || message_seqs(&buffer).contains(&6));
    let lines = buffer.lines();
    let said: Vec<(u64, String)> = of_kind(&lines, "message").iter().map(|m| (m["seq"].as_u64().unwrap(), m["text"].as_str().unwrap().to_string())).collect();
    assert_eq!(said, vec![(1, "5 lines the room dropped".into()), (6, "n6".into())]);
}

/// T13 (I11, I12, ck11): a stale child changes no journal; ACKs out of order or twice keep the
/// watermark monotone; a close is matched by its id; the file goes only after the last close.
#[test]
fn stale_events_and_reordered_acks_leave_the_journal_monotone_and_deletion_last() {
    let f = fixture("b-epochs", Some(TOKEN));
    let _buffer = f.attach_buffer();
    {
        let mut hub = lock(&f.state.hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        for seq in 1..=3 {
            hub.forward(line_in(ROOM, seq));
        }
    }
    let path = journal_path(&f);
    let file = path.join(journal::file_name(ROOM, CREATED));
    let before = fs::read(&file).unwrap();
    let stale = lock(&f.state.hub).epoch.wrapping_sub(1);
    on_child_event_from(&f.state.hub, f.owners.as_ref(), stale, FromChild::Posted { room: ROOM.into(), seq: 3, created_at: Some(CREATED), msg_id: Some("9".into()) });
    assert_eq!(fs::read(&file).unwrap(), before, "a stale child's ACK writes nothing");
    ack(&f, ROOM, 2);
    ack(&f, ROOM, 1);
    ack(&f, ROOM, 2);
    let acks = String::from_utf8(fs::read(&file).unwrap()).unwrap().lines().filter(|line| line.contains("\"t\":\"ack\"")).count();
    assert_eq!(acks, 1, "one ACK record: the late and repeated ones do not move the watermark");
    assert_eq!(journal_of(&path, ROOM, CREATED).acked, 2);
    lock(&f.state.hub).disconnect(ROOM, DisconnectReason::Closed);
    ack(&f, ROOM, 3);
    assert!(file.exists(), "every line taken, the close not yet: the journal stays");
    let id = pending_close(&f, ROOM);
    let at_close = fs::read(&file).unwrap();
    on_child_event_from(&f.state.hub, f.owners.as_ref(), stale, FromChild::Closed { room: ROOM.into(), created_at: Some(CREATED), id: id.clone() });
    on_child_event(&f.state.hub, f.owners.as_ref(), FromChild::Closed { room: ROOM.into(), created_at: Some(CREATED), id: Some("0000000000000000".into()) });
    on_child_event(&f.state.hub, f.owners.as_ref(), FromChild::Closed { room: ROOM.into(), created_at: Some(CREATED), id: None });
    assert_eq!(fs::read(&file).unwrap(), at_close, "a stale, a foreign or an id-less close writes nothing");
    on_child_event(&f.state.hub, f.owners.as_ref(), FromChild::Closed { room: ROOM.into(), created_at: Some(CREATED), id: id.clone() });
    assert!(!file.exists(), "the last close acknowledged: deleted");
    on_child_event(&f.state.hub, f.owners.as_ref(), FromChild::Closed { room: ROOM.into(), created_at: Some(CREATED), id });
    assert!(journal_names(&path).is_empty(), "a repeated close is a no-op");
}

/// T16 (d25): a journal that cannot be written takes nothing in, says so, and resumes.
#[test]
fn a_journal_write_error_stops_the_reader_and_is_shown() {
    let f = fixture("b-blocked", Some(TOKEN));
    let buffer = f.attach_buffer();
    {
        let mut hub = lock(&f.state.hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.rooms[ROOM].journal.as_ref().unwrap().fail_writes(true);
        assert_eq!(hub.forward(line_in(ROOM, 1)), Forwarded::Blocked);
        assert_eq!(hub.rooms[ROOM].last_seq, 0, "not taken in, so read again later");
        assert!(hub.rooms[ROOM].unacked.is_empty());
    }
    let status = f.state.status();
    assert_eq!(status.journal_errors.get(ROOM).map(|error| error.code.as_str()), Some(JOURNAL_BLOCKED));
    thread::sleep(Duration::from_millis(100));
    assert!(message_seqs(&buffer).is_empty(), "the child is handed nothing the journal does not hold");
    lock(&f.state.hub).rooms[ROOM].journal.as_ref().unwrap().fail_writes(false);
    assert_eq!(lock(&f.state.hub).forward(line_in(ROOM, 1)), Forwarded::Taken);
    assert!(f.state.status().journal_errors.is_empty());
    wait_until("the line", || message_seqs(&buffer) == vec![1]);
}

/// T17 (d26, Codex r1 finding 4): journals past the launch window stay names on disk —
/// never opened or read — and drain in order.
#[test]
fn journals_past_the_launch_window_stay_on_disk_and_drain_in_order() {
    let (hub, path) = journal_hub("b-window");
    {
        let mut hub = lock(&hub);
        hub.cap = 100;
        for at in 1..=5_u64 {
            hub.connect(ROOM, vec![], Some(at)).unwrap();
            for seq in 1..=3 {
                hub.forward(line_in(ROOM, seq));
            }
            hub.disconnect(ROOM, DisconnectReason::Closed);
        }
    }
    journal::tests::opened();
    let next = recovered_hub(&path, 4);
    let opened = journal::tests::opened();
    let mut next = lock(&next);
    // Each journal owes three lines and a close: four, the whole window.
    assert_eq!(opened, 1, "only the window's journals are opened and read at launch");
    assert_eq!(next.draining[ROOM].iter().map(|(feed, _)| feed.created_at).collect::<Vec<_>>(), vec![Some(1)]);
    assert_eq!(next.parked.iter().cloned().collect::<Vec<_>>(), (2..=5).map(|at| journal::file_name(ROOM, at)).collect::<Vec<_>>(), "the rest are names, oldest first");
    let mut most = 0;
    for at in 1..=5_u64 {
        most = most.max(next.owed(true).values().sum::<usize>());
        assert_eq!(next.draining[ROOM][0].0.created_at, Some(at), "oldest first");
        next.ack(ROOM, 3, Some(at), None);
        let id = next.draining[ROOM][0].0.close_id.clone();
        next.closed(ROOM, Some(at), id);
    }
    assert!(most <= 4 + 4, "never more loaded than the window plus one journal: {most}");
    assert!(next.draining.is_empty() && next.parked.is_empty());
    assert!(journal_names(&path).is_empty());
}

/// T18 (I21, Remove, C3): Remove says what it could not send, and deletes the journals.
#[test]
fn remove_deletes_the_journals_after_saying_what_was_not_relayed() {
    let f = fixture("b-remove", Some(TOKEN));
    let _buffer = f.attach_buffer();
    {
        let mut hub = lock(&f.state.hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(ROOM, 41));
    }
    assert_eq!(journal_names(&journal_path(&f)).len(), 1, "premise: journalled");
    let status = f.state.remove(Some(APP_WORD)).unwrap();
    assert_eq!(status.dropped.get(ROOM), Some(&1));
    assert!(journal_names(&journal_path(&f)).is_empty());
}

/// The Rust half of every new wire field (v2 §7.5).
#[test]
fn every_new_wire_field_reads_and_writes_as_specified() {
    let connect = serde_json::to_value(ToChild::Connect { room: ROOM.into(), members: vec![], created_at: Some(1), resume: Some(Resume { last_acked: 4, last_msg_id: Some("900000000000000004".into()) }) }).unwrap();
    assert_eq!(connect["resume"], serde_json::json!({ "lastAcked": 4, "lastMsgId": "900000000000000004" }));
    let fresh = serde_json::to_value(ToChild::Connect { room: ROOM.into(), members: vec![], created_at: Some(1), resume: None }).unwrap();
    assert!(fresh["resume"].is_null());
    let disconnect = serde_json::to_value(ToChild::Disconnect { room: ROOM.into(), reason: DisconnectReason::Ended, id: "00ff00ff00ff00ff".into() }).unwrap();
    assert_eq!(disconnect, serde_json::json!({ "t": "disconnect", "room": ROOM, "reason": "ended", "id": "00ff00ff00ff00ff" }));
    let posted: FromChild = serde_json::from_str(r#"{"t":"posted","room":"sync-ab23","seq":3,"createdAt":1,"msgId":"900000000000000003"}"#).unwrap();
    assert!(matches!(posted, FromChild::Posted { msg_id: Some(ref id), .. } if id == "900000000000000003"));
    let dedupe: FromChild = serde_json::from_str(r#"{"t":"posted","room":"sync-ab23","seq":3,"createdAt":1,"msgId":null}"#).unwrap();
    assert!(matches!(dedupe, FromChild::Posted { msg_id: None, .. }));
    let closed: FromChild = serde_json::from_str(r#"{"t":"closed","room":"sync-ab23","createdAt":1,"id":"00ff00ff00ff00ff"}"#).unwrap();
    assert!(matches!(closed, FromChild::Closed { id: Some(ref id), .. } if id == "00ff00ff00ff00ff"));
    let unnamed: FromChild = serde_json::from_str(r#"{"t":"closed","room":"sync-ab23","createdAt":1,"id":null}"#).unwrap();
    assert!(matches!(unnamed, FromChild::Closed { id: None, .. }));
    let error: FromChild = serde_json::from_str(r#"{"t":"error","code":"readback_unavailable","message":"no history"}"#).unwrap();
    assert!(matches!(error, FromChild::Error { ref code, .. } if code == "readback_unavailable"));
    let dropped: WireDropped = serde_json::from_str(r#"{"droppedThroughSeq":5}"#).unwrap();
    assert_eq!((dropped.dropped_through_seq, dropped.relay_from), (5, 0));
    // A dedupe ACK with no id keeps the anchor an earlier one gave.
    let mut hub = Hub::default();
    hub.connect(ROOM, vec![], Some(1)).unwrap();
    hub.forward(line_in(ROOM, 1));
    hub.forward(line_in(ROOM, 2));
    hub.ack(ROOM, 1, Some(1), Some("900000000000000001".into()));
    hub.ack(ROOM, 2, Some(1), None);
    assert_eq!(hub.resume_of(ROOM, Some(1)), Some(Resume { last_acked: 2, last_msg_id: Some("900000000000000001".into()) }));
}

/// T-IPC: the built connector (N's side, with the fake Discord in place of discord.js) and this
/// side's real `read_child`, through every new field: `connect.resume` on a replay, `posted.msgId`
/// journalled as the anchor, `disconnect.id` with `closed`/`ended`, and `closed.id` deleting the
/// journal.
#[test]
fn ipc_the_real_child_round_trips_every_new_field() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bundle = root.join("adapters/discord/dist/gyredeck-discord.mjs");
    assert!(bundle.is_file(), "run `pnpm discord:build` first");
    let f = fixture("b-ipc", Some(TOKEN));
    f.acts.founded.lock().unwrap().push(OTHER.to_string());
    {
        // Held before any child runs, so the child meets them as a replay.
        let mut hub = lock(&f.state.hub);
        hub.forum_id = Some("F1".to_string());
        hub.connect(ROOM, vec!["Codex".into()], Some(CREATED)).unwrap();
        hub.forward(line_in(ROOM, 1));
        hub.forward(line_in(ROOM, 2));
    }
    let mut process = Command::new(node())
        .arg(root.join("tests/discord/child.mjs"))
        .arg(&bundle)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let (stdin, stdout) = (process.stdin.take().unwrap(), process.stdout.take().unwrap());
    let epoch = {
        let mut hub = lock(&f.state.hub);
        hub.epoch += 1;
        hub.epoch
    };
    lock(&f.state.hub).attach(ChildChannel::new(Box::new(stdin)), BotToken::parse(TOKEN).unwrap(), f.dir.join("discord-state.json").display().to_string());
    let (hub, owners) = (Arc::clone(&f.state.hub), Arc::clone(&f.owners));
    thread::spawn(move || read_child(stdout, &hub, owners.as_ref(), epoch));
    wait_until("ready", || lock(&f.state.hub).ready);

    let anchor = || lock(&f.state.hub).resume_of(ROOM, Some(CREATED));
    wait_until("both posted, with their message id", || anchor().is_some_and(|resume| resume.last_acked == 2 && resume.last_msg_id.is_some()));
    let path = journal_path(&f);
    assert_eq!(journal_of(&path, ROOM, CREATED).last_msg_id, anchor().unwrap().last_msg_id, "the anchor is journalled");
    lock(&f.state.hub).disconnect(ROOM, DisconnectReason::Closed);
    wait_until("closed by id, so the journal goes", || !path.join(journal::file_name(ROOM, CREATED)).exists());

    {
        let mut hub = lock(&f.state.hub);
        hub.connect(OTHER, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(OTHER, 1));
        hub.disconnect(OTHER, DisconnectReason::Ended);
    }
    wait_until("an ended close, said and acknowledged", || journal_names(&path).is_empty());
    assert!(lock(&f.state.hub).draining.is_empty());
    assert!(lock(&f.state.hub).error.is_none(), "{:?}", lock(&f.state.hub).error);
    lock(&f.state.hub).channel = None;
    let _ = process.kill();
    let _ = process.wait();
}

// ── round 2: the deep audit's Hub findings ──

/// The relay-ack half of I1 on its own: lines read on a stream that stays open are synced
/// before Discord's ACK of them is told to the bridge, with no reopen to sync them first.
#[test]
fn a_relay_ack_on_an_open_stream_waits_for_the_journal_sync() {
    let f = fixture("r2-ack-sync", Some(TOKEN));
    let buffer = f.attach_buffer();
    *f.source.probe.lock().unwrap() = Some(Arc::downgrade(&f.state.hub));
    f.source.hold.store(true, Ordering::SeqCst);
    f.stream(ROOM, &(1..=5).map(|seq| mail(seq, "peer-a", "everyone", "tell", &format!("m{seq}"))).collect::<Vec<_>>());
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("five", || message_seqs(&buffer).len() == 5);
    for seq in 1..=5 {
        ack(&f, ROOM, seq);
    }
    wait_until("the relay-ack", || f.source.acks.lock().unwrap().iter().any(|(_, _, seq)| *seq == 5));
    let seen = f.source.synced_at.lock().unwrap().clone();
    assert_eq!(seen.iter().filter(|(what, ..)| *what == "open").count(), 1, "premise: one open, before any line was journalled: {seen:?}");
    for (what, told, synced) in seen.iter().filter(|(what, ..)| *what == "ack") {
        assert!(told <= synced, "{what} told the bridge {told} with the journal synced only through {synced}");
    }
}

/// Finding 9: the bridge's join point moves no seq past what the journal holds.
#[test]
fn a_pre_join_floor_moves_no_seq_past_the_journal() {
    let (hub, _path) = journal_hub("r2-floor");
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.on_dropped(ROOM, 0, 5);
    let written = hub.rooms[ROOM].journal.as_ref().unwrap().written_through();
    assert!(hub.rooms[ROOM].last_seq <= written, "the next open's since ({}) is past the journal ({written})", hub.rooms[ROOM].last_seq);
    hub.forward(line_in(ROOM, 5));
    hub.forward(line_in(ROOM, 6));
    hub.forward(line_in(ROOM, 9));
    assert_eq!(texts_of(&hub, ROOM), vec![(6, "m6".into()), (7, "2 lines went by unfollowed".into()), (9, "m9".into())], "pre-join history is not said; a later jump is");
}

/// Finding 10: Remove deletes a journal recovery refused, too.
#[test]
fn remove_deletes_a_journal_refused_as_corrupt() {
    let f = fixture("r2-remove-corrupt", Some(TOKEN));
    let path = journal_path(&f);
    let name = journal::file_name(ROOM, CREATED);
    fs::write(path.join(&name), b"{\"t\":\"open\"}\ngarbage\n").unwrap();
    let next = relaunch(&f);
    assert!(next.status().journal_errors.contains_key(&name), "premise: refused at launch");
    assert!(path.join(&name).exists());
    next.remove(Some(APP_WORD)).unwrap();
    assert!(!path.join(&name).exists(), "Remove deletes it");
    assert!(next.status().journal_errors.is_empty());
}

/// AUDIT-C, the Hub's half: a `posted` with no id journals no id.
#[test]
fn a_dedupe_posted_never_moves_the_journalled_anchor() {
    let (hub, path) = journal_hub("r2-anchor");
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    for seq in 1..=3 {
        hub.forward(line_in(ROOM, seq));
    }
    hub.ack(ROOM, 1, Some(CREATED), Some("900000000000000001".into()));
    hub.ack(ROOM, 2, Some(CREATED), None);
    let on_disk = journal_of(&path, ROOM, CREATED);
    assert_eq!((on_disk.acked, on_disk.anchor_seq, on_disk.last_msg_id.as_deref()), (2, 1, Some("900000000000000001")));
    hub.ack(ROOM, 3, Some(CREATED), Some("900000000000000003".into()));
    assert_eq!(journal_of(&path, ROOM, CREATED).anchor_seq, 3);
}

/// Codex's re-check probe (audit_r3): a gap said at one reconnect is not said again at the next.
#[test]
fn audit_r3_two_reconnects_do_not_count_the_same_gap_twice() {
    let mut hub = Hub::default();
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    for seq in 1..=3 {
        hub.forward(line_in(ROOM, seq));
    }
    hub.ack(ROOM, 3, Some(CREATED), None);
    hub.disconnect(ROOM, DisconnectReason::Disconnected);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.on_dropped(ROOM, 0, 6);
    hub.disconnect(ROOM, DisconnectReason::Disconnected);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.on_dropped(ROOM, 0, 9);
    hub.forward(line_in(ROOM, 10));
    let said: Vec<(u64, String)> = held_seqs_texts(&hub);
    assert_eq!(said, vec![(4, "3 lines went by unfollowed".to_string()), (7, "3 lines went by unfollowed".to_string()), (10, "m10".to_string())], "{said:?}");
    assert_eq!(hub.rooms[ROOM].last_seq, 10, "the open's since stays the last seq journalled");
    // A quit now counts from the same point: nothing at or below 10 again.
    hub.lose_unread(ROOM, Some(12));
    assert_eq!(held_seqs_texts(&hub).last().cloned(), Some((11, "2 lines were unread when Gyredeck quit".to_string())));
}

fn held_seqs_texts(hub: &Hub) -> Vec<(u64, String)> {
    let draining = hub.draining.get(ROOM).into_iter().flatten().map(|(feed, _)| feed);
    hub.rooms.get(ROOM).into_iter().chain(draining).flat_map(|feed| feed.unacked.iter()).map(|line| match line {
        ToChild::Message { seq, text, .. } => (*seq, text.clone()),
        _ => unreachable!(),
    }).collect::<std::collections::BTreeMap<_, _>>().into_iter().collect()
}

// ── r2: Codex's independent pass, ported ──

/// Codex r1 finding 1: empty Disconnect/Connect cycles while Discord is down stay bounded.
#[test]
fn auditor_empty_reconnects_stay_within_disk_and_memory_budget() {
    let (hub, path) = journal_hub("auditor-empty-cycles");
    {
        let mut hub = lock(&hub);
        hub.cap = 3;
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(ROOM, 1));
        assert!(hub.disconnect(ROOM, DisconnectReason::Disconnected));
        for _ in 0..1000 {
            hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
            assert!(hub.disconnect(ROOM, DisconnectReason::Disconnected));
        }
        let batches = hub.draining.get(ROOM).map_or(0, Vec::len);
        let bytes = fs::metadata(path.join(journal::file_name(ROOM, CREATED))).unwrap().len();
        assert!(batches <= 3, "empty close intents accumulate without using the line budget: {batches} batches, {bytes} journal bytes");
        // The meaning is kept: the one owed close still closes the post, and a reconnect that
        // has something to say gets its own.
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(ROOM, 2));
        assert!(hub.disconnect(ROOM, DisconnectReason::Disconnected));
        assert_eq!(hub.draining[ROOM].len(), 2);
        hub.ack(ROOM, 2, Some(CREATED), None);
        for _ in 0..2 {
            let id = hub.draining[ROOM][0].0.close_id.clone();
            hub.closed(ROOM, Some(CREATED), id);
        }
        assert!(hub.draining.is_empty());
    }
    assert!(journal_names(&path).is_empty(), "every close acknowledged: the journal goes");
}

/// The same cycles from a fresh room, with nothing ever said, stay bounded too.
#[test]
fn auditor_empty_reconnects_from_nothing_stay_bounded() {
    let (hub, path) = journal_hub("auditor-empty-cycles-bare");
    let mut hub = lock(&hub);
    for _ in 0..1000 {
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        assert!(hub.disconnect(ROOM, DisconnectReason::Disconnected));
    }
    assert_eq!(hub.draining.get(ROOM).map_or(0, Vec::len), 1);
    assert!(fs::metadata(path.join(journal::file_name(ROOM, CREATED))).unwrap().len() < 4096);
}

/// Codex r1 finding 2: a quit whose roster query fails records a loss that never claims a
/// complete count — "at least" the bridge's last answer, or unknown.
#[test]
fn auditor_quit_records_unread_loss_when_roster_query_fails() {
    let f = fixture("auditor-quit-roster-fails", Some(TOKEN));
    let _buffer = f.attach_buffer();
    f.state.connect(ROOM, APP_WORD).unwrap();
    lock(&f.state.hub).channel = None;
    f.source.room_seq.lock().unwrap().insert(ROOM.to_string(), 5);
    f.source.roster_fails.store(true, Ordering::SeqCst);
    f.state.shutdown();
    let on_disk = journal_of(&journal_path(&f), ROOM, CREATED);
    let losses: Vec<&journal::Item> = on_disk.batches.iter().flat_map(|b| &b.items).filter(|item| matches!(item, journal::Item::Loss { .. })).collect();
    assert_eq!(losses, vec![&journal::Item::Loss { seq: 1, n: 0, label: UNREAD_AT_QUIT_UNKNOWN.into(), through: None }], "no count was ever known: said as unknown, not dropped");
}

#[test]
fn a_quit_whose_roster_fails_counts_at_least_the_bridges_last_answer() {
    let f = fixture("quit-roster-at-least", Some(TOKEN));
    let _buffer = f.attach_buffer();
    f.source.room_seq.lock().unwrap().insert(ROOM.to_string(), 5);
    f.state.connect(ROOM, APP_WORD).unwrap();
    lock(&f.state.hub).channel = None;
    f.source.roster_fails.store(true, Ordering::SeqCst);
    f.state.shutdown();
    let on_disk = journal_of(&journal_path(&f), ROOM, CREATED);
    let item = on_disk.batches.iter().flat_map(|b| &b.items).find(|item| matches!(item, journal::Item::Loss { .. })).cloned();
    assert_eq!(item, Some(journal::Item::Loss { seq: 1, n: 5, label: UNREAD_AT_QUIT_AT_LEAST.into(), through: Some(5) }));
    assert_eq!(loss_text(5, UNREAD_AT_QUIT_AT_LEAST), "At least 5 lines were unread when Gyredeck quit; the bridge could not say how many more");
    // Relaunched onto the same instance, the next line is not a second gap over 1–5 (#199 r9).
    let path = journal_path(&f);
    let (next, _) = launch_wire(&path, Moment::Launch).unwrap();
    let mut hub = lock(&next);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    assert_eq!(hub.forward(line_in(ROOM, 6)), Forwarded::Taken);
    let notices: Vec<String> = records_in(&path).iter()
        .filter(|record| record["t"] == "line" && record["kind"] == "notice")
        .filter_map(|record| record["text"].as_str().map(str::to_string)).collect();
    assert!(notices.is_empty(), "the lines the loss already counted were counted again: {notices:?}");
}

/// A loss the journal cannot write is not handed on until it is in (r6: nothing leaves before
/// its record); it waits, pending, and the refusal is shown.
#[test]
fn a_quit_loss_the_journal_cannot_write_waits_and_is_shown() {
    let (hub, _path) = journal_hub("quit-loss-blocked");
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.forward(line_in(ROOM, 1));
    hub.rooms[ROOM].journal.as_ref().unwrap().fail_writes(true);
    hub.lose_unread(ROOM, Some(4));
    assert_eq!(held_seqs(&hub, ROOM), vec![1], "not handed on before it is durable");
    assert_eq!(hub.pending.len(), 1);
    assert_eq!(hub.journal_errors.get(ROOM).map(|error| error.code.as_str()), Some(JOURNAL_BLOCKED));
    hub.rooms[ROOM].journal.as_ref().unwrap().fail_writes(false);
    hub.flush_pending();
    assert_eq!(held_seqs(&hub, ROOM), vec![1, 2], "handed on once it is in");
}

// ── r3: Codex's second pass ──

/// Codex r2 finding 1: journals that owe only their close take room in the window too.
#[test]
fn auditor_close_only_journals_obey_the_launch_window() {
    let (hub, path) = journal_hub("auditor-close-only");
    {
        let mut hub = lock(&hub);
        for at in 1..=100_u64 {
            hub.connect(ROOM, vec![], Some(at)).unwrap();
            assert!(hub.disconnect(ROOM, DisconnectReason::Closed));
        }
    }
    assert_eq!(journal_names(&path).len(), 100, "premise: a hundred journals, each Open + Close");
    journal::tests::opened();
    let next = recovered_hub(&path, 3);
    let opened = journal::tests::opened();
    let mut next = lock(&next);
    let loaded = next.draining.get(ROOM).map_or(0, Vec::len);
    assert!(opened <= 3 && loaded <= 3, "opened {opened}, loaded {loaded}, with a window of 3");
    assert_eq!(next.parked.len(), 100 - loaded);
    let mut order = Vec::new();
    while let Some((feed, _)) = next.draining.get(ROOM).and_then(|batches| batches.first()) {
        let (at, id) = (feed.created_at, feed.close_id.clone());
        order.push(at.unwrap());
        assert!(next.draining[ROOM].len() <= 3, "never more than the window loaded");
        next.closed(ROOM, at, id);
    }
    assert_eq!(order, (1..=100).collect::<Vec<_>>(), "every one drained, oldest first");
    assert!(next.parked.is_empty() && journal_names(&path).is_empty());
}

fn quit_with_failing_loss_write(name: &str, failures: Option<u32>) -> Fixture {
    let f = fixture(name, Some(TOKEN));
    let _buffer = f.attach_buffer();
    log_of(&f, ROOM, 1..=1);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("line 1 journalled", || lock(&f.state.hub).rooms.get(ROOM).is_some_and(|feed| feed.last_seq == 1));
    lock(&f.state.hub).channel = None;
    f.source.room_seq.lock().unwrap().insert(ROOM.to_string(), 4);
    {
        let hub = lock(&f.state.hub);
        let file = hub.rooms[ROOM].journal.as_ref().unwrap();
        match failures {
            Some(count) => file.fail_next(count),
            None => file.fail_writes(true),
        }
    }
    f.state.shutdown();
    f
}

fn losses_in(parsed: &journal::Parsed) -> Vec<journal::Item> {
    parsed.batches.iter().flat_map(|batch| batch.items.iter()).filter(|item| matches!(item, journal::Item::Loss { .. })).cloned().collect()
}

/// Codex r2 finding 2, transient: a refused loss write that lands on a retry within the quit
/// leaves exactly one loss record, and no fallback.
#[test]
fn a_loss_write_refused_once_at_quit_lands_once_on_retry() {
    let f = quit_with_failing_loss_write("loss-transient", Some(1));
    let path = journal_path(&f);
    let on_disk = journal_of(&path, ROOM, CREATED);
    assert_eq!(losses_in(&on_disk), vec![journal::Item::Loss { seq: 2, n: 3, label: UNREAD_AT_QUIT.into(), through: Some(4) }]);
    assert_eq!(on_disk.batches[0].close.as_ref().map(|close| close.reason), Some(DisconnectReason::Closed));
    assert_eq!(journal_names(&path), vec![journal::file_name(ROOM, CREATED)], "no fallback file");
}

/// Codex r2 finding 2: a loss the journal refuses through the whole quit survives in the
/// fallback file, and the next launch says it once, before the close.
#[test]
fn auditor_failed_loss_write_stays_accounted_after_offline_quit() {
    let f = quit_with_failing_loss_write("loss-fallback", None);
    let path = journal_path(&f);
    assert!(path.join(format!("{ROOM}@{CREATED}.loss")).exists(), "premise: the journal refused it, the fallback holds it");
    assert!(losses_in(&journal_of(&path, ROOM, CREATED)).is_empty(), "premise: not in the journal");

    let next = relaunch(&f);
    let buffer = SharedBuf::default();
    lock(&next.hub).attach(ChildChannel::new(Box::new(buffer.clone())), BotToken::parse(TOKEN).unwrap(), String::new());
    wait_until("the replay", || !of_kind(&buffer.lines(), "disconnect").is_empty());
    let lines = buffer.lines();
    let said: Vec<(u64, String)> = of_kind(&lines, "message").iter().map(|m| (m["seq"].as_u64().unwrap(), m["text"].as_str().unwrap().to_string())).collect();
    assert_eq!(said, vec![(1, "m1".to_string()), (2, "3 lines were unread when Gyredeck quit".to_string())], "the loss is said once, after the held line");
    assert_eq!(losses_in(&journal_of(&path, ROOM, CREATED)).len(), 1, "now in the journal");
    assert!(!path.join(format!("{ROOM}@{CREATED}.loss")).exists(), "and the fallback is gone");
    let id = of_kind(&lines, "disconnect")[0]["id"].as_str().unwrap().to_string();
    on_child_event(&next.hub, f.owners.as_ref(), FromChild::Posted { room: ROOM.into(), seq: 2, created_at: Some(CREATED), msg_id: None });
    on_child_event(&next.hub, f.owners.as_ref(), FromChild::Closed { room: ROOM.into(), created_at: Some(CREATED), id: Some(id) });
    assert!(journal_names(&path).is_empty());
}

/// The loss refused through every try, the disk taking writes again right after: the close
/// queued behind it lands after it, so the journal holds loss then close, each once.
#[test]
fn a_loss_refused_through_every_try_still_comes_before_the_close() {
    let f = quit_with_failing_loss_write("loss-then-close", Some(QUIT_LOSS_TRIES));
    let path = journal_path(&f);
    assert_eq!(record_kinds(&path), ["open", "line", "loss", "close"], "loss, then close");
    assert!(!path.join(format!("{ROOM}@{CREATED}.loss")).exists(), "landed, so the fallback went");
    let next = relaunch(&f);
    assert_eq!(held_seqs(&lock(&next.hub), ROOM), vec![1, 2]);
}

// ── r4: Codex's third pass, ported ──

/// Codex r3 finding 1: an acknowledged earlier close never lets recovery delete the journal
/// before its quit's loss is merged; the loss is said, then closed, then the journal goes.
#[test]
fn auditor_fallback_survives_an_acked_earlier_close() {
    let (hub, path) = journal_hub("audit-fallback-after-closeack");
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.disconnect(ROOM, DisconnectReason::Closed);
        let old_id = hub.draining[ROOM][0].0.close_id.clone();
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.closed(ROOM, Some(CREATED), old_id);
        assert!(hub.draining.is_empty());
        hub.rooms[ROOM].journal.as_ref().unwrap().fail_writes(true);
        hub.lose_unread(ROOM, Some(1));
        hub.disconnect(ROOM, DisconnectReason::Closed);
    }
    assert!(path.join(format!("{ROOM}@{CREATED}.loss")).exists());
    let next = recovered_hub(&path, 3);
    let mut next = lock(&next);
    assert_eq!(held_seqs(&next, ROOM), vec![1], "an acknowledged old close must not cause recovery to delete the journal before merging its fallback");
    assert!(!path.join(format!("{ROOM}@{CREATED}.loss")).exists(), "merged and synced, so the fallback goes");
    assert_eq!(next.draining[ROOM][0].1, DisconnectReason::Ended);
    next.ack(ROOM, 1, Some(CREATED), None);
    assert!(path.join(journal::file_name(ROOM, CREATED)).exists(), "the loss taken, its close not yet: kept");
    let id = next.draining[ROOM][0].0.close_id.clone();
    next.closed(ROOM, Some(CREATED), id);
    assert!(journal_names(&path).is_empty());
}

/// Codex r3 finding 2: a clamped ACK never pairs a later line's id with an earlier seq.
#[test]
fn auditor_ack_clamp_keeps_the_message_id_paired_with_its_seq() {
    let (hub, path) = journal_hub("audit-ack-clamp-anchor");
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.forward(line_in(ROOM, 1));
    hub.ack(ROOM, 1, Some(CREATED), Some("900000000000000001".into()));
    let file = hub.rooms[ROOM].journal.as_ref().unwrap().clone();
    file.fail_writes(true);
    hub.lose_unread(ROOM, Some(2));
    file.fail_writes(false);
    hub.ack(ROOM, 2, Some(CREATED), Some("900000000000000002".into()));
    let parsed = journal_of(&path, ROOM, CREATED);
    assert_eq!((parsed.anchor_seq, parsed.last_msg_id.as_deref()), (1, Some("900000000000000001")), "the journal must not pair a line-2 Discord id with its clamped line-1 ACK");
}

/// Codex r3 finding 3: a corrupt fallback is refused and shown, its instance neither replayed
/// nor closed, its bytes left as they are; another instance goes on.
#[test]
fn auditor_corrupt_loss_fallback_is_refused_and_shown() {
    let (hub, path) = journal_hub("audit-corrupt-loss-fallback");
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.rooms[ROOM].journal.as_ref().unwrap().fail_writes(true);
        hub.lose_unread(ROOM, Some(1));
        hub.disconnect(ROOM, DisconnectReason::Closed);
        hub.connect(OTHER, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(OTHER, 1));
    }
    let fallback = path.join(format!("{ROOM}@{CREATED}.loss"));
    assert!(fallback.exists());
    fs::write(&fallback, b"broken loss record\n").unwrap();
    let journal_before = fs::read(path.join(journal::file_name(ROOM, CREATED))).unwrap();
    let next = recovered_hub(&path, 10);
    let next = lock(&next);
    assert!(!next.journal_errors.is_empty(), "a malformed fallback must not silently turn an owed loss into an ordinary close");
    assert_eq!(next.journal_errors.values().filter(|error| error.code == JOURNAL_CORRUPT).count(), 2, "{:?}", next.journal_errors);
    assert!(fallback.exists(), "a corrupt fallback stays for inspection");
    assert_eq!(fs::read(&fallback).unwrap(), b"broken loss record\n");
    assert_eq!(fs::read(path.join(journal::file_name(ROOM, CREATED))).unwrap(), journal_before, "no close was written");
    assert!(!next.draining.contains_key(ROOM), "the instance is held, not replayed");
    assert_eq!(held_seqs(&next, OTHER), vec![1], "another instance goes on");
}

/// A fallback whose journal is gone is named, never silently left.
#[test]
fn an_orphan_loss_fallback_is_shown() {
    let f = fixture("orphan-loss", Some(TOKEN));
    let path = journal_path(&f);
    fs::write(path.join(format!("{ROOM}@{CREATED}.loss")), b"{}\n").unwrap();
    let next = relaunch(&f);
    assert!(next.status().journal_errors.contains_key(&format!("{ROOM}@{CREATED}.loss")));
    next.remove(Some(APP_WORD)).unwrap();
    assert!(journal_names(&path).is_empty(), "Remove deletes it");
}

/// A fallback whose loss is already in the journal (a merge that crashed before the unlink)
/// is the same loss, dropped; the same seq with other content is corruption, refused.
#[test]
fn a_fallback_already_merged_is_dropped_and_a_conflicting_one_refused() {
    for (text, refused) in [(UNREAD_AT_QUIT, false), ("something else", true)] {
        let (hub, path) = journal_hub(if refused { "loss-conflict" } else { "loss-merged" });
        {
            let mut hub = lock(&hub);
            hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
            hub.forward(line_in(ROOM, 1));
            hub.lose_unread(ROOM, Some(4));
        }
        // As the quit wrote it: a loss of seqs 2–4 says it reaches 4 (#199 r9).
        let record = serde_json::json!({ "t": "loss", "seq": 2, "n": 3, "label": text, "through": 4 }).to_string() + "\n";
        fs::write(path.join(format!("{ROOM}@{CREATED}.loss")), &record).unwrap();
        let next = recovered_hub(&path, 10);
        let next = lock(&next);
        if refused {
            assert!(next.journal_errors.values().any(|error| error.code == JOURNAL_CORRUPT), "{:?}", next.journal_errors);
            assert!(path.join(format!("{ROOM}@{CREATED}.loss")).exists(), "kept as evidence");
            assert!(!next.draining.contains_key(ROOM));
        } else {
            assert_eq!(held_seqs(&next, ROOM), vec![1, 2], "said once");
            assert!(!path.join(format!("{ROOM}@{CREATED}.loss")).exists());
        }
    }
}

/// A symlink at the fallback's name is refused and kept, its target untouched, other rooms
/// go on.
#[test]
fn a_symlinked_loss_fallback_is_refused_and_kept() {
    let (hub, path) = journal_hub("loss-symlink");
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(ROOM, 1));
        hub.connect(OTHER, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(OTHER, 1));
    }
    let target = path.parent().unwrap().join("target");
    fs::write(&target, b"{\"t\":\"loss\",\"seq\":2,\"n\":1,\"label\":\"x\"}\n").unwrap();
    std::os::unix::fs::symlink(&target, path.join(format!("{ROOM}@{CREATED}.loss"))).unwrap();
    let next = recovered_hub(&path, 10);
    let next = lock(&next);
    assert!(next.journal_errors.values().any(|error| error.code == JOURNAL_CORRUPT && error.message.contains(".loss")), "{:?}", next.journal_errors);
    assert!(fs::symlink_metadata(path.join(format!("{ROOM}@{CREATED}.loss"))).unwrap().file_type().is_symlink());
    assert!(!next.draining.contains_key(ROOM));
    assert_eq!(held_seqs(&next, OTHER), vec![1]);
}

/// A disk that refuses the journal and the fallback both: the loss is not claimed recorded;
/// it is shown, and said only while this child runs (the stated d18/I21 limit).
#[test]
fn a_loss_both_writes_refuse_is_never_reported_as_recorded() {
    let (hub, path) = journal_hub("loss-both-refused");
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.forward(line_in(ROOM, 1));
    hub.rooms[ROOM].journal.as_ref().unwrap().fail_writes(true);
    journal::tests::set_fail_loss_write(true);
    hub.lose_unread(ROOM, Some(4));
    journal::tests::set_fail_loss_write(false);
    assert_eq!(hub.journal_errors.get(ROOM).map(|error| error.code.as_str()), Some(JOURNAL_BLOCKED));
    assert_eq!(held_seqs(&hub, ROOM), vec![1], "not recorded anywhere, so not said: the stated limit");
    assert!(!path.join(format!("{ROOM}@{CREATED}.loss")).exists());
}

// ── r5: Codex's fourth pass ──

fn journal_with_fallback(name: &str) -> PathBuf {
    let (hub, path) = journal_hub(name);
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.forward(line_in(ROOM, 1));
    hub.rooms[ROOM].journal.as_ref().unwrap().fail_writes(true);
    hub.lose_unread(ROOM, Some(4));
    hub.disconnect(ROOM, DisconnectReason::Closed);
    path
}

fn record_kinds(path: &Path) -> Vec<String> {
    String::from_utf8(fs::read(path.join(journal::file_name(ROOM, CREATED))).unwrap()).unwrap().lines().map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()["t"].as_str().unwrap().to_string()).collect()
}

/// Codex r4: the merge refused once, the next write fine, then a relaunch: the loss is said
/// before the close, each once.
#[test]
fn auditor_a_merge_refused_once_never_journals_the_close_before_the_loss() {
    let path = journal_with_fallback("merge-refused-once");
    {
        journal::tests::fail_appends(1);
        let next = recovered_hub(&path, 10);
        let next = lock(&next);
        assert_eq!(held_seqs(&next, ROOM), vec![1], "the loss is not handed on before it is in");
        assert!(!next.pending.is_empty(), "premise: the merge was refused");
        assert_eq!(record_kinds(&path), ["open", "line"], "nothing journalled after the refused loss: no close ahead of it");
        assert!(path.join(format!("{ROOM}@{CREATED}.loss")).exists());
    }
    let again = recovered_hub(&path, 10);
    let again = lock(&again);
    assert_eq!(held_seqs(&again, ROOM), vec![1, 2]);
    assert_eq!(record_kinds(&path), ["open", "line", "loss", "close"], "loss, then close, each once");
    assert!(again.pending.is_empty());
}

/// The same within one life: the held loss lands at the next write, ACK and close after it,
/// and only then is the child told to close.
#[test]
fn a_held_loss_lands_before_its_close_is_written_or_sent() {
    let path = journal_with_fallback("merge-lands-later");
    journal::tests::fail_appends(1);
    let next = recovered_hub(&path, 10);
    let buffer = SharedBuf::default();
    lock(&next).attach(ChildChannel::new(Box::new(buffer.clone())), BotToken::parse(TOKEN).unwrap(), String::new());
    // attach tried the merge again, and it landed: the loss, then the close.
    wait_until("the replay", || message_seqs(&buffer) == vec![1, 2]);
    wait_until("the close", || !of_kind(&buffer.lines(), "disconnect").is_empty());
    assert_eq!(record_kinds(&path), ["open", "line", "loss", "close"]);
    let id = of_kind(&buffer.lines(), "disconnect")[0]["id"].as_str().unwrap().to_string();
    {
        let mut hub = lock(&next);
        hub.ack(ROOM, 2, Some(CREATED), None);
        hub.closed(ROOM, Some(CREATED), Some(id));
    }
    assert!(journal_names(&path).is_empty());
}

/// Held for as long as the journal refuses: no close journalled, none sent, the refusal shown.
#[test]
fn a_loss_the_journal_keeps_refusing_holds_its_close() {
    let path = journal_with_fallback("merge-refused-long");
    journal::tests::fail_appends(100);
    let next = recovered_hub(&path, 10);
    let buffer = SharedBuf::default();
    lock(&next).attach(ChildChannel::new(Box::new(buffer.clone())), BotToken::parse(TOKEN).unwrap(), String::new());
    wait_until("the replay", || message_seqs(&buffer) == vec![1]);
    thread::sleep(Duration::from_millis(200));
    journal::tests::fail_appends(0);
    assert!(of_kind(&buffer.lines(), "disconnect").is_empty(), "no close is sent while the loss is not in the journal");
    assert_eq!(record_kinds(&path), ["open", "line"]);
    assert_eq!(lock(&next).journal_errors.get(ROOM).map(|error| error.code.as_str()), Some(JOURNAL_BLOCKED));
}

/// Self-audit: a held loss cannot be taken by Discord before the journal has it, since it is
/// not handed on; an ACK that names it early is clamped to what was handed and carries no id,
/// and the loss is still said once, after the launch that lands it.
#[test]
fn a_held_loss_discord_already_took_is_not_said_again() {
    let path = journal_with_fallback("merge-acked-first");
    journal::tests::fail_appends(1);
    let next = recovered_hub(&path, 10);
    {
        let mut hub = lock(&next);
        assert!(!hub.pending.is_empty(), "premise: held");
        assert_eq!(held_seqs(&hub, ROOM), vec![1], "the loss is not handed on");
        hub.ack(ROOM, 2, Some(CREATED), Some("900000000000000002".into()));
    }
    let kinds = record_kinds(&path);
    assert_eq!(kinds, ["open", "line", "loss", "close", "ack"], "{kinds:?}");
    let parsed = journal_of(&path, ROOM, CREATED);
    assert_eq!((parsed.acked, parsed.last_msg_id), (1, None), "the early ACK is line 1's, without line 2's id");
    let again = recovered_hub(&path, 10);
    assert_eq!(held_seqs(&lock(&again), ROOM), vec![2], "the loss, once");
}

// ── r6: no effect leaves the process before the record that authorises it ──

/// A Hub whose child channel has no writer: what would leave the process stays in the outbox
/// to be counted.
fn quiet_hub(name: &str) -> (Arc<Mutex<Hub>>, PathBuf) {
    let (hub, path) = journal_hub(name);
    lock(&hub).channel = Some(ChildChannel::new(Box::new(std::io::sink())));
    (hub, path)
}

fn quiet_recovered(path: &Path) -> Arc<Mutex<Hub>> {
    let dir = journal::Dir::open(path).unwrap();
    let names = dir.scan().unwrap();
    let hub = Arc::new(Mutex::new(Hub { journal_dir: Some(dir), window: 10, ..Hub::default() }));
    lock(&hub).me = Arc::downgrade(&hub);
    lock(&hub).channel = Some(ChildChannel::new(Box::new(std::io::sink())));
    lock(&hub).recover(names);
    hub
}

fn disconnects_sent(hub: &Hub) -> Vec<String> {
    hub.outbox.iter().filter_map(|out| match out {
        Out::Control(ToChild::Disconnect { id, .. }) => Some(id.clone()),
        _ => None,
    }).collect()
}

fn connects_sent(hub: &Hub) -> usize {
    hub.outbox.iter().filter(|out| matches!(out, Out::Control(ToChild::Connect { .. }))).count()
}

fn kinds_or_none(path: &Path) -> Vec<String> {
    if path.join(journal::file_name(ROOM, CREATED)).exists() { record_kinds(path) } else { Vec::new() }
}

fn close_ids_in(path: &Path) -> Vec<String> {
    let text = fs::read_to_string(path.join(journal::file_name(ROOM, CREATED))).unwrap_or_default();
    text.lines().map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()).filter(|record| record["t"] == "close").map(|record| record["id"].as_str().unwrap().to_string()).collect()
}

/// Codex r5: the Close write refused once. Nothing is sent until it is in; the retry writes
/// the same id; the child is told once; a relaunch closes with that same id.
#[test]
fn auditor_a_close_write_refused_once_sends_nothing_and_keeps_its_id() {
    let (hub, path) = quiet_hub("close-refused-once");
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.forward(line_in(ROOM, 1));
    journal::tests::fail_appends(1);
    hub.disconnect(ROOM, DisconnectReason::Closed);
    let minted = hub.draining[ROOM][0].0.close_id.clone().unwrap();
    assert!(disconnects_sent(&hub).is_empty(), "no close to the child before its record");
    assert!(close_ids_in(&path).is_empty());
    hub.flush_pending();
    assert_eq!(close_ids_in(&path), vec![minted.clone()], "the retry writes the same id");
    assert_eq!(disconnects_sent(&hub), vec![minted.clone()], "and only then is the child told, once");
    drop(hub);
    let next = quiet_recovered(&path);
    let next = lock(&next);
    assert_eq!(next.draining[ROOM][0].0.close_id.as_deref(), Some(minted.as_str()), "a relaunch closes with the same id");
    assert_eq!(close_ids_in(&path), vec![minted], "no second close minted");
}

/// The same crash before any retry: nothing was sent, so the relaunch's one close is the only.
#[test]
fn a_close_refused_then_a_crash_closes_once_at_the_next_launch() {
    let (hub, path) = quiet_hub("close-refused-crash");
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(ROOM, 1));
        journal::tests::fail_appends(1);
        hub.disconnect(ROOM, DisconnectReason::Closed);
        assert!(disconnects_sent(&hub).is_empty());
    }
    let next = quiet_recovered(&path);
    let next = lock(&next);
    assert_eq!(close_ids_in(&path).len(), 1);
    assert_eq!(disconnects_sent(&next), close_ids_in(&path), "one close, said once");
}

/// How a site's write is refused: the append fails whole, or writes half its record and then
/// fails as a full disk does (ENOSPC).
#[derive(Clone, Copy, Debug)]
enum Fault {
    Append,
    Short,
}

fn fault(mode: Fault, count: u32) {
    match mode {
        Fault::Append => journal::tests::fail_appends(count),
        Fault::Short => journal::tests::short_appends(count),
    }
}

fn no_faults() {
    journal::tests::fail_appends(0);
    journal::tests::short_appends(0);
    journal::tests::fail_syncs(0);
    journal::tests::set_fail_loss_write(false);
}

type SiteCase = (&'static str, fn(Fault) -> Result<(), String>);

fn check(ok: bool, why: &str) -> Result<(), String> {
    if ok { Ok(()) } else { Err(why.to_string()) }
}

/// Right after a refused write: the journal is whole records only, and parses.
fn whole(path: &Path) -> Result<(), String> {
    let name = journal::file_name(ROOM, CREATED);
    let Ok(bytes) = fs::read(path.join(&name)) else {
        return Ok(());
    };
    check(bytes.last().is_none_or(|last| *last == b'\n'), "a refused write left part of a record")?;
    journal::parse(&name, &bytes).map(|_| ()).map_err(|corrupt| format!("the journal no longer parses: {corrupt:?}"))
}

/// The crash after the retry, then the next launch: the journal is whole; no journalled close
/// changes id; at most one close is minted, for an open tail; every line and loss is in the
/// file once; and the child is handed nothing ahead of what authorises it (`check_wire`).
fn after_relaunch(path: &Path) -> Result<Vec<serde_json::Value>, String> {
    if !path.join(journal::file_name(ROOM, CREATED)).exists() {
        return Ok(Vec::new());
    }
    whole(path)?;
    let before = close_ids_in(path);
    let (_hub, handed) = launch_wire(path, Moment::Launch).map_err(|why| format!("relaunch: {why}"))?;
    let after = close_ids_in(path);
    check(after.starts_with(&before) && after.len() <= before.len() + 1, &format!("relaunch: closes {before:?} became {after:?}"))?;
    let closes_told: Vec<&str> = handed.iter().filter(|line| line["t"] == "disconnect").filter_map(|line| line["id"].as_str()).collect();
    check(closes_told.iter().all(|id| after.iter().any(|kept| kept == id)), "relaunch: a close told that the journal does not hold")?;
    let seqs: Vec<u64> = records_in(path).iter().filter(|record| record["t"] == "line" || record["t"] == "loss").filter_map(|record| record["seq"].as_u64()).collect();
    check(seqs.windows(2).all(|pair| pair[0] < pair[1]), &format!("relaunch: lines or losses out of order or twice: {seqs:?}"))?;
    Ok(handed)
}

fn messages_handed(handed: &[serde_json::Value]) -> Vec<u64> {
    handed.iter().filter(|line| line["t"] == "message").filter_map(|line| line["seq"].as_u64()).collect()
}

fn site_close(mode: Fault) -> Result<(), String> {
    let (hub, path) = quiet_hub(&format!("site-close-{mode:?}"));
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    fault(mode, 1);
    hub.disconnect(ROOM, DisconnectReason::Closed);
    whole(&path)?;
    let id = hub.draining[ROOM][0].0.close_id.clone().unwrap();
    check(disconnects_sent(&hub).is_empty() && close_ids_in(&path).is_empty(), "close sent before its record")?;
    hub.flush_pending();
    check(close_ids_in(&path) == vec![id.clone()] && disconnects_sent(&hub) == vec![id.clone()], "close retried with another id, or not sent once")?;
    let handed = after_relaunch(&path)?;
    check(handed.iter().filter(|line| line["t"] == "disconnect").map(|line| line["id"].as_str().unwrap()).collect::<Vec<_>>() == vec![id.as_str()], "relaunch: not the same close, once")
}

fn site_closeack(mode: Fault) -> Result<(), String> {
    let (hub, path) = quiet_hub(&format!("site-closeack-{mode:?}"));
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.disconnect(ROOM, DisconnectReason::Closed);
    let id = hub.draining[ROOM][0].0.close_id.clone();
    fault(mode, 1);
    hub.closed(ROOM, Some(CREATED), id.clone());
    whole(&path)?;
    check(path.join(journal::file_name(ROOM, CREATED)).exists() && !hub.draining.is_empty(), "journal deleted before its closeack")?;
    hub.closed(ROOM, Some(CREATED), id);
    check(hub.pending.len() == 1, "a repeated closed queued a second closeack")?;
    hub.flush_pending();
    check(journal_names(&path).is_empty(), "the closeack's retry did not finish the journal")?;
    check(after_relaunch(&path)?.is_empty(), "relaunch: a finished journal replayed")
}

fn site_line(mode: Fault) -> Result<(), String> {
    let (hub, path) = quiet_hub(&format!("site-line-{mode:?}"));
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    fault(mode, 1);
    let first = hub.forward(line_in(ROOM, 1));
    whole(&path)?;
    check(first == Forwarded::Blocked && held_seqs(&hub, ROOM).is_empty() && hub.rooms[ROOM].last_seq == 0, "line handed on before its record")?;
    let again = hub.forward(line_in(ROOM, 1));
    check(again == Forwarded::Taken && held_seqs(&hub, ROOM) == vec![1] && kinds_or_none(&path) == ["open", "line"], "the same line not taken once on retry")?;
    check(messages_handed(&after_relaunch(&path)?) == vec![1], "relaunch: the line not handed once")
}

/// A jump said as a gap notice, the notice's write refused (`skip` 0) or the line's after the
/// notice landed (`skip` 1): only what the journal took is taken in, and the retry says the
/// gap once, as the journal holds it.
fn site_gap_notice_after(mode: Fault, skip: u32) -> Result<(), String> {
    let (hub, path) = quiet_hub(&format!("site-gap-{mode:?}-{skip}"));
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.forward(line_in(ROOM, 1));
    journal::tests::pass_appends(skip);
    fault(mode, 1);
    let first = hub.forward(line_in(ROOM, 4));
    journal::tests::pass_appends(0);
    whole(&path)?;
    // What the journal took is taken in, and nothing past it: the notice when it landed.
    let landed: Vec<u64> = if skip == 0 { vec![1] } else { vec![1, 2] };
    check(first == Forwarded::Blocked && held_seqs(&hub, ROOM) == landed && hub.rooms[ROOM].last_seq == *landed.last().unwrap(), "a record handed on before it was in, or one that was in not taken")?;
    held_matches_journal(&hub, &path)?;
    let again = hub.forward(line_in(ROOM, 4));
    check(again == Forwarded::Taken && held_seqs(&hub, ROOM) == vec![1, 2, 4], "the gap and its line not taken once on retry")?;
    let notice = texts_of(&hub, ROOM).into_iter().find(|(seq, _)| *seq == 2).map(|(_, text)| text);
    check(notice.as_deref() == Some("2 lines went by unfollowed"), "the retry said another gap")?;
    check(messages_handed(&after_relaunch(&path)?) == vec![1, 2, 4], "relaunch: the gap or its line not handed once")
}

fn site_gap_notice(mode: Fault) -> Result<(), String> {
    site_gap_notice_after(mode, 0)
}

fn site_gap_line(mode: Fault) -> Result<(), String> {
    site_gap_notice_after(mode, 1)
}

fn site_dropped_notice(mode: Fault) -> Result<(), String> {
    let (hub, path) = quiet_hub(&format!("site-dropped-{mode:?}"));
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    fault(mode, 1);
    let first = hub.on_dropped(ROOM, 5, 0);
    whole(&path)?;
    check(first == Forwarded::Blocked && held_seqs(&hub, ROOM).is_empty() && hub.rooms[ROOM].skip == 0, "the dropped prefix handed on, or passed over, before its record")?;
    let again = hub.on_dropped(ROOM, 5, 0);
    check(again == Forwarded::Taken && texts_of(&hub, ROOM) == vec![(1, "5 lines the room dropped".to_string())], "the dropped prefix not said once on retry")?;
    check(messages_handed(&after_relaunch(&path)?) == vec![1], "relaunch: the dropped prefix not handed once")
}

fn site_open(mode: Fault) -> Result<(), String> {
    let (hub, path) = quiet_hub(&format!("site-open-{mode:?}"));
    let mut hub = lock(&hub);
    fault(mode, 1);
    let first = hub.connect(ROOM, vec![], Some(CREATED));
    check(first.is_err() && connects_sent(&hub) == 0 && !path.join(journal::file_name(ROOM, CREATED)).exists(), "connect sent before its open record")?;
    hub.connect(ROOM, vec![], Some(CREATED)).map_err(|error| error.to_string())?;
    check(connects_sent(&hub) == 1 && kinds_or_none(&path) == ["open"], "the retried connect not once")?;
    let handed = after_relaunch(&path)?;
    check(messages_handed(&handed).is_empty() && handed.iter().filter(|line| line["t"] == "disconnect").count() == 1, "relaunch: an empty instance not closed once")
}

fn site_ack(mode: Fault) -> Result<(), String> {
    let (hub, path) = quiet_hub(&format!("site-ack-{mode:?}"));
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.forward(line_in(ROOM, 1));
    // The ack's own write, the retry its settle makes, and the close's flush: all refused.
    fault(mode, 3);
    hub.ack(ROOM, 1, Some(CREATED), Some("900000000000000001".into()));
    whole(&path)?;
    check(kinds_or_none(&path) == ["open", "line"], "an ack record half-written")?;
    hub.disconnect(ROOM, DisconnectReason::Closed);
    check(disconnects_sent(&hub).is_empty(), "a close went ahead of the ack still pending")?;
    hub.flush_pending();
    let parsed = journal_of(&path, ROOM, CREATED);
    check((parsed.acked, parsed.anchor_seq, parsed.last_msg_id.as_deref()) == (1, 1, Some("900000000000000001")) && record_kinds(&path) == ["open", "line", "ack", "close"], "the ack retried out of order or re-paired")?;
    let id = close_ids_in(&path);
    let handed = after_relaunch(&path)?;
    check(messages_handed(&handed).is_empty(), "relaunch: an acked line handed again")?;
    check(handed.iter().filter(|line| line["t"] == "disconnect").map(|line| line["id"].as_str().unwrap().to_string()).collect::<Vec<_>>() == id, "relaunch: not the same close")?;
    check(handed.iter().find(|line| line["t"] == "connect").map(|line| line["resume"].clone()) == Some(serde_json::json!({ "lastAcked": 1, "lastMsgId": "900000000000000001" })), "relaunch: the anchor not the retried ack's")
}

fn site_quit_loss(mode: Fault) -> Result<(), String> {
    let (hub, path) = quiet_hub(&format!("site-quit-loss-{mode:?}"));
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.forward(line_in(ROOM, 1));
    // Every try in the quit's grace, and the flush the close's record makes.
    fault(mode, QUIT_LOSS_TRIES + 1);
    hub.lose_unread(ROOM, Some(4));
    hub.disconnect(ROOM, DisconnectReason::Closed);
    whole(&path)?;
    check(held_seqs(&hub, ROOM) == vec![1] && disconnects_sent(&hub).is_empty() && record_kinds(&path) == ["open", "line"], "loss or close let out before the loss record")?;
    check(path.join(format!("{ROOM}@{CREATED}.loss")).exists(), "no fallback while the journal refuses")?;
    hub.flush_pending();
    check(held_seqs(&hub, ROOM) == vec![1, 2] && record_kinds(&path) == ["open", "line", "loss", "close"] && disconnects_sent(&hub).len() == 1, "the loss and its close not in order, once")?;
    check(!path.join(format!("{ROOM}@{CREATED}.loss")).exists(), "the fallback kept after the loss landed")?;
    let id = close_ids_in(&path);
    let handed = after_relaunch(&path)?;
    check(messages_handed(&handed) == vec![1, 2], "relaunch: the line and the loss not handed once each")?;
    check(handed.iter().filter(|line| line["t"] == "disconnect").map(|line| line["id"].as_str().unwrap().to_string()).collect::<Vec<_>>() == id, "relaunch: not the same close")
}

fn site_merge_loss(mode: Fault) -> Result<(), String> {
    let path = journal_with_fallback(&format!("site-merge-loss-{mode:?}"));
    fault(mode, 1);
    let hub = quiet_recovered(&path);
    let mut hub = lock(&hub);
    whole(&path)?;
    check(held_seqs(&hub, ROOM) == vec![1] && disconnects_sent(&hub).is_empty() && record_kinds(&path) == ["open", "line"], "merged loss or its close let out before the record")?;
    check(path.join(format!("{ROOM}@{CREATED}.loss")).exists(), "fallback deleted before the merge landed")?;
    let id = hub.draining[ROOM][0].0.close_id.clone().unwrap();
    hub.flush_pending();
    check(record_kinds(&path) == ["open", "line", "loss", "close"] && close_ids_in(&path) == vec![id.clone()] && disconnects_sent(&hub) == vec![id.clone()], "the merge's retry out of order, or a new close id")?;
    check(!path.join(format!("{ROOM}@{CREATED}.loss")).exists(), "the fallback kept after the merge landed")?;
    let handed = after_relaunch(&path)?;
    check(messages_handed(&handed) == vec![1, 2], "relaunch: the line and the loss not handed once each")?;
    check(handed.iter().filter(|line| line["t"] == "disconnect").map(|line| line["id"].as_str().unwrap()).collect::<Vec<_>>() == vec![id.as_str()], "relaunch: not the same close")
}

fn site_ended_close(mode: Fault) -> Result<(), String> {
    let (hub, path) = journal_hub(&format!("site-ended-close-{mode:?}"));
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(ROOM, 1));
    }
    fault(mode, 1);
    let next = quiet_recovered(&path);
    let mut next = lock(&next);
    whole(&path)?;
    let id = next.draining[ROOM][0].0.close_id.clone().unwrap();
    check(disconnects_sent(&next).is_empty() && close_ids_in(&path).is_empty(), "an ended close sent before its record")?;
    next.flush_pending();
    check(close_ids_in(&path) == vec![id.clone()] && disconnects_sent(&next) == vec![id.clone()], "the ended close's retry with another id, or not once")?;
    let handed = after_relaunch(&path)?;
    check(messages_handed(&handed) == vec![1], "relaunch: the line not handed once")?;
    check(handed.iter().filter(|line| line["t"] == "disconnect").map(|line| line["id"].as_str().unwrap()).collect::<Vec<_>>() == vec![id.as_str()], "relaunch: not the same close")
}

/// Every journal write site (`.claude/context/discord-write-sites.md`), each refused once as a
/// failed append and as a short write: nothing it authorises leaves the process before the
/// record is in, the journal stays whole, the retry in the same process keeps the same record,
/// id and order, and a crash after it relaunches to the same ids with nothing lost or doubled.
#[test]
fn every_write_site_refused_once_lets_nothing_out_and_retries_the_same_record() {
    let table: [SiteCase; 11] = [
        ("open", site_open),
        ("line", site_line),
        ("gap notice", site_gap_notice),
        ("gap line after its notice", site_gap_line),
        ("dropped notice", site_dropped_notice),
        ("ack", site_ack),
        ("close", site_close),
        ("closeack", site_closeack),
        ("quit loss", site_quit_loss),
        ("merged loss", site_merge_loss),
        ("ended close at launch", site_ended_close),
    ];
    let mut failed = Vec::new();
    for mode in [Fault::Append, Fault::Short] {
        for (site, case) in &table {
            let outcome = std::panic::catch_unwind(|| case(mode)).unwrap_or_else(|panic| {
                let said = panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|text| text.to_string()));
                Err(format!("panicked: {}", said.unwrap_or_default()))
            });
            no_faults();
            journal::tests::pass_appends(0);
            if let Err(why) = outcome {
                failed.push(format!("{site} ({mode:?}): {why}"));
            }
        }
    }
    assert!(failed.is_empty(), "{} of {} cases: {failed:#?}", failed.len(), table.len() * 2);
}

// ── r6b: the auditor's checklist on the durable-before-effect rule ──

/// A child that is only an outbox: attached, its writer never started, so what it would be
/// handed is read here in order with `wire`.
fn quiet_attach(hub: &mut Hub) {
    let mut channel = ChildChannel::new(Box::new(std::io::sink()));
    channel.out = None;
    hub.attach(channel, BotToken::parse(TOKEN).unwrap(), String::new());
}

/// Everything the current child is handed from here, in order.
fn wire(hub: &mut Hub) -> Vec<serde_json::Value> {
    std::iter::from_fn(|| hub.next_line()).map(|line| serde_json::from_str(&line).unwrap()).collect()
}

fn records_in(path: &Path) -> Vec<serde_json::Value> {
    fs::read_to_string(path.join(journal::file_name(ROOM, CREATED))).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

/// The oracle for durable-before-effect, over what one child was handed and the journal as it
/// is now: every Disconnect names a close the journal holds; every line or loss the journal
/// holds ahead of that close, not yet taken by Discord, was handed before it; and every loss
/// not yet taken is handed exactly once.
fn check_wire(path: &Path, wire: &[serde_json::Value]) -> Result<(), String> {
    let records = records_in(path);
    let acked = records.iter().filter(|record| record["t"] == "ack").filter_map(|record| record["seq"].as_u64()).max().unwrap_or(0);
    let handed_at = |seq: u64| wire.iter().position(|line| line["t"] == "message" && line["seq"].as_u64() == Some(seq));
    for (at, line) in wire.iter().enumerate().filter(|(_, line)| line["t"] == "disconnect") {
        let id = &line["id"];
        let Some(close) = records.iter().position(|record| record["t"] == "close" && record["id"] == *id) else {
            return Err(format!("disconnect {id} handed with no close in the journal: {records:?}"));
        };
        for record in &records[..close] {
            let Some(seq) = record["seq"].as_u64().filter(|seq| (record["t"] == "line" || record["t"] == "loss") && *seq > acked) else {
                continue;
            };
            if !handed_at(seq).is_some_and(|handed| handed < at) {
                return Err(format!("disconnect {id} handed before {} {seq}, which the journal holds ahead of its close", record["t"]));
            }
        }
    }
    for record in records.iter().filter(|record| record["t"] == "loss") {
        let seq = record["seq"].as_u64().unwrap();
        let times = wire.iter().filter(|line| line["t"] == "message" && line["seq"].as_u64() == Some(seq)).count();
        if seq > acked && times != 1 {
            return Err(format!("the loss at seq {seq} handed {times} times"));
        }
    }
    Ok(())
}

fn write_fallback(path: &Path, seq: u64, n: u64) {
    let record = serde_json::json!({ "t": "loss", "seq": seq, "n": n, "label": UNREAD_AT_QUIT }).to_string() + "\n";
    fs::write(path.join(format!("{ROOM}@{CREATED}.loss")), record).unwrap();
}

/// A journal whose only close is journalled and not yet done, with a quit's loss left in the
/// fallback after it: the shape the suspect at launch replay (`install`) reads.
fn journal_closed_then_fallback(name: &str) -> PathBuf {
    let (hub, path) = journal_hub(name);
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(ROOM, 1));
        hub.disconnect(ROOM, DisconnectReason::Closed);
    }
    write_fallback(&path, 2, 3);
    path
}

#[derive(Clone, Copy, Debug)]
enum Moment {
    /// A child is running when the journal is loaded.
    Launch,
    /// None is; one is attached afterwards.
    Offline,
    /// One is running, and a second replaces it.
    Restart,
}

fn launch_wire(path: &Path, moment: Moment) -> Result<(Arc<Mutex<Hub>>, Vec<serde_json::Value>), String> {
    let dir = journal::Dir::open(path).unwrap();
    let names = dir.scan().unwrap();
    let hub = Arc::new(Mutex::new(Hub { journal_dir: Some(dir), window: 10, ..Hub::default() }));
    let mut guard = lock(&hub);
    guard.me = Arc::downgrade(&hub);
    if !matches!(moment, Moment::Offline) {
        quiet_attach(&mut guard);
    }
    guard.recover(names);
    let mut handed = wire(&mut guard);
    let running = !matches!(moment, Moment::Offline);
    if running {
        check_wire(path, &handed).map_err(|why| format!("{moment:?}, first child: {why}"))?;
    }
    guard.flush_pending();
    handed.extend(wire(&mut guard));
    if running {
        check_wire(path, &handed).map_err(|why| format!("{moment:?}, first child after the retry: {why}"))?;
    }
    if !matches!(moment, Moment::Launch) {
        quiet_attach(&mut guard);
        handed = wire(&mut guard);
        check_wire(path, &handed).map_err(|why| format!("{moment:?}, attached child: {why}"))?;
    }
    drop(guard);
    Ok((hub, handed))
}

/// Checklist 4, the suspect at launch replay: a batch whose close is already journalled and
/// still owed is told to close at once, while a quit's fallback loss of the same instance only
/// waits for the journal. At launch, offline, and after a child restart, with the loss landing
/// at once or refused once: no close leaves ahead of a line or loss the journal holds before
/// it, and the loss is handed exactly once.
#[test]
fn r6b_launch_replay_never_closes_a_post_ahead_of_its_loss() {
    let mut failed = Vec::new();
    for moment in [Moment::Launch, Moment::Offline, Moment::Restart] {
        for refused in [0, 1] {
            let path = journal_closed_then_fallback(&format!("r6b-suspect-{moment:?}-{refused}"));
            journal::tests::fail_appends(refused);
            let outcome = launch_wire(&path, moment).and_then(|(_, handed)| {
                let shape: Vec<String> = handed.iter().filter(|line| line["t"] != "hello").map(|line| format!("{}{}", line["t"].as_str().unwrap(), line["seq"].as_u64().map(|seq| seq.to_string()).unwrap_or_default())).collect();
                check(shape.iter().filter(|kind| *kind == "message2").count() == 1, &format!("the loss not handed once: {shape:?}"))?;
                check(shape.last().map(String::as_str) == Some("disconnect"), &format!("the post left open: {shape:?}"))
            });
            journal::tests::fail_appends(0);
            if let Err(why) = outcome {
                failed.push(format!("refused {refused}: {why}"));
            }
        }
    }
    assert!(failed.is_empty(), "{failed:#?}");
}

/// Checklist 4, the same rule where a close is folded over another: a connection with nothing
/// held, let go while its instance's last close is still owed, is told that same close again.
/// When its quit's loss is still waiting for the journal, that fold must not close the post
/// ahead of the loss, nor lose the loss when it lands.
#[test]
fn r6b_a_quit_never_folds_its_close_over_a_loss_still_waiting_for_the_journal() {
    let (hub, path) = quiet_hub("r6b-fold");
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.disconnect(ROOM, DisconnectReason::Closed);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    let mut handed = wire(&mut hub);
    assert_eq!(handed.iter().filter(|line| line["t"] == "disconnect").count(), 1, "premise: the first close was told");
    // The quit: the loss refused through every try and the next flush.
    journal::tests::fail_appends(QUIT_LOSS_TRIES + 1);
    hub.lose_unread(ROOM, Some(3));
    hub.disconnect(ROOM, DisconnectReason::Closed);
    journal::tests::fail_appends(0);
    assert!(path.join(format!("{ROOM}@{CREATED}.loss")).exists(), "premise: the loss waits in the fallback");
    handed.extend(wire(&mut hub));
    assert_eq!(handed.iter().filter(|line| line["t"] == "disconnect").count(), 1, "a close left while the quit's loss was not in the journal: {handed:?}");
    hub.flush_pending();
    handed.extend(wire(&mut hub));
    check_wire(&path, &handed).unwrap();
    assert!(handed.iter().any(|line| line["t"] == "message" && line["seq"] == 1), "the loss landed but was never handed: {handed:?}");
    // The child says each close is done before Discord takes the loss: the journal stays.
    for id in handed.iter().filter(|line| line["t"] == "disconnect").map(|line| line["id"].as_str().unwrap().to_string()).collect::<Vec<_>>() {
        hub.closed(ROOM, Some(CREATED), Some(id));
    }
    assert!(path.join(journal::file_name(ROOM, CREATED)).exists(), "the journal went with its loss never taken");
}

/// The same fold crashed before the loss landed: the next launch says it once, before the
/// close that ends the post.
#[test]
fn r6b_a_folded_quit_crashed_before_its_loss_landed_says_it_once_at_launch() {
    let (hub, path) = quiet_hub("r6b-fold-crash");
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.disconnect(ROOM, DisconnectReason::Closed);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        journal::tests::fail_appends(QUIT_LOSS_TRIES + 1);
        hub.lose_unread(ROOM, Some(3));
        hub.disconnect(ROOM, DisconnectReason::Closed);
        journal::tests::fail_appends(0);
    }
    drop(hub);
    for moment in [Moment::Launch, Moment::Offline, Moment::Restart] {
        let copy = scratch(&format!("r6b-fold-crash-{moment:?}")).join(JOURNAL_DIR);
        journal::Dir::open(&copy).unwrap();
        for name in journal_names(&path) {
            fs::copy(path.join(&name), copy.join(&name)).unwrap();
        }
        let (_, handed) = launch_wire(&copy, moment).unwrap();
        assert_eq!(handed.iter().filter(|line| line["t"] == "message" && line["seq"] == 1).count(), 1, "{moment:?}: {handed:?}");
        assert_eq!(handed.last().map(|line| line["t"].clone()), Some(serde_json::json!("disconnect")), "{moment:?}");
    }
}

/// Checklist 2, the sync half, for the records whose effect waits on a sync rather than on
/// write(2) alone (C1): a quit's loss and a merged loss. The append lands and the sync is
/// refused: the loss is not handed on, its fallback stays, its close is not journalled; the
/// retry writes no second loss and hands it once; a crash before the retry says it once.
#[test]
fn r6b_a_refused_sync_holds_a_waiting_loss_and_its_close_then_says_it_once() {
    let mut failed = Vec::new();
    let fallback = |path: &Path| path.join(format!("{ROOM}@{CREATED}.loss")).exists();
    let losses = |path: &Path| records_in(path).iter().filter(|record| record["t"] == "loss").count();
    for (case, crash) in [("quit", false), ("quit", true), ("merged", false), ("merged", true)] {
        let outcome = std::panic::catch_unwind(|| -> Result<(), String> {
            let name = format!("r6b-sync-{case}-{crash}");
            let (hub, path) = if case == "quit" {
                let (hub, path) = quiet_hub(&name);
                {
                    let mut hub = lock(&hub);
                    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
                    hub.forward(line_in(ROOM, 1));
                    journal::tests::fail_appends(QUIT_LOSS_TRIES + 1);
                    hub.lose_unread(ROOM, Some(4));
                    hub.disconnect(ROOM, DisconnectReason::Closed);
                    journal::tests::fail_appends(0);
                    journal::tests::fail_syncs(1);
                    hub.flush_pending();
                }
                (hub, path)
            } else {
                let path = journal_with_fallback(&name);
                journal::tests::fail_syncs(1);
                (quiet_recovered(&path), path)
            };
            journal::tests::fail_syncs(0);
            {
                let hub = lock(&hub);
                check(record_kinds(&path) == ["open", "line", "loss"], &format!("premise: the loss written, its sync refused: {:?}", record_kinds(&path)))?;
                check(held_seqs(&hub, ROOM) == vec![1] && disconnects_sent(&hub).is_empty(), "the loss or its close let out before the loss was synced")?;
                check(fallback(&path), "the fallback went before the loss was synced")?;
                check(hub.journal_errors.get(ROOM).is_some_and(|error| error.message.contains("injected journal sync failure")), "the refused sync not shown")?;
            }
            if !crash {
                let mut hub = lock(&hub);
                hub.flush_pending();
                check(losses(&path) == 1 && record_kinds(&path) == ["open", "line", "loss", "close"], "the retry wrote the loss again, or the close not after it")?;
                check(held_seqs(&hub, ROOM) == vec![1, 2] && disconnects_sent(&hub).len() == 1 && !fallback(&path), "the loss not handed once after its sync, or its fallback kept")?;
            }
            drop(hub);
            let handed = after_relaunch(&path)?;
            check(messages_handed(&handed) == vec![1, 2] && losses(&path) == 1 && !fallback(&path), &format!("relaunch: the loss not said once: {:?}", messages_handed(&handed)))
        })
        .unwrap_or_else(|_| Err("panicked".to_string()));
        no_faults();
        if let Err(why) = outcome {
            failed.push(format!("{case}, crash {crash}: {why}"));
        }
    }
    assert!(failed.is_empty(), "{failed:#?}");
}

/// Checklist 2, sync before delete (C7 → C8): a done journal whose sync is refused is kept and
/// the refusal shown; the next launch finds it done and deletes it, replaying nothing.
#[test]
fn r6b_a_refused_sync_keeps_a_done_journal_until_it_can_be_finished() {
    let (hub, path) = quiet_hub("r6b-sync-finish");
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(ROOM, 1));
        hub.disconnect(ROOM, DisconnectReason::Closed);
        hub.ack(ROOM, 1, Some(CREATED), None);
        let id = hub.draining[ROOM][0].0.close_id.clone();
        journal::tests::fail_syncs(1);
        hub.closed(ROOM, Some(CREATED), id);
        journal::tests::fail_syncs(0);
        assert_eq!(record_kinds(&path), ["open", "line", "close", "ack", "closeack"], "premise: done, the closeack written");
        assert!(path.join(journal::file_name(ROOM, CREATED)).exists(), "deleted before its closeack was synced");
        assert!(hub.journal_errors.get(ROOM).is_some_and(|error| error.message.contains("injected journal sync failure")), "the refused sync not shown");
    }
    let (_next, handed) = launch_wire(&path, Moment::Launch).unwrap();
    assert!(messages_handed(&handed).is_empty() && !handed.iter().any(|line| line["t"] == "disconnect"), "a done journal replayed: {handed:?}");
    assert!(journal_names(&path).is_empty(), "the next launch finishes it");
}

/// Checklist 2, the bridge's half of I1: an events-open whose journal sync is refused is not
/// made; the reader backs off, and opens from that seq only once a sync has covered it.
#[test]
fn r6b_a_refused_sync_opens_nothing_on_the_bridge() {
    let f = fixture("r6b-sync-open", Some(TOKEN));
    let _buffer = f.attach_buffer();
    *f.source.probe.lock().unwrap() = Some(Arc::downgrade(&f.state.hub));
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("the first open", || !f.source.sinces.lock().unwrap().is_empty());
    let file = {
        let mut hub = lock(&f.state.hub);
        for seq in 1..=3 {
            assert_eq!(hub.forward(line_in(ROOM, seq)), Forwarded::Taken);
        }
        let file = hub.rooms[ROOM].journal.clone().unwrap();
        file.fail_next_syncs(1);
        file
    };
    wait_until("an open from 3", || f.source.sinces.lock().unwrap().contains(&3));
    let error = lock(&f.state.hub).journal_errors.get(ROOM).map(|error| error.message.clone()).unwrap_or_default();
    assert!(error.contains("injected journal sync failure"), "premise: the open's sync was refused: {error:?}");
    let seen = f.source.synced_at.lock().unwrap().clone();
    for (what, told, synced) in &seen {
        assert!(told <= synced, "{what} told the bridge {told} with the journal synced only through {synced}: {seen:?}");
    }
    assert_eq!(file.synced_through(), 3);
}

/// Checklist 2, the relay-ack: Discord's ACK of synced-nothing lines is not told to the bridge
/// while the sync is refused; it is told once a sync covers it.
#[test]
fn r6b_a_refused_sync_acks_nothing_on_the_bridge() {
    let f = fixture("r6b-sync-ack", Some(TOKEN));
    let buffer = f.attach_buffer();
    *f.source.probe.lock().unwrap() = Some(Arc::downgrade(&f.state.hub));
    f.source.hold.store(true, Ordering::SeqCst);
    f.stream(ROOM, &(1..=5).map(|seq| mail(seq, "peer-a", "everyone", "tell", &format!("m{seq}"))).collect::<Vec<_>>());
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("five", || message_seqs(&buffer).len() == 5);
    lock(&f.state.hub).rooms[ROOM].journal.as_ref().unwrap().fail_next_syncs(1);
    for seq in 1..=5 {
        ack(&f, ROOM, seq);
    }
    wait_until("the relay-ack", || f.source.acks.lock().unwrap().iter().any(|(_, _, seq)| *seq == 5));
    let error = lock(&f.state.hub).journal_errors.get(ROOM).map(|error| error.message.clone()).unwrap_or_default();
    assert!(error.contains("injected journal sync failure"), "premise: the ACK's sync was refused: {error:?}");
    let seen = f.source.synced_at.lock().unwrap().clone();
    for (what, told, synced) in seen.iter().filter(|(what, ..)| *what == "ack") {
        assert!(told <= synced, "{what} told the bridge {told} with the journal synced only through {synced}: {seen:?}");
    }
}

/// Checklist 5: a journal whose last record was torn by a crash mid-write. Only whole records
/// stand; nothing whole is lost, nothing torn is said, the post is closed once, and a torn
/// tail is not taken for a corrupt journal.
#[test]
fn r6b_a_torn_tail_replays_what_is_whole_and_closes_once() {
    let mut failed = Vec::new();
    for torn in ["line", "loss", "ack", "close", "closeack"] {
        let (hub, path) = journal_hub(&format!("r6b-torn-{torn}"));
        {
            let mut hub = lock(&hub);
            hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
            hub.forward(line_in(ROOM, 1));
            match torn {
                "line" => drop(hub.forward(line_in(ROOM, 2))),
                "loss" => hub.lose_unread(ROOM, Some(3)),
                "ack" => hub.ack(ROOM, 1, Some(CREATED), Some("900000000000000001".into())),
                "close" => drop(hub.disconnect(ROOM, DisconnectReason::Closed)),
                _ => {
                    hub.ack(ROOM, 1, Some(CREATED), None);
                    hub.disconnect(ROOM, DisconnectReason::Disconnected);
                    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
                    hub.forward(line_in(ROOM, 2));
                    let id = hub.draining[ROOM][0].0.close_id.clone();
                    hub.closed(ROOM, Some(CREATED), id);
                }
            }
        }
        drop(hub);
        let name = path.join(journal::file_name(ROOM, CREATED));
        let bytes = fs::read(&name).unwrap();
        let last = bytes[..bytes.len() - 1].iter().rposition(|b| *b == b'\n').unwrap() + 1;
        let kind = serde_json::from_slice::<serde_json::Value>(&bytes[last..bytes.len() - 1]).unwrap()["t"].clone();
        let whole_before = records_in(&path).len() - 1;
        fs::write(&name, &bytes[..last + (bytes.len() - last) / 2]).unwrap();
        let outcome = (|| -> Result<(), String> {
            check(kind == torn, &format!("premise: the last record is a {torn}, not {kind}"))?;
            let (next, handed) = launch_wire(&path, Moment::Launch)?;
            check(lock(&next).journal_errors.is_empty(), "a torn tail taken for corruption")?;
            check(records_in(&path).len() >= whole_before, "a whole record lost with the torn tail")?;
            let said = messages_handed(&handed);
            let expect: Vec<u64> = match torn {
                "closeack" => vec![2],
                _ => vec![1],
            };
            check(said == expect, &format!("handed {said:?}, expected {expect:?}"))?;
            check(handed.last().is_some_and(|line| line["t"] == "disconnect"), "the post left open")
        })();
        if let Err(why) = outcome {
            failed.push(format!("torn {torn}: {why}"));
        }
    }
    assert!(failed.is_empty(), "{failed:#?}");
}

/// Checklist 5: a close told, the child restarted before it said the close was done, the old
/// child's `closed` arriving late, the new child's `closed` refused by the journal, then the app
/// relaunched: the late one writes nothing, the close is told again with the same id, and the
/// next `closed` finishes the journal. Nothing is taken as done early.
#[test]
fn r6b_a_close_ack_after_restarts_keeps_its_id_and_finishes_once() {
    let f = fixture("r6b-closeack-restart", Some(TOKEN));
    let _buffer = f.attach_buffer();
    let path = journal_path(&f);
    let id = {
        let mut hub = lock(&f.state.hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(ROOM, 1));
        hub.disconnect(ROOM, DisconnectReason::Closed);
        hub.ack(ROOM, 1, Some(CREATED), None);
        hub.draining[ROOM][0].0.close_id.clone().unwrap()
    };
    let old = lock(&f.state.hub).epoch;
    lock(&f.state.hub).epoch += 1;
    let new = old + 1;
    let before = fs::read(path.join(journal::file_name(ROOM, CREATED))).unwrap();
    on_child_event_from(&f.state.hub, f.owners.as_ref(), old, FromChild::Closed { room: ROOM.into(), created_at: Some(CREATED), id: Some(id.clone()) });
    assert_eq!(fs::read(path.join(journal::file_name(ROOM, CREATED))).unwrap(), before, "the restarted-away child's late closed wrote something");
    assert!(lock(&f.state.hub).pending.is_empty(), "the late closed queued a closeack");
    journal::tests::fail_appends(1);
    on_child_event_from(&f.state.hub, f.owners.as_ref(), new, FromChild::Closed { room: ROOM.into(), created_at: Some(CREATED), id: Some(id.clone()) });
    journal::tests::fail_appends(0);
    assert_eq!(record_kinds(&path), ["open", "line", "close", "ack"], "premise: the closeack refused");
    let (next, handed) = launch_wire(&path, Moment::Launch).unwrap();
    let told: Vec<&str> = handed.iter().filter(|line| line["t"] == "disconnect").filter_map(|line| line["id"].as_str()).collect();
    assert_eq!(told, vec![id.as_str()], "the close not told again with its own id");
    assert!(messages_handed(&handed).is_empty(), "an acked line said again");
    lock(&next).closed(ROOM, Some(CREATED), Some(id));
    assert!(journal_names(&path).is_empty(), "the close's ACK after the relaunch did not finish it");
}

// ── r7: a retry never stands one record in for another (Codex r6b P2) ──

/// What the Hub holds for each seq is what the journal holds at it, word for word.
fn held_matches_journal(hub: &Hub, path: &Path) -> Result<(), String> {
    let records = records_in(path);
    let draining = hub.draining.get(ROOM).into_iter().flatten().map(|(feed, _)| feed);
    for line in hub.rooms.get(ROOM).into_iter().chain(draining).flat_map(|feed| feed.unacked.iter()) {
        let ToChild::Message { seq, text, .. } = line else { continue };
        let on_disk: Vec<&serde_json::Value> = records.iter().filter(|record| record["seq"].as_u64() == Some(*seq) && (record["t"] == "line" || record["t"] == "loss")).collect();
        let said = |record: &serde_json::Value| match record["t"].as_str() {
            Some("loss") => loss_text(record["n"].as_u64().unwrap(), record["label"].as_str().unwrap()),
            _ => record["text"].as_str().unwrap().to_string(),
        };
        if on_disk.len() != 1 || said(on_disk[0]) != *text {
            return Err(format!("seq {seq} held as {text:?}, journalled as {:?}", on_disk.iter().map(|record| said(record)).collect::<Vec<_>>()));
        }
    }
    Ok(())
}

/// A gap notice lands and the line after it is refused; the next line is a later seq.
fn gap_landed_line_refused(name: &str) -> (Arc<Mutex<Hub>>, PathBuf) {
    let (hub, path) = quiet_hub(name);
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(ROOM, 1));
        journal::tests::pass_appends(1);
        journal::tests::fail_appends(1);
        assert_eq!(hub.forward(line_in(ROOM, 4)), Forwarded::Blocked);
        journal::tests::pass_appends(0);
        journal::tests::fail_appends(0);
        assert_eq!(records_in(&path).iter().filter(|record| record["t"] == "line").count(), 2, "premise: the notice landed, its line did not");
    }
    (hub, path)
}

/// Codex r6b P2, first repro: the retry with a later seq says the gap the journal says.
#[test]
fn r7_a_retry_after_a_landed_gap_notice_says_what_the_journal_holds() {
    let (hub, path) = gap_landed_line_refused("r7-gap-retry");
    let mut hub = lock(&hub);
    assert_eq!(hub.forward(line_in(ROOM, 5)), Forwarded::Taken);
    held_matches_journal(&hub, &path).unwrap();
    let handed = after_relaunch(&path).unwrap();
    assert_eq!(*messages_handed(&handed).last().unwrap(), 5, "{handed:?}");
}

/// Codex r6b P2, second repro: a quit after that partial write states its loss, and the next
/// launch says it.
#[test]
fn r7_a_quit_after_a_landed_gap_notice_still_states_its_loss() {
    let (hub, path) = gap_landed_line_refused("r7-gap-quit");
    {
        let mut hub = lock(&hub);
        hub.lose_unread(ROOM, Some(4));
        hub.disconnect(ROOM, DisconnectReason::Closed);
        held_matches_journal(&hub, &path).unwrap();
    }
    assert_eq!(records_in(&path).iter().filter(|record| record["t"] == "loss").count(), 1, "the quit's loss not journalled: {:?}", records_in(&path));
    let handed = after_relaunch(&path).unwrap();
    let texts: Vec<&str> = handed.iter().filter(|line| line["t"] == "message").filter_map(|line| line["text"].as_str()).collect();
    assert!(texts.iter().any(|text| text.contains("unread when Gyredeck quit")), "relaunch says no loss: {texts:?}");
}

/// The one appender: the very record a refused sync left written is found and not written
/// again; any other record at a seq the file holds is refused, never taken for written.
#[test]
fn r7_a_different_record_at_a_written_seq_is_refused_never_skipped() {
    let (hub, path) = quiet_hub("r7-append-once");
    let mut hub = lock(&hub);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.forward(line_in(ROOM, 1));
    let file = hub.rooms[ROOM].journal.clone().unwrap();
    let same = line_record(&line_in(ROOM, 1)).unwrap();
    let other = journal::Record::Loss { seq: 1, n: 3, label: UNREAD_AT_QUIT.into(), through: None };
    assert!(append_once(&file, &same).is_ok(), "the same record must be found written");
    assert!(append_once(&file, &other).is_err(), "another record at seq 1 was taken for written");
    assert_eq!(records_in(&path).len(), 2, "nothing more written: {:?}", records_in(&path));
}

// ── r8: a feed that joins an instance already journalled starts where the journal stands ──

#[derive(Clone, Copy, Debug)]
enum Rejoin {
    /// The app relaunched; the bridge outlived it and replays from the relay's old floor.
    RelaunchBridgeAlive,
    /// The app relaunched with a fresh bridge: the old instance is gone, a new one starts.
    RelaunchFreshBridge,
    /// The child restarted within one app life.
    ChildRestart,
    /// Disconnect, then Connect of the same instance within one life, by either reason.
    Reconnect(DisconnectReason),
}

/// One path through which a feed's in-memory position is lost, then the bridge replays what it
/// already sent and one new line: the replay is passed over (never Blocked, never journalled
/// again), the new line is taken, and the next child is handed each line once.
fn rejoin_case(path: Rejoin) -> Result<(), String> {
    let (hub, dir) = quiet_hub(&format!("r8-{path:?}"));
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(ROOM, 1));
        hub.forward(line_in(ROOM, 2));
        hub.forward(line_in(ROOM, 5));
        hub.ack(ROOM, 1, Some(CREATED), Some("900000000000000001".into()));
    }
    let (hub, created) = match path {
        Rejoin::RelaunchBridgeAlive | Rejoin::RelaunchFreshBridge => {
            drop(hub);
            let (next, _) = launch_wire(&dir, Moment::Launch)?;
            let created = if matches!(path, Rejoin::RelaunchFreshBridge) { CREATED + 1 } else { CREATED };
            lock(&next).connect(ROOM, vec![], Some(created)).map_err(|error| error.to_string())?;
            (next, created)
        }
        Rejoin::ChildRestart => {
            quiet_attach(&mut lock(&hub));
            (hub, CREATED)
        }
        Rejoin::Reconnect(reason) => {
            {
                let mut hub = lock(&hub);
                hub.disconnect(ROOM, reason);
                hub.connect(ROOM, vec![], Some(CREATED)).map_err(|error| error.to_string())?;
            }
            (hub, CREATED)
        }
    };
    let mut hub = lock(&hub);
    let held = hub.rooms[ROOM].journal.as_ref().map_or(0, |file| file.written_through());
    check(hub.rooms[ROOM].last_seq >= held, &format!("the reader would open the bridge from {} with the journal holding {held}", hub.rooms[ROOM].last_seq))?;
    if created == CREATED {
        check(hub.rooms[ROOM].acked == 1, &format!("the feed forgot what Discord took: acked {}", hub.rooms[ROOM].acked))?;
    }
    let replay: Vec<u64> = if created == CREATED { vec![1, 2, 5] } else { vec![] };
    for seq in replay {
        let taken = hub.forward(line_in(ROOM, seq));
        check(taken == Forwarded::Ignored, &format!("the bridge's replay of seq {seq} was {taken:?}, not passed over"))?;
    }
    let new = if created == CREATED { 6 } else { 1 };
    let taken = hub.forward(line_in(ROOM, new));
    check(taken == Forwarded::Taken, &format!("the new line {new} was {taken:?}"))?;
    let name = journal::file_name(ROOM, created);
    let seqs: Vec<u64> = fs::read_to_string(dir.join(&name)).unwrap().lines().map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()).filter(|record| record["t"] == "line").filter_map(|record| record["seq"].as_u64()).collect();
    let expect: Vec<u64> = if created == CREATED { vec![1, 2, 3, 5, 6] } else { vec![1] };
    check(seqs == expect, &format!("journalled {seqs:?}, expected {expect:?}"))?;
    held_matches_journal(&hub, &dir)?;
    quiet_attach(&mut hub);
    let handed = wire(&mut hub);
    let mut said = messages_handed(&handed);
    let total = said.len();
    said.sort_unstable();
    said.dedup();
    check(said.len() == total, &format!("a line handed twice to one child: {:?}", messages_handed(&handed)))?;
    check(said.contains(&new), "the new line never handed")?;
    if created == CREATED {
        let resume = handed.iter().filter(|line| line["t"] == "connect").map(|line| line["resume"]["lastAcked"].clone()).collect::<Vec<_>>();
        check(resume.iter().all(|acked| *acked == serde_json::json!(1)), &format!("an attach forgot the ACK watermark: {resume:?}"))?;
    }
    Ok(())
}

/// Codex r7 P2 and its class: every path that loses a feed's in-memory position — a relaunch
/// with the bridge alive or fresh, a child restart, a Disconnect/Connect for either reason —
/// still passes over the bridge's replay and reaches the next new line (liveness) without
/// journalling or handing any line twice (safety).
#[test]
fn r8_every_rejoin_passes_over_the_replay_and_reaches_a_new_line() {
    let mut failed = Vec::new();
    for path in [
        Rejoin::RelaunchBridgeAlive,
        Rejoin::RelaunchFreshBridge,
        Rejoin::ChildRestart,
        Rejoin::Reconnect(DisconnectReason::Disconnected),
        Rejoin::Reconnect(DisconnectReason::Closed),
    ] {
        let outcome = std::panic::catch_unwind(|| rejoin_case(path)).unwrap_or_else(|_| Err("panicked".to_string()));
        no_faults();
        if let Err(why) = outcome {
            failed.push(format!("{path:?}: {why}"));
        }
    }
    assert!(failed.is_empty(), "{failed:#?}");
}

/// Codex r7 P2 through the real reader: the app crashes, the bridge outlives it and still has
/// the relay's old floor; after relaunch the same instance is followed again. The reader opens
/// from what the journal holds and reaches the new line, instead of reopening from zero.
#[test]
fn r8_a_relaunch_with_the_bridge_alive_reaches_the_next_new_line() {
    let f = fixture("r8-reader-relaunch", Some(TOKEN));
    let _first = f.attach_buffer();
    log_of(&f, ROOM, 1..=3);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("three journalled", || lock(&f.state.hub).rooms.get(ROOM).is_some_and(|feed| feed.last_seq == 3));
    // The crash: the readers stop where they are, nothing is closed or counted.
    f.state.stop_readers();
    log_of(&f, ROOM, 1..=4);
    f.source.sinces.lock().unwrap().clear();
    let next = relaunch(&f);
    let buffer = SharedBuf::default();
    next.configured.store(true, Ordering::SeqCst);
    {
        let mut hub = lock(&next.hub);
        hub.attach(ChildChannel::new(Box::new(buffer.clone())), BotToken::parse(TOKEN).unwrap(), String::new());
        hub.ready = true;
        hub.forum_id = Some("223456789012345678".into());
    }
    next.connect(ROOM, APP_WORD).unwrap();
    wait_until("the new line 4", || message_seqs(&buffer).contains(&4));
    let sinces = f.source.sinces.lock().unwrap().clone();
    assert!(!sinces.contains(&0), "the reader opened the bridge from zero: {sinces:?}");
    let mut seqs = message_seqs(&buffer);
    let total = seqs.len();
    seqs.sort_unstable();
    seqs.dedup();
    assert_eq!(seqs.len(), total, "a line handed twice: {:?}", message_seqs(&buffer));
    next.stop_readers();
}

#[test]
fn auditor_r8_relaunch_does_not_count_the_same_gap_twice() {
    let (hub, path) = gap_landed_line_refused("auditor-r8-gap-relaunch");
    let before: Vec<String> = records_in(&path).iter()
        .filter(|record| record["t"] == "line" && record["kind"] == "notice")
        .filter_map(|record| record["text"].as_str().map(str::to_string)).collect();
    assert_eq!(before.len(), 1, "premise: exactly one gap notice landed: {before:?}");
    drop(hub);
    let (next, _) = launch_wire(&path, Moment::Launch).unwrap();
    let mut hub = lock(&next);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    let outcome = hub.forward(line_in(ROOM, 4));
    assert_eq!(outcome, Forwarded::Taken, "the new line must be accepted");
    let after: Vec<String> = records_in(&path).iter()
        .filter(|record| record["t"] == "line" && record["kind"] == "notice")
        .filter_map(|record| record["text"].as_str().map(str::to_string)).collect();
    assert_eq!(after, before, "recovery counted the same missing seq a second time");
}

#[test]
fn auditor_r8_recovered_position_needs_a_real_sync_before_open() {
    let (hub, path) = quiet_hub("auditor-r8-recovered-sync");
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        assert_eq!(hub.forward(line_in(ROOM, 1)), Forwarded::Taken);
        hub.disconnect(ROOM, DisconnectReason::Closed);
        let file = hub.draining[ROOM][0].0.journal.as_ref().unwrap();
        assert_eq!(file.written_through(), 1);
        assert_eq!(file.synced_through(), 0, "premise: no full sync before crash");
    }
    drop(hub);
    let next = quiet_recovered(&path);
    let mut hub = lock(&next);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    let feed = &hub.rooms[ROOM];
    assert_eq!(feed.last_seq, 1, "premise: r8 will open the bridge at recovered seq 1");
    let file = feed.journal.as_ref().unwrap();
    file.fail_next_syncs(1);
    assert!(file.sync().is_err(), "recovered unsynced bytes were counted as durable before opening the bridge at seq 1");
}

/// r9 sweep: every record that accounts for seqs past its own — a dropped-prefix notice, an
/// unfollowed-gap notice from a reconnect, a quit's loss — is resumed past after a relaunch onto
/// the same instance, so the next line says no second gap over what was already counted.
#[test]
fn r9_every_reaching_record_is_resumed_past_after_a_relaunch() {
    let said = |path: &Path| -> Vec<String> {
        records_in(path)
            .iter()
            .filter(|record| record["t"] == "loss" || (record["t"] == "line" && record["kind"] == "notice"))
            .map(|record| record.to_string())
            .collect()
    };
    type Setup = fn(&mut Hub);
    let cases: [(&str, Setup, Setup, u64); 3] = [
        ("dropped", |hub| assert_eq!(hub.on_dropped(ROOM, 5, 0), Forwarded::Taken), |hub| {
            hub.on_dropped(ROOM, 5, 0);
        }, 6),
        ("unfollowed", |hub| {
            for seq in 1..=3 {
                assert_eq!(hub.forward(line_in(ROOM, seq)), Forwarded::Taken);
            }
            hub.disconnect(ROOM, DisconnectReason::Disconnected);
            hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
            assert_eq!(hub.on_dropped(ROOM, 0, 6), Forwarded::Taken);
        }, |hub| {
            hub.on_dropped(ROOM, 0, 6);
        }, 7),
        ("quit loss", |hub| {
            for seq in 1..=3 {
                assert_eq!(hub.forward(line_in(ROOM, seq)), Forwarded::Taken);
            }
            hub.lose_unread(ROOM, Some(8));
        }, |_| {}, 9),
    ];
    let mut recounted = Vec::new();
    for (name, before, reopen, next) in cases {
        let (hub, path) = quiet_hub(&format!("r9-reach-{}", name.replace(' ', "-")));
        {
            let mut hub = lock(&hub);
            hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
            before(&mut hub);
        }
        let counted = said(&path);
        assert_eq!(counted.len(), 1, "{name}: premise, one record says the reach: {counted:?}");
        drop(hub);
        let (relaunched, _) = launch_wire(&path, Moment::Launch).unwrap();
        let mut hub = lock(&relaunched);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        reopen(&mut hub);
        assert_eq!(hub.forward(line_in(ROOM, next)), Forwarded::Taken, "{name}: the next line is taken");
        if said(&path) != counted {
            recounted.push(format!("{name}: {:?}", said(&path)));
        }
    }
    assert!(recounted.is_empty(), "what was already counted was counted again: {recounted:?}");
}

/// Codex's r9 audit test: a compaction that drops every acknowledged line keeps how far the
/// room was accounted for, so a rejoin passes over the bridge's replay and takes the next line.
#[test]
fn r9_a_rejoin_after_a_compacted_ack_passes_over_the_replay() {
    let (hub, path) = quiet_hub("r9-compacted-ack-replay");
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        for seq in 1..=50 {
            assert_eq!(hub.forward(line_in(ROOM, seq)), Forwarded::Taken);
        }
        let file = hub.rooms[ROOM].journal.as_ref().unwrap();
        file.append(&journal::Record::Ack { seq: 50, msg: None }).unwrap();
        assert!(file.compact().unwrap(), "premise: all acked lines compact away");
        let parsed = file.reload().unwrap();
        assert_eq!(parsed.acked, 50);
        assert_eq!(parsed.last_seq, 0, "premise: compacted file has no line records");
    }
    drop(hub);
    let (next, _) = launch_wire(&path, Moment::Launch).unwrap();
    let mut hub = lock(&next);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    assert!(hub.rooms[ROOM].last_seq.max(hub.rooms[ROOM].skip) >= 50, "rejoin forgot the compacted ACK watermark");
    assert_eq!(hub.forward(line_in(ROOM, 1)), Forwarded::Ignored, "old replay was taken again");
    assert_eq!(hub.forward(line_in(ROOM, 51)), Forwarded::Taken, "new line did not progress");
    assert!(hub.rooms[ROOM].journal.as_ref().unwrap().reload().is_ok(), "old replay corrupted the compacted journal");
}

// ── stand-in r9 audit (Claude, 2026-11-01): audit-only tests ──

/// S1: a launch whose fallback loss the journal refuses once, the same instance reconnected
/// (bridge alive) before the loss lands. Once the disk works, the replay of a seq the loss
/// counted is passed over and the next new line is taken.
#[test]
fn standin_r9_reconnect_before_a_held_fallback_loss_lands_still_reaches_new_lines() {
    let path = journal_with_fallback("standin-r9-fallback-reconnect");
    journal::tests::fail_appends(1);
    let next = quiet_recovered(&path);
    let mut hub = lock(&next);
    assert!(!hub.pending.is_empty(), "premise: the fallback's loss waits for the journal");
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    hub.flush_pending();
    assert!(hub.pending.is_empty(), "premise: the disk works again and the loss is in");
    assert_eq!(record_kinds(&path), ["open", "line", "loss", "close"], "premise");
    // The reader reopens at since = 1 and the bridge replays 2, 3, 4, 5 on every open.
    let outcomes: Vec<Forwarded> = (0..3).flat_map(|_| [hub.forward(line_in(ROOM, 2)), hub.forward(line_in(ROOM, 5))]).collect();
    assert_eq!(
        outcomes,
        vec![Forwarded::Ignored, Forwarded::Taken, Forwarded::Ignored, Forwarded::Ignored, Forwarded::Ignored, Forwarded::Ignored],
        "the replay of a seq the loss counted, and the first new line, are refused on every reopen: {:?}",
        hub.journal_errors.get(ROOM).map(|error| error.message.clone())
    );
}

/// S2: a fallback loss already in the journal, written by a life whose sync then failed, is
/// let go at launch only after this life has synced the journal (r9: recovered bytes count as
/// unsynced).
#[test]
fn standin_r9_a_merged_fallback_is_not_dropped_before_the_journal_is_synced() {
    let (hub, path) = journal_hub("standin-r9-fallback-unsynced");
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(line_in(ROOM, 1));
        let file = hub.rooms[ROOM].journal.clone().unwrap();
        file.fail_next(QUIT_LOSS_TRIES);
        hub.lose_unread(ROOM, Some(4));
        assert!(path.join(format!("{ROOM}@{CREATED}.loss")).exists(), "premise: fallback written");
        file.fail_next_syncs(1);
        hub.disconnect(ROOM, DisconnectReason::Closed);
        assert_eq!(record_kinds(&path), ["open", "line", "loss"], "premise: the loss is appended, its sync failed");
        assert!(!hub.pending.is_empty(), "premise: still pending for its sync");
    }
    drop(hub);
    journal::tests::fail_syncs(100);
    let next = recovered_hub(&path, 10);
    journal::tests::fail_syncs(0);
    drop(next);
    assert!(
        path.join(format!("{ROOM}@{CREATED}.loss")).exists(),
        "the durable fallback was unlinked while the only other copy of the loss sits in journal bytes no sync of this life covered"
    );
}

/// S3: Disconnect, then Connect of the same instance after its journal finished, then a crash
/// before the reader's first open: at the relaunch (bridge alive) the lines that went by
/// unfollowed are still said, as they are within one life.
#[test]
fn standin_r9_a_recreated_journal_keeps_the_resume_gap_across_a_crash() {
    let (hub, path) = quiet_hub("standin-r9-recreated");
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        for seq in 1..=3 {
            assert_eq!(hub.forward(line_in(ROOM, seq)), Forwarded::Taken);
        }
        hub.ack(ROOM, 3, Some(CREATED), Some("900000000000000003".into()));
        hub.disconnect(ROOM, DisconnectReason::Disconnected);
        let id = hub.draining[ROOM][0].0.close_id.clone().unwrap();
        hub.closed(ROOM, Some(CREATED), Some(id));
        assert!(journal_names(&path).is_empty(), "premise: the journal finished");
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        assert_eq!(hub.rooms[ROOM].last_seq, 3, "premise: in this life the reconnect resumes at 3");
    }
    drop(hub);
    let next = quiet_recovered(&path);
    let mut hub = lock(&next);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    // The bridge's first frame: the relay rejoined at 10, so 4-10 went by unfollowed.
    hub.on_dropped(ROOM, 0, 10);
    let notices: Vec<String> = records_in(&path).iter()
        .filter(|record| record["t"] == "line" && record["kind"] == "notice")
        .filter_map(|record| record["text"].as_str().map(str::to_string)).collect();
    assert_eq!(notices, vec!["7 lines went by unfollowed".to_string()], "the resume gap 4-10 was dropped in silence");
}

#[test]
fn auditor_r9_refused_reconnect_header_keeps_the_resume_gap() {
    let (hub, path) = quiet_hub("auditor-r9-refused-header-resume");
    {
        let mut hub = lock(&hub);
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        for seq in 1..=3 {
            assert_eq!(hub.forward(line_in(ROOM, seq)), Forwarded::Taken);
        }
        hub.ack(ROOM, 3, Some(CREATED), Some("900000000000000003".into()));
        hub.disconnect(ROOM, DisconnectReason::Disconnected);
        let id = hub.draining[ROOM][0].0.close_id.clone().unwrap();
        hub.closed(ROOM, Some(CREATED), Some(id));
        assert!(journal_names(&path).is_empty(), "premise: earlier file finished");
        journal::tests::fail_appends(1);
        assert!(hub.connect(ROOM, vec![], Some(CREATED)).is_err(), "premise: header append refused");
        journal::tests::fail_appends(0);
        assert!(journal_names(&path).is_empty(), "failed header file was discarded");
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        assert_eq!(hub.rooms[ROOM].seen_through(), 3, "a refused header consumed the resume position");
    }
    drop(hub);
    let next = quiet_recovered(&path);
    let mut hub = lock(&next);
    hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
    assert_eq!(hub.on_dropped(ROOM, 0, 10), Forwarded::Taken);
    let notices: Vec<String> = records_in(&path).iter()
        .filter(|record| record["t"] == "line" && record["kind"] == "notice")
        .filter_map(|record| record["text"].as_str().map(str::to_string)).collect();
    assert_eq!(notices, vec!["7 lines went by unfollowed".to_string()], "the gap after a refused header was lost");
}

/// #182 in Discord: a line is posted under the name the room showed when it was said, so a name
/// declared after Connect shows there, and a line addressed to that member names it so too;
/// a line said before the declaration keeps the name it had.
#[test]
fn a_declared_name_is_the_poster_and_the_recipient_from_the_line_it_rides_on() {
    let f = fixture("declared-name", Some(TOKEN));
    let buffer = f.attach_buffer();
    let relay = relay_member(ROOM);
    f.members(ROOM, &[("founder-1", "Claude Code"), ("peer-a", "Codex"), (relay.as_str(), "Discord")]);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("a first open", || !f.source.opens.lock().unwrap().is_empty());
    let with = |seq: u64, from: &str, to: &str, text: &str, shown: &str| {
        let mut line = mail(seq, from, to, "tell", text);
        line["fromShown"] = serde_json::json!(shown);
        line
    };
    f.stream(ROOM, &[with(1, "peer-a", "everyone", "before the name", "Codex")]);
    wait_until("the first message", || of_kind(&buffer.lines(), "message").len() == 1);
    // Both declare; the roster says so from now on.
    f.members(ROOM, &[("founder-1", "Claude Code / Gyre Assistant"), ("peer-a", "Codex / Gyre Audit"), (relay.as_str(), "Discord")]);
    f.stream(ROOM, &[
        with(2, "peer-a", "everyone", "with the name", "Codex / Gyre Audit"),
        with(3, "founder-1", "peer-a", "to the named one", "Claude Code / Gyre Assistant"),
    ]);
    wait_until("three messages", || of_kind(&buffer.lines(), "message").len() == 3);
    let named: Vec<(String, String)> = of_kind(&buffer.lines(), "message")
        .iter()
        .map(|m| (m["sender"].as_str().unwrap().into(), m["to"].as_str().unwrap().into()))
        .collect();
    assert_eq!(
        named,
        vec![
            ("Codex".into(), "everyone".into()),
            ("Codex / Gyre Audit".into(), "everyone".into()),
            ("Claude Code / Gyre Assistant".into(), "Codex / Gyre Audit".into()),
        ]
    );
}

#[test]
fn auditor_old_sender_snapshot_must_not_rename_a_current_recipient() {
    let f = fixture("old-sender-snapshot", Some(TOKEN));
    let buffer = f.attach_buffer();
    let relay = relay_member(ROOM);
    // The name was already declared when Discord joins; backlog still contains an older line.
    f.members(ROOM, &[("founder-1", "Claude Code"), ("peer-a", "Codex / Gyre Audit"), (relay.as_str(), "Discord")]);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("a first open", || !f.source.opens.lock().unwrap().is_empty());
    let mut old = mail(1, "peer-a", "everyone", "tell", "before name");
    old["fromShown"] = serde_json::json!("Codex");
    let mut new = mail(2, "founder-1", "peer-a", "tell", "to named one");
    new["fromShown"] = serde_json::json!("Claude Code");
    f.stream(ROOM, &[old, new]);
    wait_until("two messages", || of_kind(&buffer.lines(), "message").len() == 2);
    let lines = buffer.lines();
    let named = of_kind(&lines, "message");
    assert_eq!(named[0]["sender"], "Codex", "the old sender snapshot must remain old");
    assert_eq!(named[1]["to"], "Codex / Gyre Audit", "an old sender snapshot must not replace the current recipient name");
}

#[test]
fn auditor_a_failed_name_refresh_must_retry_for_the_next_line() {
    let f = fixture("failed-name-refresh", Some(TOKEN));
    let buffer = f.attach_buffer();
    let relay = relay_member(ROOM);
    f.members(ROOM, &[("founder-1", "Claude Code"), ("peer-a", "Codex"), (relay.as_str(), "Discord")]);
    f.state.connect(ROOM, APP_WORD).unwrap();
    wait_until("a first open", || !f.source.opens.lock().unwrap().is_empty());
    f.members(ROOM, &[("founder-1", "Claude Code"), ("peer-a", "Codex / Gyre Audit"), (relay.as_str(), "Discord")]);
    f.source.roster_fails.store(true, Ordering::SeqCst);
    let mut named = mail(1, "peer-a", "everyone", "tell", "my new name");
    named["fromShown"] = serde_json::json!("Codex / Gyre Audit");
    f.stream(ROOM, &[named]);
    wait_until("first message", || of_kind(&buffer.lines(), "message").len() == 1);
    f.source.roster_fails.store(false, Ordering::SeqCst);
    let mut to_named = mail(2, "founder-1", "peer-a", "tell", "to your new name");
    to_named["fromShown"] = serde_json::json!("Claude Code");
    f.stream(ROOM, &[to_named]);
    wait_until("second message", || of_kind(&buffer.lines(), "message").len() == 2);
    let lines = buffer.lines();
    let messages = of_kind(&lines, "message");
    assert_eq!(messages[0]["sender"], "Codex / Gyre Audit");
    assert_eq!(messages[1]["to"], "Codex / Gyre Audit", "a failed roster read must not permanently mark this name checked");
}
