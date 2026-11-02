use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

/// Counts what is asked of the power manager, and can refuse an acquire.
#[derive(Default)]
struct Fake {
    log: Mutex<Vec<String>>,
    next: Mutex<u32>,
    refuse: AtomicBool,
}

impl Power for Arc<Fake> {
    fn acquire(&self, kind: Kind) -> Result<u32, String> {
        if self.refuse.load(Ordering::SeqCst) {
            return Err("refused".to_string());
        }
        let mut next = self.next.lock().unwrap();
        *next += 1;
        self.log.lock().unwrap().push(format!("+{kind:?}#{next}"));
        Ok(*next)
    }
    fn release(&self, id: u32) -> Result<(), String> {
        self.log.lock().unwrap().push(format!("-#{id}"));
        Ok(())
    }
}

fn state() -> (KeepAwakeState, Arc<Fake>) {
    let fake = Arc::new(Fake::default());
    (KeepAwakeState::with(Box::new(Arc::clone(&fake))), fake)
}

fn log(fake: &Fake) -> Vec<String> {
    std::mem::take(&mut *fake.log.lock().unwrap())
}

#[test]
fn c1_c2_a_followed_room_holds_system_sleep_with_nobody_working_and_its_end_lets_go() {
    let (s, fake) = state();
    s.set_active(true, false).unwrap();
    assert!(log(&fake).is_empty(), "nothing to hold yet");
    s.set_discord_rooms(vec!["sync-ab12".into()]);
    assert_eq!(log(&fake), ["+System#1"]);
    let held = s.held();
    assert!(held.system && !held.display);
    assert_eq!(held.why.as_deref(), Some("sync-ab12 connected to Discord — the Mac won't idle-sleep"));
    s.set_discord_rooms(vec![]);
    assert_eq!(log(&fake), ["-#1"]);
    assert_eq!(s.held(), Held { display: false, system: false, why: None, error: None, rev: s.held().rev });
}

#[test]
fn c3_c4_a_live_heavy_run_holds_and_its_end_lets_go() {
    let (s, fake) = state();
    s.set_active(true, false).unwrap();
    let now = Instant::now();
    s.set_heavy(HeavySeen::Live("cargo test".into()), now);
    assert_eq!(log(&fake), ["+System#1"]);
    assert_eq!(s.held().why.as_deref(), Some("heavy run: cargo test — the Mac won't idle-sleep"));
    s.set_heavy(HeavySeen::Idle, now);
    assert_eq!(log(&fake), ["-#1"]);
    assert_eq!(s.held().why, None, "no run named once it ended");
}

#[test]
fn c4_a_bridge_that_cannot_be_asked_holds_for_the_grace_and_no_longer() {
    let (s, fake) = state();
    s.set_active(true, false).unwrap();
    let t0 = Instant::now();
    s.set_heavy(HeavySeen::Live("pnpm test:demo".into()), t0);
    log(&fake);
    s.set_heavy(HeavySeen::Unknown, t0);
    s.set_heavy(HeavySeen::Unknown, t0 + HEAVY_UNKNOWN_GRACE - Duration::from_secs(1));
    assert!(log(&fake).is_empty(), "not let go the moment the bridge goes quiet");
    assert!(s.held().system);
    s.set_heavy(HeavySeen::Unknown, t0 + HEAVY_UNKNOWN_GRACE);
    assert_eq!(log(&fake), ["-#1"], "not held for good either");
    // Answering again starts the grace afresh.
    s.set_heavy(HeavySeen::Live("pnpm test:demo".into()), t0 + HEAVY_UNKNOWN_GRACE * 2);
    s.set_heavy(HeavySeen::Unknown, t0 + HEAVY_UNKNOWN_GRACE * 3);
    assert!(s.held().system);
}

#[test]
fn c5_the_switch_off_lets_go_of_both_and_nothing_is_held_before_the_ui_speaks() {
    let (s, fake) = state();
    s.set_discord_rooms(vec!["sync-ab12".into()]);
    s.set_heavy(HeavySeen::Live("vitest".into()), Instant::now());
    assert!(log(&fake).is_empty(), "the switch is off until the UI says otherwise");
    s.set_active(true, true).unwrap();
    assert_eq!(log(&fake), ["+Display#1"]);
    s.set_active(false, true).unwrap();
    assert_eq!(log(&fake), ["-#1"]);
    assert_eq!(s.held(), Held { display: false, system: false, why: None, error: None, rev: s.held().rev });
}

#[test]
fn c6_overlapping_reasons_hold_one_assertion_and_switch_without_churn() {
    let (s, fake) = state();
    s.set_active(true, true).unwrap();
    assert_eq!(log(&fake), ["+Display#1"]);
    s.set_discord_rooms(vec!["sync-ab12".into()]);
    s.set_heavy(HeavySeen::Live("vitest".into()), Instant::now());
    assert!(log(&fake).is_empty(), "the display assertion already keeps the system up");
    assert_eq!(s.held().why.as_deref(), Some("agent working — display won't sleep"));
    s.set_active(true, false).unwrap();
    assert_eq!(log(&fake), ["+System#2", "-#1"]);
    s.set_discord_rooms(vec![]);
    assert!(log(&fake).is_empty(), "the heavy run still holds it");
    assert_eq!(s.held().why.as_deref(), Some("heavy run: vitest — the Mac won't idle-sleep"));
    s.set_heavy(HeavySeen::Idle, Instant::now());
    assert_eq!(log(&fake), ["-#2"]);
}

#[test]
fn c7_a_failed_acquire_says_nothing_is_held_and_the_next_input_tries_again() {
    let (s, fake) = state();
    s.set_active(true, false).unwrap();
    fake.refuse.store(true, Ordering::SeqCst);
    s.set_discord_rooms(vec!["sync-ab12".into()]);
    let held = s.held();
    assert!(!held.system && held.why.is_none(), "{held:?}");
    assert_eq!(held.error.as_deref(), Some("refused"));
    let held = s.set_active(true, true).unwrap();
    assert!(!held.display && held.error.as_deref() == Some("refused"), "the answer itself says the display is not held: {held:?}");
    fake.refuse.store(false, Ordering::SeqCst);
    s.set_active(true, false).unwrap();
    assert_eq!(log(&fake), ["+System#1"]);
    assert_eq!(s.held().error, None);
}

#[test]
fn every_change_is_told_once_and_quit_lets_go() {
    let (s, fake) = state();
    let told = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&told);
    s.on_change(Arc::new(move |held| sink.lock().unwrap().push(held)));
    s.set_active(true, false).unwrap();
    s.set_discord_rooms(vec!["sync-ab12".into()]);
    s.set_discord_rooms(vec!["sync-ab12".into()]);
    s.release_all();
    let told = told.lock().unwrap();
    assert_eq!(told.iter().map(|held| held.system).collect::<Vec<_>>(), [false, true, false], "{told:?}");
    assert_eq!(log(&fake), ["+System#1", "-#1"]);
}

#[test]
fn heavy_seen_reads_every_shape_the_bridge_answers() {
    use serde_json::json;
    let holder = |state: &str, gone: bool| json!({ "holder": { "id": "h", "as": "a", "what": "cargo test", "state": state, "elapsedMs": 1, "loadSkipped": false, "helperGone": gone }, "queue": [] });
    let cases: Vec<(&str, Option<serde_json::Value>, Vec<String>, HeavySeen)> = vec![
        ("reserved", Some(holder("reserved", false)), vec![], HeavySeen::Live("cargo test".into())),
        ("active", Some(holder("active", false)), vec![], HeavySeen::Live("cargo test".into())),
        ("helper gone, the slot still held", Some(holder("active", true)), vec![], HeavySeen::Live("cargo test".into())),
        ("queued only", Some(json!({ "holder": null, "queue": [{ "position": 1, "as": "a", "what": "tsc -b", "waitedMs": 5 }] })), vec![], HeavySeen::Live("tsc -b".into())),
        ("observed outside the helper", Some(json!({ "holder": null, "queue": [] })), vec!["vitest".into()], HeavySeen::Live("vitest".into())),
        ("observed while the bridge is down", None, vec!["vitest".into()], HeavySeen::Live("vitest".into())),
        ("empty", Some(json!({ "holder": null, "queue": [] })), vec![], HeavySeen::Idle),
        ("bridge down", None, vec![], HeavySeen::Unknown),
    ];
    for (name, status, observed, want) in cases {
        assert_eq!(heavy_seen(status.as_ref(), &observed), want, "{name}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn both_native_assertions_can_be_acquired_and_released() {
    let state = KeepAwakeState::default();
    assert!(state.set_active(true, true).unwrap().display);
    state.set_active(true, false).unwrap();
    state.set_discord_rooms(vec!["sync-test".into()]);
    let held = state.held();
    assert!(held.system && !held.display && held.error.is_none(), "{held:?}");
    state.release_all();
    assert_eq!(state.held(), Held { display: false, system: false, why: None, error: None, rev: state.held().rev });
}

#[test]
fn a_hand_over_whose_new_assertion_is_refused_keeps_the_old_one_until_it_can() {
    for (from_working, to_working) in [(false, true), (true, false)] {
        let (s, fake) = state();
        s.set_discord_rooms(vec!["sync-ab12".into()]);
        s.set_active(true, from_working).unwrap();
        log(&fake);
        fake.refuse.store(true, Ordering::SeqCst);
        let _ = s.set_active(true, to_working);
        assert!(log(&fake).is_empty(), "{from_working}->{to_working}: the old one is kept");
        let held = s.held();
        assert!(held.display || held.system, "{from_working}->{to_working}: never nothing while a room is on Discord");
        assert_eq!(held.error.as_deref(), Some("refused"));
        fake.refuse.store(false, Ordering::SeqCst);
        s.set_active(true, to_working).unwrap();
        assert_eq!(log(&fake).len(), 2, "{from_working}->{to_working}: taken, then the old one let go");
        assert_eq!(s.held().error, None);
    }
}

#[test]
fn every_change_moves_the_rev_and_a_repeat_does_not() {
    let (s, _fake) = state();
    s.set_active(true, false).unwrap();
    let first = s.held().rev;
    s.set_discord_rooms(vec!["sync-ab12".into()]);
    let second = s.held().rev;
    assert!(second > first);
    s.set_discord_rooms(vec!["sync-ab12".into()]);
    assert_eq!(s.held().rev, second);
}
