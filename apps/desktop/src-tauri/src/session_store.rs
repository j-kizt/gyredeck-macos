//! The session-event registry, kept in a file the app owns (#280).
//!
//! It used to live in WebKit's localStorage, rewritten whole (2.6 MB on the owner's Mac) on
//! almost every event, and WebKit never checkpointed that store while the app ran, so its
//! WAL grew by gigabytes. A file written to a temporary name and renamed over the old one
//! has no WAL to grow.
//!
//! Three rules, each from the audit checklist:
//! - A save carries a revision and is refused unless it is newer than the last one kept, so
//!   a save that was delayed never replaces a newer registry.
//! - A save is durable before it answers: the data is synced, renamed into place, and the
//!   directory synced. The caller removes the old localStorage copy only after that answer.
//! - A file that cannot be read is moved aside, never overwritten in place, and reported as
//!   corrupt rather than as an empty registry.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const FILE_NAME: &str = "session-events.json";

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Loaded {
    Absent,
    Ok { revision: u64, registry: Value },
    Corrupt { kept: String },
}

#[derive(Default)]
pub struct SessionStoreState {
    revision: Mutex<u64>,
}

fn file_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// Read the registry, and remember its revision so an older save cannot follow it.
pub fn load(dir: &Path, state: &SessionStoreState) -> Loaded {
    let path = file_in(dir);
    let Ok(text) = fs::read_to_string(&path) else {
        return Loaded::Absent;
    };
    let parsed = serde_json::from_str::<Value>(&text).ok().and_then(|value| {
        let revision = value.get("revision")?.as_u64()?;
        let registry = value.get("registry")?.clone();
        registry.is_object().then_some((revision, registry))
    });
    match parsed {
        Some((revision, registry)) => {
            if let Ok(mut kept) = state.revision.lock() {
                *kept = (*kept).max(revision);
            }
            Loaded::Ok { revision, registry }
        }
        None => {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let aside = dir.join(format!("session-events.corrupt-{stamp}.json"));
            let kept = match fs::rename(&path, &aside) {
                Ok(()) => aside.to_string_lossy().into_owned(),
                Err(_) => path.to_string_lossy().into_owned(),
            };
            Loaded::Corrupt { kept }
        }
    }
}

/// Write the registry durably, unless a save as new or newer has already been kept.
pub fn save(dir: &Path, state: &SessionStoreState, revision: u64, registry: &Value) -> Result<(), String> {
    if !registry.is_object() {
        return Err("the registry is not an object".to_string());
    }
    // Held across the write, so two saves never interleave and the check stays true.
    let mut kept = state.revision.lock().map_err(|_| "session store lock failed".to_string())?;
    if revision <= *kept {
        return Err(format!("stale: revision {revision} is not newer than {}", *kept));
    }
    fs::create_dir_all(dir).map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
    let path = file_in(dir);
    let temp = dir.join(format!("{FILE_NAME}.{}.tmp", std::process::id()));
    let body = serde_json::to_vec(&serde_json::json!({ "revision": revision, "registry": registry }))
        .map_err(|error| error.to_string())?;
    let written = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(&body)?;
        file.sync_all()?;
        fs::rename(&temp, &path)?;
        fs::File::open(dir)?.sync_all()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(format!("cannot save the session registry: {error}"));
    }
    *kept = revision;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use std::thread;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gyredeck-session-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_saved_registry_comes_back_and_nothing_is_left_beside_it() {
        let dir = scratch("roundtrip");
        let state = SessionStoreState::default();
        assert_eq!(load(&dir, &state), Loaded::Absent);
        save(&dir, &state, 1, &json!({ "c1": [{ "id": "e1" }] })).unwrap();
        let fresh = SessionStoreState::default();
        assert_eq!(load(&dir, &fresh), Loaded::Ok { revision: 1, registry: json!({ "c1": [{ "id": "e1" }] }) });
        let names: Vec<_> = fs::read_dir(&dir).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(names, [FILE_NAME], "no temporary file left");
    }

    #[test]
    fn an_older_save_never_replaces_a_newer_one_even_after_a_restart() {
        let dir = scratch("stale");
        let state = SessionStoreState::default();
        save(&dir, &state, 5, &json!({ "new": [] })).unwrap();
        assert!(save(&dir, &state, 4, &json!({ "old": [] })).unwrap_err().starts_with("stale"));
        assert!(save(&dir, &state, 5, &json!({ "same": [] })).is_err(), "equal is not newer");
        let restarted = SessionStoreState::default();
        load(&dir, &restarted);
        assert!(save(&dir, &restarted, 3, &json!({ "old": [] })).is_err(), "the kept revision survives a restart");
        assert_eq!(load(&dir, &restarted), Loaded::Ok { revision: 5, registry: json!({ "new": [] }) });
    }

    #[test]
    fn overlapping_saves_keep_the_newest_whatever_order_they_land_in() {
        let dir = Arc::new(scratch("overlap"));
        let state = Arc::new(SessionStoreState::default());
        let saves: Vec<_> = (1..=20u64)
            .rev()
            .map(|revision| {
                let (dir, state) = (Arc::clone(&dir), Arc::clone(&state));
                thread::spawn(move || {
                    let _ = save(&dir, &state, revision, &json!({ "rev": [revision] }));
                })
            })
            .collect();
        for save in saves {
            save.join().unwrap();
        }
        assert_eq!(load(&dir, &SessionStoreState::default()), Loaded::Ok { revision: 20, registry: json!({ "rev": [20] }) });
    }

    #[test]
    fn a_failed_save_leaves_the_last_good_file_and_its_revision() {
        let dir = scratch("fail");
        let state = SessionStoreState::default();
        save(&dir, &state, 1, &json!({ "good": [] })).unwrap();
        // A directory where the temporary file must go makes the write itself fail.
        fs::create_dir(dir.join(format!("{FILE_NAME}.{}.tmp", std::process::id()))).unwrap();
        assert!(save(&dir, &state, 2, &json!({ "lost": [] })).is_err());
        fs::remove_dir(dir.join(format!("{FILE_NAME}.{}.tmp", std::process::id()))).unwrap();
        assert_eq!(load(&dir, &SessionStoreState::default()), Loaded::Ok { revision: 1, registry: json!({ "good": [] }) });
        save(&dir, &state, 2, &json!({ "retry": [] })).expect("the failed revision may be saved again");
    }

    #[test]
    fn an_unreadable_file_is_moved_aside_and_reported_never_read_as_empty() {
        for (name, text) in [("trunc", "{\"revision\":3,\"regi"), ("shape", "{\"revision\":3,\"registry\":[]}"), ("norev", "{\"registry\":{}}")] {
            let dir = scratch(name);
            fs::write(file_in(&dir), text).unwrap();
            let loaded = load(&dir, &SessionStoreState::default());
            let Loaded::Corrupt { kept } = loaded else { panic!("{name}: {loaded:?}") };
            assert_eq!(fs::read_to_string(&kept).unwrap(), text, "{name}: the bytes are kept as they were");
            assert!(!file_in(&dir).exists(), "{name}: nothing is left to be read as empty");
        }
    }
}
