use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const API_VERSION: &str = "2022-11-28";
const USER_AGENT: &str = "Gyredeck";
const MAX_REPOS: usize = 300;
// Refresh an OAuth token this many seconds before it actually expires.
const TOKEN_REFRESH_BUFFER_SECS: u64 = 60;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── Providers ──

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Github,
    Gitlab,
}

impl Default for Provider {
    fn default() -> Self {
        Provider::Github
    }
}

impl Provider {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "github" => Some(Provider::Github),
            "gitlab" => Some(Provider::Gitlab),
            _ => None,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Provider::Github => "github",
            Provider::Gitlab => "gitlab",
        }
    }

    fn api_base(&self) -> &'static str {
        match self {
            Provider::Github => "https://api.github.com",
            Provider::Gitlab => "https://gitlab.com/api/v4",
        }
    }

    fn label(&self) -> &'static str {
        match self {
            Provider::Github => "GitHub",
            Provider::Gitlab => "GitLab",
        }
    }

    fn device_code_url(&self) -> &'static str {
        match self {
            Provider::Github => "https://github.com/login/device/code",
            Provider::Gitlab => "https://gitlab.com/oauth/authorize_device",
        }
    }

    fn token_url(&self) -> &'static str {
        match self {
            Provider::Github => "https://github.com/login/oauth/access_token",
            Provider::Gitlab => "https://gitlab.com/oauth/token",
        }
    }

    fn oauth_scope(&self) -> &'static str {
        match self {
            Provider::Github => "repo read:org workflow",
            Provider::Gitlab => "read_api write_repository",
        }
    }

    /// GitLab OAuth tokens are used for git push with the fixed username `oauth2`;
    /// GitHub authenticates as the account login.
    fn credential_username<'a>(&self, login: &'a str) -> &'a str {
        match self {
            Provider::Github => login,
            Provider::Gitlab => "oauth2",
        }
    }
}

// ── Token store (~/.config/gyredeck/github-accounts.json, mode 0600) ──

#[derive(Serialize, Deserialize, Clone)]
pub struct StoredAccount {
    pub login: String,
    pub id: u64,
    pub token: String,
    // Missing in legacy files (GitHub-only) => defaults to Github.
    #[serde(default)]
    pub provider: Provider,
    // OAuth device-flow tokens (GitLab) expire and must be refreshed. Absent for
    // PATs and GitHub OAuth (which don't expire); back-compat via serde default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

/// Composite key identifying an account across providers ("github:octocat").
fn account_key(account: &StoredAccount) -> String {
    format!("{}:{}", account.provider.as_str(), account.login)
}

/// Parse a stored `active` key. A bare login (legacy, no provider prefix) is
/// treated as GitHub for backward compatibility.
fn parse_key(key: &str) -> (Provider, &str) {
    if let Some((prefix, login)) = key.split_once(':') {
        if let Some(provider) = Provider::parse(prefix) {
            return (provider, login);
        }
    }
    (Provider::Github, key)
}

fn account_matches_key(account: &StoredAccount, key: &str) -> bool {
    let (provider, login) = parse_key(key);
    account.provider == provider && account.login == login
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize)]
pub struct TokenStore {
    pub active: Option<String>,
    pub accounts: Vec<StoredAccount>,
    // When false, switching/adding accounts does not touch the system git
    // identity (git config / gh). Missing in legacy files => true.
    #[serde(default = "default_true")]
    pub sync_identity: bool,
}

impl Default for TokenStore {
    fn default() -> Self {
        Self {
            active: None,
            accounts: Vec::new(),
            sync_identity: true,
        }
    }
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

fn upsert_account(store: &mut TokenStore, account: StoredAccount) {
    if let Some(existing) = store
        .accounts
        .iter_mut()
        .find(|a| a.provider == account.provider && a.login == account.login)
    {
        existing.id = account.id;
        existing.token = account.token;
        existing.refresh_token = account.refresh_token;
        existing.expires_at = account.expires_at;
    } else {
        store.accounts.push(account);
    }
}

/// Ensure the token for `key` is valid, refreshing an expired OAuth token via its
/// refresh_token and persisting the rotation. Returns the usable access token.
/// Accounts without a refresh_token (PATs, GitHub OAuth) are returned unchanged.
fn ensure_fresh_token(store: &mut TokenStore, key: &str) -> Result<String, String> {
    let Some(index) = store.accounts.iter().position(|a| account_matches_key(a, key)) else {
        return Err("No active account. Add an account first.".to_string());
    };
    let account = &store.accounts[index];
    let needs_refresh = account.refresh_token.is_some()
        && account
            .expires_at
            .map(|at| now_secs() + TOKEN_REFRESH_BUFFER_SECS >= at)
            .unwrap_or(false);
    if !needs_refresh {
        return Ok(store.accounts[index].token.clone());
    }
    let provider = account.provider;
    let refresh_token = account.refresh_token.clone().unwrap_or_default();
    let refreshed = refresh_oauth_token(provider, &refresh_token)?;
    let account = &mut store.accounts[index];
    account.token = refreshed.access_token;
    if refreshed.refresh_token.is_some() {
        account.refresh_token = refreshed.refresh_token;
    }
    account.expires_at = refreshed.expires_in.map(|secs| now_secs() + secs);
    let token = account.token.clone();
    save_store(store)?;
    Ok(token)
}

/// The active account's provider plus a fresh (refreshed if needed) access token.
fn active_provider_token() -> Result<(Provider, String), String> {
    let mut store = load_store()?;
    let key = store
        .active
        .clone()
        .ok_or_else(|| "No active account. Add an account first.".to_string())?;
    let provider = store
        .accounts
        .iter()
        .find(|a| account_matches_key(a, &key))
        .map(|a| a.provider)
        .ok_or_else(|| "No active account. Add an account first.".to_string())?;
    let token = ensure_fresh_token(&mut store, &key)?;
    Ok((provider, token))
}

/// Resolve a token for an explicit account (viewing account) when given, else the
/// active account. Refreshes an expired OAuth token as needed.
fn provider_token_for(
    provider: Option<Provider>,
    login: Option<&str>,
) -> Result<(Provider, String), String> {
    match (provider, login) {
        (Some(provider), Some(login)) => {
            let mut store = load_store()?;
            let key = format!("{}:{}", provider.as_str(), login);
            if !store.accounts.iter().any(|a| account_matches_key(a, &key)) {
                return Err("Account is not added".to_string());
            }
            let token = ensure_fresh_token(&mut store, &key)?;
            Ok((provider, token))
        }
        _ => active_provider_token(),
    }
}

// ── Validation (repo/account strings flow into `gh` arguments) ──

fn is_valid_repo(repo: &str, provider: Provider) -> bool {
    let parts: Vec<&str> = repo.split('/').collect();
    // GitHub is always owner/name; GitLab allows nested groups (2+ segments).
    let count_ok = match provider {
        Provider::Github => parts.len() == 2,
        Provider::Gitlab => parts.len() >= 2,
    };
    let segment_ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    count_ok && parts.iter().all(|s| segment_ok(s))
}

fn is_valid_account(user: &str, provider: Provider) -> bool {
    if user.is_empty() || user.len() > 64 {
        return false;
    }
    match provider {
        Provider::Github => {
            user.len() <= 39 && user.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        }
        Provider::Gitlab => user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')),
    }
}

/// GitLab per-project endpoints take a URL-encoded `namespace/project` id.
/// Repo strings are validated to alnum/./_/- plus `/`, so encoding `/` suffices.
fn gitlab_project_id(repo: &str) -> String {
    repo.replace('/', "%2F")
}

// ── REST client ──

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

/// Perform an authenticated GET against a provider's REST API. `path` is either
/// an absolute URL (e.g. a Link-header "next" URL) or a path relative to the base.
fn api_get(
    client: &reqwest::blocking::Client,
    provider: Provider,
    token: &str,
    path: &str,
) -> Result<reqwest::blocking::Response, String> {
    let url = if path.starts_with("http") {
        path.to_string()
    } else {
        format!("{}/{}", provider.api_base(), path.trim_start_matches('/'))
    };
    let request = client.get(&url).header("User-Agent", USER_AGENT);
    let request = match provider {
        Provider::Github => request
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", API_VERSION),
        // Bearer works for both GitLab OAuth tokens and personal access tokens.
        Provider::Gitlab => request.header("Authorization", format!("Bearer {token}")),
    };
    let response = request
        .send()
        .map_err(|e| format!("{} request failed: {e}", provider.label()))?;
    if response.status().as_u16() == 401 {
        return Err(format!(
            "{} token expired or invalid — re-add the account",
            provider.label()
        ));
    }
    if !response.status().is_success() {
        return Err(format!("{} API returned {}", provider.label(), response.status()));
    }
    Ok(response)
}

fn api_get_json(
    client: &reqwest::blocking::Client,
    provider: Provider,
    token: &str,
    path: &str,
) -> Result<Value, String> {
    api_get(client, provider, token, path)?
        .json()
        .map_err(|e| format!("Invalid {} response: {e}", provider.label()))
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

/// Map a GitLab pipeline `status` onto the GitHub Actions {status, conclusion}
/// shape the frontend already understands, so the UI needs no provider branch.
fn map_pipeline_status(status: &str) -> (String, Option<String>) {
    match status {
        "success" => ("completed".to_string(), Some("success".to_string())),
        "failed" => ("completed".to_string(), Some("failure".to_string())),
        "canceled" | "skipped" => ("completed".to_string(), Some("cancelled".to_string())),
        other => (other.to_string(), None),
    }
}

fn latest_commit(
    client: &reqwest::blocking::Client,
    provider: Provider,
    token: &str,
    repo: &str,
) -> Option<GithubCommit> {
    match provider {
        Provider::Github => {
            let value =
                api_get_json(client, provider, token, &format!("repos/{repo}/commits?per_page=1")).ok()?;
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
        Provider::Gitlab => {
            let id = gitlab_project_id(repo);
            let value = api_get_json(
                client,
                provider,
                token,
                &format!("projects/{id}/repository/commits?per_page=1"),
            )
            .ok()?;
            let entry = value.as_array()?.first()?;
            Some(GithubCommit {
                sha: entry.get("short_id").and_then(Value::as_str).unwrap_or("").to_string(),
                message: first_line(entry.get("title").and_then(Value::as_str).unwrap_or("")),
                author: entry.get("author_name").and_then(Value::as_str).unwrap_or("").to_string(),
                committed_at: entry.get("committed_date").and_then(Value::as_str).unwrap_or("").to_string(),
            })
        }
    }
}

fn recent_runs(
    client: &reqwest::blocking::Client,
    provider: Provider,
    token: &str,
    repo: &str,
) -> Vec<GithubRun> {
    match provider {
        Provider::Github => {
            let Ok(value) =
                api_get_json(client, provider, token, &format!("repos/{repo}/actions/runs?per_page=5"))
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
        Provider::Gitlab => {
            let id = gitlab_project_id(repo);
            let Ok(value) =
                api_get_json(client, provider, token, &format!("projects/{id}/pipelines?per_page=5"))
            else {
                return Vec::new();
            };
            value
                .as_array()
                .map(|runs| {
                    runs.iter()
                        .map(|run| {
                            let branch = run.get("ref").and_then(Value::as_str).unwrap_or("").to_string();
                            let (status, conclusion) = map_pipeline_status(
                                run.get("status").and_then(Value::as_str).unwrap_or(""),
                            );
                            let name = if branch.is_empty() {
                                format!("pipeline #{}", run.get("id").and_then(Value::as_u64).unwrap_or(0))
                            } else {
                                branch.clone()
                            };
                            GithubRun {
                                name,
                                status,
                                conclusion,
                                branch,
                                created_at: run.get("created_at").and_then(Value::as_str).unwrap_or("").to_string(),
                            }
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
    }
}

fn open_pulls(
    client: &reqwest::blocking::Client,
    provider: Provider,
    token: &str,
    repo: &str,
) -> (usize, Vec<GithubPull>) {
    let path = match provider {
        Provider::Github => format!("repos/{repo}/pulls?state=open&per_page=100"),
        Provider::Gitlab => {
            format!("projects/{}/merge_requests?state=opened&per_page=100", gitlab_project_id(repo))
        }
    };
    let Ok(value) = api_get_json(client, provider, token, &path) else {
        return (0, Vec::new());
    };
    let Some(array) = value.as_array() else {
        return (0, Vec::new());
    };
    let count = array.len();
    let pulls = array
        .iter()
        .take(MAX_PULLS)
        .map(|pr| match provider {
            Provider::Github => GithubPull {
                number: pr.get("number").and_then(Value::as_u64).unwrap_or(0),
                title: pr.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
                author: pr
                    .get("user")
                    .and_then(|a| a.get("login"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                updated_at: pr.get("updated_at").and_then(Value::as_str).unwrap_or("").to_string(),
            },
            Provider::Gitlab => GithubPull {
                number: pr.get("iid").and_then(Value::as_u64).unwrap_or(0),
                title: pr.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
                author: pr
                    .get("author")
                    .and_then(|a| a.get("username"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                updated_at: pr.get("updated_at").and_then(Value::as_str).unwrap_or("").to_string(),
            },
        })
        .collect();
    (count, pulls)
}

fn repo_status_blocking(
    repo: &str,
    provider: Option<Provider>,
    login: Option<&str>,
) -> Result<GithubRepoStatus, String> {
    // Don't hard-fail the tab: surface auth/setup problems as an error field.
    let (client, provider, token) = match (http_client(), provider_token_for(provider, login)) {
        (Ok(client), Ok((provider, token))) => (client, provider, token),
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
    if !is_valid_repo(repo, provider) {
        return Err("Invalid repository (expected owner/name)".to_string());
    }
    let token = token.as_str();
    let (open_pr_count, pulls) = open_pulls(&client, provider, token, repo);
    Ok(GithubRepoStatus {
        repo: repo.to_string(),
        commit: latest_commit(&client, provider, token, repo),
        runs: recent_runs(&client, provider, token, repo),
        open_pr_count,
        pulls,
        error: None,
    })
}

#[tauri::command]
pub async fn github_repo_status(
    repo: String,
    provider: Option<String>,
    login: Option<String>,
) -> Result<GithubRepoStatus, String> {
    let provider = provider.as_deref().and_then(Provider::parse);
    tauri::async_runtime::spawn_blocking(move || {
        repo_status_blocking(&repo, provider, login.as_deref())
    })
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

fn available_repos_blocking(
    provider: Option<Provider>,
    login: Option<&str>,
) -> Result<Vec<String>, String> {
    let client = http_client()?;
    let (provider, token) = provider_token_for(provider, login)?;
    let token = token.as_str();
    let name_field = match provider {
        Provider::Github => "full_name",
        Provider::Gitlab => "path_with_namespace",
    };
    let mut repos: Vec<String> = Vec::new();
    let mut url = match provider {
        Provider::Github => format!(
            "{}/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=full_name",
            provider.api_base()
        ),
        Provider::Gitlab => format!(
            "{}/projects?membership=true&simple=true&per_page=100&order_by=path&sort=asc",
            provider.api_base()
        ),
    };
    loop {
        let response = api_get(&client, provider, token, &url)?;
        let next = response
            .headers()
            .get(reqwest::header::LINK)
            .and_then(|v| v.to_str().ok())
            .and_then(next_link);
        let value: Value = response
            .json()
            .map_err(|e| format!("Invalid {} response: {e}", provider.label()))?;
        if let Some(array) = value.as_array() {
            for repo in array {
                if let Some(name) = repo.get(name_field).and_then(Value::as_str) {
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
pub async fn github_available_repos(
    provider: Option<String>,
    login: Option<String>,
) -> Result<Vec<String>, String> {
    let provider = provider.as_deref().and_then(Provider::parse);
    tauri::async_runtime::spawn_blocking(move || {
        available_repos_blocking(provider, login.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Sync-identity preference ──

#[tauri::command]
pub fn get_sync_identity() -> Result<bool, String> {
    Ok(load_store()?.sync_identity)
}

#[tauri::command]
pub fn set_sync_identity(enabled: bool) -> Result<(), String> {
    let mut store = load_store()?;
    store.sync_identity = enabled;
    save_store(&store)?;
    // Re-pin the system identity to the active account when turning sync on.
    if enabled {
        sync_git_identity(&store);
    }
    Ok(())
}

// ── Accounts (switch between already-authenticated gh accounts) ──

#[derive(Serialize)]
pub struct GhAccount {
    pub login: String,
    pub active: bool,
    pub provider: String,
}

fn accounts_blocking() -> Result<Vec<GhAccount>, String> {
    let store = load_store()?;
    Ok(store
        .accounts
        .iter()
        .map(|a| GhAccount {
            login: a.login.clone(),
            active: store
                .active
                .as_deref()
                .map(|key| account_matches_key(a, key))
                .unwrap_or(false),
            provider: a.provider.as_str().to_string(),
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
    if !store.sync_identity {
        return;
    }
    let Some(active) = store.active.as_deref() else {
        return;
    };
    let Some(account) = store.accounts.iter().find(|a| account_matches_key(a, active)) else {
        return;
    };
    let email = http_client()
        .ok()
        .and_then(|client| api_get_json(&client, account.provider, &account.token, "user").ok())
        .and_then(|value| {
            value
                .get("email")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| match account.provider {
            Provider::Github => {
                format!("{}+{}@users.noreply.github.com", account.id, account.login)
            }
            Provider::Gitlab => format!("{}@users.noreply.gitlab.com", account.login),
        });
    let _ = Command::new("git")
        .args(["config", "--global", "user.name", &account.login])
        .status();
    let _ = Command::new("git")
        .args(["config", "--global", "user.email", &email])
        .status();
}

fn switch_account_blocking(provider: Provider, user: &str) -> Result<String, String> {
    if !is_valid_account(user, provider) {
        return Err("Invalid account name".to_string());
    }
    let mut store = load_store()?;
    if !store
        .accounts
        .iter()
        .any(|a| a.provider == provider && a.login == user)
    {
        return Err(format!("Account {user} is not added"));
    }
    store.active = Some(format!("{}:{}", provider.as_str(), user));
    let sync = store.sync_identity;
    save_store(&store)?;
    sync_git_identity(&store);
    if sync && provider == Provider::Github {
        sync_gh_active(user);
    }
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
pub async fn github_switch_account(provider: String, user: String) -> Result<String, String> {
    let provider = Provider::parse(&provider).unwrap_or(Provider::Github);
    tauri::async_runtime::spawn_blocking(move || switch_account_blocking(provider, &user))
        .await
        .map_err(|e| e.to_string())?
}

// ── Import tokens from the gh CLI (optional token importer) ──

/// Fetch a login + id from the provider for the given token, then upsert it.
fn import_token(
    client: &reqwest::blocking::Client,
    store: &mut TokenStore,
    provider: Provider,
    token: &str,
) -> Result<String, String> {
    let value = api_get_json(client, provider, token, "user")?;
    // GitHub returns `login`; GitLab returns `username`.
    let login_field = match provider {
        Provider::Github => "login",
        Provider::Gitlab => "username",
    };
    let login = value
        .get(login_field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{} /user response missing {login_field}", provider.label()))?
        .to_string();
    let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
    upsert_account(
        store,
        StoredAccount {
            login: login.clone(),
            id,
            token: token.to_string(),
            provider,
            refresh_token: None,
            expires_at: None,
        },
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
        let login = import_token(&client, &mut store, Provider::Github, &token)?;
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
            match import_token(&client, &mut store, Provider::Github, &token) {
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
    let active_login = gh_active.or_else(|| imported.first().cloned());
    store.active = active_login.map(|login| format!("github:{login}"));
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

// ── Import token from the glab CLI (GitLab) ──

/// Read the GitLab PAT the `glab` CLI stored, trying `glab auth token` first and
/// falling back to `glab config get -h gitlab.com token`.
fn glab_token() -> Option<String> {
    for args in [
        vec!["auth", "token"],
        vec!["auth", "token", "-h", "gitlab.com"],
        vec!["config", "get", "-h", "gitlab.com", "token"],
    ] {
        if let Ok(output) = Command::new("glab").args(&args).output() {
            if output.status.success() {
                let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !token.is_empty() {
                    return Some(token);
                }
            }
        }
    }
    None
}

fn import_from_glab_blocking() -> Result<Vec<GhAccount>, String> {
    if Command::new("glab").arg("--version").output().is_err() {
        return Err("glab CLI not found".to_string());
    }
    let token =
        glab_token().ok_or_else(|| "No glab token found. Run `glab auth login` first.".to_string())?;
    let client = http_client()?;
    let mut store = load_store()?;
    let login = import_token(&client, &mut store, Provider::Gitlab, &token)?;
    store.active = Some(format!("gitlab:{login}"));
    save_store(&store)?;
    sync_git_identity(&store);
    accounts_blocking()
}

#[tauri::command]
pub async fn import_from_glab() -> Result<Vec<GhAccount>, String> {
    tauri::async_runtime::spawn_blocking(import_from_glab_blocking)
        .await
        .map_err(|e| e.to_string())?
}

/// Best-effort: log the account out of its CLI so removing it from Gyredeck also
/// clears the system credential. GitHub supports per-user logout; glab is
/// single-account per host so it logs out the host. Never fatal.
fn logout_cli_account(provider: Provider, user: &str) {
    match provider {
        Provider::Github => {
            if Command::new("gh").arg("--version").output().is_ok() {
                let _ = Command::new("gh")
                    .args(["auth", "logout", "--hostname", "github.com", "--user", user])
                    .status();
            }
        }
        Provider::Gitlab => {
            if Command::new("glab").arg("--version").output().is_ok() {
                let _ = Command::new("glab")
                    .args(["auth", "logout", "--hostname", "gitlab.com"])
                    .status();
            }
        }
    }
}

fn remove_account_blocking(provider: Provider, user: &str) -> Result<Vec<GhAccount>, String> {
    if !is_valid_account(user, provider) {
        return Err("Invalid account name".to_string());
    }
    let mut store = load_store()?;
    let removed_key = format!("{}:{}", provider.as_str(), user);
    store
        .accounts
        .retain(|a| !(a.provider == provider && a.login == user));
    if store
        .active
        .as_deref()
        .map(|key| key == removed_key || parse_key(key) == (provider, user))
        .unwrap_or(false)
    {
        store.active = store.accounts.first().map(account_key);
    }
    save_store(&store)?;
    // Removing an account also clears its system credential (CLI logout).
    logout_cli_account(provider, user);
    accounts_blocking()
}

#[tauri::command]
pub async fn github_remove_account(provider: String, user: String) -> Result<Vec<GhAccount>, String> {
    let provider = Provider::parse(&provider).unwrap_or(Provider::Github);
    tauri::async_runtime::spawn_blocking(move || remove_account_blocking(provider, &user))
        .await
        .map_err(|e| e.to_string())?
}

// ── OAuth Device Flow (add a new account) ──

/// Resolve a provider's OAuth **client id** for the device flow. A client id is a
/// public identifier (not a secret). Order: runtime env, per-machine config file,
/// then build-time env baked from CI.
fn client_id(provider: Provider) -> Result<String, String> {
    let (env_key, file, build_id) = match provider {
        Provider::Github => (
            "GYREDECK_GITHUB_CLIENT_ID",
            "github-oauth.json",
            option_env!("GYREDECK_GITHUB_CLIENT_ID"),
        ),
        Provider::Gitlab => (
            "GYREDECK_GITLAB_CLIENT_ID",
            "gitlab-oauth.json",
            option_env!("GYREDECK_GITLAB_CLIENT_ID"),
        ),
    };
    // 1. Runtime env override (local dev).
    if let Ok(value) = std::env::var(env_key) {
        if !value.trim().is_empty() {
            return Ok(value.trim().to_string());
        }
    }
    // 2. Per-machine config file override.
    if let Ok(home) = std::env::var("HOME") {
        let path = std::path::PathBuf::from(home)
            .join(".config")
            .join("gyredeck")
            .join(file);
        if let Ok(content) = std::fs::read_to_string(&path) {
            let value: Value =
                serde_json::from_str(&content).map_err(|e| format!("Invalid {file}: {e}"))?;
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
    match build_id {
        Some(id) if !id.is_empty() => Ok(id.to_string()),
        _ => Err(format!(
            "{} sign-in isn't configured. Set {env_key} or add ~/.config/gyredeck/{file} with {{ \"client_id\": \"...\" }}.",
            provider.label()
        )),
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

fn device_start_blocking(provider: Provider) -> Result<DeviceCodeStart, String> {
    let client_id = client_id(provider)?;
    let client = http_client()?;
    let response = client
        .post(provider.device_code_url())
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("scope", provider.oauth_scope()),
        ])
        .send()
        .map_err(|e| format!("Device code request failed: {e}"))?;
    let value: Value = response
        .json()
        .map_err(|e| format!("Invalid device code response: {e}"))?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        let detail = value
            .get("error_description")
            .and_then(Value::as_str)
            .unwrap_or(error);
        return Err(format!("{} rejected the device request: {detail}", provider.label()));
    }
    Ok(DeviceCodeStart {
        device_code: value.get("device_code").and_then(Value::as_str).unwrap_or("").to_string(),
        user_code: value.get("user_code").and_then(Value::as_str).unwrap_or("").to_string(),
        verification_uri: value
            .get("verification_uri")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        interval: value.get("interval").and_then(Value::as_u64).unwrap_or(5),
        expires_in: value.get("expires_in").and_then(Value::as_u64).unwrap_or(900),
    })
}

#[tauri::command]
pub async fn device_start(provider: String) -> Result<DeviceCodeStart, String> {
    let provider = Provider::parse(&provider).ok_or_else(|| "Unknown provider".to_string())?;
    tauri::async_runtime::spawn_blocking(move || device_start_blocking(provider))
        .await
        .map_err(|e| e.to_string())?
}

/// Poll status: "pending" (keep polling), "success" (account added), or an error string.
#[derive(Serialize)]
pub struct DevicePollResult {
    pub status: String,
    pub login: Option<String>,
}

/// Token fields shared by the device-code and refresh grants.
struct OAuthToken {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

fn parse_oauth_token(value: &Value) -> Option<OAuthToken> {
    let access_token = value.get("access_token").and_then(Value::as_str)?.to_string();
    Some(OAuthToken {
        access_token,
        refresh_token: value.get("refresh_token").and_then(Value::as_str).map(str::to_string),
        expires_in: value.get("expires_in").and_then(Value::as_u64),
    })
}

/// Exchange a refresh token for a new access token (OAuth token rotation).
fn refresh_oauth_token(provider: Provider, refresh_token: &str) -> Result<OAuthToken, String> {
    let client_id = client_id(provider)?;
    let client = http_client()?;
    let response = client
        .post(provider.token_url())
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .send()
        .map_err(|e| format!("Token refresh failed: {e}"))?;
    let value: Value = response
        .json()
        .map_err(|e| format!("Invalid token response: {e}"))?;
    parse_oauth_token(&value).ok_or_else(|| {
        let err = value.get("error").and_then(Value::as_str).unwrap_or("refresh failed");
        format!("{} token refresh failed: {err}", provider.label())
    })
}

/// Persist a device-flow OAuth token into the store and mark it active.
fn store_oauth_token(provider: Provider, token: &OAuthToken) -> Result<Option<String>, String> {
    let client = http_client()?;
    let mut store = load_store()?;
    let login = import_token(&client, &mut store, provider, &token.access_token)?;
    if let Some(account) = store
        .accounts
        .iter_mut()
        .find(|a| a.provider == provider && a.login == login)
    {
        account.refresh_token = token.refresh_token.clone();
        account.expires_at = token.expires_in.map(|secs| now_secs() + secs);
    }
    store.active = Some(format!("{}:{login}", provider.as_str()));
    save_store(&store)?;
    sync_git_identity(&store);
    // Register the account with its CLI so adding mirrors removing (which logs out).
    login_cli_account(provider, &token.access_token);
    Ok(Some(login))
}

/// Best-effort: register an account's token with its CLI (`gh`/`glab`) via stdin,
/// so an OAuth/device-flow add also lands in the system CLI. Never fatal; a
/// missing CLI is silently ignored. Note: GitLab OAuth tokens expire (~2h), so
/// the CLI copy is short-lived until re-added.
fn login_cli_account(provider: Provider, token: &str) {
    use std::io::Write;
    let mut command = match provider {
        Provider::Github => {
            let mut c = Command::new("gh");
            c.args(["auth", "login", "--hostname", "github.com", "--with-token"]);
            c
        }
        Provider::Gitlab => {
            let mut c = Command::new("glab");
            c.args(["auth", "login", "--hostname", "gitlab.com", "--stdin"]);
            c
        }
    };
    let child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Ok(mut child) = child {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(token.as_bytes());
            let _ = stdin.write_all(b"\n");
        }
        let _ = child.wait();
    }
}

fn device_poll_blocking(provider: Provider, device_code: &str) -> Result<DevicePollResult, String> {
    let client_id = client_id(provider)?;
    let client = http_client()?;
    let response = client
        .post(provider.token_url())
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

    if let Some(token) = parse_oauth_token(&value) {
        let login = store_oauth_token(provider, &token)?;
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
pub async fn device_poll(provider: String, device_code: String) -> Result<DevicePollResult, String> {
    let provider = Provider::parse(&provider).ok_or_else(|| "Unknown provider".to_string())?;
    tauri::async_runtime::spawn_blocking(move || device_poll_blocking(provider, &device_code))
        .await
        .map_err(|e| e.to_string())?
}

// ── Git credential helper (Gyredeck as a gh/glab-free credential source) ──
//
// When enabled, git is pointed at `gyredeck-desktop git-credential`, which answers
// HTTPS auth for GitHub/GitLab from the local token store — so `git push` works
// without the gh/glab CLIs. A1 policy: Gyredeck only fills hosts that have no
// existing (gh/glab) helper, deferring to them where present. Toggled from Settings.

const CREDENTIAL_CONFIG_HOSTS: [&str; 3] =
    ["https://github.com", "https://gist.github.com", "https://gitlab.com"];

/// Map a git host to the provider whose token should answer for it.
fn provider_for_host(host: &str) -> Option<Provider> {
    match host {
        "github.com" | "gist.github.com" => Some(Provider::Github),
        "gitlab.com" => Some(Provider::Gitlab),
        _ => None,
    }
}

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
    let Some(provider) = provider_for_host(&host) else {
        return;
    };
    let Ok(store) = load_store() else {
        return;
    };
    // Select within the host's provider: explicit remote username, else the
    // active account of that provider, else the first account of that provider.
    let account = store
        .accounts
        .iter()
        .find(|a| a.provider == provider && !wanted_user.is_empty() && a.login == wanted_user)
        .or_else(|| {
            let active = store.active.as_deref()?;
            let (active_provider, active_login) = parse_key(active);
            if active_provider == provider {
                store
                    .accounts
                    .iter()
                    .find(|a| a.provider == provider && a.login == active_login)
            } else {
                None
            }
        })
        .or_else(|| store.accounts.iter().find(|a| a.provider == provider));
    let Some(account) = account else {
        return;
    };
    let key = account_key(account);
    let login = account.login.clone();
    // Refresh an expired OAuth token before answering (borrow of `store` ends above).
    let mut store = match load_store() {
        Ok(store) => store,
        Err(_) => return,
    };
    let Ok(token) = ensure_fresh_token(&mut store, &key) else {
        return;
    };
    let username = provider.credential_username(&login);
    let mut out = std::io::stdout();
    let _ = write!(
        out,
        "protocol=https\nhost={host}\nusername={username}\npassword={token}\n"
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

/// Bare host ("github.com") for a config host ("https://github.com").
fn bare_host(config_host: &str) -> &str {
    config_host.trim_start_matches("https://")
}

/// Whether a host already has a credential helper that isn't Gyredeck's (gh/glab).
/// A1 defers to it rather than taking over.
fn host_has_external_helper(config_host: &str) -> bool {
    let key = format!("credential.{config_host}.helper");
    let Ok(output) = Command::new("git")
        .args(["config", "--global", "--get-all", &key])
        .output()
    else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        let trimmed = line.trim();
        !trimmed.is_empty() && !trimmed.to_lowercase().contains("gyredeck")
    })
}

fn host_has_gyredeck_helper(config_host: &str) -> bool {
    let key = format!("credential.{config_host}.helper");
    let Ok(output) = Command::new("git")
        .args(["config", "--global", "--get-all", &key])
        .output()
    else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        let lower = line.to_lowercase();
        lower.contains("git-credential") && lower.contains("gyredeck")
    })
}

fn credential_helper_installed() -> Result<CredentialHelperStatus, String> {
    let path = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    // Installed if Gyredeck's helper is present on any managed host.
    let installed = CREDENTIAL_CONFIG_HOSTS
        .iter()
        .any(|host| host_has_gyredeck_helper(host));
    Ok(CredentialHelperStatus { installed, path })
}

fn credential_helper_enable_blocking() -> Result<CredentialHelperStatus, String> {
    let helper = helper_command_value()?;
    let store = load_store().unwrap_or_default();
    for host in CREDENTIAL_CONFIG_HOSTS {
        let Some(provider) = provider_for_host(bare_host(host)) else {
            continue;
        };
        // Only manage hosts whose provider we actually have an account for.
        if !store.accounts.iter().any(|a| a.provider == provider) {
            continue;
        }
        // A1: defer to an existing non-Gyredeck helper (gh/glab); fill only the gap.
        if host_has_external_helper(host) {
            continue;
        }
        let key = format!("credential.{host}.helper");
        // Reset then install ours (empty entry drops any inherited global helper).
        let _ = Command::new("git").args(["config", "--global", "--unset-all", &key]).status();
        git_config_add(&key, "")?;
        git_config_add(&key, &helper)?;
    }
    credential_helper_installed()
}

fn credential_helper_disable_blocking() -> Result<CredentialHelperStatus, String> {
    for host in CREDENTIAL_CONFIG_HOSTS {
        let key = format!("credential.{host}.helper");
        // Remove only Gyredeck's own entries; leave any gh/glab helper intact.
        let _ = Command::new("git")
            .args(["config", "--global", "--unset-all", &key, "gyredeck"])
            .status();
        // If nothing external remains, clear the leftover empty reset entry too.
        if !host_has_external_helper(host) {
            let _ = Command::new("git").args(["config", "--global", "--unset-all", &key]).status();
        }
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
