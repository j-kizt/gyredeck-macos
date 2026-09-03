use std::{
    fs,
    io::{ErrorKind, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const BRIDGE_HOST: &str = "127.0.0.1";
pub(crate) const BRIDGE_PORT: u16 = 47_621;
const BRIDGE_MIN_PORT: u16 = 1024;
const BRIDGE_PROBE_TIMEOUT: Duration = Duration::from_millis(350);
// Mail calls carry a body and a reply, so they get more room than a health probe.
const MAIL_REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);
const BRIDGE_SUPERVISOR_INTERVAL: Duration = Duration::from_secs(1);
const OWNED_BRIDGE_FAILURE_LIMIT: u8 = 3;

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
        self.start_with(bridge_script, node, BridgeEndpoint::default())
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
            .spawn(move || supervise_bridge(bridge_script, node, endpoint, stop_rx))
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

fn supervise_bridge(
    bridge_script: PathBuf,
    node: PathBuf,
    endpoint: BridgeEndpoint,
    stop_rx: mpsc::Receiver<()>,
) {
    let mut owned_child: Option<Child> = None;
    let mut consecutive_failures = 0_u8;

    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        if let Some(child) = owned_child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    eprintln!("Gyredeck standalone bridge exited: {status}");
                    owned_child = None;
                    consecutive_failures = 0;
                }
                Err(error) => {
                    eprintln!("Gyredeck could not inspect its standalone bridge: {error}");
                    owned_child = None;
                    consecutive_failures = 0;
                }
                Ok(None) => {}
            }
        }

        let probe = probe_bridge(endpoint);
        if owned_child.is_some() {
            if probe == BridgeProbe::Healthy {
                consecutive_failures = 0;
            } else {
                consecutive_failures = consecutive_failures.saturating_add(1);
                if consecutive_failures >= OWNED_BRIDGE_FAILURE_LIMIT {
                    stop_owned_child(&mut owned_child);
                    consecutive_failures = 0;
                }
            }
        } else if probe == BridgeProbe::Offline {
            owned_child = match spawn_bridge(&node, &bridge_script, endpoint) {
                Ok(child) => Some(child),
                Err(error) => {
                    eprintln!("Gyredeck could not start its standalone bridge: {error}");
                    None
                }
            };
            consecutive_failures = 0;
        }

        match stop_rx.recv_timeout(BRIDGE_SUPERVISOR_INTERVAL) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }

    stop_owned_child(&mut owned_child);
}

fn spawn_bridge(
    node: &Path,
    bridge_script: &Path,
    endpoint: BridgeEndpoint,
) -> std::io::Result<Child> {
    Command::new(node)
        .arg(bridge_script)
        .arg("--port")
        .arg(endpoint.address.port().to_string())
        .arg("--host")
        .arg(BRIDGE_HOST)
        .arg("--parent-stdio")
        .env("PATH", super::enriched_cli_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
}

fn stop_owned_child(child: &mut Option<Child>) {
    if let Some(mut child) = child.take() {
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
    let mut stream = match TcpStream::connect_timeout(&endpoint.address, BRIDGE_PROBE_TIMEOUT) {
        Ok(stream) => stream,
        Err(error) => return classify_connect_error(&error),
    };
    let _ = stream.set_read_timeout(Some(BRIDGE_PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(BRIDGE_PROBE_TIMEOUT));
    let request = format!(
        "GET /health HTTP/1.1\r\nHost: {BRIDGE_HOST}:{}\r\nConnection: close\r\n\r\n",
        endpoint.address.port()
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return BridgeProbe::Occupied;
    }

    let mut response = String::new();
    let _ = stream.take(64 * 1024).read_to_string(&mut response);
    if is_gyredeck_health_response(&response) {
        BridgeProbe::Healthy
    } else {
        BridgeProbe::Occupied
    }
}

/// One mail room as the bridge reports it.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct MailRoom {
    pub room: String,
    pub seq: u32,
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
fn mail_request(method: &str, path: &str, body: Option<String>) -> Result<serde_json::Value, String> {
    let Some(token) = read_ingest_token() else {
        return Err("Ingest token is not available yet".to_string());
    };
    let port = configured_bridge_port();
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);

    let mut stream = TcpStream::connect_timeout(&address, MAIL_REQUEST_TIMEOUT)
        .map_err(|error| format!("Bridge is not reachable: {error}"))?;
    let _ = stream.set_read_timeout(Some(MAIL_REQUEST_TIMEOUT));
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
    if !(head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.1 202")) {
        // A bridge predating mail rooms answers 404 here; an unauthorized read is 401.
        let status = head.lines().next().unwrap_or("unknown status");
        return Err(format!("Bridge declined the mail request: {status}"));
    }
    serde_json::from_str(payload).map_err(|error| format!("Bridge sent malformed JSON: {error}"))
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
            .start_with(script, node, endpoint)
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
                .start_with(script, node.clone(), endpoint)
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
            .start_with(script, node, endpoint)
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
}

