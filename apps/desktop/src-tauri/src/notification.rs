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
    use objc2_foundation::{NSError, NSObjectProtocol};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNNotification,
        UNNotificationPresentationOptions, UNNotificationSettings, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
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
                #[allow(deprecated)]
                completion_handler.call((UNNotificationPresentationOptions::Alert,));
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

        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert,
            &completion,
        );
        receiver
            .recv_timeout(PERMISSION_CALLBACK_TIMEOUT)
            .map_err(|_| {
                "Timed out while waiting for macOS notification permission".to_string()
            })??;

        permission_state()
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

