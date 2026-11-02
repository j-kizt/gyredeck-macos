//! What keeps the Mac awake, and why (#211, #278).
//!
//! Three things may: an agent working (the display stays on, as before), a room followed on
//! Discord, and a heavy run on the machine. The last two hold only idle *system* sleep — the
//! display may dim and sleep (the owner, 2026-10-27) — and a closed lid still sleeps whatever
//! is held. The webview reports only the switch and whether an agent is working, and reads
//! what is held from the answer; Discord and the heavy-run watcher report straight to this
//! state, so a hidden or throttled window never lets the Mac sleep under a room or a run.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a heavy run last seen live still holds the Mac when the bridge cannot be asked:
/// long enough for a bridge restart, short enough that a bridge that never answers again does
/// not keep the Mac up for good.
pub(crate) const HEAVY_UNKNOWN_GRACE: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// `PreventUserIdleDisplaySleep`: an agent is working.
    Display,
    /// `PreventUserIdleSystemSleep`: a Discord room or a heavy run, the display free to sleep.
    System,
}

pub(crate) trait Power: Send + Sync {
    fn acquire(&self, kind: Kind) -> Result<u32, String>;
    fn release(&self, id: u32) -> Result<(), String>;
}

/// The heavy-run slot as one round of the watcher saw it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum HeavySeen {
    /// Something heavy is live: the helper's holder or queue, or a run outside the helper.
    Live(String),
    Idle,
    /// The bridge did not answer, and nothing was observed outside the helper.
    Unknown,
}

/// The heavy-run slot from one round: the bridge's `/heavy` answer (or none) and the runs the
/// process table showed outside the helper. A holder whose helper went quiet still holds the
/// slot — its process group may be running — so it counts until the bridge lets it go.
pub(crate) fn heavy_seen(status: Option<&serde_json::Value>, observed: &[String]) -> HeavySeen {
    if let Some(what) = observed.first() {
        return HeavySeen::Live(what.clone());
    }
    let Some(status) = status else {
        return HeavySeen::Unknown;
    };
    let what = |entry: &serde_json::Value| entry.get("what").and_then(serde_json::Value::as_str).unwrap_or("a heavy run").to_string();
    if let Some(holder) = status.get("holder").filter(|holder| holder.is_object()) {
        return HeavySeen::Live(what(holder));
    }
    match status.get("queue").and_then(serde_json::Value::as_array).and_then(|queue| queue.first()) {
        Some(first) => HeavySeen::Live(what(first)),
        None => HeavySeen::Idle,
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Inputs {
    enabled: bool,
    working: bool,
    /// The room codes followed on Discord.
    discord: Vec<String>,
    heavy: Option<String>,
    /// Since when the bridge could not be asked, while it cannot.
    heavy_unknown_since: Option<Instant>,
    /// The webview's last call applied, as (page, call). Pages are numbered here, one per load,
    /// so a page loaded since ranks above every call of the one before it, whatever the clock.
    ui_seq: (u64, u64),
    pages: u64,
}

/// What the inputs ask to be held, and the reason the Settings row gives for it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Wanted {
    display: bool,
    system: bool,
    why: Option<String>,
}

fn wanted(inputs: &Inputs) -> Wanted {
    if !inputs.enabled {
        return Wanted { display: false, system: false, why: None };
    }
    let display = inputs.working;
    let room = inputs.discord.first();
    // While an agent works the display assertion holds the system awake too; no second is taken.
    let system = !display && (room.is_some() || inputs.heavy.is_some());
    let why = if display {
        Some("agent working — display won't sleep".to_string())
    } else if let Some(room) = room {
        let more = inputs.discord.len() - 1;
        let rooms = if more == 0 { room.clone() } else { format!("{room} and {more} more") };
        Some(format!("{rooms} connected to Discord — the Mac won't idle-sleep"))
    } else {
        inputs.heavy.as_ref().map(|what| format!("heavy run: {what} — the Mac won't idle-sleep"))
    };
    Wanted { display, system, why }
}

/// What is held now, as the Settings row shows it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Held {
    pub display: bool,
    pub system: bool,
    /// Said only for what is actually held.
    pub why: Option<String>,
    pub error: Option<String>,
    /// Goes up with every change, so a reader keeps the newest of a snapshot and an event.
    pub rev: u64,
}

struct Inner {
    inputs: Inputs,
    display: Option<u32>,
    system: Option<u32>,
    error: Option<String>,
    last: Option<Held>,
    rev: u64,
}

pub struct KeepAwakeState {
    inner: Mutex<Inner>,
    power: Box<dyn Power>,
}

impl Default for KeepAwakeState {
    fn default() -> Self {
        Self::with(Box::new(platform::Native))
    }
}

impl KeepAwakeState {
    pub(crate) fn with(power: Box<dyn Power>) -> Self {
        Self {
            inner: Mutex::new(Inner { inputs: Inputs::default(), display: None, system: None, error: None, last: None, rev: 0 }),
            power,
        }
    }

    /// The webview's two inputs. Answers with what is held after them, a refusal included, so
    /// the answer to every call is as true as an event.
    /// A page loaded: its number, above every page before it. Their calls change nothing after.
    pub(crate) fn new_page(&self) -> Result<u64, String> {
        let mut page = 0;
        self.update(|inputs| {
            inputs.pages += 1;
            page = inputs.pages;
            inputs.ui_seq = (page, 0);
        })?;
        Ok(page)
    }

    pub(crate) fn set_active(&self, enabled: bool, working: bool, seq: (u64, u64)) -> Result<Held, String> {
        self.update(|inputs| {
            if seq < inputs.ui_seq {
                return;
            }
            inputs.ui_seq = seq;
            inputs.enabled = enabled;
            inputs.working = working;
        })
    }

    pub(crate) fn set_discord_rooms(&self, rooms: Vec<String>) {
        let _ = self.update(|inputs| inputs.discord = rooms);
    }

    pub(crate) fn set_heavy(&self, seen: HeavySeen, now: Instant) {
        let _ = self.update(|inputs| match seen {
            HeavySeen::Live(what) => {
                inputs.heavy = Some(what);
                inputs.heavy_unknown_since = None;
            }
            HeavySeen::Idle => {
                inputs.heavy = None;
                inputs.heavy_unknown_since = None;
            }
            HeavySeen::Unknown => {
                let since = *inputs.heavy_unknown_since.get_or_insert(now);
                if now.duration_since(since) >= HEAVY_UNKNOWN_GRACE {
                    inputs.heavy = None;
                }
            }
        });
    }

    /// Let go of everything: the app is quitting.
    pub fn release_all(&self) {
        let _ = self.update(|inputs| *inputs = Inputs { ui_seq: inputs.ui_seq, pages: inputs.pages, ..Inputs::default() });
    }

    pub(crate) fn held(&self) -> Held {
        match self.inner.lock() {
            Ok(inner) => Held { rev: inner.rev, ..held_of(&inner) },
            Err(_) => Held { display: false, system: false, why: None, error: Some("Keep-awake state lock failed".to_string()), rev: 0 },
        }
    }

    fn update(&self, change: impl FnOnce(&mut Inputs)) -> Result<Held, String> {
        let held = {
            let mut inner = self.inner.lock().map_err(|_| "Keep-awake state lock failed".to_string())?;
            change(&mut inner.inputs);
            let want = wanted(&inner.inputs);
            let mut errors = Vec::new();
            // The one wanted is taken before the other is let go, and the other is kept while it
            // cannot be: a hand-over never leaves nothing held while something still asks.
            let kinds = if want.display { [Kind::Display, Kind::System] } else { [Kind::System, Kind::Display] };
            for kind in kinds {
                let (slot, on) = match kind {
                    Kind::Display => (&mut inner.display, want.display),
                    Kind::System => (&mut inner.system, want.system),
                };
                let still_asked = want.display || want.system;
                if !on && slot.is_some() && !errors.is_empty() && still_asked {
                    continue;
                }
                if let Err(error) = self.settle(slot, kind, on) {
                    errors.push(error);
                }
            }
            inner.error = (!errors.is_empty()).then(|| errors.join("; "));
            let mut held = held_of(&inner);
            let changed = inner.last.as_ref().is_none_or(|last| Held { rev: 0, ..last.clone() } != held);
            inner.rev += u64::from(changed);
            held.rev = inner.rev;
            inner.last = Some(held.clone());
            held
        };
        Ok(held)
    }

    /// Acquire or release one assertion, only on a transition. A failed acquire is tried again
    /// by the next input; a failed release keeps the id, so it is not leaked.
    fn settle(&self, slot: &mut Option<u32>, kind: Kind, on: bool) -> Result<(), String> {
        match (*slot, on) {
            (None, true) => *slot = Some(self.power.acquire(kind)?),
            (Some(id), false) => {
                self.power.release(id)?;
                *slot = None;
            }
            _ => {}
        }
        Ok(())
    }
}

fn held_of(inner: &Inner) -> Held {
    let display = inner.display.is_some();
    let system = inner.system.is_some();
    let want = wanted(&inner.inputs);
    let why = want.why.filter(|_| (want.display && display) || (want.system && system));
    Held { display, system, why, error: inner.error.clone(), rev: 0 }
}

impl Drop for KeepAwakeState {
    fn drop(&mut self) {
        let Ok(inner) = self.inner.get_mut() else {
            return;
        };
        for id in [inner.display.take(), inner.system.take()].into_iter().flatten() {
            let _ = self.power.release(id);
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Kind;
    use core_foundation::{base::TCFType, string::CFString};

    type IOPMAssertionID = u32;
    type IOPMAssertionLevel = u32;
    type IOReturn = i32;

    const ASSERTION_LEVEL_ON: IOPMAssertionLevel = 255;
    const IO_RETURN_SUCCESS: IOReturn = 0;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: core_foundation::string::CFStringRef,
            assertion_level: IOPMAssertionLevel,
            assertion_name: core_foundation::string::CFStringRef,
            assertion_id: *mut IOPMAssertionID,
        ) -> IOReturn;
        fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> IOReturn;
    }

    pub struct Native;

    impl super::Power for Native {
        fn acquire(&self, kind: Kind) -> Result<IOPMAssertionID, String> {
            let (assertion_type, name) = match kind {
                Kind::Display => ("PreventUserIdleDisplaySleep", "Gyredeck is working"),
                Kind::System => ("PreventUserIdleSystemSleep", "Gyredeck is keeping a Discord room or a heavy run alive"),
            };
            let assertion_type = CFString::new(assertion_type);
            let assertion_name = CFString::new(name);
            let mut assertion_id = 0;
            let result = unsafe {
                IOPMAssertionCreateWithName(
                    assertion_type.as_concrete_TypeRef(),
                    ASSERTION_LEVEL_ON,
                    assertion_name.as_concrete_TypeRef(),
                    &mut assertion_id,
                )
            };
            if result == IO_RETURN_SUCCESS {
                Ok(assertion_id)
            } else {
                Err(format!("Failed to acquire keep-awake assertion ({result})"))
            }
        }

        fn release(&self, assertion_id: IOPMAssertionID) -> Result<(), String> {
            let result = unsafe { IOPMAssertionRelease(assertion_id) };
            if result == IO_RETURN_SUCCESS {
                Ok(())
            } else {
                Err(format!("Failed to release keep-awake assertion ({result})"))
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::Kind;

    pub struct Native;

    impl super::Power for Native {
        fn acquire(&self, _kind: Kind) -> Result<u32, String> {
            Err("Keep awake is available only on macOS".to_string())
        }

        fn release(&self, _assertion_id: u32) -> Result<(), String> {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests;
