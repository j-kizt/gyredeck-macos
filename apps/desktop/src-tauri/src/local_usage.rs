//! Usage from the agent's own files before the provider's API (#398).
//!
//! Claude Code hands its status line `rate_limits` on every update, and Codex writes
//! `rate_limits` into each session log. The provider is still asked every refresh; a reading
//! from either, for the same account and newer than the provider's answer, is shown in its
//! place. Its Session and Weekly lines replace those of the last API answer for that
//! account, so Plan, resets and credits still come from the provider.
//!
//! Invariants, each pinned by a test that was made to fail:
//! - L1  Whose: a Codex log counts only when its `creator_account_id` is the login's
//!       `account_id`; a Claude status line only for the config dir the app reads and a
//!       Weekly reset within 60 s of the last API answer's. Otherwise the API is asked.
//! - L2  Cheapest: a same-account reading no older than the interval makes no API call;
//!       older or missing makes exactly one, and the answer is labelled `api`.
//! - L3  `fetched_at` is the time the file recorded, never later than its mtime.
//! - L4  When the API fails, a newer local reading is shown but marked not fresh, so it is
//!       never relayed.
//! - L5  The local lines carry the API's labels, so the bridge compares like with like.

use std::{
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, UNIX_EPOCH},
};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    hex_lower, progress_metric, unix_seconds_to_iso, CodexMetricLine, CodexUsageSnapshot,
    UsageReading, UsageSource, SESSION_LABEL, SESSION_PERIOD_MS, WEEKLY_LABEL, WEEKLY_PERIOD_MS,
};

pub(crate) const REFRESH_MINUTES: [u64; 4] = [5, 15, 30, 60];
const DEFAULT_REFRESH: Duration = Duration::from_secs(5 * 60);
const RESET_MATCH_SECONDS: i64 = 60;
const LOG_DAY_DIRS: usize = 7;
const LOG_CANDIDATES: usize = 8;
const LOG_FILES_READ: usize = 5;
const LOG_HEAD_BYTES: u64 = 256 * 1024;
const LOG_TAIL_BYTES: u64 = 256 * 1024;
const STATUS_LINE_MAX_BYTES: u64 = 64 * 1024;
const FETCH_FAILED: &str = "Login valid, fetch failed, last reading kept.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UsageMode {
    Left,
    Used,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct UsageSettings {
    pub(crate) refresh: Duration,
    /// Left or Used, as the panel shows it; `/usage` on Discord follows it (#396).
    pub(crate) mode: UsageMode,
}

static SETTINGS: Mutex<UsageSettings> =
    Mutex::new(UsageSettings { refresh: DEFAULT_REFRESH, mode: UsageMode::Left });

/// What the webview sent, or the default for anything not on the list.
pub(crate) fn settings_from(refresh_ms: &Value, usage_mode: &Value) -> UsageSettings {
    let refresh = refresh_ms
        .as_u64()
        .filter(|ms| ms % 60_000 == 0 && REFRESH_MINUTES.contains(&(ms / 60_000)))
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_REFRESH);
    let mode = match usage_mode.as_str() {
        Some("used") => UsageMode::Used,
        _ => UsageMode::Left,
    };
    UsageSettings { refresh, mode }
}

pub(crate) fn settings() -> UsageSettings {
    SETTINGS.lock().map(|guard| *guard).unwrap_or(UsageSettings {
        refresh: DEFAULT_REFRESH,
        mode: UsageMode::Left,
    })
}

pub(crate) fn set_settings(next: UsageSettings) {
    if let Ok(mut guard) = SETTINGS.lock() {
        *guard = next;
    }
}

/// A short tag for an account, never the id itself: enough for the bridge to tell one
/// account's readings from another's.
pub(crate) fn account_tag(id: &str) -> String {
    hex_lower(Sha256::digest(id.as_bytes()))[..16].to_string()
}

#[derive(Debug, Clone)]
pub(crate) struct LocalReading {
    pub(crate) lines: Vec<CodexMetricLine>,
    pub(crate) fetched_at: i64,
    pub(crate) source: UsageSource,
}

// ---------------------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------------------

/// The API is asked every interval (owner, sync-dhhq seq 306/308); the answer is the newer of
/// its reading and the local one. A local reading is offered the snapshot it would replace, so
/// it can refuse one from another account. Without an API snapshot there is no plan or credits
/// to show beside the local lines, so the fetch answers alone (#398 Q3). The clock is read once
/// the API has answered, so a local reading that aged out during a slow fetch is not news.
pub(crate) fn choose(
    local: impl FnOnce(&CodexUsageSnapshot, i64) -> Option<LocalReading>,
    base: Option<CodexUsageSnapshot>,
    account: Option<String>,
    refresh: Duration,
    clock: impl FnOnce() -> i64,
    fetch: impl FnOnce() -> Result<UsageReading, String>,
) -> Result<UsageReading, String> {
    let fetched = fetch();
    let now = clock();
    // Another login answered: the local reading was matched to the first one (#398 r2).
    if matches!(&fetched, Ok(reading) if reading.account != account) {
        return fetched;
    }
    let reference = match &fetched {
        Ok(reading) => Some(reading.snapshot.clone()),
        Err(_) => base,
    };
    let Some(reference) = reference else {
        return fetched;
    };
    let Some(reading) = local(&reference, now) else {
        return fetched;
    };
    if reading.fetched_at <= iso_seconds(&reference.fetched_at).unwrap_or(i64::MAX) {
        return fetched;
    }
    if now.saturating_sub(reading.fetched_at) <= refresh.as_secs() as i64 {
        return Ok(UsageReading { snapshot: merge(&reference, &reading), fresh: true, account });
    }
    let snapshot = match fetched {
        Ok(kept) => merge_keeping_status(&kept.snapshot, &reading),
        Err(_) => {
            let mut snapshot = merge(&reference, &reading);
            snapshot.lines.push(CodexMetricLine::Text {
                label: "Status".to_string(),
                value: FETCH_FAILED.to_string(),
            });
            snapshot
        }
    };
    Ok(UsageReading { snapshot, fresh: false, account })
}

fn is_status(line: &CodexMetricLine) -> bool {
    matches!(line, CodexMetricLine::Text { label, .. } if label == "Status")
}

fn label_of(line: &CodexMetricLine) -> &str {
    match line {
        CodexMetricLine::Progress { label, .. }
        | CodexMetricLine::Text { label, .. }
        | CodexMetricLine::BarChart { label, .. } => label,
    }
}

/// The base with its Session and Weekly lines taken from the local reading.
pub(crate) fn merge(base: &CodexUsageSnapshot, local: &LocalReading) -> CodexUsageSnapshot {
    let mut snapshot = merge_keeping_status(base, local);
    snapshot.lines.retain(|line| !is_status(line));
    snapshot
}

fn merge_keeping_status(base: &CodexUsageSnapshot, local: &LocalReading) -> CodexUsageSnapshot {
    let mut snapshot = base.clone();
    for (index, line) in local.lines.iter().enumerate() {
        match snapshot.lines.iter().position(|old| label_of(old) == label_of(line)) {
            Some(at) => snapshot.lines[at] = line.clone(),
            None => snapshot.lines.insert(index.min(snapshot.lines.len()), line.clone()),
        }
    }
    snapshot.fetched_at = iso(local.fetched_at);
    snapshot.source = local.source;
    snapshot
}

fn iso(seconds: i64) -> String {
    unix_seconds_to_iso(seconds).unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

fn iso_seconds(text: &str) -> Option<i64> {
    time::OffsetDateTime::parse(text.trim(), &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|time| time.unix_timestamp())
}

fn window_line(label: &str, used: f64, resets_at: i64, period_ms: u64) -> CodexMetricLine {
    progress_metric(label, used, unix_seconds_to_iso(resets_at), Some(period_ms))
}

fn percent(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|used| (0.0..=100.0).contains(used))
}

fn unix(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value.as_i64().or_else(|| value.as_f64().filter(|v| v.is_finite()).map(|v| v.floor() as i64))
}

// ---------------------------------------------------------------------------------------
// Bounded, no-follow file reads
// ---------------------------------------------------------------------------------------

fn open_regular(path: &Path) -> Option<(fs::File, u64, i64)> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    let mtime = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    Some((file, metadata.len(), mtime))
}

// ---------------------------------------------------------------------------------------
// Claude Code: the status-line payload
// ---------------------------------------------------------------------------------------

/// The API's `five_hour`/`seven_day` windows, under the labels the API path gives them.
const CLAUDE_WINDOWS: [(&str, &str, u64); 2] = [
    ("five_hour", SESSION_LABEL, SESSION_PERIOD_MS),
    ("seven_day", WEEKLY_LABEL, WEEKLY_PERIOD_MS),
];

#[derive(Debug, Clone)]
pub(crate) struct ClaudeStatusLine {
    reading: LocalReading,
    config_dir: String,
    weekly_resets_at: i64,
}

/// `{ at, configDir, payload: { rate_limits: { five_hour, seven_day } } }` as the script
/// writes it, or nothing: an unknown shape gives no value.
pub(crate) fn parse_claude_statusline(bytes: &[u8], mtime: i64, now: i64) -> Option<ClaudeStatusLine> {
    let root: Value = serde_json::from_slice(bytes).ok()?;
    let at = root.get("at")?.as_i64()?;
    let config_dir = root.get("configDir")?.as_str()?.to_string();
    let limits = root.get("payload")?.get("rate_limits")?.as_object()?;
    let mut lines = Vec::new();
    let mut weekly_resets_at = 0;
    for (key, label, period) in CLAUDE_WINDOWS {
        let window = limits.get(key)?.as_object()?;
        let used = percent(window.get("used_percentage"))?;
        let resets_at = unix(window.get("resets_at"))?;
        // A window that has reset since is no longer what the file says.
        if resets_at <= now {
            return None;
        }
        if label == WEEKLY_LABEL {
            weekly_resets_at = resets_at;
        }
        lines.push(window_line(label, used, resets_at, period));
    }
    Some(ClaudeStatusLine {
        reading: LocalReading { lines, fetched_at: at.min(mtime), source: UsageSource::StatusLine },
        config_dir,
        weekly_resets_at,
    })
}

fn weekly(lines: &[CodexMetricLine]) -> Option<(i64, f64)> {
    lines.iter().find_map(|line| match line {
        CodexMetricLine::Progress { label, used, resets_at: Some(at), .. } if label == WEEKLY_LABEL => {
            Some((iso_seconds(at)?, *used))
        }
        _ => None,
    })
}

fn same_dir(left: &str, right: &Path) -> bool {
    let right = right.to_string_lossy();
    left.trim_end_matches('/') == right.trim_end_matches('/')
}

/// The record with the highest number: the last one whose number was reserved. Tests use it
/// to find what a run of the script wrote; the app chooses by content (`claude_local_latest`).
#[cfg(test)]
pub(crate) fn newest_claude_record(dir: &Path) -> Option<PathBuf> {
    claude_records(dir).into_iter().max_by_key(|(order, _)| *order).map(|(_, path)| path)
}

/// `claude-statusline.<n>.json` in the app's folder, regular files only.
fn claude_records(dir: &Path) -> Vec<(u64, PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| Some((claude_record_order(entry.file_name().to_str()?)?, entry.path())))
        .collect()
}

/// The arrival number of a record's name, or nothing when the name is not one.
pub(crate) fn claude_record_order(name: &str) -> Option<u64> {
    let number = name.strip_prefix(CLAUDE_RECORD_PREFIX)?.strip_suffix(".json")?;
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    number.parse().ok()
}

pub(crate) const CLAUDE_RECORD_PREFIX: &str = "claude-statusline.";
/// How many of the highest-numbered records are read; those below are older still.
/// A record that does not parse is left this long, in case it is still being written.
const CLAUDE_UNREADABLE_GRACE: i64 = 600;

/// A record as the script wrote it, and the file's mtime when it could be opened.
fn read_claude_record(path: &Path, now: i64) -> (Option<ClaudeStatusLine>, Option<i64>) {
    let Some((file, length, mtime)) = open_regular(path) else { return (None, None) };
    if length > STATUS_LINE_MAX_BYTES {
        return (None, Some(mtime));
    }
    let mut bytes = Vec::new();
    if file.take(STATUS_LINE_MAX_BYTES + 1).read_to_end(&mut bytes).is_err() {
        return (None, Some(mtime));
    }
    (parse_claude_statusline(&bytes, mtime, now), Some(mtime))
}

/// Which of two payloads is newer, by what they say: within a window the used share only
/// grows, and a later reset is a later window. The order processes ran in plays no part, so a
/// writer paused at any point cannot put its older payload first (#398 audit r7).
fn claude_content(status: &ClaudeStatusLine) -> Option<[(i64, f64); 2]> {
    let window = |wanted: &str| {
        status.reading.lines.iter().find_map(|line| match line {
            CodexMetricLine::Progress { label, used, resets_at: Some(at), .. } if label == wanted => {
                Some((iso_seconds(at)?, *used))
            }
            _ => None,
        })
    };
    Some([window(WEEKLY_LABEL)?, window(SESSION_LABEL)?])
}

fn content_order(left: &[(i64, f64); 2], right: &[(i64, f64); 2]) -> std::cmp::Ordering {
    left.iter()
        .zip(right)
        .map(|((left_at, left_used), (right_at, right_used))| left_at.cmp(right_at).then(left_used.total_cmp(right_used)))
        .find(|order| order.is_ne())
        .unwrap_or(std::cmp::Ordering::Equal)
}

/// The newest status-line reading for this config dir that is plausibly this account's, chosen
/// by content. Records it outranks are removed, by name, without following a link: those of this
/// config dir and account saying no more than it, and those that have not parsed for
/// `CLAUDE_UNREADABLE_GRACE`. Another account's, or another config dir's, are left alone.
pub(crate) fn claude_local_latest(
    dir: &Path,
    config_dir: &Path,
    base: Option<&CodexUsageSnapshot>,
    now: i64,
) -> Option<LocalReading> {
    let accept = |status: &ClaudeStatusLine| guard_claude(status.clone(), config_dir, base).is_some();
    Some(choose_claude_record(dir, config_dir, now, &accept)?.1.reading)
}

/// The record `claude_local_latest` reads, with its path, among those `accept` lets through.
pub(crate) fn choose_claude_record(
    dir: &Path,
    config_dir: &Path,
    now: i64,
    accept: &dyn Fn(&ClaudeStatusLine) -> bool,
) -> Option<(PathBuf, ClaudeStatusLine)> {
    let mut mine = Vec::new();
    for (order, path) in claude_records(dir) {
        match read_claude_record(&path, now) {
            (Some(status), _) if same_dir(&status.config_dir, config_dir) && accept(&status) => {
                if let Some(content) = claude_content(&status) {
                    mine.push((content, order, path, status));
                }
            }
            (Some(_), _) => {}
            (None, Some(mtime)) if now.saturating_sub(mtime) > CLAUDE_UNREADABLE_GRACE => {
                let _ = fs::remove_file(&path);
            }
            (None, _) => {}
        }
    }
    let best = mine
        .iter()
        .max_by(|left, right| {
            content_order(&left.0, &right.0)
                .then(left.3.reading.fetched_at.cmp(&right.3.reading.fetched_at))
                .then(left.1.cmp(&right.1))
        })
        .map(|(_, order, _, _)| *order)?;
    let mut chosen = None;
    for (_, order, path, status) in mine {
        if order == best {
            chosen = Some((path, status));
        } else {
            let _ = fs::remove_file(&path);
        }
    }
    chosen
}

/// The status-line reading, when it was written for this config dir and plausibly this account.
#[cfg(test)]
pub(crate) fn claude_local(
    path: &Path,
    config_dir: &Path,
    base: Option<&CodexUsageSnapshot>,
    now: i64,
) -> Option<LocalReading> {
    guard_claude(read_claude_record(path, now).0?, config_dir, base)
}

fn guard_claude(status: ClaudeStatusLine, config_dir: &Path, base: Option<&CodexUsageSnapshot>) -> Option<LocalReading> {
    let (api_reset, api_used) = weekly(&base?.lines)?;
    let (_, local_used) = weekly(&status.reading.lines)?;
    // Resets are rounded to the hour, so two accounts can share one; within a window the used
    // share only grows, so a lower one is another account's (sync-dhhq seq 307/308).
    (same_dir(&status.config_dir, config_dir)
        && (status.weekly_resets_at - api_reset).abs() <= RESET_MATCH_SECONDS
        && local_used >= api_used)
        .then_some(status.reading)
}

// ---------------------------------------------------------------------------------------
// Codex: the session logs
// ---------------------------------------------------------------------------------------

fn sorted_children(dir: &Path) -> Vec<PathBuf> {
    let mut children: Vec<PathBuf> = fs::read_dir(dir)
        .map(|entries| entries.filter_map(|entry| entry.ok().map(|entry| entry.path())).collect())
        .unwrap_or_default();
    children.sort();
    children.reverse();
    children
}

/// The newest few rollouts, newest first by mtime, from the newest day directories.
fn recent_rollouts(codex_home: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut days = 0;
    'walk: for year in sorted_children(&codex_home.join("sessions")) {
        for month in sorted_children(&year) {
            for day in sorted_children(&month) {
                days += 1;
                found.extend(sorted_children(&day).into_iter().filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
                }));
                if found.len() >= LOG_CANDIDATES || days >= LOG_DAY_DIRS {
                    break 'walk;
                }
            }
        }
    }
    let mut stamped: Vec<(i64, PathBuf)> = found
        .into_iter()
        .filter_map(|path| {
            let modified = fs::symlink_metadata(&path).ok()?.modified().ok()?;
            Some((modified.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64, path))
        })
        .collect();
    stamped.sort_by(|a, b| b.0.cmp(&a.0));
    stamped.into_iter().take(LOG_FILES_READ).map(|(_, path)| path).collect()
}

/// `rate_limits` from one `token_count` event, under the API's labels.
fn codex_lines(limits: &Value, now: i64) -> Option<Vec<CodexMetricLine>> {
    let limits = limits.as_object()?;
    if let Some(id) = limits.get("limit_id") {
        if id.as_str()? != "codex" {
            return None;
        }
    }
    let mut lines = Vec::new();
    for (key, label, minutes) in
        [("primary", SESSION_LABEL, SESSION_PERIOD_MS / 60_000), ("secondary", WEEKLY_LABEL, WEEKLY_PERIOD_MS / 60_000)]
    {
        let window = limits.get(key)?.as_object()?;
        if window.get("window_minutes")?.as_u64()? != minutes {
            return None;
        }
        let used = percent(window.get("used_percent"))?;
        let resets_at = unix(window.get("resets_at"))?;
        if resets_at <= now {
            return None;
        }
        lines.push(window_line(label, used, resets_at, minutes * 60_000));
    }
    Some(lines)
}

fn codex_file_reading(path: &Path, account_id: &str, now: i64) -> Option<LocalReading> {
    let (file, length, mtime) = open_regular(path)?;
    let mut head = BufReader::new(&file).take(LOG_HEAD_BYTES);
    let mut first = Vec::new();
    head.read_until(b'\n', &mut first).ok()?;
    let meta: Value = serde_json::from_slice(&first).ok()?;
    if meta.get("type")?.as_str()? != "session_meta"
        || meta.get("payload")?.get("creator_account_id")?.as_str()? != account_id
    {
        return None;
    }

    let start = length.saturating_sub(LOG_TAIL_BYTES);
    let mut file = file;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = Vec::new();
    file.take(LOG_TAIL_BYTES).read_to_end(&mut tail).ok()?;
    let text = String::from_utf8_lossy(&tail);
    let mut lines = text.split('\n');
    if start > 0 {
        lines.next();
    }
    let lines: Vec<&str> = lines.collect();
    lines.iter().rev().filter(|line| line.contains("\"token_count\"")).find_map(|line| {
        let event: Value = serde_json::from_str(line).ok()?;
        let payload = event.get("payload")?;
        if event.get("type")?.as_str()? != "event_msg" || payload.get("type")?.as_str()? != "token_count" {
            return None;
        }
        let recorded = iso_seconds(event.get("timestamp")?.as_str()?)?;
        Some(LocalReading {
            lines: codex_lines(payload.get("rate_limits")?, now)?,
            fetched_at: recorded.min(mtime),
            source: UsageSource::Log,
        })
    })
}

/// The newest reading in this account's own session logs.
pub(crate) fn codex_local(codex_home: &Path, account_id: Option<&str>, now: i64) -> Option<LocalReading> {
    let account_id = account_id.map(str::trim).filter(|id| !id.is_empty())?;
    recent_rollouts(codex_home)
        .iter()
        .filter_map(|path| codex_file_reading(path, account_id, now))
        .max_by_key(|reading| reading.fetched_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        build_claude_usage_snapshot, relay_if_fresh, ClaudeAuthState, ClaudeCredentialsFile,
        ClaudeOauthConfig,
    };
    use std::cell::Cell;

    fn claude_auth() -> ClaudeAuthState {
        ClaudeAuthState {
            credentials: ClaudeCredentialsFile { claude_ai_oauth: None },
            service_name: None,
            file_path: None,
            inference_only: false,
            oauth_config: ClaudeOauthConfig { usage_url: String::new(), oauth_file_suffix: String::new() },
        }
    }

    /// 2026-11-28T00:00:00Z
    const NOW: i64 = 1_795_737_600;
    const ACCOUNT: &str = "11111111-2222-3333-4444-555555555555";
    const OTHER: &str = "99999999-2222-3333-4444-555555555555";
    const REFRESH: Duration = Duration::from_secs(5 * 60);
    const WEEKLY_RESET: i64 = NOW + 3 * 86_400;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("gyredeck-local-usage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn set_mtime(path: &Path, seconds: i64) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(UNIX_EPOCH + Duration::from_secs(seconds as u64)).unwrap();
    }

    fn api_snapshot(provider: &str, fetched_at: i64) -> CodexUsageSnapshot {
        CodexUsageSnapshot {
            provider_id: provider.to_string(),
            display_name: provider.to_string(),
            plan: Some("Plus".to_string()),
            lines: vec![
                progress_metric(SESSION_LABEL, 40.0, unix_seconds_to_iso(NOW + 3_600), Some(SESSION_PERIOD_MS)),
                progress_metric(WEEKLY_LABEL, 50.0, unix_seconds_to_iso(WEEKLY_RESET), Some(WEEKLY_PERIOD_MS)),
                CodexMetricLine::Text { label: "Rate Limit Resets".to_string(), value: "2 available".to_string() },
                CodexMetricLine::Text { label: "Credits".to_string(), value: "$4.00 · 100 credits".to_string() },
            ],
            fetched_at: iso(fetched_at),
            source: UsageSource::Api,
        }
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

    fn labels(lines: &[CodexMetricLine]) -> Vec<String> {
        lines.iter().map(|line| label_of(line).to_string()).collect()
    }

    fn api_fetch<'a>(calls: &'a Cell<u32>, provider: &'static str) -> impl FnOnce() -> Result<UsageReading, String> + 'a {
        move || {
            calls.set(calls.get() + 1);
            Ok(UsageReading { snapshot: api_snapshot(provider, NOW), fresh: true, account: None })
        }
    }

    // Codex fixtures ---------------------------------------------------------------------

    fn token_count(at: i64, session: f64, weekly: f64) -> String {
        serde_json::json!({
            "timestamp": iso(at).replace('Z', ".123Z"),
            "type": "event_msg",
            "payload": { "type": "token_count", "info": null, "rate_limits": {
                "limit_id": "codex",
                "primary": { "used_percent": session, "window_minutes": 300, "resets_at": NOW + 3_600 },
                "secondary": { "used_percent": weekly, "window_minutes": 10080, "resets_at": WEEKLY_RESET },
                "credits": { "has_credits": false, "unlimited": false, "balance": "0" },
                "plan_type": "plus"
            } }
        })
        .to_string()
    }

    fn rollout(home: &Path, name: &str, account: &str, events: &[String], mtime: i64) -> PathBuf {
        let day = home.join("sessions/2026/11/27");
        fs::create_dir_all(&day).unwrap();
        let path = day.join(format!("rollout-{name}.jsonl"));
        let meta = serde_json::json!({
            "timestamp": iso(NOW - 3_600), "type": "session_meta",
            "payload": { "id": name, "creator_account_id": account, "account_scoped": true,
                "base_instructions": { "text": "x".repeat(20_000) } }
        });
        let mut body = format!("{meta}\n");
        for event in events {
            body.push_str(event);
            body.push('\n');
        }
        fs::write(&path, body).unwrap();
        set_mtime(&path, mtime);
        path
    }

    // Claude fixtures --------------------------------------------------------------------

    fn claude_file(dir: &Path, at: i64, config_dir: &str, weekly_reset: i64, mtime: i64) -> PathBuf {
        let path = dir.join("claude-statusline.json");
        let body = serde_json::json!({
            "at": at, "configDir": config_dir,
            "payload": { "model": { "display_name": "Opus" }, "rate_limits": {
                "five_hour": { "used_percentage": 12, "resets_at": NOW + 3_600 },
                "seven_day": { "used_percentage": 54.5, "resets_at": weekly_reset }
            } }
        });
        fs::write(&path, body.to_string()).unwrap();
        set_mtime(&path, mtime);
        path
    }

    // 398-1 ------------------------------------------------------------------------------

    #[test]
    fn a_codex_log_from_another_account_is_not_used() {
        let home = scratch("codex-account");
        rollout(&home, "a", OTHER, &[token_count(NOW - 30, 10.0, 20.0)], NOW - 20);
        let calls = Cell::new(0);
        let local = codex_local(&home, Some(ACCOUNT), NOW);
        let reading = choose(|_, _| local, Some(api_snapshot("codex", NOW - 900)), None, REFRESH, || NOW, api_fetch(&calls, "codex")).unwrap();
        assert_eq!(calls.get(), 1, "another account's log is not shown");
        assert_eq!(reading.snapshot.source, UsageSource::Api);

        // Premise: the same file under the right account is used.
        rollout(&home, "a", ACCOUNT, &[token_count(NOW - 30, 10.0, 20.0)], NOW - 20);
        assert!(codex_local(&home, Some(ACCOUNT), NOW).is_some());
        let _ = fs::remove_dir_all(&home);
    }

    // 398-2 ------------------------------------------------------------------------------

    #[test]
    fn a_claude_statusline_reading_from_another_account_is_not_used() {
        let dir = scratch("claude-account");
        let base = api_snapshot("claude", NOW - 900);
        let config = Path::new("/Users/someone/.claude");

        let good = claude_file(&dir, NOW - 30, "/Users/someone/.claude/", WEEKLY_RESET + 20, NOW - 20);
        assert!(claude_local(&good, config, Some(&base), NOW).is_some(), "premise: the right account reads");

        let other_dir = claude_file(&dir, NOW - 30, "/Users/someone/.claude-work", WEEKLY_RESET, NOW - 20);
        assert!(claude_local(&other_dir, config, Some(&base), NOW).is_none(), "another config dir");

        let other_account = claude_file(&dir, NOW - 30, "/Users/someone/.claude", WEEKLY_RESET + 3_600, NOW - 20);
        assert!(claude_local(&other_account, config, Some(&base), NOW).is_none(), "another week's reset");

        let calls = Cell::new(0);
        let local = claude_local(&other_account, config, Some(&base), NOW);
        let reading = choose(|_, _| local, Some(base.clone()), None, REFRESH, || NOW, api_fetch(&calls, "claude")).unwrap();
        assert_eq!((calls.get(), reading.snapshot.source), (1, UsageSource::Api));

        // No API answer yet: there is nothing to match the reset against (#398 Q3).
        let good = claude_file(&dir, NOW - 30, "/Users/someone/.claude", WEEKLY_RESET, NOW - 20);
        assert!(claude_local(&good, config, None, NOW).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    // 398-3, 398-4 -----------------------------------------------------------------------

    /// The API is asked every interval, and its fresh answer is newer than any local one.
    /// When it cannot answer fresh, a local reading within the interval is the answer.
    #[test]
    fn every_interval_asks_once_and_the_newer_reading_answers() {
        let home = scratch("codex-newest");
        let dir = scratch("claude-newest");
        let config = Path::new("/Users/someone/.claude");
        let refresh_s = REFRESH.as_secs() as i64;

        type Local = Box<dyn Fn(i64, &CodexUsageSnapshot) -> Option<LocalReading>>;
        let codex_home = home.clone();
        let claude_dir = dir.clone();
        let providers: [(&'static str, Local); 2] = [
            ("codex", Box::new(move |age, _| {
                rollout(&codex_home, "c", ACCOUNT, &[token_count(NOW - age, 60.0, 70.0)], NOW - age);
                codex_local(&codex_home, Some(ACCOUNT), NOW)
            })),
            ("claude", Box::new(move |age, reference| {
                let path = claude_file(&claude_dir, NOW - age, "/Users/someone/.claude", WEEKLY_RESET, NOW - age);
                claude_local(&path, config, Some(reference), NOW)
            })),
        ];
        let limited = |provider: &'static str, calls: &Cell<u32>| {
            calls.set(calls.get() + 1);
            let mut kept = api_snapshot(provider, NOW - 900);
            kept.lines.push(CodexMetricLine::Text { label: "Status".into(), value: "Rate limited".into() });
            Ok(UsageReading { snapshot: kept, fresh: false, account: Some("tag".to_string()) })
        };
        for (provider, local_at) in providers {
            let base = || Some(api_snapshot(provider, NOW - 900));

            let calls = Cell::new(0);
            let reading = choose(|r, _| local_at(1, r), base(), None, REFRESH, || NOW, api_fetch(&calls, provider)).unwrap();
            assert_eq!(calls.get(), 1, "{provider}: a local reading a second old still asks");
            assert_eq!(reading.snapshot.source, UsageSource::Api, "{provider}: the fresh answer is newer");
            assert!(reading.fresh);

            let calls = Cell::new(0);
            let reading = choose(|r, _| local_at(refresh_s, r), base(), Some("tag".into()), REFRESH, || NOW, || limited(provider, &calls)).unwrap();
            assert_eq!(calls.get(), 1, "{provider}");
            assert_ne!(reading.snapshot.source, UsageSource::Api, "{provider}: newer than the kept answer");
            assert!(reading.fresh, "{provider}: within the interval it is news");
            assert!(!reading.snapshot.lines.iter().any(is_status), "{provider}: nothing was kept");
            assert_eq!(reading.account.as_deref(), Some("tag"));

            let calls = Cell::new(0);
            let reading = choose(|r, _| local_at(refresh_s + 1, r), base(), Some("tag".into()), REFRESH, || NOW, || limited(provider, &calls)).unwrap();
            assert!(!reading.fresh, "{provider}: one second past the interval it is kept");
            assert!(reading.snapshot.lines.iter().any(is_status), "{provider}");

            // The interval is measured once the API has answered: a reading inside it when the
            // fetch began but past it by the time the fetch failed is kept, not news.
            let calls = Cell::new(0);
            let clock = Cell::new(NOW);
            let reading = choose(|r, _| local_at(refresh_s, r), base(), Some("tag".into()), REFRESH, || clock.get(), || {
                clock.set(NOW + 12);
                limited(provider, &calls)
            })
            .unwrap();
            assert!(!reading.fresh, "{provider}: it aged out while the API was asked");

            let calls = Cell::new(0);
            let reading = choose(|_, _| None, base(), None, REFRESH, || NOW, api_fetch(&calls, provider)).unwrap();
            assert_eq!((calls.get(), reading.snapshot.source), (1, UsageSource::Api), "{provider}: none");

            // A later login answered (the first could not, or was re-read): its kept reading
            // is shown as it came, never merged with the first login's local one (#398 r2).
            let calls = Cell::new(0);
            let reading = choose(|r, _| local_at(refresh_s, r), base(), Some("other".into()), REFRESH, || NOW, || limited(provider, &calls)).unwrap();
            assert_eq!(reading.snapshot.source, UsageSource::Api, "{provider}: another login's answer stays its own");
            assert!(!reading.fresh, "{provider}");
            assert_eq!(reading.account.as_deref(), Some("tag"), "{provider}");
        }
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Resets are rounded to the hour, so another account in the same config dir can carry
    /// the same Weekly reset. A lower used share than the API's then marks it as another's.
    /// Accepted (seq 308): another account that has used more in the same hour still passes.
    #[test]
    fn a_statusline_below_the_api_share_is_another_account() {
        let dir = scratch("claude-same-reset");
        let config = Path::new("/c");
        let api = api_snapshot("claude", NOW - 900);
        let file = |weekly: f64| {
            let path = dir.join("claude-statusline.json");
            let body = serde_json::json!({ "at": NOW - 30, "configDir": "/c", "payload": { "rate_limits": {
                "five_hour": { "used_percentage": 1, "resets_at": NOW + 3_600 },
                "seven_day": { "used_percentage": weekly, "resets_at": WEEKLY_RESET } } } });
            fs::write(&path, body.to_string()).unwrap();
            set_mtime(&path, NOW - 20);
            path
        };
        assert_eq!(used_of(&api, WEEKLY_LABEL), 50.0, "premise");
        assert!(claude_local(&file(50.0), config, Some(&api), NOW).is_some(), "the same share is this account");
        assert!(claude_local(&file(49.0), config, Some(&api), NOW).is_none(), "a lower share is not");

        let reading = choose(
            |reference, _| claude_local(&file(10.0), config, Some(reference), NOW),
            Some(api.clone()), None, REFRESH, || NOW, || Err("network down".to_string()),
        );
        assert!(reading.is_err(), "nothing of this account's to show");
        let _ = fs::remove_dir_all(&dir);
    }

    // 398-5 ------------------------------------------------------------------------------

    #[test]
    fn a_local_reading_carries_its_recorded_time() {
        let home = scratch("codex-time");
        // Premise: recorded time, mtime and now are three different instants.
        rollout(&home, "t", ACCOUNT, &[token_count(NOW - 200, 10.0, 20.0)], NOW - 100);
        let codex = codex_local(&home, Some(ACCOUNT), NOW).unwrap();
        assert_eq!(codex.fetched_at, NOW - 200);
        let merged = merge(&api_snapshot("codex", NOW - 900), &codex);
        assert_eq!(merged.fetched_at, iso(NOW - 200));

        // A recorded time after the file's own write is held to the write.
        rollout(&home, "t", ACCOUNT, &[token_count(NOW - 50, 10.0, 20.0)], NOW - 100);
        assert_eq!(codex_local(&home, Some(ACCOUNT), NOW).unwrap().fetched_at, NOW - 100);

        let dir = scratch("claude-time");
        let base = api_snapshot("claude", NOW - 900);
        let config = Path::new("/c");
        let path = claude_file(&dir, NOW - 200, "/c", WEEKLY_RESET, NOW - 100);
        assert_eq!(claude_local(&path, config, Some(&base), NOW).unwrap().fetched_at, NOW - 200);
        let path = claude_file(&dir, NOW - 50, "/c", WEEKLY_RESET, NOW - 100);
        assert_eq!(claude_local(&path, config, Some(&base), NOW).unwrap().fetched_at, NOW - 100);
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&dir);
    }

    // 398-6 ------------------------------------------------------------------------------

    #[test]
    fn a_stale_local_reading_is_not_relayed() {
        let base = api_snapshot("codex", NOW - 3_600);
        let local = LocalReading {
            lines: vec![
                window_line(SESSION_LABEL, 70.0, NOW + 3_600, SESSION_PERIOD_MS),
                window_line(WEEKLY_LABEL, 80.0, WEEKLY_RESET, WEEKLY_PERIOD_MS),
            ],
            fetched_at: NOW - 900,
            source: UsageSource::Log,
        };
        let calls = Cell::new(0);
        let reading = choose(|_, _| Some(local.clone()), Some(base.clone()), Some("tag".into()), REFRESH, || NOW, || {
            calls.set(calls.get() + 1);
            Err("network down".to_string())
        })
        .unwrap();
        assert_eq!(calls.get(), 1);
        assert!(!reading.fresh, "a kept reading is not fresh");
        assert_eq!(used_of(&reading.snapshot, SESSION_LABEL), 70.0, "the newer local lines are shown");
        assert_eq!(reading.snapshot.source, UsageSource::Log);
        assert!(reading.snapshot.lines.iter().any(|line| matches!(line,
            CodexMetricLine::Text { label, value } if label == "Status" && value == FETCH_FAILED)));
        let mut relayed = 0;
        relay_if_fresh(reading, |_, _| relayed += 1);
        assert_eq!(relayed, 0, "a kept reading is never relayed");

        // An expired login answers with its own kept reading: that one keeps its Status line.
        let mut kept = base.clone();
        kept.lines.push(CodexMetricLine::Text { label: "Status".into(), value: "Login expired".into() });
        let reading = choose(|_, _| Some(local), Some(base), None, REFRESH, || NOW, || {
            Ok(UsageReading { snapshot: kept, fresh: false, account: None })
        })
        .unwrap();
        assert!(!reading.fresh);
        assert_eq!(used_of(&reading.snapshot, SESSION_LABEL), 70.0);
        assert!(reading.snapshot.lines.iter().any(|line| matches!(line,
            CodexMetricLine::Text { value, .. } if value == "Login expired")));
    }

    // 398-8 ------------------------------------------------------------------------------

    #[test]
    fn a_local_reading_keeps_plan_and_credits_from_the_last_request() {
        let home = scratch("codex-merge");
        rollout(&home, "m", ACCOUNT, &[token_count(NOW - 30, 61.0, 72.0)], NOW - 20);
        let local = codex_local(&home, Some(ACCOUNT), NOW).unwrap();
        let reading = choose(|_, _| Some(local), Some(api_snapshot("codex", NOW - 900)), None, REFRESH, || NOW, || {
            Err("network down".to_string())
        })
        .unwrap();
        let snapshot = reading.snapshot;
        assert_eq!(snapshot.plan.as_deref(), Some("Plus"));
        assert_eq!(
            labels(&snapshot.lines),
            [SESSION_LABEL, WEEKLY_LABEL, "Rate Limit Resets", "Credits"],
            "the API's lines stay, in their order"
        );
        assert_eq!((used_of(&snapshot, SESSION_LABEL), used_of(&snapshot, WEEKLY_LABEL)), (61.0, 72.0));
        let _ = fs::remove_dir_all(&home);
    }

    // 398-9 ------------------------------------------------------------------------------

    #[test]
    fn local_lines_carry_the_api_labels() {
        let api = build_claude_usage_snapshot(
            serde_json::json!({
                "five_hour": { "utilization": 10, "resets_at": iso(NOW + 3_600) },
                "seven_day": { "utilization": 20, "resets_at": iso(WEEKLY_RESET) }
            }),
            &claude_auth(),
        );
        let dir = scratch("labels");
        let path = claude_file(&dir, NOW - 30, "/c", WEEKLY_RESET, NOW - 20);
        let claude = claude_local(&path, Path::new("/c"), Some(&api), NOW).unwrap();
        assert_eq!(labels(&claude.lines), labels(&api.lines));

        let home = scratch("labels-codex");
        rollout(&home, "l", ACCOUNT, &[token_count(NOW - 30, 1.0, 2.0)], NOW - 20);
        let codex = codex_local(&home, Some(ACCOUNT), NOW).unwrap();
        assert_eq!(labels(&codex.lines), [crate::CODEX_LIMIT_LABELS.0, crate::CODEX_LIMIT_LABELS.1]);
        let periods: Vec<Option<u64>> = codex
            .lines
            .iter()
            .chain(claude.lines.iter())
            .map(|line| match line {
                CodexMetricLine::Progress { period_duration_ms, .. } => *period_duration_ms,
                _ => None,
            })
            .collect();
        assert_eq!(periods, [Some(SESSION_PERIOD_MS), Some(WEEKLY_PERIOD_MS), Some(SESSION_PERIOD_MS), Some(WEEKLY_PERIOD_MS)]);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&home);
    }

    // Shapes ------------------------------------------------------------------------------

    #[test]
    fn an_unknown_shape_gives_no_local_value() {
        let good = serde_json::json!({ "at": NOW, "configDir": "/c", "payload": { "rate_limits": {
            "five_hour": { "used_percentage": 1, "resets_at": NOW + 10 },
            "seven_day": { "used_percentage": 2, "resets_at": NOW + 20 } } } });
        assert!(parse_claude_statusline(good.to_string().as_bytes(), NOW, NOW).is_some(), "premise");
        type Mutation = fn(&mut Value);
        let cases: [(&str, Mutation); 6] = [
            ("no at", |v| { v.as_object_mut().unwrap().remove("at"); }),
            ("no configDir", |v| { v.as_object_mut().unwrap().remove("configDir"); }),
            ("no seven_day", |v| { v["payload"]["rate_limits"].as_object_mut().unwrap().remove("seven_day"); }),
            ("percent as text", |v| v["payload"]["rate_limits"]["five_hour"]["used_percentage"] = "1".into()),
            ("percent over 100", |v| v["payload"]["rate_limits"]["five_hour"]["used_percentage"] = 101.into()),
            ("already reset", |v| v["payload"]["rate_limits"]["five_hour"]["resets_at"] = NOW.into()),
        ];
        for (name, mutate) in cases {
            let mut value = good.clone();
            mutate(&mut value);
            assert!(parse_claude_statusline(value.to_string().as_bytes(), NOW, NOW).is_none(), "{name}");
        }

        let limits = serde_json::json!({ "limit_id": "codex",
            "primary": { "used_percent": 1.0, "window_minutes": 300, "resets_at": NOW + 10 },
            "secondary": { "used_percent": 2.0, "window_minutes": 10080, "resets_at": NOW + 20 } });
        assert!(codex_lines(&limits, NOW).is_some(), "premise");
        let cases: [(&str, Mutation); 4] = [
            ("another limit", |v| v["limit_id"] = "codex_other".into()),
            ("window swapped", |v| v["primary"]["window_minutes"] = 10080.into()),
            ("percent missing", |v| { v["secondary"].as_object_mut().unwrap().remove("used_percent"); }),
            ("already reset", |v| v["secondary"]["resets_at"] = NOW.into()),
        ];
        for (name, mutate) in cases {
            let mut value = limits.clone();
            mutate(&mut value);
            assert!(codex_lines(&value, NOW).is_none(), "{name}");
        }
    }

    #[test]
    fn the_latest_claude_record_is_read_whatever_order_it_was_written_in() {
        let dir = scratch("claude-records");
        for name in [
            "claude-statusline.9.json",
            "claude-statusline.10.json",
            "claude-statusline.07.json",
            ".claude-statusline.abc",
            "claude-statusline.20.1.json",
            "claude-statusline.x.json",
            "claude-statusline.previous.json",
            "claude-statusline.json",
        ] {
            fs::write(dir.join(name), "{}").unwrap();
        }
        assert_eq!(newest_claude_record(&dir), Some(dir.join("claude-statusline.10.json")), "by number, not by name: 10 arrived after 9");
        let elsewhere = scratch("claude-records-elsewhere").join("x.json");
        fs::write(&elsewhere, "{}").unwrap();
        std::os::unix::fs::symlink(&elsewhere, dir.join("claude-statusline.30.json")).unwrap();
        assert_eq!(newest_claude_record(&dir), Some(dir.join("claude-statusline.10.json")), "a link is never a record");
        assert_eq!(newest_claude_record(&dir.join("missing")), None);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(elsewhere.parent().unwrap());
    }

    /// The app reads the record whose payload says the most, whatever its number, and removes
    /// only what it outranks: never another config dir's, never one still being written, never
    /// through a link (#398 audit r7).
    #[test]
    fn the_claude_record_read_is_chosen_by_what_it_says_and_only_what_it_outranks_goes() {
        let dir = scratch("claude-choose");
        let write = |order: u64, config: &str, weekly: f64, session: f64, weekly_reset: i64| {
            let path = dir.join(format!("claude-statusline.{order}.json"));
            let body = serde_json::json!({ "at": NOW - 10, "configDir": config, "payload": { "rate_limits": {
                "five_hour": { "used_percentage": session, "resets_at": NOW + 3_600 },
                "seven_day": { "used_percentage": weekly, "resets_at": weekly_reset } } } });
            fs::write(&path, body.to_string()).unwrap();
            set_mtime(&path, NOW - 10);
            path
        };
        let week = NOW + 86_400;
        let newest = write(3, "/c", 41.0, 12.0, week);
        let older_later_number = write(9, "/c", 40.0, 30.0, week);
        let same_weekly_less_session = write(2, "/c", 41.0, 11.0, week);
        let other_dir = write(10, "/other", 90.0, 90.0, week);
        let writing = dir.join("claude-statusline.11.json");
        fs::write(&writing, "").unwrap();
        set_mtime(&writing, NOW - CLAUDE_UNREADABLE_GRACE + 1);
        let abandoned = dir.join("claude-statusline.1.json");
        fs::write(&abandoned, "{").unwrap();
        set_mtime(&abandoned, NOW - CLAUDE_UNREADABLE_GRACE - 1);
        let outside = scratch("claude-choose-outside").join("theirs.json");
        fs::write(&outside, "keep").unwrap();
        let link = dir.join("claude-statusline.0.json");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let (path, status) = choose_claude_record(&dir, Path::new("/c"), NOW, &|_| true).expect("a reading");
        assert_eq!(path, newest, "the most the payloads say, not the highest number");
        assert_eq!(weekly(&status.reading.lines).unwrap().1, 41.0);
        assert!(!older_later_number.exists() && !same_weekly_less_session.exists(), "what it outranks is removed");
        assert!(other_dir.exists(), "another config dir's record is not compared, so not removed");
        assert!(writing.exists(), "one still being written is left");
        assert!(!abandoned.exists(), "one that has not parsed for the grace is removed");
        assert!(fs::symlink_metadata(&link).is_ok() && fs::read_to_string(&outside).unwrap() == "keep", "a link is never a record");

        // A later week outranks a higher share, and however many higher numbers follow, a lower
        // number that says more is still read and kept.
        let next_week = write(12, "/c", 1.0, 1.0, week + 7 * 86_400);
        assert_eq!(choose_claude_record(&dir, Path::new("/c"), NOW, &|_| true).unwrap().0, next_week);
        assert!(!newest.exists());
        let paused = write(13, "/c", 2.0, 1.0, week + 7 * 86_400);
        for order in 100..200 {
            write(order, "/c", 1.0, 1.0, week + 7 * 86_400);
            fs::write(dir.join(format!("claude-statusline.{}.json", order + 1000)), "").unwrap();
        }
        assert_eq!(choose_claude_record(&dir, Path::new("/c"), NOW, &|_| true).unwrap().0, paused, "order never decides");
        assert!(other_dir.exists() && writing.exists(), "another config dir's and a record being written are kept");

        // The same figures: the later arrival wins, whatever number it reserved.
        let timed = scratch("claude-choose-timed");
        let at = |order: u64, at: i64| {
            let path = timed.join(format!("claude-statusline.{order}.json"));
            let body = serde_json::json!({ "at": at, "configDir": "/c", "payload": { "rate_limits": {
                "five_hour": { "used_percentage": 5.0, "resets_at": NOW + 3_600 },
                "seven_day": { "used_percentage": 5.0, "resets_at": week } } } });
            fs::write(&path, body.to_string()).unwrap();
            set_mtime(&path, NOW - 10);
            path
        };
        let later = at(4, NOW - 20);
        let earlier_higher_number = at(5, NOW - 900);
        assert_eq!(choose_claude_record(&timed, Path::new("/c"), NOW, &|_| true).unwrap().0, later, "time, then number");
        assert!(!earlier_higher_number.exists());
        let _ = fs::remove_dir_all(&timed);

        // Another account in the same config dir, with a later Weekly reset, outranks by content
        // but is not this account's: it is never chosen, and neither record is removed for it.
        let two = scratch("claude-choose-two-accounts");
        let account = |order: u64, weekly_reset: i64| {
            let path = two.join(format!("claude-statusline.{order}.json"));
            let body = serde_json::json!({ "at": NOW - 10, "configDir": "/c", "payload": { "rate_limits": {
                "five_hour": { "used_percentage": 5.0, "resets_at": NOW + 3_600 },
                "seven_day": { "used_percentage": 60.0, "resets_at": weekly_reset } } } });
            fs::write(&path, body.to_string()).unwrap();
            set_mtime(&path, NOW - 10);
            path
        };
        let mine = account(1, WEEKLY_RESET);
        let theirs = account(2, WEEKLY_RESET + 7 * 86_400);
        let base = api_snapshot("claude", NOW - 900);
        let reading = claude_local_latest(&two, Path::new("/c"), Some(&base), NOW).expect("this account's reading");
        assert_eq!(weekly(&reading.lines).unwrap().0, WEEKLY_RESET);
        assert!(mine.exists() && theirs.exists(), "another account's record neither wins nor removes this one");
        let _ = fs::remove_dir_all(&two);
        assert!(choose_claude_record(&dir.join("missing"), Path::new("/c"), NOW, &|_| true).is_none());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(outside.parent().unwrap());
    }

    #[test]
    fn a_linked_log_or_status_file_is_not_followed() {
        let home = scratch("codex-link");
        let real = rollout(&home, "real", ACCOUNT, &[token_count(NOW - 30, 1.0, 2.0)], NOW - 20);
        assert!(codex_local(&home, Some(ACCOUNT), NOW).is_some(), "premise");
        let moved = home.join("elsewhere.jsonl");
        fs::rename(&real, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &real).unwrap();
        assert!(codex_local(&home, Some(ACCOUNT), NOW).is_none());

        let dir = scratch("claude-link");
        let base = api_snapshot("claude", NOW - 900);
        let real = claude_file(&dir, NOW - 30, "/c", WEEKLY_RESET, NOW - 20);
        let link = dir.join("link.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(claude_local(&real, Path::new("/c"), Some(&base), NOW).is_some(), "premise");
        assert!(claude_local(&link, Path::new("/c"), Some(&base), NOW).is_none());
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&dir);
    }

    // 398-14 -----------------------------------------------------------------------------

    #[test]
    fn usage_settings_take_only_the_offered_intervals() {
        for minutes in REFRESH_MINUTES {
            let got = settings_from(&(minutes * 60_000).into(), &"used".into());
            assert_eq!(got.refresh, Duration::from_secs(minutes * 60));
            assert_eq!(got.mode, UsageMode::Used);
        }
        for bad in [
            serde_json::json!(3 * 60_000),
            serde_json::json!(10 * 60_000),
            serde_json::json!(5 * 60_000 + 1),
            serde_json::json!("300000"),
            serde_json::json!(-300000),
            Value::Null,
        ] {
            assert_eq!(settings_from(&bad, &Value::Null).refresh, DEFAULT_REFRESH, "{bad}");
        }
        assert_eq!(settings_from(&Value::Null, &"sideways".into()).mode, UsageMode::Left);
        assert_eq!(DEFAULT_REFRESH, Duration::from_secs(5 * 60));
    }
}
