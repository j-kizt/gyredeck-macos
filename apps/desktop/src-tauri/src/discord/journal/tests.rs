use super::*;
use std::{
    cell::RefCell,
    io::{BufRead, BufReader},
    os::unix::{
        fs::{symlink, PermissionsExt},
        process::ExitStatusExt,
    },
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const ROOM: &str = "sync-ab23";
const CREATED: u64 = 1_761_559_200_000;
const HELPER: &str = "discord::journal::tests::crash_helper";

thread_local! {
    static FORCED_TEMP: RefCell<Option<String>> = const { RefCell::new(None) };
}

pub(super) fn forced_temp_hex() -> Option<String> {
    FORCED_TEMP.with(|forced| forced.borrow().clone())
}

static HITS: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    /// Every boundary this thread passed, in order: what a kill cannot see (a sync) can be.
    static EVENTS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    static FAIL_DIR_SYNC: RefCell<bool> = const { RefCell::new(false) };
}

thread_local! {
    static OPENED: RefCell<usize> = const { RefCell::new(0) };
}

pub(super) fn count_open() {
    OPENED.with(|opened| *opened.borrow_mut() += 1);
}

/// How many journals this thread has opened and parsed since the last call.
pub(crate) fn opened() -> usize {
    OPENED.with(|opened| std::mem::take(&mut *opened.borrow_mut()))
}

thread_local! {
    static FAIL_LOSS_WRITE: RefCell<bool> = const { RefCell::new(false) };
}

pub(super) fn fail_loss_write() -> bool {
    FAIL_LOSS_WRITE.with(|fail| *fail.borrow())
}

pub(crate) fn set_fail_loss_write(fail: bool) {
    FAIL_LOSS_WRITE.with(|cell| *cell.borrow_mut() = fail);
}

thread_local! {
    static FAIL_APPENDS: RefCell<u32> = const { RefCell::new(0) };
}

/// The next `count` appends on this thread fail, whatever file they go to.
pub(crate) fn fail_appends(count: u32) {
    FAIL_APPENDS.with(|cell| *cell.borrow_mut() = count);
}

thread_local! {
    static PASS_APPENDS: RefCell<u32> = const { RefCell::new(0) };
}

/// The next `count` appends on this thread go through before any injected fault applies.
pub(crate) fn pass_appends(count: u32) {
    PASS_APPENDS.with(|cell| *cell.borrow_mut() = count);
}

/// Whether this append is one `pass_appends` lets through; counted once per append.
fn passing() -> bool {
    PASS_APPENDS.with(|cell| {
        let mut left = cell.borrow_mut();
        let pass = *left > 0;
        *left = left.saturating_sub(1);
        pass
    })
}

pub(super) fn fault_free() -> bool {
    passing()
}

pub(super) fn fail_append() -> bool {
    FAIL_APPENDS.with(|cell| {
        let mut left = cell.borrow_mut();
        let fail = *left > 0;
        *left = left.saturating_sub(1);
        fail
    })
}

thread_local! {
    static SHORT_APPENDS: RefCell<u32> = const { RefCell::new(0) };
    static FAIL_SYNCS: RefCell<u32> = const { RefCell::new(0) };
}

/// The next `count` appends on this thread write half their record, then fail as a full disk
/// does (ENOSPC), whatever file they go to.
pub(crate) fn short_appends(count: u32) {
    SHORT_APPENDS.with(|cell| *cell.borrow_mut() = count);
}

pub(super) fn short_append() -> bool {
    SHORT_APPENDS.with(|cell| {
        let mut left = cell.borrow_mut();
        let short = *left > 0;
        *left = left.saturating_sub(1);
        short
    })
}

/// The next `count` journal syncs on this thread fail, whatever file they go to.
pub(crate) fn fail_syncs(count: u32) {
    FAIL_SYNCS.with(|cell| *cell.borrow_mut() = count);
}

pub(super) fn fail_sync() -> bool {
    FAIL_SYNCS.with(|cell| {
        let mut left = cell.borrow_mut();
        let fail = *left > 0;
        *left = left.saturating_sub(1);
        fail
    })
}

pub(super) fn fail_dir_sync() -> bool {
    FAIL_DIR_SYNC.with(|fail| *fail.borrow())
}

fn events() -> Vec<String> {
    EVENTS.with(|events| std::mem::take(&mut *events.borrow_mut()))
}

/// In the helper process only: at the named boundary (its Nth time), say so and wait to be
/// killed by the parent. Every other process passes straight through.
pub(crate) fn at_point(name: &str) {
    EVENTS.with(|events| events.borrow_mut().push(name.to_string()));
    if std::env::var("GYREDECK_JOURNAL_KILL_AT").as_deref() != Ok(name) {
        return;
    }
    if std::env::var("GYREDECK_JOURNAL_HELPER").is_ok_and(|helper| helper.starts_with("merge") || helper == "close_fail") && std::env::var("GYREDECK_JOURNAL_ARMED").is_err() {
        return;
    }
    let nth: usize = std::env::var("GYREDECK_JOURNAL_KILL_NTH").ok().and_then(|n| n.parse().ok()).unwrap_or(1);
    if HITS.fetch_add(1, Ordering::SeqCst) + 1 != nth {
        return;
    }
    let mut out = io::stdout();
    let _ = writeln!(out, "KILLME {name}");
    let _ = out.flush();
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn scratch(name: &str) -> PathBuf {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("gyredeck-journal-{name}-{}-{unique}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn line(seq: u64) -> Record {
    Record::Line { seq, sender: "Codex".into(), to: "everyone".into(), kind: "tell".into(), text: format!("m{seq}"), ts: "2026-10-27T10:00:00.000Z".into(), through: None }
}

fn item(seq: u64) -> Item {
    match line(seq) {
        Record::Line { seq, sender, to, kind, text, ts, through } => Item::Line { seq, sender, to, kind, text, ts, through },
        _ => unreachable!(),
    }
}

fn open_record() -> Record {
    Record::Open { code: ROOM.into(), created_at: CREATED, members: vec!["Codex".into()], v: VERSION, covered: None }
}

fn bytes_of(records: &[Record]) -> Vec<u8> {
    records.iter().flat_map(line_of).collect()
}

fn name() -> String {
    file_name(ROOM, CREATED)
}

fn seqs(parsed: &Parsed) -> Vec<u64> {
    parsed.batches.iter().flat_map(|batch| batch.items.iter().map(Item::seq)).collect()
}

// ── T3: parsing and corruption (ck2, d20) ──

#[test]
fn a_torn_tail_is_ignored() {
    let mut bytes = bytes_of(&[open_record(), line(1), line(2)]);
    let whole = bytes.len();
    bytes.extend_from_slice(br#"{"t":"line","seq":3,"sen"#);
    let parsed = parse(&name(), &bytes).expect("a torn last write is not corruption");
    assert_eq!(seqs(&parsed), vec![1, 2], "every earlier record stands");
    assert_eq!(parsed.valid_len, whole);
    assert!(parsed.batches[0].close.is_none(), "no close: the tail is the app's end");
}

#[test]
fn a_malformed_middle_record_refuses_the_file_and_says_so() {
    let mut bytes = bytes_of(&[open_record(), line(1)]);
    bytes.extend_from_slice(b"{not json}\n");
    bytes.extend(bytes_of(&[line(2)]));
    let corrupt = parse(&name(), &bytes).unwrap_err();
    assert_eq!(corrupt.line, 3, "{corrupt:?}");
    assert!(corrupt.why.contains("not a record"), "{corrupt:?}");
}

#[test]
fn a_malformed_middle_record_is_left_untouched_on_disk_and_named() {
    let base = scratch("corrupt-disk");
    let dir = Dir::open(&base.join("j")).unwrap();
    let mut bytes = bytes_of(&[open_record(), line(1)]);
    bytes.extend_from_slice(b"garbage\n");
    bytes.extend(bytes_of(&[line(2)]));
    fs::write(base.join("j").join(name()), &bytes).unwrap();
    fs::set_permissions(base.join("j").join(name()), fs::Permissions::from_mode(0o600)).unwrap();
    let (found, refused) = dir.recover();
    assert!(found.is_empty());
    assert_eq!(refused.len(), 1);
    assert_eq!((refused[0].name.as_str(), refused[0].line), (name().as_str(), 3));
    assert_eq!(fs::read(base.join("j").join(name())).unwrap(), bytes, "the corrupt file's bytes are unchanged");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn seq_going_backwards_is_corrupt() {
    let corrupt = parse(&name(), &bytes_of(&[open_record(), line(2), line(1)])).unwrap_err();
    assert_eq!(corrupt.line, 3);
    assert!(corrupt.why.contains("backwards"), "{corrupt:?}");
}

#[test]
fn a_duplicate_line_is_ignored_a_conflicting_one_is_corrupt() {
    let parsed = parse(&name(), &bytes_of(&[open_record(), line(1), line(2), line(1)])).unwrap();
    assert_eq!(seqs(&parsed), vec![1, 2]);
    let other = Record::Line { seq: 1, sender: "Codex".into(), to: "everyone".into(), kind: "tell".into(), text: "different".into(), ts: String::new(), through: None };
    let corrupt = parse(&name(), &bytes_of(&[open_record(), line(1), line(2), other])).unwrap_err();
    assert_eq!(corrupt.line, 4);
    assert!(corrupt.why.contains("different content"), "{corrupt:?}");
}

#[test]
fn closeack_without_close_is_corrupt() {
    let corrupt = parse(&name(), &bytes_of(&[open_record(), line(1), Record::Closeack { id: "c1".into() }])).unwrap_err();
    assert_eq!(corrupt.line, 3);
    let twice = Record::Close { id: "c1".into(), reason: DisconnectReason::Closed, at: 1 };
    assert!(parse(&name(), &bytes_of(&[open_record(), twice.clone(), twice])).is_err(), "a close id is unique");
    assert!(parse(&name(), &bytes_of(&[line(1)])).is_err(), "open comes first");
    assert!(parse(&name(), &bytes_of(&[open_record(), open_record()])).is_err(), "and only once");
    let foreign = Record::Open { code: ROOM.into(), created_at: CREATED + 1, members: vec![], v: VERSION, covered: None };
    assert!(parse(&name(), &bytes_of(&[foreign])).is_err(), "and names the file's own instance");
}

#[test]
fn batches_split_at_each_close_and_acked_ones_go() {
    let close = |id: &str, at| Record::Close { id: id.into(), reason: DisconnectReason::Disconnected, at };
    let parsed = parse(
        &name(),
        &bytes_of(&[
            open_record(),
            line(1),
            line(2),
            close("a", 2),
            Record::Ack { seq: 2, msg: Some("900000000000000001".into()) },
            Record::Closeack { id: "a".into() },
            line(3),
            close("b", 3),
            line(4),
            Record::Loss { seq: 5, n: 2, label: "unread when Gyredeck quit".into(), through: None },
        ]),
    )
    .unwrap();
    assert_eq!(parsed.acked, 2);
    assert_eq!(parsed.last_msg_id.as_deref(), Some("900000000000000001"));
    assert_eq!(parsed.batches.len(), 2, "the acked, closed batch is gone: {parsed:?}");
    assert_eq!(parsed.batches[0].items, vec![item(3)]);
    assert_eq!(parsed.batches[0].close.as_ref().map(|close| close.id.as_str()), Some("b"));
    assert_eq!(parsed.batches[1].items.len(), 2);
    assert!(parsed.batches[1].close.is_none(), "the tail after the last close");
    assert_eq!(parse(&name(), &render(&parsed)).unwrap().batches, parsed.batches, "a compacted file reads back the same");
}

// ── T4: path safety (ck3, d21) ──

#[test]
fn a_symlink_at_the_file_temp_or_dir_is_refused_and_the_target_unchanged() {
    let base = scratch("symlinks");
    let target = base.join("target");
    fs::write(&target, b"the target's own bytes").unwrap();
    let path = base.join("j");
    let dir = Dir::open(&path).unwrap();

    // The file name.
    symlink(&target, path.join(name())).unwrap();
    assert!(dir.create(ROOM, CREATED, &[]).is_err(), "create refuses a planted symlink");
    let (found, refused) = dir.recover();
    assert!(found.is_empty() && refused.len() == 1, "recover refuses it too: {refused:?}");
    assert_eq!(fs::read(&target).unwrap(), b"the target's own bytes");
    fs::remove_file(path.join(name())).unwrap();

    // The compaction temp.
    let file = dir.create(ROOM, CREATED, &[]).unwrap();
    for seq in 1..=50 {
        file.append(&line(seq)).unwrap();
    }
    file.append(&Record::Ack { seq: 49, msg: None }).unwrap();
    let before = fs::read(path.join(name())).unwrap();
    FORCED_TEMP.with(|forced| *forced.borrow_mut() = Some("0123456789abcdef".into()));
    let temp = path.join(format!("{}.0123456789abcdef.tmp", name()));
    symlink(&target, &temp).unwrap();
    assert!(file.compact().is_err(), "compaction refuses a planted temp");
    FORCED_TEMP.with(|forced| *forced.borrow_mut() = None);
    assert_eq!(fs::read(&target).unwrap(), b"the target's own bytes");
    assert!(fs::symlink_metadata(&temp).unwrap().file_type().is_symlink(), "and does not remove what it did not create");
    assert_eq!(fs::read(path.join(name())).unwrap(), before, "the journal is untouched");
    file.append(&line(51)).unwrap();
    // A planted temp at launch is not a regular file, so it is neither followed nor removed.
    let (found, _) = dir.recover();
    assert_eq!(found.len(), 1);
    assert_eq!(fs::read(&target).unwrap(), b"the target's own bytes");

    // The directory.
    let real = base.join("real");
    fs::create_dir(&real).unwrap();
    fs::set_permissions(&real, fs::Permissions::from_mode(0o700)).unwrap();
    symlink(&real, base.join("linked")).unwrap();
    assert!(Dir::open(&base.join("linked")).is_err(), "a symlinked journal directory is refused");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn a_hardlink_is_refused() {
    let base = scratch("hardlink");
    let path = base.join("j");
    let dir = Dir::open(&path).unwrap();
    let outside = base.join("outside.jsonl");
    let bytes = bytes_of(&[open_record(), line(1)]);
    fs::write(&outside, &bytes).unwrap();
    fs::hard_link(&outside, path.join(name())).unwrap();
    let (found, refused) = dir.recover();
    assert!(found.is_empty());
    assert!(refused[0].why.contains("more than one name"), "{refused:?}");
    assert_eq!(fs::read(&outside).unwrap(), bytes);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn a_dir_with_group_bits_is_refused() {
    let base = scratch("group");
    let path = base.join("j");
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
    assert!(Dir::open(&path).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(Dir::open(&path).is_ok(), "premise: the same directory, private, opens");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn every_file_written_is_mode_0600_and_the_dir_0700() {
    let base = scratch("modes");
    let path = base.join("j");
    let dir = Dir::open(&path).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
    let file = dir.create(ROOM, CREATED, &[]).unwrap();
    assert_eq!(fs::metadata(path.join(name())).unwrap().permissions().mode() & 0o777, 0o600);
    for seq in 1..=50 {
        file.append(&line(seq)).unwrap();
    }
    file.append(&Record::Ack { seq: 50, msg: None }).unwrap();
    assert!(file.compact().unwrap(), "premise: compacted");
    assert_eq!(fs::metadata(path.join(name())).unwrap().permissions().mode() & 0o777, 0o600);
    file.append(&line(51)).unwrap();
    let parsed = file.reload().unwrap();
    assert_eq!(seqs(&parsed), vec![51], "appends go to the compacted file");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn a_torn_tail_is_cut_at_recovery_so_the_next_append_stays_whole() {
    let base = scratch("torn-cut");
    let path = base.join("j");
    let dir = Dir::open(&path).unwrap();
    let mut bytes = bytes_of(&[open_record(), line(1)]);
    bytes.extend_from_slice(br#"{"t":"line","se"#);
    fs::write(path.join(name()), &bytes).unwrap();
    fs::set_permissions(path.join(name()), fs::Permissions::from_mode(0o600)).unwrap();
    let (mut found, refused) = dir.recover();
    assert!(refused.is_empty());
    let recovered = found.remove(0);
    recovered.file.append(&line(2)).unwrap();
    assert_eq!(seqs(&recovered.file.reload().expect("still whole")), vec![1, 2]);
    let _ = fs::remove_dir_all(base);
}

// ── T2 and T5: a real process killed at each boundary (ck1, ck12, d3, d24) ──

/// Run in a separate process by the crash tests only; a plain test run passes straight by.
#[test]
#[ignore]
fn crash_helper() {
    let (Ok(scenario), Ok(path)) = (std::env::var("GYREDECK_JOURNAL_HELPER"), std::env::var("GYREDECK_JOURNAL_DIR")) else {
        return;
    };
    if scenario == "close_fail" {
        // A Close write refused once, then retried: Codex r5's case, through a real kill.
        std::env::set_var("GYREDECK_JOURNAL_ARMED", "1");
        let dir = Dir::open(Path::new(&path)).unwrap();
        let mut hub = super::super::Hub { journal_dir: Some(dir), ..Default::default() };
        hub.channel = Some(super::super::ChildChannel::new(Box::new(std::io::sink())));
        hub.connect(ROOM, vec![], Some(CREATED)).unwrap();
        hub.forward(super::super::ToChild::Message { room: ROOM.into(), seq: 1, sender: "Codex".into(), to: "everyone".into(), kind: "tell".into(), text: "m1".into(), ts: String::new() });
        fail_appends(1);
        hub.disconnect(ROOM, DisconnectReason::Closed);
        point("close_pending");
        hub.flush_pending();
        println!("HELPER DONE");
        return;
    }
    let dir = Dir::open(Path::new(&path)).unwrap();
    let file = dir.create(ROOM, CREATED, &["Codex".to_string()]).unwrap();
    match scenario.as_str() {
        "write" => {
            for seq in 1..=5 {
                file.append(&line(seq)).unwrap();
            }
            file.append(&Record::Ack { seq: 2, msg: Some("900000000000000002".into()) }).unwrap();
            file.sync().unwrap();
            for seq in 6..=8 {
                file.append(&line(seq)).unwrap();
            }
            file.sync().unwrap();
        }
        "compact" => {
            for seq in 1..=40 {
                file.append(&line(seq)).unwrap();
            }
            file.append(&Record::Ack { seq: 38, msg: None }).unwrap();
            file.append(&Record::Close { id: "c1".into(), reason: DisconnectReason::Closed, at: 40 }).unwrap();
            file.sync().unwrap();
            assert!(file.compact().unwrap());
        }
        "finish" => {
            file.append(&line(1)).unwrap();
            file.append(&Record::Ack { seq: 1, msg: None }).unwrap();
            file.append(&Record::Close { id: "c1".into(), reason: DisconnectReason::Closed, at: 1 }).unwrap();
            file.append(&Record::Closeack { id: "c1".into() }).unwrap();
            file.sync().unwrap();
            file.finish().unwrap();
        }
        "merge" => {
            // An offline quit whose loss only the fallback took, then the next launch merging
            // it and Discord taking line and loss.
            file.append(&line(1)).unwrap();
            file.sync().unwrap();
            dir.write_loss(ROOM, CREATED, &Record::Loss { seq: 2, n: 3, label: "unread when Gyredeck quit".into(), through: Some(4) }).unwrap();
            drop(file);
            drop(dir);
            HITS.store(0, Ordering::SeqCst);
            std::env::set_var("GYREDECK_JOURNAL_ARMED", "1");
            let dir = Dir::open(Path::new(&path)).unwrap();
            let names = dir.scan().unwrap();
            let mut hub = super::super::Hub { journal_dir: Some(dir), ..Default::default() };
            hub.recover(names);
            point("merge_done");
            hub.ack(ROOM, 2, Some(CREATED), None);
        }
        "merge_fail" => {
            // As "merge", but the next launch's merge write is refused once.
            file.append(&line(1)).unwrap();
            file.sync().unwrap();
            dir.write_loss(ROOM, CREATED, &Record::Loss { seq: 2, n: 3, label: "unread when Gyredeck quit".into(), through: Some(4) }).unwrap();
            drop(file);
            drop(dir);
            HITS.store(0, Ordering::SeqCst);
            std::env::set_var("GYREDECK_JOURNAL_ARMED", "1");
            let dir = Dir::open(Path::new(&path)).unwrap();
            let names = dir.scan().unwrap();
            let mut hub = super::super::Hub { journal_dir: Some(dir), ..Default::default() };
            fail_appends(1);
            hub.recover(names);
            point("held");
            hub.sync_all();
        }
        other => panic!("no scenario {other}"),
    }
    println!("HELPER DONE");
}

/// Spawn the helper on a fresh journal directory and SIGKILL it from here when it reports
/// the boundary. Answers the directory, for recovery.
fn kill_at(scenario: &str, point: &str, nth: usize) -> PathBuf {
    let base = scratch(&format!("crash-{scenario}-{point}-{nth}"));
    let path = base.join("j");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([HELPER, "--exact", "--ignored", "--nocapture", "--test-threads=1"])
        .env("GYREDECK_JOURNAL_HELPER", scenario)
        .env("GYREDECK_JOURNAL_DIR", &path)
        .env("GYREDECK_JOURNAL_KILL_AT", point)
        .env("GYREDECK_JOURNAL_KILL_NTH", nth.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut reached = false;
    for line in BufReader::new(child.stdout.take().unwrap()).lines() {
        let line = line.unwrap();
        if line.contains("KILLME") {
            reached = true;
            break;
        }
        assert!(!line.contains("HELPER DONE"), "the helper finished without reaching {point} #{nth}");
    }
    assert!(reached, "premise: the helper reached {point} #{nth}");
    child.kill().unwrap();
    let status = child.wait().unwrap();
    assert_eq!(status.signal(), Some(libc::SIGKILL), "premise: killed, not exited");
    path
}

fn recover_at(path: &Path) -> (Vec<Recovered>, Vec<Corrupt>, Vec<String>) {
    let dir = Dir::open(path).unwrap();
    let (found, refused) = dir.recover();
    (found, refused, dir.names_for_test())
}

#[test]
fn kill_before_sync_and_after_sync() {
    // (boundary, nth, the seqs still owed: written and above the ACK of 2)
    let cases = [("before_sync", 1, vec![3, 4, 5]), ("after_sync", 1, vec![3, 4, 5]), ("before_sync", 2, vec![3, 4, 5, 6, 7, 8]), ("after_sync", 2, vec![3, 4, 5, 6, 7, 8])];
    for (point, nth, owed) in cases {
        let path = kill_at("write", point, nth);
        let (found, refused, _) = recover_at(&path);
        assert!(refused.is_empty(), "{point} #{nth}: {refused:?}");
        assert_eq!(found.len(), 1, "{point} #{nth}");
        let parsed = &found[0].parsed;
        assert_eq!(parsed.acked, 2, "{point} #{nth}");
        assert_eq!(parsed.last_msg_id.as_deref(), Some("900000000000000002"));
        assert_eq!(seqs(parsed), owed, "{point} #{nth}: every line write(2) returned survives the kill, none acked is replayed");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}

#[test]
fn compaction_crash_boundaries() {
    for point in ["compact_before_temp_sync", "compact_before_rename", "compact_after_rename"] {
        let path = kill_at("compact", point, 1);
        let (found, refused, names) = recover_at(&path);
        assert!(refused.is_empty(), "{point}: {refused:?}");
        assert_eq!(names, vec![name()], "{point}: the old file or the new one, whole, and no temp left behind");
        let parsed = &found[0].parsed;
        assert_eq!(seqs(parsed), vec![39, 40], "{point}: nothing owed is lost");
        assert_eq!(parsed.batches[0].close.as_ref().map(|close| close.id.as_str()), Some("c1"), "{point}: and the close stays");
        assert_eq!(fs::metadata(path.join(name())).unwrap().permissions().mode() & 0o777, 0o600, "{point}");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
    let path = kill_at("finish", "finish_after_unlink", 1);
    let (found, refused, names) = recover_at(&path);
    assert!(found.is_empty() && refused.is_empty() && names.is_empty(), "after the unlink there is nothing to replay: {names:?}");
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

// ── round 2: the deep audit's journal findings ──

/// AUDIT-R1: a write the disk cut short leaves no partial record for the next one to join.
#[test]
fn a_short_write_is_cut_back_so_later_records_stay_whole_and_the_journal_recovers() {
    let base = scratch("short-write");
    let path = base.join("j");
    let dir = Dir::open(&path).unwrap();
    let file = dir.create(ROOM, CREATED, &[]).unwrap();
    file.append(&line(1)).unwrap();
    file.short_writes(true);
    assert!(file.append(&line(2)).is_err(), "premise: the disk took half of line 2 and refused the rest");
    file.short_writes(false);
    file.append(&Record::Ack { seq: 1, msg: None }).unwrap();
    file.append(&Record::Close { id: "c1".into(), reason: DisconnectReason::Closed, at: 1 }).unwrap();
    let (found, refused) = Dir::open(&path).unwrap().recover();
    assert!(refused.is_empty(), "the next launch replays it: {refused:?}");
    assert_eq!(found[0].parsed.batches.len(), 1);
    assert_eq!(found[0].parsed.batches[0].close.as_ref().map(|close| close.id.as_str()), Some("c1"), "the close after the failed write stands");
    let _ = fs::remove_dir_all(base);
}

/// AUDIT-R2: a crash after the last closeack was synced and before the unlink.
#[test]
fn a_done_journal_left_by_a_crash_is_deleted_at_recovery() {
    let base = scratch("done-left");
    let path = base.join("j");
    let dir = Dir::open(&path).unwrap();
    let file = dir.create(ROOM, CREATED, &[]).unwrap();
    for record in [line(1), Record::Ack { seq: 1, msg: None }, Record::Close { id: "c1".into(), reason: DisconnectReason::Closed, at: 1 }, Record::Closeack { id: "c1".into() }] {
        file.append(&record).unwrap();
    }
    file.sync().unwrap();
    let (found, refused) = Dir::open(&path).unwrap().recover();
    assert!(found.is_empty() && refused.is_empty());
    assert!(dir.names_for_test().is_empty(), "nothing owed and its close acknowledged: deleted");
    let _ = fs::remove_dir_all(base);
}

/// A directory sync that fails after the rename: the name holds the new file, so later
/// lines must go to it, not to the unlinked old one.
#[test]
fn a_failed_dir_sync_after_the_rename_still_writes_to_the_new_file() {
    let base = scratch("dirsync-fail");
    let path = base.join("j");
    let dir = Dir::open(&path).unwrap();
    let file = dir.create(ROOM, CREATED, &[]).unwrap();
    for seq in 1..=50 {
        file.append(&line(seq)).unwrap();
    }
    file.append(&Record::Ack { seq: 50, msg: None }).unwrap();
    FAIL_DIR_SYNC.with(|fail| *fail.borrow_mut() = true);
    let compacted = file.compact();
    FAIL_DIR_SYNC.with(|fail| *fail.borrow_mut() = false);
    assert!(compacted.is_err(), "premise: the directory sync failed");
    file.append(&line(51)).unwrap();
    let on_disk = parse(&name(), &fs::read(path.join(name())).unwrap()).unwrap();
    assert_eq!(seqs(&on_disk), vec![51], "line 51 is in the file the name holds");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn compaction_keeps_an_acknowledged_close() {
    let parsed = parse(
        &name(),
        &bytes_of(&[
            open_record(),
            line(1),
            line(2),
            Record::Close { id: "a".into(), reason: DisconnectReason::Closed, at: 2 },
            Record::Closeack { id: "a".into() },
            Record::Ack { seq: 1, msg: None },
        ]),
    )
    .unwrap();
    assert_eq!(parsed.batches[0].close.as_ref().map(|close| close.acked), Some(true), "premise: line 2 owed, its close acknowledged");
    let again = parse(&name(), &render(&parsed)).unwrap();
    assert_eq!(again.batches, parsed.batches, "the closeack survives compaction");
}

/// AUDIT-C: an ACK with no id moves the watermark, never the anchor.
#[test]
fn a_dedupe_ack_never_moves_the_anchor() {
    let parsed = parse(
        &name(),
        &bytes_of(&[open_record(), line(1), line(2), Record::Ack { seq: 1, msg: Some("900000000000000001".into()) }, Record::Ack { seq: 2, msg: None }]),
    )
    .unwrap();
    assert_eq!((parsed.acked, parsed.anchor_seq, parsed.last_msg_id.as_deref()), (2, 1, Some("900000000000000001")));
    let again = parse(&name(), &render(&parsed)).unwrap();
    assert_eq!((again.acked, again.anchor_seq, again.last_msg_id), (2, 1, parsed.last_msg_id), "nor does compaction re-pair the id with a later seq");
    let late = parse(&name(), &bytes_of(&[open_record(), Record::Ack { seq: 3, msg: Some("900000000000000003".into()) }, Record::Ack { seq: 2, msg: Some("900000000000000002".into()) }])).unwrap();
    assert_eq!(late.last_msg_id.as_deref(), Some("900000000000000003"), "a late ACK never makes it older");
}

/// What a kill cannot show: the temp is fully synced before the rename, and the directory
/// after it.
#[test]
fn compaction_syncs_the_temp_before_the_rename_and_the_dir_after() {
    let base = scratch("compact-order");
    let path = base.join("j");
    let dir = Dir::open(&path).unwrap();
    let file = dir.create(ROOM, CREATED, &[]).unwrap();
    for seq in 1..=50 {
        file.append(&line(seq)).unwrap();
    }
    file.append(&Record::Ack { seq: 50, msg: None }).unwrap();
    events();
    assert!(file.compact().unwrap());
    let seen: Vec<String> = events().into_iter().filter(|event| event != "appended").collect();
    assert_eq!(seen, ["compact_before_temp_sync", "full_sync", "compact_before_rename", "renamed", "compact_after_rename", "dir_sync"]);
    let _ = fs::remove_dir_all(base);
}

// ── r2: Codex's independent pass ──

/// Codex r1 finding 3: an ACK past every line this file recorded is impossible, and refused.
#[test]
fn auditor_future_ack_is_refused_without_deleting_unposted_line() {
    let bytes = bytes_of(&[open_record(), line(1), Record::Ack { seq: 999, msg: None }]);
    let result = parse(&name(), &bytes);
    assert!(result.is_err(), "an ACK beyond every recorded line must not erase line 1 at recovery: {result:?}");
    let line_under_ack = parse(&name(), &bytes_of(&[open_record(), Record::Ack { seq: 50, msg: None }, line(7)]));
    assert!(line_under_ack.is_err(), "a line recorded after an ACK that covers it is impossible too: {line_under_ack:?}");
}

/// The same rule never refuses what compaction legitimately writes: a leading watermark past
/// the lines that follow it, and later ACKs of those lines.
#[test]
fn a_compacted_leading_ack_past_its_lines_is_valid() {
    let base = scratch("compacted-ack");
    let dir = Dir::open(&base.join("j")).unwrap();
    let file = dir.create(ROOM, CREATED, &[]).unwrap();
    for seq in 1..=50 {
        file.append(&line(seq)).unwrap();
    }
    file.append(&Record::Ack { seq: 48, msg: Some("900000000000000048".into()) }).unwrap();
    file.append(&Record::Ack { seq: 50, msg: None }).unwrap();
    assert!(file.compact().unwrap(), "premise: compacted to a leading ACK of 50 and no lines");
    file.append(&line(51)).unwrap();
    file.append(&Record::Ack { seq: 51, msg: None }).unwrap();
    file.append(&line(52)).unwrap();
    let parsed = file.reload().expect("a compacted file with its leading ACK parses");
    assert_eq!((parsed.acked, seqs(&parsed)), (51, vec![52]));
    let _ = fs::remove_dir_all(base);
}

// ── r4: the `.loss` merge across a real kill (Codex's r4 pitfalls) ──

fn raw_losses(path: &Path) -> usize {
    String::from_utf8(fs::read(path.join(name())).unwrap()).unwrap().lines().filter(|line| line.contains("\"t\":\"loss\"")).count()
}

/// Killed at each boundary of the merge and the ACK after it, the next launch holds every
/// line once and the loss once: never lost, never said twice.
#[test]
fn kill_through_the_loss_merge_and_its_ack() {
    // (boundary, the seqs still owed after the next launch)
    let cases = [
        ("merge_appended", vec![1, 2]),
        ("merge_synced", vec![1, 2]),
        ("loss_unlinked", vec![1, 2]),
        ("merge_done", vec![1, 2]),
        ("ack_written", vec![]),
    ];
    let proofs = std::env::var("GYREDECK_PROOF_DIR").ok().map(PathBuf::from);
    let loss_file = format!("{ROOM}@{CREATED}.loss");
    let keep = |dir: &Option<PathBuf>, point: &str, what: &str, from: &Path| {
        if let Some(dir) = dir {
            let at = dir.join("faults").join(point);
            fs::create_dir_all(&at).unwrap();
            match fs::read(from) {
                Ok(bytes) => fs::write(at.join(what), bytes).unwrap(),
                Err(_) => fs::write(at.join(format!("{what}.absent")), b"").unwrap(),
            }
        }
    };
    for (point, owed) in cases {
        let path = kill_at("merge", point, 1);
        keep(&proofs, point, "journal-before.bin", &path.join(name()));
        keep(&proofs, point, "loss-before.bin", &path.join(&loss_file));
        let dir = Dir::open(&path).unwrap();
        let names = dir.scan().unwrap();
        let mut hub = super::super::Hub { journal_dir: Some(dir), ..Default::default() };
        hub.recover(names);
        assert!(hub.journal_errors.is_empty(), "{point}: {:?}", hub.journal_errors);
        let held: Vec<u64> = hub.draining.get(ROOM).into_iter().flatten().flat_map(|(feed, _)| feed.unacked.iter().map(super::super::line_seq)).collect();
        keep(&proofs, point, "journal-after.bin", &path.join(name()));
        keep(&proofs, point, "loss-after.bin", &path.join(&loss_file));
        if let Some(dir) = &proofs {
            let result = format!("boundary {point}\nheld seqs after recovery: {held:?} (expected {owed:?})\nloss records in the journal: {}\nbatches: {}\njournal errors: {:?}\n", raw_losses(&path), hub.draining.get(ROOM).map_or(0, Vec::len), hub.journal_errors);
            fs::write(dir.join("faults").join(point).join("recovered-result.txt"), result).unwrap();
        }
        assert_eq!(held, owed, "{point}: nothing lost, nothing twice");
        assert_eq!(raw_losses(&path), 1, "{point}: one loss record in the journal");
        assert!(!path.join(format!("{ROOM}@{CREATED}.loss")).exists(), "{point}: the fallback is merged and gone");
        assert_eq!(hub.draining.get(ROOM).map_or(0, Vec::len), 1, "{point}: one batch, closed once");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}

// ── r5: a merge refused once never lets the close go ahead of the loss ──

fn closes_and_losses_in_order(path: &Path) -> Vec<&'static str> {
    String::from_utf8(fs::read(path.join(name())).unwrap())
        .unwrap()
        .lines()
        .filter_map(|line| if line.contains("\"t\":\"loss\"") { Some("loss") } else if line.contains("\"t\":\"close\"") { Some("close") } else { None })
        .collect()
}

/// Killed while the merge failed and the close is held, or as the held close is written: the
/// next launch has the loss before the close, each once.
#[test]
fn kill_while_a_failed_merge_holds_the_close() {
    let proofs = std::env::var("GYREDECK_PROOF_DIR").ok().map(PathBuf::from);
    for point in ["record_refused", "held", "close_landed"] {
        let path = kill_at("merge_fail", point, 1);
        let before = fs::read(path.join(name())).unwrap();
        let loss_before = fs::read(path.join(format!("{ROOM}@{CREATED}.loss"))).ok();
        let dir = Dir::open(&path).unwrap();
        let names = dir.scan().unwrap();
        let mut hub = super::super::Hub { journal_dir: Some(dir), ..Default::default() };
        hub.recover(names);
        let held: Vec<u64> = hub.draining.get(ROOM).into_iter().flatten().flat_map(|(feed, _)| feed.unacked.iter().map(super::super::line_seq)).collect();
        let order = closes_and_losses_in_order(&path);
        if let Some(dir) = &proofs {
            let at = dir.join("faults").join(point);
            fs::create_dir_all(&at).unwrap();
            fs::write(at.join("journal-before.bin"), &before).unwrap();
            match &loss_before {
                Some(bytes) => fs::write(at.join("loss-before.bin"), bytes).unwrap(),
                None => fs::write(at.join("loss-before.bin.absent"), b"").unwrap(),
            }
            fs::write(at.join("journal-after.bin"), fs::read(path.join(name())).unwrap()).unwrap();
            let gone = !path.join(format!("{ROOM}@{CREATED}.loss")).exists();
            fs::write(at.join("recovered-result.txt"), format!("boundary {point}\nheld seqs: {held:?}\nrecords in order: {order:?}\nfallback gone: {gone}\nerrors: {:?}\n", hub.journal_errors)).unwrap();
        }
        assert_eq!(held, vec![1, 2], "{point}: line and loss, once each");
        assert_eq!(order, vec!["loss", "close"], "{point}: the loss before the close, each once");
        assert!(!path.join(format!("{ROOM}@{CREATED}.loss")).exists(), "{point}");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}

/// Codex r5 through a real kill: the Close write refused, the process killed before the retry,
/// after it, or as it lands. One close id in the journal, said once at the next launch.
#[test]
fn kill_around_a_refused_close() {
    let proofs = std::env::var("GYREDECK_PROOF_DIR").ok().map(PathBuf::from);
    for point in ["record_refused", "close_pending", "close_landed"] {
        let path = kill_at("close_fail", point, 1);
        let before = fs::read(path.join(name())).unwrap();
        let dir = Dir::open(&path).unwrap();
        let names = dir.scan().unwrap();
        let mut hub = super::super::Hub { journal_dir: Some(dir), ..Default::default() };
        hub.channel = Some(super::super::ChildChannel::new(Box::new(std::io::sink())));
        hub.recover(names);
        let text = String::from_utf8(fs::read(path.join(name())).unwrap()).unwrap();
        let ids: Vec<String> = text.lines().map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()).filter(|record| record["t"] == "close").map(|record| record["id"].as_str().unwrap().to_string()).collect();
        let sent: Vec<String> = hub.outbox.iter().filter_map(|out| match out {
            super::super::Out::Control(super::super::ToChild::Disconnect { id, .. }) => Some(id.clone()),
            _ => None,
        }).collect();
        if let Some(dir) = &proofs {
            let at = dir.join("faults").join(format!("close-{point}"));
            fs::create_dir_all(&at).unwrap();
            fs::write(at.join("journal-before.bin"), &before).unwrap();
            fs::write(at.join("journal-after.bin"), text.as_bytes()).unwrap();
            fs::write(at.join("recovered-result.txt"), format!("boundary {point}\nclose ids in the journal: {ids:?}\ncloses sent at the next launch: {sent:?}\n")).unwrap();
        }
        assert_eq!(ids.len(), 1, "{point}: one close in the journal");
        assert_eq!(sent, ids, "{point}: said once, with that id");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}

/// Stand-in r9 audit S4: a directory sync that fails after the compaction's rename leaves the
/// rename not durable, so the next sync must not report the file synced without doing it.
#[test]
fn standin_r9_a_failed_dir_sync_after_compaction_is_not_taken_as_synced() {
    let base = scratch("standin-dirsync");
    let path = base.join("j");
    let dir = Dir::open(&path).unwrap();
    let file = dir.create(ROOM, CREATED, &[]).unwrap();
    for seq in 1..=51 {
        file.append(&line(seq)).unwrap();
    }
    file.append(&Record::Ack { seq: 50, msg: None }).unwrap();
    FAIL_DIR_SYNC.with(|fail| *fail.borrow_mut() = true);
    let compacted = file.compact();
    FAIL_DIR_SYNC.with(|fail| *fail.borrow_mut() = false);
    assert!(compacted.is_err(), "premise: the directory sync failed");
    file.fail_next_syncs(1);
    assert!(file.sync().is_err(), "sync() answered Ok without syncing: line 51 is only in a rename no sync made durable");
    let _ = fs::remove_dir_all(base);
}
