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
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const FILE_NAME: &str = "session-events.json";
/// 200 conversations of 32 events stay well under this; past it a file is not ours to trust.
pub(crate) const MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Loaded {
    Absent,
    Ok { revision: u64, registry: Value },
    Corrupt { kept: String },
    /// There, but not readable (permissions, a link, too big): nothing may be saved over it.
    Unreadable { reason: String },
}

#[derive(Default)]
pub struct SessionStoreState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    revision: u64,
    blocked: Option<String>,
}

/// The registry's shape, the same rule the app's `isSessionEventRegistry` applies: an object
/// of arrays of events, each with a string `id`, `timestamp` and `conversationId`. A file the
/// app would refuse is not accepted here either, so the two never disagree (#280 audit).
pub(crate) fn is_registry(value: &Value) -> bool {
    value.as_object().is_some_and(|conversations| {
        conversations.values().all(|events| {
            events.as_array().is_some_and(|events| {
                events.iter().all(|event| {
                    ["id", "timestamp", "conversationId"].iter().all(|key| event.get(key).is_some_and(Value::is_string))
                })
            })
        })
    })
}

fn file_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

fn stamp() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

/// Read the registry, and remember its revision. Only a file that is not there is absent;
/// one that is there and cannot be read blocks every save for the rest of the run.
pub fn load(dir: &Path, state: &SessionStoreState) -> Loaded {
    let Ok(mut inner) = state.inner.lock() else {
        return Loaded::Unreadable { reason: "session store lock failed".to_string() };
    };
    let path = file_in(dir);
    let unreadable = |inner: &mut Inner, reason: String| {
        inner.blocked = Some(reason.clone());
        Loaded::Unreadable { reason }
    };
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            inner.blocked = None;
            return Loaded::Absent;
        }
        Err(error) => return unreadable(&mut inner, format!("cannot look at {}: {error}", path.display())),
        Ok(meta) if !meta.file_type().is_file() => return unreadable(&mut inner, format!("{} is not a plain file", path.display())),
        Ok(meta) if meta.len() > MAX_BYTES => return unreadable(&mut inner, format!("{} is larger than {MAX_BYTES} bytes", path.display())),
        Ok(_) => {}
    }
    let mut text = String::new();
    let read = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .and_then(|file| file.take(MAX_BYTES + 1).read_to_string(&mut text));
    if let Err(error) = read {
        return unreadable(&mut inner, format!("cannot read {}: {error}", path.display()));
    }
    let parsed = serde_json::from_str::<Value>(&text).ok().and_then(|value| {
        let revision = value.get("revision")?.as_u64()?;
        let registry = value.get("registry")?.clone();
        is_registry(&registry).then_some((revision, registry))
    });
    match parsed {
        Some((revision, registry)) => {
            // Read at last: saves may follow it again.
            inner.blocked = None;
            inner.revision = inner.revision.max(revision);
            Loaded::Ok { revision, registry }
        }
        None => {
            let aside = dir.join(format!("session-events.corrupt-{}.json", stamp()));
            match fs::rename(&path, &aside) {
                Ok(()) => Loaded::Corrupt { kept: aside.to_string_lossy().into_owned() },
                // Could not move it aside: then nothing may be written over it either.
                Err(error) => unreadable(&mut inner, format!("cannot move the unreadable {} aside: {error}", path.display())),
            }
        }
    }
}

/// Write the registry durably and hand back the revision it was kept as. The revision is
/// this store's, taken under its lock, so saves are ordered as they arrive and two windows
/// can never mint the same one.
pub fn save(dir: &Path, state: &SessionStoreState, registry: &Value) -> Result<u64, String> {
    if !is_registry(registry) {
        return Err("the registry is not a session-event registry".to_string());
    }
    let mut inner = state.inner.lock().map_err(|_| "session store lock failed".to_string())?;
    if let Some(reason) = &inner.blocked {
        return Err(format!("not saving over a registry that could not be read: {reason}"));
    }
    let revision = inner.revision + 1;
    let body = serde_json::to_vec(&serde_json::json!({ "revision": revision, "registry": registry }))
        .map_err(|error| error.to_string())?;
    if body.len() as u64 > MAX_BYTES {
        return Err(format!("the registry is larger than {MAX_BYTES} bytes"));
    }
    fs::create_dir_all(dir).map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
    let path = file_in(dir);
    if fs::symlink_metadata(&path).is_ok_and(|meta| !meta.file_type().is_file()) {
        return Err(format!("{} is not a plain file", path.display()));
    }
    // A fresh name each time, created only if nothing is there, never through a link.
    let temp = dir.join(format!(".{FILE_NAME}.{}.{}.tmp", std::process::id(), stamp()));
    let written = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .custom_flags(libc::O_NOFOLLOW)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(&body)?;
        file.sync_all()?;
        fs::rename(&temp, &path)?;
        fs::File::open(dir)?.sync_all()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(format!("cannot save the session registry: {error}"));
    }
    inner.revision = revision;
    Ok(revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use std::thread;

    fn ev(id: &str) -> Value {
        json!({ "id": id, "timestamp": "2026-11-02T00:00:00.000Z", "conversationId": "c" })
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gyredeck-session-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_file_that_exists_but_cannot_be_read_is_not_absent_and_blocks_every_save() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("unreadable");
        let state = SessionStoreState::default();
        save(&dir, &state, &json!({ "kept": [] })).unwrap();
        fs::set_permissions(file_in(&dir), fs::Permissions::from_mode(0o000)).unwrap();
        let fresh = SessionStoreState::default();
        assert!(matches!(load(&dir, &fresh), Loaded::Unreadable { .. }), "not absent");
        assert!(save(&dir, &fresh, &json!({ "new": [] })).is_err(), "no save over a file it could not read");
        fs::set_permissions(file_in(&dir), fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(fs::read_to_string(file_in(&dir)).unwrap(), r#"{"registry":{"kept":[]},"revision":1}"#);
    }

    #[test]
    fn once_the_file_can_be_read_again_saves_follow_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("recover");
        let state = SessionStoreState::default();
        save(&dir, &state, &json!({ "kept": [] })).unwrap();
        fs::set_permissions(file_in(&dir), fs::Permissions::from_mode(0o000)).unwrap();
        assert!(matches!(load(&dir, &state), Loaded::Unreadable { .. }));
        assert!(save(&dir, &state, &json!({ "new": [] })).is_err());
        fs::set_permissions(file_in(&dir), fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(load(&dir, &state), Loaded::Ok { revision: 1, .. }), "read again");
        assert_eq!(save(&dir, &state, &json!({ "new": [] })).unwrap(), 2, "and saved after it");
    }

    #[test]
    fn a_symlink_in_the_files_place_is_never_followed_for_reading_or_writing() {
        let dir = scratch("link");
        let elsewhere = dir.join("elsewhere.txt");
        fs::write(&elsewhere, "not ours").unwrap();
        std::os::unix::fs::symlink(&elsewhere, file_in(&dir)).unwrap();
        let state = SessionStoreState::default();
        assert!(matches!(load(&dir, &state), Loaded::Unreadable { .. }));
        assert!(save(&dir, &state, &json!({ "x": [] })).is_err());
        assert_eq!(fs::read_to_string(&elsewhere).unwrap(), "not ours");
    }

    #[test]
    fn a_planted_temporary_name_is_never_written_through() {
        let dir = scratch("plant");
        let elsewhere = dir.join("elsewhere.txt");
        fs::write(&elsewhere, "not ours").unwrap();
        // The old, predictable temporary name.
        std::os::unix::fs::symlink(&elsewhere, dir.join(format!("{FILE_NAME}.{}.tmp", std::process::id()))).unwrap();
        save(&dir, &SessionStoreState::default(), &json!({ "x": [] })).unwrap();
        assert_eq!(fs::read_to_string(&elsewhere).unwrap(), "not ours");
    }

    #[test]
    fn a_registry_the_app_would_refuse_is_never_saved() {
        let dir = scratch("refuse");
        let state = SessionStoreState::default();
        for bad in [json!({ "c": [{ "id": "e", "timestamp": "t" }] }), json!({ "c": {} }), json!({ "c": [1] }), json!([])] {
            assert!(save(&dir, &state, &bad).is_err(), "{bad}");
        }
        assert!(!file_in(&dir).exists());
    }

    #[test]
    fn reads_and_writes_are_capped() {
        let dir = scratch("cap");
        let big = "x".repeat(MAX_BYTES as usize + 1);
        let state = SessionStoreState::default();
        assert!(save(&dir, &state, &json!({ "c": [ev(&big)] })).is_err(), "an oversized save is refused");
        fs::write(file_in(&dir), format!(r#"{{"revision":1,"registry":{{"c":["{}"]}}}}"#, "x".repeat(MAX_BYTES as usize))).unwrap();
        assert!(matches!(load(&dir, &state), Loaded::Unreadable { .. }), "an oversized file is not read");
    }

    #[test]
    fn a_saved_registry_comes_back_and_nothing_is_left_beside_it() {
        let dir = scratch("roundtrip");
        let state = SessionStoreState::default();
        assert_eq!(load(&dir, &state), Loaded::Absent);
        assert_eq!(save(&dir, &state, &json!({ "c1": [ev("e1")] })).unwrap(), 1);
        let fresh = SessionStoreState::default();
        assert_eq!(load(&dir, &fresh), Loaded::Ok { revision: 1, registry: json!({ "c1": [ev("e1")] }) });
        let names: Vec<_> = fs::read_dir(&dir).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(names, [FILE_NAME], "no temporary file left");
    }

    #[test]
    fn revisions_are_the_stores_own_increasing_across_a_restart() {
        let dir = scratch("revisions");
        let state = SessionStoreState::default();
        assert_eq!(save(&dir, &state, &json!({ "a": [] })).unwrap(), 1);
        assert_eq!(save(&dir, &state, &json!({ "b": [] })).unwrap(), 2);
        let restarted = SessionStoreState::default();
        load(&dir, &restarted);
        assert_eq!(save(&dir, &restarted, &json!({ "c": [] })).unwrap(), 3, "a restart continues, never repeats");
    }

    #[test]
    fn overlapping_saves_each_get_their_own_revision_and_the_last_kept_is_the_highest() {
        let dir = Arc::new(scratch("overlap"));
        let state = Arc::new(SessionStoreState::default());
        let saves: Vec<_> = (0..20)
            .map(|n| {
                let (dir, state) = (Arc::clone(&dir), Arc::clone(&state));
                thread::spawn(move || save(&dir, &state, &json!({ "n": [ev(&n.to_string())] })).unwrap())
            })
            .collect();
        let mut revisions: Vec<u64> = saves.into_iter().map(|save| save.join().unwrap()).collect();
        revisions.sort_unstable();
        assert_eq!(revisions, (1..=20).collect::<Vec<_>>(), "no two saves share a revision");
        let Loaded::Ok { revision, .. } = load(&dir, &SessionStoreState::default()) else { panic!() };
        assert_eq!(revision, 20);
    }

    #[test]
    fn a_failed_save_leaves_the_last_good_file_and_its_revision() {
        let dir = scratch("fail");
        let state = SessionStoreState::default();
        save(&dir, &state, &json!({ "good": [] })).unwrap();
        // A read-only folder makes the write itself fail.
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
        assert!(save(&dir, &state, &json!({ "lost": [] })).is_err());
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(load(&dir, &SessionStoreState::default()), Loaded::Ok { revision: 1, registry: json!({ "good": [] }) });
        assert_eq!(save(&dir, &state, &json!({ "retry": [] })).unwrap(), 2, "the failed save took no revision");
    }

    #[test]
    fn an_unreadable_file_is_moved_aside_and_reported_never_read_as_empty() {
        for (name, text) in [
            ("trunc", "{\"revision\":3,\"regi"),
            ("shape", "{\"revision\":3,\"registry\":[]}"),
            ("norev", "{\"registry\":{}}"),
            ("event", "{\"revision\":3,\"registry\":{\"c\":[{\"id\":\"e\",\"timestamp\":\"t\"}]}}"),
            ("events", "{\"revision\":3,\"registry\":{\"c\":{\"id\":\"e\"}}}"),
        ] {
            let dir = scratch(name);
            fs::write(file_in(&dir), text).unwrap();
            let loaded = load(&dir, &SessionStoreState::default());
            let Loaded::Corrupt { kept } = loaded else { panic!("{name}: {loaded:?}") };
            assert_eq!(fs::read_to_string(&kept).unwrap(), text, "{name}: the bytes are kept as they were");
            assert!(!file_in(&dir).exists(), "{name}: nothing is left to be read as empty");
        }
    }
}
