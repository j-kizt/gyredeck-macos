//! Antigravity usage from agy's own status-line payload (#230): no token is read and no
//! network call is made.
//!
//! agy runs a status-line command on every TUI update and hands it a JSON payload whose
//! `quota` carries each bucket's `remaining_fraction`, `reset_time` and `reset_in_seconds`.
//! The app installs `gyredeck-agy-statusline.sh` as that command; it keeps the payload in
//! `~/.config/gyredeck/agy-statusline.json` and runs the person's own status line, if they
//! had one, on the same input. This module reads that file, and owns the one key of agy's
//! `settings.json` the install changes.
//!
//! Invariants, each pinned by a test that was made to fail:
//! - C1  An unknown shape gives no value: no `quota`, a wrongly typed or out-of-range known
//!       bucket, or no known bucket at all. The format is undocumented and still changing.
//! - C2  `fetched_at` is the payload's time (`reset_time − reset_in_seconds`, never later
//!       than the file's mtime), not the time it was read.
//! - C3  An unchanged reading is relayed once; a stale one is marked stale and not relayed.
//! - C4  With a fresh status-line value, the token-reading fallback is not called at all.
//! - C5  The account email is never kept, logged or relayed: it is reduced to a hash in
//!       memory, used only to tell accounts apart.
//! - C6  Installing over a person's status line keeps its output; uninstalling restores it.
//!       Our own command is never chained, which would recurse on every frame.
//! - C7  `settings.json` is agy's file: only `statusLine` changes, every other key survives,
//!       the write is atomic with the file's mode kept, and a file that does not parse is
//!       refused rather than overwritten.

use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::{
    unix_seconds_to_iso, CodexMetricLine, CodexProgressFormat, CodexUsageSnapshot,
    AGY_QUOTA_BUCKETS,
};

pub(crate) const SCRIPT_NAME: &str = "gyredeck-agy-statusline.sh";
const PAYLOAD_FILE: &str = "agy-statusline.json";
const CHAIN_FILE: &str = "agy-statusline.chain";
const PREVIOUS_FILE: &str = "agy-statusline.previous.json";
const STATUS_LINE_KEY: &str = "statusLine";
const MAX_PAYLOAD_BYTES: u64 = 64 * 1024;
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

    fn chain(&self) -> PathBuf {
        self.dir.join(CHAIN_FILE)
    }

    fn previous(&self) -> PathBuf {
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
    account_key: Option<String>,
    fetched_at: i64,
}

/// One bucket as read, kept apart from `CodexMetricLine` so readings can be compared.
#[derive(Debug, Clone, PartialEq)]
struct Bucket {
    label: &'static str,
    used: f64,
    resets_at: String,
    period_duration_ms: u64,
}

/// The payload as far as this reader is concerned. Everything else in it is ignored, and
/// `email` goes no further than [`account_key`].
#[derive(serde::Deserialize)]
struct Payload {
    quota: Map<String, Value>,
    #[serde(default)]
    plan_tier: Option<Value>,
    #[serde(default)]
    email: Option<Value>,
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
    let account_key = match payload.email {
        None | Some(Value::Null) => None,
        Some(Value::String(email)) => account_key(&email),
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
        account_key,
        // The file can be touched without agy writing it; the payload cannot claim a time
        // after its own write.
        fetched_at: fetched_at.min(mtime),
    })
}

/// Tells one agy account from another without keeping who it is. The plaintext never
/// leaves this function; the hash lives only in memory.
fn account_key(email: &str) -> Option<String> {
    let email = email.trim().to_lowercase();
    if email.is_empty() {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(b"gyredeck-agy-account\0");
    hasher.update(email.as_bytes());
    let digest = hasher.finalize();
    Some(digest[..16].iter().map(|byte| format!("{byte:02x}")).collect())
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
    key: (Option<String>, i64),
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
        key: (status.account_key, status.fetched_at),
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

/// The last relayed reading: which account, and the payload time.
pub(crate) type RelayMark = Mutex<Option<(Option<String>, i64)>>;
pub(crate) static LAST_RELAYED: RelayMark = Mutex::new(None);

/// Relay a fresh reading the bridge has not had yet. The bridge believes the body's
/// `fetchedAt`, so a stale or repeated one would be taken as news (#192). A reading from
/// another account is news whatever its time.
pub(crate) fn relay_if_newer(
    reading: &AgyStatusLineReading,
    mark: &RelayMark,
    relay: impl FnOnce(&CodexUsageSnapshot),
) {
    if reading.stale {
        return;
    }
    let Ok(mut last) = mark.lock() else {
        return;
    };
    let news = match last.as_ref() {
        None => true,
        Some((account, at)) => *account != reading.key.0 || reading.key.1 > *at,
    };
    if news {
        relay(&reading.snapshot);
        *last = Some(reading.key.clone());
    }
}

// ---------------------------------------------------------------------------------------
// agy's settings.json
// ---------------------------------------------------------------------------------------

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
/// not change. The write goes to a temporary file beside it, given the file's own mode, and
/// is renamed over it, so a reader never sees half a file. Returns the previous value.
///
/// The read and the rename are not one step: a write by the owner in between is lost. agy
/// rewrites its settings only on a settings change, so the window is a person changing a
/// setting in the same instant they press Install.
pub(crate) fn merge_json_key(
    path: &Path,
    key: &str,
    update: impl FnOnce(Option<&Value>) -> Result<Option<Value>, String>,
) -> Result<Option<Value>, String> {
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
    write_atomically(path, text.as_bytes(), mode)?;
    Ok(previous)
}

fn write_atomically(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
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
            .mode(0o600)
            .open(&temp)?;
        file.write_all(bytes)?;
        // The umask narrowed the create; the file's own mode is set exactly.
        file.set_permissions(fs::Permissions::from_mode(mode))?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    written.map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("Failed to write {}: {error}", path.display())
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

/// Install the script as agy's status line, keeping whatever the person had so it still
/// draws and can be put back.
pub(crate) fn install(paths: &AgyStatusLinePaths, bundled_script: &Path) -> Result<(), String> {
    // Everything that can refuse, before anything that can change.
    let current = read_json_object(&paths.settings)?;
    if let Some(line) = current.get(STATUS_LINE_KEY) {
        if !line.is_object() && !line.is_null() {
            return Err(format!(
                "Refusing to change {}: statusLine is not an object",
                paths.settings.display()
            ));
        }
    }
    fs::create_dir_all(&paths.dir)
        .map_err(|error| format!("Failed to create {}: {error}", paths.dir.display()))?;
    let script = paths.script();
    fs::copy(bundled_script, &script)
        .map_err(|error| format!("Failed to copy {SCRIPT_NAME}: {error}"))?;
    let command = our_command(&script);

    merge_json_key(&paths.settings, STATUS_LINE_KEY, |line| {
        let line = line.filter(|value| !value.is_null());
        if line.is_some_and(is_ours) {
            let mut object = line.and_then(Value::as_object).cloned().unwrap_or_default();
            object.insert("command".to_string(), Value::String(command.clone()));
            return Ok(Some(Value::Object(object)));
        }
        if let Some(line) = line {
            if !line.is_object() {
                return Err("statusLine changed under the install; try again".to_string());
            }
        }
        // Recorded before agy is pointed at the script, so a failure here changes nothing.
        let record = serde_json::json!({ "previous": line.cloned() });
        write_private(&paths.previous(), format!("{record}\n").as_bytes())?;
        match running_command(line) {
            Some(theirs) => write_private(&paths.chain(), theirs.as_bytes())?,
            None => remove_if_present(&paths.chain())?,
        }
        let mut object = line.and_then(Value::as_object).cloned().unwrap_or_default();
        object.insert("type".to_string(), Value::String("command".to_string()));
        object.insert("command".to_string(), Value::String(command.clone()));
        object.insert("enabled".to_string(), Value::Bool(true));
        Ok(Some(Value::Object(object)))
    })?;
    Ok(())
}

/// Whether agy runs this installation's script as its status line. An app updated past an
/// install from before #230 has the hook but not this, and the panel names it out of date so
/// the person knows to install again.
pub(crate) fn wired(paths: &AgyStatusLinePaths) -> bool {
    let command = our_command(&paths.script());
    paths.script().is_file()
        && read_json_object(&paths.settings).is_ok_and(|root| {
            root.get(STATUS_LINE_KEY)
                .and_then(|line| line.get("command"))
                .and_then(Value::as_str)
                == Some(command.as_str())
        })
}

/// Put back the status line the person had before the install. A status line they set
/// since is theirs and is left alone. Either way the files this feature keeps go, the
/// payload included, since it carries the account email.
pub(crate) fn uninstall(paths: &AgyStatusLinePaths) -> Result<(), String> {
    let previous = match fs::read_to_string(paths.previous()) {
        Ok(text) => serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|record| record.get("previous").cloned()),
        Err(_) => None,
    };
    merge_json_key(&paths.settings, STATUS_LINE_KEY, |line| {
        let Some(line) = line.filter(|value| is_ours(value)) else {
            return Ok(line.cloned());
        };
        let mut object = line.as_object().cloned().unwrap_or_default();
        match previous.as_ref() {
            Some(Value::Object(before)) => {
                for key in ["type", "command", "enabled"] {
                    match before.get(key) {
                        Some(value) => object.insert(key.to_string(), value.clone()),
                        None => object.remove(key),
                    };
                }
            }
            // No record, or no status line before: agy's own empty default.
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
        let cases: [(&str, Mutation); 14] = [
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
            ("email not a string", |p| p["email"] = serde_json::json!({ "a": 1 })),
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
    fn c3_an_unchanged_reading_is_relayed_once_and_a_stale_one_never() {
        let mark: RelayMark = Mutex::new(None);
        let fresh = reading_from(parse_payload(&bytes(&payload(T0)), T0).unwrap(), T0 + 60);
        assert!(!fresh.stale, "premise: fresh");
        let mut relayed = Vec::new();
        relay_if_newer(&fresh, &mark, |s| relayed.push(s.fetched_at.clone()));
        relay_if_newer(&fresh, &mark, |s| relayed.push(s.fetched_at.clone()));
        assert_eq!(relayed.len(), 1, "the same reading twice is one relay");

        let later = reading_from(parse_payload(&bytes(&payload(T0 + 30)), T0 + 30).unwrap(), T0 + 60);
        relay_if_newer(&later, &mark, |s| relayed.push(s.fetched_at.clone()));
        assert_eq!(relayed.len(), 2, "a newer reading is relayed");

        let older = reading_from(parse_payload(&bytes(&payload(T0 + 10)), T0 + 10).unwrap(), T0 + 60);
        relay_if_newer(&older, &mark, |s| relayed.push(s.fetched_at.clone()));
        assert_eq!(relayed.len(), 2, "an older reading of the same account is not");

        let mut other = payload(T0 + 10);
        other["email"] = serde_json::json!("other@example.com");
        let switched = reading_from(parse_payload(&bytes(&other), T0 + 10).unwrap(), T0 + 60);
        relay_if_newer(&switched, &mark, |s| relayed.push(s.fetched_at.clone()));
        assert_eq!(relayed.len(), 3, "another account's reading is news");

        let stale_mark: RelayMark = Mutex::new(None);
        let stale = reading_from(
            parse_payload(&bytes(&payload(T0)), T0).unwrap(),
            T0 + STALE_AFTER.as_secs() as i64 + 1,
        );
        assert!(stale.stale);
        let mut stale_relays = 0;
        relay_if_newer(&stale, &stale_mark, |_| stale_relays += 1);
        assert_eq!(stale_relays, 0, "a stale reading is not relayed");
        assert!(
            stale.snapshot.lines.iter().any(|line| matches!(line, CodexMetricLine::Text { label, .. } if label == "Status")),
            "a stale reading is marked for the panel"
        );
        assert!(
            !fresh.snapshot.lines.iter().any(|line| matches!(line, CodexMetricLine::Text { .. })),
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
        let key = status.account_key.clone().expect("an account key from the email");
        assert!(!key.contains(EMAIL) && !key.contains("example"), "the key is not the plaintext");
        assert!(!format!("{status:?}").contains(EMAIL), "nothing kept holds the email");

        let reading = reading_from(status, T0 + 1);
        let mark: RelayMark = Mutex::new(None);
        let mut body = String::new();
        relay_if_newer(&reading, &mark, |snapshot| body = serde_json::to_string(snapshot).unwrap());
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

    fn settings(paths: &AgyStatusLinePaths) -> Value {
        serde_json::from_str(&fs::read_to_string(&paths.settings).unwrap()).unwrap()
    }

    #[test]
    fn c6_installing_over_a_status_line_keeps_its_output_and_uninstall_restores_it() {
        let root = scratch("chain");
        let home = root.join("home");
        let paths = paths(&root);
        fs::create_dir_all(paths.settings.parent().unwrap()).unwrap();
        let theirs = serde_json::json!({
            "type": "command", "command": "printf 'mine:'; head -c 9", "enabled": true,
            "stack_with_default": true, "padding": 1
        });
        let original = serde_json::json!({ "theme": "dark", "statusLine": theirs, "trustedWorkspaces": ["/a"] });
        fs::write(&paths.settings, serde_json::to_string_pretty(&original).unwrap()).unwrap();

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
        assert_eq!(installed["statusLine"]["enabled"], true);
        assert_eq!(installed["statusLine"]["stack_with_default"], true, "stack_with_default left alone");
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
    fn c6_without_a_status_line_the_script_prints_nothing_and_never_chains_itself() {
        let root = scratch("plain");
        let home = root.join("home");
        let paths = paths(&root);
        fs::create_dir_all(paths.settings.parent().unwrap()).unwrap();
        let original = serde_json::json!({ "statusLine": { "type": "", "command": "", "enabled": false } });
        fs::write(&paths.settings, serde_json::to_string(&original).unwrap()).unwrap();

        install(&paths, &script_source()).unwrap();
        assert!(!paths.chain().exists(), "nothing to chain");
        let (code, out) = run_script(&paths, &home, b"{}");
        assert_eq!((code, out.as_str()), (0, ""));

        // Our command from another install path, as the person's "own": never chained.
        let mut current = settings(&paths);
        current["statusLine"]["command"] = Value::String("sh '/elsewhere/gyredeck-agy-statusline.sh'".into());
        fs::write(&paths.settings, current.to_string()).unwrap();
        install(&paths, &script_source()).unwrap();
        assert!(!paths.chain().exists(), "our own command is never chained");
        let ours_running = serde_json::json!({ "enabled": true, "command": "sh '/x/gyredeck-agy-statusline.sh'" });
        assert_eq!(running_command(Some(&serde_json::json!({ "enabled": true, "command": "echo hi" }))).as_deref(), Some("echo hi"), "premise");
        assert_eq!(running_command(Some(&ours_running)), None, "ours is never a command to chain");

        uninstall(&paths).unwrap();
        assert_eq!(settings(&paths), original);
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

        // Install refuses on an unparsable settings.json before copying anything.
        let root = scratch("refuse-install");
        let paths = paths(&root);
        fs::create_dir_all(paths.settings.parent().unwrap()).unwrap();
        fs::write(&paths.settings, b"{ broken").unwrap();
        assert!(install(&paths, &script_source()).is_err());
        assert!(!paths.script().exists(), "a refusal leaves nothing behind");
        assert_eq!(fs::read(&paths.settings).unwrap(), b"{ broken");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&root);
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
