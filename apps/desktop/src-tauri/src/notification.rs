use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotificationPermissionState {
    NotDetermined,
    Denied,
    Authorized,
    Provisional,
    Ephemeral,
    Unsupported,
}

#[cfg(target_os = "macos")]
mod platform {
    use std::{ptr::NonNull, sync::mpsc, time::Duration};

    use block2::{DynBlock, RcBlock};
    use objc2::{
        define_class, extern_methods, rc::Retained, runtime::NSObject, runtime::ProtocolObject,
    };
    use objc2_foundation::{NSError, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent,
        UNNotification, UNNotificationPresentationOptions, UNNotificationRequest,
        UNNotificationSettings, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };

    use super::NotificationPermissionState;

    const CALLBACK_TIMEOUT: Duration = Duration::from_secs(10);
    const PERMISSION_CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);

    /// UserNotifications requires a real app bundle (a bundle identifier). Running the
    /// unbundled `target/debug` binary via `tauri dev` has no main bundle, so any
    /// `UNUserNotificationCenter` call throws an NSException. Treat that case as
    /// "notifications unavailable" instead of crashing the whole app.
    fn is_bundled() -> bool {
        std::env::current_exe()
            .ok()
            .and_then(|path| path.to_str().map(|s| s.contains(".app/Contents/MacOS/")))
            .unwrap_or(false)
    }

    define_class!(
        #[unsafe(super(NSObject))]
        struct NotificationCenterDelegate;

        unsafe impl NSObjectProtocol for NotificationCenterDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for NotificationCenterDelegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present_notification(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                // Banner and List, not the deprecated Alert. This delegate decides what
                // happens to a notification posted *while the app is running*, which for
                // a menu-bar app is every notification it will ever send — and asking
                // for an option macOS stopped honouring in 11 means the notification is
                // delivered and then presented as nothing at all. Silent, with no error
                // anywhere: the post succeeds, the banner never appears.
                completion_handler.call((
                    UNNotificationPresentationOptions::Banner
                        | UNNotificationPresentationOptions::List,
                ));
            }
        }
    );

    impl NotificationCenterDelegate {
        extern_methods!(
            #[unsafe(method(new))]
            fn new() -> Retained<Self>;
        );
    }

    thread_local! {
        static NOTIFICATION_DELEGATE: Retained<NotificationCenterDelegate> = NotificationCenterDelegate::new();
    }

    pub fn initialize() {
        if !is_bundled() {
            return;
        }
        NOTIFICATION_DELEGATE.with(|delegate| {
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let delegate = ProtocolObject::from_ref(&**delegate);
            center.setDelegate(Some(delegate));
        });
    }

    pub fn permission_state() -> Result<NotificationPermissionState, String> {
        if !is_bundled() {
            return Ok(NotificationPermissionState::Unsupported);
        }
        let settings = notification_settings()?;
        Ok(permission_state_from_status(settings.authorizationStatus()))
    }

    pub fn request_permission() -> Result<NotificationPermissionState, String> {
        if !is_bundled() {
            return Err("Notifications require the installed app bundle (unavailable in dev)".to_string());
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (sender, receiver) = mpsc::channel();
        let completion = RcBlock::new(move |_granted, error: *mut NSError| {
            let result = if error.is_null() {
                Ok(())
            } else {
                Err(ns_error_message(error))
            };
            let _ = sender.send(result);
        });

        // Alert here is the authorisation option, not the presentation one, and is not
        // deprecated — it is what grants the right to show anything at all.
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &completion,
        );
        let refusal = receiver
            .recv_timeout(PERMISSION_CALLBACK_TIMEOUT)
            .map_err(|_| "Timed out while waiting for macOS notification permission".to_string())?
            .err();

        // Settled by what the system now holds, not by whether asking succeeded. macOS
        // refuses the request outright once an app has been turned off — the error says
        // "not allowed", which reads like a broken app and sent a whole morning into
        // chasing code signatures. The status says `denied`, which is the truth and the
        // one state the panel knows how to explain.
        let state = permission_state()?;
        match state {
            NotificationPermissionState::NotDetermined => match refusal {
                // Asking failed and left no trace: nothing was learnt, so say so rather
                // than reporting a state that was never reached.
                Some(message) => Err(message),
                None => Ok(state),
            },
            settled => Ok(settled),
        }
    }

    /// Post one notification, replacing any earlier one carrying the same identifier.
    ///
    /// Replacing rather than stacking is the whole reason the caller supplies an id. A
    /// session that asks twice in ten seconds should occupy one slot in Notification
    /// Centre, not two: the second question is the one worth answering, and a column of
    /// near-identical banners is how a useful notification becomes one people switch off.
    ///
    /// The identifier carries which session it belongs to, so it does double duty —
    /// replacement now, and a route back to that session when acting on a banner is
    /// wired up. `userInfo` would be the conventional place, but its dictionary wants
    /// key and value types that do not line up with what the bindings accept here, and
    /// a second field holding the same fact is a second field to keep in step.
    pub fn deliver(identifier: &str, title: &str, body: &str) -> Result<(), String> {
        if !is_bundled() {
            return Err("Notifications require the installed app bundle (unavailable in dev)".to_string());
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        // No trigger: `None` means deliver immediately.
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(identifier),
            &content,
            None,
        );
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (sender, receiver) = mpsc::channel();
        let completion = RcBlock::new(move |error: *mut NSError| {
            let _ = sender.send(if error.is_null() { Ok(()) } else { Err(ns_error_message(error)) });
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
        receiver
            .recv_timeout(CALLBACK_TIMEOUT)
            .map_err(|_| "Timed out while posting a macOS notification".to_string())?
    }

    fn notification_settings() -> Result<Retained<UNNotificationSettings>, String> {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (sender, receiver) = mpsc::channel();
        let completion = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // SAFETY: UserNotifications supplies a valid settings object for the duration of the
            // callback. Retaining it gives the receiving command independent ownership.
            let settings = unsafe { Retained::retain(settings.as_ptr()) }
                .expect("a non-null UserNotifications settings pointer must retain");
            let _ = sender.send(settings);
        });
        center.getNotificationSettingsWithCompletionHandler(&completion);
        receiver
            .recv_timeout(CALLBACK_TIMEOUT)
            .map_err(|_| "Timed out while reading macOS notification settings".to_string())
    }

    /// Open the pane that holds the one switch a refused app cannot flip for itself.
    ///
    /// Once macOS has recorded a refusal it stops presenting the prompt, so the only
    /// route back is this list. Offering the trip is the difference between a dead end
    /// and a two-click fix.
    pub fn open_settings() -> Result<(), String> {
        std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
            .status()
            .map_err(|error| format!("Could not open System Settings: {error}"))
            .and_then(|status| {
                if status.success() {
                    Ok(())
                } else {
                    Err("System Settings refused to open".to_string())
                }
            })
    }

    fn permission_state_from_status(status: UNAuthorizationStatus) -> NotificationPermissionState {
        if status == UNAuthorizationStatus::NotDetermined {
            NotificationPermissionState::NotDetermined
        } else if status == UNAuthorizationStatus::Denied {
            NotificationPermissionState::Denied
        } else if status == UNAuthorizationStatus::Authorized {
            NotificationPermissionState::Authorized
        } else if status == UNAuthorizationStatus::Provisional {
            NotificationPermissionState::Provisional
        } else if status == UNAuthorizationStatus::Ephemeral {
            NotificationPermissionState::Ephemeral
        } else {
            NotificationPermissionState::Unsupported
        }
    }

    fn ns_error_message(error: *mut NSError) -> String {
        // SAFETY: Apple passes either null or a valid NSError for the duration of the callback.
        unsafe { &*error }.localizedDescription().to_string()
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::NotificationPermissionState;

    pub fn initialize() {}

    pub fn permission_state() -> Result<NotificationPermissionState, String> {
        Ok(NotificationPermissionState::Unsupported)
    }

    pub fn request_permission() -> Result<NotificationPermissionState, String> {
        Err("Native macOS notifications are unavailable on this platform".to_string())
    }

    pub fn deliver(_identifier: &str, _title: &str, _body: &str) -> Result<(), String> {
        Err("Native macOS notifications are unavailable on this platform".to_string())
    }

    pub fn open_settings() -> Result<(), String> {
        Err("Native macOS notifications are unavailable on this platform".to_string())
    }
}

pub fn initialize() {
    platform::initialize();
}

async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Native notification task failed: {error}"))?
}

#[tauri::command]
pub async fn notification_permission_state() -> Result<NotificationPermissionState, String> {
    run_blocking(platform::permission_state).await
}

#[tauri::command]
pub async fn request_notification_permission() -> Result<NotificationPermissionState, String> {
    run_blocking(platform::request_permission).await
}

/// Post a notification the renderer has decided is worth interrupting for.
///
/// The decision stays in the renderer because that is where the event stream already
/// arrives — the window is hidden rather than destroyed when it is closed, so the
/// webview keeps running and keeps its subscription. Reaching for the events a second
/// time here would mean the same rule implemented in two places, which is how the room
/// routing drifted apart twice in one day.
#[tauri::command]
pub async fn open_notification_settings() -> Result<(), String> {
    run_blocking(platform::open_settings).await
}

#[tauri::command]
pub async fn deliver_notification(
    identifier: String,
    title: String,
    body: String,
) -> Result<(), String> {
    run_blocking(move || platform::deliver(&identifier, &title, &body)).await
}

