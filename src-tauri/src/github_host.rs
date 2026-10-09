use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub const DEFAULT_GITHUB_HOST: &str = "github.com";

// Every `gh` call reads this, including ones without an AppHandle.
static GITHUB_HOST: RwLock<String> = RwLock::new(String::new());

#[derive(Serialize, Deserialize)]
struct GithubConfig {
    host: String,
}

/// The GitHub host MonoCode targets: github.com or a GitHub Enterprise Server.
pub fn current() -> String {
    let host = GITHUB_HOST
        .read()
        .map(|host| host.clone())
        .unwrap_or_default();
    if host.is_empty() {
        DEFAULT_GITHUB_HOST.into()
    } else {
        host
    }
}

pub fn is_dotcom(host: &str) -> bool {
    host == DEFAULT_GITHUB_HOST
}

/// REST API root for `host`, matching the URLs GitHub returns in payloads.
pub fn api_base(host: &str) -> String {
    if is_dotcom(host) {
        "https://api.github.com".into()
    } else {
        format!("https://{host}/api/v3")
    }
}

pub fn init(app: &AppHandle) {
    let host = read_config(app)
        .ok()
        .flatten()
        .and_then(|config| normalize_github_host(&config.host).ok())
        .unwrap_or_else(|| DEFAULT_GITHUB_HOST.into());
    set_current(host);
}

fn set_current(host: String) {
    if let Ok(mut slot) = GITHUB_HOST.write() {
        *slot = host;
    }
}

#[tauri::command]
pub fn github_host() -> String {
    current()
}

#[tauri::command(async)]
pub fn github_set_host(app: AppHandle, host: String) -> Result<String, String> {
    let host = normalize_github_host(&host)?;
    if is_dotcom(&host) {
        delete_config(&app)?;
    } else {
        write_config(&app, &GithubConfig { host: host.clone() })?;
    }
    set_current(host.clone());
    let _ = app.emit("github_host_changed", &host);
    Ok(host)
}

/// Accepts `oss.example.com` or `https://oss.example.com/` and keeps the host.
fn normalize_github_host(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(DEFAULT_GITHUB_HOST.into());
    }
    let rest = match raw.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("https") => rest,
        Some(_) => return Err("GitHub host must use HTTPS".into()),
        None => raw,
    };
    let host = rest.trim_end_matches('/').to_ascii_lowercase();
    let host = host.trim_end_matches('.');
    let valid = !host.is_empty()
        && host.contains('.')
        && host.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        });
    if !valid {
        return Err("Enter a GitHub host such as github.com".into());
    }
    let host = host.strip_prefix("www.").unwrap_or(host);
    Ok(host.to_string())
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("github-config.json"))
}

fn read_config(app: &AppHandle) -> Result<Option<GithubConfig>, String> {
    match fs::read_to_string(config_path(app)?) {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|_| "GitHub settings are invalid".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_config(app: &AppHandle, config: &GithubConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let value = serde_json::to_string(config).map_err(|error| error.to_string())?;
    fs::write(path, value).map_err(|error| error.to_string())
}

fn delete_config(app: &AppHandle) -> Result<(), String> {
    match fs::remove_file(config_path(app)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_hosts_and_urls() {
        assert_eq!(normalize_github_host("").unwrap(), "github.com");
        assert_eq!(normalize_github_host(" GitHub.com ").unwrap(), "github.com");
        assert_eq!(
            normalize_github_host("www.github.com").unwrap(),
            "github.com"
        );
        assert_eq!(
            normalize_github_host("https://oss.navercorp.com/").unwrap(),
            "oss.navercorp.com"
        );
        assert_eq!(
            normalize_github_host("oss.navercorp.com.").unwrap(),
            "oss.navercorp.com"
        );
    }

    #[test]
    fn rejects_non_host_input() {
        for raw in [
            "http://oss.example.com",
            "https://oss.example.com/org/repo",
            "user@oss.example.com",
            "oss.example.com:8443",
            "localhost",
            "-bad.example.com",
            "oss example.com",
        ] {
            assert!(normalize_github_host(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn api_base_matches_host_kind() {
        assert_eq!(api_base("github.com"), "https://api.github.com");
        assert_eq!(
            api_base("oss.navercorp.com"),
            "https://oss.navercorp.com/api/v3"
        );
    }
}
