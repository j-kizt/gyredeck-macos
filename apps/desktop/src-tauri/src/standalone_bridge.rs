use std::{
    collections::VecDeque,
    fs,
    io::{ErrorKind, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub(crate) const BRIDGE_HOST: &str = "127.0.0.1";
pub(crate) const BRIDGE_PORT: u16 = 47_621;
const BRIDGE_MIN_PORT: u16 = 1024;
const BRIDGE_PROBE_TIMEOUT: Duration = Duration::from_millis(350);
// Mail calls carry a body and a reply, so they get more room than a health probe.
const MAIL_REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);
const BRIDGE_SUPERVISOR_INTERVAL: Duration = Duration::from_secs(1);
const OWNED_BRIDGE_FAILURE_LIMIT: u8 = 3;
/// How many of the bridge's last stderr lines are kept to be written down with a kill —
/// and how many bytes, in total and per line, because a line is whatever the bridge
/// chose to put before a newline, and one of 4 MiB was kept whole until both bounds
/// existed. A longer line is cut and says so.
const BRIDGE_STDERR_TAIL_LINES: usize = 40;
const BRIDGE_STDERR_TAIL_MAX_BYTES: usize = 8 * 1024;
const BRIDGE_STDERR_LINE_MAX_BYTES: usize = 512;
/// A record longer than this is replaced by a line saying so: the file has a cap, and one
/// record must not be the thing that blows through it.
const SUPERVISOR_RECORD_MAX_BYTES: usize = 64 * 1024;
/// How long an exited bridge's stderr is given to be read to its end before the exit is
/// written down — the pipe closes with the process, so this is a bound, not a wait.
const BRIDGE_STDERR_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
/// The supervisor log is rotated past this, one generation kept. It grows by a line per
/// start, exit or kill, so this is years of ordinary use and an afternoon of a crash loop.
const SUPERVISOR_LOG_MAX_BYTES: u64 = 256 * 1024;

/// Where the supervisor writes down what it did to the bridge, and why.
///
/// The kills of 2026-10-07 — three in an afternoon, every sync room lost each time — were
/// reported only through `eprintln!`, which nothing keeps once the app is not run from a
/// terminal. They had to be reproduced live to be proven at all. This file is the trace
/// that was missing: one JSON line per start, exit, kill and failed probe run, with the
/// probe failures that led to a kill and the bridge's last stderr lines beside it.
pub(crate) fn supervisor_log_path() -> Option<PathBuf> {
    super::home_dir().map(|home| {
        home.join(".config")
            .join("gyredeck")
            .join("gyredeck.supervisor.log")
    })
}

/// An append-only NDJSON log, private to the user, one generation of rotation.
#[derive(Clone)]
pub(crate) struct SupervisorLog {
    path: Option<PathBuf>,
}

impl SupervisorLog {
    pub(crate) fn at(path: Option<PathBuf>) -> Self {
        Self { path }
    }

    #[cfg(test)]
    fn none() -> Self {
        Self { path: None }
    }

    /// One line, with the time and the event's name in front of whatever else is given.
    /// Writing it can fail, and that is reported on stderr and not otherwise: the log is
    /// evidence for later, never something the supervisor's own loop depends on.
    pub(crate) fn record(&self, event: &str, mut fields: serde_json::Map<String, serde_json::Value>) {
        let Some(path) = self.path.as_ref() else {
            return;
        };
        let at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| "unknown".to_string());
        let mut line = serde_json::Map::new();
        line.insert("at".to_string(), serde_json::Value::String(at.clone()));
        line.insert("event".to_string(), serde_json::Value::String(event.to_string()));
        line.append(&mut fields);
        let mut text = serde_json::Value::Object(line).to_string();
        if text.len() > SUPERVISOR_RECORD_MAX_BYTES {
            let mut short = serde_json::Map::new();
            short.insert("at".to_string(), serde_json::Value::String(at));
            short.insert("event".to_string(), serde_json::Value::String(event.to_string()));
            short.insert("truncated".to_string(), serde_json::Value::Bool(true));
            short.insert("bytes".to_string(), serde_json::Value::from(text.len()));
            text = serde_json::Value::Object(short).to_string();
        }
        if let Err(error) = append_private_line(path, &text) {
            eprintln!(
                "Gyredeck could not write its supervisor log at {}: {error}",
                path.display()
            );
        }
    }
}

/// Append one line to a file that only the user may read, rotating it past the cap.
///
/// Created with mode 0600 and never widened: the events log was world-readable for a year
/// because nothing created it deliberately, and this one carries the bridge's stderr.
fn append_private_line(path: &Path, line: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut options = fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    // Narrowed on the handle, every time, and a failure is a failure: a file created
    // earlier by something less careful would otherwise be rotated aside still readable by
    // everyone, and "private" would be a word in a comment.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    if file.metadata()?.len() >= SUPERVISOR_LOG_MAX_BYTES {
        // Already private, so what is moved aside is too. The handle is dropped first: on
        // some filesystems a rename under an open append handle is refused.
        drop(file);
        fs::rename(path, path.with_extension("log.1"))?;
        return append_private_line(path, line);
    }
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")
}

/// The bridge's last stderr lines, kept so a kill can say what the bridge was saying.
///
/// Read on a thread of its own, line by line, each line also passed on to the app's own
/// stderr as it always was — `Stdio::inherit` used to do that, and gave the supervisor no
/// way to see any of it.
#[derive(Default)]
struct TailBuffer {
    lines: VecDeque<String>,
    bytes: usize,
}

impl TailBuffer {
    fn push(&mut self, line: String) {
        self.bytes += line.len();
        self.lines.push_back(line);
        while self.lines.len() > BRIDGE_STDERR_TAIL_LINES || self.bytes > BRIDGE_STDERR_TAIL_MAX_BYTES {
            if let Some(dropped) = self.lines.pop_front() {
                self.bytes -= dropped.len();
            } else {
                break;
            }
        }
    }
}

#[derive(Clone, Default)]
struct StderrTail {
    kept: Arc<Mutex<TailBuffer>>,
    reader: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl StderrTail {
    /// Read `stderr` to its end on a thread of its own, in bytes, with a bound per line.
    ///
    /// Not `BufReader::lines()`: that assembles a whole line before handing it over, so a
    /// line with no newline in sight costs as much memory as the bridge cares to write, and
    /// it stops at the first byte that is not UTF-8, keeping nothing said after it. Bytes
    /// past the per-line bound are counted and dropped, the line is marked as cut, and text
    /// is decoded leniently.
    fn follow(&self, stderr: impl Read + Send + 'static) {
        let kept = Arc::clone(&self.kept);
        let handle = thread::Builder::new()
            .name("gyredeck-bridge-stderr".to_string())
            .spawn(move || {
                let mut stderr = stderr;
                let mut chunk = [0_u8; 4096];
                let mut line: Vec<u8> = Vec::new();
                let mut dropped = 0_usize;
                let flush = |line: &mut Vec<u8>, dropped: &mut usize| {
                    if line.is_empty() && *dropped == 0 {
                        return;
                    }
                    let mut text = String::from_utf8_lossy(line).into_owned();
                    if *dropped > 0 {
                        text.push_str(&format!(" …[{} more bytes cut]", *dropped));
                    }
                    eprintln!("{text}");
                    if let Ok(mut kept) = kept.lock() {
                        kept.push(text);
                    }
                    line.clear();
                    *dropped = 0;
                };
                loop {
                    let read = match stderr.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(read) => read,
                        Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    };
                    for &byte in &chunk[..read] {
                        if byte == b'\n' {
                            flush(&mut line, &mut dropped);
                        } else if line.len() < BRIDGE_STDERR_LINE_MAX_BYTES {
                            line.push(byte);
                        } else {
                            dropped += 1;
                        }
                    }
                }
                flush(&mut line, &mut dropped);
            })
            .ok();
        if let Ok(mut reader) = self.reader.lock() {
            *reader = handle;
        }
    }

    /// Wait, briefly, for the reader to reach the end of the pipe: a process that wrote its
    /// last words and exited has them in flight for a moment after `try_wait` says so.
    fn drain(&self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            let finished = self
                .reader
                .lock()
                .map(|reader| reader.as_ref().map_or(true, JoinHandle::is_finished))
                .unwrap_or(true);
            if finished || Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn snapshot(&self) -> Vec<String> {
        self.kept
            .lock()
            .map(|kept| kept.lines.iter().cloned().collect())
            .unwrap_or_default()
    }
}

fn describe_exit(status: std::process::ExitStatus) -> serde_json::Value {
    let mut fields = serde_json::Map::new();
    if let Some(code) = status.code() {
        fields.insert("code".to_string(), serde_json::Value::from(code));
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            fields.insert("signal".to_string(), serde_json::Value::from(signal));
        }
    }
    fields.insert("status".to_string(), serde_json::Value::String(status.to_string()));
    serde_json::Value::Object(fields)
}

fn probe_name(probe: BridgeProbe) -> &'static str {
    match probe {
        BridgeProbe::Healthy => "healthy",
        BridgeProbe::Offline => "offline",
        BridgeProbe::Occupied => "occupied",
    }
}

fn bridge_config_path() -> Option<PathBuf> {
    super::home_dir().map(|home| {
        home.join(".config")
            .join("gyredeck")
            .join("gyredeck.config.json")
    })
}

/// The port the bridge should use, read from the shared
/// `~/.config/gyredeck/gyredeck.config.json` the Node bridge already honors.
/// Falls back to [`BRIDGE_PORT`] when unset or out of the allowed range.
pub(crate) fn configured_bridge_port() -> u16 {
    let Some(contents) = bridge_config_path().and_then(|path| fs::read_to_string(path).ok()) else {
        return BRIDGE_PORT;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return BRIDGE_PORT;
    };
    match value.get("port").and_then(serde_json::Value::as_u64) {
        Some(port) if port >= u64::from(BRIDGE_MIN_PORT) && port <= u64::from(u16::MAX) => {
            port as u16
        }
        _ => BRIDGE_PORT,
    }
}

/// Persist `port` into the shared bridge config, preserving any other keys.
/// Read a boolean preference from the Gyredeck config, defaulting when absent.
///
/// Absent has to mean the default rather than false: an install that predates a
/// setting has no opinion recorded, and reading that as "off" would silently opt
/// existing users out of something new that is meant to be on.
pub(crate) fn config_flag(key: &str, fallback: bool) -> bool {
    bridge_config_path()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok())
        .and_then(|value| value.get(key).and_then(serde_json::Value::as_bool))
        .unwrap_or(fallback)
}

pub(crate) fn write_config_flag(key: &str, value: bool) -> Result<(), String> {
    let path =
        bridge_config_path().ok_or_else(|| "Could not resolve Gyredeck config directory".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "Gyredeck config path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Gyredeck config directory: {error}"))?;
    let mut config = fs::read_to_string(&path)
        .ok()
        .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    config.insert(key.to_string(), serde_json::Value::from(value));
    let contents = serde_json::to_vec_pretty(&serde_json::Value::Object(config))
        .map_err(|error| format!("Could not serialise Gyredeck config: {error}"))?;
    fs::write(&path, contents)
        .map_err(|error| format!("Could not write Gyredeck config: {error}"))
}

pub(crate) fn write_configured_port(port: u16) -> Result<(), String> {
    if port < BRIDGE_MIN_PORT {
        return Err(format!(
            "Port must be between {BRIDGE_MIN_PORT} and {}",
            u16::MAX
        ));
    }
    let path =
        bridge_config_path().ok_or_else(|| "Could not resolve Gyredeck config directory".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "Gyredeck config path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Gyredeck config directory: {error}"))?;
    let mut config = fs::read_to_string(&path)
        .ok()
        .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    config.insert("port".to_string(), serde_json::Value::from(port));
    let contents = serde_json::to_vec_pretty(&serde_json::Value::Object(config))
        .map_err(|error| format!("Could not encode Gyredeck config: {error}"))?;
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, contents)
        .map_err(|error| format!("Could not write Gyredeck config: {error}"))?;
    fs::rename(&temporary_path, &path)
        .map_err(|error| format!("Could not save Gyredeck config: {error}"))?;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BridgeProbe {
    Healthy,
    Occupied,
    Offline,
}

/// What a probe saw, finer than the verdict: the verdict decides, the reason is written
/// down. A stalled bridge connects and then says nothing (`read_timeout`); a dead one
/// refuses the connection; an impostor answers the wrong thing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProbeOutcome {
    verdict: BridgeProbe,
    reason: &'static str,
}

#[derive(Clone, Copy, Debug)]
struct BridgeEndpoint {
    address: SocketAddr,
}

impl Default for BridgeEndpoint {
    fn default() -> Self {
        Self {
            address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), configured_bridge_port()),
        }
    }
}

struct BridgeSupervisorHandle {
    stop_tx: mpsc::Sender<()>,
    join: JoinHandle<()>,
}

#[derive(Default)]
pub(crate) struct StandaloneBridgeState {
    supervisor: Mutex<Option<BridgeSupervisorHandle>>,
    script: Mutex<Option<PathBuf>>,
}

impl StandaloneBridgeState {
    pub(crate) fn start(&self, bridge_script: PathBuf) -> Result<(), String> {
        let node = find_node_binary().ok_or_else(|| {
            "Gyredeck could not find Node.js for the standalone bridge".to_string()
        })?;
        if let Ok(mut script) = self.script.lock() {
            *script = Some(bridge_script.clone());
        }
        self.start_with(
            bridge_script,
            node,
            BridgeEndpoint::default(),
            SupervisorLog::at(supervisor_log_path()),
        )
    }

    /// Stop the current supervisor and start a fresh one, re-reading the
    /// configured port. Used after the user changes the bridge port.
    pub(crate) fn restart(&self) -> Result<(), String> {
        let script = self
            .script
            .lock()
            .ok()
            .and_then(|script| script.clone())
            .ok_or_else(|| "Standalone bridge has not been started yet".to_string())?;
        self.stop();
        self.start(script)
    }

    fn start_with(
        &self,
        bridge_script: PathBuf,
        node: PathBuf,
        endpoint: BridgeEndpoint,
        log: SupervisorLog,
    ) -> Result<(), String> {
        if !bridge_script.is_file() {
            return Err(format!(
                "Standalone bridge resource is missing: {}",
                bridge_script.display()
            ));
        }

        let mut supervisor = self
            .supervisor
            .lock()
            .map_err(|_| "Standalone bridge supervisor state is unavailable".to_string())?;
        if supervisor.is_some() {
            return Ok(());
        }

        let (stop_tx, stop_rx) = mpsc::channel();
        let join = thread::Builder::new()
            .name("gyredeck-bridge-supervisor".to_string())
            .spawn(move || supervise_bridge(bridge_script, node, endpoint, stop_rx, log))
            .map_err(|error| format!("Failed to start standalone bridge supervisor: {error}"))?;
        *supervisor = Some(BridgeSupervisorHandle { stop_tx, join });
        Ok(())
    }

    pub(crate) fn stop(&self) {
        let handle = self
            .supervisor
            .lock()
            .ok()
            .and_then(|mut supervisor| supervisor.take());
        if let Some(handle) = handle {
            let _ = handle.stop_tx.send(());
            let _ = handle.join.join();
        }
    }
}

pub(crate) fn bridge_health() -> bool {
    probe_bridge(BridgeEndpoint::default()) == BridgeProbe::Healthy
}

/// Whether `port` is usable for the bridge: either free (nothing listening) or
/// already answered by a Gyredeck bridge. An unrelated listener is rejected so
/// the user gets a clear error instead of a silently failed reconnect.
pub(crate) fn port_available_for_bridge(port: u16) -> bool {
    let endpoint = BridgeEndpoint {
        address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
    };
    !matches!(probe_bridge(endpoint), BridgeProbe::Occupied)
}

/// A bridge the supervisor started, with what it needs to say about it later.
struct OwnedBridge {
    child: Child,
    pid: u32,
    started: Instant,
    stderr: StderrTail,
    /// The failed probes since the last healthy one, oldest first: what a kill is made of.
    failures: Vec<serde_json::Value>,
}

impl OwnedBridge {
    fn fields(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut fields = serde_json::Map::new();
        fields.insert("pid".to_string(), serde_json::Value::from(self.pid));
        fields.insert(
            "uptimeMs".to_string(),
            serde_json::Value::from(self.started.elapsed().as_millis() as u64),
        );
        fields.insert(
            "stderr".to_string(),
            serde_json::Value::Array(
                self.stderr
                    .snapshot()
                    .into_iter()
                    .map(serde_json::Value::String)
                    .collect(),
            ),
        );
        fields
    }
}

fn supervise_bridge(
    bridge_script: PathBuf,
    node: PathBuf,
    endpoint: BridgeEndpoint,
    stop_rx: mpsc::Receiver<()>,
    log: SupervisorLog,
) {
    let mut owned: Option<OwnedBridge> = None;

    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        if let Some(bridge) = owned.as_mut() {
            match bridge.child.try_wait() {
                Ok(Some(status)) => {
                    eprintln!("Gyredeck standalone bridge exited: {status}");
                    // Its last words may still be in the pipe. And this is an exit the
                    // supervisor did not ask for — one it asked for is written down as
                    // `killed` or `stopped` and never seen here, so the field says so.
                    bridge.stderr.drain(BRIDGE_STDERR_DRAIN_TIMEOUT);
                    let mut fields = bridge.fields();
                    fields.insert("exit".to_string(), describe_exit(status));
                    fields.insert("byGyredeck".to_string(), serde_json::Value::Bool(false));
                    log.record("exited", fields);
                    owned = None;
                }
                Err(error) => {
                    eprintln!("Gyredeck could not inspect its standalone bridge: {error}");
                    let mut fields = bridge.fields();
                    fields.insert(
                        "error".to_string(),
                        serde_json::Value::String(error.to_string()),
                    );
                    log.record("lost", fields);
                    owned = None;
                }
                Ok(None) => {}
            }
        }

        let probed_at = Instant::now();
        let outcome = probe_bridge_detailed(endpoint);
        let probe = outcome.verdict;
        let probe_took = probed_at.elapsed();
        if let Some(bridge) = owned.as_mut() {
            if probe == BridgeProbe::Healthy {
                if !bridge.failures.is_empty() {
                    let mut fields = bridge.fields();
                    fields.insert(
                        "failures".to_string(),
                        serde_json::Value::Array(std::mem::take(&mut bridge.failures)),
                    );
                    log.record("recovered", fields);
                }
            } else {
                let mut failure = serde_json::Map::new();
                failure.insert(
                    "probe".to_string(),
                    serde_json::Value::String(probe_name(probe).to_string()),
                );
                failure.insert(
                    "reason".to_string(),
                    serde_json::Value::String(outcome.reason.to_string()),
                );
                failure.insert(
                    "tookMs".to_string(),
                    serde_json::Value::from(probe_took.as_millis() as u64),
                );
                failure.insert(
                    "afterMs".to_string(),
                    serde_json::Value::from(bridge.started.elapsed().as_millis() as u64),
                );
                bridge.failures.push(serde_json::Value::Object(failure));
                if bridge.failures.len() >= usize::from(OWNED_BRIDGE_FAILURE_LIMIT) {
                    // Written before the kill, so the stderr tail is what the bridge said
                    // up to the moment it was judged, not what it said while dying.
                    let mut fields = bridge.fields();
                    fields.insert(
                        "failures".to_string(),
                        serde_json::Value::Array(std::mem::take(&mut bridge.failures)),
                    );
                    log.record("killed", fields);
                    eprintln!(
                        "Gyredeck is restarting its standalone bridge: {OWNED_BRIDGE_FAILURE_LIMIT} health probes in a row failed"
                    );
                    stop_owned_child(&mut owned);
                }
            }
        } else if probe == BridgeProbe::Offline {
            owned = match spawn_bridge(&node, &bridge_script, endpoint) {
                Ok(bridge) => {
                    let mut fields = serde_json::Map::new();
                    fields.insert("pid".to_string(), serde_json::Value::from(bridge.pid));
                    fields.insert(
                        "port".to_string(),
                        serde_json::Value::from(endpoint.address.port()),
                    );
                    log.record("started", fields);
                    Some(bridge)
                }
                Err(error) => {
                    eprintln!("Gyredeck could not start its standalone bridge: {error}");
                    let mut fields = serde_json::Map::new();
                    fields.insert(
                        "error".to_string(),
                        serde_json::Value::String(error.to_string()),
                    );
                    log.record("spawn_failed", fields);
                    None
                }
            };
        }

        match stop_rx.recv_timeout(BRIDGE_SUPERVISOR_INTERVAL) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }

    if let Some(bridge) = owned.as_ref() {
        log.record("stopped", bridge.fields());
    }
    stop_owned_child(&mut owned);
}

fn spawn_bridge(
    node: &Path,
    bridge_script: &Path,
    endpoint: BridgeEndpoint,
) -> std::io::Result<OwnedBridge> {
    let mut child = Command::new(node)
        .arg(bridge_script)
        .arg("--port")
        .arg(endpoint.address.port().to_string())
        .arg("--host")
        .arg(BRIDGE_HOST)
        .arg("--parent-stdio")
        .env("PATH", super::enriched_cli_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let stderr = StderrTail::default();
    if let Some(pipe) = child.stderr.take() {
        stderr.follow(pipe);
    }
    Ok(OwnedBridge {
        pid: child.id(),
        child,
        started: Instant::now(),
        stderr,
        failures: Vec::new(),
    })
}

fn stop_owned_child(owned: &mut Option<OwnedBridge>) {
    if let Some(bridge) = owned.take() {
        let mut child = bridge.child;
        drop(child.stdin.take());
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn probe_bridge(endpoint: BridgeEndpoint) -> BridgeProbe {
    probe_bridge_detailed(endpoint).verdict
}

fn probe_bridge_detailed(endpoint: BridgeEndpoint) -> ProbeOutcome {
    let outcome = |verdict, reason| ProbeOutcome { verdict, reason };
    let mut stream = match TcpStream::connect_timeout(&endpoint.address, BRIDGE_PROBE_TIMEOUT) {
        Ok(stream) => stream,
        Err(error) => {
            let reason = match error.kind() {
                ErrorKind::ConnectionRefused => "connect_refused",
                ErrorKind::TimedOut | ErrorKind::WouldBlock => "connect_timeout",
                _ => "connect_failed",
            };
            return outcome(classify_connect_error(&error), reason);
        }
    };
    let _ = stream.set_read_timeout(Some(BRIDGE_PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(BRIDGE_PROBE_TIMEOUT));
    let request = format!(
        "GET /health HTTP/1.1\r\nHost: {BRIDGE_HOST}:{}\r\nConnection: close\r\n\r\n",
        endpoint.address.port()
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return outcome(BridgeProbe::Occupied, "write_failed");
    }

    let mut response = String::new();
    let read = stream.take(64 * 1024).read_to_string(&mut response);
    if is_gyredeck_health_response(&response) {
        return outcome(BridgeProbe::Healthy, "healthy");
    }
    let reason = match read {
        Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {
            if response.is_empty() { "read_timeout" } else { "read_timeout_mid_response" }
        }
        Err(_) => "read_failed",
        Ok(_) if response.is_empty() => "closed_without_answer",
        Ok(_) => "unexpected_response",
    };
    outcome(BridgeProbe::Occupied, reason)
}

/// One mail room as the bridge reports it.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct MailRoom {
    pub room: String,
    pub seq: u32,
    /// Provider names of the sessions put into this room, empty for a plain mailbox.
    pub members: Vec<String>,
    /// The session that created the room, and the only one that may close it.
    pub founder: Option<String>,
    pub pending: u32,
    pub subscribers: u32,
    #[serde(rename = "lastMessageAt")]
    pub last_message_at: Option<String>,
    #[serde(rename = "lastReadAt")]
    pub last_read_at: Option<String>,
}

/// Read the machine-local ingest token. Mail requires it, and it never leaves the
/// native side — the webview asks this process for room state instead of holding a
/// credential it has no other use for.
fn read_ingest_token() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let token = fs::read_to_string(
        PathBuf::from(home)
            .join(".config")
            .join("gyredeck")
            .join("gyredeck.ingest-token"),
    )
    .ok()?;
    let token = token.trim().to_string();
    (token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit())).then_some(token)
}

/// One request to the bridge's mail endpoints.
///
/// Raw HTTP rather than a client crate: this is a single loopback call and the bridge
/// answers with Content-Length rather than chunked. The token is attached here and
/// never handed to the webview, which has no other use for it.
/// A bridge call whose status code reaches the caller.
///
/// Sync rooms answer with statuses that are not failures to be hidden: an unknown code
/// is a 404 the join field has to render as "no room with that code", and a session
/// already in a room is a 409. Collapsing those into one error string would leave the
/// panel unable to say which happened.
fn bridge_request(
    method: &str,
    path: &str,
    body: Option<String>,
) -> Result<(u16, serde_json::Value), String> {
    bridge_request_within(method, path, body, MAIL_REQUEST_TIMEOUT)
}

/// The same request, for the one caller whose answer takes longer than a mailbox read.
///
/// Connecting is still held to the short limit — an unreachable bridge is unreachable at
/// once — and only the wait for the reply is stretched.
fn bridge_request_within(
    method: &str,
    path: &str,
    body: Option<String>,
    reply_timeout: Duration,
) -> Result<(u16, serde_json::Value), String> {
    let Some(token) = read_ingest_token() else {
        return Err("Ingest token is not available yet".to_string());
    };
    let port = configured_bridge_port();
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);

    let mut stream = TcpStream::connect_timeout(&address, MAIL_REQUEST_TIMEOUT)
        .map_err(|error| format!("Bridge is not reachable: {error}"))?;
    let _ = stream.set_read_timeout(Some(reply_timeout));
    let _ = stream.set_write_timeout(Some(MAIL_REQUEST_TIMEOUT));

    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {BRIDGE_HOST}:{port}\r\nAccept: application/json\r\nX-Gyredeck-Token: {token}\r\nConnection: close\r\n"
    );
    match &body {
        Some(payload) => request.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{payload}",
            payload.len()
        )),
        None => request.push_str("\r\n"),
    }
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Failed to reach the bridge: {error}"))?;

    let mut response = String::new();
    let _ = stream.take(512 * 1024).read_to_string(&mut response);

    let Some((head, payload)) = response.split_once("\r\n\r\n") else {
        return Err("Bridge returned no response body".to_string());
    };
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "Bridge returned no status line".to_string())?;
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        dechunk(payload).ok_or_else(|| "Bridge sent a malformed chunked body".to_string())?
    } else {
        payload.to_string()
    };

    // A body that will not parse must not become an empty answer. Defaulting to null
    // here made "the bridge said you are in no room" and "I could not read the reply"
    // indistinguishable, and the panel believed the first for an hour.
    let value = serde_json::from_str(&body).map_err(|error| {
        format!("Bridge sent an unparsable body ({error}): {}", body.chars().take(200).collect::<String>())
    })?;
    Ok((status, value))
}

/// Join the pieces of a chunked body.
///
/// Node does not send Content-Length unless the handler sets one, so the bridge
/// answers chunked and the body arrives as `2f\r\n{...}\r\n0\r\n\r\n`. Reading it
/// raw yields a hex length where JSON was expected, and every reply looked empty.
fn dechunk(payload: &str) -> Option<String> {
    let mut rest = payload;
    let mut body = String::new();
    loop {
        let (header, tail) = rest.split_once("\r\n")?;
        // A chunk header may carry extensions after a semicolon; the size is the part
        // before it.
        let size = usize::from_str_radix(header.split(';').next()?.trim(), 16).ok()?;
        if size == 0 {
            return Some(body);
        }
        if tail.len() < size {
            return None;
        }
        body.push_str(&tail[..size]);
        rest = tail.get(size + 2..)?;
    }
}

/// A bridge call where anything but success is a failure, which is every mail read.
fn mail_request(method: &str, path: &str, body: Option<String>) -> Result<serde_json::Value, String> {
    let (status, value) = bridge_request(method, path, body)?;
    if !(200..300).contains(&status) {
        // A bridge predating mail rooms answers 404 here; an unauthorized read is 401.
        return Err(format!("Bridge declined the mail request: HTTP {status}"));
    }
    Ok(value)
}

/// One member of a sync room.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct SyncMember {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    /// "Claude Code", "Codex", "Antigravity" — a conversation id reads as nothing, so
    /// the bridge labels each member from the runtime kind on its events.
    pub provider: String,
    /// Whether this member may speak in the room, not merely read it.
    pub confirmed: bool,
    pub pending: u32,
    pub you: bool,
}

/// The room a session is in, or the absence of one.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct SyncRoom {
    pub room: Option<String>,
    pub founder: Option<String>,
    pub members: Vec<SyncMember>,
}

fn parse_sync_room(value: &serde_json::Value, as_id: &str) -> SyncRoom {
    let members = value
        .get("members")
        .and_then(|value| value.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|member| {
                    let conversation_id = member.get("conversationId")?.as_str()?.to_string();
                    Some(SyncMember {
                        you: conversation_id == as_id,
                        conversation_id,
                        confirmed: member
                            .get("confirmed")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        provider: member
                            .get("provider")
                            .and_then(|value| value.as_str())
                            .unwrap_or("Agent")
                            .to_string(),
                        pending: member.get("pending").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    SyncRoom {
        room: value.get("room").and_then(|value| value.as_str()).map(ToOwned::to_owned),
        founder: value
            .get("founder")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned),
        members,
    }
}

/// Turn a refusal into something the panel can put next to the field that caused it.
fn sync_error(status: u16, value: &serde_json::Value) -> String {
    let code = value.get("error").and_then(|value| value.as_str()).unwrap_or("");
    match (status, code) {
        (404, _) => "No room with that code".to_string(),
        (409, _) => "This session is already in another room".to_string(),
        (429, "room_full") => "That room is full".to_string(),
        (429, _) => "Too many rooms are open".to_string(),
        (401, _) => "Gyredeck could not authenticate to its own bridge".to_string(),
        (400, _) => "That code is not a valid room name".to_string(),
        _ => format!("The bridge refused the request (HTTP {status})"),
    }
}

/// Which room a session is in. Absence is an answer, not a failure.
pub(crate) fn sync_room(conversation_id: &str) -> Result<SyncRoom, String> {
    if !valid_room(conversation_id) {
        return Err("Not a valid session id".to_string());
    }
    let (status, value) = bridge_request("GET", &format!("/sync/rooms?as={conversation_id}"), None)?;
    if !(200..300).contains(&status) {
        return Err(sync_error(status, &value));
    }
    Ok(parse_sync_room(&value, conversation_id))
}

/// Create a room and put this session in it. Creating without joining would leave a
/// code nobody is in, which is never what the button means.
pub(crate) fn sync_create(conversation_id: &str) -> Result<SyncRoom, String> {
    if !valid_room(conversation_id) {
        return Err("Not a valid session id".to_string());
    }
    let body = serde_json::json!({ "conversationId": conversation_id }).to_string();
    let (status, value) = bridge_request("POST", "/sync/rooms", Some(body))?;
    if !(200..300).contains(&status) {
        return Err(sync_error(status, &value));
    }
    Ok(parse_sync_room(&value, conversation_id))
}

/// Read the room's password, so the founder can copy it out.
///
/// Only the founder may: handing out a room's credential is the act of whoever set it up,
/// not something a member can pass along. Reading it out grants nothing by itself — the
/// session that holds it earns the right to speak by presenting it, and until then it is
/// in the room and silent. Password and token are one thing said two ways — a password to
/// the person copying it, a token to the header that carries it on every read and send.
pub(crate) fn sync_issue_password(code: &str, conversation_id: &str) -> Result<String, String> {
    if !valid_room(code) || !valid_room(conversation_id) {
        return Err("Not a valid room".to_string());
    }
    let body = serde_json::json!({ "conversationId": conversation_id }).to_string();
    let (status, value) = bridge_request("POST", &format!("/sync/rooms/{code}/passwords"), Some(body))?;
    if !(200..300).contains(&status) {
        return Err(match value.get("error").and_then(serde_json::Value::as_str) {
            Some("not_the_founder") => "Only the session that created this room can invite".to_string(),
            _ => sync_error(status, &value),
        });
    }
    value
        .get("password")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Bridge returned no password".to_string())
}

/// Close a room for everyone in it.
///
/// Different from leaving: every member is told, every stream is cut, and the room is
/// gone. Only the founder may, for the same reason only the founder hands out the
/// password — ending a room other people are working in is not a thing any member
/// should be able to do to the others.
pub(crate) fn sync_close(code: &str, conversation_id: &str) -> Result<(), String> {
    if !valid_room(code) || !valid_room(conversation_id) {
        return Err("Not a valid room".to_string());
    }
    let (status, value) = bridge_request(
        "DELETE",
        &format!("/sync/rooms/{code}?as={conversation_id}"),
        None,
    )?;
    if !(200..300).contains(&status) {
        return Err(match value.get("error").and_then(serde_json::Value::as_str) {
            Some("not_the_founder") => "Only the session that created this room can close it".to_string(),
            Some("no_such_room") => "That room is already closed".to_string(),
            _ => sync_error(status, &value),
        });
    }
    Ok(())
}

/// Join a room by code. Idempotent, so pressing Connect twice is not an error.
pub(crate) fn sync_join(code: &str, conversation_id: &str) -> Result<SyncRoom, String> {
    if !valid_room(conversation_id) {
        return Err("Not a valid session id".to_string());
    }
    if !valid_room(code) {
        return Err("No room with that code".to_string());
    }
    let body = serde_json::json!({ "conversationId": conversation_id }).to_string();
    let (status, value) = bridge_request("POST", &format!("/sync/rooms/{code}/members"), Some(body))?;
    if !(200..300).contains(&status) {
        return Err(sync_error(status, &value));
    }
    Ok(parse_sync_room(&value, conversation_id))
}

pub(crate) fn sync_leave(code: &str, conversation_id: &str) -> Result<(), String> {
    if !valid_room(code) || !valid_room(conversation_id) {
        return Err("Not a valid room".to_string());
    }
    let (status, value) =
        bridge_request("DELETE", &format!("/sync/rooms/{code}/members/{conversation_id}"), None)?;
    // Already gone is the state the caller wanted.
    if status == 404 || (200..300).contains(&status) {
        return Ok(());
    }
    Err(sync_error(status, &value))
}

/// Room names must survive being put in a URL, and they come from session ids.
fn valid_room(room: &str) -> bool {
    !room.is_empty()
        && room.len() <= 64
        && room
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Ask the bridge which mail rooms exist and how much is waiting in each.
pub(crate) fn mail_rooms() -> Result<Vec<MailRoom>, String> {
    let parsed = mail_request("GET", "/mail", None)?;
    let Some(rooms) = parsed.get("rooms").and_then(|value| value.as_array()) else {
        return Ok(Vec::new());
    };

    Ok(rooms
        .iter()
        .filter_map(|room| {
            let name = room.get("room")?.as_str()?.to_string();
            let number = |key: &str| room.get(key).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let text = |key: &str| {
                room.get(key)
                    .and_then(|v| v.as_str())
                    .map(|value| value.to_string())
            };
            Some(MailRoom {
                founder: room
                    .get("founder")
                    .and_then(|value| value.as_str())
                    .map(ToOwned::to_owned),
                members: room
                    .get("members")
                    .and_then(serde_json::Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(|value| value.as_str().map(ToOwned::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
                room: name,
                seq: number("seq"),
                pending: number("pending"),
                subscribers: number("subscribers"),
                last_message_at: text("lastMessageAt"),
                last_read_at: text("lastReadAt"),
            })
        })
        .collect())
}

fn classify_connect_error(error: &std::io::Error) -> BridgeProbe {
    if error.kind() == ErrorKind::ConnectionRefused {
        BridgeProbe::Offline
    } else {
        BridgeProbe::Occupied
    }
}

fn is_gyredeck_health_response(response: &str) -> bool {
    let mut sections = response.splitn(2, "\r\n\r\n");
    let Some(headers) = sections.next() else {
        return false;
    };
    let Some(body) = sections.next() else {
        return false;
    };
    if !headers
        .lines()
        .next()
        .is_some_and(|line| line.starts_with("HTTP/1.1 200 ") || line.starts_with("HTTP/1.0 200 "))
    {
        return false;
    }
    let Some(json_start) = body.find('{') else {
        return false;
    };
    let Some(json_end) = body.rfind('}') else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&body[json_start..=json_end])
        .ok()
        .is_some_and(|payload| {
            payload.get("ok").and_then(|value| value.as_bool()) == Some(true)
                && payload.get("name").and_then(|value| value.as_str()) == Some("gyredeck")
                && payload.get("version").and_then(|value| value.as_u64()) == Some(2)
        })
}

pub(crate) fn find_node_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("GYREDECK_NODE_BINARY") {
        let path = PathBuf::from(path);
        if path.is_absolute() && path.is_file() {
            return Some(path);
        }
    }

    for directory in super::enriched_cli_path().split(':') {
        let candidate = Path::new(directory).join("node");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let versions = super::home_dir()?.join(".nvm/versions/node");
    let mut candidates = fs::read_dir(versions)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("bin/node"))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.pop()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        net::TcpListener,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn wait_for_probe(endpoint: BridgeEndpoint, expected: BridgeProbe) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if probe_bridge(endpoint) == expected {
                return true;
            }
            thread::sleep(Duration::from_millis(40));
        }
        false
    }

    fn serve_health_fixture(
        listener: TcpListener,
        body: &'static str,
    ) -> (mpsc::Sender<()>, JoinHandle<()>) {
        listener
            .set_nonblocking(true)
            .expect("nonblocking fixture listener");
        let (stop_tx, stop_rx) = mpsc::channel();
        let join = thread::spawn(move || loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        });
        (stop_tx, join)
    }

    #[test]
    fn health_parser_accepts_letta_and_standalone_bridge_payloads() {
        for body in [
            r#"{"ok":true,"name":"gyredeck","version":2,"clients":1}"#,
            r#"{"ok":true,"name":"gyredeck","version":2,"mode":"standalone","clients":0}"#,
        ] {
            assert!(is_gyredeck_health_response(&format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{body}"
            )));
        }
    }

    #[test]
    fn health_parser_rejects_an_unrelated_listener() {
        assert!(!is_gyredeck_health_response(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"name\":\"other\",\"version\":2}"
        ));
        assert!(!is_gyredeck_health_response(
            "HTTP/1.1 503 Service Unavailable\r\n\r\n{\"ok\":true,\"name\":\"gyredeck\",\"version\":2}"
        ));
    }

    #[test]
    fn uncertain_connection_failures_are_fail_closed() {
        assert_eq!(
            classify_connect_error(&std::io::Error::new(ErrorKind::ConnectionRefused, "closed")),
            BridgeProbe::Offline
        );
        assert_eq!(
            classify_connect_error(&std::io::Error::new(ErrorKind::TimedOut, "uncertain")),
            BridgeProbe::Occupied
        );
        assert_eq!(
            classify_connect_error(&std::io::Error::new(
                ErrorKind::PermissionDenied,
                "uncertain"
            )),
            BridgeProbe::Occupied
        );
    }

    #[test]
    fn supervisor_starts_and_stops_an_owned_bridge() {
        let Some(node) = find_node_binary() else {
            return;
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("reserve test port");
        let port = listener.local_addr().expect("test address").port();
        drop(listener);
        let endpoint = BridgeEndpoint {
            address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        };
        assert_eq!(probe_bridge(endpoint), BridgeProbe::Offline, "port {port}");
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("gyredeck-bridge-{unique}"));
        fs::create_dir_all(&directory).expect("fixture directory");
        let script = directory.join("bridge.mjs");
        fs::write(
            &script,
            r#"import { createServer } from 'node:http'
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, name: 'gyredeck', version: 2, mode: 'standalone' }))
    return
  }
  response.writeHead(404)
  response.end()
})
server.listen(port, '127.0.0.1')
process.stdin.resume()
process.stdin.on('end', () => server.close(() => process.exit(0)))
"#,
        )
        .expect("fixture script");

        let state = StandaloneBridgeState::default();
        state
            .start_with(script, node, endpoint, SupervisorLog::none())
            .expect("start supervisor");
        assert!(wait_for_probe(endpoint, BridgeProbe::Healthy));
        state.stop();
        assert!(wait_for_probe(endpoint, BridgeProbe::Offline));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn supervisor_never_replaces_an_existing_or_unrelated_listener() {
        let Some(node) = find_node_binary() else {
            return;
        };
        for (label, body, expected_probe) in [
            (
                "healthy",
                r#"{"ok":true,"name":"gyredeck","version":2}"#,
                BridgeProbe::Healthy,
            ),
            (
                "occupied",
                r#"{"ok":true,"name":"other","version":2}"#,
                BridgeProbe::Occupied,
            ),
        ] {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("fixture listener");
            let port = listener.local_addr().expect("fixture address").port();
            let endpoint = BridgeEndpoint {
                address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            };
            let (server_stop, server_join) = serve_health_fixture(listener, body);
            assert!(wait_for_probe(endpoint, expected_probe));

            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let directory =
                std::env::temp_dir().join(format!("gyredeck-bridge-{label}-{unique}"));
            fs::create_dir_all(&directory).expect("fixture directory");
            let marker = directory.join("unexpected-spawn");
            let script = directory.join("bridge.mjs");
            let marker_json = serde_json::to_string(&marker.to_string_lossy()).expect("marker");
            fs::write(
                &script,
                format!(
                    "import {{ writeFileSync }} from 'node:fs'\nwriteFileSync({marker_json}, 'spawned')\nsetInterval(() => {{}}, 1000)\n"
                ),
            )
            .expect("marker script");

            let state = StandaloneBridgeState::default();
            state
                .start_with(script, node.clone(), endpoint, SupervisorLog::none())
                .expect("start supervisor");
            thread::sleep(Duration::from_millis(1_250));
            assert!(!marker.exists(), "{label} listener was replaced");
            state.stop();
            let _ = server_stop.send(());
            let _ = server_join.join();
            let _ = fs::remove_dir_all(directory);
        }
    }

    #[test]
    fn supervisor_takes_over_after_an_external_owner_stops() {
        let Some(node) = find_node_binary() else {
            return;
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("fixture listener");
        let port = listener.local_addr().expect("fixture address").port();
        let endpoint = BridgeEndpoint {
            address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        };
        let (server_stop, server_join) =
            serve_health_fixture(listener, r#"{"ok":true,"name":"gyredeck","version":2}"#);
        assert!(wait_for_probe(endpoint, BridgeProbe::Healthy));

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("gyredeck-bridge-takeover-{unique}"));
        fs::create_dir_all(&directory).expect("fixture directory");
        let marker = directory.join("owned-started");
        let marker_json = serde_json::to_string(&marker.to_string_lossy()).expect("marker");
        let script = directory.join("bridge.mjs");
        fs::write(
            &script,
            format!(
                r#"import {{ writeFileSync }} from 'node:fs'
import {{ createServer }} from 'node:http'
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
writeFileSync({marker_json}, 'started')
const server = createServer((request, response) => {{
  if (request.url === '/health') {{
    response.writeHead(200, {{ 'content-type': 'application/json' }})
    response.end(JSON.stringify({{ ok: true, name: 'gyredeck', version: 2 }}))
    return
  }}
  response.writeHead(404)
  response.end()
}})
server.listen(port, '127.0.0.1')
process.stdin.resume()
process.stdin.on('end', () => server.close(() => process.exit(0)))
"#
            ),
        )
        .expect("takeover script");

        let state = StandaloneBridgeState::default();
        state
            .start_with(script, node, endpoint, SupervisorLog::none())
            .expect("start supervisor");
        thread::sleep(Duration::from_millis(1_250));
        assert!(
            !marker.exists(),
            "external owner was replaced while healthy"
        );

        let _ = server_stop.send(());
        let _ = server_join.join();
        assert!(wait_for_probe(endpoint, BridgeProbe::Healthy));
        assert!(marker.exists(), "standalone fallback never took ownership");
        state.stop();
        assert!(wait_for_probe(endpoint, BridgeProbe::Offline));
        let _ = fs::remove_dir_all(directory);
    }

    fn fixture_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("gyredeck-{name}-{unique}"));
        fs::create_dir_all(&directory).expect("fixture directory");
        directory
    }

    fn log_lines(path: &Path) -> Vec<serde_json::Value> {
        fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("a JSON line"))
            .collect()
    }

    #[test]
    fn supervisor_log_lines_are_json_private_and_rotated() {
        let directory = fixture_dir("supervisor-log");
        let path = directory.join("nested").join("supervisor.log");
        let log = SupervisorLog::at(Some(path.clone()));
        let mut fields = serde_json::Map::new();
        fields.insert("pid".to_string(), serde_json::Value::from(42));
        log.record("started", fields);

        let lines = log_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["event"], "started");
        assert_eq!(lines[0]["pid"], 42);
        assert!(lines[0]["at"].as_str().expect("a timestamp").ends_with('Z'));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).expect("log").permissions().mode() & 0o777, 0o600);
        }

        // Past the cap the file is moved aside, once, and a fresh one begins. Filled with
        // records each under the record cap, since one over it is replaced by a short line.
        let padding = "x".repeat(SUPERVISOR_RECORD_MAX_BYTES - 200);
        while fs::metadata(&path).expect("log").len() < SUPERVISOR_LOG_MAX_BYTES {
            let mut fields = serde_json::Map::new();
            fields.insert("padding".to_string(), serde_json::Value::String(padding.clone()));
            log.record("padded", fields);
        }
        log.record("after", serde_json::Map::new());
        let rotated = path.with_extension("log.1");
        assert!(rotated.is_file(), "the full log was moved aside");
        let lines = log_lines(&path);
        assert_eq!(lines.len(), 1, "the live log restarted with the line written after rotation");
        assert_eq!(lines[0]["event"], "after");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn a_log_with_no_path_writes_nothing_and_does_not_fail() {
        SupervisorLog::none().record("started", serde_json::Map::new());
    }

    #[test]
    fn stderr_tail_keeps_only_the_last_lines() {
        let tail = StderrTail::default();
        let text: String = (0..(BRIDGE_STDERR_TAIL_LINES + 5))
            .map(|index| format!("line {index}\n"))
            .collect();
        tail.follow(std::io::Cursor::new(text.into_bytes()));
        let deadline = Instant::now() + Duration::from_secs(5);
        while tail.snapshot().len() < BRIDGE_STDERR_TAIL_LINES && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let kept = tail.snapshot();
        assert_eq!(kept.len(), BRIDGE_STDERR_TAIL_LINES);
        assert_eq!(kept.first().map(String::as_str), Some("line 5"));
        assert_eq!(
            kept.last().map(String::as_str),
            Some(format!("line {}", BRIDGE_STDERR_TAIL_LINES + 4).as_str())
        );
    }

    #[test]
    fn a_kill_is_written_down_with_the_probes_that_led_to_it_and_the_last_stderr() {
        let Some(node) = find_node_binary() else {
            return;
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("reserve test port");
        let port = listener.local_addr().expect("test address").port();
        drop(listener);
        let endpoint = BridgeEndpoint {
            address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        };
        assert_eq!(probe_bridge(endpoint), BridgeProbe::Offline, "port {port}");
        let directory = fixture_dir("bridge-kill");
        let script = directory.join("bridge.mjs");
        // Answers two health probes, says what it is about to do on stderr, then holds the
        // event loop for good — the shape of the 2026-10-07 kills, where a synchronous read
        // of a 50 MB log kept the bridge from answering.
        fs::write(
            &script,
            r#"import { createServer } from 'node:http'
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
let answered = 0
const server = createServer((request, response) => {
  if (request.url === '/health') {
    answered += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, name: 'gyredeck', version: 2, mode: 'standalone' }))
    if (answered === 2) {
      console.error('bridge fixture: about to stall the event loop')
      setTimeout(() => { for (;;) {} }, 50)
    }
    return
  }
  response.writeHead(404)
  response.end()
})
server.listen(port, '127.0.0.1')
process.stdin.resume()
process.stdin.on('end', () => server.close(() => process.exit(0)))
"#,
        )
        .expect("fixture script");
        let log_path = directory.join("supervisor.log");

        let state = StandaloneBridgeState::default();
        state
            .start_with(script, node, endpoint, SupervisorLog::at(Some(log_path.clone())))
            .expect("start supervisor");
        // The first bridge is killed after three failed probes, and a second one started in
        // its place: the stall is in the fixture, so the second stalls too — one kill is
        // enough to prove the record, and the second start proves the supervisor went on.
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            let lines = log_lines(&log_path);
            let starts = lines.iter().filter(|line| line["event"] == "started").count();
            if lines.iter().any(|line| line["event"] == "killed") && starts >= 2 {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        state.stop();

        let lines = log_lines(&log_path);
        let killed = lines
            .iter()
            .find(|line| line["event"] == "killed")
            .unwrap_or_else(|| panic!("a kill was written down: {lines:?}"));
        let failures = killed["failures"].as_array().expect("the probes that led to it");
        assert_eq!(failures.len(), usize::from(OWNED_BRIDGE_FAILURE_LIMIT));
        for failure in failures {
            assert_eq!(failure["probe"], "occupied", "a stalled bridge connects but does not answer");
            assert_eq!(failure["reason"], "read_timeout", "and the reason says which half it failed at");
            assert!(failure["tookMs"].as_u64().is_some());
            assert!(failure["afterMs"].as_u64().is_some());
        }
        assert!(killed["pid"].as_u64().is_some());
        assert!(killed["uptimeMs"].as_u64().is_some());
        let stderr = killed["stderr"].as_array().expect("the bridge's last stderr");
        assert!(
            stderr.iter().any(|line| line.as_str() == Some("bridge fixture: about to stall the event loop")),
            "what the bridge said before it was judged is beside the kill: {stderr:?}"
        );
        let first_start = lines.iter().position(|line| line["event"] == "started").expect("a start");
        let kill_at = lines.iter().position(|line| line["event"] == "killed").expect("the kill");
        assert!(first_start < kill_at, "started before killed");
        assert!(
            lines.iter().skip(kill_at).any(|line| line["event"] == "started"),
            "a bridge was started again after the kill"
        );
        assert!(
            lines.iter().any(|line| line["event"] == "stopped" || line["event"] == "exited"),
            "the end of the supervisor is written down too: {lines:?}"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn stderr_tail_is_bounded_in_bytes_and_survives_bytes_that_are_not_text() {
        // One 4 MiB line, then bytes that are not UTF-8, then a last word. `lines()` kept the
        // whole 4 MiB and stopped at the bad bytes; Codex measured both.
        let tail = StderrTail::default();
        let mut text: Vec<u8> = Vec::new();
        text.extend(std::iter::repeat(b'x').take(4 * 1024 * 1024));
        text.push(b'\n');
        text.extend_from_slice(b"good\n");
        text.extend_from_slice(&[0xff, 0xfe, b'b', b'a', b'd', b'\n']);
        text.extend_from_slice(b"last");
        tail.follow(std::io::Cursor::new(text));
        tail.drain(Duration::from_secs(10));
        let kept = tail.snapshot();
        assert_eq!(kept.len(), 4, "{kept:?}");
        assert!(kept[0].starts_with(&"x".repeat(BRIDGE_STDERR_LINE_MAX_BYTES)));
        assert!(kept[0].ends_with("more bytes cut]"), "the long line says it was cut: {}", &kept[0][kept[0].len() - 40..]);
        assert!(kept[0].len() < BRIDGE_STDERR_LINE_MAX_BYTES + 64);
        assert_eq!(kept[1], "good");
        assert!(kept[2].ends_with("bad"), "decoded leniently, not dropped: {:?}", kept[2]);
        assert_eq!(kept[3], "last", "the last word, with no newline after it, is kept");
        let total: usize = kept.iter().map(String::len).sum();
        assert!(total <= BRIDGE_STDERR_TAIL_MAX_BYTES);

        // Many short lines: the byte bound, not only the line bound, decides what stays.
        let tail = StderrTail::default();
        let text: String = (0..BRIDGE_STDERR_TAIL_LINES).map(|index| format!("{index:0>400}\n")).collect();
        tail.follow(std::io::Cursor::new(text.into_bytes()));
        tail.drain(Duration::from_secs(10));
        let kept = tail.snapshot();
        assert!(kept.len() < BRIDGE_STDERR_TAIL_LINES);
        assert!(kept.iter().map(String::len).sum::<usize>() <= BRIDGE_STDERR_TAIL_MAX_BYTES);
        assert!(kept.last().expect("something kept").ends_with(&format!("{}", BRIDGE_STDERR_TAIL_LINES - 1)));
    }

    #[test]
    fn a_log_left_readable_by_an_older_build_is_narrowed_before_it_is_moved_aside() {
        let directory = fixture_dir("supervisor-log-narrow");
        let path = directory.join("supervisor.log");
        fs::write(&path, "x".repeat(SUPERVISOR_LOG_MAX_BYTES as usize)).expect("a full log");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("widen");
        }
        SupervisorLog::at(Some(path.clone())).record("after", serde_json::Map::new());
        let rotated = path.with_extension("log.1");
        assert!(rotated.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&rotated).expect("rotated").permissions().mode() & 0o777, 0o600, "moved aside private");
            assert_eq!(fs::metadata(&path).expect("live").permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(log_lines(&path).len(), 1);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn a_record_too_large_for_the_file_is_replaced_by_a_line_that_says_so() {
        let directory = fixture_dir("supervisor-log-record");
        let path = directory.join("supervisor.log");
        let mut fields = serde_json::Map::new();
        fields.insert("blob".to_string(), serde_json::Value::String("y".repeat(SUPERVISOR_RECORD_MAX_BYTES)));
        SupervisorLog::at(Some(path.clone())).record("huge", fields);
        let lines = log_lines(&path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["event"], "huge");
        assert_eq!(lines[0]["truncated"], true);
        assert!(lines[0]["bytes"].as_u64().expect("size") > SUPERVISOR_RECORD_MAX_BYTES as u64);
        assert!(lines[0].get("blob").is_none());
        assert!(fs::metadata(&path).expect("log").len() < 1024);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn a_bridge_that_dies_on_its_own_is_written_down_with_its_last_words() {
        let Some(node) = find_node_binary() else {
            return;
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("reserve test port");
        let port = listener.local_addr().expect("test address").port();
        drop(listener);
        let endpoint = BridgeEndpoint {
            address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        };
        let directory = fixture_dir("bridge-dies");
        let script = directory.join("bridge.mjs");
        // Says why, and is gone — the words are still in the pipe when the exit is seen.
        fs::write(&script, "console.error('bridge fixture: cannot bind, giving up')\nprocess.exit(3)\n").expect("fixture script");
        let log_path = directory.join("supervisor.log");
        let state = StandaloneBridgeState::default();
        state
            .start_with(script, node, endpoint, SupervisorLog::at(Some(log_path.clone())))
            .expect("start supervisor");
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline && !log_lines(&log_path).iter().any(|line| line["event"] == "exited") {
            thread::sleep(Duration::from_millis(100));
        }
        state.stop();
        let lines = log_lines(&log_path);
        let exited = lines.iter().find(|line| line["event"] == "exited").unwrap_or_else(|| panic!("{lines:?}"));
        assert_eq!(exited["exit"]["code"], 3);
        assert_eq!(exited["byGyredeck"], false);
        let stderr = exited["stderr"].as_array().expect("stderr");
        assert!(
            stderr.iter().any(|line| line.as_str() == Some("bridge fixture: cannot bind, giving up")),
            "the last words were read before the exit was written: {stderr:?}"
        );
        let _ = fs::remove_dir_all(directory);
    }
}


/// Every name the person has typed for a session.
///
/// The names live with the bridge rather than in the webview because they outlast it: a
/// window that has never been opened still has the names in it, and a name kept only in
/// the page would be gone with the next reload. Returned whole — there are a handful, and
/// asking for one at a time would be a request per row of the session list.
pub(crate) fn session_names() -> Result<serde_json::Value, String> {
    let (status, value) = bridge_request("GET", "/sessions/names", None)?;
    if !(200..300).contains(&status) {
        return Err(sync_error(status, &value));
    }
    Ok(value.get("names").cloned().unwrap_or_else(|| serde_json::json!({})))
}

/// Name one session, or take the name back by passing an empty one.
///
/// What is stored is what the bridge makes of it, not what was typed: it trims, flattens
/// anything that would break the line a name is printed on, and caps the length. The
/// caller is told what was actually kept rather than left assuming its own string was.
pub(crate) fn set_session_name(conversation_id: &str, name: &str) -> Result<Option<String>, String> {
    if conversation_id.is_empty() || conversation_id.len() > 128 {
        return Err("Not a valid session id".to_string());
    }
    let body = serde_json::json!({ "name": name }).to_string();
    let (status, value) = bridge_request(
        "PUT",
        &format!("/sessions/names/{}", urlencoding_path(conversation_id)),
        Some(body),
    )?;
    // A name that could not be written down was not set: the bridge changes nothing and
    // says so, rather than answering yes with a flag saying the yes is temporary. There
    // is no half-set name to explain here.
    if !(200..300).contains(&status) {
        return Err(sync_error(status, &value));
    }
    Ok(value
        .get("name")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned))
}

/// Whether Codex will run Gyredeck's hooks, as Codex itself reports it.
///
/// The bridge starts Codex's app-server and asks it, which takes a couple of seconds and
/// is bounded at eight; the reply wait here is a little past that so the bridge's own
/// `unknown` arrives rather than a timeout of ours that says nothing about why.
pub(crate) fn codex_hook_trust() -> Result<serde_json::Value, String> {
    let (status, value) =
        bridge_request_within("GET", "/codex/hook-trust", None, Duration::from_millis(9_500))?;
    if !(200..300).contains(&status) {
        return Err(sync_error(status, &value));
    }
    Ok(value)
}

/// Percent-encode the few characters that would otherwise change which path is asked for.
/// A conversation id is a uuid in practice; this is here so that a malformed one cannot
/// reach past its own path segment.
fn urlencoding_path(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}
