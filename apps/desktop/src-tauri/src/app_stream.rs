//! The bridge's app-only stream (#391). What was said in a room, and to whom, is no longer on
//! the public `/events`; it comes on `/events/app`, which takes the machine token and the app's
//! word. The webview's `EventSource` cannot send either, so the stream is read here and each
//! event handed to the webview as `app_event`.
//!
//! Nothing may fall in a gap (#391 audit): a reconnect asks the bridge for what came after the
//! last id it saw, and what arrived is kept here too, for a webview that was not listening yet
//! when it came — the first seconds after launch, or a reload. Each event is numbered here,
//! in the order it arrived, and handed over as `{ n, event }` both live and in `app_events`, so
//! the webview can put the two in one order whatever the overlap between them.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::standalone_bridge;

const RECONNECT_AFTER: Duration = Duration::from_secs(1);
const KEPT: usize = 200;

#[derive(Default)]
pub(crate) struct AppStreamState {
    kept: Mutex<Kept>,
}

#[derive(Default)]
struct Kept {
    last: u64,
    events: VecDeque<serde_json::Value>,
}

impl AppStreamState {
    /// Numbered and kept under one lock, so the numbers run in the order the events are kept.
    fn keep(&self, payload: serde_json::Value) -> serde_json::Value {
        let mut kept = self.kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        kept.last += 1;
        let numbered = serde_json::json!({ "n": kept.last, "event": payload });
        kept.events.push_back(numbered.clone());
        while kept.events.len() > KEPT {
            kept.events.pop_front();
        }
        numbered
    }

    fn kept(&self) -> Vec<serde_json::Value> {
        let kept = self.kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        kept.events.iter().cloned().collect()
    }
}

#[tauri::command]
pub(crate) fn app_events(state: tauri::State<'_, AppStreamState>) -> Vec<serde_json::Value> {
    state.kept()
}

pub(crate) fn spawn(app: AppHandle, app_word: String) {
    std::thread::spawn(move || {
        let mut last_id: Option<String> = None;
        loop {
            let _ = read_once(&app, &app_word, &mut last_id);
            std::thread::sleep(RECONNECT_AFTER);
        }
    });
}

/// One connection, read until the bridge closes it.
fn read_once(app: &AppHandle, app_word: &str, last_id: &mut Option<String>) -> Result<(), String> {
    let target = standalone_bridge::BridgeTarget::configured()?;
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), target.port);
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(1500)).map_err(|error| error.to_string())?;
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
    let request = format!(
        "GET {} HTTP/1.0\r\nHost: {}:{}\r\nAccept: text/event-stream\r\nX-Gyredeck-Token: {}\r\nX-Gyredeck-Broker: {}\r\n\r\n",
        stream_path(last_id.as_deref()),
        standalone_bridge::BRIDGE_HOST,
        target.port,
        target.token,
        app_word
    );
    stream.write_all(request.as_bytes()).map_err(|error| error.to_string())?;
    read_events(BufReader::new(stream), last_id, |payload| {
        let numbered = app.state::<AppStreamState>().keep(payload);
        let _ = app.emit("app_event", numbered);
    })
}

fn stream_path(last_id: Option<&str>) -> String {
    match last_id {
        // An id is `<bridge>:<n>`, both parts the bridge's own hex and digits.
        Some(id) if id.chars().all(|c| c.is_ascii_alphanumeric() || c == ':') => format!("/events/app?since={id}"),
        _ => "/events/app".to_string(),
    }
}

/// The status line must say 200; then every SSE event's data, parsed, goes to `deliver`, and
/// its `id:` becomes the one the next connection asks from.
fn read_events(reader: impl BufRead, last_id: &mut Option<String>, mut deliver: impl FnMut(serde_json::Value)) -> Result<(), String> {
    let mut lines = reader.lines();
    let status = lines.next().ok_or("no status line")?.map_err(|error| error.to_string())?;
    if status.split_whitespace().nth(1) != Some("200") {
        return Err(format!("refused: {status}"));
    }
    for line in lines.by_ref() {
        if line.map_err(|error| error.to_string())?.trim_end_matches('\r').is_empty() {
            break;
        }
    }
    let mut data: Vec<String> = Vec::new();
    let mut id: Option<String> = None;
    for line in lines {
        let line = line.map_err(|error| error.to_string())?;
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            if !data.is_empty() {
                if let Ok(payload) = serde_json::from_str(&data.join("\n")) {
                    deliver(payload);
                }
                data.clear();
            }
            if let Some(seen) = id.take() {
                *last_id = Some(seen);
            }
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
        } else if let Some(value) = line.strip_prefix("id:") {
            id = Some(value.trim().to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{read_events, stream_path, AppStreamState, KEPT};

    #[test]
    fn c391_each_event_on_the_app_stream_reaches_the_webview_whole() {
        let wire = "HTTP/1.0 200 OK\r\ncontent-type: text/event-stream\r\n\r\n: connected\n\nid: ab12:7\nevent: room_message\ndata: {\"type\":\"room_message\",\"data\":{\"seq\":7}}\n\n";
        let mut seen = Vec::new();
        let mut last_id = None;
        read_events(wire.as_bytes(), &mut last_id, |payload| seen.push(payload)).unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["data"]["seq"], 7);
        assert_eq!(last_id.as_deref(), Some("ab12:7"), "the next connection asks from here");
        assert_eq!(stream_path(last_id.as_deref()), "/events/app?since=ab12:7");
    }

    #[test]
    fn c391_a_refused_stream_delivers_nothing() {
        let wire = "HTTP/1.0 401 Unauthorized\r\n\r\nid: ab12:1\nevent: room_message\ndata: {\"type\":\"room_message\"}\n\n";
        let mut seen = Vec::new();
        let mut last_id = None;
        assert!(read_events(wire.as_bytes(), &mut last_id, |payload| seen.push(payload)).is_err());
        assert!(seen.is_empty());
        assert_eq!(last_id, None);
    }

    #[test]
    fn c391_kept_events_are_numbered_in_arrival_order_and_bounded() {
        let state = AppStreamState::default();
        for seq in 1..=KEPT + 1 {
            let numbered = state.keep(serde_json::json!({ "seq": seq }));
            assert_eq!(numbered["n"], seq as u64, "live and kept carry the same number");
        }
        let kept = state.kept();
        assert_eq!(kept.len(), KEPT);
        assert_eq!(kept[0]["n"], 2, "the oldest goes first");
        assert_eq!(kept[0]["event"]["seq"], 2);
        assert_eq!(kept[KEPT - 1]["n"], (KEPT + 1) as u64);
    }

    #[test]
    fn c391_a_first_connection_and_an_odd_id_ask_for_everything_kept() {
        assert_eq!(stream_path(None), "/events/app");
        assert_eq!(stream_path(Some("ab12:7 HTTP/1.0\r\nX: y")), "/events/app");
    }
}
