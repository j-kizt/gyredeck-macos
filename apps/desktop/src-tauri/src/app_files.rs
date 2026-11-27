//! Files the app keeps in its data folder instead of WebKit's localStorage (#280, #300).
//!
//! WebKit never checkpointed the localStorage WAL while the app ran, so every rewrite of a
//! key grew it until the app restarted. A file written to a fresh temporary name and renamed
//! over the old one has no WAL to grow.
//!
//! The one reader and the one writer for every such file live here, so no store can skip a
//! rule: reads never follow a link and are capped; writes are synced, renamed into place and
//! the folder synced before they answer.
//!
//! Beside them, the app's small rewritten caches (#300): the room inbox, the GitHub status
//! cache and the usage snapshots. Each is opaque text to this side, kept under a name from a
//! fixed list. A file that is there but cannot be read blocks saves over it for the run.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn stamp() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

/// What is at a path: nothing (`Ok(None)`), its text, or why it cannot be read.
pub(crate) fn read_capped(path: &Path, max: u64) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot look at {}: {error}", path.display())),
        Ok(meta) if !meta.file_type().is_file() => return Err(format!("{} is not a plain file", path.display())),
        Ok(meta) if meta.len() > max => return Err(format!("{} is larger than {max} bytes", path.display())),
        Ok(_) => {}
    }
    let mut text = String::new();
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .and_then(|file| file.take(max + 1).read_to_string(&mut text))
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if text.len() as u64 > max {
        return Err(format!("{} is larger than {max} bytes", path.display()));
    }
    Ok(Some(text))
}

/// Replace `dir/name` with `body`, durably, never through a link and never in place.
pub(crate) fn write_durable(dir: &Path, name: &str, body: &[u8]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
    let path = dir.join(name);
    if fs::symlink_metadata(&path).is_ok_and(|meta| !meta.file_type().is_file()) {
        return Err(format!("{} is not a plain file", path.display()));
    }
    // A fresh name each time, created only if nothing is there, never through a link.
    let temp = dir.join(format!(".{name}.{}.{}.tmp", std::process::id(), stamp()));
    let written = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .custom_flags(libc::O_NOFOLLOW)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(body)?;
        file.sync_all()?;
        fs::rename(&temp, &path)?;
        fs::File::open(dir)?.sync_all()
    })();
    written.map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("cannot save {}: {error}", path.display())
    })
}

/// The caches moved out of localStorage (#300). Nothing else may be named.
const NAMES: [&str; 3] = ["room-inbox", "github-status-cache", "usage-snapshots"];
/// Each is a few hundred kilobytes at most; past this it is not ours to trust.
pub(crate) const MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Loaded {
    Absent,
    Ok { text: String },
    /// There, but not readable: nothing may be saved over it this run.
    Unreadable { reason: String },
}

#[derive(Default)]
pub struct AppFilesState {
    blocked: Mutex<HashMap<&'static str, String>>,
}

fn known(name: &str) -> Result<&'static str, String> {
    NAMES.iter().copied().find(|known| *known == name).ok_or_else(|| format!("{name} is not a file the app keeps"))
}

fn file_name(name: &str) -> String {
    format!("{name}.json")
}

pub fn load(dir: &Path, state: &AppFilesState, name: &str) -> Result<Loaded, String> {
    let name = known(name)?;
    let mut blocked = state.blocked.lock().map_err(|_| "app files lock failed".to_string())?;
    Ok(match read_capped(&dir.join(file_name(name)), MAX_BYTES) {
        Ok(None) => {
            blocked.remove(name);
            Loaded::Absent
        }
        Ok(Some(text)) => {
            blocked.remove(name);
            Loaded::Ok { text }
        }
        Err(reason) => {
            blocked.insert(name, reason.clone());
            Loaded::Unreadable { reason }
        }
    })
}

/// Saves are taken one at a time, so the last to arrive is the one kept.
pub fn save(dir: &Path, state: &AppFilesState, name: &str, text: &str) -> Result<(), String> {
    let name = known(name)?;
    if text.len() as u64 > MAX_BYTES {
        return Err(format!("{name} is larger than {MAX_BYTES} bytes"));
    }
    let blocked = state.blocked.lock().map_err(|_| "app files lock failed".to_string())?;
    if let Some(reason) = blocked.get(name) {
        return Err(format!("not saving over a file that could not be read: {reason}"));
    }
    write_durable(dir, &file_name(name), text.as_bytes())
}

pub fn dir_in(data: &Path) -> PathBuf {
    data.join("state")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gyredeck-app-files-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_saved_cache_comes_back_and_nothing_is_left_beside_it() {
        let dir = scratch("roundtrip");
        let state = AppFilesState::default();
        assert_eq!(load(&dir, &state, "room-inbox").unwrap(), Loaded::Absent);
        save(&dir, &state, "room-inbox", r#"{"a":1}"#).unwrap();
        save(&dir, &state, "room-inbox", r#"{"a":2}"#).unwrap();
        assert_eq!(load(&dir, &AppFilesState::default(), "room-inbox").unwrap(), Loaded::Ok { text: r#"{"a":2}"#.into() });
        let names: Vec<_> = fs::read_dir(&dir).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(names, ["room-inbox.json"], "no temporary file left");
    }

    #[test]
    fn only_the_listed_names_are_read_or_written() {
        let dir = scratch("names");
        let state = AppFilesState::default();
        for bad in ["../escape", "session-events", "room-inbox.json", ""] {
            assert!(load(&dir, &state, bad).is_err(), "{bad}");
            assert!(save(&dir, &state, bad, "{}").is_err(), "{bad}");
        }
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        assert!(!dir.parent().unwrap().join("escape.json").exists());
    }

    #[test]
    fn a_file_that_cannot_be_read_blocks_saves_over_it_until_it_can() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("unreadable");
        let state = AppFilesState::default();
        save(&dir, &state, "usage-snapshots", "kept").unwrap();
        let path = dir.join("usage-snapshots.json");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        assert!(matches!(load(&dir, &state, "usage-snapshots").unwrap(), Loaded::Unreadable { .. }));
        assert!(save(&dir, &state, "usage-snapshots", "new").is_err());
        assert!(save(&dir, &state, "room-inbox", "other").is_ok(), "only that name is blocked");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "kept");
        assert_eq!(load(&dir, &state, "usage-snapshots").unwrap(), Loaded::Ok { text: "kept".into() });
        assert!(save(&dir, &state, "usage-snapshots", "new").is_ok(), "read again, saved again");
    }

    #[test]
    fn a_symlink_in_the_files_place_is_never_followed() {
        let dir = scratch("link");
        let elsewhere = dir.join("elsewhere.txt");
        fs::write(&elsewhere, "not ours").unwrap();
        std::os::unix::fs::symlink(&elsewhere, dir.join("github-status-cache.json")).unwrap();
        let state = AppFilesState::default();
        assert!(matches!(load(&dir, &state, "github-status-cache").unwrap(), Loaded::Unreadable { .. }));
        assert!(save(&dir, &AppFilesState::default(), "github-status-cache", "x").is_err(), "not even by a store that never read it");
        assert_eq!(fs::read_to_string(&elsewhere).unwrap(), "not ours");
    }

    #[test]
    fn reads_and_writes_are_capped() {
        let dir = scratch("cap");
        let state = AppFilesState::default();
        let big = "x".repeat(MAX_BYTES as usize + 1);
        assert!(save(&dir, &state, "room-inbox", &big).is_err());
        fs::write(dir.join("room-inbox.json"), &big).unwrap();
        assert!(matches!(load(&dir, &state, "room-inbox").unwrap(), Loaded::Unreadable { .. }));
    }

    #[test]
    fn a_failed_save_leaves_the_last_good_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("fail");
        let state = AppFilesState::default();
        save(&dir, &state, "room-inbox", "good").unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
        assert!(save(&dir, &state, "room-inbox", "lost").is_err());
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(fs::read_to_string(dir.join("room-inbox.json")).unwrap(), "good");
    }
}
