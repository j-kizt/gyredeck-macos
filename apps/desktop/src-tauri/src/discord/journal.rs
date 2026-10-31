//! The relay's disk journal (#199 option B): every line Rust takes from a room is written here
//! before the child can be handed it, and stays until Discord has taken it and the instance's
//! last close is acknowledged. One file per room instance, `<code>@<createdAt>.jsonl`, one
//! JSON record per line.
//!
//! Every write goes through `*at` calls on a directory fd held for the app's life, with
//! `O_NOFOLLOW`, and no write ever goes through a path: a symlink or hardlink planted at a
//! journal name, the temp name or the directory is refused, never followed (#230 class). The
//! path-based helpers in `standalone_bridge` follow a symlinked parent and are not used.

use std::{
    collections::HashMap,
    ffi::CString,
    fs,
    io::{self, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{FileExt, MetadataExt},
    },
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};

use super::DisconnectReason;

pub(crate) const VERSION: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Record {
    #[serde(rename_all = "camelCase")]
    Open {
        code: String,
        created_at: u64,
        members: Vec<String>,
        v: u8,
        /// How far the room's seqs are accounted for, carried over by a compaction that
        /// dropped the records saying so (#199 r9).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        covered: Option<u64>,
    },
    /// `through`: the last seq a notice accounts for, when past its own (a gap notice).
    Line {
        seq: u64,
        sender: String,
        to: String,
        kind: String,
        text: String,
        ts: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        through: Option<u64>,
    },
    Ack { seq: u64, msg: Option<String> },
    Close { id: String, reason: DisconnectReason, at: u64 },
    Closeack { id: String },
    Loss {
        seq: u64,
        n: u64,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        through: Option<u64>,
    },
}

/// A line or a loss, as the journal holds it until Discord takes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Item {
    Line { seq: u64, sender: String, to: String, kind: String, text: String, ts: String, through: Option<u64> },
    Loss { seq: u64, n: u64, label: String, through: Option<u64> },
}

impl Item {
    pub(crate) fn seq(&self) -> u64 {
        match self {
            Item::Line { seq, .. } | Item::Loss { seq, .. } => *seq,
        }
    }

    /// The last seq this item accounts for: its own, or further for a gap notice.
    pub(crate) fn covers(&self) -> u64 {
        match self {
            Item::Line { seq, through, .. } | Item::Loss { seq, through, .. } => through.unwrap_or(*seq).max(*seq),
        }
    }

    fn record(&self) -> Record {
        match self.clone() {
            Item::Line { seq, sender, to, kind, text, ts, through } => Record::Line { seq, sender, to, kind, text, ts, through },
            Item::Loss { seq, n, label, through } => Record::Loss { seq, n, label, through },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Close {
    pub id: String,
    pub reason: DisconnectReason,
    pub at: u64,
    /// Its `closeack` is in the file: only its lines are still owed.
    pub acked: bool,
}

/// One connection's worth: its lines, then its close. `close` is `None` only for the tail after
/// the last close of a journal whose instance was never closed — the app ended under it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Batch {
    pub items: Vec<Item>,
    pub close: Option<Close>,
}

/// What a journal still owes Discord.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Parsed {
    pub code: String,
    pub created_at: u64,
    pub members: Vec<String>,
    /// The ACK watermark, and the newest Discord id an ACK carried with the seq it carried it
    /// at. An ACK with no id (a dedupe) moves the watermark, never the anchor.
    pub acked: u64,
    pub last_msg_id: Option<String>,
    pub anchor_seq: u64,
    pub batches: Vec<Batch>,
    /// The highest line or loss seq the file holds, acknowledged or not.
    pub last_seq: u64,
    /// How far the room's seqs are accounted for (gap notices' reach, ACKs, a carried header).
    pub covered: u64,
    /// The bytes up to the last whole record; a torn tail starts here.
    pub valid_len: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Corrupt {
    pub name: String,
    /// 1-based; 0 when the file could not be opened or read at all.
    pub line: usize,
    pub why: String,
}

pub(crate) struct Recovered {
    pub parsed: Parsed,
    pub file: File,
}

/// A quit's loss record its journal could not take, kept beside it: `<code>@<createdAt>.loss`.
fn loss_name(journal: &str) -> String {
    format!("{}.loss", journal.strip_suffix(".jsonl").unwrap_or(journal))
}

/// `<code>@<createdAt>.jsonl`, the one shape a journal is named.
pub(crate) fn file_name(code: &str, created_at: u64) -> String {
    format!("{code}@{created_at}.jsonl")
}

fn name_parts(name: &str) -> Option<(&str, u64)> {
    let stem = name.strip_suffix(".jsonl")?;
    let (code, created) = stem.split_once('@')?;
    if !super::valid_sync_code(code) || created.is_empty() || !created.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((code, created.parse().ok()?))
}

fn temp_parts(name: &str) -> bool {
    let Some(rest) = name.strip_suffix(".tmp") else {
        return false;
    };
    let Some((stem, hex)) = rest.rsplit_once('.') else {
        return false;
    };
    hex.len() == 16 && hex.bytes().all(|b| b.is_ascii_hexdigit()) && name_parts(stem).is_some()
}

/// Parse a journal's bytes. A last chunk with no `\n` is a torn write and ignored; any other
/// malformation refuses the whole file.
pub(crate) fn parse(name: &str, bytes: &[u8]) -> Result<Parsed, Corrupt> {
    let corrupt = |line: usize, why: String| Corrupt { name: name.to_string(), line, why };
    let (code, created_at) = name_parts(name).ok_or_else(|| corrupt(0, "not a journal name".to_string()))?;
    let valid_len = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |at| at + 1);
    let mut members: Option<Vec<String>> = None;
    let mut acked = 0_u64;
    let mut last_msg_id: Option<String> = None;
    let mut anchor_seq = 0_u64;
    // What an ACK may name: no further than the lines this file has recorded, or, before its
    // first line, the watermark a compaction carried over (its leading ACKs).
    let mut ack_bound = 0_u64;
    let mut lines_seen = false;
    let mut last_seq: Option<u64> = None;
    // How far the room's seqs are accounted for: lines, gap notices' reach, ACKs, and what a
    // compaction carried over in the header.
    let mut covered = 0_u64;
    let mut seen: HashMap<u64, Item> = HashMap::new();
    let mut closes: HashMap<String, bool> = HashMap::new();
    let mut batches: Vec<Batch> = Vec::new();
    let mut current: Vec<Item> = Vec::new();
    let whole: &[u8] = if valid_len == 0 { &[] } else { &bytes[..valid_len - 1] };
    for (index, raw) in whole.split(|b| *b == b'\n').enumerate().filter(|_| valid_len > 0) {
        let line = index + 1;
        let record: Record = serde_json::from_slice(raw).map_err(|error| corrupt(line, format!("not a record: {error}")))?;
        if members.is_none() {
            let Record::Open { code: own, created_at: at, members: list, v, covered: carried } = record else {
                return Err(corrupt(line, "the first record is not open".to_string()));
            };
            if own != code || at != created_at {
                return Err(corrupt(line, "open names another room instance than the file".to_string()));
            }
            if v != VERSION {
                return Err(corrupt(line, format!("journal version {v}")));
            }
            members = Some(list);
            covered = carried.unwrap_or(0);
            continue;
        }
        match record {
            Record::Open { .. } => return Err(corrupt(line, "a second open".to_string())),
            Record::Line { .. } | Record::Loss { .. } => {
                let item = match record {
                    Record::Line { seq, sender, to, kind, text, ts, through } => Item::Line { seq, sender, to, kind, text, ts, through },
                    Record::Loss { seq, n, label, through } => Item::Loss { seq, n, label, through },
                    _ => unreachable!(),
                };
                let seq = item.seq();
                if seq <= acked && !seen.contains_key(&seq) {
                    return Err(corrupt(line, format!("seq {seq} is recorded after an ACK that already covers it")));
                }
                if last_seq.is_some_and(|last| seq <= last) {
                    match seen.get(&seq) {
                        Some(earlier) if *earlier == item => continue,
                        Some(_) => return Err(corrupt(line, format!("seq {seq} twice with different content"))),
                        None => return Err(corrupt(line, format!("seq {seq} goes backwards"))),
                    }
                }
                last_seq = Some(seq);
                covered = covered.max(item.covers());
                lines_seen = true;
                ack_bound = ack_bound.max(seq);
                seen.insert(seq, item.clone());
                current.push(item);
            }
            Record::Ack { seq, msg } => {
                if !lines_seen {
                    ack_bound = ack_bound.max(seq);
                } else if seq > ack_bound {
                    return Err(corrupt(line, format!("an ACK of seq {seq} past every line recorded ({ack_bound})")));
                }
                acked = acked.max(seq);
                covered = covered.max(seq);
                if msg.is_some() && seq >= anchor_seq {
                    anchor_seq = seq;
                    last_msg_id = msg;
                }
            }
            Record::Close { id, reason, at } => {
                if closes.insert(id.clone(), false).is_some() {
                    return Err(corrupt(line, format!("close {id} twice")));
                }
                batches.push(Batch { items: std::mem::take(&mut current), close: Some(Close { id, reason, at, acked: false }) });
            }
            Record::Closeack { id } => match closes.get_mut(&id) {
                Some(done) => *done = true,
                None => return Err(corrupt(line, format!("closeack {id} names no earlier close"))),
            },
        }
    }
    let Some(members) = members else {
        return Err(corrupt(0, "no whole record".to_string()));
    };
    if !current.is_empty() || closes.is_empty() {
        batches.push(Batch { items: current, close: None });
    }
    for batch in &mut batches {
        batch.items.retain(|item| item.seq() > acked);
        if let Some(close) = batch.close.as_mut() {
            close.acked = closes.get(&close.id) == Some(&true);
        }
    }
    batches.retain(|batch| !(batch.items.is_empty() && batch.close.as_ref().is_some_and(|close| close.acked)));
    Ok(Parsed { code: code.to_string(), created_at, members, acked, last_msg_id, anchor_seq, batches, last_seq: last_seq.unwrap_or(0), covered, valid_len })
}

/// The live subset of a parsed journal, as a file that parses back to the same `Parsed`.
fn render(parsed: &Parsed) -> Vec<u8> {
    let covered = (parsed.covered > 0).then_some(parsed.covered);
    let mut records = vec![Record::Open { code: parsed.code.clone(), created_at: parsed.created_at, members: parsed.members.clone(), v: VERSION, covered }];
    if parsed.last_msg_id.is_some() {
        records.push(Record::Ack { seq: parsed.anchor_seq, msg: parsed.last_msg_id.clone() });
    }
    if parsed.acked > parsed.anchor_seq || (parsed.acked > 0 && parsed.last_msg_id.is_none()) {
        records.push(Record::Ack { seq: parsed.acked, msg: None });
    }
    for batch in &parsed.batches {
        records.extend(batch.items.iter().map(Item::record));
        if let Some(close) = &batch.close {
            records.push(Record::Close { id: close.id.clone(), reason: close.reason, at: close.at });
            if close.acked {
                records.push(Record::Closeack { id: close.id.clone() });
            }
        }
    }
    let mut out = Vec::new();
    for record in records {
        out.extend(line_of(&record));
    }
    out
}

fn line_of(record: &Record) -> Vec<u8> {
    let mut line = serde_json::to_vec(record).unwrap_or_default();
    line.push(b'\n');
    line
}

// ── the descriptors ──

fn cstr(name: &str) -> io::Result<CString> {
    if name.contains('/') {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "a journal name has no slash"));
    }
    CString::new(name).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "a journal name has no NUL"))
}

fn refuse(why: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, why.to_string())
}

fn openat(dir: &fs::File, name: &str, flags: libc::c_int) -> io::Result<fs::File> {
    let name = cstr(name)?;
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags, 0o600 as libc::c_uint) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { fs::File::from_raw_fd(fd) })
}

/// A regular file of this user's with one name: a hardlink planted at a journal name has two.
fn check_file(file: &fs::File) -> io::Result<()> {
    let meta = file.metadata()?;
    if !meta.file_type().is_file() {
        return Err(refuse("not a regular file"));
    }
    if meta.nlink() != 1 {
        return Err(refuse("a file with more than one name"));
    }
    if meta.uid() != unsafe { libc::geteuid() } {
        return Err(refuse("a file another user owns"));
    }
    Ok(())
}

fn full_sync(file: &fs::File) -> io::Result<()> {
    point("full_sync");
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_FULLFSYNC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn dir_sync(dir: &fs::File) -> io::Result<()> {
    point("dir_sync");
    #[cfg(test)]
    if tests::fail_dir_sync() {
        return Err(io::Error::other("injected directory sync failure"));
    }
    if unsafe { libc::fsync(dir.as_raw_fd()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn unlinkat(dir: &fs::File, name: &str) -> io::Result<()> {
    let name = cstr(name)?;
    if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn read_all(file: &fs::File) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read_at(&mut chunk, bytes.len() as u64)?;
        if read == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
}

fn random_hex() -> io::Result<String> {
    #[cfg(test)]
    if let Some(name) = tests::forced_temp_hex() {
        return Ok(name);
    }
    let mut bytes = [0_u8; 8];
    security_framework::random::SecRandom::default()
        .copy_bytes(&mut bytes)
        .map_err(|error| io::Error::other(format!("no randomness for a temp name: {error}")))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// A crash-test boundary; nothing outside the tests.
#[inline]
pub(crate) fn point(_name: &str) {
    #[cfg(test)]
    tests::at_point(_name);
}

/// The journal directory, held open for the app's life.
pub(crate) struct Dir {
    fd: Arc<fs::File>,
}

impl Dir {
    /// Create it private if missing, then open it without following a symlink, and refuse
    /// anything but this user's own directory with no group or other bits.
    pub(crate) fn open(path: &Path) -> io::Result<Dir> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let raw = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| refuse("a path with a NUL"))?;
        if unsafe { libc::mkdir(raw.as_ptr(), 0o700) } < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::AlreadyExists {
                return Err(error);
            }
        }
        let fd = unsafe { libc::open(raw.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let dir = unsafe { fs::File::from_raw_fd(fd) };
        let meta = dir.metadata()?;
        if !meta.file_type().is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
            return Err(refuse("not a private directory"));
        }
        Ok(Dir { fd: Arc::new(dir) })
    }

    /// A new instance's file, with its header. Only a planted file can already be there: this
    /// app's own stays open for its instance's whole life, so `EEXIST` is refused. Read-write,
    /// not write-only: compaction and a parked reload read through this same descriptor.
    #[cfg(test)]
    pub(crate) fn create(&self, code: &str, created_at: u64, members: &[String]) -> io::Result<File> {
        let file = self.create_bare(code, created_at)?;
        let header = Record::Open { code: code.to_string(), created_at, members: members.to_vec(), v: VERSION, covered: None };
        if let Err(error) = file.append(&header) {
            let _ = unlinkat(&self.fd, &file.name);
            return Err(error);
        }
        Ok(file)
    }

    /// The same file with no header yet: the Hub writes its `open` through its one write path.
    pub(crate) fn create_bare(&self, code: &str, created_at: u64) -> io::Result<File> {
        let name = file_name(code, created_at);
        let fd = openat(&self.fd, &name, libc::O_RDWR | libc::O_APPEND | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC)?;
        if let Err(error) = check_file(&fd) {
            let _ = unlinkat(&self.fd, &name);
            return Err(error);
        }
        Ok(File { dir: Arc::clone(&self.fd), name, inner: Mutex::new(Inner::new(fd, 0, 0, 0)) })
    }

    /// The names of the journals an earlier life left, oldest instance first, with stale
    /// compaction temps removed. Nothing is opened or parsed: the launch window decides which
    /// are (d26).
    pub(crate) fn scan(&self) -> Result<Vec<String>, Corrupt> {
        let names = self.names().map_err(|error| Corrupt { name: String::new(), line: 0, why: format!("the journal directory could not be listed: {error}") })?;
        for name in names.iter().filter(|name| temp_parts(name)) {
            if self.is_regular(name) {
                let _ = unlinkat(&self.fd, name);
            }
        }
        let _ = dir_sync(&self.fd);
        let mut journals: Vec<(u64, String)> = names.iter().filter_map(|name| name_parts(name).map(|(_, at)| (at, name.clone()))).collect();
        journals.sort();
        Ok(journals.into_iter().map(|(_, name)| name).collect())
    }

    /// Fallback loss records whose journal is gone: nothing can say them, so they are named.
    pub(crate) fn orphan_losses(&self) -> Vec<Corrupt> {
        let names = self.names().unwrap_or_default();
        names
            .iter()
            .filter_map(|name| {
                let stem = name.strip_suffix(".loss")?;
                let journal = format!("{stem}.jsonl");
                (name_parts(&journal).is_some() && !names.contains(&journal))
                    .then(|| Corrupt { name: name.clone(), line: 0, why: "a quit's loss record with no journal to say it in".to_string() })
            })
            .collect()
    }

    /// Every journal at once; the tests' way in.
    #[cfg(test)]
    pub(crate) fn recover(&self) -> (Vec<Recovered>, Vec<Corrupt>) {
        let mut found = Vec::new();
        let mut refused = Vec::new();
        let names = match self.scan() {
            Ok(names) => names,
            Err(corrupt) => return (found, vec![corrupt]),
        };
        for name in names {
            match self.recover_one(&name) {
                Ok(Some(recovered)) => found.push(recovered),
                Ok(None) => {}
                Err(corrupt) => refused.push(corrupt),
            }
        }
        found.sort_by_key(|recovered| (recovered.parsed.created_at, recovered.parsed.code.clone()));
        (found, refused)
    }

    /// Open and parse one journal by name: `None` when it was done and is now deleted.
    pub(crate) fn recover_one(&self, name: &str) -> Result<Option<Recovered>, Corrupt> {
        #[cfg(test)]
        tests::count_open();
        let unreadable = |why: String| Corrupt { name: name.to_string(), line: 0, why };
        let fd = openat(&self.fd, name, libc::O_RDWR | libc::O_APPEND | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .map_err(|error| unreadable(format!("refused: {error}")))?;
        check_file(&fd).map_err(|error| unreadable(format!("refused: {error}")))?;
        let bytes = read_all(&fd).map_err(|error| unreadable(format!("unreadable: {error}")))?;
        let parsed = match parse(name, &bytes) {
            Ok(parsed) => parsed,
            // A crash before the header was whole: nothing was ever handed on from it.
            Err(corrupt) if corrupt.line == 0 && !bytes.contains(&b'\n') => {
                drop(fd);
                let _ = unlinkat(&self.fd, name);
                let _ = dir_sync(&self.fd);
                return Ok(None);
            }
            Err(corrupt) => return Err(corrupt),
        };
        if parsed.batches.is_empty() && !self.has_loss(name) {
            // Done before the crash: every line taken and every close acknowledged, the unlink
            // not yet made (C7 → C8).
            drop(fd);
            let _ = unlinkat(&self.fd, name);
            let _ = dir_sync(&self.fd);
            return Ok(None);
        }
        if parsed.valid_len < bytes.len() {
            // The torn tail goes, or the next append would join it into a malformed record.
            fd.set_len(parsed.valid_len as u64).and_then(|()| full_sync(&fd)).map_err(|error| unreadable(format!("its torn tail could not be cut: {error}")))?;
        }
        let file = File { dir: Arc::clone(&self.fd), name: name.to_string(), inner: Mutex::new(Inner::new(fd, parsed.valid_len as u64, parsed.last_seq, parsed.covered)) };
        Ok(Some(Recovered { parsed, file }))
    }

    /// The fallback for a quit's loss record the journal refused (d18 under d25): a separate
    /// small file, written whole, fully synced, with the directory synced, under the same
    /// no-follow rules. The next launch merges it into the journal.
    pub(crate) fn write_loss(&self, code: &str, created_at: u64, record: &Record) -> io::Result<()> {
        #[cfg(test)]
        if tests::fail_loss_write() {
            return Err(io::Error::other("injected fallback write failure"));
        }
        let name = loss_name(&file_name(code, created_at));
        let mut fd = openat(&self.fd, &name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC)?;
        let written = check_file(&fd).and_then(|()| fd.write_all(&line_of(record))).and_then(|()| full_sync(&fd)).and_then(|()| dir_sync(&self.fd));
        if written.is_err() {
            let _ = unlinkat(&self.fd, &name);
        }
        written
    }

    /// The fallback loss record of this instance: `None` when no quit left one. One that
    /// cannot be opened, is not this user's regular file, or is not one whole `loss` record is
    /// refused, never taken for absent, and its bytes are left as they are (d20).
    pub(crate) fn read_loss(&self, code: &str, created_at: u64) -> Result<Option<Record>, Corrupt> {
        let name = loss_name(&file_name(code, created_at));
        let refused = |why: String| Corrupt { name: name.clone(), line: 0, why };
        let fd = match openat(&self.fd, &name, libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(refused(format!("refused: {error}"))),
        };
        check_file(&fd).map_err(|error| refused(format!("refused: {error}")))?;
        let bytes = read_all(&fd).map_err(|error| refused(format!("unreadable: {error}")))?;
        let whole = bytes.strip_suffix(b"\n").filter(|line| !line.contains(&b'\n')).ok_or_else(|| refused("not one whole record".to_string()))?;
        match serde_json::from_slice::<Record>(whole) {
            Ok(record @ Record::Loss { .. }) => Ok(Some(record)),
            Ok(_) => Err(Corrupt { name: name.clone(), line: 1, why: "not a loss record".to_string() }),
            Err(error) => Err(Corrupt { name: name.clone(), line: 1, why: format!("not a record: {error}") }),
        }
    }

    /// Whether a fallback loss record sits beside this journal, of any kind.
    fn has_loss(&self, journal: &str) -> bool {
        let Ok(raw) = cstr(&loss_name(journal)) else {
            return false;
        };
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        unsafe { libc::fstatat(self.fd.as_raw_fd(), raw.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) == 0 }
    }

    /// The fallback is in the journal now, or the instance is gone.
    pub(crate) fn drop_loss(&self, code: &str, created_at: u64) {
        if unlinkat(&self.fd, &loss_name(&file_name(code, created_at))).is_ok() {
            point("loss_unlinked");
            let _ = dir_sync(&self.fd);
        }
    }

    /// Remove: a journal refused at recovery goes too. Only the name is removed; a planted
    /// symlink's target or a hardlink's other name is never touched.
    pub(crate) fn discard(&self, name: &str) -> io::Result<()> {
        if name_parts(name).is_none() && !name.strip_suffix(".loss").is_some_and(|stem| name_parts(&format!("{stem}.jsonl")).is_some()) {
            return Err(refuse("not a journal name"));
        }
        unlinkat(&self.fd, name)?;
        let _ = unlinkat(&self.fd, &loss_name(name));
        dir_sync(&self.fd)
    }

    fn names(&self) -> io::Result<Vec<String>> {
        let fd = unsafe { libc::dup(self.fd.as_raw_fd()) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            unsafe { libc::close(fd) };
            return Err(error);
        }
        unsafe { libc::rewinddir(stream) };
        let mut names = Vec::new();
        loop {
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break;
            }
            let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
            if let Ok(name) = name.to_str() {
                names.push(name.to_string());
            }
        }
        unsafe { libc::closedir(stream) };
        Ok(names)
    }

    fn is_regular(&self, name: &str) -> bool {
        let Ok(raw) = cstr(name) else {
            return false;
        };
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        let found = unsafe { libc::fstatat(self.fd.as_raw_fd(), raw.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } == 0;
        found && (stat.st_mode & libc::S_IFMT) == libc::S_IFREG
    }

    #[cfg(test)]
    pub(crate) fn names_for_test(&self) -> Vec<String> {
        let mut names: Vec<String> = self.names().unwrap().into_iter().filter(|name| name != "." && name != "..").collect();
        names.sort();
        names
    }
}

struct Inner {
    fd: fs::File,
    size: u64,
    /// The highest line or loss seq written, and the highest the last sync covered.
    written: u64,
    synced: u64,
    dirty: bool,
    /// A failed append could not be undone: nothing more may land after its partial bytes.
    broken: bool,
    /// The last line or loss record this process wrote: the one a retry may find already in.
    last: Option<Record>,
    /// How far the room's seqs are accounted for, gap notices' reach included.
    covered: u64,
    /// A compaction's rename is not yet durable: the directory still owes a sync.
    dir_dirty: bool,
    #[cfg(test)]
    fail: bool,
    #[cfg(test)]
    fail_next: u32,
    #[cfg(test)]
    short: bool,
    #[cfg(test)]
    fail_syncs: u32,
}

impl Inner {
    fn new(fd: fs::File, size: u64, last_seq: u64, covered: u64) -> Self {
        Inner {
            fd,
            size,
            written: last_seq,
            covered: covered.max(last_seq),
            dir_dirty: false,
            // A recovered file's bytes may still sit in the page cache of the life that wrote
            // them: nothing in it counts as synced until this life syncs it, so the bridge is
            // told no position from it before a real sync (#199 r9).
            synced: 0,
            dirty: size > 0,
            broken: false,
            last: None,
            #[cfg(test)]
            fail: false,
            #[cfg(test)]
            fail_next: 0,
            #[cfg(test)]
            short: false,
            #[cfg(test)]
            fail_syncs: 0,
        }
    }
}

/// One room instance's journal. Every call goes through the descriptor it was opened with.
pub(crate) struct File {
    dir: Arc<fs::File>,
    name: String,
    inner: Mutex<Inner>,
}

impl File {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// One record, in one write: once this returns, a process crash cannot lose it. A write
    /// that fails part-way (ENOSPC, EFBIG) is cut back to the last whole record, so the next
    /// one cannot join its bytes into a malformed record; if it cannot be cut, the file takes
    /// nothing more.
    pub(crate) fn append(&self, record: &Record) -> io::Result<()> {
        let line = line_of(record);
        let mut inner = self.lock();
        if inner.broken {
            return Err(refuse("an earlier write could not be undone"));
        }
        #[cfg(test)]
        let passing = tests::fault_free();
        #[cfg(test)]
        if !passing && (inner.fail || inner.fail_next > 0 || tests::fail_append()) {
            inner.fail_next = inner.fail_next.saturating_sub(1);
            return Err(io::Error::other("injected journal write failure"));
        }
        #[cfg(test)]
        let written = if passing { inner.fd.write_all(&line) } else { Self::write_record(&mut inner, &line) };
        #[cfg(not(test))]
        let written = Self::write_record(&mut inner, &line);
        if let Err(error) = written {
            let good = inner.size;
            if inner.fd.set_len(good).is_err() {
                inner.broken = true;
            }
            return Err(error);
        }
        inner.size += line.len() as u64;
        inner.dirty = true;
        if let Record::Line { seq, through, .. } | Record::Loss { seq, through, .. } = record {
            inner.written = inner.written.max(*seq);
            inner.covered = inner.covered.max(through.unwrap_or(*seq));
            inner.last = Some(record.clone());
        }
        drop(inner);
        point("appended");
        Ok(())
    }

    fn write_record(inner: &mut Inner, line: &[u8]) -> io::Result<()> {
        #[cfg(test)]
        if inner.short || tests::short_append() {
            // A real partial write, as a full disk leaves one.
            inner.fd.write_all(&line[..line.len() / 2])?;
            return Err(io::Error::from_raw_os_error(libc::ENOSPC));
        }
        inner.fd.write_all(line)
    }

    /// `F_FULLFSYNC`, when anything was written since the last one.
    pub(crate) fn sync(&self) -> io::Result<()> {
        let mut inner = self.lock();
        if !inner.dirty && !inner.dir_dirty {
            return Ok(());
        }
        point("before_sync");
        #[cfg(test)]
        if inner.fail_syncs > 0 || tests::fail_sync() {
            inner.fail_syncs = inner.fail_syncs.saturating_sub(1);
            return Err(io::Error::other("injected journal sync failure"));
        }
        full_sync(&inner.fd)?;
        if inner.dir_dirty {
            dir_sync(&self.dir)?;
            inner.dir_dirty = false;
        }
        inner.synced = inner.written;
        inner.dirty = false;
        drop(inner);
        point("after_sync");
        Ok(())
    }

    /// The highest seq a sync has covered: the furthest the bridge may be told (I1).
    #[cfg(test)]
    pub(crate) fn synced_through(&self) -> u64 {
        self.lock().synced
    }

    pub(crate) fn size(&self) -> u64 {
        self.lock().size
    }

    /// The file as it stands, parsed again through its own descriptor.
    #[cfg(test)]
    pub(crate) fn reload(&self) -> Result<Parsed, Corrupt> {
        let inner = self.lock();
        let bytes = read_all(&inner.fd).map_err(|error| Corrupt { name: self.name.clone(), line: 0, why: format!("unreadable: {error}") })?;
        parse(&self.name, &bytes)
    }

    /// Rewrite the file as only what it still owes, when that is less than half of it: a
    /// private temp, synced, renamed over the file, the directory synced, and only then is the
    /// new descriptor the one written to. Answers whether it was rewritten.
    pub(crate) fn compact(&self) -> io::Result<bool> {
        let mut inner = self.lock();
        let bytes = read_all(&inner.fd)?;
        let parsed = parse(&self.name, &bytes).map_err(|corrupt| io::Error::other(format!("line {}: {}", corrupt.line, corrupt.why)))?;
        let live = render(&parsed);
        if live.len() * 2 >= bytes.len() {
            return Ok(false);
        }
        let temp = format!("{}.{}.tmp", self.name, random_hex()?);
        let fresh = openat(&self.dir, &temp, libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC)?;
        let written = (|| {
            check_file(&fresh)?;
            let mut fresh = &fresh;
            fresh.write_all(&live)?;
            point("compact_before_temp_sync");
            full_sync(fresh)?;
            point("compact_before_rename");
            let (from, to) = (cstr(&temp)?, cstr(&self.name)?);
            if unsafe { libc::renameat(self.dir.as_raw_fd(), from.as_ptr(), self.dir.as_raw_fd(), to.as_ptr()) } < 0 {
                return Err(io::Error::last_os_error());
            }
            point("renamed");
            Ok(())
        })();
        if let Err(error) = written {
            let _ = unlinkat(&self.dir, &temp);
            return Err(error);
        }
        point("compact_after_rename");
        // The name now holds the new file whatever the directory sync says: the new descriptor
        // is the one written to from here, or later lines would land in the unlinked old one.
        inner.fd = fresh;
        inner.size = live.len() as u64;
        // The new file is synced; the rename is durable only once the directory is. Until a
        // directory sync succeeds, a sync owes it, and nothing counts as synced (#199 r9).
        inner.dirty = false;
        inner.dir_dirty = true;
        dir_sync(&self.dir)?;
        inner.dir_dirty = false;
        Ok(true)
    }

    /// The instance is done: its last close is acknowledged and synced. The name goes, then
    /// the directory is synced.
    pub(crate) fn finish(&self) -> io::Result<()> {
        let _inner = self.lock();
        unlinkat(&self.dir, &self.name)?;
        point("finish_after_unlink");
        let _ = unlinkat(&self.dir, &loss_name(&self.name));
        dir_sync(&self.dir)
    }

    /// The last line or loss record this process wrote to the file.
    pub(crate) fn last_item(&self) -> Option<Record> {
        self.lock().last.clone()
    }

    /// How far the room's seqs are accounted for: the furthest a reattached feed has seen.
    pub(crate) fn covered_through(&self) -> u64 {
        self.lock().covered
    }

    /// The highest line or loss seq this file holds: no ACK record may name more.
    pub(crate) fn written_through(&self) -> u64 {
        self.lock().written
    }

    #[cfg(test)]
    pub(crate) fn fail_writes(&self, fail: bool) {
        self.lock().fail = fail;
    }

    #[cfg(test)]
    pub(crate) fn short_writes(&self, short: bool) {
        self.lock().short = short;
    }

    /// The next `count` syncs of this file fail, on any thread, then they succeed again.
    #[cfg(test)]
    pub(crate) fn fail_next_syncs(&self, count: u32) {
        self.lock().fail_syncs = count;
    }

    /// The next `count` appends fail, then they succeed again.
    #[cfg(test)]
    pub(crate) fn fail_next(&self, count: u32) {
        self.lock().fail_next = count;
    }
}

#[cfg(test)]
pub(crate) mod tests;
