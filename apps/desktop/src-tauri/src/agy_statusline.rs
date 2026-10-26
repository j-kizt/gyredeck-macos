//! Antigravity usage from agy's own status-line payload (#230): no token is read and no
//! network call is made.
//!
//! agy runs a status-line command on every TUI update and hands it a JSON payload whose
//! `quota` carries each bucket's `remaining_fraction`, `reset_time` and `reset_in_seconds`.
//! The app installs `gyredeck-agy-statusline.sh` as that command; it keeps the payload in
//! `~/.config/gyredeck/agy-statusline.json` (`0600`, the whole payload, email included) and
//! runs the person's own status line, if they had one, on the same input. This module reads
//! that file, and owns the one key of agy's `settings.json` the install changes.
//!
//! Invariants, each pinned by a test that was made to fail:
//! - C1  An unknown shape gives no value: no `quota`, a wrongly typed or out-of-range known
//!       bucket, or no known bucket at all. The format is undocumented and still changing.
//! - C2  `fetched_at` is the payload's time (`reset_time − reset_in_seconds`, never later
//!       than the file's mtime), not the time it was read.
//! - C3  Every fresh reading is relayed, a repeat included — the bridge's edge logic is what
//!       dedupes notices, so a same-second change or a lost POST is never swallowed here. A
//!       stale reading is marked stale and not relayed.
//! - C4  With a fresh status-line value, the token-reading fallback is not called at all.
//! - C5  The reader never parses the account email, so it is never kept, logged or relayed.
//! - C6  Installing over a person's status line keeps its output; uninstalling restores what
//!       was there, an absent key included. Our own command is never chained. With no status
//!       line of their own, agy's default line is kept (`stack_with_default`).
//! - C7  `settings.json` is agy's file: only `statusLine` changes, and every other key
//!       survives unless agy rewrites the file in the instant between the last check and the
//!       rename; a change seen before that is retried, never overwritten. The write is atomic
//!       with the file's mode kept, and a file that does not parse is refused.
//! - C8  Nothing this install writes follows a symlink: each file is a private temporary file
//!       renamed into place.
//! - C9  "Wired" means agy will actually run the script: type `command`, enabled, our command.

use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value};

use super::{
    unix_seconds_to_iso, CodexMetricLine, CodexProgressFormat, CodexUsageSnapshot,
    AGY_QUOTA_BUCKETS,
};

pub(crate) const SCRIPT_NAME: &str = "gyredeck-agy-statusline.sh";
const PAYLOAD_FILE: &str = "agy-statusline.json";
const CHAIN_FILE: &str = "agy-statusline.chain";
const PREVIOUS_FILE: &str = "agy-statusline.previous.json";
const STATUS_LINE_KEY: &str = "statusLine";
/// The keys of `statusLine` the install sets, and so the ones uninstall puts back.
const OWNED_KEYS: [&str; 4] = ["type", "command", "enabled", "stack_with_default"];
const MAX_PAYLOAD_BYTES: u64 = 64 * 1024;
const MERGE_ATTEMPTS: usize = 3;
/// agy writes only while its TUI updates, never while it sits idle.
pub(crate) const STALE_AFTER: Duration = Duration::from_secs(15 * 60);

/// Where everything this feature touches lives. Passed in rather than read from `HOME`, so
/// tests can run side by side.
pub(crate) struct AgyStatusLinePaths {
    pub(crate) settings: PathBuf,
    pub(crate) dir: PathBuf,
}

impl AgyStatusLinePaths {
    pub(crate) fn from_home() -> Result<Self, String> {
        let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
        let home = PathBuf::from(home);
        Ok(Self {
            settings: home.join(".gemini").join("antigravity-cli").join("settings.json"),
            dir: home.join(".config").join("gyredeck"),
        })
    }

    pub(crate) fn script(&self) -> PathBuf {
        self.dir.join(SCRIPT_NAME)
    }

    pub(crate) fn payload(&self) -> PathBuf {
        self.dir.join(PAYLOAD_FILE)
    }

    pub(crate) fn chain(&self) -> PathBuf {
        self.dir.join(CHAIN_FILE)
    }

    pub(crate) fn previous(&self) -> PathBuf {
        self.dir.join(PREVIOUS_FILE)
    }
}

// ---------------------------------------------------------------------------------------
// Reading the payload
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AgyStatusLine {
    lines: Vec<Bucket>,
    plan: Option<String>,
    fetched_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
struct Bucket {
    label: &'static str,
    used: f64,
    resets_at: String,
    period_duration_ms: u64,
}

/// The payload as far as this reader is concerned. Everything else in it — the email
/// among it — is never parsed.
#[derive(serde::Deserialize)]
struct Payload {
    quota: Map<String, Value>,
    #[serde(default)]
    plan_tier: Option<Value>,
}

/// Parse a payload, or nothing. `mtime` is the file's modification time in unix seconds.
pub(crate) fn parse_payload(bytes: &[u8], mtime: i64) -> Option<AgyStatusLine> {
    let payload: Payload = serde_json::from_slice(bytes).ok()?;
    let plan = match payload.plan_tier {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => {
            let text = text.trim();
            (!text.is_empty()).then(|| text.chars().take(64).collect())
        }
        Some(_) => return None,
    };

    let mut resolved = BTreeMap::new();
    let mut fetched_at = i64::MAX;
    for (id, label, period_duration_ms) in AGY_QUOTA_BUCKETS {
        let Some(bucket) = payload.quota.get(id) else {
            continue;
        };
        let bucket = bucket.as_object()?;
        let remaining = bucket.get("remaining_fraction")?.as_f64()?;
        if !(0.0..=1.0).contains(&remaining) {
            return None;
        }
        let reset_time = bucket.get("reset_time")?.as_str()?.trim();
        let reset_unix = time::OffsetDateTime::parse(
            reset_time,
            &time::format_description::well_known::Rfc3339,
        )
        .ok()?
        .unix_timestamp();
        let reset_in = bucket.get("reset_in_seconds")?.as_i64()?;
        if reset_in < 0 {
            return None;
        }
        fetched_at = fetched_at.min(reset_unix.checked_sub(reset_in)?);
        resolved.insert(
            id,
            Bucket {
                label,
                used: ((1.0 - remaining) * 100.0).round(),
                resets_at: reset_time.to_string(),
                period_duration_ms,
            },
        );
    }
    if resolved.is_empty() {
        return None;
    }
    Some(AgyStatusLine {
        lines: AGY_QUOTA_BUCKETS
            .iter()
            .filter_map(|(id, _, _)| resolved.remove(id))
            .collect(),
        plan,
        // The file can be touched without agy writing it; the payload cannot claim a time
        // after its own write.
        fetched_at: fetched_at.min(mtime),
    })
}

/// The payload file's bytes and mtime, when it is a regular file of a sane size. Opened
/// without following a symlink and without blocking on a FIFO, and checked through the
/// descriptor rather than the path.
pub(crate) fn read_payload_file(path: &Path) -> Option<(Vec<u8>, i64)> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_PAYLOAD_BYTES {
        return None;
    }
    let mtime = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    let mut bytes = Vec::new();
    file.take(MAX_PAYLOAD_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_PAYLOAD_BYTES {
        return None;
    }
    Some((bytes, mtime))
}

/// A status-line reading, as the usage tab gets it.
#[derive(Debug, Clone)]
pub(crate) struct AgyStatusLineReading {
    pub(crate) snapshot: CodexUsageSnapshot,
    pub(crate) stale: bool,
}

pub(crate) fn reading_from(status: AgyStatusLine, now: i64) -> AgyStatusLineReading {
    let age = now.saturating_sub(status.fetched_at);
    let stale = age > STALE_AFTER.as_secs() as i64;
    let mut lines: Vec<CodexMetricLine> = status
        .lines
        .iter()
        .map(|line| CodexMetricLine::Progress {
            label: line.label.to_string(),
            used: line.used,
            limit: 100.0,
            format: CodexProgressFormat::Percent,
            resets_at: Some(line.resets_at.clone()),
            period_duration_ms: Some(line.period_duration_ms),
        })
        .collect();
    if stale {
        // A Status line beside the bars is what the panel reads as "outdated".
        lines.push(CodexMetricLine::Text {
            label: "Status".to_string(),
            value: format!(
                "agy has not updated its status line for {} min; showing the last values.",
                age / 60
            ),
        });
    }
    AgyStatusLineReading {
        snapshot: CodexUsageSnapshot {
            provider_id: "agy".to_string(),
            display_name: "Antigravity".to_string(),
            plan: status.plan,
            lines,
            fetched_at: unix_seconds_to_iso(status.fetched_at)
                .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string()),
        },
        stale,
    }
}

pub(crate) fn read_reading(path: &Path, now: i64) -> Option<AgyStatusLineReading> {
    let (bytes, mtime) = read_payload_file(path)?;
    parse_payload(&bytes, mtime).map(|status| reading_from(status, now))
}

pub(crate) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// Where an agy usage answer came from.
pub(crate) enum AgyUsage {
    StatusLine(AgyStatusLineReading),
    Fallback(CodexUsageSnapshot),
}

/// The status line first. The fallback reads agy's token, so it runs only when there is no
/// fresh status-line value; and a stale value still beats the fallback's error.
pub(crate) fn choose_usage(
    status: Option<AgyStatusLineReading>,
    fallback: impl FnOnce() -> Result<CodexUsageSnapshot, String>,
) -> Result<AgyUsage, String> {
    match status {
        Some(reading) if !reading.stale => Ok(AgyUsage::StatusLine(reading)),
        Some(reading) => Ok(fallback()
            .map(AgyUsage::Fallback)
            .unwrap_or(AgyUsage::StatusLine(reading))),
        None => fallback().map(AgyUsage::Fallback),
    }
}

/// Relay every fresh reading. The bridge believes the body's `fetchedAt`, so a stale one
/// would be taken as news (#192) and is held back. A repeat is not: the bridge's notices are
/// edge-triggered, so posting the same numbers twice says nothing, while skipping one here
/// would lose a change made within the same second, or a POST the bridge never received.
pub(crate) fn relay_if_fresh(reading: &AgyStatusLineReading, relay: impl FnOnce(&CodexUsageSnapshot)) {
    if !reading.stale {
        relay(&reading.snapshot);
    }
}

// ---------------------------------------------------------------------------------------
// Files: atomic writes, and agy's settings.json
// ---------------------------------------------------------------------------------------

/// What identifies one version of a file: replaced, rewritten or resized, it changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    dev: u64,
    ino: u64,
    len: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

fn stamp(path: &Path) -> Result<Option<FileStamp>, String> {
    use std::os::unix::fs::MetadataExt;
    match fs::symlink_metadata(path) {
        Ok(m) => Ok(Some(FileStamp {
            dev: m.dev(),
            ino: m.ino(),
            len: m.len(),
            mtime: (m.mtime(), m.mtime_nsec()),
            ctime: (m.ctime(), m.ctime_nsec()),
        })),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

/// Read a JSON settings file another program owns, as an object. A missing or empty file is
/// an empty object; anything else that is not an object is refused, so it is never
/// overwritten — a hand-edited file with one stray comma is still the person's settings.
pub(crate) fn read_json_object(path: &Path) -> Result<Map<String, Value>, String> {
    let name = path.display();
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(format!("Failed to read {name}: {error}")),
        // Renaming over a symlink would replace the link, not the file it points at.
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(format!("Refusing to rewrite {name}: it is not a regular file"))
        }
        Ok(_) => {}
    }
    let content = fs::read_to_string(path).map_err(|error| format!("Failed to read {name}: {error}"))?;
    if content.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(&content) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(format!("Refusing to rewrite {name}: its root is not an object")),
        Err(error) => Err(format!("Refusing to overwrite unparsable {name}: {error}")),
    }
}

/// Change one top-level key of a JSON settings file another program owns, and nothing else.
///
/// `update` sees the key's current value and answers the new one (`None` removes it), or
/// refuses. Every other key is carried over as read. Nothing is written when the value does
/// not change. The new file is written beside it with the file's own mode and renamed over
/// it, so a reader never sees half a file. Returns the previous value.
///
/// The owner may write the file while this runs. The file's identity, size and times are
/// taken before the read and compared again just before the rename; a change means the read
/// is out of date, so the whole merge is redone (`update` runs again), and after
/// [`MERGE_ATTEMPTS`] it gives up having changed nothing. What remains is a write by the
/// owner between that last comparison and the rename itself.
pub(crate) fn merge_json_key(
    path: &Path,
    key: &str,
    mut update: impl FnMut(Option<&Value>) -> Result<Option<Value>, String>,
) -> Result<Option<Value>, String> {
    for _ in 0..MERGE_ATTEMPTS {
        let before = stamp(path)?;
        let mut root = read_json_object(path)?;
        let previous = root.get(key).cloned();
        let next = update(previous.as_ref())?;
        if next == previous {
            return Ok(previous);
        }
        match next {
            Some(value) => root.insert(key.to_string(), value),
            None => root.remove(key),
        };
        let mut text = serde_json::to_string_pretty(&Value::Object(root))
            .map_err(|error| format!("Failed to encode {}: {error}", path.display()))?;
        text.push('\n');
        let mode = match fs::metadata(path) {
            Ok(metadata) => {
                use std::os::unix::fs::PermissionsExt;
                metadata.permissions().mode() & 0o7777
            }
            Err(_) => 0o600,
        };
        let temp = write_temp(path, text.as_bytes(), mode)?;
        if stamp(path)? != before {
            let _ = fs::remove_file(&temp);
            continue;
        }
        return rename_into_place(&temp, path).map(|()| previous);
    }
    Err(format!(
        "{} kept changing while Gyredeck was updating it; nothing was changed. Try again.",
        path.display()
    ))
}

/// A private temporary file beside `path`, holding `bytes`, with `mode`. Created fresh
/// (`O_EXCL`), so nothing already at that name is followed or reused.
fn write_temp(path: &Path, bytes: &[u8], mode: u32) -> Result<PathBuf, String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or(0);
    let temp = parent.join(format!(".{file_name}.gyredeck-{}-{nanos}", std::process::id()));
    let written = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .custom_flags(libc::O_NOFOLLOW)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(bytes)?;
        // The umask narrowed the create; the file's own mode is set exactly.
        file.set_permissions(fs::Permissions::from_mode(mode))?;
        file.sync_all()
    })();
    written.map(|()| temp.clone()).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("Failed to write {}: {error}", path.display())
    })
}

/// A rename replaces whatever is at `path`, a symlink included, without following it.
fn rename_into_place(temp: &Path, path: &Path) -> Result<(), String> {
    fs::rename(temp, path).map_err(|error| {
        let _ = fs::remove_file(temp);
        format!("Failed to write {}: {error}", path.display())
    })
}

fn write_atomically(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    let temp = write_temp(path, bytes, mode)?;
    rename_into_place(&temp, path)
}

/// Run `body`, and put `files` back as they were if it fails: rewritten with their old bytes
/// and mode, or removed if they did not exist. A file that cannot be read beforehand stops
/// it before anything runs, since it could not be put back.
pub(crate) fn with_rollback<T>(
    files: &[PathBuf],
    body: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    use std::os::unix::fs::PermissionsExt;
    let mut saved = Vec::new();
    for path in files {
        match fs::read(path) {
            Ok(bytes) => {
                let mode = fs::metadata(path)
                    .map(|metadata| metadata.permissions().mode() & 0o7777)
                    .unwrap_or(0o600);
                saved.push((path.clone(), Some((bytes, mode))));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => saved.push((path.clone(), None)),
            Err(error) => return Err(format!("Failed to read {}: {error}", path.display())),
        }
    }
    body().inspect_err(|_| {
        for (path, before) in &saved {
            match before {
                Some((bytes, mode)) => {
                    let _ = write_atomically(path, bytes, *mode);
                }
                None => {
                    let _ = fs::remove_file(path);
                }
            }
        }
    })
}

/// The command agy is given: `sh` and the script, quoted for the shell.
pub(crate) fn our_command(script: &Path) -> String {
    let path = script.to_string_lossy().replace('\'', "'\\''");
    format!("sh '{path}'")
}

/// Ours is any command naming the script, wherever it was installed from. Chaining one of
/// those would run the script inside itself on every frame.
fn is_ours_command(command: &str) -> bool {
    command.contains(SCRIPT_NAME)
}

fn is_ours(status_line: &Value) -> bool {
    status_line
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(is_ours_command)
}

/// The command of a status line that was actually running, and is not ours.
fn running_command(status_line: Option<&Value>) -> Option<String> {
    let line = status_line?.as_object()?;
    if line.get("enabled").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let command = line.get("command")?.as_str()?.trim();
    (!command.is_empty() && !is_ours_command(command)).then(|| command.to_string())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomically(path, bytes, 0o600)
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("Failed to remove {}: {error}", path.display()))
        }
        _ => Ok(()),
    }
}

/// Everything the install could refuse over, checked before anything is changed: agy's
/// settings must parse, and `statusLine` must be an object or absent.
pub(crate) fn preflight(paths: &AgyStatusLinePaths) -> Result<(), String> {
    match read_json_object(&paths.settings)?.get(STATUS_LINE_KEY) {
        None | Some(Value::Object(_)) => Ok(()),
        Some(_) => Err(format!(
            "Refusing to change {}: statusLine is not an object",
            paths.settings.display()
        )),
    }
}

/// Install the script as agy's status line, keeping whatever the person had so it still
/// draws and can be put back.
pub(crate) fn install(paths: &AgyStatusLinePaths, bundled_script: &Path) -> Result<(), String> {
    preflight(paths)?;
    let source = fs::read(bundled_script)
        .map_err(|error| format!("Failed to read the bundled {SCRIPT_NAME}: {error}"))?;
    write_atomically(&paths.script(), &source, 0o644)?;
    let command = our_command(&paths.script());

    merge_json_key(&paths.settings, STATUS_LINE_KEY, |line| {
        let mut object = match line {
            None => Map::new(),
            Some(Value::Object(object)) => object.clone(),
            Some(_) => return Err("statusLine changed under the install; try again".to_string()),
        };
        let enable = |object: &mut Map<String, Value>| {
            object.insert("type".to_string(), Value::String("command".to_string()));
            object.insert("command".to_string(), Value::String(command.clone()));
            object.insert("enabled".to_string(), Value::Bool(true));
        };
        if line.is_some_and(is_ours) {
            // Reinstalling repairs ours, a status line switched off included; the record of
            // what was there before stays as it is.
            enable(&mut object);
            return Ok(Some(Value::Object(object)));
        }
        // Recorded before agy is pointed at the script, so a failure here changes nothing.
        let record = serde_json::json!({ "present": line.is_some(), "previous": line.cloned() });
        write_private(&paths.previous(), format!("{record}\n").as_bytes())?;
        let theirs = running_command(line);
        match &theirs {
            Some(theirs) => write_private(&paths.chain(), theirs.as_bytes())?,
            None => remove_if_present(&paths.chain())?,
        }
        enable(&mut object);
        if theirs.is_none() {
            // The script draws nothing of its own, so without this agy's default line goes.
            object.insert("stack_with_default".to_string(), Value::Bool(true));
        }
        Ok(Some(Value::Object(object)))
    })?;
    Ok(())
}

/// Whether agy will run this installation's script: a regular file, and a status line of
/// type `command`, switched on, naming it. An app updated past an install from before #230
/// has the hook but not this, and the panel names it out of date so the person installs again.
pub(crate) fn wired(paths: &AgyStatusLinePaths) -> bool {
    let command = our_command(&paths.script());
    fs::symlink_metadata(paths.script()).is_ok_and(|metadata| metadata.file_type().is_file())
        && read_json_object(&paths.settings).is_ok_and(|root| {
            root.get(STATUS_LINE_KEY).is_some_and(|line| {
                line.get("type").and_then(Value::as_str) == Some("command")
                    && line.get("enabled").and_then(Value::as_bool) == Some(true)
                    && line.get("command").and_then(Value::as_str) == Some(command.as_str())
            })
        })
}

/// What the install recorded: whether `statusLine` was there, and what it held.
fn read_record(paths: &AgyStatusLinePaths) -> Option<(bool, Option<Map<String, Value>>)> {
    let record: Value = serde_json::from_str(&fs::read_to_string(paths.previous()).ok()?).ok()?;
    let present = record.get("present")?.as_bool()?;
    Some((present, record.get("previous").and_then(Value::as_object).cloned()))
}

/// Put back the status line the person had before the install. A status line they set
/// since is theirs and is left alone. Either way the files this feature keeps go, the
/// payload included, since it carries the account email.
pub(crate) fn uninstall(paths: &AgyStatusLinePaths) -> Result<(), String> {
    let record = read_record(paths);
    merge_json_key(&paths.settings, STATUS_LINE_KEY, |line| {
        let Some(line) = line.filter(|value| is_ours(value)) else {
            return Ok(line.cloned());
        };
        let mut object = line.as_object().cloned().unwrap_or_default();
        match &record {
            Some((true, Some(before))) => {
                for key in OWNED_KEYS {
                    match before.get(key) {
                        Some(value) => object.insert(key.to_string(), value.clone()),
                        None => object.remove(key),
                    };
                }
            }
            Some((false, _)) => {
                for key in OWNED_KEYS {
                    object.remove(key);
                }
                if object.is_empty() {
                    return Ok(None);
                }
            }
            // No record to go by: agy's own empty default, which turns ours off.
            _ => {
                object.insert("type".to_string(), Value::String(String::new()));
                object.insert("command".to_string(), Value::String(String::new()));
                object.insert("enabled".to_string(), Value::Bool(false));
            }
        }
        Ok(Some(Value::Object(object)))
    })?;
    for path in [paths.chain(), paths.previous(), paths.payload(), paths.script()] {
        remove_if_present(&path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command, Stdio};

    const EMAIL: &str = "someone.private@example.com";
    /// 2026-10-26T05:00:00Z
    const T0: i64 = 1_792_990_800;

    fn script_source() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../adapters/antigravity").join(SCRIPT_NAME)
    }

    fn iso(seconds: i64) -> String {
        unix_seconds_to_iso(seconds).unwrap()
    }

    /// The captured shape (agy 1.4.7, 2026-10-26), values made up.
    fn payload(fetched: i64) -> Value {
        serde_json::json!({
            "cwd": "/tmp/x", "session_id": "s-1", "conversation_id": "c-1",
            "transcript_path": "/tmp/x.jsonl",
            "model": { "id": "m", "display_name": "M", "effort": "high" },
            "workspace": { "current_dir": "/tmp/x", "project_dir": "/tmp/x" },
            "version": "1.4.7", "product": "antigravity",
            "context_window": { "total_input_tokens": 1, "total_output_tokens": 2,
                "context_window_size": 3, "used_percentage": 4, "remaining_percentage": 96,
                "current_usage": { "input_tokens": 1, "output_tokens": 1,
                    "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 } },
            "exceeds_200k_tokens": false,
            "quota": {
                "3p-weekly": { "remaining_fraction": 0.75, "reset_time": iso(fetched + 3_600), "reset_in_seconds": 3_600 },
                "gemini-weekly": { "remaining_fraction": 0.2, "reset_time": iso(fetched + 7_200), "reset_in_seconds": 7_200 }
            },
            "agent_state": "idle", "sandbox": { "enabled": false },
            "plan_tier": "Antigravity Starter Quota", "email": EMAIL,
            "task_count": 0, "terminal_width": 120
        })
    }

    fn bytes(value: &Value) -> Vec<u8> {
        serde_json::to_vec(value).unwrap()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gyredeck-agy-statusline-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn paths(root: &Path) -> AgyStatusLinePaths {
        AgyStatusLinePaths {
            settings: root.join("home/.gemini/antigravity-cli/settings.json"),
            dir: root.join("home/.config/gyredeck"),
        }
    }

    fn write_settings(paths: &AgyStatusLinePaths, value: &Value) {
        fs::create_dir_all(paths.settings.parent().unwrap()).unwrap();
        fs::write(&paths.settings, serde_json::to_string_pretty(value).unwrap()).unwrap();
    }

    fn settings(paths: &AgyStatusLinePaths) -> Value {
        serde_json::from_str(&fs::read_to_string(&paths.settings).unwrap()).unwrap()
    }

    fn used_of(snapshot: &CodexUsageSnapshot, wanted: &str) -> f64 {
        snapshot
            .lines
            .iter()
            .find_map(|line| match line {
                CodexMetricLine::Progress { label, used, .. } if label == wanted => Some(*used),
                _ => None,
            })
            .unwrap()
    }

    // C1 -------------------------------------------------------------------------------

    #[test]
    fn c1_the_captured_shape_reads_and_every_unknown_shape_gives_nothing() {
        // Premise: the untouched fixture reads, so each rejection below is the mutation's.
        let good = parse_payload(&bytes(&payload(T0)), T0 + 10).expect("the captured shape reads");
        assert_eq!(good.lines.len(), 2);
        assert_eq!(good.lines[0].label, "Gemini Weekly");
        assert_eq!(good.lines[0].used, 80.0);
        assert_eq!(good.lines[1].label, "Claude and GPT Weekly");
        assert_eq!(good.lines[1].used, 25.0);
        assert_eq!(good.plan.as_deref(), Some("Antigravity Starter Quota"));

        type Mutation = fn(&mut Value);
        let cases: [(&str, Mutation); 13] = [
            ("no quota", |p| { p.as_object_mut().unwrap().remove("quota"); }),
            ("quota not an object", |p| p["quota"] = serde_json::json!([1])),
            ("only unknown buckets", |p| p["quota"] = serde_json::json!({ "x-daily": { "remaining_fraction": 0.5 } })),
            ("empty quota", |p| p["quota"] = serde_json::json!({})),
            ("bucket not an object", |p| p["quota"]["3p-weekly"] = serde_json::json!(0.5)),
            ("fraction as a string", |p| p["quota"]["3p-weekly"]["remaining_fraction"] = serde_json::json!("0.5")),
            ("fraction above 1", |p| p["quota"]["3p-weekly"]["remaining_fraction"] = serde_json::json!(1.5)),
            ("fraction below 0", |p| p["quota"]["3p-weekly"]["remaining_fraction"] = serde_json::json!(-0.1)),
            ("a percentage, not a fraction", |p| p["quota"]["gemini-weekly"]["remaining_fraction"] = serde_json::json!(80)),
            ("reset_time missing", |p| { p["quota"]["3p-weekly"].as_object_mut().unwrap().remove("reset_time"); }),
            ("reset_time not ISO", |p| p["quota"]["3p-weekly"]["reset_time"] = serde_json::json!("tomorrow")),
            ("reset_in_seconds negative", |p| p["quota"]["3p-weekly"]["reset_in_seconds"] = serde_json::json!(-5)),
            ("plan_tier not a string", |p| p["plan_tier"] = serde_json::json!(3)),
        ];
        for (name, mutate) in cases {
            let mut value = payload(T0);
            mutate(&mut value);
            assert!(parse_payload(&bytes(&value), T0 + 10).is_none(), "{name} must give no value");
        }
        assert!(parse_payload(b"not json", T0).is_none());
        assert!(parse_payload(b"[]", T0).is_none());
    }

    #[test]
    fn c1_the_file_must_be_a_small_regular_file() {
        let dir = scratch("file");
        let good = dir.join("good.json");
        fs::write(&good, bytes(&payload(T0))).unwrap();
        assert!(read_payload_file(&good).is_some(), "premise: a regular file reads");

        let link = dir.join("link.json");
        std::os::unix::fs::symlink(&good, &link).unwrap();
        assert!(read_payload_file(&link).is_none(), "a symlink is not followed");

        let big = dir.join("big.json");
        fs::write(&big, vec![b' '; (MAX_PAYLOAD_BYTES + 1) as usize]).unwrap();
        assert!(read_payload_file(&big).is_none(), "over 64 KiB is refused");

        assert!(read_payload_file(&dir).is_none(), "a directory is refused");
        let _ = fs::remove_dir_all(&dir);
    }

    // C2 -------------------------------------------------------------------------------

    #[test]
    fn c2_fetched_at_is_the_payload_time_not_now() {
        let fetched = T0 - 600;
        // Premise: the payload time, the mtime and now are three different instants.
        let mtime = T0 - 60;
        let now = T0;
        let status = parse_payload(&bytes(&payload(fetched)), mtime).unwrap();
        assert_eq!(status.fetched_at, fetched);
        let reading = reading_from(status, now);
        assert_eq!(reading.snapshot.fetched_at, iso(fetched));
        assert_ne!(reading.snapshot.fetched_at, iso(now));
        assert!(!reading.stale, "premise: ten minutes old is fresh");

        // A payload claiming a time after its own write is held to the write.
        let early_mtime = fetched - 30;
        assert_eq!(parse_payload(&bytes(&payload(fetched)), early_mtime).unwrap().fetched_at, early_mtime);
    }

    // C3 -------------------------------------------------------------------------------

    #[test]
    fn c3_every_fresh_reading_is_relayed_and_a_stale_one_never() {
        let first = reading_from(parse_payload(&bytes(&payload(T0)), T0).unwrap(), T0 + 60);
        let mut crossing = payload(T0);
        crossing["quota"]["gemini-weekly"]["remaining_fraction"] = serde_json::json!(0.05);
        let second = reading_from(parse_payload(&bytes(&crossing), T0).unwrap(), T0 + 60);
        // Premise: the same second, the same account, different numbers.
        assert_eq!(first.snapshot.fetched_at, second.snapshot.fetched_at);
        assert_eq!((used_of(&first.snapshot, "Gemini Weekly"), used_of(&second.snapshot, "Gemini Weekly")), (80.0, 95.0));
        assert!(!first.stale && !second.stale);

        let mut relayed = Vec::new();
        relay_if_fresh(&first, |s| relayed.push(used_of(s, "Gemini Weekly")));
        relay_if_fresh(&second, |s| relayed.push(used_of(s, "Gemini Weekly")));
        assert_eq!(relayed, [80.0, 95.0], "a change within the same second reaches the bridge");

        // A POST that failed, or a bridge that restarted: the unchanged file must go again.
        relay_if_fresh(&second, |s| relayed.push(used_of(s, "Gemini Weekly")));
        assert_eq!(relayed, [80.0, 95.0, 95.0], "the next refresh posts it again");

        let stale = reading_from(
            parse_payload(&bytes(&payload(T0)), T0).unwrap(),
            T0 + STALE_AFTER.as_secs() as i64 + 1,
        );
        assert!(stale.stale);
        let mut stale_relays = 0;
        relay_if_fresh(&stale, |_| stale_relays += 1);
        assert_eq!(stale_relays, 0, "a stale reading is not relayed");
        assert!(
            stale.snapshot.lines.iter().any(|line| matches!(line, CodexMetricLine::Text { label, .. } if label == "Status")),
            "a stale reading is marked for the panel"
        );
        assert!(
            !first.snapshot.lines.iter().any(|line| matches!(line, CodexMetricLine::Text { .. })),
            "a fresh one is not"
        );
    }

    // C4 -------------------------------------------------------------------------------

    #[test]
    fn c4_a_fresh_status_line_never_reaches_the_token_fallback() {
        let fallback_snapshot = || CodexUsageSnapshot {
            provider_id: "agy".into(),
            display_name: "Antigravity".into(),
            plan: None,
            lines: Vec::new(),
            fetched_at: iso(T0),
        };
        let reading = |now| reading_from(parse_payload(&bytes(&payload(T0)), T0).unwrap(), now);
        let stale_now = T0 + STALE_AFTER.as_secs() as i64 + 1;

        // (status line, fallback answers, calls expected, answer from the status line)
        let cases: [(&str, Option<AgyStatusLineReading>, bool, u32, bool); 5] = [
            ("fresh", Some(reading(T0 + 1)), true, 0, true),
            ("fresh, fallback failing", Some(reading(T0 + 1)), false, 0, true),
            ("stale, fallback answers", Some(reading(stale_now)), true, 1, false),
            ("stale, fallback fails", Some(reading(stale_now)), false, 1, true),
            ("none", None, true, 1, false),
        ];
        for (name, status, answers, expected_calls, from_status_line) in cases {
            let mut calls = 0;
            let outcome = choose_usage(status, || {
                calls += 1;
                if answers { Ok(fallback_snapshot()) } else { Err("no".into()) }
            });
            assert_eq!(calls, expected_calls, "{name}: fallback calls");
            assert_eq!(matches!(outcome, Ok(AgyUsage::StatusLine(_))), from_status_line, "{name}: source");
        }
    }

    // C5 -------------------------------------------------------------------------------

    #[test]
    fn c5_the_email_is_never_kept_or_relayed() {
        let fixture = bytes(&payload(T0));
        assert!(String::from_utf8_lossy(&fixture).contains(EMAIL), "premise: the payload carries the email");

        let status = parse_payload(&fixture, T0).unwrap();
        assert!(!format!("{status:?}").contains(EMAIL), "nothing kept holds the email");

        let reading = reading_from(status, T0 + 1);
        let mut body = String::new();
        relay_if_fresh(&reading, |snapshot| body = serde_json::to_string(snapshot).unwrap());
        assert!(!body.is_empty(), "premise: the reading was relayed");
        assert!(!body.contains(EMAIL), "the relayed body carries no email");
        assert!(!body.contains("\"email\""), "nor an email key");
        assert!(!body.contains("session_id") && !body.contains("conversation_id"));
    }

    // C6 -------------------------------------------------------------------------------

    fn run_script(paths: &AgyStatusLinePaths, home: &Path, input: &[u8]) -> (i32, String) {
        let mut child = Command::new("sh")
            .arg(paths.script())
            .env("HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let output = child.wait_with_output().unwrap();
        (output.status.code().unwrap_or(-1), String::from_utf8_lossy(&output.stdout).to_string())
    }

    #[test]
    fn c6_installing_over_a_status_line_keeps_its_output_and_uninstall_restores_it() {
        let root = scratch("chain");
        let home = root.join("home");
        let paths = paths(&root);
        let theirs = serde_json::json!({
            "type": "command", "command": "printf 'mine:'; head -c 9", "enabled": true, "padding": 1
        });
        let original = serde_json::json!({ "theme": "dark", "statusLine": theirs, "trustedWorkspaces": ["/a"] });
        write_settings(&paths, &original);

        let input = bytes(&payload(T0));
        let drawn = format!("mine:{}", String::from_utf8_lossy(&input[..9]));
        // Premise: their command alone draws this from the payload.
        let mut alone = Command::new("sh")
            .args(["-c", "printf 'mine:'; head -c 9"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        alone.stdin.take().unwrap().write_all(&input).unwrap();
        assert_eq!(String::from_utf8_lossy(&alone.wait_with_output().unwrap().stdout), drawn);

        assert!(!wired(&paths), "premise: not wired before the install");
        install(&paths, &script_source()).unwrap();
        assert!(wired(&paths), "wired after the install");
        let installed = settings(&paths);
        assert!(is_ours(&installed["statusLine"]), "agy now runs the script");
        assert_eq!(installed["statusLine"]["type"], "command");
        assert_eq!(installed["statusLine"]["enabled"], true);
        assert!(installed["statusLine"].get("stack_with_default").is_none(), "theirs draws, so no default line is stacked");
        assert_eq!(installed["statusLine"]["padding"], 1);
        assert_eq!(installed["theme"], "dark");
        assert_eq!(installed["trustedWorkspaces"], serde_json::json!(["/a"]));

        let (code, out) = run_script(&paths, &home, &input);
        assert_eq!(code, 0);
        assert_eq!(out, drawn, "their output is what agy draws");
        assert_eq!(fs::read(paths.payload()).unwrap(), input, "the payload is kept whole");
        assert_eq!(fs::metadata(paths.payload()).unwrap().permissions().mode() & 0o777, 0o600);

        // A second install must not record our own command as theirs.
        install(&paths, &script_source()).unwrap();
        let (_, again) = run_script(&paths, &home, &input);
        assert_eq!(again, drawn, "reinstall keeps their command chained");

        uninstall(&paths).unwrap();
        assert!(!wired(&paths), "not wired after the uninstall");
        assert_eq!(settings(&paths), original, "uninstall puts their status line back");
        for gone in [paths.payload(), paths.chain(), paths.previous(), paths.script()] {
            assert!(!gone.exists(), "{} removed", gone.display());
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn c6_without_a_status_line_of_their_own_the_default_line_is_kept() {
        // (name, settings before)
        let cases = [
            ("agy's empty default", serde_json::json!({ "statusLine": { "type": "", "command": "", "enabled": false } })),
            ("a switched-off command", serde_json::json!({ "statusLine": { "type": "command", "command": "echo off", "enabled": false } })),
            ("no statusLine key at all", serde_json::json!({ "theme": "dark" })),
            ("stack_with_default already false", serde_json::json!({ "statusLine": { "type": "", "command": "", "enabled": false, "stack_with_default": false } })),
        ];
        for (name, original) in cases {
            let root = scratch("plain");
            let home = root.join("home");
            let paths = paths(&root);
            write_settings(&paths, &original);

            install(&paths, &script_source()).unwrap();
            assert!(!paths.chain().exists(), "{name}: nothing to chain");
            assert_eq!(settings(&paths)["statusLine"]["stack_with_default"], true, "{name}: agy's default line stays");
            let (code, out) = run_script(&paths, &home, b"{}");
            assert_eq!((code, out.as_str()), (0, ""), "{name}");

            uninstall(&paths).unwrap();
            assert_eq!(settings(&paths), original, "{name}: uninstall restores exactly, an absent key included");
            let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn c6_our_own_command_is_never_chained() {
        let root = scratch("self");
        let paths = paths(&root);
        write_settings(&paths, &serde_json::json!({ "statusLine": { "type": "command", "enabled": true,
            "command": "sh '/elsewhere/gyredeck-agy-statusline.sh'" } }));
        install(&paths, &script_source()).unwrap();
        assert!(!paths.chain().exists(), "our own command is never chained");
        let ours_running = serde_json::json!({ "enabled": true, "command": "sh '/x/gyredeck-agy-statusline.sh'" });
        assert_eq!(running_command(Some(&serde_json::json!({ "enabled": true, "command": "echo hi" }))).as_deref(), Some("echo hi"), "premise");
        assert_eq!(running_command(Some(&ours_running)), None, "ours is never a command to chain");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn c6_a_status_line_set_after_install_is_left_alone_by_uninstall() {
        let root = scratch("theirs-later");
        let paths = paths(&root);
        install(&paths, &script_source()).unwrap();
        let mut current = settings(&paths);
        current["statusLine"]["command"] = Value::String("echo new".into());
        fs::write(&paths.settings, current.to_string()).unwrap();
        assert!(paths.script().is_file(), "premise: the script is still in place");
        assert!(!wired(&paths), "a status line of theirs is not ours wired");
        uninstall(&paths).unwrap();
        assert_eq!(settings(&paths), current);
        let _ = fs::remove_dir_all(&root);
    }

    // C8 -------------------------------------------------------------------------------

    #[test]
    fn c8_installing_over_a_symlinked_script_leaves_its_target_alone() {
        let root = scratch("script-link");
        let paths = paths(&root);
        fs::create_dir_all(&paths.dir).unwrap();
        let victim = root.join("victim.txt");
        fs::write(&victim, b"keep me").unwrap();
        std::os::unix::fs::symlink(&victim, paths.script()).unwrap();
        assert!(fs::symlink_metadata(paths.script()).unwrap().file_type().is_symlink(), "premise: a link");

        install(&paths, &script_source()).unwrap();
        assert_eq!(fs::read(&victim).unwrap(), b"keep me", "the link's target is byte-identical");
        assert!(fs::symlink_metadata(paths.script()).unwrap().file_type().is_file(), "the link was replaced");
        assert_eq!(fs::read(paths.script()).unwrap(), fs::read(script_source()).unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    // C9 -------------------------------------------------------------------------------

    #[test]
    fn c9_a_switched_off_or_unsupported_status_line_is_not_wired_and_install_repairs_it() {
        type Mutation = fn(&mut Value);
        let cases: [(&str, Mutation); 3] = [
            ("switched off", |s| s["statusLine"]["enabled"] = Value::Bool(false)),
            ("type not command", |s| s["statusLine"]["type"] = Value::String(String::new())),
            ("enabled missing", |s| { s["statusLine"].as_object_mut().unwrap().remove("enabled"); }),
        ];
        for (name, mutate) in cases {
            let root = scratch("wired");
            let paths = paths(&root);
            install(&paths, &script_source()).unwrap();
            assert!(wired(&paths), "{name}: premise, wired after install");
            let mut current = settings(&paths);
            mutate(&mut current);
            fs::write(&paths.settings, current.to_string()).unwrap();
            assert!(!wired(&paths), "{name}: not wired");

            install(&paths, &script_source()).unwrap();
            let repaired = settings(&paths);
            assert_eq!(repaired["statusLine"]["type"], "command", "{name}");
            assert_eq!(repaired["statusLine"]["enabled"], true, "{name}");
            assert!(wired(&paths), "{name}: install repairs it");
            let _ = fs::remove_dir_all(&root);
        }
    }

    // C7 -------------------------------------------------------------------------------

    #[test]
    fn c7_merge_changes_one_key_keeps_the_rest_and_the_mode() {
        let dir = scratch("merge");
        let path = dir.join("settings.json");
        let original = serde_json::json!({ "a": 1, "nested": { "b": [1, 2] }, "statusLine": { "x": 1 } });
        fs::write(&path, original.to_string()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        // Premise: the mode is not what a fresh file would get.
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);

        let previous = merge_json_key(&path, "statusLine", |_| Ok(Some(serde_json::json!({ "y": 2 })))).unwrap();
        assert_eq!(previous, Some(serde_json::json!({ "x": 1 })));
        let after: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after, serde_json::json!({ "a": 1, "nested": { "b": [1, 2] }, "statusLine": { "y": 2 } }));
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640, "mode kept");
        let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(Result::ok).filter(|e| e.file_name() != "settings.json").collect();
        assert!(leftovers.is_empty(), "no temporary file left behind");

        merge_json_key(&path, "statusLine", |_| Ok(None)).unwrap();
        let removed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(removed, serde_json::json!({ "a": 1, "nested": { "b": [1, 2] } }));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn c7_a_write_by_agy_during_the_merge_is_kept() {
        let dir = scratch("concurrent");
        let path = dir.join("settings.json");
        fs::write(&path, serde_json::json!({ "theme": "dark", "statusLine": {} }).to_string()).unwrap();
        let mut calls = 0;
        merge_json_key(&path, "statusLine", |_| {
            calls += 1;
            if calls == 1 {
                // agy saves a setting while the merge is under way.
                fs::write(&path, serde_json::json!({ "theme": "light, saved by agy", "statusLine": {} }).to_string()).unwrap();
            }
            Ok(Some(serde_json::json!({ "ours": true })))
        })
        .unwrap();
        assert_eq!(calls, 2, "premise: the change was seen and the merge redone");
        let after: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["theme"], "light, saved by agy", "agy's write survives");
        assert_eq!(after["statusLine"], serde_json::json!({ "ours": true }));

        // A file that never stops changing is given up on, unchanged by us.
        let mut n = 0;
        let outcome = merge_json_key(&path, "statusLine", |_| {
            n += 1;
            fs::write(&path, serde_json::json!({ "theme": n.to_string(), "statusLine": {} }).to_string()).unwrap();
            Ok(Some(serde_json::json!({ "ours": "again" })))
        });
        assert!(outcome.is_err(), "it gives up");
        let last: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(last["statusLine"], serde_json::json!({}), "and wrote nothing of its own");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn c7_merge_refuses_rather_than_clobbering() {
        let dir = scratch("refuse");
        let cases: [(&str, &[u8]); 3] = [
            ("unparsable", b"{ \"a\": 1, }"),
            ("not an object", b"[1, 2]"),
            ("truncated", b"{ \"statusLine\": {"),
        ];
        for (name, content) in cases {
            let path = dir.join(format!("{name}.json"));
            fs::write(&path, content).unwrap();
            let mut asked = false;
            let outcome = merge_json_key(&path, "statusLine", |_| {
                asked = true;
                Ok(Some(Value::Bool(true)))
            });
            assert!(outcome.is_err(), "{name}: refused");
            assert!(!asked, "{name}: refused before the update ran");
            assert_eq!(fs::read(&path).unwrap(), content, "{name}: byte-identical");
        }

        let target = dir.join("target.json");
        fs::write(&target, b"{}").unwrap();
        let link = dir.join("link.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(merge_json_key(&link, "statusLine", |_| Ok(Some(Value::Bool(true)))).is_err(), "a symlink is refused");
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "and stays a symlink");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn c7_install_refuses_before_changing_anything() {
        let cases: [(&str, &[u8]); 3] = [
            ("unparsable", b"{ broken"),
            ("statusLine a boolean", b"{ \"statusLine\": true }"),
            ("statusLine a string", b"{ \"statusLine\": \"sh x\" }"),
        ];
        for (name, content) in cases {
            let root = scratch("refuse-install");
            let paths = paths(&root);
            fs::create_dir_all(paths.settings.parent().unwrap()).unwrap();
            fs::write(&paths.settings, content).unwrap();
            assert!(preflight(&paths).is_err(), "{name}: the preflight refuses");
            assert!(install(&paths, &script_source()).is_err(), "{name}: install refuses");
            assert!(!paths.script().exists(), "{name}: a refusal leaves nothing behind");
            assert_eq!(fs::read(&paths.settings).unwrap(), content, "{name}");
            let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn c7_a_failed_install_puts_the_hook_files_back() {
        let dir = scratch("rollback");
        let existing = dir.join("hooks.json");
        let absent = dir.join("gyredeck-agy-hook.mjs");
        fs::write(&existing, b"{\"theirs\":1}").unwrap();
        fs::set_permissions(&existing, fs::Permissions::from_mode(0o640)).unwrap();
        // Premise: one file there, one not.
        assert!(!absent.exists());

        let outcome: Result<(), String> = with_rollback(&[existing.clone(), absent.clone()], || {
            fs::write(&existing, b"{\"gyredeck\":1}").unwrap();
            fs::write(&absent, b"copied").unwrap();
            Err("statusLine refused".into())
        });
        assert!(outcome.is_err());
        assert_eq!(fs::read(&existing).unwrap(), b"{\"theirs\":1}", "the old bytes are back");
        assert_eq!(fs::metadata(&existing).unwrap().permissions().mode() & 0o777, 0o640, "with their mode");
        assert!(!absent.exists(), "a file that was not there is gone again");

        let kept: Result<(), String> = with_rollback(&[existing.clone()], || {
            fs::write(&existing, b"new").unwrap();
            Ok(())
        });
        assert!(kept.is_ok());
        assert_eq!(fs::read(&existing).unwrap(), b"new", "success keeps the changes");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn c7_an_unchanged_value_is_not_rewritten() {
        let dir = scratch("unchanged");
        let path = dir.join("settings.json");
        let text = "{\"statusLine\":{\"x\":1},   \"z\":0}";
        fs::write(&path, text).unwrap();
        merge_json_key(&path, "statusLine", |current| Ok(current.cloned())).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), text, "the file is untouched");
        let _ = fs::remove_dir_all(&dir);
    }
}
