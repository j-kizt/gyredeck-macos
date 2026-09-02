use std::{
    collections::{BTreeMap, HashMap, HashSet},
    error::Error as StdError,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine as _,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

mod github;
mod keep_awake;
mod local_services;
mod notification;
mod standalone_bridge;

use github::{
    device_poll, device_start, get_sync_identity, github_accounts, github_available_repos,
    github_credential_helper_disable, github_credential_helper_enable,
    github_credential_helper_status, github_import_from_gh, github_remove_account,
    github_repo_status, github_switch_account, import_from_glab, set_sync_identity,
};

use keep_awake::KeepAwakeState;
use local_services::{control_local_service, local_services, LocalServicesControlState};
use notification::{notification_permission_state, request_notification_permission};
use standalone_bridge::StandaloneBridgeState;

#[cfg(target_os = "macos")]
use objc2::{msg_send, rc::Retained, MainThreadMarker};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSScreen, NSWindow};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSArray, NSPoint, NSRect, NSSize, NSString};
#[cfg(target_os = "macos")]
use security_framework::passwords::set_generic_password;

const TRAY_ID: &str = "gyredeck";
const TRAY_SHOW: &str = "show";
const TRAY_HIDE: &str = "hide";
const TRAY_QUIT: &str = "quit";
const DISPLAY_PREFERENCE_FILE: &str = "display-preference.json";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CODEX_REFRESH_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_KEYCHAIN_SERVICE: &str = "Codex Auth";
const CODEX_CREDIT_USD_RATE: f64 = 0.04;
const CCUSAGE_PACKAGE: &str = "ccusage@20.0.18";
const CCUSAGE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const CCUSAGE_TIMEOUT: Duration = Duration::from_secs(15);
const OPENUSAGE_PROXY_CONFIG_PATH: &str = ".openusage/config.json";
const AGY_LS_SERVICE: &str = "exa.language_server_pb.LanguageServerService";
const AGY_KEYCHAIN_SERVICE: &str = "gemini";
const AGY_KEYCHAIN_ACCOUNT: &str = "antigravity";
const AGY_CLOUD_CODE_BASE_URLS: [&str; 2] = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
];
const AGY_CLOUD_QUOTA_SUMMARY_PATH: &str = "/v1internal:retrieveUserQuotaSummary";
const AGY_CLOUD_LOAD_CODE_ASSIST_PATH: &str = "/v1internal:loadCodeAssist";
const AGY_GOOGLE_OAUTH_URL: &str = "https://oauth2.googleapis.com/token";
const AGY_GOOGLE_CLIENT_ID_ENV: &str = "GYREDECK_AGY_GOOGLE_CLIENT_ID";
const AGY_GOOGLE_CLIENT_SECRET_ENV: &str = "GYREDECK_AGY_GOOGLE_CLIENT_SECRET";
const AGY_GOOGLE_OAUTH_CONFIG_PATH: &str = ".config/gyredeck/agy-google-oauth.json";
const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_REFRESH_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_NON_PROD_CLIENT_ID: &str = "22422756-60c9-4084-8eb7-27705fd5cf9a";
const CLAUDE_SCOPES: &str =
    "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CLAUDE_KEYCHAIN_SERVICE_PREFIX: &str = "Claude Code";
const CLAUDE_DEFAULT_HOME: &str = ".claude";
const CLAUDE_CREDENTIALS_FILE: &str = ".credentials.json";
const CLAUDE_REFRESH_BUFFER_MS: i64 = 5 * 60 * 1000;
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisplayPreference {
    id: String,
    fingerprint: String,
    #[serde(default)]
    name: String,
}

#[derive(Default)]
pub(crate) struct DisplayPreferenceState {
    selection: Mutex<Option<DisplayPreference>>,
}

impl DisplayPreferenceState {
    pub(crate) fn get(&self) -> Option<DisplayPreference> {
        self.selection
            .lock()
            .ok()
            .and_then(|selection| selection.clone())
    }

    fn set(&self, selection: Option<DisplayPreference>) {
        if let Ok(mut current) = self.selection.lock() {
            *current = selection;
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisplayOption {
    pub(crate) id: String,
    pub(crate) fingerprint: String,
    pub(crate) name: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) scale_factor: f64,
    pub(crate) is_primary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DisplayStateSnapshot {
    displays: Vec<DisplayOption>,
    preferred_display_id: Option<String>,
    preferred_display_name: Option<String>,
    selected_display_id: Option<String>,
    active_display_id: Option<String>,
    fallback_active: bool,
}

#[cfg(any(test, not(target_os = "macos")))]
fn preferred_display_index(
    displays: &[DisplayOption],
    preference: Option<&DisplayPreference>,
) -> Option<usize> {
    let preference = preference?;
    displays
        .iter()
        .position(|display| display.id == preference.id)
        .or_else(|| {
            displays
                .iter()
                .position(|display| display.fingerprint == preference.fingerprint)
        })
}
#[derive(Debug, Clone, Deserialize, Serialize)]
struct CodexAuthFile {
    #[serde(rename = "OPENAI_API_KEY")]
    openai_api_key: Option<String>,
    tokens: Option<CodexAuthTokens>,
    last_refresh: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CodexAuthTokens {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    account_id: Option<String>,
}

#[derive(Debug, Clone)]
enum CodexAuthSource {
    File(PathBuf),
    Keychain(String),
}

#[derive(Debug, Clone)]
struct CodexAuthState {
    auth: CodexAuthFile,
    source: CodexAuthSource,
}

#[derive(Debug, Deserialize)]
struct OpenUsageProxyConfigFile {
    proxy: Option<OpenUsageProxyConfig>,
}

#[derive(Debug, Deserialize)]
struct OpenUsageProxyConfig {
    enabled: Option<bool>,
    url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexUsageSnapshot {
    provider_id: String,
    display_name: String,
    plan: Option<String>,
    lines: Vec<CodexMetricLine>,
    fetched_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum CodexMetricLine {
    #[serde(rename_all = "camelCase")]
    Progress {
        label: String,
        used: f64,
        limit: f64,
        format: CodexProgressFormat,
        resets_at: Option<String>,
        period_duration_ms: Option<u64>,
    },
    Text {
        label: String,
        value: String,
    },
    #[serde(rename_all = "camelCase")]
    BarChart {
        label: String,
        points: Vec<CodexBarChartPoint>,
        note: Option<String>,
        color: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexBarChartPoint {
    label: String,
    value: f64,
    value_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum CodexProgressFormat {
    Percent,
}

#[derive(Debug, Deserialize)]
struct CodexUsageEnvelope {
    plan_type: Option<String>,
    rate_limit: Option<CodexRateLimit>,
    additional_rate_limits: Option<Vec<CodexAdditionalRateLimit>>,
    code_review_rate_limit: Option<CodexReviewRateLimit>,
    credits: Option<CodexCredits>,
    rate_limit_reset_credits: Option<CodexResetCredits>,
}

#[derive(Debug, Deserialize)]
struct CodexAdditionalRateLimit {
    limit_name: Option<String>,
    metered_feature: Option<String>,
    rate_limit: Option<CodexRateLimit>,
}

#[derive(Debug, Deserialize)]
struct CodexRateLimit {
    primary_window: Option<CodexRateLimitWindow>,
    secondary_window: Option<CodexRateLimitWindow>,
}

#[derive(Debug, Deserialize)]
struct CodexReviewRateLimit {
    primary_window: Option<CodexRateLimitWindow>,
}

#[derive(Debug, Deserialize)]
struct CodexRateLimitWindow {
    used_percent: Option<Value>,
    reset_at: Option<Value>,
    reset_after_seconds: Option<Value>,
    limit_window_seconds: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexWindowKind {
    Session,
    Weekly,
}

#[derive(Debug, Clone, Copy)]
struct CodexWindowCandidate<'a> {
    window: Option<&'a CodexRateLimitWindow>,
    header_percent: Option<f64>,
    fallback_kind: CodexWindowKind,
}

#[derive(Debug, Deserialize)]
struct CodexCredits {
    balance: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct CodexResetCredits {
    available_count: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct CodexResetCreditsEnvelope {
    available_count: Option<Value>,
    credits: Option<Vec<CodexResetCredit>>,
}

#[derive(Debug, Deserialize)]
struct CodexResetCredit {
    status: Option<String>,
    expires_at: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct CcusageDailyUsage {
    daily: Vec<CcusageDay>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CcusageDay {
    date: String,
    total_tokens: Option<Value>,
    cost_usd: Option<Value>,
    total_cost: Option<Value>,
    models: Option<BTreeMap<String, CcusageModelUsage>>,
    model_breakdowns: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CcusageModelUsage {
    total_tokens: Option<Value>,
    input_tokens: Option<Value>,
    cached_input_tokens: Option<Value>,
    cache_creation_tokens: Option<Value>,
    cache_read_tokens: Option<Value>,
    output_tokens: Option<Value>,
    reasoning_output_tokens: Option<Value>,
}

#[derive(Debug, Clone)]
struct CcusageCacheEntry {
    key: String,
    fetched_at: Instant,
    usage: CcusageDailyUsage,
}

static CLAUDE_LAST_GOOD_USAGE: OnceLock<Mutex<HashMap<String, CodexUsageSnapshot>>> =
    OnceLock::new();

static CODEX_CCUSAGE_CACHE: OnceLock<Mutex<Option<CcusageCacheEntry>>> = OnceLock::new();
static CODEX_CCUSAGE_IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Debug, Deserialize)]
struct CodexRefreshResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ClaudeCredentialsFile {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: Option<ClaudeOauth>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ClaudeOauth {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
    #[serde(rename = "refreshToken")]
    refresh_token: Option<String>,
    #[serde(rename = "expiresAt")]
    expires_at: Option<i64>,
    #[serde(rename = "subscriptionType")]
    subscription_type: Option<String>,
    #[serde(rename = "rateLimitTier")]
    rate_limit_tier: Option<String>,
    scopes: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
struct ClaudeAuthState {
    credentials: ClaudeCredentialsFile,
    service_name: Option<String>,
    file_path: Option<PathBuf>,
    inference_only: bool,
    oauth_config: ClaudeOauthConfig,
}

#[derive(Debug, Clone)]
struct ClaudeOauthConfig {
    usage_url: String,
    refresh_url: String,
    client_id: String,
    oauth_file_suffix: String,
}

#[derive(Debug, Deserialize)]
struct OAuthRefreshResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

fn claude_hook_install_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".config")
        .join("gyredeck")
        .join("gyredeck-claude-hook.mjs"))
}

fn claude_settings_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".claude").join("settings.json"))
}

fn agy_hook_install_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".config")
        .join("gyredeck")
        .join("gyredeck-agy-hook.mjs"))
}

fn agy_hooks_json_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".gemini")
        .join("config")
        .join("hooks.json"))
}


fn codex_hook_install_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".config")
        .join("gyredeck")
        .join("gyredeck-codex-hook.mjs"))
}

fn codex_hooks_json_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".codex").join("hooks.json"))
}

/// Codex's matcher is a regex over the tool name.
const CODEX_HOOK_MATCHED_EVENTS: [&str; 3] = ["PreToolUse", "PostToolUse", "PermissionRequest"];
const CODEX_HOOK_PLAIN_EVENTS: [&str; 7] = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "Stop",
    // Not in the published hook list; found on Codex's own /hooks screen. Without it a
    // turn the user aborts leaves the session showing as working until it goes stale.
    "Interrupt",
    "PreCompact",
    "PostCompact",
];

const CLAUDE_HOOK_MATCHED_EVENTS: [&str; 2] = ["PreToolUse", "PostToolUse"];
const CLAUDE_HOOK_PLAIN_EVENTS: [&str; 7] = [
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "SubagentStop",
    "SessionStart",
    "SessionEnd",
    "PreCompact",
];


/// The command an agent runs for a hook.
///
/// Node is resolved to an absolute path at install time rather than left as bare
/// `node`. Agents are not always launched from a shell: from the Dock or Spotlight the
/// process inherits launchd's PATH, which is /usr/bin:/bin:/usr/sbin:/sbin and holds no
/// node on a machine that installed it through nvm or Homebrew. The hook would then
/// fail to spawn, and because hooks report failures nowhere visible, presence would
/// simply stop with no error anywhere.
///
/// Falls back to bare `node` only when the binary cannot be found at all, which at
/// least works for agents started from a shell that has it.
fn node_hook_command(installed_path: &str, event: &str) -> String {
    let node = standalone_bridge::find_node_binary()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "node".to_string());
    format!("{node} {installed_path} --event {event}")
}

fn hook_entry_present(
    hooks: &serde_json::Map<String, serde_json::Value>,
    event: &str,
    command: &str,
) -> bool {
    hooks
        .get(event)
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries.iter().any(|entry| {
                entry
                    .get("hooks")
                    .and_then(serde_json::Value::as_array)
                    .map(|inner| {
                        inner.iter().any(|hook| {
                            hook.get("command").and_then(serde_json::Value::as_str) == Some(command)
                        })
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Remove any hook entries whose command contains `needle` (e.g. an old brand's
/// adapter path), pruning emptied matcher groups and events. Used to clean up a
/// prior install so it can't fire alongside the current one.
fn prune_hook_entries(hooks: &mut serde_json::Map<String, serde_json::Value>, needle: &str) {
    let events: Vec<String> = hooks.keys().cloned().collect();
    for event in events {
        let Some(groups) = hooks.get_mut(&event).and_then(serde_json::Value::as_array_mut) else {
            continue;
        };
        groups.retain_mut(|group| {
            let Some(list) = group.get_mut("hooks").and_then(serde_json::Value::as_array_mut) else {
                return true;
            };
            list.retain(|hook| {
                hook.get("command")
                    .and_then(serde_json::Value::as_str)
                    .map(|command| !command.contains(needle))
                    .unwrap_or(true)
            });
            !list.is_empty()
        });
        if groups.is_empty() {
            hooks.remove(&event);
        }
    }
}

#[tauri::command]
fn bridge_health() -> bool {
    standalone_bridge::bridge_health()
}

/// Mail rooms and how much is waiting in each, so a session card can show that a
/// message arrived without the webview holding the ingest token.
#[tauri::command]
fn mail_rooms() -> Result<Vec<standalone_bridge::MailRoom>, String> {
    standalone_bridge::mail_rooms()
}

#[tauri::command]
fn get_bridge_port() -> u16 {
    standalone_bridge::configured_bridge_port()
}

#[tauri::command]
fn set_bridge_port(
    state: tauri::State<'_, StandaloneBridgeState>,
    port: u16,
) -> Result<(), String> {
    if port < 1024 {
        return Err("Port must be between 1024 and 65535".to_string());
    }
    if !standalone_bridge::port_available_for_bridge(port) {
        return Err(format!("Port {port} is already in use by another process"));
    }
    standalone_bridge::write_configured_port(port)?;
    state.restart()
}

#[tauri::command]
fn set_keep_awake(state: tauri::State<'_, KeepAwakeState>, active: bool) -> Result<bool, String> {
    state.set_active(active)
}

#[tauri::command]
async fn codex_usage() -> Result<CodexUsageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(codex_usage_blocking)
        .await
        .map_err(|error| format!("Codex usage task failed: {error}"))?
}

fn codex_usage_blocking() -> Result<CodexUsageSnapshot, String> {
    let auth_candidates = load_codex_auth_candidates()?;
    let client = usage_client("Codex")?;

    let mut last_auth_error = None;
    for mut auth_state in auth_candidates {
        if codex_access_token_needs_refresh(&auth_state) {
            if let Err(message) = refresh_codex_auth(&client, &mut auth_state) {
                last_auth_error = Some(message);
                continue;
            }
        }

        match fetch_codex_usage_snapshot(&client, &auth_state) {
            Ok(snapshot) => return Ok(snapshot),
            Err(CodexUsageFetchError::Auth) => {
                let previous_fingerprint = codex_auth_fingerprint(&auth_state);
                let refreshed_source = match reload_codex_auth_source(&auth_state) {
                    Ok(source) => source,
                    Err(message) => {
                        last_auth_error = Some(message);
                        continue;
                    }
                };
                if codex_auth_fingerprint(&refreshed_source) != previous_fingerprint {
                    match fetch_codex_usage_snapshot(&client, &refreshed_source) {
                        Ok(snapshot) => return Ok(snapshot),
                        Err(CodexUsageFetchError::Auth) => {}
                        Err(error) => return Err(format_codex_usage_error(error)),
                    }
                }
                auth_state = refreshed_source;
                if let Err(message) = refresh_codex_auth(&client, &mut auth_state) {
                    last_auth_error = Some(message);
                    continue;
                }
                match fetch_codex_usage_snapshot(&client, &auth_state) {
                    Ok(snapshot) => return Ok(snapshot),
                    Err(CodexUsageFetchError::Auth) => {
                        last_auth_error =
                            Some(format_codex_usage_error(CodexUsageFetchError::Auth));
                    }
                    Err(error) => return Err(format_codex_usage_error(error)),
                }
            }
            Err(error) => return Err(format_codex_usage_error(error)),
        }
    }

    Err(last_auth_error
        .unwrap_or_else(|| "Codex session expired. Run `codex` to log in again.".to_string()))
}

fn fetch_codex_usage_snapshot(
    client: &reqwest::blocking::Client,
    auth_state: &CodexAuthState,
) -> Result<CodexUsageSnapshot, CodexUsageFetchError> {
    let (usage, headers) = fetch_codex_usage(client, auth_state)?;
    let reset_credits = fetch_codex_reset_credits_best_effort(client, auth_state);
    let mut snapshot = build_codex_usage_snapshot(usage, &headers, reset_credits.as_ref());
    append_codex_local_usage(&mut snapshot, auth_state);
    Ok(snapshot)
}

fn format_codex_usage_error(error: CodexUsageFetchError) -> String {
    match error {
        CodexUsageFetchError::Auth => {
            "Codex session expired. Run `codex` to log in again.".to_string()
        }
        CodexUsageFetchError::RateLimited(_) => {
            "Codex usage is rate limited. Try again shortly.".to_string()
        }
        CodexUsageFetchError::Other(message) => message,
    }
}

#[tauri::command]
async fn agy_usage() -> Result<CodexUsageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(agy_usage_blocking)
        .await
        .map_err(|error| format!("Antigravity usage task failed: {error}"))?
}

fn agy_usage_blocking() -> Result<CodexUsageSnapshot, String> {
    if let Some(snapshot) = probe_antigravity_ls_usage() {
        return Ok(snapshot);
    }

    let client = usage_client("Antigravity")?;
    let mut has_local_credentials = false;
    if let Some(mut auth) = load_antigravity_auth() {
        has_local_credentials = true;
        if auth.access_token.is_none() {
            let _ = refresh_antigravity_auth(&client, &mut auth);
        }
        match fetch_antigravity_cloud_snapshot(&client, &auth) {
            Ok(Some(snapshot)) => return Ok(snapshot),
            Err(AntigravityCloudError::Auth) => {
                if refresh_antigravity_auth(&client, &mut auth).is_ok() {
                    if let Ok(Some(snapshot)) = fetch_antigravity_cloud_snapshot(&client, &auth) {
                        return Ok(snapshot);
                    }
                }
            }
            Ok(None) | Err(AntigravityCloudError::Unavailable) => {}
        }
    }

    if !discover_antigravity_ls_processes().is_empty() {
        return Err(if has_local_credentials {
            "Agy is running, but its local session did not return usage. Check that Agy is signed in, then refresh.".to_string()
        } else {
            "Agy is running, but its session is not signed in. Sign in to Agy or Antigravity, then refresh.".to_string()
        });
    }
    Err(if has_local_credentials {
        "Antigravity usage is temporarily unavailable. Local credentials were found, but Cloud Code did not return quota data. Try again shortly.".to_string()
    } else {
        "Antigravity usage unavailable. Start `agy` or Antigravity, then refresh.".to_string()
    })
}

#[tauri::command]
async fn claude_usage() -> Result<CodexUsageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(claude_usage_blocking)
        .await
        .map_err(|error| format!("Claude usage task failed: {error}"))?
}

fn claude_usage_blocking() -> Result<CodexUsageSnapshot, String> {
    let candidates = load_claude_auth_candidates();
    if candidates.is_empty() {
        return Err("Claude Code auth not found. Run `claude` to log in.".to_string());
    }
    let client = usage_client("Claude Code")?;
    let mut last_error = None;

    for mut auth in candidates {
        if !claude_can_fetch_live_usage(&auth) {
            last_error =
                Some("Re-login for live usage. Run `claude` and sign in again.".to_string());
            continue;
        }

        if claude_needs_refresh(&auth) {
            if let Err(message) = refresh_claude_token(&client, &mut auth) {
                last_error = Some(message);
                continue;
            }
        }

        match fetch_claude_usage(&client, &auth) {
            Ok(usage) => {
                return Ok(store_claude_last_good(
                    &auth,
                    build_claude_usage_snapshot(usage, &auth),
                ))
            }
            Err(CodexUsageFetchError::Auth) => {
                if let Err(message) = refresh_claude_token(&client, &mut auth) {
                    last_error = Some(message);
                    continue;
                }
                match fetch_claude_usage(&client, &auth) {
                    Ok(usage) => {
                        return Ok(store_claude_last_good(
                            &auth,
                            build_claude_usage_snapshot(usage, &auth),
                        ))
                    }
                    Err(CodexUsageFetchError::Auth) => {
                        last_error = Some(
                            "Claude Code session expired. Run `claude` to log in again."
                                .to_string(),
                        );
                    }
                    Err(CodexUsageFetchError::RateLimited(retry_after)) => {
                        return Ok(claude_rate_limited_snapshot(&auth, retry_after));
                    }
                    Err(CodexUsageFetchError::Other(message)) => last_error = Some(message),
                }
            }
            Err(CodexUsageFetchError::RateLimited(retry_after)) => {
                return Ok(claude_rate_limited_snapshot(&auth, retry_after));
            }
            Err(CodexUsageFetchError::Other(message)) => last_error = Some(message),
        }
    }

    Err(last_error.unwrap_or_else(|| {
        "Claude Code usage unavailable. Run `claude` to log in again.".to_string()
    }))
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Only http(s) URLs can be opened".to_string());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(trimmed);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", trimmed]);
        command
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(trimmed);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to open link: {error}"))
}

#[derive(Debug)]
enum CodexUsageFetchError {
    Auth,
    RateLimited(Option<u64>),
    Other(String),
}

fn load_codex_auth_candidates() -> Result<Vec<CodexAuthState>, String> {
    let mut candidates = Vec::new();
    let mut api_key_auth_state: Option<CodexAuthState> = None;

    for path in codex_auth_paths()? {
        if !path.exists() {
            continue;
        }

        let text = fs::read_to_string(&path).map_err(|error| {
            format!("Failed to read Codex auth file {}: {error}", path.display())
        })?;
        if let Some(auth) = parse_codex_auth_payload(&text) {
            if has_codex_oauth_token(&auth) {
                candidates.push(CodexAuthState {
                    auth: auth.clone(),
                    source: CodexAuthSource::File(path.clone()),
                });
            }
            if has_codex_api_key(&auth) && api_key_auth_state.is_none() {
                api_key_auth_state = Some(CodexAuthState {
                    auth,
                    source: CodexAuthSource::File(path),
                });
            }
        }
    }

    if let Some(auth) = load_codex_auth_from_keychain() {
        candidates.push(CodexAuthState {
            auth,
            source: CodexAuthSource::Keychain(CODEX_KEYCHAIN_SERVICE.to_string()),
        });
    }

    if let Some(auth_state) = api_key_auth_state {
        candidates.push(auth_state);
    }

    if candidates.is_empty() {
        Err("Codex auth not found. Run `codex` to authenticate.".to_string())
    } else {
        Ok(candidates)
    }
}

fn codex_auth_paths() -> Result<Vec<PathBuf>, String> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let trimmed = codex_home.trim();
        if !trimmed.is_empty() {
            return Ok(vec![PathBuf::from(trimmed).join("auth.json")]);
        }
    }

    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(vec![
        PathBuf::from(&home)
            .join(".config")
            .join("codex")
            .join("auth.json"),
        PathBuf::from(home).join(".codex").join("auth.json"),
    ])
}

fn load_codex_auth_from_keychain() -> Option<CodexAuthFile> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("security")
            .args(["find-generic-password", "-s", CODEX_KEYCHAIN_SERVICE, "-w"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8(output.stdout).ok()?;
        parse_codex_auth_payload(text.trim()).filter(has_codex_auth_token)
    }

    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn parse_codex_auth_payload(text: &str) -> Option<CodexAuthFile> {
    serde_json::from_str::<CodexAuthFile>(text)
        .ok()
        .or_else(|| {
            decode_hex_utf8(text)
                .and_then(|decoded| serde_json::from_str::<CodexAuthFile>(&decoded).ok())
        })
}

fn decode_hex_utf8(text: &str) -> Option<String> {
    let hex = text
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    if hex.is_empty() || hex.len() % 2 != 0 || !hex.chars().all(|char| char.is_ascii_hexdigit()) {
        return None;
    }

    let bytes = (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).ok())
        .collect::<Option<Vec<_>>>()?;
    String::from_utf8(bytes).ok()
}

fn has_codex_auth_token(auth: &CodexAuthFile) -> bool {
    has_codex_oauth_token(auth) || has_codex_api_key(auth)
}

fn has_codex_oauth_token(auth: &CodexAuthFile) -> bool {
    auth.tokens
        .as_ref()
        .and_then(|tokens| tokens.access_token.as_deref())
        .is_some_and(|token| !token.trim().is_empty())
}

fn has_codex_api_key(auth: &CodexAuthFile) -> bool {
    auth.openai_api_key
        .as_deref()
        .is_some_and(|token| !token.trim().is_empty())
}

fn codex_access_token(auth_state: &CodexAuthState) -> Result<String, String> {
    let Some(tokens) = auth_state.auth.tokens.as_ref() else {
        if auth_state
            .auth
            .openai_api_key
            .as_deref()
            .is_some_and(|key| !key.trim().is_empty())
        {
            return Err("Codex usage is not available for API-key auth. Run `codex` to authenticate with ChatGPT.".to_string());
        }
        return Err("Codex OAuth token missing. Run `codex` to authenticate.".to_string());
    };

    tokens
        .access_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Codex access token missing. Run `codex` to authenticate.".to_string())
}

fn codex_access_token_needs_refresh(auth_state: &CodexAuthState) -> bool {
    let Some(token) = auth_state
        .auth
        .tokens
        .as_ref()
        .and_then(|tokens| tokens.access_token.as_deref())
    else {
        return false;
    };
    let Some(expires_at) = jwt_expiry_seconds(token) else {
        return false;
    };
    expires_at <= time::OffsetDateTime::now_utc().unix_timestamp() + 5 * 60
}

fn jwt_expiry_seconds(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| URL_SAFE.decode(payload))
        .ok()?;
    let payload = serde_json::from_slice::<Value>(&decoded).ok()?;
    value_to_i64(payload.get("exp"))
}

fn fetch_codex_usage(
    client: &reqwest::blocking::Client,
    auth_state: &CodexAuthState,
) -> Result<(CodexUsageEnvelope, reqwest::header::HeaderMap), CodexUsageFetchError> {
    let token = codex_access_token(auth_state).map_err(CodexUsageFetchError::Other)?;
    let mut request = client
        .get(CODEX_USAGE_URL)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json");

    if let Some(account_id) = auth_state
        .auth
        .tokens
        .as_ref()
        .and_then(|tokens| tokens.account_id.as_deref())
        .map(str::trim)
        .filter(|account_id| !account_id.is_empty())
    {
        request = request.header("ChatGPT-Account-Id", account_id);
    }

    let response = request.send().map_err(|error| {
        CodexUsageFetchError::Other(format_http_send_error("Codex usage", &error))
    })?;

    let status = response.status();
    let headers = response.headers().clone();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(CodexUsageFetchError::Auth);
    }
    if !status.is_success() {
        return Err(CodexUsageFetchError::Other(format!(
            "Codex usage request failed (HTTP {})",
            status.as_u16()
        )));
    }

    response
        .json::<CodexUsageEnvelope>()
        .map(|usage| (usage, headers))
        .map_err(|error| {
            CodexUsageFetchError::Other(format!("Codex usage response invalid: {error}"))
        })
}

fn fetch_codex_reset_credits_best_effort(
    client: &reqwest::blocking::Client,
    auth_state: &CodexAuthState,
) -> Option<CodexResetCreditsEnvelope> {
    let token = codex_access_token(auth_state).ok()?;
    let mut request = client
        .get(CODEX_RESET_CREDITS_URL)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("OpenAI-Beta", "codex-1")
        .header("originator", "Codex Desktop");

    if let Some(account_id) = auth_state
        .auth
        .tokens
        .as_ref()
        .and_then(|tokens| tokens.account_id.as_deref())
        .map(str::trim)
        .filter(|account_id| !account_id.is_empty())
    {
        request = request.header("ChatGPT-Account-Id", account_id);
    }

    let response = request.send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<CodexResetCreditsEnvelope>().ok()
}

fn refresh_codex_auth(
    client: &reqwest::blocking::Client,
    auth_state: &mut CodexAuthState,
) -> Result<(), String> {
    let source_fingerprint = codex_auth_fingerprint(auth_state);
    let refresh_token = auth_state
        .auth
        .tokens
        .as_ref()
        .and_then(|tokens| tokens.refresh_token.as_deref())
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Codex refresh token missing. Run `codex` to log in again.".to_string())?;

    let response = client
        .post(CODEX_REFRESH_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CODEX_CLIENT_ID),
            ("refresh_token", refresh_token.as_str()),
        ])
        .send()
        .map_err(|error| format_http_send_error("Codex token refresh", &error))?;

    if !response.status().is_success() {
        return Err(format!(
            "Codex token refresh failed (HTTP {}). Run `codex` to log in again.",
            response.status().as_u16()
        ));
    }

    let refreshed = response
        .json::<CodexRefreshResponse>()
        .map_err(|error| format!("Codex token refresh response invalid: {error}"))?;
    let tokens = auth_state
        .auth
        .tokens
        .as_mut()
        .ok_or_else(|| "Codex OAuth token missing. Run `codex` to authenticate.".to_string())?;

    tokens.access_token = refreshed
        .access_token
        .or_else(|| tokens.access_token.clone());
    tokens.refresh_token = refreshed
        .refresh_token
        .or_else(|| tokens.refresh_token.clone());
    tokens.id_token = refreshed.id_token.or_else(|| tokens.id_token.clone());
    auth_state.auth.last_refresh = Some(now_iso());
    save_codex_auth(auth_state, &source_fingerprint)?;
    Ok(())
}

fn reload_codex_auth_source(auth_state: &CodexAuthState) -> Result<CodexAuthState, String> {
    let auth = match &auth_state.source {
        CodexAuthSource::File(path) => {
            let text = fs::read_to_string(path).map_err(|error| {
                format!(
                    "Failed to re-read Codex auth file {}: {error}",
                    path.display()
                )
            })?;
            parse_codex_auth_payload(&text)
                .filter(has_codex_auth_token)
                .ok_or_else(|| {
                    format!(
                        "Codex auth file {} no longer contains valid credentials.",
                        path.display()
                    )
                })?
        }
        CodexAuthSource::Keychain(service) => read_keychain_password(service, None)
            .and_then(|text| parse_codex_auth_payload(&text))
            .filter(has_codex_auth_token)
            .ok_or_else(|| {
                "Codex Keychain credentials are unavailable. Run `codex` to log in again."
                    .to_string()
            })?,
    };
    Ok(CodexAuthState {
        auth,
        source: auth_state.source.clone(),
    })
}

fn save_codex_auth(
    auth_state: &CodexAuthState,
    expected_source_fingerprint: &str,
) -> Result<(), String> {
    if codex_source_fingerprint(auth_state).as_deref() != Some(expected_source_fingerprint) {
        return Err(
            "Codex credentials changed while refreshing; retry usage to use the newest login."
                .to_string(),
        );
    }
    let text = serde_json::to_string_pretty(&auth_state.auth)
        .map_err(|error| format!("Failed to encode refreshed Codex credentials: {error}"))?;
    match &auth_state.source {
        CodexAuthSource::File(path) => fs::write(path, text).map_err(|error| {
            format!(
                "Failed to save refreshed Codex credentials to {}: {error}",
                path.display()
            )
        }),
        CodexAuthSource::Keychain(service) => {
            write_keychain_password(service, &text).map_err(|error| {
                format!("Failed to save refreshed Codex Keychain credentials: {error}")
            })
        }
    }
}

fn codex_source_fingerprint(auth_state: &CodexAuthState) -> Option<String> {
    reload_codex_auth_source(auth_state)
        .ok()
        .map(|state| codex_auth_fingerprint(&state))
}

fn codex_auth_fingerprint(auth_state: &CodexAuthState) -> String {
    let mut hasher = Sha256::new();
    if let Some(tokens) = auth_state.auth.tokens.as_ref() {
        for value in [
            &tokens.access_token,
            &tokens.refresh_token,
            &tokens.account_id,
        ] {
            hasher.update(value.as_deref().unwrap_or_default().as_bytes());
            hasher.update([0]);
        }
    }
    format!("{:x}", hasher.finalize())
}

fn build_codex_usage_snapshot(
    usage: CodexUsageEnvelope,
    headers: &reqwest::header::HeaderMap,
    reset_credits: Option<&CodexResetCreditsEnvelope>,
) -> CodexUsageSnapshot {
    let mut lines = Vec::new();
    lines.extend(codex_classified_window_lines(
        usage.rate_limit.as_ref(),
        (
            read_percent_header(headers, "x-codex-primary-used-percent"),
            read_percent_header(headers, "x-codex-secondary-used-percent"),
        ),
        ("Session", "Weekly"),
    ));
    if let Some(additional_limits) = usage.additional_rate_limits.as_ref() {
        if let Some(entry) = additional_limits
            .iter()
            .find(|entry| is_codex_spark_entry(entry))
        {
            lines.extend(codex_classified_window_lines(
                entry.rate_limit.as_ref(),
                (None, None),
                ("Spark", "Spark Weekly"),
            ));
        }
    }
    if let Some(window) = usage
        .code_review_rate_limit
        .as_ref()
        .and_then(|limit| limit.primary_window.as_ref())
    {
        if let Some(value) = value_to_f64(window.used_percent.as_ref()) {
            lines.push(progress_line(
                "Reviews",
                value,
                Some(window),
                Some(7 * 24 * 60 * 60 * 1000),
            ));
        }
    }
    if let Some((available, expiries)) = read_codex_reset_credits(&usage, reset_credits) {
        lines.push(CodexMetricLine::Text {
            label: "Rate Limit Resets".to_string(),
            value: format_reset_credit_value(available, &expiries),
        });
    }
    if let Some(balance) = usage.credits.and_then(|credits| credits.balance) {
        let Some(balance) = value_to_f64(Some(&balance)) else {
            return CodexUsageSnapshot {
                provider_id: "codex".to_string(),
                display_name: "Codex".to_string(),
                plan: usage.plan_type.and_then(format_codex_plan),
                lines,
                fetched_at: now_iso(),
            };
        };
        let credits = balance.max(0.0).floor() as i64;
        lines.push(CodexMetricLine::Text {
            label: "Credits".to_string(),
            value: format!(
                "${:.2} · {} credits",
                credits as f64 * CODEX_CREDIT_USD_RATE,
                credits
            ),
        });
    }

    CodexUsageSnapshot {
        provider_id: "codex".to_string(),
        display_name: "Codex".to_string(),
        plan: usage.plan_type.and_then(format_codex_plan),
        lines,
        fetched_at: now_iso(),
    }
}

fn append_codex_local_usage(snapshot: &mut CodexUsageSnapshot, auth_state: &CodexAuthState) {
    let Some(usage) = codex_ccusage_daily(auth_state) else {
        return;
    };

    let (today_key, yesterday_key) = codex_history_day_keys(local_now());
    let today = usage
        .daily
        .iter()
        .find(|day| ccusage_day_key(&day.date).as_deref() == Some(today_key.as_str()));
    let yesterday = usage
        .daily
        .iter()
        .find(|day| ccusage_day_key(&day.date).as_deref() == Some(yesterday_key.as_str()));

    snapshot.lines.push(CodexMetricLine::Text {
        label: "Today".to_string(),
        value: format_ccusage_optional_day(today),
    });
    snapshot.lines.push(CodexMetricLine::Text {
        label: "Yesterday".to_string(),
        value: format_ccusage_optional_day(yesterday),
    });
    if let Some(latest_day) = ccusage_latest_day(&usage.daily) {
        snapshot.lines.push(CodexMetricLine::Text {
            label: "Latest Token Log".to_string(),
            value: ccusage_day_display_label(&latest_day.date),
        });
    }

    let total_tokens: f64 = usage.daily.iter().filter_map(ccusage_day_tokens).sum();
    let cost_values = usage.daily.iter().filter_map(ccusage_day_cost);
    let mut has_cost = false;
    let mut total_cost = 0.0;
    for cost in cost_values {
        has_cost = true;
        total_cost += cost;
    }
    if total_tokens > 0.0 || has_cost {
        snapshot.lines.push(CodexMetricLine::Text {
            label: "Last 30 Days".to_string(),
            value: format_cost_tokens(if has_cost { Some(total_cost) } else { None }, total_tokens),
        });
    }

    for day in ccusage_recent_days(&usage.daily, 7) {
        snapshot.lines.push(CodexMetricLine::Text {
            label: format!("Daily {}", ccusage_day_display_label(&day.date)),
            value: format_ccusage_day(Some(day)),
        });
    }

    let mut chart_points = ccusage_chart_points(&usage.daily);
    if !chart_points.is_empty() {
        if chart_points.len() > 31 {
            chart_points = chart_points.split_off(chart_points.len() - 31);
        }
        snapshot.lines.push(CodexMetricLine::BarChart {
            label: "Usage Trend".to_string(),
            points: chart_points,
            note: Some("Estimated from local Codex logs for this home.".to_string()),
            color: Some("#74AA9C".to_string()),
        });
    }

    for (model, percent) in ccusage_model_shares(&usage.daily) {
        snapshot.lines.push(CodexMetricLine::Text {
            label: model,
            value: format_percent_label(percent),
        });
    }
}

fn codex_ccusage_daily(auth_state: &CodexAuthState) -> Option<CcusageDailyUsage> {
    let key = codex_ccusage_cache_key(auth_state);
    let cache = CODEX_CCUSAGE_CACHE.get_or_init(|| Mutex::new(None));
    if let Some(usage) = cached_codex_ccusage_usage(cache, &key) {
        return Some(usage);
    }

    let in_flight = CODEX_CCUSAGE_IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()));
    let is_leader = in_flight.lock().ok()?.insert(key.clone());
    if !is_leader {
        let deadline = Instant::now() + CCUSAGE_TIMEOUT;
        loop {
            if let Some(usage) = cached_codex_ccusage_usage(cache, &key) {
                return Some(usage);
            }
            let still_running = in_flight
                .lock()
                .ok()
                .is_some_and(|guard| guard.contains(&key));
            if !still_running {
                return codex_ccusage_daily(auth_state);
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    let usage = (|| {
        let since = codex_ccusage_since_string(30);
        let home_path = codex_home_for_ccusage(auth_state);
        run_ccusage_codex_daily(&since, home_path.as_deref())
    })();

    let Some(usage) = usage else {
        if let Ok(mut guard) = in_flight.lock() {
            guard.remove(&key);
        }
        return None;
    };
    publish_codex_ccusage_usage(cache, in_flight, key, &usage);
    Some(usage)
}

fn cached_codex_ccusage_usage(
    cache: &Mutex<Option<CcusageCacheEntry>>,
    key: &str,
) -> Option<CcusageDailyUsage> {
    cache
        .lock()
        .ok()
        .and_then(|guard| {
            guard
                .as_ref()
                .filter(|entry| entry.key == key && entry.fetched_at.elapsed() < CCUSAGE_CACHE_TTL)
                .cloned()
        })
        .map(|entry| entry.usage)
}

fn publish_codex_ccusage_usage(
    cache: &Mutex<Option<CcusageCacheEntry>>,
    in_flight: &Mutex<HashSet<String>>,
    key: String,
    usage: &CcusageDailyUsage,
) {
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(CcusageCacheEntry {
            key: key.clone(),
            fetched_at: Instant::now(),
            usage: usage.clone(),
        });
    }
    if let Ok(mut guard) = in_flight.lock() {
        guard.remove(&key);
    }
}

fn codex_ccusage_cache_key(auth_state: &CodexAuthState) -> String {
    let home = codex_home_for_ccusage(auth_state).unwrap_or_else(|| "default".to_string());
    let account = auth_state
        .auth
        .tokens
        .as_ref()
        .and_then(|tokens| tokens.account_id.as_deref())
        .map(str::trim)
        .filter(|account| !account.is_empty())
        .unwrap_or("unresolved");
    format!("{home}\u{0}{account}")
}

fn codex_home_for_ccusage(auth_state: &CodexAuthState) -> Option<String> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let trimmed = codex_home.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    match &auth_state.source {
        CodexAuthSource::File(path) => path.parent().map(|path| path.to_string_lossy().to_string()),
        CodexAuthSource::Keychain(_) => None,
    }
}

fn run_ccusage_codex_daily(since: &str, codex_home: Option<&str>) -> Option<CcusageDailyUsage> {
    for runner in ccusage_runners(since) {
        let child_result = Command::new(&runner.program)
            .args(&runner.args)
            .env("PATH", enriched_cli_path())
            .envs(codex_home.map(|home| ("CODEX_HOME", home)))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let Ok(mut child) = child_result else {
            continue;
        };
        let deadline = Instant::now() + CCUSAGE_TIMEOUT;
        loop {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            thread::sleep(Duration::from_millis(100));
        }

        let mut stdout = String::new();
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stdout.take() {
            let _ = pipe.read_to_string(&mut stdout);
        }
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        let Ok(status) = child.wait() else {
            continue;
        };
        if !status.success() {
            let _ = stderr;
            continue;
        }
        if let Some(usage) = parse_ccusage_output(&stdout) {
            return Some(usage);
        }
    }
    None
}

struct CcusageRunnerCommand {
    program: String,
    args: Vec<String>,
}

fn ccusage_runners(since: &str) -> Vec<CcusageRunnerCommand> {
    let suffix = vec![
        "codex".to_string(),
        "daily".to_string(),
        "--json".to_string(),
        "--order".to_string(),
        "desc".to_string(),
        "--since".to_string(),
        since.to_string(),
    ];
    let mut runners = Vec::new();
    if let Some(program) = first_existing_command(&[
        home_join(".bun/bin/bunx"),
        Some("/opt/homebrew/bin/bunx".into()),
        Some("/usr/local/bin/bunx".into()),
        Some("bunx".into()),
    ]) {
        runners.push(CcusageRunnerCommand {
            program,
            args: [
                vec!["--silent".to_string(), CCUSAGE_PACKAGE.to_string()],
                suffix.clone(),
            ]
            .concat(),
        });
    }
    if let Some(program) = first_existing_command(&[
        Some("/opt/homebrew/bin/pnpm".into()),
        Some("/usr/local/bin/pnpm".into()),
        Some("pnpm".into()),
    ]) {
        runners.push(CcusageRunnerCommand {
            program,
            args: [
                vec![
                    "-s".to_string(),
                    "dlx".to_string(),
                    CCUSAGE_PACKAGE.to_string(),
                ],
                suffix.clone(),
            ]
            .concat(),
        });
    }
    if let Some(program) = first_existing_command(&[
        Some("/opt/homebrew/bin/yarn".into()),
        Some("/usr/local/bin/yarn".into()),
        Some("yarn".into()),
    ]) {
        runners.push(CcusageRunnerCommand {
            program,
            args: [
                vec![
                    "dlx".to_string(),
                    "-q".to_string(),
                    CCUSAGE_PACKAGE.to_string(),
                ],
                suffix.clone(),
            ]
            .concat(),
        });
    }
    if let Some(program) = first_existing_command(&[
        Some("/opt/homebrew/bin/npm".into()),
        Some("/usr/local/bin/npm".into()),
        Some("npm".into()),
    ]) {
        runners.push(CcusageRunnerCommand {
            program,
            args: [
                vec![
                    "exec".to_string(),
                    "--yes".to_string(),
                    format!("--package={CCUSAGE_PACKAGE}"),
                    "--".to_string(),
                    "ccusage".to_string(),
                ],
                suffix.clone(),
            ]
            .concat(),
        });
    }
    if let Some(program) = first_existing_command(&[
        Some("/opt/homebrew/bin/npx".into()),
        Some("/usr/local/bin/npx".into()),
        Some("npx".into()),
    ]) {
        runners.push(CcusageRunnerCommand {
            program,
            args: [
                vec!["--yes".to_string(), CCUSAGE_PACKAGE.to_string()],
                suffix,
            ]
            .concat(),
        });
    }
    runners
}

fn parse_ccusage_output(stdout: &str) -> Option<CcusageDailyUsage> {
    serde_json::from_str::<CcusageDailyUsage>(stdout)
        .ok()
        .or_else(|| {
            let start = stdout.find('{')?;
            serde_json::from_str::<CcusageDailyUsage>(&stdout[start..]).ok()
        })
}

fn first_existing_command(candidates: &[Option<String>]) -> Option<String> {
    for candidate in candidates.iter().flatten() {
        if candidate.contains('/') {
            if Path::new(candidate).is_file() {
                return Some(candidate.clone());
            }
        } else {
            return Some(candidate.clone());
        }
    }
    None
}

fn home_join(relative: &str) -> Option<String> {
    home_dir().map(|home| home.join(relative).to_string_lossy().to_string())
}

fn enriched_cli_path() -> String {
    let mut entries = Vec::new();
    if let Some(home) = home_dir() {
        entries.push(home.join(".bun/bin").to_string_lossy().to_string());
        entries.push(home.join(".nvm/current/bin").to_string_lossy().to_string());
        entries.push(home.join(".local/bin").to_string_lossy().to_string());
    }
    entries.push("/opt/homebrew/bin".to_string());
    entries.push("/usr/local/bin".to_string());
    if let Ok(path) = std::env::var("PATH") {
        entries.extend(path.split(':').map(ToOwned::to_owned));
    }
    let mut seen = BTreeMap::new();
    entries
        .into_iter()
        .filter(|entry| !entry.is_empty())
        .filter(|entry| seen.insert(entry.clone(), ()).is_none())
        .collect::<Vec<_>>()
        .join(":")
}

fn codex_ccusage_since_string(days_back: i64) -> String {
    codex_ccusage_since_string_at(local_now(), days_back)
}

fn codex_ccusage_since_string_at(now: time::OffsetDateTime, days_back: i64) -> String {
    let since = now - time::Duration::days(days_back);
    format!(
        "{:04}{:02}{:02}",
        since.year(),
        u8::from(since.month()),
        since.day()
    )
}

fn local_now() -> time::OffsetDateTime {
    let now = time::OffsetDateTime::now_utc();
    time::UtcOffset::current_local_offset()
        .map(|offset| now.to_offset(offset))
        .unwrap_or(now)
}

fn codex_history_day_keys(now: time::OffsetDateTime) -> (String, String) {
    (
        local_day_key(now),
        local_day_key(now - time::Duration::days(1)),
    )
}

fn local_day_key(date: time::OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

fn ccusage_day_key(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.len() >= 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
    {
        return Some(value[..10].to_string());
    }
    if value.len() == 8 && value.chars().all(|ch| ch.is_ascii_digit()) {
        return Some(format!("{}-{}-{}", &value[..4], &value[4..6], &value[6..8]));
    }
    None
}

fn ccusage_day_tokens(day: &CcusageDay) -> Option<f64> {
    value_to_f64(day.total_tokens.as_ref()).filter(|value| *value >= 0.0)
}

fn ccusage_day_cost(day: &CcusageDay) -> Option<f64> {
    value_to_f64(day.cost_usd.as_ref())
        .or_else(|| value_to_f64(day.total_cost.as_ref()))
        .filter(|value| value.is_finite())
}

fn format_ccusage_day(day: Option<&CcusageDay>) -> String {
    let tokens = day.and_then(ccusage_day_tokens).unwrap_or(0.0);
    let cost = day.and_then(ccusage_day_cost).or(Some(0.0));
    format_cost_tokens(cost, tokens)
}

fn format_ccusage_optional_day(day: Option<&CcusageDay>) -> String {
    day.map(|day| format_ccusage_day(Some(day)))
        .unwrap_or_else(|| "No local token log".to_string())
}

fn format_cost_tokens(cost: Option<f64>, tokens: f64) -> String {
    let mut parts = Vec::new();
    if let Some(cost) = cost {
        parts.push(format!("${:.2}", cost.max(0.0)));
    }
    parts.push(format!("{} tokens", format_compact_number(tokens)));
    parts.join(" · ")
}

fn format_compact_number(value: f64) -> String {
    let abs = value.abs();
    let (divisor, suffix) = if abs >= 1_000_000_000.0 {
        (1_000_000_000.0, "B")
    } else if abs >= 1_000_000.0 {
        (1_000_000.0, "M")
    } else if abs >= 1_000.0 {
        (1_000.0, "K")
    } else {
        return format!("{}", value.round() as i64);
    };
    let scaled = value / divisor;
    if scaled.abs() >= 10.0 {
        format!("{}{suffix}", scaled.round() as i64)
    } else {
        format!("{:.1}{suffix}", scaled).replace(".0", "")
    }
}

fn ccusage_chart_points(days: &[CcusageDay]) -> Vec<CodexBarChartPoint> {
    let mut points = days
        .iter()
        .filter_map(|day| {
            let key = ccusage_day_key(&day.date)?;
            let value = ccusage_day_tokens(day)?;
            Some((key, value))
        })
        .collect::<Vec<_>>();
    points.sort_by(|a, b| a.0.cmp(&b.0));
    points
        .into_iter()
        .map(|(key, value)| CodexBarChartPoint {
            label: format!(
                "{}/{}",
                key[5..7].trim_start_matches('0'),
                key[8..10].trim_start_matches('0')
            ),
            value,
            value_label: format!("{} tokens", format_compact_number(value)),
        })
        .collect()
}

fn ccusage_recent_days(days: &[CcusageDay], limit: usize) -> Vec<&CcusageDay> {
    let mut keyed = days
        .iter()
        .filter_map(|day| ccusage_day_key(&day.date).map(|key| (key, day)))
        .collect::<Vec<_>>();
    keyed.sort_by(|a, b| b.0.cmp(&a.0));
    keyed.into_iter().take(limit).map(|(_, day)| day).collect()
}

fn ccusage_latest_day(days: &[CcusageDay]) -> Option<&CcusageDay> {
    ccusage_recent_days(days, 1).into_iter().next()
}

fn ccusage_day_display_label(raw: &str) -> String {
    ccusage_day_key(raw)
        .map(|key| {
            format!(
                "{}/{}",
                key[5..7].trim_start_matches('0'),
                key[8..10].trim_start_matches('0')
            )
        })
        .unwrap_or_else(|| raw.to_string())
}

fn ccusage_model_shares(days: &[CcusageDay]) -> Vec<(String, f64)> {
    let mut totals: BTreeMap<String, f64> = BTreeMap::new();
    let mut total_tokens = 0.0;
    for day in days {
        if let Some(models) = &day.models {
            for (name, usage) in models {
                let tokens = ccusage_model_tokens(usage);
                if tokens <= 0.0 {
                    continue;
                }
                *totals.entry(name.clone()).or_default() += tokens;
                total_tokens += tokens;
            }
        }
        if let Some(breakdowns) = &day.model_breakdowns {
            for breakdown in breakdowns {
                let name = maybe_string(breakdown.get("modelName"))
                    .or_else(|| maybe_string(breakdown.get("name")))
                    .or_else(|| maybe_string(breakdown.get("model")));
                let Some(name) = name else {
                    continue;
                };
                let tokens = ccusage_model_tokens_from_value(breakdown);
                if tokens <= 0.0 {
                    continue;
                }
                *totals.entry(name).or_default() += tokens;
                total_tokens += tokens;
            }
        }
    }
    if total_tokens <= 0.0 {
        return Vec::new();
    }
    let mut shares = totals
        .into_iter()
        .map(|(name, tokens)| (name, (tokens / total_tokens) * 100.0))
        .collect::<Vec<_>>();
    shares.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    shares.truncate(5);
    shares
}

fn ccusage_model_tokens(usage: &CcusageModelUsage) -> f64 {
    value_to_f64(usage.total_tokens.as_ref()).unwrap_or_else(|| {
        [
            usage.input_tokens.as_ref(),
            usage.cached_input_tokens.as_ref(),
            usage.cache_creation_tokens.as_ref(),
            usage.cache_read_tokens.as_ref(),
            usage.output_tokens.as_ref(),
            usage.reasoning_output_tokens.as_ref(),
        ]
        .into_iter()
        .flatten()
        .filter_map(|value| value_to_f64(Some(value)))
        .sum()
    })
}

fn ccusage_model_tokens_from_value(value: &Value) -> f64 {
    value_to_f64(value.get("totalTokens")).unwrap_or_else(|| {
        [
            "inputTokens",
            "cachedInputTokens",
            "cacheCreationTokens",
            "cacheReadTokens",
            "outputTokens",
            "reasoningOutputTokens",
        ]
        .into_iter()
        .filter_map(|key| value_to_f64(value.get(key)))
        .sum()
    })
}

fn format_percent_label(percent: f64) -> String {
    if percent > 0.0 && percent < 0.1 {
        return "<0.1%".to_string();
    }
    let rounded = (percent * 10.0).round() / 10.0;
    if (rounded.fract()).abs() < f64::EPSILON {
        format!("{}%", rounded as i64)
    } else {
        format!("{rounded:.1}%")
    }
}

fn read_codex_reset_credits(
    usage: &CodexUsageEnvelope,
    dedicated: Option<&CodexResetCreditsEnvelope>,
) -> Option<(i64, Vec<time::OffsetDateTime>)> {
    let dedicated_count = dedicated
        .and_then(|credits| credits.available_count.as_ref())
        .and_then(|value| value_to_f64(Some(value)));
    let embedded_count = usage
        .rate_limit_reset_credits
        .as_ref()
        .and_then(|credits| credits.available_count.as_ref())
        .and_then(|value| value_to_f64(Some(value)));
    let count = dedicated_count.or(embedded_count)?.max(0.0).floor() as i64;
    let expiries = dedicated
        .and_then(|credits| credits.credits.as_ref())
        .map(|credits| {
            let mut expiries = credits
                .iter()
                .filter(|credit| {
                    credit
                        .status
                        .as_deref()
                        .map(|status| status.eq_ignore_ascii_case("available"))
                        .unwrap_or(true)
                })
                .filter_map(|credit| parse_reset_credit_expiry(credit.expires_at.as_ref()))
                .collect::<Vec<_>>();
            expiries.sort();
            expiries
        })
        .unwrap_or_default();
    Some((count, expiries))
}

fn parse_reset_credit_expiry(value: Option<&Value>) -> Option<time::OffsetDateTime> {
    match value? {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value as i64))
            .and_then(|seconds| time::OffsetDateTime::from_unix_timestamp(seconds).ok()),
        Value::String(text) => {
            time::OffsetDateTime::parse(text.trim(), &time::format_description::well_known::Rfc3339)
                .ok()
        }
        _ => None,
    }
}

fn format_reset_credit_value(count: i64, expiries: &[time::OffsetDateTime]) -> String {
    let base = format!("{count} available");
    let Some(first_expiry) = expiries.first() else {
        return base;
    };
    format!("{base} · expires {}", format_relative_time(*first_expiry))
}

fn format_relative_time(target: time::OffsetDateTime) -> String {
    let seconds = target.unix_timestamp() - time::OffsetDateTime::now_utc().unix_timestamp();
    let abs = seconds.unsigned_abs();
    let (value, unit) = if abs >= 86_400 {
        ((abs as f64 / 86_400.0).ceil() as u64, "d")
    } else if abs >= 3_600 {
        ((abs as f64 / 3_600.0).ceil() as u64, "h")
    } else {
        ((abs as f64 / 60.0).ceil().max(1.0) as u64, "m")
    };
    if seconds >= 0 {
        format!("in {value}{unit}")
    } else {
        format!("{value}{unit} ago")
    }
}

fn is_codex_spark_entry(entry: &CodexAdditionalRateLimit) -> bool {
    [
        entry.limit_name.as_deref(),
        entry.metered_feature.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .any(|value| value.to_ascii_lowercase().contains("spark"))
}

fn codex_window_kind(window: Option<&CodexRateLimitWindow>) -> Option<CodexWindowKind> {
    match value_to_u64(window?.limit_window_seconds.as_ref())? {
        18_000 => Some(CodexWindowKind::Session),
        604_800 => Some(CodexWindowKind::Weekly),
        _ => None,
    }
}

fn codex_classified_window_lines(
    rate_limit: Option<&CodexRateLimit>,
    header_percents: (Option<f64>, Option<f64>),
    labels: (&str, &str),
) -> Vec<CodexMetricLine> {
    let mut candidates = Vec::new();
    if let Some(rate_limit) = rate_limit {
        let primary_window = rate_limit.primary_window.as_ref();
        if primary_window.is_some() || header_percents.0.is_some() {
            candidates.push(CodexWindowCandidate {
                window: primary_window,
                header_percent: header_percents.0,
                fallback_kind: CodexWindowKind::Session,
            });
        }
        let secondary_window = rate_limit.secondary_window.as_ref();
        if secondary_window.is_some() || header_percents.1.is_some() {
            candidates.push(CodexWindowCandidate {
                window: secondary_window,
                header_percent: header_percents.1,
                fallback_kind: CodexWindowKind::Weekly,
            });
        }
    } else {
        if header_percents.0.is_some() {
            candidates.push(CodexWindowCandidate {
                window: None,
                header_percent: header_percents.0,
                fallback_kind: CodexWindowKind::Session,
            });
        }
        if header_percents.1.is_some() {
            candidates.push(CodexWindowCandidate {
                window: None,
                header_percent: header_percents.1,
                fallback_kind: CodexWindowKind::Weekly,
            });
        }
    }

    [
        (CodexWindowKind::Session, labels.0, 5 * 60 * 60 * 1000),
        (CodexWindowKind::Weekly, labels.1, 7 * 24 * 60 * 60 * 1000),
    ]
    .into_iter()
    .filter_map(|(kind, label, fallback_duration_ms)| {
        let candidate = candidates
            .iter()
            .find(|candidate| codex_window_kind(candidate.window) == Some(kind))
            .or_else(|| {
                candidates.iter().find(|candidate| {
                    codex_window_kind(candidate.window).is_none() && candidate.fallback_kind == kind
                })
            })?;
        let used = candidate.header_percent.or_else(|| {
            candidate
                .window
                .and_then(|window| value_to_f64(window.used_percent.as_ref()))
        })?;
        Some(progress_line(
            label,
            used,
            candidate.window,
            Some(fallback_duration_ms),
        ))
    })
    .collect()
}

fn progress_line(
    label: &str,
    used: f64,
    window: Option<&CodexRateLimitWindow>,
    fallback_duration_ms: Option<u64>,
) -> CodexMetricLine {
    let period_duration_ms = window
        .and_then(|window| value_to_u64(window.limit_window_seconds.as_ref()))
        .map(|seconds| seconds * 1000)
        .or(fallback_duration_ms);
    let reset_at = window.and_then(rate_limit_reset_iso);
    let used = normalize_fresh_rate_limit_used(used, window, period_duration_ms);

    CodexMetricLine::Progress {
        label: label.to_string(),
        used: used.clamp(0.0, 100.0),
        limit: 100.0,
        format: CodexProgressFormat::Percent,
        resets_at: reset_at,
        period_duration_ms,
    }
}

fn rate_limit_reset_iso(window: &CodexRateLimitWindow) -> Option<String> {
    if let Some(seconds) = value_to_i64(window.reset_at.as_ref()) {
        return unix_seconds_to_iso(seconds);
    }
    let reset_after = value_to_i64(window.reset_after_seconds.as_ref())?;
    unix_seconds_to_iso(time::OffsetDateTime::now_utc().unix_timestamp() + reset_after)
}

fn normalize_fresh_rate_limit_used(
    used: f64,
    window: Option<&CodexRateLimitWindow>,
    period_duration_ms: Option<u64>,
) -> f64 {
    if used > 1.0 {
        return used;
    }
    let Some(window) = window else { return used };
    let Some(period_ms) = period_duration_ms else {
        return used;
    };
    let Some(reset_after_seconds) = rate_limit_reset_after_seconds(window) else {
        return used;
    };
    let period_seconds = (period_ms / 1000) as i64;
    if period_seconds > 0 && reset_after_seconds >= period_seconds.saturating_sub(60) {
        0.0
    } else {
        used
    }
}

fn rate_limit_reset_after_seconds(window: &CodexRateLimitWindow) -> Option<i64> {
    if let Some(value) = value_to_i64(window.reset_after_seconds.as_ref()) {
        return Some(value);
    }
    value_to_i64(window.reset_at.as_ref())
        .map(|reset_at| reset_at - time::OffsetDateTime::now_utc().unix_timestamp())
}

fn value_to_f64(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|value| value.is_finite())
}

fn value_to_i64(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value as i64)),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn value_to_u64(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number
            .as_u64()
            .or_else(|| number.as_f64().map(|value| value as u64)),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn usage_client(provider: &str) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Gyredeck");

    if let Some(proxy_url) = openusage_proxy_url() {
        let proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|error| format!("Invalid OpenUsage proxy config: {error}"))?;
        let no_proxy = reqwest::NoProxy::from_string("localhost,127.0.0.1,::1");
        builder = builder.proxy(proxy.no_proxy(no_proxy));
    }

    builder
        .build()
        .map_err(|error| format!("Failed to create {provider} usage client: {error}"))
}

fn openusage_proxy_url() -> Option<String> {
    static OPENUSAGE_PROXY_URL: OnceLock<Option<String>> = OnceLock::new();
    OPENUSAGE_PROXY_URL
        .get_or_init(|| {
            let path = home_path(OPENUSAGE_PROXY_CONFIG_PATH)?;
            let text = fs::read_to_string(path).ok()?;
            let config = serde_json::from_str::<OpenUsageProxyConfigFile>(&text).ok()?;
            let proxy = config.proxy?;
            if proxy.enabled != Some(true) {
                return None;
            }
            let url = proxy.url?.trim().to_string();
            if is_supported_proxy_url(&url) {
                Some(url)
            } else {
                None
            }
        })
        .clone()
}

fn is_supported_proxy_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("socks5://") || lower.starts_with("http://") || lower.starts_with("https://")
}

fn format_http_send_error(label: &str, error: &reqwest::Error) -> String {
    let mut message = format!("{label} request failed: {error}");
    if let Some(source) = error.source() {
        message.push_str(&format!(" ({source})"));
    }
    if error.is_connect() && openusage_proxy_url().is_none() {
        message.push_str(
            ". If this network needs a proxy, add ~/.openusage/config.json with proxy.enabled and proxy.url.",
        );
    }
    message
}

fn read_keychain_password(service: &str, account: Option<&str>) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let mut args = vec!["find-generic-password", "-s", service];
        if let Some(account) = account {
            args.push("-a");
            args.push(account);
        }
        args.push("-w");
        let output = Command::new("security").args(args).output().ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8(output.stdout)
            .ok()
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (service, account);
        None
    }
}

fn write_keychain_password(service: &str, value: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let account = keychain_account_for_service(service)?;
        set_generic_password(service, &account, value.as_bytes())
            .map_err(|error| format!("Keychain update failed: {error}"))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (service, value);
        Err("Keychain writes require macOS".to_string())
    }
}

#[cfg(target_os = "macos")]
fn keychain_account_for_service(service: &str) -> Result<String, String> {
    let output = Command::new("security")
        .args(["find-generic-password", "-s", service])
        .output()
        .map_err(|error| format!("could not inspect Keychain item: {error}"))?;
    if !output.status.success() {
        return Err(
            "Keychain item is unavailable; run the provider CLI to log in again.".to_string(),
        );
    }
    let metadata = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    metadata
        .lines()
        .find_map(|line| line.trim().strip_prefix("\"acct\"<blob>=\""))
        .and_then(|value| value.strip_suffix('"'))
        .filter(|account| !account.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            "Keychain item account is unavailable; refusing to overwrite credentials.".to_string()
        })
}

fn parse_json_or_hex<T: for<'de> Deserialize<'de>>(text: &str) -> Option<T> {
    if let Ok(value) = serde_json::from_str::<T>(text) {
        return Some(value);
    }
    let mut hex = text.trim();
    if let Some(stripped) = hex.strip_prefix("0x").or_else(|| hex.strip_prefix("0X")) {
        hex = stripped;
    }
    if hex.is_empty() || hex.len() % 2 != 0 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).ok())
        .collect::<Option<Vec<_>>>()?;
    let decoded = String::from_utf8(bytes).ok()?;
    serde_json::from_str::<T>(&decoded).ok()
}

fn home_path(relative: &str) -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(relative))
}

fn maybe_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

fn format_plan_label(value: &str) -> String {
    value
        .split(['_', '-', ' '])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn dollars_from_cents(cents: f64) -> String {
    format!("${:.2}", cents / 100.0)
}

fn progress_metric(
    label: &str,
    used: f64,
    resets_at: Option<String>,
    period_duration_ms: Option<u64>,
) -> CodexMetricLine {
    CodexMetricLine::Progress {
        label: label.to_string(),
        used: used.clamp(0.0, 100.0),
        limit: 100.0,
        format: CodexProgressFormat::Percent,
        resets_at,
        period_duration_ms,
    }
}

fn load_claude_auth_candidates() -> Vec<ClaudeAuthState> {
    let oauth_config = claude_oauth_config();
    claude_auth_candidates_from(
        load_stored_claude_auths(&oauth_config),
        env_text("CLAUDE_CODE_OAUTH_TOKEN"),
        oauth_config,
    )
}

fn claude_auth_candidates_from(
    mut candidates: Vec<ClaudeAuthState>,
    env_access_token: Option<String>,
    oauth_config: ClaudeOauthConfig,
) -> Vec<ClaudeAuthState> {
    if let Some(env_access_token) = env_access_token {
        let mut credentials = ClaudeCredentialsFile {
            claude_ai_oauth: Some(ClaudeOauth {
                access_token: None,
                refresh_token: None,
                expires_at: None,
                subscription_type: None,
                rate_limit_tier: None,
                scopes: None,
            }),
        };
        if let Some(oauth) = credentials.claude_ai_oauth.as_mut() {
            oauth.access_token = Some(env_access_token);
        }
        candidates.push(ClaudeAuthState {
            credentials,
            service_name: None,
            file_path: None,
            inference_only: true,
            oauth_config,
        });
    }
    candidates
}

fn load_stored_claude_auths(oauth_config: &ClaudeOauthConfig) -> Vec<ClaudeAuthState> {
    let mut candidates = load_claude_keychain_auths(oauth_config);
    if let Some(file_auth) = load_claude_file_auth(oauth_config) {
        candidates.push(file_auth);
    }
    candidates
}

fn load_claude_keychain_auths(oauth_config: &ClaudeOauthConfig) -> Vec<ClaudeAuthState> {
    let mut candidates = Vec::new();
    for service in claude_keychain_service_candidates(oauth_config) {
        let Some(text) = read_keychain_password(&service, None) else {
            continue;
        };
        let Some(credentials) = parse_json_or_hex::<ClaudeCredentialsFile>(&text) else {
            continue;
        };
        if !claude_credentials_have_access_token(&credentials) {
            continue;
        }
        candidates.push(ClaudeAuthState {
            credentials,
            service_name: Some(service),
            file_path: None,
            inference_only: false,
            oauth_config: oauth_config.clone(),
        });
    }
    candidates
}

fn load_claude_file_auth(oauth_config: &ClaudeOauthConfig) -> Option<ClaudeAuthState> {
    let path = claude_credentials_path()?;
    let text = fs::read_to_string(&path).ok()?;
    let credentials = parse_json_or_hex::<ClaudeCredentialsFile>(&text)?;
    if !claude_credentials_have_access_token(&credentials) {
        return None;
    }
    Some(ClaudeAuthState {
        credentials,
        service_name: None,
        file_path: Some(path),
        inference_only: false,
        oauth_config: oauth_config.clone(),
    })
}

fn claude_credentials_have_access_token(credentials: &ClaudeCredentialsFile) -> bool {
    credentials
        .claude_ai_oauth
        .as_ref()
        .and_then(|oauth| oauth.access_token.as_deref())
        .map(str::trim)
        .is_some_and(|token| !token.is_empty())
}

fn claude_oauth_config() -> ClaudeOauthConfig {
    let mut base_api = CLAUDE_USAGE_URL
        .strip_suffix("/api/oauth/usage")
        .unwrap_or("https://api.anthropic.com")
        .to_string();
    let mut refresh_url = CLAUDE_REFRESH_URL.to_string();
    let mut client_id = CLAUDE_CLIENT_ID.to_string();
    let mut oauth_file_suffix = String::new();

    let is_ant_user = env_text("USER_TYPE").as_deref() == Some("ant");
    if is_ant_user && env_flag("USE_LOCAL_OAUTH") {
        base_api = env_text("CLAUDE_LOCAL_OAUTH_API_BASE")
            .unwrap_or_else(|| "http://localhost:8000".to_string())
            .trim_end_matches('/')
            .to_string();
        refresh_url = format!("{base_api}/v1/oauth/token");
        client_id = CLAUDE_NON_PROD_CLIENT_ID.to_string();
        oauth_file_suffix = "-local-oauth".to_string();
    } else if is_ant_user && env_flag("USE_STAGING_OAUTH") {
        base_api = "https://api-staging.anthropic.com".to_string();
        refresh_url = "https://platform.staging.ant.dev/v1/oauth/token".to_string();
        client_id = CLAUDE_NON_PROD_CLIENT_ID.to_string();
        oauth_file_suffix = "-staging-oauth".to_string();
    }

    // A refresh token and a bearer token go over this URL, so a plaintext override is
    // refused outright rather than honoured. Loopback is allowed: it never leaves the
    // machine, and the local OAuth path above already relies on it.
    if let Some(custom) = env_text("CLAUDE_CODE_CUSTOM_OAUTH_URL") {
        let custom = custom.trim_end_matches('/').to_string();
        if is_confidential_oauth_url(&custom) {
            base_api = custom;
            refresh_url = format!("{base_api}/v1/oauth/token");
            oauth_file_suffix = "-custom-oauth".to_string();
        } else {
            eprintln!(
                "Ignoring CLAUDE_CODE_CUSTOM_OAUTH_URL: {custom} is not https and is not loopback"
            );
        }
    }
    if let Some(override_client_id) = env_text("CLAUDE_CODE_OAUTH_CLIENT_ID") {
        client_id = override_client_id;
    }

    ClaudeOauthConfig {
        usage_url: format!("{base_api}/api/oauth/usage"),
        refresh_url,
        client_id,
        oauth_file_suffix,
    }
}

fn claude_keychain_service_candidates(oauth_config: &ClaudeOauthConfig) -> Vec<String> {
    let base = format!(
        "{}{}-credentials",
        CLAUDE_KEYCHAIN_SERVICE_PREFIX, oauth_config.oauth_file_suffix
    );
    let mut candidates = Vec::new();
    if let Some(config_dir) = env_text("CLAUDE_CONFIG_DIR") {
        let mut hasher = Sha256::new();
        hasher.update(config_dir.as_bytes());
        let digest = format!("{:x}", hasher.finalize());
        candidates.push(format!("{}-{}", base, &digest[..8]));
    }
    candidates.push(base);
    candidates
}

fn claude_credentials_path() -> Option<PathBuf> {
    if let Some(config_dir) = env_text("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(config_dir).join(CLAUDE_CREDENTIALS_FILE));
    }
    home_dir().map(|home| home.join(CLAUDE_DEFAULT_HOME).join(CLAUDE_CREDENTIALS_FILE))
}

fn env_text(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_flag(name: &str) -> bool {
    env_text(name)
        .map(|value| {
            !matches!(
                value.to_ascii_lowercase().as_str(),
                "0" | "false" | "no" | "off"
            )
        })
        .unwrap_or(false)
}

fn claude_access_token(auth: &ClaudeAuthState) -> Result<String, String> {
    auth.credentials
        .claude_ai_oauth
        .as_ref()
        .and_then(|oauth| oauth.access_token.as_deref())
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Claude Code access token missing. Run `claude` to log in.".to_string())
}

fn claude_can_fetch_live_usage(auth: &ClaudeAuthState) -> bool {
    if auth.inference_only {
        return false;
    }
    let Some(scopes) = auth
        .credentials
        .claude_ai_oauth
        .as_ref()
        .and_then(|oauth| oauth.scopes.as_ref())
    else {
        return true;
    };
    scopes.is_empty() || scopes.iter().any(|scope| scope == "user:profile")
}

fn claude_needs_refresh(auth: &ClaudeAuthState) -> bool {
    let Some(expires_at) = auth
        .credentials
        .claude_ai_oauth
        .as_ref()
        .and_then(|oauth| oauth.expires_at)
    else {
        return false;
    };
    let now_ms = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
    expires_at - now_ms <= CLAUDE_REFRESH_BUFFER_MS
}

fn fetch_claude_usage(
    client: &reqwest::blocking::Client,
    auth: &ClaudeAuthState,
) -> Result<Value, CodexUsageFetchError> {
    let response = client
        .get(&auth.oauth_config.usage_url)
        .bearer_auth(claude_access_token(auth).map_err(CodexUsageFetchError::Other)?)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .header(reqwest::header::USER_AGENT, "claude-code/2.1.69")
        .send()
        .map_err(|error| {
            CodexUsageFetchError::Other(format_http_send_error("Claude Code usage", &error))
        })?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err(CodexUsageFetchError::Auth);
    }
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(CodexUsageFetchError::RateLimited(read_retry_after_seconds(
            response.headers(),
        )));
    }
    if !response.status().is_success() {
        return Err(CodexUsageFetchError::Other(format!(
            "Claude Code usage request failed (HTTP {})",
            response.status().as_u16()
        )));
    }
    response.json::<Value>().map_err(|error| {
        CodexUsageFetchError::Other(format!("Claude Code usage response invalid: {error}"))
    })
}

fn read_retry_after_seconds(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

fn refresh_claude_token(
    client: &reqwest::blocking::Client,
    auth: &mut ClaudeAuthState,
) -> Result<(), String> {
    *auth = reload_claude_auth_source(auth)?;
    let source_fingerprint = claude_auth_fingerprint(auth);
    let oauth = auth
        .credentials
        .claude_ai_oauth
        .as_mut()
        .ok_or_else(|| "Claude Code OAuth data missing. Run `claude` to log in.".to_string())?;
    let refresh_token = oauth
        .refresh_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            "Claude Code refresh token missing. Run `claude` to log in again.".to_string()
        })?;
    let response = client
        .post(&auth.oauth_config.refresh_url)
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": auth.oauth_config.client_id,
            "scope": CLAUDE_SCOPES,
        }))
        .send()
        .map_err(|error| format_http_send_error("Claude Code token refresh", &error))?;
    if !response.status().is_success() {
        return Err(format!(
            "Claude Code token refresh failed (HTTP {})",
            response.status().as_u16()
        ));
    }
    let refreshed = response
        .json::<OAuthRefreshResponse>()
        .map_err(|error| format!("Claude Code token refresh response invalid: {error}"))?;
    oauth.access_token = refreshed
        .access_token
        .or_else(|| oauth.access_token.clone());
    oauth.refresh_token = refreshed
        .refresh_token
        .or_else(|| oauth.refresh_token.clone());
    if let Some(expires_in) = refreshed.expires_in {
        oauth.expires_at =
            Some((time::OffsetDateTime::now_utc().unix_timestamp() + expires_in) * 1000);
    }
    save_claude_auth(auth, &source_fingerprint)?;
    Ok(())
}

fn reload_claude_auth_source(auth: &ClaudeAuthState) -> Result<ClaudeAuthState, String> {
    let credentials = if let Some(path) = &auth.file_path {
        let text = fs::read_to_string(path).map_err(|error| {
            format!(
                "Failed to re-read Claude Code credentials {}: {error}",
                path.display()
            )
        })?;
        parse_json_or_hex::<ClaudeCredentialsFile>(&text)
            .filter(claude_credentials_have_access_token)
            .ok_or_else(|| {
                format!(
                    "Claude Code credentials {} no longer contain a valid access token.",
                    path.display()
                )
            })?
    } else if let Some(service) = &auth.service_name {
        read_keychain_password(service, None)
            .and_then(|text| parse_json_or_hex::<ClaudeCredentialsFile>(&text))
            .filter(claude_credentials_have_access_token)
            .ok_or_else(|| {
                "Claude Code Keychain credentials are unavailable. Run `claude` to log in again."
                    .to_string()
            })?
    } else {
        return Err(
            "Claude Code environment token cannot be refreshed for live usage.".to_string(),
        );
    };

    Ok(ClaudeAuthState {
        credentials,
        service_name: auth.service_name.clone(),
        file_path: auth.file_path.clone(),
        inference_only: auth.inference_only,
        oauth_config: auth.oauth_config.clone(),
    })
}

fn save_claude_auth(
    auth: &ClaudeAuthState,
    expected_source_fingerprint: &str,
) -> Result<(), String> {
    if auth.inference_only {
        return Err(
            "Claude Code environment token cannot be refreshed for live usage.".to_string(),
        );
    }
    if claude_source_fingerprint(auth).as_deref() != Some(expected_source_fingerprint) {
        return Err("Claude Code credentials changed while refreshing; retry usage to use the newest login.".to_string());
    }
    let text = serde_json::to_string(&auth.credentials)
        .map_err(|error| format!("Failed to encode refreshed Claude Code credentials: {error}"))?;
    if let Some(path) = &auth.file_path {
        fs::write(path, text).map_err(|error| {
            format!(
                "Failed to save refreshed Claude Code credentials to {}: {error}",
                path.display()
            )
        })?;
    } else if let Some(service) = &auth.service_name {
        write_keychain_password(service, &text).map_err(|error| {
            format!("Failed to save refreshed Claude Code Keychain credentials: {error}")
        })?;
    } else {
        return Err("Claude Code credential source is unavailable for persistence.".to_string());
    }
    Ok(())
}

fn claude_source_fingerprint(auth: &ClaudeAuthState) -> Option<String> {
    let credentials = if let Some(path) = &auth.file_path {
        fs::read_to_string(path)
            .ok()
            .and_then(|text| parse_json_or_hex::<ClaudeCredentialsFile>(&text))
    } else if let Some(service) = &auth.service_name {
        read_keychain_password(service, None)
            .and_then(|text| parse_json_or_hex::<ClaudeCredentialsFile>(&text))
    } else {
        None
    }?;
    Some(claude_credentials_fingerprint(&credentials))
}

fn claude_credentials_fingerprint(credentials: &ClaudeCredentialsFile) -> String {
    let mut hasher = Sha256::new();
    if let Some(oauth) = credentials.claude_ai_oauth.as_ref() {
        for value in [&oauth.access_token, &oauth.refresh_token] {
            hasher.update(value.as_deref().unwrap_or_default().as_bytes());
            hasher.update([0]);
        }
    }
    format!("{:x}", hasher.finalize())
}

fn claude_auth_fingerprint(auth: &ClaudeAuthState) -> String {
    claude_credentials_fingerprint(&auth.credentials)
}

fn build_claude_usage_snapshot(usage: Value, auth: &ClaudeAuthState) -> CodexUsageSnapshot {
    let mut lines = Vec::new();
    for (key, label, period) in [
        ("five_hour", "Session", Some(5 * 60 * 60 * 1000)),
        ("seven_day", "Weekly", Some(7 * 24 * 60 * 60 * 1000)),
        (
            "seven_day_opus",
            "Opus weekly",
            Some(7 * 24 * 60 * 60 * 1000),
        ),
        (
            "seven_day_omelette",
            "Design weekly",
            Some(7 * 24 * 60 * 60 * 1000),
        ),
    ] {
        if let Some(window) = usage.get(key) {
            if let Some(used) = value_to_f64(window.get("utilization")) {
                lines.push(progress_metric(
                    label,
                    used,
                    maybe_string(window.get("resets_at")),
                    period,
                ));
            }
        }
    }
    if let Some(extra) = usage.get("extra_usage") {
        if value_to_f64(extra.get("used_credits")).unwrap_or(0.0) > 0.0
            || value_to_f64(extra.get("monthly_limit")).unwrap_or(0.0) > 0.0
        {
            let used = value_to_f64(extra.get("used_credits")).unwrap_or(0.0);
            let limit = value_to_f64(extra.get("monthly_limit")).unwrap_or(0.0);
            let value = if limit > 0.0 {
                format!(
                    "{} / {}",
                    dollars_from_cents(used),
                    dollars_from_cents(limit)
                )
            } else {
                dollars_from_cents(used)
            };
            lines.push(CodexMetricLine::Text {
                label: "Extra usage".to_string(),
                value,
            });
        }
    }
    CodexUsageSnapshot {
        provider_id: "claude".to_string(),
        display_name: "Claude Code".to_string(),
        plan: claude_plan_label(auth),
        lines,
        fetched_at: now_iso(),
    }
}

fn store_claude_last_good(
    auth: &ClaudeAuthState,
    snapshot: CodexUsageSnapshot,
) -> CodexUsageSnapshot {
    let cache = CLAUDE_LAST_GOOD_USAGE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut guard) = cache.lock() {
        guard.insert(claude_auth_fingerprint(auth), snapshot.clone());
    }
    snapshot
}

fn claude_rate_limited_snapshot(
    auth: &ClaudeAuthState,
    retry_after_seconds: Option<u64>,
) -> CodexUsageSnapshot {
    if let Some(mut snapshot) = read_claude_last_good(auth) {
        snapshot.lines.push(CodexMetricLine::Text {
            label: "Status".to_string(),
            value: claude_rate_limit_message(retry_after_seconds, true),
        });
        return snapshot;
    }
    build_claude_status_snapshot(auth, claude_rate_limit_message(retry_after_seconds, false))
}

fn read_claude_last_good(auth: &ClaudeAuthState) -> Option<CodexUsageSnapshot> {
    CLAUDE_LAST_GOOD_USAGE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|guard| guard.get(&claude_auth_fingerprint(auth)).cloned())
}

fn claude_rate_limit_message(retry_after_seconds: Option<u64>, has_cached_usage: bool) -> String {
    let retry = retry_after_seconds
        .map(format_retry_after)
        .map(|value| format!(" · retry in {value}"))
        .unwrap_or_default();
    if has_cached_usage {
        format!("Live usage rate limited{retry}; showing last good values.")
    } else {
        format!("Live usage rate limited{retry}. Try again shortly.")
    }
}

fn format_retry_after(seconds: u64) -> String {
    if seconds >= 3_600 {
        format!("{}h", ((seconds as f64) / 3_600.0).ceil() as u64)
    } else if seconds >= 60 {
        format!("{}m", ((seconds as f64) / 60.0).ceil() as u64)
    } else {
        format!("{}s", seconds.max(1))
    }
}

fn build_claude_status_snapshot(auth: &ClaudeAuthState, message: String) -> CodexUsageSnapshot {
    CodexUsageSnapshot {
        provider_id: "claude".to_string(),
        display_name: "Claude Code".to_string(),
        plan: claude_plan_label(auth),
        lines: vec![CodexMetricLine::Text {
            label: "Status".to_string(),
            value: message,
        }],
        fetched_at: now_iso(),
    }
}

fn claude_plan_label(auth: &ClaudeAuthState) -> Option<String> {
    let oauth = auth.credentials.claude_ai_oauth.as_ref()?;
    let base = oauth.subscription_type.as_deref().map(format_plan_label)?;
    let Some(tier) = oauth.rate_limit_tier.as_deref() else {
        return Some(base);
    };
    let Some(multiplier) = first_rate_limit_multiplier(tier) else {
        return Some(base);
    };
    Some(format!("{base} {multiplier}"))
}

fn first_rate_limit_multiplier(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    for start in 0..bytes.len() {
        if !bytes[start].is_ascii_digit() {
            continue;
        }
        let mut end = start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end < bytes.len() && bytes[end].eq_ignore_ascii_case(&b'x') {
            return Some(value[start..=end].to_string());
        }
    }
    None
}

#[derive(Debug, Clone)]
struct AntigravityLsDiscovery {
    pid: String,
    csrf: String,
    extension_port: Option<u16>,
}

#[derive(Debug, Clone, Default)]
struct AntigravityAuth {
    access_token: Option<String>,
    refresh_token: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AntigravityCloudError {
    Auth,
    Unavailable,
}

fn load_antigravity_auth() -> Option<AntigravityAuth> {
    let raw = read_keychain_password(AGY_KEYCHAIN_SERVICE, Some(AGY_KEYCHAIN_ACCOUNT))?;
    let text = unwrap_go_keyring(&raw)?;
    let value = serde_json::from_str::<Value>(&text).ok();
    let access_token = value
        .as_ref()
        .and_then(|value| {
            find_antigravity_auth_string(
                value,
                &[
                    "access_token",
                    "accessToken",
                    "token",
                    "id_token",
                    "idToken",
                    "bearerToken",
                    "auth_token",
                    "authToken",
                ],
            )
        })
        .or_else(|| {
            let text = text.strip_prefix("Bearer ").unwrap_or(&text).trim();
            (!text.is_empty()).then(|| text.to_string())
        });
    let refresh_token = value
        .as_ref()
        .and_then(|value| find_antigravity_auth_string(value, &["refresh_token", "refreshToken"]));
    if access_token.is_none() && refresh_token.is_none() {
        return None;
    }
    Some(AntigravityAuth {
        access_token,
        refresh_token,
    })
}

fn unwrap_go_keyring(raw: &str) -> Option<String> {
    let text = raw.trim();
    let text = if let Some(encoded) = text.strip_prefix("go-keyring-base64:") {
        let decoded = STANDARD.decode(encoded.trim()).ok()?;
        String::from_utf8(decoded).ok()?
    } else {
        text.to_string()
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn find_antigravity_auth_string(value: &Value, keys: &[&str]) -> Option<String> {
    if let Some(object) = value.as_object() {
        let source = object
            .get("token")
            .and_then(Value::as_object)
            .unwrap_or(object);
        for key in keys {
            if let Some(value) = source
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Some(value.to_string());
            }
        }
        for key in ["tokens", "oauth", "oauth2", "credentials", "auth"] {
            if let Some(nested) = object.get(key) {
                if let Some(value) = find_antigravity_auth_string(nested, keys) {
                    return Some(value);
                }
            }
        }
    }
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn fetch_antigravity_cloud_json(
    client: &reqwest::blocking::Client,
    path: &str,
    token: &str,
    user_agent: &str,
    body: &Value,
) -> Result<Value, AntigravityCloudError> {
    for base_url in AGY_CLOUD_CODE_BASE_URLS {
        let response = client
            .post(format!("{base_url}{path}"))
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
            .header(reqwest::header::USER_AGENT, user_agent)
            .json(body)
            .send();
        let Ok(response) = response else {
            continue;
        };
        if response.status() == reqwest::StatusCode::UNAUTHORIZED
            || response.status() == reqwest::StatusCode::FORBIDDEN
        {
            return Err(AntigravityCloudError::Auth);
        }
        if !response.status().is_success() {
            continue;
        }
        return response
            .json::<Value>()
            .map_err(|_| AntigravityCloudError::Unavailable);
    }
    Err(AntigravityCloudError::Unavailable)
}

fn fetch_antigravity_cloud_snapshot(
    client: &reqwest::blocking::Client,
    auth: &AntigravityAuth,
) -> Result<Option<CodexUsageSnapshot>, AntigravityCloudError> {
    let token = auth
        .access_token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
        .ok_or(AntigravityCloudError::Auth)?;
    let response = fetch_antigravity_cloud_json(
        client,
        AGY_CLOUD_QUOTA_SUMMARY_PATH,
        token,
        "antigravity",
        &serde_json::json!({}),
    )?;
    let Some(lines) = build_antigravity_quota_summary_lines(&response) else {
        return Ok(None);
    };
    let plan = fetch_antigravity_cloud_json(
        client,
        AGY_CLOUD_LOAD_CODE_ASSIST_PATH,
        token,
        "agy",
        &serde_json::json!({}),
    )
    .ok()
    .and_then(|value| read_antigravity_cloud_plan(&value));
    Ok(Some(CodexUsageSnapshot {
        provider_id: "agy".to_string(),
        display_name: "Antigravity".to_string(),
        plan,
        lines,
        fetched_at: now_iso(),
    }))
}

fn read_antigravity_cloud_plan(value: &Value) -> Option<String> {
    value
        .get("paidTier")
        .and_then(|tier| tier.get("name"))
        .and_then(Value::as_str)
        .map(format_plan_label)
        .or_else(|| {
            value
                .get("currentTier")
                .and_then(|tier| tier.get("name"))
                .and_then(Value::as_str)
                .map(format_plan_label)
        })
}

fn refresh_antigravity_auth(
    client: &reqwest::blocking::Client,
    auth: &mut AntigravityAuth,
) -> Result<(), AntigravityCloudError> {
    let refresh_token = auth
        .refresh_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or(AntigravityCloudError::Auth)?;
    let (client_id, client_secret) =
        load_antigravity_oauth_client().ok_or(AntigravityCloudError::Unavailable)?;
    let response = client
        .post(AGY_GOOGLE_OAUTH_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .map_err(|_| AntigravityCloudError::Unavailable)?;
    if response.status().is_success() {
        let body = response
            .json::<Value>()
            .map_err(|_| AntigravityCloudError::Unavailable)?;
        auth.access_token = body
            .get("access_token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .map(ToOwned::to_owned);
        return auth
            .access_token
            .as_ref()
            .map(|_| ())
            .ok_or(AntigravityCloudError::Unavailable);
    }
    if response.status().is_client_error() {
        Err(AntigravityCloudError::Auth)
    } else {
        Err(AntigravityCloudError::Unavailable)
    }
}

fn load_antigravity_oauth_client() -> Option<(String, String)> {
    let client_id = env_text(AGY_GOOGLE_CLIENT_ID_ENV);
    let client_secret = env_text(AGY_GOOGLE_CLIENT_SECRET_ENV);
    if let (Some(client_id), Some(client_secret)) = (client_id, client_secret) {
        return Some((client_id, client_secret));
    }

    let path = home_path(AGY_GOOGLE_OAUTH_CONFIG_PATH)?;
    let text = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&text).ok()?;
    parse_antigravity_oauth_client(&value)
}

fn parse_antigravity_oauth_client(value: &Value) -> Option<(String, String)> {
    let client_id = maybe_string(value.get("client_id"))?;
    let client_secret = maybe_string(value.get("client_secret"))?;
    Some((client_id, client_secret))
}

fn probe_antigravity_ls_usage() -> Option<CodexUsageSnapshot> {
    // Antigravity's language server listens on loopback with a self-signed
    // certificate, so the check has to come off to reach it at all. That makes this
    // client unsafe for anything else: it is named for its only legal destination,
    // every URL it is given comes from antigravity_ls_url (hardcoded to
    // LOOPBACK_HOST), and the two functions below assert that before sending.
    let loopback_client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent("Gyredeck")
        .danger_accept_invalid_certs(true)
        .build()
        .ok()?;

    for discovery in discover_antigravity_ls_processes() {
        let ports = discover_listening_ports(&discovery);
        for port in ports {
            for scheme in ["https", "http"] {
                if probe_antigravity_ls_port(&loopback_client, scheme, port, &discovery.csrf).is_none() {
                    continue;
                }
                if let Some(snapshot) =
                    fetch_antigravity_ls_snapshot(&loopback_client, scheme, port, &discovery.csrf)
                {
                    return Some(snapshot);
                }
            }
        }
    }

    None
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

fn discover_antigravity_ls_processes() -> Vec<AntigravityLsDiscovery> {
    let output = Command::new("ps")
        .args(["-ax", "-o", "pid=,command="])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    let Ok(text) = String::from_utf8(output.stdout) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let (pid, command) = trimmed.split_once(' ')?;
            let lower = command.to_lowercase();
            let is_antigravity_ls = lower.contains("language_server")
                && (lower.contains("antigravity") || lower.contains("antigravity-ide"));
            let is_agy_ls =
                lower.contains("/agy") || lower.starts_with("agy ") || lower.ends_with("/agy");
            if !is_antigravity_ls && !is_agy_ls {
                return None;
            }
            Some(AntigravityLsDiscovery {
                pid: pid.to_string(),
                csrf: extract_flag_value(command, "--csrf_token").unwrap_or_default(),
                extension_port: extract_flag_value(command, "--extension_server_port")
                    .and_then(|value| value.parse::<u16>().ok()),
            })
        })
        .collect()
}

fn extract_flag_value(command: &str, flag: &str) -> Option<String> {
    let parts = command.split_whitespace().collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        if *part == flag {
            return parts
                .get(index + 1)
                .map(|value| value.trim_matches('"').to_string());
        }
        if let Some(value) = part.strip_prefix(&format!("{flag}=")) {
            return Some(value.trim_matches('"').to_string());
        }
    }
    None
}

fn discover_listening_ports(discovery: &AntigravityLsDiscovery) -> Vec<u16> {
    let mut ports = Vec::new();
    if let Some(port) = discovery.extension_port {
        ports.push(port);
    }

    let output = Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", &discovery.pid])
        .output();
    if let Ok(output) = output {
        if let Ok(text) = String::from_utf8(output.stdout) {
            for line in text.lines().skip(1) {
                for token in line.split_whitespace() {
                    if let Some(port_text) = token.rsplit(':').next() {
                        if let Ok(port) = port_text.parse::<u16>() {
                            if !ports.contains(&port) {
                                ports.push(port);
                            }
                        }
                    }
                }
            }
        }
    }

    ports
}

/// True when an OAuth base URL is safe to send credentials to: TLS, or loopback where
/// the request never reaches a network.
fn is_confidential_oauth_url(url: &str) -> bool {
    if url.starts_with("https://") {
        return true;
    }
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or("");
    // IPv6 authorities bracket the host, so the port cannot simply be split on ':'.
    let host = match authority.strip_prefix('[') {
        Some(bracketed) => bracketed.split(']').next().unwrap_or(""),
        None => authority.split(':').next().unwrap_or(""),
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

/// The only host the certificate-skipping client above may ever be pointed at.
const LOOPBACK_HOST: &str = "127.0.0.1";

fn antigravity_ls_url(scheme: &str, port: u16, method: &str) -> String {
    format!("{scheme}://{LOOPBACK_HOST}:{port}/{AGY_LS_SERVICE}/{method}")
}

/// Guard for requests made with the certificate-skipping client. Skipping validation
/// is only defensible because the traffic never leaves the machine; this is what stops
/// a later caller from quietly widening that.
fn is_loopback_ls_url(url: &str) -> bool {
    url.starts_with(&format!("http://{LOOPBACK_HOST}:"))
        || url.starts_with(&format!("https://{LOOPBACK_HOST}:"))
}

fn antigravity_ls_headers(
    request: reqwest::blocking::RequestBuilder,
    csrf: &str,
) -> reqwest::blocking::RequestBuilder {
    request
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("Connect-Protocol-Version", "1")
        .header("x-codeium-csrf-token", csrf)
}

fn probe_antigravity_ls_port(
    client: &reqwest::blocking::Client,
    scheme: &str,
    port: u16,
    csrf: &str,
) -> Option<()> {
    let url = antigravity_ls_url(scheme, port, "GetUnleashData");
    // This client skips certificate validation; refuse to send anywhere but loopback.
    if !is_loopback_ls_url(&url) {
        return None;
    }
    let response = antigravity_ls_headers(client.post(url), csrf)
    .json(&serde_json::json!({
        "context": { "properties": { "devMode": "false", "extensionVersion": "unknown", "ide": "antigravity", "ideVersion": "unknown", "os": "macos" } }
    }))
    .send()
    .ok()?;
    if response.status().is_success() || response.status().is_client_error() {
        Some(())
    } else {
        None
    }
}

fn call_antigravity_ls(
    client: &reqwest::blocking::Client,
    scheme: &str,
    port: u16,
    csrf: &str,
    method: &str,
) -> Option<Value> {
    let url = antigravity_ls_url(scheme, port, method);
    // Same client, same rule: certificate validation is off, so loopback only.
    if !is_loopback_ls_url(&url) {
        return None;
    }
    let response = antigravity_ls_headers(client.post(url), csrf)
    .json(&serde_json::json!({
        "metadata": { "ideName": "antigravity", "extensionName": "antigravity", "ideVersion": "unknown", "locale": "en" }
    }))
    .send()
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Value>().ok()
}

fn fetch_antigravity_ls_snapshot(
    client: &reqwest::blocking::Client,
    scheme: &str,
    port: u16,
    csrf: &str,
) -> Option<CodexUsageSnapshot> {
    if let Some(snapshot) = fetch_antigravity_quota_summary_snapshot(client, scheme, port, csrf) {
        return Some(snapshot);
    }

    let user_status = call_antigravity_ls(client, scheme, port, csrf, "GetUserStatus");
    let (configs, plan) = if let Some(data) = user_status {
        let plan = data
            .get("userStatus")
            .and_then(|status| status.get("userTier"))
            .and_then(|tier| tier.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| {
                data.get("userStatus")
                    .and_then(|status| status.get("planStatus"))
                    .and_then(|plan_status| plan_status.get("planInfo"))
                    .and_then(|info| info.get("planName"))
                    .and_then(Value::as_str)
                    .map(format_plan_label)
            });
        let configs = data
            .get("userStatus")
            .and_then(|status| status.get("cascadeModelConfigData"))
            .and_then(|data| data.get("clientModelConfigs"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        (configs, plan)
    } else {
        let data = call_antigravity_ls(client, scheme, port, csrf, "GetCommandModelConfigs")?;
        let configs = data.get("clientModelConfigs")?.as_array()?.clone();
        (configs, None)
    };

    let lines = build_antigravity_config_lines(&configs);
    if lines.is_empty() {
        return None;
    }
    Some(CodexUsageSnapshot {
        provider_id: "agy".to_string(),
        display_name: "Antigravity".to_string(),
        plan,
        lines,
        fetched_at: now_iso(),
    })
}

fn fetch_antigravity_quota_summary_snapshot(
    client: &reqwest::blocking::Client,
    scheme: &str,
    port: u16,
    csrf: &str,
) -> Option<CodexUsageSnapshot> {
    let data = call_antigravity_ls(client, scheme, port, csrf, "RetrieveUserQuotaSummary")?;
    let response = data.get("response")?;
    let lines = build_antigravity_quota_summary_lines(response)?;
    let plan = call_antigravity_ls(client, scheme, port, csrf, "GetUserStatus")
        .and_then(|status| read_antigravity_user_status_plan(&status));

    Some(CodexUsageSnapshot {
        provider_id: "agy".to_string(),
        display_name: "Antigravity".to_string(),
        plan,
        lines,
        fetched_at: now_iso(),
    })
}

fn read_antigravity_user_status_plan(data: &Value) -> Option<String> {
    data.get("userStatus")
        .and_then(|status| status.get("userTier"))
        .and_then(|tier| tier.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            data.get("userStatus")
                .and_then(|status| status.get("planStatus"))
                .and_then(|plan_status| plan_status.get("planInfo"))
                .and_then(|info| info.get("planName"))
                .and_then(Value::as_str)
                .map(format_plan_label)
        })
}

fn build_antigravity_quota_summary_lines(response: &Value) -> Option<Vec<CodexMetricLine>> {
    let response = response.get("response").unwrap_or(response);
    let groups = response.get("groups").and_then(Value::as_array)?;

    const BUCKETS: [(&str, &str, u64); 4] = [
        ("gemini-5h", "Gemini 5h", 5 * 60 * 60 * 1000),
        ("gemini-weekly", "Gemini Weekly", 7 * 24 * 60 * 60 * 1000),
        ("3p-5h", "Claude and GPT 5h", 5 * 60 * 60 * 1000),
        (
            "3p-weekly",
            "Claude and GPT Weekly",
            7 * 24 * 60 * 60 * 1000,
        ),
    ];
    let mut resolved = BTreeMap::new();

    for bucket in groups
        .iter()
        .filter_map(|group| group.get("buckets").and_then(Value::as_array))
        .flatten()
    {
        let Some(id) = bucket.get("bucketId").and_then(Value::as_str) else {
            continue;
        };
        let Some((_, label, period_duration_ms)) = BUCKETS.iter().find(|(key, _, _)| *key == id)
        else {
            continue;
        };
        if resolved.contains_key(id) {
            continue;
        }
        let Some(remaining) = value_to_f64(bucket.get("remainingFraction")) else {
            continue;
        };
        let reset_time = bucket
            .get("resetTime")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        resolved.insert(
            id,
            CodexMetricLine::Progress {
                label: (*label).to_string(),
                used: ((1.0 - remaining.clamp(0.0, 1.0)) * 100.0).round(),
                limit: 100.0,
                format: CodexProgressFormat::Percent,
                resets_at: reset_time,
                period_duration_ms: Some(*period_duration_ms),
            },
        );
    }

    Some(
        BUCKETS
            .iter()
            .filter_map(|(id, _, _)| resolved.remove(*id))
            .collect(),
    )
}

fn build_antigravity_config_lines(configs: &[Value]) -> Vec<CodexMetricLine> {
    let mut groups: BTreeMap<&'static str, (f64, Option<String>)> = BTreeMap::new();
    for config in configs {
        let Some(label) = config
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let model_id = config
            .get("modelOrAlias")
            .and_then(|model| model.get("model"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if is_antigravity_blacklisted_model(model_id) {
            continue;
        }
        let quota = config.get("quotaInfo");
        let remaining = value_to_f64(quota.and_then(|value| value.get("remainingFraction")))
            .unwrap_or(0.0)
            .clamp(0.0, 1.0);
        let reset_time = quota
            .and_then(|value| value.get("resetTime"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        add_antigravity_quota_group(
            &mut groups,
            antigravity_quota_group_label(label),
            remaining,
            reset_time,
        );
    }
    build_antigravity_group_lines(groups)
}

fn antigravity_quota_group_label(label: &str) -> &'static str {
    let lower = label.to_lowercase();
    if lower.contains("gemini") {
        "Gemini models"
    } else {
        "Claude and GPT models"
    }
}

fn add_antigravity_quota_group(
    groups: &mut BTreeMap<&'static str, (f64, Option<String>)>,
    label: &'static str,
    remaining: f64,
    reset_time: Option<String>,
) {
    match groups.get(label) {
        Some((current_remaining, _)) if *current_remaining <= remaining => {}
        _ => {
            groups.insert(label, (remaining, reset_time));
        }
    }
}

fn build_antigravity_group_lines(
    groups: BTreeMap<&'static str, (f64, Option<String>)>,
) -> Vec<CodexMetricLine> {
    ["Gemini models", "Claude and GPT models"]
        .into_iter()
        .filter_map(|label| {
            groups
                .get(label)
                .map(|(remaining, reset_time)| (label, *remaining, reset_time.clone()))
        })
        .map(|(label, remaining, reset_time)| CodexMetricLine::Progress {
            label: label.to_string(),
            used: ((1.0 - remaining) * 100.0).round().clamp(0.0, 100.0),
            limit: 100.0,
            format: CodexProgressFormat::Percent,
            resets_at: reset_time,
            period_duration_ms: Some(5 * 60 * 60 * 1000),
        })
        .collect()
}

fn is_antigravity_blacklisted_model(model_id: &str) -> bool {
    matches!(
        model_id,
        "MODEL_CHAT_20706"
            | "MODEL_CHAT_23310"
            | "MODEL_GOOGLE_GEMINI_2_5_FLASH"
            | "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING"
            | "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE"
            | "MODEL_GOOGLE_GEMINI_2_5_PRO"
            | "MODEL_PLACEHOLDER_M19"
            | "MODEL_PLACEHOLDER_M9"
            | "MODEL_PLACEHOLDER_M12"
    )
}

fn read_percent_header(headers: &reqwest::header::HeaderMap, name: &str) -> Option<f64> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite())
}

fn format_codex_plan(plan: String) -> Option<String> {
    let trimmed = plan.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.eq_ignore_ascii_case("prolite") {
        return Some("Pro 5x".to_string());
    }
    if trimmed.eq_ignore_ascii_case("pro") {
        return Some("Pro 20x".to_string());
    }

    Some(
        trimmed
            .split(['_', '-'])
            .filter(|part| !part.is_empty())
            .map(|part| {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn unix_seconds_to_iso(seconds: i64) -> Option<String> {
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .and_then(|time| {
            time.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
}

#[tauri::command]
fn install_claude_hook(app: tauri::AppHandle) -> Result<String, String> {
    let install_path = claude_hook_install_path()?;
    let settings_path = claude_settings_path()?;

    let resource_path = app
        .path()
        .resolve(
            "gyredeck-claude-hook.mjs",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Failed to resolve resource: {e}"))?;

    let Some(parent) = install_path.parent() else {
        return Err("Failed to resolve config directory".to_string());
    };
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create config directory: {error}"))?;
    fs::copy(&resource_path, &install_path)
        .map_err(|error| format!("Failed to copy hook script: {error}"))?;

    let installed_path = install_path.to_string_lossy().to_string();

    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings.json: {e}"))?;
        if content.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse settings.json: {e}"))?
        }
    } else {
        serde_json::json!({})
    };

    if !settings.is_object() {
        settings = serde_json::json!({});
    }
    let root = settings.as_object_mut().expect("settings is object");
    let hooks_value = root
        .entry("hooks".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !hooks_value.is_object() {
        *hooks_value = serde_json::json!({});
    }
    let hooks = hooks_value.as_object_mut().expect("hooks is object");

    // Upgrading from the previous brand (agent-activity) left its hook registered;
    // strip it so it doesn't fire alongside Gyredeck and double every event.
    prune_hook_entries(hooks, "agent-activity");

    let mut register = |event: &str, entry: serde_json::Value| {
        let command = node_hook_command(&installed_path, event);
        if hook_entry_present(hooks, event, &command) {
            return;
        }
        let list = hooks
            .entry(event.to_string())
            .or_insert_with(|| serde_json::json!([]));
        if let Some(arr) = list.as_array_mut() {
            arr.push(entry);
        } else {
            *list = serde_json::json!([entry]);
        }
    };

    for event in CLAUDE_HOOK_MATCHED_EVENTS {
        let entry = serde_json::json!({
            "matcher": "*",
            "hooks": [{"type": "command", "command": node_hook_command(&installed_path, event)}]
        });
        register(event, entry);
    }
    for event in CLAUDE_HOOK_PLAIN_EVENTS {
        let entry = serde_json::json!({
            "hooks": [{"type": "command", "command": node_hook_command(&installed_path, event)}]
        });
        register(event, entry);
    }

    let Some(settings_parent) = settings_path.parent() else {
        return Err("Failed to resolve Claude settings directory".to_string());
    };
    fs::create_dir_all(settings_parent)
        .map_err(|error| format!("Failed to create Claude settings directory: {error}"))?;

    let json_string = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to stringify settings.json: {e}"))?;
    fs::write(&settings_path, format!("{json_string}\n"))
        .map_err(|error| format!("Failed to write settings.json: {error}"))?;

    Ok(installed_path)
}

#[tauri::command]
fn claude_hook_status() -> Result<(String, bool), String> {
    let install_path = claude_hook_install_path()?;
    let settings_path = claude_settings_path()?;
    let installed_path = install_path.to_string_lossy().to_string();

    let mut in_settings = false;
    if settings_path.exists() {
        if let Ok(content) = fs::read_to_string(&settings_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(hooks) = json.get("hooks").and_then(serde_json::Value::as_object) {
                    let command = node_hook_command(&installed_path, "Stop");
                    in_settings = hook_entry_present(hooks, "Stop", &command);
                }
            }
        }
    }

    let installed = install_path.exists() && in_settings;
    Ok((installed_path, installed))
}

#[tauri::command]
fn install_agy_hook(app: tauri::AppHandle) -> Result<String, String> {
    let install_path = agy_hook_install_path()?;
    let hooks_json_path = agy_hooks_json_path()?;

    let resource_path = app
        .path()
        .resolve(
            "gyredeck-agy-hook.mjs",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Failed to resolve resource: {e}"))?;

    let Some(parent) = install_path.parent() else {
        return Err("Failed to resolve config directory".to_string());
    };
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create config directory: {error}"))?;
    fs::copy(&resource_path, &install_path)
        .map_err(|error| format!("Failed to copy hook script: {error}"))?;

    let installed_path = install_path.to_string_lossy().to_string();

    let mut hooks_root: serde_json::Value = if hooks_json_path.exists() {
        let content = fs::read_to_string(&hooks_json_path)
            .map_err(|e| format!("Failed to read hooks.json: {e}"))?;
        if content.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse hooks.json: {e}"))?
        }
    } else {
        serde_json::json!({})
    };

    if !hooks_root.is_object() {
        hooks_root = serde_json::json!({});
    }
    let root = hooks_root.as_object_mut().expect("hooks.json is object");

    let entry = serde_json::json!({
        "PreToolUse": [{
            "matcher": ".*",
            "hooks": [{"type": "command", "command": node_hook_command(&installed_path, "PreToolUse")}]
        }],
        "PostToolUse": [{
            "matcher": ".*",
            "hooks": [{"type": "command", "command": node_hook_command(&installed_path, "PostToolUse")}]
        }],
        "PreInvocation": [
            {"type": "command", "command": node_hook_command(&installed_path, "PreInvocation")}
        ],
        "PostInvocation": [
            {"type": "command", "command": node_hook_command(&installed_path, "PostInvocation")}
        ],
        // Antigravity reads the Stop hook's response as a decision about whether the
        // turn may end, so the adapter must answer "allow" here. It once answered
        // "continue" — meaning "keep going" — and the agent replied to every finished
        // turn with "Stop hook blocked termination", looping forever.
        "Stop": [
            {"type": "command", "command": node_hook_command(&installed_path, "Stop")}
        ],
    });
    // Drop the previous brand's namespace so it can't fire alongside Gyredeck.
    root.remove("agent-activity");
    root.insert("gyredeck".to_string(), entry);

    let Some(hooks_parent) = hooks_json_path.parent() else {
        return Err("Failed to resolve Gemini config directory".to_string());
    };
    fs::create_dir_all(hooks_parent)
        .map_err(|error| format!("Failed to create Gemini config directory: {error}"))?;

    let json_string = serde_json::to_string_pretty(&hooks_root)
        .map_err(|e| format!("Failed to stringify hooks.json: {e}"))?;
    fs::write(&hooks_json_path, format!("{json_string}\n"))
        .map_err(|error| format!("Failed to write hooks.json: {error}"))?;

    Ok(installed_path)
}

#[tauri::command]
fn install_codex_hook(app: tauri::AppHandle) -> Result<String, String> {
    let install_path = codex_hook_install_path()?;
    let hooks_json_path = codex_hooks_json_path()?;

    let resource_path = app
        .path()
        .resolve(
            "gyredeck-codex-hook.mjs",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Failed to resolve resource: {e}"))?;

    let Some(parent) = install_path.parent() else {
        return Err("Failed to resolve config directory".to_string());
    };
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create config directory: {error}"))?;
    fs::copy(&resource_path, &install_path)
        .map_err(|error| format!("Failed to copy hook script: {error}"))?;

    let installed_path = install_path.to_string_lossy().to_string();

    // Unlike Antigravity's file, ~/.codex/hooks.json has no per-tool namespace — the
    // user's own hooks sit in the same event arrays. Entries are appended, never
    // replaced, and a refusal to overwrite unparsable JSON keeps a hand-written file
    // from being destroyed by a mis-click.
    let mut hooks_root: serde_json::Value = if hooks_json_path.exists() {
        let content = fs::read_to_string(&hooks_json_path)
            .map_err(|e| format!("Failed to read hooks.json: {e}"))?;
        if content.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&content).map_err(|e| {
                format!("Refusing to overwrite unparsable ~/.codex/hooks.json: {e}")
            })?
        }
    } else {
        serde_json::json!({})
    };
    if !hooks_root.is_object() {
        return Err("Refusing to overwrite ~/.codex/hooks.json: root is not an object".to_string());
    }

    let root = hooks_root.as_object_mut().expect("hooks root is object");
    let hooks_value = root
        .entry("hooks".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !hooks_value.is_object() {
        *hooks_value = serde_json::json!({});
    }
    let hooks = hooks_value.as_object_mut().expect("hooks is object");

    let mut register = |event: &str, entry: serde_json::Value| {
        let command = node_hook_command(&installed_path, event);
        if hook_entry_present(hooks, event, &command) {
            return;
        }
        let list = hooks
            .entry(event.to_string())
            .or_insert_with(|| serde_json::json!([]));
        if let Some(arr) = list.as_array_mut() {
            arr.push(entry);
        } else {
            *list = serde_json::json!([entry]);
        }
    };

    // async so Codex never waits on this. It only reports — it returns no decision on
    // PreToolUse or PermissionRequest — so blocking the agent on a localhost POST would
    // buy nothing and cost latency on every event.
    //
    // SessionEnd is the exception: Codex runs it synchronously whatever the config says,
    // and clamps its timeout to 3s. Declaring async there only earns two warnings on the
    // /hooks screen, so it is declared the way Codex will actually run it.
    let handler = |event: &str| {
        let ends_session = event == "SessionEnd";
        serde_json::json!({
            "type": "command",
            "command": node_hook_command(&installed_path, event),
            "async": !ends_session,
            "timeout": if ends_session { 3 } else { 5 }
        })
    };

    for event in CODEX_HOOK_MATCHED_EVENTS {
        register(
            event,
            serde_json::json!({ "matcher": ".*", "hooks": [handler(event)] }),
        );
    }
    for event in CODEX_HOOK_PLAIN_EVENTS {
        register(event, serde_json::json!({ "hooks": [handler(event)] }));
    }

    let Some(hooks_parent) = hooks_json_path.parent() else {
        return Err("Failed to resolve Codex config directory".to_string());
    };
    fs::create_dir_all(hooks_parent)
        .map_err(|error| format!("Failed to create Codex config directory: {error}"))?;

    let json_string = serde_json::to_string_pretty(&hooks_root)
        .map_err(|e| format!("Failed to stringify hooks.json: {e}"))?;
    fs::write(&hooks_json_path, format!("{json_string}\n"))
        .map_err(|error| format!("Failed to write hooks.json: {error}"))?;

    Ok(installed_path)
}

#[tauri::command]
fn codex_hook_status() -> Result<(String, bool), String> {
    let install_path = codex_hook_install_path()?;
    let hooks_json_path = codex_hooks_json_path()?;
    let installed_path = install_path.to_string_lossy().to_string();

    // Probe the exact command string for one event, the way the Claude status does:
    // the file existing says nothing about whether Codex will actually call it.
    let mut in_hooks = false;
    if hooks_json_path.exists() {
        if let Ok(content) = fs::read_to_string(&hooks_json_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(hooks) = json.get("hooks").and_then(|v| v.as_object()) {
                    in_hooks = hook_entry_present(
                        hooks,
                        "Stop",
                        &node_hook_command(&installed_path, "Stop"),
                    );
                }
            }
        }
    }

    Ok((installed_path, install_path.exists() && in_hooks))
}

#[tauri::command]
fn agy_hook_status() -> Result<(String, bool), String> {
    let install_path = agy_hook_install_path()?;
    let hooks_json_path = agy_hooks_json_path()?;
    let installed_path = install_path.to_string_lossy().to_string();

    let mut in_hooks = false;
    if hooks_json_path.exists() {
        if let Ok(content) = fs::read_to_string(&hooks_json_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                in_hooks = json.get("gyredeck").is_some();
            }
        }
    }

    let installed = install_path.exists() && in_hooks;
    Ok((installed_path, installed))
}


#[tauri::command]
fn focus_terminal(
    conversation_id: String,
    cwd: Option<String>,
    terminal: Option<String>,
) -> Result<String, String> {
    match terminal.as_deref() {
        Some("ghostty") => focus_ghostty_window(&conversation_id, cwd.as_deref()),
        Some("terminal") => focus_appleterminal_window(&conversation_id, cwd.as_deref()),
        _ => focus_iterm_window(&conversation_id, cwd.as_deref()),
    }
}

fn activate_iterm() -> Result<(), String> {
    let output = Command::new("open")
        .args(["-a", "iTerm"])
        .output()
        .map_err(|error| format!("Failed to launch iTerm: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        "Failed to activate iTerm".to_string()
    } else {
        format!("Failed to activate iTerm: {stderr}")
    })
}

fn focus_iterm_window(conversation_id: &str, cwd: Option<&str>) -> Result<String, String> {
    let hints = build_focus_hints(conversation_id, cwd);

    if let Ok(message) = focus_iterm_with_window_hints(&hints) {
        return Ok(message);
    }

    activate_iterm()?;
    Ok("Activated iTerm · exact terminal not found".to_string())
}

fn build_focus_hints(conversation_id: &str, cwd: Option<&str>) -> Vec<String> {
    let mut hints = Vec::new();
    let trimmed_conversation_id = conversation_id.trim();

    if !trimmed_conversation_id.is_empty() {
        hints.push(trimmed_conversation_id.to_string());
        hints.push(trimmed_conversation_id.chars().take(8).collect::<String>());
    }

    if let Some(cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) {
        hints.push(cwd.to_string());
        if let Some(name) = Path::new(cwd).file_name().and_then(|name| name.to_str()) {
            hints.push(name.to_string());
        }
    }

    hints.sort();
    hints.dedup();
    hints
}

fn focus_iterm_with_window_hints(hints: &[String]) -> Result<String, String> {
    let script = build_focus_iterm_script(hints);
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("Failed to run AppleScript: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "AppleScript focus failed".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.strip_prefix("matched:").is_some() {
        Ok(format!(
            "Focused iTerm · {}",
            stdout.trim_start_matches("matched:")
        ))
    } else {
        Ok("Activated iTerm · exact terminal not found".to_string())
    }
}

fn build_focus_iterm_script(hints: &[String]) -> String {
    let hints_source = hints
        .iter()
        .filter(|hint| !hint.trim().is_empty())
        .map(|hint| apple_script_string(hint))
        .collect::<Vec<_>>()
        .join(", ");
    let hints_source = if hints_source.is_empty() {
        "{}".to_string()
    } else {
        format!("{{{hints_source}}}")
    };

    format!(
        r#"set matchHints to {hints_source}
tell application "iTerm2"
  repeat with candidateWindow in windows
    set windowTitle to (name of candidateWindow) as text
    repeat with candidateTab in tabs of candidateWindow
      repeat with candidateSession in sessions of candidateTab
        set sessionName to (name of candidateSession) as text
        set sessionTty to ""
        try
          set sessionTty to (tty of candidateSession) as text
        end try
        set sessionPath to ""
        try
          set sessionPath to (get variable named "path" of candidateSession) as text
        end try
        repeat with matchHint in matchHints
          set hintText to matchHint as text
          if hintText is not "" then
            if sessionPath is hintText or sessionPath contains hintText or sessionName contains hintText or windowTitle contains hintText or sessionTty is hintText then
              select candidateWindow
              tell candidateTab to select
              tell candidateSession to select
              activate
              return "matched:" & sessionName
            end if
          end if
        end repeat
      end repeat
    end repeat
  end repeat
  activate
end tell
return "activated"
"#
    )
}

fn activate_ghostty() -> Result<(), String> {
    let output = Command::new("open")
        .args(["-a", "Ghostty"])
        .output()
        .map_err(|error| format!("Failed to launch Ghostty: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        "Failed to activate Ghostty".to_string()
    } else {
        format!("Failed to activate Ghostty: {stderr}")
    })
}

fn focus_ghostty_window(conversation_id: &str, cwd: Option<&str>) -> Result<String, String> {
    let hints = build_focus_hints(conversation_id, cwd);

    if let Ok(message) = focus_ghostty_with_window_hints(&hints) {
        return Ok(message);
    }

    activate_ghostty()?;
    Ok("Activated Ghostty · exact terminal not found".to_string())
}

fn focus_ghostty_with_window_hints(hints: &[String]) -> Result<String, String> {
    let script = build_focus_ghostty_script(hints);
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("Failed to run AppleScript: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "AppleScript focus failed".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.strip_prefix("matched:").is_some() {
        Ok(format!(
            "Focused Ghostty · {}",
            stdout.trim_start_matches("matched:")
        ))
    } else {
        Ok("Activated Ghostty · exact terminal not found".to_string())
    }
}

fn build_focus_ghostty_script(hints: &[String]) -> String {
    let hints_source = hints
        .iter()
        .filter(|hint| !hint.trim().is_empty())
        .map(|hint| apple_script_string(hint))
        .collect::<Vec<_>>()
        .join(", ");
    let hints_source = if hints_source.is_empty() {
        "{}".to_string()
    } else {
        format!("{{{hints_source}}}")
    };

    format!(
        r#"set matchHints to {hints_source}
tell application "Ghostty"
  repeat with candidateWindow in windows
    set windowTitle to name of candidateWindow as text
    set windowId to id of candidateWindow as text
    repeat with candidateTab in tabs of candidateWindow
      set tabTitle to name of candidateTab as text
      set tabId to id of candidateTab as text
      repeat with candidateTerminal in terminals of candidateTab
        set terminalTitle to name of candidateTerminal as text
        set terminalId to id of candidateTerminal as text
        set terminalCwd to working directory of candidateTerminal as text
        repeat with matchHint in matchHints
          set hintText to matchHint as text
          if hintText is not "" then
            if terminalCwd is hintText or terminalCwd contains hintText or terminalTitle contains hintText or tabTitle contains hintText or windowTitle contains hintText or terminalId is hintText or tabId is hintText or windowId is hintText then
              select tab candidateTab
              focus candidateTerminal
              activate window candidateWindow
              return "matched:" & terminalCwd & " · " & terminalTitle
            end if
          end if
        end repeat
      end repeat
    end repeat
  end repeat
  activate
end tell
return "activated"
"#
    )
}

fn activate_appleterminal() -> Result<(), String> {
    let output = Command::new("open")
        .args(["-a", "Terminal"])
        .output()
        .map_err(|error| format!("Failed to launch Terminal: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        "Failed to activate Terminal".to_string()
    } else {
        format!("Failed to activate Terminal: {stderr}")
    })
}

fn focus_appleterminal_window(conversation_id: &str, cwd: Option<&str>) -> Result<String, String> {
    let hints = build_focus_hints(conversation_id, cwd);

    if let Ok(message) = focus_appleterminal_with_window_hints(&hints) {
        return Ok(message);
    }

    activate_appleterminal()?;
    Ok("Activated Terminal · exact terminal not found".to_string())
}

fn focus_appleterminal_with_window_hints(hints: &[String]) -> Result<String, String> {
    let script = build_focus_appleterminal_script(hints);
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("Failed to run AppleScript: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "AppleScript focus failed".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if let Some(rest) = stdout.strip_prefix("matched:") {
        Ok(format!("Focused Terminal · {rest}"))
    } else {
        Ok("Activated Terminal · exact terminal not found".to_string())
    }
}

fn build_focus_appleterminal_script(hints: &[String]) -> String {
    let hints_source = hints
        .iter()
        .filter(|hint| !hint.trim().is_empty())
        .map(|hint| apple_script_string(hint))
        .collect::<Vec<_>>()
        .join(", ");
    let hints_source = if hints_source.is_empty() {
        "{}".to_string()
    } else {
        format!("{{{hints_source}}}")
    };

    // Terminal.app does not expose a session cwd, so match on window/tab title, the
    // running process name, and tty — then select that tab and bring it to front.
    format!(
        r#"set matchHints to {hints_source}
tell application "Terminal"
  repeat with candidateWindow in windows
    set windowTitle to ""
    try
      set windowTitle to (name of candidateWindow) as text
    end try
    repeat with candidateTab in tabs of candidateWindow
      set tabTitle to ""
      try
        set tabTitle to (custom title of candidateTab) as text
      end try
      set tabProcess to ""
      try
        set tabProcess to (processes of candidateTab) as text
      end try
      set tabTty to ""
      try
        set tabTty to (tty of candidateTab) as text
      end try
      repeat with matchHint in matchHints
        set hintText to matchHint as text
        if hintText is not "" then
          if tabTitle contains hintText or windowTitle contains hintText or tabProcess contains hintText or tabTty is hintText then
            set frontmost of candidateWindow to true
            set selected tab of candidateWindow to candidateTab
            activate
            return "matched:" & tabTitle
          end if
        end if
      end repeat
    end repeat
  end repeat
  activate
end tell
return "activated"
"#
    )
}

fn apple_script_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', " ")
        .replace('\r', " ");
    format!("\"{escaped}\"")
}

fn display_preference_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(DISPLAY_PREFERENCE_FILE))
        .map_err(|error| format!("Could not resolve Gyredeck config directory: {error}"))
}

fn read_display_preference(app: &tauri::AppHandle) -> Option<DisplayPreference> {
    let path = display_preference_path(app).ok()?;
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn write_display_preference(
    app: &tauri::AppHandle,
    preference: &DisplayPreference,
) -> Result<(), String> {
    let path = display_preference_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Display preference path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Gyredeck config directory: {error}"))?;
    let temporary_path = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(preference)
        .map_err(|error| format!("Could not encode display preference: {error}"))?;
    fs::write(&temporary_path, contents)
        .map_err(|error| format!("Could not write display preference: {error}"))?;
    fs::rename(&temporary_path, &path)
        .map_err(|error| format!("Could not save display preference: {error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn appkit_display_id(screen: &NSScreen) -> Option<String> {
    let description = screen.deviceDescription();
    let key = NSString::from_str("NSScreenNumber");
    let value = description.objectForKey(&key)?;
    // SAFETY: NSScreenNumber is documented as an NSNumber-compatible unsigned display id.
    let display_id: usize = unsafe { msg_send![&*value, unsignedIntegerValue] };
    Some(format!("macos:{display_id}"))
}

#[cfg(target_os = "macos")]
pub(crate) fn appkit_display_option(
    screen: &NSScreen,
    primary_display_id: Option<&str>,
) -> Option<DisplayOption> {
    let id = appkit_display_id(screen)?;
    let name = screen.localizedName().to_string();
    let frame = screen.frame();
    let backing_frame =
        screen.convertRectToBacking(NSRect::new(NSPoint::new(0.0, 0.0), frame.size));
    let width = backing_frame.size.width.max(1.0).round() as u32;
    let height = backing_frame.size.height.max(1.0).round() as u32;
    let scale_factor = if frame.size.width > 0.0 {
        backing_frame.size.width / frame.size.width
    } else {
        1.0
    };
    let fingerprint = format!("{name}|{width}x{height}|{scale_factor:.3}");

    Some(DisplayOption {
        is_primary: primary_display_id == Some(id.as_str()),
        id,
        fingerprint,
        name,
        width,
        height,
        scale_factor,
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn resolve_appkit_screen(
    screens: &NSArray<NSScreen>,
    preference: Option<&DisplayPreference>,
) -> (Option<Retained<NSScreen>>, bool) {
    if let Some(preference) = preference {
        if let Some(screen) = screens
            .iter()
            .find(|screen| appkit_display_id(screen).is_some_and(|id| id == preference.id))
        {
            return (Some(screen), false);
        }
        if let Some(screen) = screens.iter().find(|screen| {
            appkit_display_option(screen, None)
                .is_some_and(|option| option.fingerprint == preference.fingerprint)
        }) {
            return (Some(screen), false);
        }
    }

    (screens.iter().next(), preference.is_some())
}

#[cfg(target_os = "macos")]
fn display_state_for_platform(window: &tauri::WebviewWindow) -> Option<DisplayStateSnapshot> {
    let mtm = MainThreadMarker::new()?;
    let screens = NSScreen::screens(mtm);
    let primary_display_id = screens
        .iter()
        .next()
        .and_then(|screen| appkit_display_id(&screen));
    let preference = window.app_handle().state::<DisplayPreferenceState>().get();
    let (active_screen, fallback_active) = resolve_appkit_screen(&screens, preference.as_ref());
    let active_display_id = active_screen.as_deref().and_then(appkit_display_id);
    let selected_display_id = if preference.is_none() || !fallback_active {
        active_display_id.clone()
    } else {
        None
    };
    let displays = screens
        .iter()
        .filter_map(|screen| appkit_display_option(&screen, primary_display_id.as_deref()))
        .collect();

    Some(DisplayStateSnapshot {
        displays,
        preferred_display_id: preference.as_ref().map(|selection| selection.id.clone()),
        preferred_display_name: preference.map(|selection| selection.name),
        selected_display_id,
        active_display_id,
        fallback_active,
    })
}

#[cfg(not(target_os = "macos"))]
fn monitor_display_option(
    monitor: &tauri::window::Monitor,
    primary_id: Option<&str>,
) -> DisplayOption {
    let name = monitor
        .name()
        .cloned()
        .unwrap_or_else(|| "Display".to_string());
    let size = monitor.size();
    let position = monitor.position();
    let scale_factor = monitor.scale_factor();
    let fingerprint = format!("{name}|{}x{}|{scale_factor:.3}", size.width, size.height);
    let id = format!("monitor:{fingerprint}|{},{}", position.x, position.y);
    DisplayOption {
        is_primary: primary_id == Some(id.as_str()),
        id,
        fingerprint,
        name,
        width: size.width,
        height: size.height,
        scale_factor,
    }
}

#[cfg(not(target_os = "macos"))]
fn display_state_for_platform(window: &tauri::WebviewWindow) -> Option<DisplayStateSnapshot> {
    let monitors = window.available_monitors().ok()?;
    let primary = window.primary_monitor().ok().flatten();
    let primary_option = primary
        .as_ref()
        .map(|monitor| monitor_display_option(monitor, None));
    let primary_id = primary_option.as_ref().map(|option| option.id.as_str());
    let displays: Vec<_> = monitors
        .iter()
        .map(|monitor| monitor_display_option(monitor, primary_id))
        .collect();
    let preference = window.app_handle().state::<DisplayPreferenceState>().get();
    let matched = preferred_display_index(&displays, preference.as_ref())
        .and_then(|index| displays.get(index));
    let fallback_active = preference.is_some() && matched.is_none();
    let active_display_id = matched
        .map(|display| display.id.clone())
        .or_else(|| primary_option.map(|display| display.id))
        .or_else(|| displays.first().map(|display| display.id.clone()));
    let selected_display_id = if preference.is_none() || !fallback_active {
        active_display_id.clone()
    } else {
        None
    };

    Some(DisplayStateSnapshot {
        displays,
        preferred_display_id: preference.as_ref().map(|selection| selection.id.clone()),
        preferred_display_name: preference.map(|selection| selection.name),
        selected_display_id,
        active_display_id,
        fallback_active,
    })
}

#[tauri::command]
fn display_state(window: tauri::WebviewWindow) -> Result<DisplayStateSnapshot, String> {
    if let Some(state) = display_state_for_platform(&window) {
        return Ok(state);
    }

    let (sender, receiver) = mpsc::channel();
    let scheduled_window = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = sender.send(display_state_for_platform(&scheduled_window));
        })
        .map_err(|error| format!("Could not query displays: {error}"))?;

    receiver
        .recv_timeout(Duration::from_millis(500))
        .map_err(|_| "Timed out while querying displays".to_string())?
        .ok_or_else(|| "No displays are available".to_string())
}

#[tauri::command]
fn select_display(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    display_id: String,
) -> Result<DisplayStateSnapshot, String> {
    let current = display_state(window.clone())?;
    let selected = current
        .displays
        .iter()
        .find(|display| display.id == display_id)
        .ok_or_else(|| "That display is no longer connected".to_string())?;
    let preference = DisplayPreference {
        id: selected.id.clone(),
        fingerprint: selected.fingerprint.clone(),
        name: selected.name.clone(),
    };

    let preference_state = app.state::<DisplayPreferenceState>();
    let previous = preference_state.get();
    preference_state.set(Some(preference.clone()));
    if let Err(error) = position_main_window_on_selected_display(&window) {
        preference_state.set(previous.clone());
        let _ = position_main_window(&window);
        return Err(error);
    }
    if let Err(error) = write_display_preference(&app, &preference) {
        preference_state.set(previous);
        let _ = position_main_window(&window);
        return Err(error);
    }
    display_state(window)
}

fn position_main_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let width = f64::from(window.outer_size()?.width);
    position_main_window_for_physical_width(window, width)
}

#[cfg(target_os = "macos")]
fn main_window_matches_selected_frame(window: &tauri::WebviewWindow) -> Option<bool> {
    let mtm = MainThreadMarker::new()?;
    let ns_window_ptr = window.ns_window().ok()?;
    let screens = NSScreen::screens(mtm);
    let preference = window.app_handle().state::<DisplayPreferenceState>().get();
    let (screen, _) = resolve_appkit_screen(&screens, preference.as_ref());
    let screen = screen?;

    // SAFETY: Tauri owns this NSWindow and this helper only runs on AppKit's main thread.
    unsafe {
        let ns_window: &NSWindow = &*ns_window_ptr.cast();
        let frame = ns_window.frame();
        let screen_frame = screen.frame();
        let expected_x =
            screen_frame.origin.x + (screen_frame.size.width / 2.0) - (frame.size.width / 2.0);
        let expected_y = screen_frame.origin.y + screen_frame.size.height - frame.size.height;
        Some(
            (frame.origin.x - expected_x).abs() <= 1.0
                && (frame.origin.y - expected_y).abs() <= 1.0,
        )
    }
}

#[cfg(not(target_os = "macos"))]
fn main_window_matches_selected_frame(window: &tauri::WebviewWindow) -> Option<bool> {
    let preference = window.app_handle().state::<DisplayPreferenceState>().get();
    let monitors = window.available_monitors().ok()?;
    let monitor = preference
        .as_ref()
        .and_then(|selection| {
            monitors
                .iter()
                .find(|monitor| monitor_display_option(monitor, None).id == selection.id)
                .or_else(|| {
                    monitors.iter().find(|monitor| {
                        monitor_display_option(monitor, None).fingerprint == selection.fingerprint
                    })
                })
        })
        .cloned()
        .or(window.primary_monitor().ok().flatten())
        .or(window.current_monitor().ok().flatten())?;
    let frame_position = window.outer_position().ok()?;
    let frame_width = window.outer_size().ok()?.width;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let expected_x =
        monitor_position.x + ((monitor_size.width.saturating_sub(frame_width)) / 2) as i32;
    Some(frame_position.x == expected_x && frame_position.y == monitor_position.y)
}

#[tauri::command]
fn reconcile_display(window: tauri::WebviewWindow) -> Result<DisplayStateSnapshot, String> {
    reconcile_display_position(&window)?;
    display_state(window)
}

#[cfg(target_os = "macos")]
fn reconcile_display_position(window: &tauri::WebviewWindow) -> Result<(), String> {
    if let Some(matches) = main_window_matches_selected_frame(window) {
        if matches || position_main_window_with_appkit(window, None, false) {
            return Ok(());
        }
        return Err("Could not reconcile Gyredeck display position".to_string());
    }

    let (sender, receiver) = mpsc::channel();
    let scheduled_window = window.clone();
    window
        .run_on_main_thread(move || {
            let matches = main_window_matches_selected_frame(&scheduled_window) == Some(true);
            let positioned =
                matches || position_main_window_with_appkit(&scheduled_window, None, false);
            let _ = sender.send(positioned);
        })
        .map_err(|error| format!("Could not schedule display reconciliation: {error}"))?;

    if receiver
        .recv_timeout(Duration::from_millis(500))
        .unwrap_or(false)
    {
        Ok(())
    } else {
        Err("Timed out while reconciling Gyredeck display position".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn reconcile_display_position(window: &tauri::WebviewWindow) -> Result<(), String> {
    if main_window_matches_selected_frame(window) == Some(true) {
        return Ok(());
    }
    position_main_window(window)
        .map_err(|error| format!("Could not reconcile Gyredeck display position: {error}"))
}

#[cfg(target_os = "macos")]
fn position_main_window_on_selected_display(window: &tauri::WebviewWindow) -> Result<(), String> {
    if position_main_window_with_appkit(window, None, true) {
        return Ok(());
    }

    let (sender, receiver) = mpsc::channel();
    let scheduled_window = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = sender.send(position_main_window_with_appkit(
                &scheduled_window,
                None,
                true,
            ));
        })
        .map_err(|error| format!("Could not schedule display move: {error}"))?;

    if receiver
        .recv_timeout(Duration::from_millis(500))
        .unwrap_or(false)
    {
        Ok(())
    } else {
        Err("The selected display disconnected before Gyredeck could move".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn position_main_window_on_selected_display(window: &tauri::WebviewWindow) -> Result<(), String> {
    let state = display_state(window.clone())?;
    if state.selected_display_id.is_none() {
        return Err("The selected display disconnected before Gyredeck could move".to_string());
    }
    position_main_window(window)
        .map_err(|error| format!("Could not move Gyredeck to the selected display: {error}"))
}

fn position_main_window_for_physical_width(
    window: &tauri::WebviewWindow,
    width: f64,
) -> tauri::Result<()> {
    position_main_window_for_platform(window, width)
}

#[cfg(target_os = "macos")]
fn position_main_window_for_platform(
    window: &tauri::WebviewWindow,
    _width: f64,
) -> tauri::Result<()> {
    if position_main_window_with_appkit(window, None, false) {
        return Ok(());
    }

    let scheduled_window = window.clone();
    window.run_on_main_thread(move || {
        let _ = position_main_window_with_appkit(&scheduled_window, None, false);
    })?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn position_main_window_for_platform(
    window: &tauri::WebviewWindow,
    width: f64,
) -> tauri::Result<()> {
    let preference = window.app_handle().state::<DisplayPreferenceState>().get();
    let monitors = window.available_monitors()?;
    let monitor = preference
        .as_ref()
        .and_then(|selection| {
            monitors
                .iter()
                .find(|monitor| monitor_display_option(monitor, None).id == selection.id)
                .or_else(|| {
                    monitors.iter().find(|monitor| {
                        monitor_display_option(monitor, None).fingerprint == selection.fingerprint
                    })
                })
        })
        .cloned()
        .or(window.primary_monitor()?)
        .or(window.current_monitor()?);

    if let Some(monitor) = monitor {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let centered_offset =
            ((f64::from(monitor_size.width) - width).max(0.0) / 2.0).round() as i32;
        let x = monitor_position.x + centered_offset;
        window.set_position(tauri::PhysicalPosition::new(x, monitor_position.y))?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn position_main_window_with_appkit(
    window: &tauri::WebviewWindow,
    target_size: Option<(f64, f64)>,
    require_preferred_display: bool,
) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };

    let Ok(ns_window_ptr) = window.ns_window() else {
        return false;
    };
    let screens = NSScreen::screens(mtm);
    let preference = window.app_handle().state::<DisplayPreferenceState>().get();
    let (screen, fallback_active) = resolve_appkit_screen(&screens, preference.as_ref());
    if require_preferred_display && fallback_active {
        return false;
    }
    let Some(screen) = screen else {
        return false;
    };

    // SAFETY: Tauri gives us the backing NSWindow pointer for this WebviewWindow.
    // We only touch AppKit from the main thread (guarded above), matching AppKit's thread rules.
    unsafe {
        let ns_window: &NSWindow = &*ns_window_ptr.cast();
        let frame = ns_window.frame();
        let (width, height) = target_size.unwrap_or((frame.size.width, frame.size.height));
        let screen_frame = screen.frame();
        let x = screen_frame.origin.x + (screen_frame.size.width / 2.0) - (width / 2.0);
        let y = screen_frame.origin.y + screen_frame.size.height - height;

        if target_size.is_some() {
            ns_window.setFrame_display(
                NSRect::new(NSPoint::new(x, y), NSSize::new(width, height)),
                true,
            );
        } else {
            ns_window.setFrameOrigin(NSPoint::new(x, y));
        }
    }

    true
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// Toggle the menu-bar utility window: hide it if visible, otherwise show + focus.
/// The window is user-movable and keeps its position, so we never reposition it.
fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// Let the borderless window float onto the active Space — including over another
/// app's full-screen Space — so the tray toggle always surfaces it. Without
/// `FullScreenAuxiliary` a borderless window stays hidden behind full-screen apps.
#[cfg(target_os = "macos")]
fn configure_overlay_window(window: &tauri::WebviewWindow) {
    use objc2_app_kit::NSWindowCollectionBehavior;
    let Ok(ptr) = window.ns_window() else {
        return;
    };
    // SAFETY: Tauri owns this NSWindow; this runs on AppKit's main thread during setup.
    unsafe {
        let ns_window: &NSWindow = &*ptr.cast();
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    }
}

/// Whether the tray is currently showing the attention badge. Kept so a system
/// appearance change can re-pick the matching icon without the frontend re-sending.
#[derive(Default)]
struct TrayAttentionState(std::sync::atomic::AtomicBool);

/// Point the tray at the icon for `attention`, and set template mode to match.
///
/// The idle mark is a macOS template image, so the system tints it for the current menu
/// bar. The attention mark cannot be: its badge is red and template mode keeps only the
/// alpha channel. That also means it does not follow the appearance on its own, so one
/// file is rendered per theme and the matching one is chosen here — and re-chosen from
/// the ThemeChanged handler while the badge is up.
///
/// Both properties must be set on every transition. Leaving is_template false while
/// showing the white idle mark would make it invisible on a light menu bar.
fn apply_tray_icon(app: &tauri::AppHandle, attention: bool) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if !attention {
        let _ = tray.set_icon(Some(tauri::include_image!("icons/tray-icon.png")));
        let _ = tray.set_icon_as_template(true);
        return;
    }
    let dark = app
        .get_webview_window("main")
        .and_then(|window| window.theme().ok())
        .map(|theme| theme == tauri::Theme::Dark)
        .unwrap_or(true);
    let icon = if dark {
        tauri::include_image!("icons/tray-icon-attention-dark.png")
    } else {
        tauri::include_image!("icons/tray-icon-attention-light.png")
    };
    let _ = tray.set_icon(Some(icon));
    let _ = tray.set_icon_as_template(false);
}

/// Raise or clear the tray's attention badge. The frontend owns session state, so it
/// decides when any session is waiting on the user; this only renders that.
#[tauri::command]
fn set_tray_attention(app: tauri::AppHandle, active: bool) {
    app.state::<TrayAttentionState>()
        .0
        .store(active, std::sync::atomic::Ordering::Relaxed);
    apply_tray_icon(&app, active);
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, TRAY_SHOW, "Show Gyredeck", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, TRAY_HIDE, "Hide Overlay", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit])?;
    TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Gyredeck")
        .icon(tauri::include_image!("icons/tray-icon.png"))
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW => show_main_window(app),
            TRAY_HIDE => hide_main_window(app),
            TRAY_QUIT => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

/// GUI apps launched from Finder inherit a minimal PATH, so Homebrew (`gh`) and
/// nvm (`node`) binaries are not found. Import the login+interactive shell PATH
/// once at startup so every `Command::new(...)` and the bundled bridge resolve.
#[cfg(target_os = "macos")]
fn import_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let Ok(output) = Command::new(shell)
        .args(["-ilc", "printf '__AAPATH__%s__AAEND__' \"$PATH\""])
        .output()
    else {
        return;
    };
    let out = String::from_utf8_lossy(&output.stdout);
    if let (Some(start), Some(end)) = (out.find("__AAPATH__"), out.find("__AAEND__")) {
        let path = &out[start + "__AAPATH__".len()..end];
        if !path.is_empty() {
            std::env::set_var("PATH", path);
        }
    }
}

pub fn run() {
    // Credential-helper mode: `gyredeck-desktop git-credential <op>`. Answer git's
    // auth request from the token store and exit before any UI initialization.
    let mut cli = std::env::args().skip(1);
    if cli.next().as_deref() == Some("git-credential") {
        let op = cli.next().unwrap_or_default();
        github::run_credential_helper(&op);
        return;
    }

    #[cfg(target_os = "macos")]
    import_shell_path();

    let command_handler: Box<tauri::ipc::InvokeHandler<tauri::Wry>> =
        Box::new(tauri::generate_handler![
            agy_usage,
            bridge_health,
            get_bridge_port,
            mail_rooms,
            set_bridge_port,
            claude_usage,
            codex_usage,
            display_state,
            focus_terminal,
            install_claude_hook,
            claude_hook_status,
            install_agy_hook,
            agy_hook_status,
            install_codex_hook,
            codex_hook_status,
            github_repo_status,
            github_available_repos,
            github_accounts,
            github_switch_account,
            github_import_from_gh,
            import_from_glab,
            github_remove_account,
            get_sync_identity,
            set_sync_identity,
            device_start,
            device_poll,
            github_credential_helper_status,
            github_credential_helper_enable,
            github_credential_helper_disable,
            control_local_service,
            local_services,
            notification_permission_state,
            open_external_url,
            reconcile_display,
            request_notification_permission,
            set_keep_awake,
            set_tray_attention,
            select_display
        ]);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(KeepAwakeState::default())
        .manage(TrayAttentionState::default())
        .manage(DisplayPreferenceState::default())
        .manage(LocalServicesControlState::default())
        .manage(StandaloneBridgeState::default())
        .invoke_handler(move |invoke| command_handler(invoke))
        .setup(|app| {
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            notification::initialize();
            let preference = read_display_preference(app.handle());
            app.state::<DisplayPreferenceState>().set(preference);

            match app.path().resolve(
                "gyredeck-bridge.mjs",
                tauri::path::BaseDirectory::Resource,
            ) {
                Ok(path) => {
                    if let Err(error) = app.state::<StandaloneBridgeState>().start(path) {
                        eprintln!("Gyredeck standalone bridge is unavailable: {error}");
                    }
                }
                Err(error) => {
                    eprintln!("Gyredeck standalone bridge resource is unavailable: {error}");
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                configure_overlay_window(&window);
                let hide_target = window.clone();
                window.on_window_event(move |event| {
                    // Menu-bar utility window: closing hides instead of quitting. It stays
                    // open on focus loss so it can sit alongside other windows.
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = hide_target.hide();
                    }
                    // The attention icon is not a template image, so it does not follow
                    // the menu bar on its own — re-pick it when the appearance flips.
                    if let tauri::WindowEvent::ThemeChanged(_) = event {
                        let app = hide_target.app_handle();
                        if app
                            .state::<TrayAttentionState>()
                            .0
                            .load(std::sync::atomic::Ordering::Relaxed)
                        {
                            apply_tray_icon(app, true);
                        }
                    }
                });

                // The window is configured as visible: false so the overlay setup above
                // lands before its first paint; show it now that the setup is done.
                // Without this, launching the app put a tray icon on the menu bar and
                // nothing else — there is no Dock icon to bounce, so an explicit launch
                // looked like it had failed, and the window needed a second click on the
                // tray. RunEvent::Reopen only covers clicking the app icon while the app
                // is already running; macOS does not send it for a cold start.
                //
                // Every launch is user-initiated today. If launch-at-login is added, gate
                // this on the launch not coming from the login item, or the window will
                // appear on every boot.
                let _ = window.show();
                let _ = window.set_focus();
            }

            setup_tray(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Gyredeck desktop");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            app_handle.state::<StandaloneBridgeState>().stop();
            let _ = app_handle.state::<KeepAwakeState>().set_active(false);
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } if label == "main" => {
            let _ = app_handle.state::<KeepAwakeState>().set_active(false);
        }
        // Clicking the app icon (Launchpad/Dock/Finder) while the menu-bar app is
        // already running fires Reopen; surface the window instead of doing nothing.
        tauri::RunEvent::Reopen { .. } => {
            show_main_window(app_handle);
        }
        _ => {}
    });
}

#[cfg(test)]
mod transport_safety_tests {
    use super::*;

    #[test]
    fn loopback_guard_accepts_only_the_local_language_server() {
        assert!(is_loopback_ls_url(&antigravity_ls_url("https", 42100, "GetUserStatus")));
        assert!(is_loopback_ls_url(&antigravity_ls_url("http", 42100, "GetUserStatus")));
        // The client behind this guard skips certificate validation, so anything that
        // could leave the machine has to be refused — including hosts that merely look
        // local, and the loopback name appearing anywhere but the host.
        assert!(!is_loopback_ls_url("https://127.0.0.1.evil.test:443/x"));
        assert!(!is_loopback_ls_url("https://example.test/127.0.0.1:1/x"));
        assert!(!is_loopback_ls_url("https://localhost:42100/x"));
        assert!(!is_loopback_ls_url("https://10.0.0.5:42100/x"));
    }

    #[test]
    fn custom_oauth_url_must_be_tls_or_loopback() {
        assert!(is_confidential_oauth_url("https://api.anthropic.com"));
        assert!(is_confidential_oauth_url("http://localhost:8000"));
        assert!(is_confidential_oauth_url("http://127.0.0.1:8000"));
        assert!(is_confidential_oauth_url("http://[::1]:8000"));
        // A refresh token would cross the network in the clear.
        assert!(!is_confidential_oauth_url("http://api.anthropic.com"));
        assert!(!is_confidential_oauth_url("http://localhost.evil.test:8000"));
        assert!(!is_confidential_oauth_url("ftp://api.anthropic.com"));
        assert!(!is_confidential_oauth_url("api.anthropic.com"));
    }
}

#[cfg(test)]
mod display_selection_tests {
    use super::*;

    fn display(id: &str, fingerprint: &str) -> DisplayOption {
        DisplayOption {
            id: id.to_string(),
            fingerprint: fingerprint.to_string(),
            name: id.to_string(),
            width: 2560,
            height: 1440,
            scale_factor: 2.0,
            is_primary: id == "primary",
        }
    }

    #[test]
    fn selected_display_matches_exact_native_id_first() {
        let displays = vec![
            display("same-model-a", "studio"),
            display("external", "studio"),
        ];
        let preference = DisplayPreference {
            id: "external".to_string(),
            fingerprint: "studio".to_string(),
            name: "Studio Display".to_string(),
        };

        assert_eq!(
            preferred_display_index(&displays, Some(&preference)),
            Some(1)
        );
    }

    #[test]
    fn selected_display_recovers_by_fingerprint_when_native_id_changes() {
        let displays = vec![display("primary", "built-in"), display("new-id", "studio")];
        let preference = DisplayPreference {
            id: "old-id".to_string(),
            fingerprint: "studio".to_string(),
            name: "Studio Display".to_string(),
        };

        assert_eq!(
            preferred_display_index(&displays, Some(&preference)),
            Some(1)
        );
    }

    #[test]
    fn disconnected_preference_has_no_match_so_platform_can_fallback_to_primary() {
        let displays = vec![display("primary", "built-in")];
        let preference = DisplayPreference {
            id: "external".to_string(),
            fingerprint: "studio".to_string(),
            name: "Studio Display".to_string(),
        };

        assert_eq!(preferred_display_index(&displays, Some(&preference)), None);
        assert_eq!(preferred_display_index(&displays, None), None);
    }

    fn claude_auth(access_token: &str, refresh_token: &str) -> ClaudeAuthState {
        ClaudeAuthState {
            credentials: ClaudeCredentialsFile {
                claude_ai_oauth: Some(ClaudeOauth {
                    access_token: Some(access_token.to_string()),
                    refresh_token: Some(refresh_token.to_string()),
                    expires_at: None,
                    subscription_type: None,
                    rate_limit_tier: None,
                    scopes: Some(vec!["user:profile".to_string()]),
                }),
            },
            service_name: Some("Claude Code-credentials".to_string()),
            file_path: None,
            inference_only: false,
            oauth_config: ClaudeOauthConfig {
                usage_url: CLAUDE_USAGE_URL.to_string(),
                refresh_url: CLAUDE_REFRESH_URL.to_string(),
                client_id: CLAUDE_CLIENT_ID.to_string(),
                oauth_file_suffix: String::new(),
            },
        }
    }

    #[test]
    fn claude_environment_token_is_a_fallback_not_a_stored_login_override() {
        let stored = claude_auth("stored-access", "stored-refresh");
        let candidates = claude_auth_candidates_from(
            vec![stored.clone()],
            Some("environment-access".to_string()),
            stored.oauth_config.clone(),
        );

        assert_eq!(candidates.len(), 2);
        assert_eq!(
            claude_access_token(&candidates[0]).as_deref(),
            Ok("stored-access")
        );
        assert!(!candidates[0].inference_only);
        assert_eq!(
            claude_access_token(&candidates[1]).as_deref(),
            Ok("environment-access")
        );
        assert!(candidates[1].inference_only);
    }

    #[test]
    fn claude_last_good_cache_is_credential_scoped() {
        let first = claude_auth("first-access", "first-refresh");
        let second = claude_auth("second-access", "second-refresh");
        let snapshot = CodexUsageSnapshot {
            provider_id: "claude".to_string(),
            display_name: "Claude Code".to_string(),
            plan: Some("Max".to_string()),
            lines: vec![],
            fetched_at: now_iso(),
        };

        store_claude_last_good(&first, snapshot);
        assert!(read_claude_last_good(&first).is_some());
        assert!(read_claude_last_good(&second).is_none());
    }

    #[test]
    fn claude_rate_limit_keeps_the_last_good_timestamp() {
        let auth = claude_auth("first-access", "first-refresh");
        let snapshot = CodexUsageSnapshot {
            provider_id: "claude".to_string(),
            display_name: "Claude Code".to_string(),
            plan: Some("Max".to_string()),
            lines: vec![],
            fetched_at: "2026-07-25T12:00:00Z".to_string(),
        };

        store_claude_last_good(&auth, snapshot);
        let rate_limited = claude_rate_limited_snapshot(&auth, Some(60));

        assert_eq!(rate_limited.fetched_at, "2026-07-25T12:00:00Z");
        assert!(rate_limited
            .lines
            .iter()
            .any(|line| matches!(line, CodexMetricLine::Text { label, .. } if label == "Status")));
    }

    #[test]
    fn codex_history_cache_identity_includes_account_and_home() {
        let base_auth = CodexAuthFile {
            openai_api_key: None,
            tokens: Some(CodexAuthTokens {
                access_token: Some("access".to_string()),
                refresh_token: Some("refresh".to_string()),
                id_token: None,
                account_id: Some("account-a".to_string()),
            }),
            last_refresh: None,
        };
        let first = CodexAuthState {
            auth: base_auth.clone(),
            source: CodexAuthSource::File(PathBuf::from("/tmp/codex-a/auth.json")),
        };
        let mut other_account = base_auth;
        other_account.tokens.as_mut().unwrap().account_id = Some("account-b".to_string());
        let second = CodexAuthState {
            auth: other_account,
            source: CodexAuthSource::File(PathBuf::from("/tmp/codex-a/auth.json")),
        };

        assert_ne!(
            codex_ccusage_cache_key(&first),
            codex_ccusage_cache_key(&second)
        );
    }

    #[test]
    fn codex_history_day_keys_follow_the_given_local_offset() {
        let now = time::Date::from_calendar_date(2026, time::Month::July, 25)
            .unwrap()
            .with_hms(0, 30, 0)
            .unwrap()
            .assume_offset(time::UtcOffset::from_hms(7, 0, 0).unwrap());
        let (today, yesterday) = codex_history_day_keys(now);

        assert_eq!(today, "2026-07-25");
        assert_eq!(yesterday, "2026-07-24");
        assert_eq!(codex_ccusage_since_string_at(now, 30), "20260625");
    }

    #[test]
    fn ccusage_runner_stays_on_the_replay_safe_pinned_version() {
        assert_eq!(CCUSAGE_PACKAGE, "ccusage@20.0.18");
    }

    #[test]
    fn ccusage_publication_caches_before_releasing_waiters() {
        let cache = Mutex::new(None);
        let in_flight = Mutex::new(HashSet::from(["account-key".to_string()]));
        let usage = CcusageDailyUsage { daily: vec![] };

        publish_codex_ccusage_usage(&cache, &in_flight, "account-key".to_string(), &usage);

        assert!(cached_codex_ccusage_usage(&cache, "account-key").is_some());
        assert!(!in_flight.lock().unwrap().contains("account-key"));
    }

    #[test]
    fn codex_reset_credits_prefer_dedicated_expiries_and_fallback_to_embedded_count() {
        let usage: CodexUsageEnvelope = serde_json::from_value(serde_json::json!({
            "rate_limit_reset_credits": { "available_count": 1 }
        }))
        .unwrap();
        let dedicated: CodexResetCreditsEnvelope = serde_json::from_value(serde_json::json!({
            "available_count": 2,
            "credits": [
                { "status": "available", "expires_at": "2026-08-03T12:00:00Z" },
                { "status": "consumed", "expires_at": "2026-08-01T12:00:00Z" },
                { "expires_at": "2026-08-01T09:00:00Z" }
            ]
        }))
        .unwrap();

        let (available, expiries) = read_codex_reset_credits(&usage, Some(&dedicated)).unwrap();

        assert_eq!(available, 2);
        assert_eq!(expiries.len(), 2);
        assert!(
            format_reset_credit_value(available, &expiries).starts_with("2 available · expires ")
        );

        let malformed_dedicated: CodexResetCreditsEnvelope = serde_json::from_value(
            serde_json::json!({ "available_count": "unknown", "credits": [] }),
        )
        .unwrap();
        assert_eq!(
            read_codex_reset_credits(&usage, Some(&malformed_dedicated)).map(|(count, _)| count),
            Some(1)
        );
    }

    #[test]
    fn codex_mapping_classifies_windows_and_only_surfaces_spark() {
        let usage: CodexUsageEnvelope = serde_json::from_value(serde_json::json!({
            "rate_limit": {
                "primary_window": { "used_percent": 10, "limit_window_seconds": 604800 },
                "secondary_window": { "used_percent": 20, "limit_window_seconds": 18000 }
            },
            "additional_rate_limits": [
                {
                    "limit_name": "GPT-5.4-Codex",
                    "rate_limit": { "primary_window": { "used_percent": 30 } }
                },
                {
                    "metered_feature": "GPT-5.3-Codex-Spark",
                    "rate_limit": {
                        "primary_window": { "used_percent": 40, "limit_window_seconds": 18000 },
                        "secondary_window": { "used_percent": 50, "limit_window_seconds": 604800 }
                    }
                }
            ]
        }))
        .unwrap();

        let snapshot = build_codex_usage_snapshot(usage, &reqwest::header::HeaderMap::new(), None);
        let labels = snapshot
            .lines
            .iter()
            .filter_map(|line| match line {
                CodexMetricLine::Progress { label, .. } => Some(label.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();

        assert_eq!(labels, ["Session", "Weekly", "Spark", "Spark Weekly"]);
        assert!(!labels.iter().any(|label| label.contains("5.4")));
    }

    #[test]
    fn antigravity_summary_uses_only_exact_supported_bucket_ids() {
        let response = serde_json::json!({
            "groups": [{ "buckets": [
                { "bucketId": "gemini-5h", "displayName": "Renamed", "remainingFraction": 0.8 },
                { "bucketId": "3p-weekly", "remainingFraction": 0.4 },
                { "bucketId": "gemini-image-5h", "remainingFraction": 0.1 },
                { "bucketId": "gemini-weekly" }
            ] }]
        });

        let lines = build_antigravity_quota_summary_lines(&response).unwrap();
        let labels = lines
            .iter()
            .map(|line| match line {
                CodexMetricLine::Progress { label, .. } => label.as_str(),
                _ => unreachable!(),
            })
            .collect::<Vec<_>>();

        assert_eq!(labels, ["Gemini 5h", "Claude and GPT Weekly"]);
    }

    #[test]
    fn antigravity_valid_empty_summary_is_authoritative_no_data() {
        let response = serde_json::json!({ "groups": [] });

        assert!(matches!(
            build_antigravity_quota_summary_lines(&response),
            Some(lines) if lines.is_empty()
        ));
        assert!(build_antigravity_quota_summary_lines(&serde_json::json!({})).is_none());
    }

    #[test]
    fn antigravity_cloud_auth_unwraps_the_agy_keychain_shape() {
        let payload = r#"{"token":{"access_token":"access","refresh_token":"refresh"}}"#;
        let wrapped = format!("go-keyring-base64:{}", STANDARD.encode(payload));
        let text = unwrap_go_keyring(&wrapped).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();

        assert_eq!(
            find_antigravity_auth_string(&value, &["access_token"]),
            Some("access".to_string())
        );
        assert_eq!(
            find_antigravity_auth_string(&value, &["refresh_token"]),
            Some("refresh".to_string())
        );
    }

    #[test]
    fn antigravity_oauth_client_reads_local_config_shape_without_bundled_secret() {
        let value = serde_json::json!({
            "client_id": "local-client-id",
            "client_secret": "local-client-secret"
        });

        assert_eq!(
            parse_antigravity_oauth_client(&value),
            Some((
                "local-client-id".to_string(),
                "local-client-secret".to_string()
            ))
        );
        assert!(parse_antigravity_oauth_client(&serde_json::json!({
            "client_id": "local-client-id"
        }))
        .is_none());
    }

    #[test]
    fn antigravity_cloud_summary_accepts_the_bare_remote_envelope() {
        let response = serde_json::json!({
            "response": { "groups": [{ "buckets": [
                { "bucketId": "gemini-5h", "remainingFraction": 0.75 }
            ] }] }
        });

        let lines = build_antigravity_quota_summary_lines(&response).unwrap();

        assert!(matches!(
            lines.first(),
            Some(CodexMetricLine::Progress { label, used, .. })
                if label == "Gemini 5h" && *used == 25.0
        ));
    }
}
