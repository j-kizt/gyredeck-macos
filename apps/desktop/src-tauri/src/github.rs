use serde::Serialize;
use serde_json::Value;
use std::process::Command;
use std::time::Duration;

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const OAUTH_SCOPE: &str = "repo read:org workflow";

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

fn run_gh(args: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new("gh")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run gh (is the GitHub CLI installed?): {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "gh command failed".to_string()
        } else {
            stderr
        });
    }
    Ok(output.stdout)
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

fn latest_commit(repo: &str) -> Option<GithubCommit> {
    let bytes = run_gh(&["api", &format!("repos/{repo}/commits?per_page=1")]).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
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

fn recent_runs(repo: &str) -> Vec<GithubRun> {
    let Ok(bytes) = run_gh(&[
        "run",
        "list",
        "-R",
        repo,
        "--limit",
        "5",
        "--json",
        "status,conclusion,name,headBranch,createdAt",
    ]) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    value
        .as_array()
        .map(|runs| {
            runs.iter()
                .map(|run| GithubRun {
                    name: run.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                    status: run.get("status").and_then(Value::as_str).unwrap_or("").to_string(),
                    conclusion: run
                        .get("conclusion")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string),
                    branch: run.get("headBranch").and_then(Value::as_str).unwrap_or("").to_string(),
                    created_at: run.get("createdAt").and_then(Value::as_str).unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn open_pulls(repo: &str) -> Vec<GithubPull> {
    let Ok(bytes) = run_gh(&[
        "pr",
        "list",
        "-R",
        repo,
        "--json",
        "number,title,author,updatedAt",
    ]) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    value
        .as_array()
        .map(|pulls| {
            pulls
                .iter()
                .map(|pr| GithubPull {
                    number: pr.get("number").and_then(Value::as_u64).unwrap_or(0),
                    title: pr.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
                    author: pr
                        .get("author")
                        .and_then(|a| a.get("login"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    updated_at: pr.get("updatedAt").and_then(Value::as_str).unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn repo_status_blocking(repo: &str) -> Result<GithubRepoStatus, String> {
    if !is_valid_repo(repo) {
        return Err("Invalid repository (expected owner/name)".to_string());
    }
    let pulls = open_pulls(repo);
    Ok(GithubRepoStatus {
        repo: repo.to_string(),
        commit: latest_commit(repo),
        runs: recent_runs(repo),
        open_pr_count: pulls.len(),
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

fn available_repos_blocking() -> Result<Vec<String>, String> {
    let bytes = run_gh(&[
        "api",
        "user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
        "--jq",
        ".[].full_name",
    ])?;
    Ok(String::from_utf8_lossy(&bytes)
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect())
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
    let output = Command::new("gh")
        .args(["auth", "status"])
        .output()
        .map_err(|e| format!("Failed to run gh: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let mut accounts: Vec<GhAccount> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.split("Logged in to github.com account ").nth(1) {
            let login = rest.split_whitespace().next().unwrap_or("").to_string();
            if !login.is_empty() {
                accounts.push(GhAccount { login, active: false });
            }
        } else if trimmed.contains("Active account: true") {
            if let Some(last) = accounts.last_mut() {
                last.active = true;
            }
        }
    }
    Ok(accounts)
}

#[tauri::command]
pub async fn github_accounts() -> Result<Vec<GhAccount>, String> {
    tauri::async_runtime::spawn_blocking(accounts_blocking)
        .await
        .map_err(|e| e.to_string())?
}

fn switch_account_blocking(user: &str) -> Result<String, String> {
    if !is_valid_account(user) {
        return Err("Invalid account name".to_string());
    }
    run_gh(&["auth", "switch", "--hostname", "github.com", "--user", user])?;
    // Best-effort: keep git's commit identity in step with the active account.
    // gh auth switch only changes the token, not user.name/user.email.
    sync_global_git_identity();
    Ok(user.to_string())
}

/// Point global git user.name/user.email at the now-active gh account so commits are
/// authored by the right person. Uses the account's email when gh exposes it, else the
/// GitHub noreply address. Scoped to --global because the desktop app is not tied to a
/// repository; repos with their own local user config keep it and are unaffected.
fn sync_global_git_identity() {
    let Ok(bytes) = run_gh(&["api", "user", "--jq", "{login, id, email}"]) else {
        return;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return;
    };
    let Some(login) = value.get("login").and_then(Value::as_str) else {
        return;
    };
    let email = match value.get("email").and_then(Value::as_str) {
        Some(email) if !email.is_empty() => email.to_string(),
        _ => {
            let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
            format!("{id}+{login}@users.noreply.github.com")
        }
    };
    let _ = Command::new("git").args(["config", "--global", "user.name", login]).output();
    let _ = Command::new("git").args(["config", "--global", "user.email", &email]).output();
}

#[tauri::command]
pub async fn github_switch_account(user: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || switch_account_blocking(&user))
        .await
        .map_err(|e| e.to_string())?
}

// ── OAuth Device Flow (add a new account) ──

fn client_id() -> Result<String, String> {
    if let Ok(value) = std::env::var("AGENT_ACTIVITY_GITHUB_CLIENT_ID") {
        if !value.trim().is_empty() {
            return Ok(value.trim().to_string());
        }
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let path = std::path::PathBuf::from(home)
        .join(".config")
        .join("agent-activity")
        .join("github-oauth.json");
    let content = std::fs::read_to_string(&path).map_err(|_| {
        "No GitHub OAuth client id configured. Set AGENT_ACTIVITY_GITHUB_CLIENT_ID or create ~/.config/agent-activity/github-oauth.json with { \"client_id\": \"...\" }.".to_string()
    })?;
    let value: Value =
        serde_json::from_str(&content).map_err(|e| format!("Invalid github-oauth.json: {e}"))?;
    value
        .get("client_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "github-oauth.json is missing a non-empty client_id".to_string())
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
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

fn store_token_with_gh(token: &str) -> Result<Option<String>, String> {
    use std::io::Write;
    let mut child = Command::new("gh")
        .args(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run gh auth login: {e}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open gh stdin".to_string())?
        .write_all(format!("{token}\n").as_bytes())
        .map_err(|e| format!("Failed to pass token to gh: {e}"))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("gh auth login failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "gh auth login failed".to_string()
        } else {
            stderr
        });
    }
    // Resolve the newly authenticated login.
    let who = run_gh(&["api", "user", "--jq", ".login"]).ok();
    Ok(who.map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string()))
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
        let login = store_token_with_gh(token)?;
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
