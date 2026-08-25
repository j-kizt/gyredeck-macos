use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const OAUTH_SCOPE: &str = "repo read:org workflow";

const API_BASE: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";
const USER_AGENT: &str = "Gyredeck";
const MAX_REPOS: usize = 300;

// ── Token store (~/.config/gyredeck/github-accounts.json, mode 0600) ──

#[derive(Serialize, Deserialize, Clone)]
pub struct StoredAccount {
    pub login: String,
    pub id: u64,
    pub token: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct TokenStore {
    pub active: Option<String>,
    pub accounts: Vec<StoredAccount>,
}

fn store_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".config")
        .join("gyredeck")
        .join("github-accounts.json"))
}

fn load_store() -> Result<TokenStore, String> {
    let path = store_path()?;
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            serde_json::from_str(&content).map_err(|e| format!("Invalid github-accounts.json: {e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(TokenStore::default()),
        Err(e) => Err(format!("Failed to read github-accounts.json: {e}")),
    }
}

fn save_store(store: &TokenStore) -> Result<(), String> {
    let path = store_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize accounts: {e}"))?;
    // Atomic write: write to a temp file, chmod 0600, then rename over the target.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes())
        .map_err(|e| format!("Failed to write accounts file: {e}"))?;
    chmod_600(&tmp)?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Failed to persist accounts file: {e}"))?;
    Ok(())
}

#[cfg(unix)]
fn chmod_600(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("Failed to set permissions: {e}"))
}

#[cfg(not(unix))]
fn chmod_600(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

fn active_token() -> Result<String, String> {
    let store = load_store()?;
    let active = store
        .active
        .as_deref()
        .ok_or_else(|| "No active GitHub account. Import an account first.".to_string())?;
    store
        .accounts
        .iter()
        .find(|a| a.login == active)
        .map(|a| a.token.clone())
        .ok_or_else(|| "No active GitHub account. Import an account first.".to_string())
}

fn upsert_account(store: &mut TokenStore, account: StoredAccount) {
    if let Some(existing) = store.accounts.iter_mut().find(|a| a.login == account.login) {
        existing.id = account.id;
        existing.token = account.token;
    } else {
        store.accounts.push(account);
    }
}

// ── Validation (repo/account strings flow into `gh` arguments) ──

fn is_valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    ok(owner) && ok(name)
}

fn is_valid_account(user: &str) -> bool {
    !user.is_empty()
        && user.len() <= 39
        && user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

// ── REST client ──

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

/// Perform an authenticated GET against the GitHub REST API. `path` is either an
/// absolute URL (e.g. a Link-header "next" URL) or a path relative to the API base.
fn api_get(
    client: &reqwest::blocking::Client,
    token: &str,
    path: &str,
) -> Result<reqwest::blocking::Response, String> {
    let url = if path.starts_with("http") {
        path.to_string()
    } else {
        format!("{API_BASE}/{}", path.trim_start_matches('/'))
    };
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .header("X-GitHub-Api-Version", API_VERSION)
        .send()
        .map_err(|e| format!("GitHub request failed: {e}"))?;
    if response.status().as_u16() == 401 {
        return Err("GitHub token expired — re-import the account".to_string());
    }
    if !response.status().is_success() {
        return Err(format!("GitHub API returned {}", response.status()));
    }
    Ok(response)
}

fn api_get_json(
    client: &reqwest::blocking::Client,
    token: &str,
    path: &str,
) -> Result<Value, String> {
    api_get(client, token, path)?
        .json()
        .map_err(|e| format!("Invalid GitHub response: {e}"))
}

// ── Repo status ──

#[derive(Serialize, Clone)]
pub struct GithubCommit {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub committed_at: String,
}

#[derive(Serialize, Clone)]
pub struct GithubRun {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub branch: String,
    pub created_at: String,
}

#[derive(Serialize, Clone)]
pub struct GithubPull {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone)]
pub struct GithubRepoStatus {
    pub repo: String,
    pub commit: Option<GithubCommit>,
    pub runs: Vec<GithubRun>,
    pub open_pr_count: usize,
    pub pulls: Vec<GithubPull>,
    pub error: Option<String>,
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or("").trim().to_string()
}

const MAX_PULLS: usize = 20;

fn latest_commit(client: &reqwest::blocking::Client, token: &str, repo: &str) -> Option<GithubCommit> {
    let value = api_get_json(client, token, &format!("repos/{repo}/commits?per_page=1")).ok()?;
    let entry = value.as_array()?.first()?;
    let commit = entry.get("commit")?;
    let author = commit.get("author")?;
    Some(GithubCommit {
        sha: entry.get("sha").and_then(Value::as_str).unwrap_or("").chars().take(7).collect(),
        message: first_line(commit.get("message").and_then(Value::as_str).unwrap_or("")),
        author: author.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
        committed_at: author.get("date").and_then(Value::as_str).unwrap_or("").to_string(),
    })
}

fn recent_runs(client: &reqwest::blocking::Client, token: &str, repo: &str) -> Vec<GithubRun> {
    let Ok(value) = api_get_json(client, token, &format!("repos/{repo}/actions/runs?per_page=5"))
    else {
        return Vec::new();
    };
    value
        .get("workflow_runs")
        .and_then(Value::as_array)
        .map(|runs| {
            runs.iter()
                .map(|run| GithubRun {
                    name: run
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .or_else(|| run.get("display_title").and_then(Value::as_str))
                        .unwrap_or("")
                        .to_string(),
                    status: run.get("status").and_then(Value::as_str).unwrap_or("").to_string(),
                    conclusion: run
                        .get("conclusion")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string),
                    branch: run.get("head_branch").and_then(Value::as_str).unwrap_or("").to_string(),
                    created_at: run.get("created_at").and_then(Value::as_str).unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn open_pulls(client: &reqwest::blocking::Client, token: &str, repo: &str) -> (usize, Vec<GithubPull>) {
    let Ok(value) =
        api_get_json(client, token, &format!("repos/{repo}/pulls?state=open&per_page=100"))
    else {
        return (0, Vec::new());
    };
    let Some(array) = value.as_array() else {
        return (0, Vec::new());
    };
    let count = array.len();
    let pulls = array
        .iter()
        .take(MAX_PULLS)
        .map(|pr| GithubPull {
            number: pr.get("number").and_then(Value::as_u64).unwrap_or(0),
            title: pr.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
            author: pr
                .get("user")
                .and_then(|a| a.get("login"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            updated_at: pr.get("updated_at").and_then(Value::as_str).unwrap_or("").to_string(),
        })
        .collect();
    (count, pulls)
}

fn repo_status_blocking(repo: &str) -> Result<GithubRepoStatus, String> {
    if !is_valid_repo(repo) {
        return Err("Invalid repository (expected owner/name)".to_string());
    }
    // Don't hard-fail the tab: surface auth/setup problems as an error field.
    let (client, token) = match (http_client(), active_token()) {
        (Ok(client), Ok(token)) => (client, token),
        (Err(e), _) | (_, Err(e)) => {
            return Ok(GithubRepoStatus {
                repo: repo.to_string(),
                commit: None,
                runs: Vec::new(),
                open_pr_count: 0,
                pulls: Vec::new(),
                error: Some(e),
            });
        }
    };
    let (open_pr_count, pulls) = open_pulls(&client, &token, repo);
    Ok(GithubRepoStatus {
        repo: repo.to_string(),
        commit: latest_commit(&client, &token, repo),
        runs: recent_runs(&client, &token, repo),
        open_pr_count,
        pulls,
        error: None,
    })
}

#[tauri::command]
pub async fn github_repo_status(repo: String) -> Result<GithubRepoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || repo_status_blocking(&repo))
        .await
        .map_err(|e| e.to_string())?
}

// ── Accessible repositories (for the add-repo picker, current account only) ──

/// Parse the `rel="next"` URL out of a GitHub `Link` header, if present.
fn next_link(header: &str) -> Option<String> {
    for part in header.split(',') {
        let mut segments = part.split(';');
        let url = segments.next()?.trim().trim_start_matches('<').trim_end_matches('>');
        if segments.any(|s| s.trim() == "rel=\"next\"") {
            return Some(url.to_string());
        }
    }
    None
}

fn available_repos_blocking() -> Result<Vec<String>, String> {
    let client = http_client()?;
    let token = active_token()?;
    let mut repos: Vec<String> = Vec::new();
    let mut url = format!(
        "{API_BASE}/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=full_name"
    );
    loop {
        let response = api_get(&client, &token, &url)?;
        let next = response
            .headers()
            .get(reqwest::header::LINK)
            .and_then(|v| v.to_str().ok())
            .and_then(next_link);
        let value: Value = response.json().map_err(|e| format!("Invalid GitHub response: {e}"))?;
        if let Some(array) = value.as_array() {
            for repo in array {
                if let Some(name) = repo.get("full_name").and_then(Value::as_str) {
                    repos.push(name.to_string());
                }
            }
        }
        match next {
            Some(next_url) if repos.len() < MAX_REPOS => url = next_url,
            _ => break,
        }
    }
    Ok(repos)
}

#[tauri::command]
pub async fn github_available_repos() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(available_repos_blocking)
        .await
        .map_err(|e| e.to_string())?
}

// ── Accounts (switch between already-authenticated gh accounts) ──

#[derive(Serialize)]
pub struct GhAccount {
    pub login: String,
    pub active: bool,
}

fn accounts_blocking() -> Result<Vec<GhAccount>, String> {
    let store = load_store()?;
    Ok(store
        .accounts
        .iter()
        .map(|a| GhAccount {
            login: a.login.clone(),
            active: store.active.as_deref() == Some(a.login.as_str()),
        })
        .collect())
}

#[tauri::command]
pub async fn github_accounts() -> Result<Vec<GhAccount>, String> {
    tauri::async_runtime::spawn_blocking(accounts_blocking)
        .await
        .map_err(|e| e.to_string())?
}

/// Switch the locally-active account. Purely a Gyredeck-local preference — no `gh`
/// invocation and no system-wide effect.
/// Best-effort: point the global git identity at the store's active account.
/// Resolves the email from GitHub `/user` (falling back to the noreply address),
/// then sets `git config --global user.name/user.email`. Never fatal — a missing
/// git binary or offline API leaves the switch itself successful.
fn sync_git_identity(store: &TokenStore) {
    let Some(active) = store.active.as_deref() else {
        return;
    };
    let Some(account) = store.accounts.iter().find(|a| a.login == active) else {
        return;
    };
    let email = http_client()
        .ok()
        .and_then(|client| api_get_json(&client, &account.token, "user").ok())
        .and_then(|value| {
            value
                .get("email")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| {
            format!("{}+{}@users.noreply.github.com", account.id, account.login)
        });
    let _ = Command::new("git")
        .args(["config", "--global", "user.name", &account.login])
        .status();
    let _ = Command::new("git")
        .args(["config", "--global", "user.email", &email])
        .status();
}

fn switch_account_blocking(user: &str) -> Result<String, String> {
    if !is_valid_account(user) {
        return Err("Invalid account name".to_string());
    }
    let mut store = load_store()?;
    if !store.accounts.iter().any(|a| a.login == user) {
        return Err(format!("Account {user} is not imported"));
    }
    store.active = Some(user.to_string());
    save_store(&store)?;
    sync_git_identity(&store);
    sync_gh_active(user);
    Ok(user.to_string())
}

/// Best-effort: if the gh CLI is installed and knows this account, switch its
/// active account too so gh stays in sync with the one picked in Gyredeck. Never
/// fatal — a missing gh, or an account gh doesn't have, is silently ignored.
fn sync_gh_active(login: &str) {
    let gh_present = Command::new("gh")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if gh_present {
        let _ = Command::new("gh")
            .args(["auth", "switch", "--user", login])
            .status();
    }
}

#[tauri::command]
pub async fn github_switch_account(user: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || switch_account_blocking(&user))
        .await
        .map_err(|e| e.to_string())?
}

// ── Import tokens from the gh CLI (optional token importer) ──

/// Fetch a login + id from GitHub for the given token, then upsert it into the store.
fn import_token(
    client: &reqwest::blocking::Client,
    store: &mut TokenStore,
    token: &str,
) -> Result<String, String> {
    let value = api_get_json(client, token, "user")?;
    let login = value
        .get("login")
        .and_then(Value::as_str)
        .ok_or_else(|| "GitHub /user response missing login".to_string())?
        .to_string();
    let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
    upsert_account(
        store,
        StoredAccount { login: login.clone(), id, token: token.to_string() },
    );
    Ok(login)
}

/// Parse `gh auth status` output into (login, is_active) pairs.
fn gh_status_accounts() -> Vec<(String, bool)> {
    let Ok(output) = Command::new("gh").args(["auth", "status"]).output() else {
        return Vec::new();
    };
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let mut accounts: Vec<(String, bool)> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.split("Logged in to github.com account ").nth(1) {
            let login = rest.split_whitespace().next().unwrap_or("").to_string();
            if !login.is_empty() {
                accounts.push((login, false));
            }
        } else if trimmed.contains("Active account: true") {
            if let Some(last) = accounts.last_mut() {
                last.1 = true;
            }
        }
    }
    accounts
}

fn gh_token_for(login: Option<&str>) -> Option<String> {
    let mut args = vec!["auth", "token"];
    if let Some(login) = login {
        args.push("--user");
        args.push(login);
    }
    let output = Command::new("gh").args(&args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

fn import_from_gh_blocking() -> Result<Vec<GhAccount>, String> {
    // Fail fast if gh isn't installed.
    if Command::new("gh").arg("--version").output().is_err() {
        return Err("GitHub CLI not found".to_string());
    }
    let client = http_client()?;
    let mut store = load_store()?;
    let gh_accounts = gh_status_accounts();

    let mut imported: Vec<String> = Vec::new();
    let mut gh_active: Option<String> = None;

    if gh_accounts.is_empty() {
        // No parsed logins — fall back to the currently-active gh token.
        let token = gh_token_for(None).ok_or_else(|| "No gh accounts found".to_string())?;
        let login = import_token(&client, &mut store, &token)?;
        gh_active = Some(login.clone());
        imported.push(login);
    } else {
        for (login, active) in &gh_accounts {
            // Prefer per-login tokens; fall back to the active token when --user is
            // unsupported and this is the active account.
            let token = match gh_token_for(Some(login)) {
                Some(token) => token,
                None if *active => match gh_token_for(None) {
                    Some(token) => token,
                    None => continue,
                },
                None => continue,
            };
            match import_token(&client, &mut store, &token) {
                Ok(resolved) => {
                    if *active {
                        gh_active = Some(resolved.clone());
                    }
                    imported.push(resolved);
                }
                Err(_) => continue,
            }
        }
    }

    if imported.is_empty() {
        return Err("Could not import any gh accounts".to_string());
    }
    store.active = gh_active.or_else(|| imported.first().cloned());
    save_store(&store)?;
    sync_git_identity(&store);
    accounts_blocking()
}

#[tauri::command]
pub async fn github_import_from_gh() -> Result<Vec<GhAccount>, String> {
    tauri::async_runtime::spawn_blocking(import_from_gh_blocking)
        .await
        .map_err(|e| e.to_string())?
}

fn remove_account_blocking(user: &str) -> Result<Vec<GhAccount>, String> {
    if !is_valid_account(user) {
        return Err("Invalid account name".to_string());
    }
    let mut store = load_store()?;
    store.accounts.retain(|a| a.login != user);
    if store.active.as_deref() == Some(user) {
        store.active = store.accounts.first().map(|a| a.login.clone());
    }
    save_store(&store)?;
    accounts_blocking()
}

#[tauri::command]
pub async fn github_remove_account(user: String) -> Result<Vec<GhAccount>, String> {
    tauri::async_runtime::spawn_blocking(move || remove_account_blocking(&user))
        .await
        .map_err(|e| e.to_string())?
}

// ── OAuth Device Flow (add a new account) ──

/// Resolve the GitHub OAuth **client id** for the device flow. A client id is a
/// public identifier (not a secret), but we keep it out of source: it is baked in
/// at build time from the `GYREDECK_GITHUB_CLIENT_ID` CI secret via `option_env!`.
/// A runtime env var or per-machine config file can override it for local dev.
fn client_id() -> Result<String, String> {
    // 1. Runtime env override (local dev).
    if let Ok(value) = std::env::var("GYREDECK_GITHUB_CLIENT_ID") {
        if !value.trim().is_empty() {
            return Ok(value.trim().to_string());
        }
    }
    // 2. Per-machine config file override.
    if let Ok(home) = std::env::var("HOME") {
        let path = std::path::PathBuf::from(home)
            .join(".config")
            .join("gyredeck")
            .join("github-oauth.json");
        if let Ok(content) = std::fs::read_to_string(&path) {
            let value: Value = serde_json::from_str(&content)
                .map_err(|e| format!("Invalid github-oauth.json: {e}"))?;
            if let Some(id) = value
                .get("client_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                return Ok(id.to_string());
            }
        }
    }
    // 3. Baked in at build time from the CI secret.
    match option_env!("GYREDECK_GITHUB_CLIENT_ID") {
        Some(id) if !id.is_empty() => Ok(id.to_string()),
        _ => Err("GitHub sign-in isn't configured in this build. Set GYREDECK_GITHUB_CLIENT_ID or add ~/.config/gyredeck/github-oauth.json with { \"client_id\": \"...\" }.".to_string()),
    }
}

#[derive(Serialize)]
pub struct DeviceCodeStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

fn device_start_blocking() -> Result<DeviceCodeStart, String> {
    let client_id = client_id()?;
    let client = http_client()?;
    let response = client
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.as_str()), ("scope", OAUTH_SCOPE)])
        .send()
        .map_err(|e| format!("Device code request failed: {e}"))?;
    let value: Value = response
        .json()
        .map_err(|e| format!("Invalid device code response: {e}"))?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(format!("GitHub rejected the device request: {error}"));
    }
    Ok(DeviceCodeStart {
        device_code: value.get("device_code").and_then(Value::as_str).unwrap_or("").to_string(),
        user_code: value.get("user_code").and_then(Value::as_str).unwrap_or("").to_string(),
        verification_uri: value
            .get("verification_uri")
            .and_then(Value::as_str)
            .unwrap_or("https://github.com/login/device")
            .to_string(),
        interval: value.get("interval").and_then(Value::as_u64).unwrap_or(5),
        expires_in: value.get("expires_in").and_then(Value::as_u64).unwrap_or(900),
    })
}

#[tauri::command]
pub async fn github_device_start() -> Result<DeviceCodeStart, String> {
    tauri::async_runtime::spawn_blocking(device_start_blocking)
        .await
        .map_err(|e| e.to_string())?
}

/// Poll status: "pending" (keep polling), "success" (account added), or an error string.
#[derive(Serialize)]
pub struct DevicePollResult {
    pub status: String,
    pub login: Option<String>,
}

/// Persist a device-flow token into the local store and mark it active.
fn store_device_token(token: &str) -> Result<Option<String>, String> {
    let client = http_client()?;
    let mut store = load_store()?;
    let login = import_token(&client, &mut store, token)?;
    store.active = Some(login.clone());
    save_store(&store)?;
    sync_git_identity(&store);
    Ok(Some(login))
}

fn device_poll_blocking(device_code: &str) -> Result<DevicePollResult, String> {
    let client_id = client_id()?;
    let client = http_client()?;
    let response = client
        .post(ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .map_err(|e| format!("Token poll failed: {e}"))?;
    let value: Value = response
        .json()
        .map_err(|e| format!("Invalid token response: {e}"))?;

    if let Some(token) = value.get("access_token").and_then(Value::as_str) {
        let login = store_device_token(token)?;
        return Ok(DevicePollResult { status: "success".to_string(), login });
    }
    match value.get("error").and_then(Value::as_str) {
        Some("authorization_pending") | Some("slow_down") => {
            Ok(DevicePollResult { status: "pending".to_string(), login: None })
        }
        Some(other) => Err(format!("Authorization failed: {other}")),
        None => Err("Unexpected token response".to_string()),
    }
}

#[tauri::command]
pub async fn github_device_poll(device_code: String) -> Result<DevicePollResult, String> {
    tauri::async_runtime::spawn_blocking(move || device_poll_blocking(&device_code))
        .await
        .map_err(|e| e.to_string())?
}

// ── Git credential helper (Gyredeck as a gh-free credential source) ──
//
// When enabled, git is pointed at `gyredeck-desktop git-credential`, which answers
// HTTPS auth for GitHub from the local token store — so `git push` follows the
// account you pick in Gyredeck, without needing the gh CLI. Toggled from Settings.

const CREDENTIAL_HOSTS: [&str; 2] = ["github.com", "gist.github.com"];
const CREDENTIAL_CONFIG_HOSTS: [&str; 2] = ["https://github.com", "https://gist.github.com"];

#[derive(Serialize)]
pub struct CredentialHelperStatus {
    pub installed: bool,
    pub path: String,
}

/// Handle a `git-credential <op>` invocation. Git sends a key=value request on
/// stdin; we answer `get` from the token store and no-op `store`/`erase`. Runs
/// before any Tauri/UI init and must exit promptly.
pub fn run_credential_helper(op: &str) {
    use std::io::{Read, Write};
    if op != "get" {
        return;
    }
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return;
    }
    let mut host = String::new();
    let mut wanted_user = String::new();
    for line in input.lines() {
        if let Some(value) = line.strip_prefix("host=") {
            host = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("username=") {
            wanted_user = value.trim().to_string();
        }
    }
    if !CREDENTIAL_HOSTS.contains(&host.as_str()) {
        return;
    }
    let Ok(store) = load_store() else {
        return;
    };
    // Prefer an explicit username from the remote URL; otherwise the active account.
    let account = store
        .accounts
        .iter()
        .find(|a| !wanted_user.is_empty() && a.login == wanted_user)
        .or_else(|| {
            let active = store.active.as_deref()?;
            store.accounts.iter().find(|a| a.login == active)
        });
    let Some(account) = account else {
        return;
    };
    let mut out = std::io::stdout();
    let _ = write!(
        out,
        "protocol=https\nhost={host}\nusername={}\npassword={}\n",
        account.login, account.token
    );
    let _ = out.flush();
}

fn helper_command_value() -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Cannot resolve executable path: {e}"))?
        .to_string_lossy()
        .to_string();
    Ok(format!("!'{exe}' git-credential"))
}

fn credential_helper_installed() -> Result<CredentialHelperStatus, String> {
    let path = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let output = Command::new("git")
        .args(["config", "--global", "--get-all", "credential.https://github.com.helper"])
        .output()
        .map_err(|e| format!("git is not available: {e}"))?;
    let installed = String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        let lower = line.to_lowercase();
        lower.contains("git-credential") && lower.contains("gyredeck")
    });
    Ok(CredentialHelperStatus { installed, path })
}

fn credential_helper_enable_blocking() -> Result<CredentialHelperStatus, String> {
    let helper = helper_command_value()?;
    for host in CREDENTIAL_CONFIG_HOSTS {
        let key = format!("credential.{host}.helper");
        // Clear prior values, then an empty helper (drops the inherited osxkeychain)
        // followed by ours — the same reset pattern `gh auth setup-git` uses.
        let _ = Command::new("git").args(["config", "--global", "--unset-all", &key]).status();
        git_config_add(&key, "")?;
        git_config_add(&key, &helper)?;
    }
    credential_helper_installed()
}

fn credential_helper_disable_blocking() -> Result<CredentialHelperStatus, String> {
    for host in CREDENTIAL_CONFIG_HOSTS {
        let key = format!("credential.{host}.helper");
        let _ = Command::new("git").args(["config", "--global", "--unset-all", &key]).status();
    }
    credential_helper_installed()
}

fn git_config_add(key: &str, value: &str) -> Result<(), String> {
    let status = Command::new("git")
        .args(["config", "--global", "--add", key, value])
        .status()
        .map_err(|e| format!("git is not available: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("git config failed for {key}"))
    }
}

#[tauri::command]
pub async fn github_credential_helper_status() -> Result<CredentialHelperStatus, String> {
    tauri::async_runtime::spawn_blocking(credential_helper_installed)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn github_credential_helper_enable() -> Result<CredentialHelperStatus, String> {
    tauri::async_runtime::spawn_blocking(credential_helper_enable_blocking)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn github_credential_helper_disable() -> Result<CredentialHelperStatus, String> {
    tauri::async_runtime::spawn_blocking(credential_helper_disable_blocking)
        .await
        .map_err(|e| e.to_string())?
}
