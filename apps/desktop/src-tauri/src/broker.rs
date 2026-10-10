//! The mailbox broker: verified process identity plus first-claim session binding.
//!
//! Every hook and every agent on this machine runs as the same Unix user, and a hook is a
//! process that lives for milliseconds, so nothing it can send — a token read from a file,
//! a `?as=` it chose — says *which* session is asking. The only party that can say anything
//! about the asker is the operating system: a Unix socket tells its listener who connected,
//! the kernel keeps every process's parent, and a signed binary carries an identity the
//! kernel will vouch for. This module listens on such a socket, asks the OS for the peer,
//! walks past any shell to the first real ancestor — the CLI that spawned the hook —
//! checks that ancestor is a known, signed CLI, and binds it to the session id the hook
//! names. A later `collect` from a hook of the same ancestor is served for the bound
//! session: the broker chooses the mailbox, the hook never names one.
//!
//! What this is, in the words agreed with Codex and Antigravity on 2026-10-10: **verified
//! process identity plus first-claim session binding**. The signature check says the
//! process is a genuine `claude` or `agy`; the binding says it was the first such process
//! to claim this id while it lives. Neither proves the id is *its* — a second genuine CLI
//! claiming an id before its owner, or after the owner exits, is the hole that remains, and
//! it is written down rather than papered over. Never call it proof of identity.
//!
//! Release 1 of three (#119): the broker exists and new hooks prefer it; the bridge still
//! serves `?as=` over TCP for hooks that do not. Codex needs no binding — its adapters never
//! read mail; the bridge pushes into the thread and harvests the reply — so its mailbox has
//! no legitimate external reader at all. macOS only: the OS calls are `LOCAL_PEERTOKEN`,
//! `proc_pidinfo`, `proc_pidpath` and the Security framework; elsewhere the listener is a
//! seam that answers `unsupported`, so a hook there falls back without guessing.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{json, Value};

/// The protocol version a request must carry and every answer carries.
pub(crate) const PROTOCOL_VERSION: u64 = 1;
/// The most a request line may carry. A hook sends a session id and a number.
const MAX_REQUEST_BYTES: usize = 4 * 1024;
/// How long one connection may take between connecting and finishing its line.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// How many connections are served at once. A hook sends one line; a flood waits.
const MAX_IN_FLIGHT: usize = 8;
/// How many sessions may be bound at once. One per live CLI; a flood is refused, not grown.
const MAX_BINDINGS: usize = 512;
/// How many shells the walk steps past between the hook and the CLI that ran it.
const MAX_SHELL_DEPTH: usize = 4;
/// The most messages one collect may take, whatever the hook asks.
const MAX_COLLECT: u64 = 1_000;

/// Where the socket lives: its own directory, this user's alone, beside the bridge's config.
pub(crate) fn broker_socket_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join(".config")
            .join("gyredeck")
            .join("broker")
            .join("gyredeck.broker.sock"),
    )
}

/// A process the OS can vouch for three times over: its pid, the unique id the kernel
/// assigns once and never reuses (`p_uniqueid`), and when it started. A pid the kernel has
/// handed to something else is a different process here however quickly it was reused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct ProcessKey {
    pub pid: i32,
    pub unique_id: u64,
    /// Microseconds since the epoch — the full precision the kernel keeps.
    pub start_time_us: u64,
}

/// The CLIs a hook may be bound through, and the signing identity each must carry.
///
/// Measured on 2026-10-10: `claude` is `com.anthropic.claude-code` under Anthropic PBC's
/// Developer ID (team Q6L2SF6YDW); `agy` is `cli` under Google LLC's (team EQHXZ8M8AV).
/// The requirement is the Developer ID form — identifier, Apple's anchor, the Developer
/// ID intermediate, a Developer ID leaf for that team — which is what each binary's own
/// designated requirement spells out. A team id alone would admit every other binary the
/// same vendor signs; the identifier narrows it to the CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KnownCli {
    Claude,
    Antigravity,
}

impl KnownCli {
    pub(crate) fn from_executable_name(name: &str) -> Option<Self> {
        match name {
            "claude" => Some(Self::Claude),
            "agy" => Some(Self::Antigravity),
            _ => None,
        }
    }

    pub(crate) fn requirement(self) -> &'static str {
        match self {
            Self::Claude => "identifier \"com.anthropic.claude-code\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = \"Q6L2SF6YDW\"",
            Self::Antigravity => "identifier \"cli\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = \"EQHXZ8M8AV\"",
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Antigravity => "agy",
        }
    }
}

/// What the OS said about the far end of a connection and about the CLI behind it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Peer {
    /// The connecting process — the hook.
    pub process: ProcessKey,
    /// The pid generation the kernel stamped into the peer's audit token. It is compared
    /// with the kernel's current generation for that pid before anything else is read: a
    /// pid handed to another process between the connect and the lookup fails right here.
    pub pid_version: u32,
    /// Every process between the hook and the CLI, hook first, ancestor last — the shells
    /// the walk stepped past included — each with the pid generation the kernel had for it
    /// when it was looked at. `exec` keeps a process's pid, unique id and start time and
    /// changes only its generation, so the generation is what pins the *code* that was
    /// checked: a CLI that exec'd into something else between the signature check and the
    /// grant is not the process that was verified. Each link and each edge is re-read
    /// before anything is granted.
    pub chain: Vec<(ProcessKey, u32)>,
    /// The first ancestor that is not a shell: the CLI, if the hook was spawned by one.
    pub ancestor: ProcessKey,
    /// What the ancestor's executable is called.
    pub ancestor_name: String,
}

/// Why an ancestor may not bind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Ineligible {
    /// Not a CLI this broker knows.
    UnknownExecutable(String),
    /// A known name whose running code does not carry that CLI's signing identity —
    /// an unsigned build, a build from source, or something else wearing the name.
    UnverifiedCode { cli: &'static str, reason: String },
}

/// The one question asked of an ancestor before it may bind, answered by the OS.
pub(crate) type Eligibility = Arc<dyn Fn(&Peer) -> Result<KnownCli, Ineligible> + Send + Sync>;
/// Whether a process the broker remembers is still the one it remembers.
pub(crate) type Liveness = Arc<dyn Fn(ProcessKey) -> bool + Send + Sync>;
/// Whether the whole chain a peer was described by still holds: the same processes, in
/// the same parent-child order, the peer's generation included.
pub(crate) type ChainCheck = Arc<dyn Fn(&Peer) -> bool + Send + Sync>;
/// What a collect does once the broker has decided whose mailbox it is: the bridge call.
pub(crate) type Collector = Arc<dyn Fn(&str, u64) -> Result<Value, String> + Send + Sync>;

/// Everything a running broker needs that is not the socket.
#[derive(Clone)]
pub(crate) struct Policy {
    pub eligible: Eligibility,
    pub alive: Liveness,
    pub chain_holds: ChainCheck,
    pub collect: Collector,
}

/// The sessions bound to processes, both ways, and the rules that govern them.
#[derive(Default)]
pub(crate) struct Bindings {
    by_session: HashMap<String, ProcessKey>,
    by_process: HashMap<ProcessKey, String>,
    /// Processes that claimed a second session while bound to a first. The broker does not
    /// pick which of the two was meant: such a process is served nothing until it exits.
    ambiguous: std::collections::HashSet<ProcessKey>,
}

/// Why a bind was refused.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BindRefusal {
    /// Another live process holds this session id.
    Conflict { session: String, holder: ProcessKey },
    /// This process claimed two sessions. It has lost both and is served nothing until it
    /// exits: the broker does not guess which claim was the real one.
    Ambiguous,
    /// The table is full.
    Full,
}

impl Bindings {
    /// Bind a session to the process the OS vouched for.
    ///
    /// One session per process and one process per session. The same pair claiming again
    /// is nothing new. A holder that has exited is replaced — that is a resumed session in
    /// a new process. A live holder is never evicted, and a process already bound to
    /// another id cannot take a second.
    pub(crate) fn bind(
        &mut self,
        session: &str,
        holder: ProcessKey,
        alive: &dyn Fn(ProcessKey) -> bool,
    ) -> Result<(), BindRefusal> {
        self.sweep(alive);
        if self.ambiguous.contains(&holder) {
            return Err(BindRefusal::Ambiguous);
        }
        if let Some(current) = self.by_process.get(&holder).cloned() {
            if current == session {
                return Ok(());
            }
            // Two claims from one process: neither is believed from here on.
            self.by_process.remove(&holder);
            self.by_session.remove(&current);
            self.ambiguous.insert(holder);
            return Err(BindRefusal::Ambiguous);
        }
        if let Some(current) = self.by_session.get(session).copied() {
            return Err(BindRefusal::Conflict { session: session.to_string(), holder: current });
        }
        // The cap is on identities the broker remembers — bound and ambiguous alike. An
        // ambiguous process keeps its entry until it exits, so a flood of claim-then-claim
        // would otherwise grow the table past every bound (Codex measured 600 of them).
        if self.by_process.len() + self.ambiguous.len() >= MAX_BINDINGS {
            return Err(BindRefusal::Full);
        }
        self.by_session.insert(session.to_string(), holder);
        self.by_process.insert(holder, session.to_string());
        Ok(())
    }

    /// The session a process is bound to.
    pub(crate) fn session_of(&self, holder: ProcessKey) -> Option<&str> {
        self.by_process.get(&holder).map(String::as_str)
    }

    /// Whether a process has disqualified itself by claiming two sessions.
    pub(crate) fn is_ambiguous(&self, holder: ProcessKey) -> bool {
        self.ambiguous.contains(&holder)
    }

    /// Drop every binding whose holder is gone. Entries die with the process they name —
    /// that is a cleanup boundary, not the session's life: a resumed session rebinds.
    pub(crate) fn sweep(&mut self, alive: &dyn Fn(ProcessKey) -> bool) {
        let dead: Vec<ProcessKey> = self
            .by_process
            .keys()
            .copied()
            .filter(|key| !alive(*key))
            .collect();
        for key in dead {
            if let Some(session) = self.by_process.remove(&key) {
                self.by_session.remove(&session);
            }
        }
        self.ambiguous.retain(|key| alive(*key));
    }

    pub(crate) fn len(&self) -> usize {
        self.by_session.len()
    }

    /// Everything the broker remembers: bound and ambiguous identities together.
    pub(crate) fn remembered(&self) -> usize {
        self.by_process.len() + self.ambiguous.len()
    }
}

fn refused(error: &str, message: String) -> Value {
    json!({ "v": PROTOCOL_VERSION, "ok": false, "error": error, "message": message })
}

/// The bridge's own rule for a mailbox name (`MAIL_ROOM_NAME`): a bind the bridge would
/// not serve must not succeed here either.
fn is_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// The broker's answer to one request, before it is written as a line.
pub(crate) fn handle_request(
    request: &Value,
    peer: Option<&Peer>,
    bindings: &Mutex<Bindings>,
    policy: &Policy,
) -> Value {
    if request.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return refused("invalid", format!("A request carries \"v\": {PROTOCOL_VERSION}."));
    }
    let Some(peer) = peer else {
        return refused("unattested", "The operating system did not say who connected; the broker serves nobody it cannot name.".to_string());
    };
    // Eligibility is asked on every request, not remembered: the process behind a pid can
    // change between one hook and the next, and the answer is the OS's, not the table's.
    let cli = match (policy.eligible)(peer) {
        Ok(cli) => cli,
        Err(Ineligible::UnknownExecutable(name)) => {
            return refused("ineligible", format!("The hook was run by {name:?}, which is not a CLI this broker binds; it keeps its TCP path."));
        }
        Err(Ineligible::UnverifiedCode { cli, reason }) => {
            return refused("ineligible", format!("The running {cli} does not carry its signing identity ({reason}); an unsigned or locally built CLI keeps its TCP path."));
        }
    };
    // The chain the socket was described by must still hold: the same hook (by generation
    // and unique id), the same shells, the same CLI, each still the parent of the next. A
    // process that exited and had its pid handed on between the reads is not the one that
    // asked. Checked after the work above, so the window it closes is the whole of the
    // time spent deciding.
    if !(policy.chain_holds)(peer) {
        return refused("unattested", "The processes that connected are no longer the ones the operating system described; nothing is granted on their behalf.".to_string());
    }

    if let Some(bind) = request.get("bind") {
        let Some(session) = bind.get("conversationId").and_then(Value::as_str).filter(|id| is_session_id(id)) else {
            return refused("invalid", "bind needs a conversationId.".to_string());
        };
        let Ok(mut table) = bindings.lock() else {
            return refused("busy", "The broker's table is unavailable.".to_string());
        };
        return match table.bind(session, peer.ancestor, &*policy.alive) {
            Ok(()) => json!({
                "v": PROTOCOL_VERSION, "ok": true,
                "bound": { "conversationId": session, "pid": peer.ancestor.pid, "cli": cli.label() },
            }),
            Err(BindRefusal::Conflict { session: held, holder }) => refused(
                "conflict",
                format!("Session {held} is bound to live process {}; a second process cannot take it while that one runs.", holder.pid),
            ),
            Err(BindRefusal::Ambiguous) => refused(
                "conflict",
                format!("Process {} claimed two sessions; it is served nothing until it exits.", peer.ancestor.pid),
            ),
            Err(BindRefusal::Full) => refused("full", "The broker holds as many bindings as it will.".to_string()),
        };
    }

    if let Some(collect) = request.get("collect") {
        let limit = collect
            .get("limit")
            .and_then(Value::as_u64)
            .map(|limit| limit.clamp(1, MAX_COLLECT))
            .unwrap_or(100);
        let session = {
            let Ok(mut table) = bindings.lock() else {
                return refused("busy", "The broker's table is unavailable.".to_string());
            };
            table.sweep(&*policy.alive);
            if table.is_ambiguous(peer.ancestor) {
                return refused("conflict", format!("Process {} claimed two sessions; it is served nothing until it exits.", peer.ancestor.pid));
            }
            table.session_of(peer.ancestor).map(str::to_string)
        };
        let Some(session) = session else {
            return refused("unbound", format!("Process {} ({}) is bound to no session; bind first, from a hook of the same process.", peer.ancestor.pid, cli.label()));
        };
        return match (policy.collect)(&session, limit) {
            Ok(mut answer) => {
                if let Value::Object(map) = &mut answer {
                    map.insert("v".to_string(), json!(PROTOCOL_VERSION));
                    map.insert("boundTo".to_string(), Value::String(session));
                }
                answer
            }
            Err(message) => refused("bridge", message),
        };
    }

    refused("invalid", "A request is {\"v\":1,\"bind\":{\"conversationId\"}} or {\"v\":1,\"collect\":{\"limit\"}}.".to_string())
}

/// A running broker: its socket, its thread, and the way to stop it.
pub(crate) struct BrokerHandle {
    stop_tx: mpsc::Sender<()>,
    join: JoinHandle<()>,
    path: PathBuf,
    /// The socket inode this broker created, so that only it is ever removed — never
    /// whatever somebody has since put at the same path.
    identity: platform::SocketIdentity,
}

#[derive(Default)]
pub(crate) struct BrokerState {
    handle: Mutex<Option<BrokerHandle>>,
    pub(crate) bindings: Arc<Mutex<Bindings>>,
}

impl BrokerState {
    /// Listen at the given path with the given policy.
    pub(crate) fn start(&self, path: PathBuf, policy: Policy) -> Result<(), String> {
        let mut handle = self
            .handle
            .lock()
            .map_err(|_| "Broker state is unavailable".to_string())?;
        if handle.is_some() {
            return Ok(());
        }
        let (listener, identity) = platform::listen(&path)?;
        let (stop_tx, stop_rx) = mpsc::channel();
        let bindings = Arc::clone(&self.bindings);
        let socket_path = path.clone();
        let own = identity;
        let join = thread::Builder::new()
            .name("gyredeck-broker".to_string())
            .spawn(move || serve(listener, socket_path, own, bindings, policy, stop_rx))
            .map_err(|error| format!("Failed to start the broker: {error}"))?;
        *handle = Some(BrokerHandle { stop_tx, join, path, identity });
        Ok(())
    }

    /// The production policy: the OS answers eligibility and liveness, the bridge collects.
    pub(crate) fn start_default(&self, collect: Collector) -> Result<(), String> {
        let path = broker_socket_path().ok_or_else(|| "HOME is not set".to_string())?;
        self.start(
            path,
            Policy {
                eligible: Arc::new(platform::eligible),
                alive: Arc::new(|key: ProcessKey| platform::process_key(key.pid).is_some_and(|now| now == key)),
                chain_holds: Arc::new(platform::chain_holds),
                collect,
            },
        )
    }

    pub(crate) fn stop(&self) {
        let handle = self
            .handle
            .lock()
            .ok()
            .and_then(|mut handle| handle.take());
        if let Some(handle) = handle {
            // The accept loop polls for this between accepts; nothing has to reach the
            // socket for the stop to land, so a path that no longer points at the listener
            // cannot keep the broker alive.
            let _ = handle.stop_tx.send(());
            let _ = handle.join.join();
            platform::remove_own_socket(&handle.path, handle.identity);
        }
    }
}

fn serve(
    listener: platform::Listener,
    path: PathBuf,
    identity: platform::SocketIdentity,
    bindings: Arc<Mutex<Bindings>>,
    policy: Policy,
    stop_rx: mpsc::Receiver<()>,
) {
    let in_flight = Arc::new(Mutex::new(0_usize));
    loop {
        // Non-blocking accept with a bounded wait between tries, so a stop is seen within
        // a tenth of a second whether or not anything ever connects again.
        let connection = match platform::accept(&listener) {
            Ok(connection) => connection,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                match stop_rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                }
            }
            Err(_) => {
                if stop_rx.try_recv().is_ok() {
                    break;
                }
                continue;
            }
        };
        if stop_rx.try_recv().is_ok() {
            break;
        }
        let admitted = in_flight
            .lock()
            .map(|mut count| {
                if *count < MAX_IN_FLIGHT {
                    *count += 1;
                    true
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if !admitted {
            let _ = platform::answer(connection, &refused("busy", "The broker is serving as many hooks as it will at once; try again.".to_string()));
            continue;
        }
        let bindings = Arc::clone(&bindings);
        let policy = policy.clone();
        let counter = Arc::clone(&in_flight);
        let spawned = thread::Builder::new()
            .name("gyredeck-broker-conn".to_string())
            .spawn(move || {
                serve_one(connection, &bindings, &policy);
                if let Ok(mut count) = counter.lock() {
                    *count = count.saturating_sub(1);
                }
            });
        if spawned.is_err() {
            if let Ok(mut count) = in_flight.lock() {
                *count = count.saturating_sub(1);
            }
        }
    }
    platform::remove_own_socket(&path, identity);
}

fn serve_one(connection: platform::Connection, bindings: &Mutex<Bindings>, policy: &Policy) {
    // Who connected is read before anything is read from them: the credential belongs to
    // the connection, and a peer that exits mid-request still answered for itself.
    let peer = platform::peer_of(&connection);
    let (mut reader, mut writer) = match platform::split(connection) {
        Ok(pair) => pair,
        Err(_) => return,
    };
    // The whole request has one deadline, from accept to the end of its line. A read
    // timeout alone is an idle timeout: a client sending a byte every few seconds would
    // hold a worker for as long as it liked.
    let started = std::time::Instant::now();
    let mut line = Vec::new();
    let answer = loop {
        if started.elapsed() >= REQUEST_TIMEOUT {
            break refused("timeout", "A request is one line, within five seconds of connecting.".to_string());
        }
        let mut chunk = [0_u8; 512];
        match reader.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => {
                line.extend_from_slice(&chunk[..n]);
                if let Some(end) = line.iter().position(|byte| *byte == b'\n') {
                    line.truncate(end);
                    break match serde_json::from_slice::<Value>(&line) {
                        Ok(request) => handle_request(&request, peer.as_ref(), bindings, policy),
                        Err(_) => refused("invalid", "A request is one JSON object per line.".to_string()),
                    };
                }
                if line.len() >= MAX_REQUEST_BYTES {
                    break refused("too_long", "A request is one line under 4 KiB.".to_string());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock || error.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(_) => return,
        }
    };
    let _ = writer.write_all(format!("{answer}\n").as_bytes());
    let _ = writer.flush();
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{Ineligible, KnownCli, Peer, ProcessKey, MAX_SHELL_DEPTH, REQUEST_TIMEOUT};
    use std::io::{BufReader, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;

    pub(super) type Listener = UnixListener;
    pub(super) type Connection = UnixStream;
    /// Device and inode of the socket this broker created.
    pub(super) type SocketIdentity = (u64, u64);

    const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "fish", "ksh"];

    /// Remove the socket at `path` only if it is the very inode this broker created. A
    /// socket that was moved away, or a file somebody put in its place, is not ours to
    /// delete — Codex renamed the socket, planted a regular file, and watched the first
    /// version of this remove it.
    pub(super) fn remove_own_socket(path: &Path, identity: SocketIdentity) {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_socket() && (meta.dev(), meta.ino()) == identity => {
                let _ = std::fs::remove_file(path);
            }
            _ => {}
        }
    }

    pub(super) fn listen(path: &Path) -> Result<(UnixListener, SocketIdentity), String> {
        use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt};
        let dir = path.parent().ok_or_else(|| "Broker socket has no directory".to_string())?;
        // The directory is this user's alone, created so, and never followed through a
        // link: a symlink planted at this path would point the socket somewhere another
        // process could reach, and `metadata` would happily describe the target instead.
        match std::fs::symlink_metadata(dir) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::DirBuilder::new()
                    .mode(0o700)
                    .create(dir)
                    .map_err(|error| format!("Broker directory: {error}"))?;
            }
            Err(error) => return Err(format!("Broker directory: {error}")),
            Ok(_) => {}
        }
        let meta = std::fs::symlink_metadata(dir).map_err(|error| format!("Broker directory: {error}"))?;
        if !meta.file_type().is_dir() {
            return Err("Broker directory is not a directory (a link or a file is in its place)".to_string());
        }
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err("Broker directory is not owned by this user".to_string());
        }
        if meta.mode() & 0o077 != 0 {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("Broker directory mode: {error}"))?;
        }
        // A socket left by a previous run is an inode nothing listens on; it is removed,
        // not reused — only if it is a socket, and only after asking: a listener that
        // answers is another app's.
        match std::fs::symlink_metadata(path) {
            Ok(existing) if existing.file_type().is_socket() => {
                if UnixStream::connect(path).is_ok() {
                    return Err("Another broker is already listening on this socket".to_string());
                }
                let _ = std::fs::remove_file(path);
            }
            Ok(_) => return Err("Something that is not a socket sits at the broker's path".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Broker socket: {error}")),
        }
        let listener = UnixListener::bind(path).map_err(|error| format!("Broker socket: {error}"))?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Broker socket mode: {error}"))?;
        listener.set_nonblocking(true).map_err(|error| format!("Broker socket: {error}"))?;
        let meta = std::fs::symlink_metadata(path).map_err(|error| format!("Broker socket: {error}"))?;
        Ok((listener, (meta.dev(), meta.ino())))
    }

    pub(super) fn accept(listener: &UnixListener) -> std::io::Result<UnixStream> {
        let (stream, _) = listener.accept()?;
        stream.set_nonblocking(false)?;
        // Short per-read waits; the elapsed deadline is kept by the reader loop.
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(250)));
        let _ = stream.set_write_timeout(Some(REQUEST_TIMEOUT));
        Ok(stream)
    }

    pub(super) fn split(stream: UnixStream) -> std::io::Result<(BufReader<UnixStream>, UnixStream)> {
        let writer = stream.try_clone()?;
        Ok((BufReader::new(stream), writer))
    }

    pub(super) fn answer(mut stream: UnixStream, answer: &serde_json::Value) -> std::io::Result<()> {
        stream.write_all(format!("{answer}\n").as_bytes())?;
        stream.flush()
    }

    /// The far end of the socket, as the kernel reports it, and the CLI behind it.
    ///
    /// `LOCAL_PEERTOKEN` hands back the peer's audit token, which carries the pid *and* the
    /// pid version; `LOCAL_PEERPID` is the fallback. The ancestry is then read from
    /// `proc_pidinfo`, never from anything the peer wrote, and walks past shells: Antigravity
    /// runs hooks through `sh -c`, which execs a single command away but stays for `&&` or
    /// a pipe, and the process the hook speaks for is the one behind the shell.
    pub(super) fn peer_of(stream: &UnixStream) -> Option<Peer> {
        let (pid, pid_version) = peer_pid(stream)?;
        // The kernel's generation for this pid must be the one stamped into the token:
        // otherwise the pid has already been handed to something else, and nothing read
        // about it from here on would be about the peer.
        let (_, current_version) = unique_info(pid)?;
        if current_version != pid_version {
            return None;
        }
        let process = process_key(pid)?;
        let mut chain = vec![(process, pid_version)];
        let mut ancestor_pid = bsd_info(pid)?.pbi_ppid as i32;
        let mut ancestor_name = executable_name(ancestor_pid)?;
        let mut depth = 0;
        while SHELLS.contains(&ancestor_name.as_str()) && depth < MAX_SHELL_DEPTH {
            chain.push((process_key(ancestor_pid)?, unique_info(ancestor_pid)?.1));
            ancestor_pid = bsd_info(ancestor_pid)?.pbi_ppid as i32;
            ancestor_name = executable_name(ancestor_pid)?;
            depth += 1;
        }
        let ancestor = process_key(ancestor_pid)?;
        chain.push((ancestor, unique_info(ancestor_pid)?.1));
        let peer = Peer { process, pid_version, chain, ancestor, ancestor_name };
        // The walk took time; everything it read must still be so.
        chain_holds(&peer).then_some(peer)
    }

    /// Whether every process in the chain is still the one described, still in that
    /// order. Each link is re-read: the child's unique id and start time, its parent pid
    /// being the next link's pid, and for the peer its token generation.
    pub(super) fn chain_holds(peer: &Peer) -> bool {
        let Some((_, version)) = unique_info(peer.process.pid) else { return false };
        if version != peer.pid_version {
            return false;
        }
        for (index, (link, generation)) in peer.chain.iter().enumerate() {
            if process_key(link.pid) != Some(*link) {
                return false;
            }
            // The same process, but is it still running the same code? An exec keeps the
            // key and bumps the generation.
            match unique_info(link.pid) {
                Some((_, now)) if now == *generation => {}
                _ => return false,
            }
            if let Some((parent, _)) = peer.chain.get(index + 1) {
                match bsd_info(link.pid) {
                    Some(info) if info.pbi_ppid as i32 == parent.pid => {}
                    _ => return false,
                }
            }
        }
        peer.chain.last().map(|(key, _)| key) == Some(&peer.ancestor)
    }

    /// Whether the ancestor is a known CLI running its vendor's signed code.
    ///
    /// Asked of the live process through the Security framework, in this process — no
    /// `codesign` is forked — against the Developer ID requirement for that CLI. A known
    /// name whose code does not verify is a build from source, an unsigned copy, or
    /// something wearing the name; all three keep the TCP path and are told so.
    pub(super) fn eligible(peer: &Peer) -> Result<KnownCli, Ineligible> {
        use security_framework::os::macos::code_signing::{Flags, GuestAttributes, SecCode, SecRequirement};

        let Some(cli) = KnownCli::from_executable_name(&peer.ancestor_name) else {
            return Err(Ineligible::UnknownExecutable(peer.ancestor_name.clone()));
        };
        let unverified = |reason: String| Ineligible::UnverifiedCode { cli: cli.label(), reason };
        let mut attributes = GuestAttributes::new();
        attributes.set_pid(peer.ancestor.pid);
        let code = SecCode::copy_guest_with_attribues(None, &attributes, Flags::NONE)
            .map_err(|error| unverified(format!("no code object for pid {}: {error}", peer.ancestor.pid)))?;
        let requirement: SecRequirement = cli
            .requirement()
            .parse()
            .map_err(|error| unverified(format!("requirement did not parse: {error}")))?;
        code.check_validity(Flags::NONE, &requirement)
            .map_err(|error| unverified(format!("{error}")))?;
        // The process the signature was checked for must still be the one that connected.
        if process_key(peer.ancestor.pid) != Some(peer.ancestor) {
            return Err(unverified("the process changed while it was being checked".to_string()));
        }
        Ok(cli)
    }

    /// The peer's pid and pid generation from its audit token. Only the token will do: a
    /// bare `LOCAL_PEERPID` carries no generation, so a pid reused between the connect and
    /// the first lookup could not be told from the peer — the broker fails closed instead.
    fn peer_pid(stream: &UnixStream) -> Option<(i32, u32)> {
        let fd = stream.as_raw_fd();
        let mut token = [0_u32; 8];
        let mut length = std::mem::size_of_val(&token) as libc::socklen_t;
        let read = unsafe {
            libc::getsockopt(fd, libc::SOL_LOCAL, libc::LOCAL_PEERTOKEN, token.as_mut_ptr().cast(), &mut length)
        };
        // audit_token_t: val[5] is the pid, val[7] the pid version.
        (read == 0 && length as usize == std::mem::size_of_val(&token) && token[5] > 0).then_some((token[5] as i32, token[7]))
    }

    /// `PROC_PIDUNIQIDENTIFIERINFO`, which the libc crate does not carry, in the layout
    /// xnu's `bsd/sys/proc_info_private.h` gives it: the unique id the kernel assigns once
    /// and never hands to another process, and the pid generation the audit token carries.
    const PROC_PIDUNIQIDENTIFIERINFO: libc::c_int = 17;
    #[repr(C)]
    struct ProcUniqIdentifierInfo {
        p_uuid: [u8; 16],
        p_uniqueid: u64,
        p_puniqueid: u64,
        p_idversion: i32,
        p_orig_ppidversion: i32,
        p_reserve2: u64,
        p_reserve3: u64,
    }

    #[cfg(test)]
    pub(super) fn unique_info_for_tests(pid: i32) -> Option<(u64, u32)> {
        unique_info(pid)
    }

    /// The process's unique id and its pid generation, or nothing if it is gone.
    fn unique_info(pid: i32) -> Option<(u64, u32)> {
        if pid <= 0 {
            return None;
        }
        let mut info = unsafe { std::mem::zeroed::<ProcUniqIdentifierInfo>() };
        let expected = std::mem::size_of::<ProcUniqIdentifierInfo>() as i32;
        let read = unsafe {
            libc::proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 0, (&mut info as *mut ProcUniqIdentifierInfo).cast(), expected)
        };
        (read == expected && info.p_uniqueid != 0).then_some((info.p_uniqueid, info.p_idversion as u32))
    }

    fn bsd_info(pid: i32) -> Option<libc::proc_bsdinfo> {
        if pid <= 0 {
            return None;
        }
        let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
        let expected = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let read = unsafe {
            libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), expected)
        };
        (read == expected && info.pbi_pid != 0).then_some(info)
    }

    /// The executable's file name — from the kernel's path for the process, not its argv.
    fn executable_name(pid: i32) -> Option<String> {
        if pid <= 0 {
            return None;
        }
        let mut bytes = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let read = unsafe { libc::proc_pidpath(pid, bytes.as_mut_ptr().cast(), bytes.len() as u32) };
        if read <= 0 {
            return None;
        }
        bytes.truncate(read as usize);
        let path = String::from_utf8_lossy(&bytes).trim_end_matches('\0').to_string();
        Path::new(&path).file_name().map(|name| name.to_string_lossy().into_owned())
    }

    /// A process as the OS knows it now: pid and start time, or nothing if it is gone.
    pub(super) fn process_key(pid: i32) -> Option<ProcessKey> {
        let info = bsd_info(pid)?;
        let (unique_id, _) = unique_info(pid)?;
        Some(ProcessKey {
            pid,
            unique_id,
            start_time_us: info.pbi_start_tvsec.saturating_mul(1_000_000).saturating_add(info.pbi_start_tvusec),
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    //! The seam: no attestation here yet. Listening fails with a reason the app prints
    //! once, so hooks find no socket and fall back to TCP without guessing.
    use super::{Ineligible, KnownCli, Peer, ProcessKey};
    use std::io::BufReader;
    use std::path::Path;

    pub(super) struct Listener;
    pub(super) struct Connection;
    pub(super) type SocketIdentity = (u64, u64);

    pub(super) fn remove_own_socket(_path: &Path, _identity: SocketIdentity) {}

    pub(super) fn listen(_path: &Path) -> Result<(Listener, SocketIdentity), String> {
        Err("The mailbox broker is only available on macOS".to_string())
    }
    pub(super) fn accept(_listener: &Listener) -> std::io::Result<Connection> {
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no broker on this platform"))
    }
    pub(super) fn split(_c: Connection) -> std::io::Result<(BufReader<std::io::Empty>, std::io::Sink)> {
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no broker on this platform"))
    }
    pub(super) fn answer(_c: Connection, _answer: &serde_json::Value) -> std::io::Result<()> {
        Ok(())
    }
    pub(super) fn peer_of(_c: &Connection) -> Option<Peer> {
        None
    }
    pub(super) fn eligible(peer: &Peer) -> Result<KnownCli, Ineligible> {
        Err(Ineligible::UnknownExecutable(peer.ancestor_name.clone()))
    }
    pub(super) fn chain_holds(_peer: &Peer) -> bool {
        false
    }
    pub(super) fn process_key(_pid: i32) -> Option<ProcessKey> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(pid: i32) -> ProcessKey {
        ProcessKey { pid, unique_id: 500_000 + pid as u64, start_time_us: 1_000_000 + pid as u64 }
    }

    fn peer(hook: i32, ancestor: i32, name: &str) -> Peer {
        Peer { process: key(hook), pid_version: 1, chain: vec![(key(hook), 1), (key(ancestor), 1)], ancestor: key(ancestor), ancestor_name: name.to_string() }
    }

    fn policy_accepting_everything() -> Policy {
        Policy {
            eligible: Arc::new(|p: &Peer| KnownCli::from_executable_name(&p.ancestor_name).ok_or_else(|| Ineligible::UnknownExecutable(p.ancestor_name.clone()))),
            alive: Arc::new(|_| true),
            chain_holds: Arc::new(|_| true),
            collect: Arc::new(|session: &str, limit: u64| Ok(json!({ "ok": true, "messages": [], "askedFor": session, "limit": limit }))),
        }
    }

    fn ask(request: Value, peer: Option<&Peer>, bindings: &Mutex<Bindings>, policy: &Policy) -> Value {
        handle_request(&request, peer, bindings, policy)
    }

    #[test]
    fn one_session_per_process_and_one_process_per_session() {
        let alive = |_: ProcessKey| true;
        let mut table = Bindings::default();
        assert_eq!(table.bind("s1", key(10), &alive), Ok(()));
        assert_eq!(table.bind("s1", key(10), &alive), Ok(()), "the holder claiming again is nothing new");
        assert_eq!(table.bind("s1", key(11), &alive), Err(BindRefusal::Conflict { session: "s1".into(), holder: key(10) }), "a second live process cannot take the id");
        assert_eq!(table.session_of(key(10)), Some("s1"));
        assert_eq!(table.session_of(key(11)), None);
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn a_process_that_claims_two_sessions_loses_both_until_it_exits() {
        let alive = |_: ProcessKey| true;
        let mut table = Bindings::default();
        table.bind("s1", key(10), &alive).unwrap();
        assert_eq!(table.bind("s2", key(10), &alive), Err(BindRefusal::Ambiguous), "a second claim is ambiguity, not a choice");
        assert_eq!(table.session_of(key(10)), None, "and the first claim is gone with it");
        assert!(table.is_ambiguous(key(10)));
        assert_eq!(table.bind("s1", key(10), &alive), Err(BindRefusal::Ambiguous), "it cannot claim its way back");
        assert_eq!(table.bind("s1", key(11), &alive), Ok(()), "another process may now take s1");
        table.sweep(&|k| k.pid != 10);
        assert!(!table.is_ambiguous(key(10)), "ambiguity dies with the process");
        let reborn = ProcessKey { pid: 10, unique_id: 777, start_time_us: 9 };
        assert_eq!(table.bind("s3", reborn, &|_| true), Ok(()), "a new process on the old pid starts clean");
    }

    #[test]
    fn a_binding_dies_with_its_process_and_a_resumed_session_rebinds() {
        let mut table = Bindings::default();
        table.bind("s1", key(10), &|_| true).unwrap();
        let only_eleven_lives = |k: ProcessKey| k.pid == 11;
        assert_eq!(table.bind("s1", key(11), &only_eleven_lives), Ok(()), "the old holder has exited: a resume");
        assert_eq!(table.session_of(key(11)), Some("s1"));
        assert_eq!(table.session_of(key(10)), None);
        table.sweep(&|_| false);
        assert_eq!(table.len(), 0);
    }

    #[test]
    fn a_reused_pid_is_a_different_process() {
        let mut table = Bindings::default();
        table.bind("s1", key(10), &|_| true).unwrap();
        let reborn = ProcessKey { pid: 10, unique_id: 999_999, start_time_us: 9_999_999 };
        assert_eq!(table.session_of(reborn), None, "same pid, different start: not the holder");
        let alive = |k: ProcessKey| k == reborn;
        assert_eq!(table.bind("s1", reborn, &alive), Ok(()), "and the old one is gone, so it may claim");
    }

    #[test]
    fn a_live_holder_is_never_evicted_by_a_full_table() {
        let mut table = Bindings::default();
        for pid in 0..MAX_BINDINGS as i32 {
            table.bind(&format!("s{pid}"), key(1_000 + pid), &|_| true).unwrap();
        }
        assert_eq!(table.bind("one-more", key(9_999), &|_| true), Err(BindRefusal::Full));
        assert_eq!(table.len(), MAX_BINDINGS, "nothing was dropped to make room");
    }

    #[test]
    fn ambiguous_identities_count_against_the_cap_and_stay_until_they_exit() {
        // Codex's harness: 600 processes each bind A then claim B. Counting only bindings
        // freed a slot on every conflict and left a permanent ambiguous entry behind it.
        let mut table = Bindings::default();
        let mut admitted = 0;
        for pid in 0..600_i32 {
            let holder = key(10_000 + pid);
            match table.bind(&format!("a{pid}"), holder, &|_| true) {
                Ok(()) => {
                    admitted += 1;
                    assert_eq!(table.bind(&format!("b{pid}"), holder, &|_| true), Err(BindRefusal::Ambiguous));
                }
                Err(BindRefusal::Full) => {}
                Err(other) => panic!("{other:?}"),
            }
        }
        assert_eq!(admitted, MAX_BINDINGS, "admission stops at the cap");
        assert_eq!(table.len(), 0, "every admitted identity is ambiguous now");
        assert_eq!(table.remembered(), MAX_BINDINGS, "and every one is still remembered");
        assert_eq!(table.bind("fresh", key(99_999), &|_| true), Err(BindRefusal::Full), "a new identity is refused while they live");
        table.sweep(&|_| false);
        assert_eq!(table.remembered(), 0);
        assert_eq!(table.bind("fresh", key(99_999), &|_| true), Ok(()), "and admitted once they have exited");
    }

    #[test]
    fn requests_are_versioned_attested_and_gated_on_eligibility() {
        let bindings = Mutex::new(Bindings::default());
        let policy = policy_accepting_everything();
        let claude = peer(42, 40, "claude");

        assert_eq!(ask(json!({ "bind": { "conversationId": "s" } }), Some(&claude), &bindings, &policy)["error"], "invalid", "no version");
        assert_eq!(ask(json!({ "v": 2, "collect": {} }), Some(&claude), &bindings, &policy)["error"], "invalid", "wrong version");
        assert_eq!(ask(json!({ "v": 1, "collect": {} }), None, &bindings, &policy)["error"], "unattested");
        let python = peer(43, 41, "python3");
        assert_eq!(ask(json!({ "v": 1, "bind": { "conversationId": "s" } }), Some(&python), &bindings, &policy)["error"], "ineligible", "not a CLI this broker binds");
        assert_eq!(ask(json!({ "v": 1, "hello": 1 }), Some(&claude), &bindings, &policy)["error"], "invalid");
        assert_eq!(ask(json!({ "v": 1, "bind": { "conversationId": "has space" } }), Some(&claude), &bindings, &policy)["error"], "invalid");
        assert_eq!(ask(json!({ "v": 1, "bind": { "conversationId": "codex:/tmp/x" } }), Some(&claude), &bindings, &policy)["error"], "invalid", "the bridge would not serve that name either");
        assert_eq!(ask(json!({ "v": 1, "bind": { "conversationId": "x".repeat(65) } }), Some(&claude), &bindings, &policy)["error"], "invalid");
    }

    #[test]
    fn the_broker_chooses_the_mailbox_for_the_bound_ancestor_and_nobody_else() {
        let bindings = Mutex::new(Bindings::default());
        let policy = policy_accepting_everything();
        let claude = peer(42, 40, "claude");

        assert_eq!(ask(json!({ "v": 1, "collect": {} }), Some(&claude), &bindings, &policy)["error"], "unbound");
        let bound = ask(json!({ "v": 1, "bind": { "conversationId": "sess-1" } }), Some(&claude), &bindings, &policy);
        assert_eq!(bound["ok"], true, "{bound}");
        assert_eq!(bound["bound"]["pid"], 40, "bound to the ancestor, not the hook");
        assert_eq!(bound["bound"]["cli"], "claude");

        let served = ask(json!({ "v": 1, "collect": { "limit": 7 } }), Some(&claude), &bindings, &policy);
        assert_eq!(served["askedFor"], "sess-1", "the broker named the mailbox; the hook named nothing");
        assert_eq!(served["limit"], 7);
        assert_eq!(served["boundTo"], "sess-1");
        assert_eq!(served["v"], 1);
        let huge = ask(json!({ "v": 1, "collect": { "limit": 1_000_000 } }), Some(&claude), &bindings, &policy);
        assert_eq!(huge["limit"], MAX_COLLECT, "the limit is clamped");

        // Another hook of the same CLI but a different process: not this session's.
        let other = peer(52, 50, "agy");
        assert_eq!(ask(json!({ "v": 1, "bind": { "conversationId": "sess-1" } }), Some(&other), &bindings, &policy)["error"], "conflict");
        assert_eq!(ask(json!({ "v": 1, "collect": {} }), Some(&other), &bindings, &policy)["error"], "unbound");
        // The holder claiming a second id is ambiguous: refused, and it can no longer
        // collect the first either — a collect after that conflict is the regression.
        assert_eq!(ask(json!({ "v": 1, "bind": { "conversationId": "sess-2" } }), Some(&claude), &bindings, &policy)["error"], "conflict");
        let after = ask(json!({ "v": 1, "collect": {} }), Some(&claude), &bindings, &policy);
        assert_eq!(after["error"], "conflict", "{after}");
        assert!(after["message"].as_str().unwrap().contains("claimed two sessions"));
    }

    #[test]
    fn a_peer_that_is_no_longer_the_described_process_is_served_nothing() {
        let bindings = Mutex::new(Bindings::default());
        let policy = Policy {
            eligible: Arc::new(|_: &Peer| Ok(KnownCli::Claude)),
            alive: Arc::new(|_| true),
            // The chain broke while it was being looked at — the hook exited, or a shell in
            // the middle was replaced; the OS no longer describes what connected.
            chain_holds: Arc::new(|_| false),
            collect: Arc::new(|_, _| Ok(json!({ "ok": true }))),
        };
        let claude = peer(42, 40, "claude");
        assert_eq!(ask(json!({ "v": 1, "bind": { "conversationId": "s" } }), Some(&claude), &bindings, &policy)["error"], "unattested");
        assert_eq!(bindings.lock().unwrap().len(), 0, "nothing was bound on its behalf");
    }

    #[test]
    fn eligibility_is_asked_on_every_request_not_remembered() {
        let bindings = Mutex::new(Bindings::default());
        let verdicts = Arc::new(Mutex::new(vec![Ok(KnownCli::Claude), Err(Ineligible::UnverifiedCode { cli: "claude", reason: "replaced".into() })]));
        let policy = Policy {
            eligible: Arc::new({
                let verdicts = Arc::clone(&verdicts);
                move |_: &Peer| verdicts.lock().unwrap().remove(0)
            }),
            alive: Arc::new(|_| true),
            chain_holds: Arc::new(|_| true),
            collect: Arc::new(|_, _| Ok(json!({ "ok": true }))),
        };
        let claude = peer(42, 40, "claude");
        assert_eq!(ask(json!({ "v": 1, "bind": { "conversationId": "s" } }), Some(&claude), &bindings, &policy)["ok"], true);
        let later = ask(json!({ "v": 1, "collect": {} }), Some(&claude), &bindings, &policy);
        assert_eq!(later["error"], "ineligible", "the same pid, no longer verified: refused, binding or not");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn over_the_socket_the_os_names_the_peer_and_its_ancestor() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::UnixStream;

        let dir = std::env::temp_dir().join(format!("gyredeck-broker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // The config directory exists before the broker does; the broker makes only its own.
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("broker").join("broker.sock");
        let state = BrokerState::default();
        // Eligibility is stubbed to "a known CLI": the test runner is not one, and the
        // real check is exercised below.
        let policy = Policy {
            eligible: Arc::new(|_: &Peer| Ok(KnownCli::Claude)),
            alive: Arc::new(|key: ProcessKey| platform::process_key(key.pid).is_some_and(|now| now == key)),
            chain_holds: Arc::new(platform::chain_holds),
            collect: Arc::new(|session: &str, _| Ok(json!({ "ok": true, "messages": [], "askedFor": session }))),
        };
        state.start(path.clone(), policy).unwrap();

        let ask = |line: &str| -> Value {
            let mut stream = UnixStream::connect(&path).unwrap();
            stream.write_all(format!("{line}\n").as_bytes()).unwrap();
            let mut answer = String::new();
            BufReader::new(stream).read_line(&mut answer).unwrap();
            serde_json::from_str(answer.trim()).unwrap()
        };
        // This test process is the peer; the OS reports its parent, which is what gets bound.
        let me = std::process::id() as i32;
        let parent_pid = unsafe { libc::getppid() };
        let bound = ask(r#"{"v":1,"bind":{"conversationId":"sock-1"}}"#);
        assert_eq!(bound["ok"], true, "{bound}");
        let bound_pid = bound["bound"]["pid"].as_i64().unwrap() as i32;
        assert_ne!(bound_pid, me, "never the hook itself");
        assert!(bound_pid == parent_pid || bound_pid > 0, "an ancestor the OS reported");
        let served = ask(r#"{"v":1,"collect":{"limit":3}}"#);
        assert_eq!(served["askedFor"], "sock-1");
        assert_eq!(served["boundTo"], "sock-1");

        let socket_mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(socket_mode, 0o600, "the socket is this user's alone");
        let dir_mode = std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700, "and so is its directory");

        let too_long = format!("{{\"v\":1,\"bind\":{{\"conversationId\":\"{}\"}}}}", "x".repeat(MAX_REQUEST_BYTES));
        assert_eq!(ask(&too_long)["error"], "too_long");
        assert_eq!(ask("not json")["error"], "invalid");

        // A client that keeps dribbling — a byte every 100 ms, well inside the 250 ms the
        // socket waits per read — never goes idle, and is still cut off at the elapsed
        // deadline. An idle client alone would prove only the read timeout.
        let mut slow = UnixStream::connect(&path).unwrap();
        let slow_started = std::time::Instant::now();
        let _ = slow.set_read_timeout(Some(Duration::from_secs(8)));
        let mut reader = BufReader::new(slow.try_clone().unwrap());
        let dribble = std::thread::spawn(move || {
            let mut written = 0;
            while slow_started.elapsed() < Duration::from_secs(7) {
                if slow.write_all(b" ").is_err() { break; }
                written += 1;
                std::thread::sleep(Duration::from_millis(100));
            }
            written
        });
        let mut answer = String::new();
        reader.read_line(&mut answer).unwrap();
        let answered_at = slow_started.elapsed();
        let answer: Value = serde_json::from_str(answer.trim()).unwrap();
        assert_eq!(answer["error"], "timeout", "{answer}");
        assert!(answered_at >= Duration::from_millis(4_500) && answered_at < Duration::from_secs(7), "answered at the deadline ({answered_at:?}), not at an idle gap and not later");
        let written = dribble.join().unwrap();
        assert!(written >= 30, "the client really was writing all along ({written} writes)");

        state.stop();
        assert!(!path.exists(), "stopping removes the socket");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Not run by `cargo test` alone: it needs a real `claude` or `agy` on the machine.
    /// `GYREDECK_BROKER_LIVE_PID=<pid> GYREDECK_BROKER_LIVE_NAME=<claude|agy> cargo test --lib broker -- --ignored`
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn the_real_check_accepts_a_live_signed_cli() {
        let pid: i32 = std::env::var("GYREDECK_BROKER_LIVE_PID").expect("GYREDECK_BROKER_LIVE_PID").parse().unwrap();
        let name = std::env::var("GYREDECK_BROKER_LIVE_NAME").expect("GYREDECK_BROKER_LIVE_NAME");
        let ancestor = platform::process_key(pid).expect("the CLI is alive");
        let me = platform::process_key(std::process::id() as i32).unwrap();
        let peer = Peer { process: me, pid_version: 0, chain: vec![(me, 0), (ancestor, 0)], ancestor, ancestor_name: name.clone() };
        let verdict = platform::eligible(&peer);
        assert!(verdict.is_ok(), "{name} at pid {pid}: {verdict:?}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_chain_check_reads_the_kernel_and_fails_closed_on_any_broken_link() {
        let me_pid = std::process::id() as i32;
        let me = platform::process_key(me_pid).unwrap();
        let parent_pid = unsafe { libc::getppid() };
        let parent = platform::process_key(parent_pid).unwrap();
        let (_, my_version) = platform_unique_version(me_pid);
        let (_, parent_version) = platform_unique_version(parent_pid);
        let honest = Peer { process: me, pid_version: my_version, chain: vec![(me, my_version), (parent, parent_version)], ancestor: parent, ancestor_name: "cargo".to_string() };
        assert!(platform::chain_holds(&honest), "this process, its parent, and the edge between them, as the kernel sees them now");
        let wrong_generation = Peer { pid_version: my_version.wrapping_add(1), ..honest.clone() };
        assert!(!platform::chain_holds(&wrong_generation), "a token from another generation of this pid is not this peer");
        let ancestor_regenerated = Peer { chain: vec![(me, my_version), (parent, parent_version.wrapping_add(1))], ..honest.clone() };
        assert!(!platform::chain_holds(&ancestor_regenerated), "an ancestor whose generation moved is not the code that was checked");
        let wrong_edge = Peer { chain: vec![(me, my_version), (me, my_version)], ancestor: me, ..honest.clone() };
        assert!(!platform::chain_holds(&wrong_edge), "a parent that is not the parent");
        let dead_link = ProcessKey { pid: me_pid, unique_id: me.unique_id + 1, start_time_us: me.start_time_us };
        let replaced = Peer { process: dead_link, chain: vec![(dead_link, my_version), (parent, parent_version)], ..honest.clone() };
        assert!(!platform::chain_holds(&replaced), "a different process on this pid");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_ancestor_that_execs_into_other_code_is_no_longer_the_process_that_was_checked() {
        // `exec` keeps pid, unique id and start time and changes only the generation, so a
        // chain pinned by keys alone would still hold for a CLI that became something else
        // after its signature was checked. Codex measured it; this is the regression.
        use std::process::{Command, Stdio};
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 1; exec /bin/sleep 30"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        let before = platform::process_key(pid).unwrap();
        let (_, generation_before) = platform_unique_version(pid);
        let me = platform::process_key(std::process::id() as i32).unwrap();
        let (_, my_version) = platform_unique_version(std::process::id() as i32);
        // The child plays the CLI: this test process stands in for the hook it "spawned" is
        // not true — so the chain is checked link by link rather than through the edge.
        let pinned = Peer { process: me, pid_version: my_version, chain: vec![(before, generation_before)], ancestor: before, ancestor_name: "sh".to_string() };
        assert!(platform::chain_holds(&pinned), "before the exec the pinned chain holds");
        // Wait for the exec: the executable name changes while the key does not.
        let started = std::time::Instant::now();
        loop {
            let (_, now) = platform_unique_version(pid);
            if now != generation_before { break; }
            assert!(started.elapsed() < Duration::from_secs(10), "the child never exec'd");
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(platform::process_key(pid), Some(before), "pid, unique id and start time survive exec");
        assert!(!platform::chain_holds(&pinned), "but the generation moved, and the chain no longer holds");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(target_os = "macos")]
    fn platform_unique_version(pid: i32) -> (u64, u32) {
        platform::unique_info_for_tests(pid).expect("alive")
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn shutdown_removes_only_the_socket_it_created_and_needs_no_path_to_stop() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixStream;

        let dir = std::env::temp_dir().join(format!("gyredeck-broker-shutdown-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("broker").join("broker.sock");
        let policy = Policy {
            eligible: Arc::new(|_: &Peer| Ok(KnownCli::Claude)),
            alive: Arc::new(|_| true),
            chain_holds: Arc::new(|_| true),
            collect: Arc::new(|_, _| Ok(json!({ "ok": true }))),
        };

        // Codex's fixture: the socket is moved away and a regular file is put in its place.
        // The listener still answers at its new path; the stop must land without the old
        // path pointing anywhere useful, and the file must survive the shutdown.
        let state = BrokerState::default();
        state.start(path.clone(), policy.clone()).unwrap();
        let moved = dir.join("broker").join("moved.sock");
        std::fs::rename(&path, &moved).unwrap();
        std::fs::write(&path, b"not a socket").unwrap();
        let mut stream = UnixStream::connect(&moved).unwrap();
        stream.write_all(b"{\"v\":1,\"collect\":{}}\n").unwrap();
        let mut answer = String::new();
        BufReader::new(stream).read_line(&mut answer).unwrap();
        assert!(answer.contains("unbound"), "still serving at the moved path: {answer}");
        let stopped = std::time::Instant::now();
        state.stop();
        assert!(stopped.elapsed() < Duration::from_secs(3), "stopped without anything connecting through the old path");
        assert_eq!(std::fs::read(&path).unwrap(), b"not a socket", "the replacement file is not ours and was left alone");
        assert!(moved.exists(), "the moved socket was not found by path either; nothing else was removed");

        // The ordinary case: our own socket, at our own path, is removed on stop.
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&moved);
        let again = BrokerState::default();
        again.start(path.clone(), policy).unwrap();
        assert!(path.exists());
        again.stop();
        assert!(!path.exists(), "our socket, our path: removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_link_in_place_of_the_broker_directory_is_refused() {
        let dir = std::env::temp_dir().join(format!("gyredeck-broker-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(dir.join("elsewhere"), dir.join("broker")).unwrap();
        let state = BrokerState::default();
        let policy = Policy {
            eligible: Arc::new(|_: &Peer| Ok(KnownCli::Claude)),
            alive: Arc::new(|_| true),
            chain_holds: Arc::new(|_| true),
            collect: Arc::new(|_, _| Ok(json!({ "ok": true }))),
        };
        let refused = state.start(dir.join("broker").join("broker.sock"), policy);
        assert!(matches!(refused, Err(ref message) if message.contains("not a directory")), "{refused:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_real_check_refuses_an_ancestor_that_is_not_a_signed_known_cli() {
        // The test runner's parent is cargo or a shell — never `claude` or `agy` — so the
        // production gate must say so. This is the gate that keeps a script from binding.
        let parent_pid = unsafe { libc::getppid() };
        let parent = platform::process_key(parent_pid).expect("the parent is alive");
        let me = platform::process_key(std::process::id() as i32).unwrap();
        let peer = Peer { process: me, pid_version: 0, chain: vec![(me, 0), (parent, 0)], ancestor: parent, ancestor_name: "cargo".to_string() };
        assert!(matches!(platform::eligible(&peer), Err(Ineligible::UnknownExecutable(_))));
        // A known name on a process that is not that CLI: the signature check refuses it.
        let impostor = Peer { ancestor_name: "claude".to_string(), ..peer };
        assert!(matches!(platform::eligible(&impostor), Err(Ineligible::UnverifiedCode { cli: "claude", .. })));
    }
}
