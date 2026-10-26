//! Heavy runs that bypass the helper (#245), seen from the process table.
//!
//! The heavy-run queue knows only the runs started through `gyredeck-heavy.mjs`. A
//! `pnpm test:demo` or `cargo test` started any other way held the CPU unseen while queued
//! helpers started on top of it. Every five seconds this thread lists the processes, keeps
//! the current user's whose command matches a heavy pattern, and reports them to the bridge
//! (`PUT /heavy/observed`, the app's word only), which grants nobody the slot while one runs.
//!
//! Observing never touches the process: nothing here signals, waits on, or slows it. Only
//! the pattern it matched, its executable's name, its cwd and pid leave this module — never
//! its argv, which may hold secrets.
//!
//! Who is not observed: a helper (its own argv says `-- cargo test`, but the command it
//! names runs behind it), anything started below a helper, and the granted run's process
//! group — recognised by the pgid together with its leader's start time, as `holder.json`
//! records it, because a pgid alone can belong to a later group.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The commands observed out of the box. Rust is the source for observation; the bridge's
/// `HEAVY_COMMANDS` (what the rules call heavy) is compared with it by a test.
pub(crate) const DEFAULT_PATTERNS: &[&str] = &[
    "pnpm test:*",
    "pnpm desktop:build",
    "pnpm desktop:install",
    "cargo test|build|check",
    "playwright test",
    "vitest",
    "tsc -b",
];
pub(crate) const SCAN_INTERVAL: Duration = Duration::from_secs(5);
pub(crate) const MAX_CUSTOM_PATTERNS: usize = 32;
pub(crate) const MAX_PATTERN_CHARS: usize = 120;
const MAX_PATTERN_WORDS: usize = 8;
const MAX_REPORTED: usize = 32;
const MAX_ANCESTRY: usize = 64;
const PATTERNS_FILE_MAX: u64 = 16 * 1024;
/// The command name every heavy-run helper has: `node …/gyredeck-heavy.mjs`.
const HELPER_NAME: &str = "gyredeck-heavy";
/// Programs whose first argument names the program that is really running.
const INTERPRETERS: &[&str] = &["node", "nodejs", "bun", "deno", "python", "python3", "ruby", "perl"];
/// Interpreter options whose value is the next argument, not the script.
const OPTIONS_WITH_VALUE: &[&str] = &["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--env-file", "-W", "-X"];

/// One heavy pattern: a command name, then words its arguments must hold in order. A word
/// may list alternatives with `|` and use `*`. An option word (`-b`) is looked for anywhere
/// after the last word matched; any other word is compared with the next argument that is
/// not an option (`-x`, `+toolchain`), so `cargo +nightly test --release` is `cargo test`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Pattern {
    text: String,
    name: Vec<String>,
    words: Vec<Vec<String>>,
}

impl Pattern {
    pub(crate) fn parse(text: &str) -> Result<Self, String> {
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            return Err("A pattern needs a command".to_string());
        }
        if text.chars().count() > MAX_PATTERN_CHARS {
            return Err(format!("A pattern is at most {MAX_PATTERN_CHARS} characters"));
        }
        if text.chars().any(char::is_control) {
            return Err("A pattern holds no control characters".to_string());
        }
        let mut words = text.split(' ').map(|word| word.split('|').map(str::to_string).collect::<Vec<_>>());
        let name = words.next().unwrap_or_default();
        let words: Vec<Vec<String>> = words.collect();
        if words.len() + 1 > MAX_PATTERN_WORDS {
            return Err(format!("A pattern is at most {MAX_PATTERN_WORDS} words"));
        }
        if name.iter().chain(words.iter().flatten()).any(|alternative| alternative.is_empty() || alternative.chars().all(|c| c == '*')) {
            return Err("Every word of a pattern says something besides *".to_string());
        }
        if name.iter().any(|alternative| alternative.starts_with('-')) {
            return Err("A pattern starts with a command, not an option".to_string());
        }
        Ok(Self { text, name, words })
    }

    pub(crate) fn text(&self) -> &str {
        &self.text
    }

    /// The command name it matched by, when it matches.
    fn matches<'a>(&self, names: &'a [String], args: &[String]) -> Option<&'a str> {
        let name = names.iter().find(|name| self.name.iter().any(|alternative| glob(alternative, name)))?;
        let mut at = 0;
        for word in &self.words {
            let option = word.iter().all(|alternative| alternative.starts_with('-'));
            if option {
                match args[at..].iter().position(|arg| word.iter().any(|alternative| glob(alternative, arg))) {
                    Some(found) => at += found + 1,
                    None => return None,
                }
            } else {
                let Some(found) = args[at..].iter().position(|arg| !arg.starts_with('-') && !arg.starts_with('+')) else {
                    return None;
                };
                if !word.iter().any(|alternative| glob(alternative, &args[at + found])) {
                    return None;
                }
                at += found + 1;
            }
        }
        Some(name)
    }

    /// The executable names a process must have for this pattern to be worth reading its
    /// argv: the pattern's own command, or none to say every process is.
    fn prefilter(&self) -> Option<Vec<String>> {
        if self.name.iter().any(|alternative| alternative.contains('*')) {
            return None;
        }
        Some(self.name.iter().map(|name| truncate_comm(name)).collect())
    }
}

/// `*` matches any run of characters, everything else itself.
fn glob(pattern: &str, value: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == value;
    }
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if !value.starts_with(first) || value.len() < first.len() + last.len() || !value.ends_with(last) {
        return false;
    }
    let mut rest = &value[first.len()..value.len() - last.len()];
    for part in &parts[1..parts.len() - 1] {
        match rest.find(part) {
            Some(index) => rest = &rest[index + part.len()..],
            None => return false,
        }
    }
    true
}

/// The kernel keeps 16 bytes of an executable's name (`MAXCOMLEN`).
fn truncate_comm(name: &str) -> String {
    let mut end = name.len().min(16);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    name[..end].to_string()
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn stem(name: &str) -> &str {
    for extension in [".js", ".mjs", ".cjs", ".ts", ".mts", ".py"] {
        if let Some(stripped) = name.strip_suffix(extension) {
            return stripped;
        }
    }
    name
}

/// What a process is running, anchored after its interpreter, and where its arguments start:
/// `node /opt/homebrew/bin/pnpm test:demo` is `pnpm` with `[test:demo]`. A script called
/// `cli.js` or `index.js` inside `node_modules` is named by its package — both halves of a
/// scoped one, so `@playwright/test/cli.js` answers to `playwright` as well as `test`.
/// Inline code (`node -e`) names nothing.
pub(crate) fn command_names(argv: &[String]) -> Option<(Vec<String>, usize)> {
    let first = argv.first()?;
    let program = file_name(first);
    if !INTERPRETERS.contains(&program) && !program.starts_with("python3.") {
        return Some((vec![program.to_string()], 1));
    }
    let mut index = 1;
    while let Some(arg) = argv.get(index) {
        if arg == "-e" || arg == "-p" || arg == "-c" || arg == "--eval" || arg == "--print" {
            return None;
        }
        if arg == "-m" {
            return argv.get(index + 1).map(|module| (vec![module.clone()], index + 2));
        }
        if !arg.starts_with('-') {
            break;
        }
        index += if OPTIONS_WITH_VALUE.contains(&arg.as_str()) { 2 } else { 1 };
    }
    let script = argv.get(index)?;
    let name = stem(file_name(script));
    if matches!(name, "cli" | "index" | "main") {
        if let Some((_, package)) = script.rsplit_once("/node_modules/") {
            let parts: Vec<&str> = package.split('/').collect();
            let names = match parts.as_slice() {
                [scope, package, _, ..] if scope.starts_with('@') => vec![package.to_string(), scope.trim_start_matches('@').to_string()],
                [package, _, ..] => vec![package.to_string()],
                _ => vec![name.to_string()],
            };
            return Some((names, index + 1));
        }
    }
    Some((vec![name.to_string()], index + 1))
}

/// One row of the process table, as much of it as the scan needs. `argv` is read only for
/// the current user's processes that could match, and never leaves this module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProcRow {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
    pub uid: u32,
    pub start_secs: i64,
    pub comm: String,
    pub argv: Option<Vec<String>>,
}

/// The granted run as `holder.json` records it. `pgid_start` is the group leader's start
/// time as `ps -o lstart` prints it; a record from before #243 has none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HolderGroup {
    pub pgid: i32,
    pub pgid_start: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AgentKind {
    Claude,
    Antigravity,
    Codex,
}

impl AgentKind {
    fn of(name: &str) -> Option<Self> {
        match name {
            "claude" | "claude-code" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ if crate::broker::KnownCli::from_executable_name(name) == Some(crate::broker::KnownCli::Antigravity) => Some(Self::Antigravity),
            _ => None,
        }
    }

    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Antigravity => "agy",
            Self::Codex => "codex",
        }
    }
}

/// A heavy run nobody queued: the topmost matching process of its tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ObservedRun {
    pub pid: i32,
    pub pattern: String,
    pub exe: String,
    pub started_at_secs: i64,
    /// The nearest agent CLI above it, if any: the session that started it.
    pub agent: Option<(AgentKind, i32)>,
}

/// The observation itself, from a table and nothing else, so every path is testable.
/// `lstart` turns a start time into the form `holder.json` keeps it in.
pub(crate) fn observe(
    rows: &[ProcRow],
    patterns: &[Pattern],
    my_uid: u32,
    holder: Option<&HolderGroup>,
    lstart: &dyn Fn(i64) -> Option<String>,
) -> Vec<ObservedRun> {
    let by_pid: HashMap<i32, &ProcRow> = rows.iter().map(|row| (row.pid, row)).collect();
    let names: HashMap<i32, (Vec<String>, usize)> = rows
        .iter()
        .filter_map(|row| Some((row.pid, command_names(row.argv.as_ref()?)?)))
        .collect();
    let helpers: HashSet<i32> = names
        .iter()
        .filter(|(_, (names, _))| names.iter().any(|name| name == HELPER_NAME || stem(name) == HELPER_NAME))
        .map(|(pid, _)| *pid)
        .collect();
    // The granted run's group, only while it is the group that was verified: its leader
    // started when the record says, or has exited while the group lives on (macOS hands out
    // no pid still in use as a group id). A leader started at another time means the id now
    // belongs to someone else, whose processes are observed like anybody's.
    let held_group = holder.and_then(|holder| {
        let started = holder.pgid_start.as_ref()?;
        match by_pid.get(&holder.pgid) {
            None => Some(holder.pgid),
            Some(leader) if leader.pgid == holder.pgid && lstart(leader.start_secs).as_ref() == Some(started) => Some(holder.pgid),
            Some(_) => None,
        }
    });
    let ancestors = |pid: i32| {
        let mut chain = Vec::new();
        let mut at = by_pid.get(&pid).map(|row| row.ppid);
        while let Some(parent) = at {
            if parent <= 1 || chain.len() >= MAX_ANCESTRY || chain.contains(&parent) {
                break;
            }
            chain.push(parent);
            at = by_pid.get(&parent).map(|row| row.ppid);
        }
        chain
    };
    let in_held_group = |pid: i32| held_group.is_some_and(|pgid| by_pid.get(&pid).is_some_and(|row| row.pgid == pgid));
    let matched: HashMap<i32, (&Pattern, String)> = rows
        .iter()
        .filter(|row| row.uid == my_uid)
        // Our own helper is never a heavy run, whatever the pattern list says: observing it
        // would hold the slot it is queued for, and the line would never move (#245 audit).
        .filter(|row| !helpers.contains(&row.pid))
        .filter_map(|row| {
            let (names, rest) = names.get(&row.pid)?;
            let args = &row.argv.as_ref()?[*rest..];
            patterns.iter().find_map(|pattern| Some((row.pid, (pattern, pattern.matches(names, args)?.to_string()))))
        })
        .filter(|(pid, _)| {
            !in_held_group(*pid) && !ancestors(*pid).iter().any(|ancestor| helpers.contains(ancestor) || in_held_group(*ancestor))
        })
        .collect();
    let mut runs: Vec<ObservedRun> = matched
        .iter()
        .filter(|(pid, _)| !ancestors(**pid).iter().any(|ancestor| matched.contains_key(ancestor)))
        .map(|(pid, (pattern, exe))| {
            let row = by_pid[pid];
            let agent = ancestors(*pid).into_iter().find_map(|ancestor| {
                let kind = AgentKind::of(&by_pid.get(&ancestor)?.comm)
                    .or_else(|| names.get(&ancestor)?.0.iter().find_map(|name| AgentKind::of(name)))?;
                Some((kind, ancestor))
            });
            ObservedRun {
                pid: *pid,
                pattern: pattern.text().to_string(),
                exe: exe.clone(),
                started_at_secs: row.start_secs,
                agent,
            }
        })
        .collect();
    runs.sort_by_key(|run| run.pid);
    runs.truncate(MAX_REPORTED);
    runs
}

/// Whether a process could match any pattern, judged by its executable's name alone, so
/// argv is read only for those.
pub(crate) fn wants_argv(patterns: &[Pattern]) -> impl Fn(&str) -> bool {
    let mut names: HashSet<String> = INTERPRETERS.iter().map(|name| name.to_string()).collect();
    let mut everything = false;
    for pattern in patterns {
        match pattern.prefilter() {
            Some(list) => names.extend(list),
            None => everything = true,
        }
    }
    move |comm: &str| everything || names.contains(comm) || comm.starts_with("python3.")
}

/// A start time as `ps -o lstart` prints it in the C locale, with runs of spaces made one,
/// which is how the bridge keeps `pgidStart`.
pub(crate) fn lstart(secs: i64) -> Option<String> {
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    #[cfg(target_os = "macos")]
    {
        let time = secs as libc::time_t;
        let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
        if unsafe { libc::localtime_r(&time, &mut tm) }.is_null() {
            return None;
        }
        Some(format!(
            "{} {} {} {:02}:{:02}:{:02} {}",
            DAYS.get(tm.tm_wday as usize)?,
            MONTHS.get(tm.tm_mon as usize)?,
            tm.tm_mday,
            tm.tm_hour,
            tm.tm_min,
            tm.tm_sec,
            tm.tm_year + 1900
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (secs, DAYS, MONTHS);
        None
    }
}

fn config_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("gyredeck"))
}

/// The granted run, if `holder.json` names an active one. Anything unreadable is no holder:
/// then nothing is excluded by group, only by ancestry, and a run is at worst observed twice
/// over — it is never hidden.
pub(crate) fn read_holder(path: &std::path::Path) -> Option<HolderGroup> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > PATTERNS_FILE_MAX {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if value.get("state")?.as_str()? != "active" {
        return None;
    }
    let pgid = i32::try_from(value.get("pgid")?.as_i64()?).ok().filter(|pgid| *pgid > 1)?;
    let pgid_start = value.get("pgidStart").and_then(serde_json::Value::as_str).map(|start| start.split_whitespace().collect::<Vec<_>>().join(" "));
    Some(HolderGroup { pgid, pgid_start })
}

fn patterns_path() -> Option<PathBuf> {
    config_dir().map(|dir| dir.join("heavy-patterns.json"))
}

/// The person's own patterns (Q17): a `0600` file under `~/.config/gyredeck/`, written only
/// from Settings. An unsafe or malformed file is no patterns, said once on stderr.
pub(crate) fn read_custom_patterns(path: &std::path::Path) -> Vec<String> {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return Vec::new() };
    if !meta.is_file() || meta.len() > PATTERNS_FILE_MAX {
        eprintln!("gyredeck: {} is not a small regular file; no custom heavy patterns", path.display());
        return Vec::new();
    }
    let parsed = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| {
            (value.get("schemaVersion")?.as_u64()? == 1).then_some(())?;
            Some(value.get("patterns")?.as_array()?.iter().filter_map(|p| p.as_str().map(str::to_string)).collect::<Vec<_>>())
        });
    match parsed {
        Some(list) => clean_custom(&list).unwrap_or_default(),
        None => {
            eprintln!("gyredeck: {} is malformed; no custom heavy patterns", path.display());
            Vec::new()
        }
    }
}

/// Validate and normalise the person's list: each pattern parses, none repeats a default or
/// another, at most 32.
pub(crate) fn clean_custom(list: &[String]) -> Result<Vec<String>, String> {
    if list.len() > MAX_CUSTOM_PATTERNS {
        return Err(format!("At most {MAX_CUSTOM_PATTERNS} patterns of your own"));
    }
    let mut seen: HashSet<String> = DEFAULT_PATTERNS.iter().map(|p| p.to_string()).collect();
    let mut out = Vec::new();
    for entry in list {
        let pattern = Pattern::parse(entry)?;
        if pattern.name.iter().any(|alternative| glob(alternative, HELPER_NAME)) {
            return Err("That pattern would match Gyredeck's own heavy-run helper".to_string());
        }
        if seen.insert(pattern.text().to_string()) {
            out.push(pattern.text().to_string());
        }
    }
    Ok(out)
}

fn write_custom_patterns(path: &std::path::Path, list: &[String]) -> Result<(), String> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let dir = path.parent().ok_or("No folder for the patterns file")?;
    std::fs::create_dir_all(dir).map_err(|error| format!("Could not make {}: {error}", dir.display()))?;
    if std::fs::symlink_metadata(path).is_ok_and(|meta| !meta.is_file()) {
        return Err(format!("{} is not a regular file; nothing was written", path.display()));
    }
    let temp = dir.join(format!(".heavy-patterns.{}.tmp", std::process::id()));
    let body = serde_json::json!({ "schemaVersion": 1, "patterns": list }).to_string();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let written = options
        .open(&temp)
        .and_then(|mut file| file.write_all(body.as_bytes()).and_then(|()| file.sync_all()))
        .and_then(|()| std::fs::rename(&temp, path));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("The patterns could not be saved: {error}"));
    }
    Ok(())
}

/// The watcher's patterns, shared with the Settings commands.
#[derive(Default)]
pub(crate) struct HeavyWatchState {
    custom: Arc<Mutex<Vec<String>>>,
}

impl HeavyWatchState {
    pub(crate) fn load(&self) {
        if let (Some(path), Ok(mut custom)) = (patterns_path(), self.custom.lock()) {
            *custom = read_custom_patterns(&path);
        }
    }

    pub(crate) fn listing(&self) -> serde_json::Value {
        let custom = self.custom.lock().map(|list| list.clone()).unwrap_or_default();
        serde_json::json!({ "defaults": DEFAULT_PATTERNS, "custom": custom })
    }

    pub(crate) fn set(&self, list: &[String]) -> Result<serde_json::Value, String> {
        let cleaned = clean_custom(list)?;
        let path = patterns_path().ok_or("HOME is not set")?;
        write_custom_patterns(&path, &cleaned)?;
        *self.custom.lock().map_err(|_| "Heavy-run patterns are unavailable".to_string())? = cleaned;
        Ok(self.listing())
    }

    fn patterns(&self) -> Vec<Pattern> {
        let custom = self.custom.lock().map(|list| list.clone()).unwrap_or_default();
        DEFAULT_PATTERNS
            .iter()
            .map(|p| p.to_string())
            .chain(custom)
            .filter_map(|text| Pattern::parse(&text).ok())
            .collect()
    }
}

/// What one scan sends the bridge for one run.
fn wire_run(run: &ObservedRun, session_of: &dyn Fn(i32) -> Option<String>) -> serde_json::Value {
    serde_json::json!({
        "pid": run.pid,
        "pattern": run.pattern,
        "exe": run.exe,
        "cwd": platform::cwd(run.pid),
        "startedAtMs": run.started_at_secs.saturating_mul(1000),
        "agent": run.agent.map(|(kind, pid)| serde_json::json!({
            "kind": kind.wire(),
            "session": session_of(pid),
        })),
    })
}

/// One round: the table, the observation, and the runs as the bridge is told them.
pub(crate) struct Round {
    scanner: platform::Scanner,
}

impl Round {
    pub(crate) fn new() -> Self {
        Self { scanner: platform::Scanner::new() }
    }

    pub(crate) fn observe(&mut self, patterns: &[Pattern]) -> Vec<ObservedRun> {
        let rows = self.scanner.rows(&wants_argv(patterns));
        let uid = platform::my_uid();
        // `holder.json` is read only when something matched at all, which is rare.
        if observe(&rows, patterns, uid, None, &|_| None).is_empty() {
            return Vec::new();
        }
        let holder = config_dir().and_then(|dir| read_holder(&dir.join("heavy").join("holder.json")));
        observe(&rows, patterns, uid, holder.as_ref(), &lstart)
    }
}

/// Start the watcher: one thread, one round every five seconds, always — the window hidden
/// included (Q14). A bridge that cannot be reached is tried again next round.
pub(crate) fn start(
    state: &HeavyWatchState,
    app_word: String,
    session_of: Arc<dyn Fn(i32) -> Option<String> + Send + Sync>,
    emit: Arc<dyn Fn(serde_json::Value) + Send + Sync>,
) -> Result<(), String> {
    let custom = Arc::clone(&state.custom);
    std::thread::Builder::new()
        .name("gyredeck-heavy-watch".to_string())
        .spawn(move || {
            let state = HeavyWatchState { custom };
            let mut round = Round::new();
            let mut reported = false;
            loop {
                let runs = round.observe(&state.patterns());
                // An empty list is sent once, when the last run ends, so the line moves at once
                // rather than at the report's expiry; after that, nothing is sent at all.
                if !runs.is_empty() || reported {
                    let body = serde_json::json!({
                        "v": 1,
                        "runs": runs.iter().map(|run| wire_run(run, session_of.as_ref())).collect::<Vec<_>>(),
                    })
                    .to_string();
                    let sent = crate::standalone_bridge::bridge_request_vouched("PUT", "/heavy/observed", Some(body), &app_word)
                        .is_ok_and(|(status, _)| status == 200);
                    reported = !runs.is_empty() || !sent;
                }
                // The slot as the bridge now sees it, every round, for the notifications
                // (#244): helper runs start and end in the bridge, so it is asked rather
                // than inferred. The window may be hidden; the webview still hears it.
                if let Ok(state) = crate::standalone_bridge::heavy_status() {
                    emit(state);
                }
                std::thread::sleep(SCAN_INTERVAL);
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Failed to start the heavy-run watcher: {error}"))
}

#[cfg(target_os = "macos")]
mod platform {
    use super::ProcRow;

    pub(super) fn my_uid() -> u32 {
        unsafe { libc::getuid() }
    }

    /// Reused buffers: the pid list and one argv buffer the size of the kernel's limit.
    pub(crate) struct Scanner {
        pids: Vec<i32>,
        args: Vec<u8>,
    }

    impl Scanner {
        pub(crate) fn new() -> Self {
            let mut argmax: libc::c_int = 0;
            let mut size = std::mem::size_of::<libc::c_int>();
            let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
            let read = unsafe { libc::sysctl(mib.as_mut_ptr(), 2, (&mut argmax as *mut libc::c_int).cast(), &mut size, std::ptr::null_mut(), 0) };
            let argmax = if read == 0 && argmax > 0 { argmax as usize } else { 1024 * 1024 };
            Self { pids: Vec::new(), args: vec![0; argmax] }
        }

        /// Every process the kernel lists, with argv for the current user's processes
        /// `wants` names.
        pub(crate) fn rows(&mut self, wants: &dyn Fn(&str) -> bool) -> Vec<ProcRow> {
            let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
            if count <= 0 {
                return Vec::new();
            }
            self.pids.resize(count as usize + 64, 0);
            let bytes = (self.pids.len() * std::mem::size_of::<i32>()) as libc::c_int;
            let listed = unsafe { libc::proc_listallpids(self.pids.as_mut_ptr().cast(), bytes) };
            if listed <= 0 {
                return Vec::new();
            }
            let uid = my_uid();
            let mut rows = Vec::with_capacity(listed as usize);
            for &pid in &self.pids[..(listed as usize).min(self.pids.len())] {
                if pid <= 0 {
                    continue;
                }
                let Some(info) = bsd_info(pid) else { continue };
                let comm = c_name(&info.pbi_comm);
                let argv = (info.pbi_uid == uid && wants(&comm)).then(|| argv(pid, &mut self.args)).flatten();
                rows.push(ProcRow {
                    pid,
                    ppid: info.pbi_ppid as i32,
                    pgid: info.pbi_pgid as i32,
                    uid: info.pbi_uid,
                    start_secs: info.pbi_start_tvsec as i64,
                    comm,
                    argv,
                });
            }
            rows
        }
    }

    fn c_name(bytes: &[libc::c_char]) -> String {
        let bytes: Vec<u8> = bytes.iter().take_while(|byte| **byte != 0).map(|byte| *byte as u8).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn bsd_info(pid: i32) -> Option<libc::proc_bsdinfo> {
        let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
        let expected = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let read = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), expected) };
        (read == expected && info.pbi_pid != 0).then_some(info)
    }

    /// `KERN_PROCARGS2`: argc, the executable path, padding, then argv — and the
    /// environment after it, which is never read.
    fn argv(pid: i32, buffer: &mut [u8]) -> Option<Vec<String>> {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        let mut size = buffer.len();
        let read = unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buffer.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) };
        if read != 0 || size < 4 {
            return None;
        }
        let data = &buffer[..size];
        let argc = i32::from_ne_bytes(data[..4].try_into().ok()?);
        if argc <= 0 {
            return None;
        }
        let mut at = 4 + data[4..].iter().position(|byte| *byte == 0)?;
        while data.get(at) == Some(&0) {
            at += 1;
        }
        let mut args = Vec::with_capacity(argc as usize);
        for _ in 0..argc {
            let end = at + data.get(at..)?.iter().position(|byte| *byte == 0)?;
            args.push(String::from_utf8_lossy(&data[at..end]).into_owned());
            at = end + 1;
        }
        Some(args)
    }

    pub(super) fn cwd(pid: i32) -> Option<String> {
        let mut info = unsafe { std::mem::zeroed::<libc::proc_vnodepathinfo>() };
        let expected = std::mem::size_of::<libc::proc_vnodepathinfo>() as i32;
        let read = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, (&mut info as *mut libc::proc_vnodepathinfo).cast(), expected) };
        if read != expected {
            return None;
        }
        let bytes: Vec<u8> = info.pvi_cdir.vip_path.iter().flatten().take_while(|byte| **byte != 0).map(|byte| *byte as u8).collect();
        (!bytes.is_empty()).then(|| String::from_utf8_lossy(&bytes).into_owned())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    //! Observation is macOS-only for now: no table, so nothing is ever observed.
    use super::ProcRow;
    pub(super) fn my_uid() -> u32 {
        0
    }
    pub(crate) struct Scanner;
    impl Scanner {
        pub(crate) fn new() -> Self {
            Self
        }
        pub(crate) fn rows(&mut self, _wants: &dyn Fn(&str) -> bool) -> Vec<ProcRow> {
            Vec::new()
        }
    }
    pub(super) fn cwd(_pid: i32) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: u32 = 501;

    fn argv(line: &str) -> Option<Vec<String>> {
        Some(line.split(' ').map(str::to_string).collect())
    }

    fn row(pid: i32, ppid: i32, pgid: i32, comm: &str, line: &str) -> ProcRow {
        ProcRow { pid, ppid, pgid, uid: ME, start_secs: 1_000 + pid as i64, comm: comm.to_string(), argv: argv(line) }
    }

    fn defaults() -> Vec<Pattern> {
        DEFAULT_PATTERNS.iter().map(|p| Pattern::parse(p).unwrap()).collect()
    }

    fn fake_lstart(secs: i64) -> Option<String> {
        Some(format!("started {secs}"))
    }

    fn pids(runs: &[ObservedRun]) -> Vec<i32> {
        runs.iter().map(|run| run.pid).collect()
    }

    /// The same table with one row changed: the premise of each fixture is that only this
    /// row differs from a table where the run *is* observed.
    fn observed(rows: &[ProcRow], holder: Option<&HolderGroup>) -> Vec<i32> {
        pids(&observe(rows, &defaults(), ME, holder, &fake_lstart))
    }

    // A terminal (no agent), a shell, and a heavy command under it.
    fn terminal() -> Vec<ProcRow> {
        vec![
            row(100, 1, 100, "login", "login -pf me"),
            row(101, 100, 101, "zsh", "-zsh"),
        ]
    }

    #[test]
    fn anchored_matching_table() {
        // (argv, observed?) — every default and the anchoring rule, one line each.
        let cases: &[(&str, bool)] = &[
            ("node /opt/homebrew/bin/pnpm test:demo --workers=3", true),
            ("pnpm test:hooks", true),
            ("node /x/pnpm desktop:build", true),
            ("node /x/pnpm check", false),
            ("/Users/me/.cargo/bin/cargo test --lib", true),
            ("cargo +nightly build --release", true),
            ("cargo check", true),
            ("cargo fmt", false),
            ("node /r/node_modules/.pnpm/@playwright+test@1.64.1/node_modules/@playwright/test/cli.js test --workers=3", true),
            ("node /r/node_modules/playwright/cli.js test", true),
            ("node /r/node_modules/vitest/vitest.mjs run", true),
            ("node /r/node_modules/typescript/bin/tsc -p . -b", true),
            ("node /r/node_modules/typescript/bin/tsc --noEmit", false),
            ("node --require ./x.js /opt/homebrew/bin/pnpm test:demo", true),
            // Unanchored words do not match: the command is something else.
            ("grep cargo test", false),
            ("node -e cargo test", false),
            ("vim pnpm test:demo", false),
            ("node /x/gyredeck-heavy.mjs --as a --what w -- cargo test", false),
        ];
        for (line, want) in cases {
            let mut rows = terminal();
            rows.push(row(200, 101, 200, file_name(line.split(' ').next().unwrap()), line));
            // Premise: every case names a heavy word somewhere in its argv.
            assert!(["pnpm", "cargo", "playwright", "vitest", "tsc"].iter().any(|word| line.contains(word)), "{line}");
            assert_eq!(observed(&rows, None) == vec![200], *want, "{line}");
        }
    }

    #[test]
    fn c1_a_queued_helper_is_not_observed() {
        let mut rows = terminal();
        rows.push(row(200, 101, 200, "node", "node /Users/me/.config/gyredeck/gyredeck-heavy.mjs --as s1 --what tests -- cargo test"));
        // Premise: the words a naive match would see are all there, after `--`.
        let line = rows[2].argv.as_ref().unwrap();
        assert!(line.windows(2).any(|pair| pair[0] == "cargo" && pair[1] == "test"));
        assert_eq!(observed(&rows, None), Vec::<i32>::new());
        // Control: the same words as the command itself are observed.
        rows[2] = row(200, 101, 200, "cargo", "cargo test");
        assert_eq!(observed(&rows, None), vec![200]);
    }

    #[test]
    fn custom_pattern_does_not_observe_the_helper_itself() {
        // A queued helper, and patterns of the person's own that name it.
        let mut rows = terminal();
        rows.push(row(200, 101, 200, "node", "node /Users/me/.config/gyredeck/gyredeck-heavy.mjs --as s1 --what tests -- cargo test"));
        let (names, rest) = command_names(rows[2].argv.as_ref().unwrap()).unwrap();
        for text in ["gyredeck-heavy", "gyredeck-*", "gyredeck-heavy --as"] {
            let pattern = Pattern::parse(text).unwrap();
            // Premise: the pattern itself matches the helper's command.
            assert!(pattern.matches(&names, &rows[2].argv.as_ref().unwrap()[rest..]).is_some(), "{text}");
            assert_eq!(pids(&observe(&rows, &[pattern], ME, None, &fake_lstart)), Vec::<i32>::new(), "{text}");
            // And Settings refuses to save it.
            assert!(clean_custom(&[text.to_string()]).is_err(), "{text}");
        }
        // Control: the same pattern observes a process of that name that is not ours.
        rows[2] = row(200, 101, 200, "gyredeck-heav", "gyredeck-heavyweight run");
        assert_eq!(pids(&observe(&rows, &[Pattern::parse("gyredeck-*").unwrap()], ME, None, &fake_lstart)), vec![200]);
    }

    /// The granted run: helper 200, its gated group 300 (leader 300), a setsid child 310 in a
    /// group of its own, and a reused-pgid stranger.
    fn granted() -> Vec<ProcRow> {
        let mut rows = terminal();
        rows.push(row(200, 101, 200, "node", "node /h/gyredeck-heavy.mjs --as s1 --what tests -- pnpm test:demo"));
        rows.push(row(300, 200, 300, "node", "node /opt/homebrew/bin/pnpm test:demo"));
        rows.push(row(301, 300, 300, "node", "node /r/node_modules/@playwright/test/cli.js test"));
        rows
    }

    fn holder_of(rows: &[ProcRow], pgid: i32) -> HolderGroup {
        let leader = rows.iter().find(|row| row.pid == pgid).unwrap();
        HolderGroup { pgid, pgid_start: fake_lstart(leader.start_secs) }
    }

    #[test]
    fn c2_the_granted_run_is_excluded_by_its_verified_group() {
        // The helper was killed with -9: its group runs on, re-parented to launchd. Only the
        // group says whose it is now.
        let mut rows = granted();
        rows.retain(|row| row.pid != 200);
        rows.iter_mut().find(|row| row.pid == 300).unwrap().ppid = 1;
        let holder = holder_of(&rows, 300);
        // Premise: nothing in the ancestry is a helper, so ancestry alone excludes nothing.
        assert_eq!(observed(&rows, None), vec![300]);
        assert_eq!(observed(&rows, Some(&holder)), Vec::<i32>::new());
        // A leader that exited while its group runs on is still the verified group.
        let mut leaderless = rows.clone();
        leaderless.retain(|row| row.pid != 300);
        leaderless.iter_mut().find(|row| row.pid == 301).unwrap().ppid = 1;
        assert_eq!(observed(&leaderless, None), vec![301]);
        assert_eq!(observed(&leaderless, Some(&holder)), Vec::<i32>::new());
    }

    #[test]
    fn c2_the_granted_run_is_excluded_by_ancestry() {
        // Playwright setsid'd a worker into its own group: the pgid no longer says it is the
        // granted run's, its ancestry does.
        let mut rows = granted();
        rows.push(row(310, 301, 310, "node", "node /r/node_modules/vitest/vitest.mjs"));
        let holder = holder_of(&rows, 300);
        // Premise: 310 is outside the held group and matches on its own.
        assert_ne!(rows.last().unwrap().pgid, holder.pgid);
        let alone: Vec<ProcRow> = terminal().into_iter().chain([row(310, 101, 310, "node", "node /r/node_modules/vitest/vitest.mjs")]).collect();
        assert_eq!(observed(&alone, None), vec![310]);
        assert_eq!(observed(&rows, Some(&holder)), Vec::<i32>::new());
        // A record from before #243 has no start time: excluded by ancestry only — the
        // helper above it — and still excluded.
        assert_eq!(observed(&rows, Some(&HolderGroup { pgid: 300, pgid_start: None })), Vec::<i32>::new());
        // The helper gone too: the setsid worker is the verified group's descendant, and
        // that ancestry alone excludes it.
        let mut orphaned = rows.clone();
        orphaned.retain(|row| row.pid != 200);
        orphaned.iter_mut().find(|row| row.pid == 300).unwrap().ppid = 1;
        assert_eq!(observed(&orphaned, Some(&HolderGroup { pgid: 300, pgid_start: None })), vec![300], "premise: no helper, no verified group");
        assert_eq!(observed(&orphaned, Some(&holder)), Vec::<i32>::new());
    }

    #[test]
    fn c2_a_reused_pgid_is_not_the_granted_run() {
        // holder.json names group 300, but 300 is now a different process, started later,
        // with nothing of the helper's above it.
        let mut rows = terminal();
        rows.push(row(300, 101, 300, "cargo", "cargo build"));
        let stale = HolderGroup { pgid: 300, pgid_start: fake_lstart(1) };
        // Premise: the recorded start is not the leader's.
        assert_ne!(stale.pgid_start, fake_lstart(rows[2].start_secs));
        assert_eq!(observed(&rows, Some(&stale)), vec![300]);
        // And a bare pgid never excludes: a legacy record whose group is a stranger's.
        assert_eq!(observed(&rows, Some(&HolderGroup { pgid: 300, pgid_start: None })), vec![300]);
    }

    #[test]
    fn one_run_is_one_observation_and_it_names_its_agent() {
        let mut rows = vec![
            row(100, 1, 100, "claude", "claude"),
            row(101, 100, 101, "zsh", "/bin/zsh -c pnpm test:demo"),
            row(200, 101, 101, "node", "node /opt/homebrew/bin/pnpm test:demo"),
            row(201, 200, 101, "sh", "sh -c playwright test"),
            row(202, 201, 101, "node", "node /r/node_modules/@playwright/test/cli.js test"),
        ];
        // Premise: both 200 and 202 match on their own.
        assert_eq!(observed(&rows[..3], None), vec![200]);
        let worker: Vec<ProcRow> = terminal().into_iter().chain([row(202, 101, 202, "node", "node /r/node_modules/@playwright/test/cli.js test")]).collect();
        assert_eq!(observed(&worker, None), vec![202]);
        let runs = observe(&rows, &defaults(), ME, None, &fake_lstart);
        assert_eq!(pids(&runs), vec![200]);
        assert_eq!(runs[0].pattern, "pnpm test:*");
        assert_eq!(runs[0].exe, "pnpm");
        assert_eq!(runs[0].agent, Some((AgentKind::Claude, 100)));
        // A terminal has no agent above it.
        rows[0] = row(100, 1, 100, "login", "login -pf me");
        assert_eq!(observe(&rows, &defaults(), ME, None, &fake_lstart)[0].agent, None);
        // agy that updated itself, and Codex, are agents too.
        for (comm, kind) in [("agy.1771.old", AgentKind::Antigravity), ("codex", AgentKind::Codex), ("agy", AgentKind::Antigravity)] {
            rows[0] = row(100, 1, 100, comm, comm);
            assert_eq!(observe(&rows, &defaults(), ME, None, &fake_lstart)[0].agent, Some((kind, 100)), "{comm}");
        }
    }

    #[test]
    fn another_users_process_is_not_observed() {
        let mut rows = terminal();
        rows.push(row(200, 101, 200, "cargo", "cargo test"));
        assert_eq!(observed(&rows, None), vec![200]);
        rows[2].uid = ME + 1;
        assert_eq!(observed(&rows, None), Vec::<i32>::new());
    }

    #[test]
    fn what_leaves_the_module_holds_no_argv() {
        let mut rows = terminal();
        rows.push(row(200, 101, 200, "cargo", "cargo test --token=s3cr3t-value"));
        let runs = observe(&rows, &defaults(), ME, None, &fake_lstart);
        assert_eq!(runs.len(), 1);
        let shown = format!("{:?}", runs[0]);
        assert!(!shown.contains("s3cr3t"), "{shown}");
    }

    #[test]
    fn patterns_parse_and_refuse() {
        for good in ["make check", "node scripts/full-check", "bun test", "tsc -b|--build", "./full-check.sh"] {
            assert!(Pattern::parse(good).is_ok(), "{good}");
        }
        for bad in ["", "   ", "*", "cargo *", "-b", &"x".repeat(MAX_PATTERN_CHARS + 1), "a b c d e f g h i", "cargo te|"] {
            assert!(Pattern::parse(bad).is_err(), "{bad:?}");
        }
        assert_eq!(Pattern::parse("  make   check ").unwrap().text(), "make check");
        assert_eq!(clean_custom(&["make check".into(), "make  check".into(), "cargo test|build|check".into()]).unwrap(), vec!["make check"]);
        assert!(clean_custom(&vec!["make check".to_string(); MAX_CUSTOM_PATTERNS + 1]).is_err());
        // A user pattern is observed like a default one.
        let custom = Pattern::parse("make check").unwrap();
        let mut rows = terminal();
        rows.push(row(200, 101, 200, "make", "make -j8 check"));
        assert_eq!(pids(&observe(&rows, &[custom], ME, None, &fake_lstart)), vec![200]);
        assert!(wants_argv(&defaults())("cargo") && wants_argv(&defaults())("node") && !wants_argv(&defaults())("Safari"));
    }

    #[test]
    fn the_patterns_file_round_trips_private_and_refuses_a_link() {
        let dir = std::env::temp_dir().join(format!("gyredeck-heavy-patterns-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("heavy-patterns.json");
        write_custom_patterns(&path, &["make check".to_string()]).unwrap();
        assert_eq!(read_custom_patterns(&path), vec!["make check"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            let link = dir.join("link.json");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert_eq!(read_custom_patterns(&link), Vec::<String>::new());
            assert!(write_custom_patterns(&link, &[]).is_err());
        }
        std::fs::write(&path, "{\"schemaVersion\":2,\"patterns\":[\"make check\"]}").unwrap();
        assert_eq!(read_custom_patterns(&path), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn holder_json_is_read_as_the_bridge_writes_it() {
        let dir = std::env::temp_dir().join(format!("gyredeck-heavy-holder-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("holder.json");
        std::fs::write(&path, r#"{"v":1,"state":"active","pgid":4242,"pgidStart":"Mon Oct  5 04:08:05 2026"}"#).unwrap();
        assert_eq!(read_holder(&path), Some(HolderGroup { pgid: 4242, pgid_start: Some("Mon Oct 5 04:08:05 2026".into()) }));
        std::fs::write(&path, r#"{"v":1,"state":"reserved","pgid":null}"#).unwrap();
        assert_eq!(read_holder(&path), None);
        std::fs::write(&path, r#"{"v":1,"state":"active","pgid":4242}"#).unwrap();
        assert_eq!(read_holder(&path), Some(HolderGroup { pgid: 4242, pgid_start: None }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Q15: everything the rules call heavy is observed by the defaults.
    #[test]
    fn the_defaults_cover_the_bridges_heavy_commands() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../adapters/bridge/gyredeck-bridge.mjs")).unwrap();
        let line = source.lines().find(|line| line.starts_with("export const HEAVY_COMMANDS = [")).expect("HEAVY_COMMANDS in the bridge");
        let commands: Vec<&str> = line.split('"').skip(1).step_by(2).collect();
        assert!(commands.len() >= 9, "{line}");
        for command in commands {
            let full = if command.contains(':') { format!("pnpm {command}") } else { command.to_string() };
            let mut rows = terminal();
            rows.push(row(200, 101, 200, full.split(' ').next().unwrap(), &full));
            assert_eq!(observed(&rows, None), vec![200], "{full} is heavy to the rules but not observed");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn lstart_matches_the_c_locale_clock_on_single_and_double_digit_days() {
        // 2026-10-05 and 2026-10-26, noon UTC: one day of each width. `date -r` in the C
        // locale prints what `ps -o lstart` does.
        for secs in [1_791_201_600_i64, 1_793_016_000] {
            let out = std::process::Command::new("date").env("LC_ALL", "C").args(["-r", &secs.to_string(), "+%a %b %e %H:%M:%S %Y"]).output().unwrap();
            let want = String::from_utf8_lossy(&out.stdout).split_whitespace().collect::<Vec<_>>().join(" ");
            assert_eq!(lstart(secs).as_deref(), Some(want.as_str()), "{secs}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn lstart_is_what_ps_prints() {
        let pid = std::process::id() as i32;
        let out = std::process::Command::new("ps").args(["-o", "lstart=", "-p", &pid.to_string()]).output().unwrap();
        let ps = String::from_utf8_lossy(&out.stdout).split_whitespace().collect::<Vec<_>>().join(" ");
        let scanner_row = platform::Scanner::new().rows(&|_| false).into_iter().find(|row| row.pid == pid).unwrap();
        assert_eq!(lstart(scanner_row.start_secs).as_deref(), Some(ps.as_str()));
    }

    /// C6, and the scanner against the real table: a matching process is observed, read from
    /// the kernel, and still running afterwards. Nothing in this module signals.
    #[cfg(target_os = "macos")]
    #[test]
    fn c6_scanning_never_signals_a_matching_process() {
        // Detached through a shell that exits, in a group of its own, so launchd is its parent:
        // this test may itself run as the granted heavy run, whose group and descendants are
        // rightly not observed.
        use std::os::unix::process::CommandExt;
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", "/bin/sleep 307.245 >/dev/null 2>&1 & echo $!"])
            .process_group(0)
            .output()
            .unwrap();
        let pid: i32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
        let pattern = Pattern::parse("sleep 307.245").unwrap();
        let mut round = Round::new();
        // The shell's child may not have exec'd `sleep` yet: a condition, not a count.
        let mut seen = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while seen.is_empty() && std::time::Instant::now() < deadline {
            seen = round.observe(std::slice::from_ref(&pattern));
            std::thread::sleep(Duration::from_millis(20));
        }
        for _ in 0..3 {
            seen = round.observe(std::slice::from_ref(&pattern));
        }
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        unsafe { libc::kill(pid, libc::SIGKILL) };
        // Premise: the real scan saw it — so it was a candidate the scanner acted on.
        assert_eq!(pids(&seen), vec![pid]);
        assert_eq!(seen[0].exe, "sleep");
        assert!(alive, "an observed process was ended by observing it");
        let source = include_str!("heavy_watch.rs");
        let body = &source[..source.find("#[cfg(test)]\nmod tests").unwrap()];
        for forbidden in ["kill(", "killpg", "SIGTERM", "SIGKILL", "SIGSTOP", "setpriority", "ptrace"] {
            assert!(!body.contains(forbidden), "the watcher mentions {forbidden}");
        }
    }

    /// Step 7: the cost of one round on this machine's real table, as CPU time of this
    /// thread, and what it is at one round per five seconds. Run with
    /// `cargo test --lib heavy_watch::tests::bench_scan_cpu -- --ignored --nocapture`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn bench_scan_cpu() {
        fn thread_cpu() -> Duration {
            let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
            unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
            Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
        }
        let rounds: u32 = std::env::var("GYREDECK_BENCH_ROUNDS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
        let patterns = defaults();
        let mut round = Round::new();
        let _ = round.observe(&patterns);
        let mut samples = Vec::with_capacity(rounds as usize);
        let wall = std::time::Instant::now();
        for _ in 0..rounds {
            let before = thread_cpu();
            std::hint::black_box(round.observe(&patterns));
            samples.push(thread_cpu() - before);
        }
        let wall = wall.elapsed();
        samples.sort();
        let total: Duration = samples.iter().sum();
        let mean = total / rounds;
        let p50 = samples[samples.len() / 2];
        let p95 = samples[samples.len() * 95 / 100];
        let rows = round.scanner.rows(&wants_argv(&patterns));
        let argv_read = rows.iter().filter(|row| row.argv.is_some()).count();
        let pct = |d: Duration| d.as_secs_f64() / SCAN_INTERVAL.as_secs_f64() * 100.0;
        println!(
            "heavy-watch bench: {rounds} rounds, {} processes ({argv_read} argv read), wall {:?}\n  cpu/round mean {:?} p50 {:?} p95 {:?}\n  at one round per {:?}: mean {:.4}% p95 {:.4}% of one core",
            rows.len(), wall, mean, p50, p95, SCAN_INTERVAL, pct(mean), pct(p95)
        );
        assert!(pct(p95) <= 1.0, "the scanner costs more than 1% of a core at its interval");
    }
}
