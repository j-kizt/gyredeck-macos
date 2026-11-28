//! The Mac's sleep and wake, for the Discord posts that say so (#318).
//!
//! A thin adapter: `IORegisterForSystemPower` on a thread of its own with its own run loop,
//! each message mapped by [`on_message`] to what to do. Whether a notice is said once per sleep
//! is the Discord hub's to decide, not this file's.

use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Event {
    WillSleep,
    Woke,
}

pub(crate) type Handler = Arc<dyn Fn(Event) + Send + Sync>;

pub(crate) const CAN_SYSTEM_SLEEP: u32 = 0xE000_0270;
pub(crate) const SYSTEM_WILL_SLEEP: u32 = 0xE000_0280;
pub(crate) const SYSTEM_HAS_POWERED_ON: u32 = 0xE000_0300;

/// One power message: a sleep is told before it is allowed, never after, and a query that may
/// still be cancelled is allowed without telling anyone.
pub(crate) fn on_message(message: u32, mut tell: impl FnMut(Event), mut allow: impl FnMut()) {
    match message {
        CAN_SYSTEM_SLEEP => allow(),
        SYSTEM_WILL_SLEEP => {
            tell(Event::WillSleep);
            allow();
        }
        SYSTEM_HAS_POWERED_ON => tell(Event::Woke),
        _ => {}
    }
}

pub(crate) fn start(handler: Handler) -> Result<(), String> {
    platform::start(handler)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{on_message, Handler};
    use core_foundation::base::TCFType;
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop, CFRunLoopSource, CFRunLoopSourceRef};
    use std::ffi::c_void;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{mpsc, OnceLock};

    type IoConnect = u32;
    type IoObject = u32;
    type NotificationPort = *mut c_void;
    type Callback = extern "C" fn(refcon: *mut c_void, service: IoObject, message: u32, argument: *mut c_void);

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IORegisterForSystemPower(refcon: *mut c_void, port: *mut NotificationPort, callback: Callback, notifier: *mut IoObject) -> IoConnect;
        fn IONotificationPortGetRunLoopSource(port: NotificationPort) -> CFRunLoopSourceRef;
        fn IOAllowPowerChange(kernel_port: IoConnect, notification_id: isize) -> i32;
    }

    static ROOT: AtomicU32 = AtomicU32::new(0);
    static HANDLER: OnceLock<Handler> = OnceLock::new();

    extern "C" fn on_power(_refcon: *mut c_void, _service: IoObject, message: u32, argument: *mut c_void) {
        // A panic must not unwind into IOKit, and the sleep is allowed whatever happened.
        let told = catch_unwind(AssertUnwindSafe(|| {
            on_message(message, |event| HANDLER.get().into_iter().for_each(|handler| handler(event)), || allow(argument));
        }));
        if told.is_err() && message == super::SYSTEM_WILL_SLEEP {
            allow(argument);
        }
    }

    fn allow(argument: *mut c_void) {
        unsafe {
            IOAllowPowerChange(ROOT.load(Ordering::SeqCst), argument as isize);
        }
    }

    pub(super) fn start(handler: Handler) -> Result<(), String> {
        if HANDLER.set(handler).is_err() {
            return Err("The sleep and wake listener is already running".to_string());
        }
        let (ready_tx, ready_rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("gyredeck-sleep-wake".to_string())
            .spawn(move || {
                let mut port: NotificationPort = std::ptr::null_mut();
                let mut notifier: IoObject = 0;
                let root = unsafe { IORegisterForSystemPower(std::ptr::null_mut(), &mut port, on_power, &mut notifier) };
                if root == 0 || port.is_null() {
                    let _ = ready_tx.send(Err("IORegisterForSystemPower refused".to_string()));
                    return;
                }
                ROOT.store(root, Ordering::SeqCst);
                let source = unsafe { CFRunLoopSource::wrap_under_get_rule(IONotificationPortGetRunLoopSource(port)) };
                CFRunLoop::get_current().add_source(&source, unsafe { kCFRunLoopCommonModes });
                let _ = ready_tx.send(Ok(()));
                CFRunLoop::run_current();
            })
            .map_err(|error| format!("The sleep and wake listener could not start: {error}"))?;
        ready_rx.recv().map_err(|_| "The sleep and wake listener stopped".to_string())?
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::Handler;

    pub(super) fn start(_handler: Handler) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(message: u32) -> Vec<&'static str> {
        let steps = std::cell::RefCell::new(Vec::new());
        on_message(
            message,
            |event| steps.borrow_mut().push(if event == Event::WillSleep { "sleep" } else { "woke" }),
            || steps.borrow_mut().push("allow"),
        );
        steps.into_inner()
    }

    #[test]
    fn a_sleep_is_told_before_it_is_allowed_and_a_query_tells_no_one() {
        assert_eq!(run(SYSTEM_WILL_SLEEP), ["sleep", "allow"]);
        assert_eq!(run(CAN_SYSTEM_SLEEP), ["allow"]);
        assert_eq!(run(SYSTEM_HAS_POWERED_ON), ["woke"]);
        assert!(run(0xE000_0290).is_empty(), "a sleep that will not happen says nothing");
    }
}
