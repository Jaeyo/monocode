use std::io::Read;
use std::process::Command;
use std::time::Duration;

use crate::dirs_home;
use crate::fs::MAX_PREVIEW_BYTES;

const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REDIRECTS: usize = 5;
const MAX_URL_BYTES: usize = 8192;
const USER_AGENT: &str = "MonoCode";

#[derive(Clone, Debug, PartialEq, Eq)]
struct MediaUrl {
    host: String,
    path: String,
    url: String,
}

/// Fetch an issue/PR image or video through the host, as a blob the webview
/// can render without opening `img-src` / `media-src` to remote hosts. Any
/// public HTTPS host is fetched; only GitHub attachments get a token.
#[tauri::command]
pub async fn fetch_inbox_media(url: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || fetch_inbox_media_sync(&url))
        .await
        .map_err(|error| error.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

fn fetch_inbox_media_sync(url: &str) -> Result<Vec<u8>, String> {
    let enterprise = enterprise_host();
    let enterprise = enterprise.as_deref();
    let mut current = parse_https_url(url)?;
    // Only a GitHub attachment URL gets a token, from the `gh` login of the
    // site it is on, and only that host ever sees it.
    let token_host = github_attachment_host(&current, enterprise).map(str::to_string);
    let token = token_host.as_deref().and_then(github_auth_token);
    let agent = ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT)
        .redirects(0)
        .build();

    for _ in 0..MAX_REDIRECTS {
        let mut request = agent
            .get(&current.url)
            .set("Accept", "image/*,video/*,*/*;q=0.1")
            .set("User-Agent", USER_AGENT);
        if let Some(token) = token.as_ref() {
            if github_site_host(&current.host, enterprise) == token_host.as_deref() {
                request = request.set("Authorization", &format!("Bearer {token}"));
            }
        }
        // ureq with redirects(0) returns 3xx as Ok, not Err(Status).
        let response = match request.call() {
            Ok(response) => response,
            Err(ureq::Error::Status(status, response)) if is_redirect(status) => response,
            Err(ureq::Error::Status(status, _)) => {
                return Err(format!("Media request failed ({status})"));
            }
            Err(_) => return Err("Could not fetch media".into()),
        };
        if is_redirect(response.status()) {
            let location = response
                .header("Location")
                .ok_or_else(|| "Media redirect is missing a Location header".to_string())?
                .to_string();
            current = redirect_target(&current.url, &location)?;
            continue;
        }
        return read_media_body(response);
    }
    Err("Too many media redirects".into())
}

fn read_media_body(response: ureq::Response) -> Result<Vec<u8>, String> {
    let status = response.status();
    if !(200..300).contains(&status) {
        return Err(format!("Media request failed ({status})"));
    }
    if let Some(content_type) = response.header("Content-Type") {
        let mime = content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if mime.starts_with("text/html")
            || mime.starts_with("text/javascript")
            || mime == "application/javascript"
            || mime == "application/xhtml+xml"
        {
            return Err("That URL is not image or video media".into());
        }
    }
    if let Some(length) = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok())
    {
        if length > MAX_PREVIEW_BYTES {
            return Err(too_large());
        }
    }
    let mut reader = response.into_reader();
    let mut bytes = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|_| "Could not read media".to_string())?;
        if n == 0 {
            break;
        }
        if bytes.len() + n > MAX_PREVIEW_BYTES as usize {
            return Err(too_large());
        }
        bytes.extend_from_slice(&buf[..n]);
    }
    if bytes.is_empty() {
        return Err("Media response was empty".into());
    }
    Ok(bytes)
}

fn too_large() -> String {
    format!(
        "Media is too large to preview (maximum {} MB).",
        MAX_PREVIEW_BYTES / 1024 / 1024
    )
}

fn parse_https_url(raw: &str) -> Result<MediaUrl, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_URL_BYTES {
        return Err("Media URL is invalid".into());
    }
    let rest = raw
        .strip_prefix("https://")
        .ok_or_else(|| "Only HTTPS media URLs are allowed".to_string())?;
    if rest.is_empty() || rest.starts_with('/') {
        return Err("Media URL is invalid".into());
    }
    let (authority, path_query) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    if authority.is_empty() || authority.contains('@') || authority.contains('\\') {
        return Err("Media URL is invalid".into());
    }
    if authority.starts_with('[') {
        return Err("Media URL is invalid".into());
    }
    let host = authority
        .split(':')
        .next()
        .unwrap_or("")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.is_empty() || host == "localhost" || host.parse::<std::net::IpAddr>().is_ok() {
        return Err("Media URL is invalid".into());
    }
    let without_hash = path_query.split('#').next().unwrap_or(path_query);
    let path = without_hash.split('?').next().unwrap_or(without_hash);
    if path_has_dotdot(path) {
        return Err("Media URL is invalid".into());
    }
    let url = raw.split('#').next().unwrap_or(raw).to_string();
    Ok(MediaUrl {
        host,
        path: path.to_string(),
        url,
    })
}

fn redirect_target(base: &str, location: &str) -> Result<MediaUrl, String> {
    let location = location.trim();
    if location.is_empty() {
        return Err("Media redirect is missing a Location header".into());
    }
    if location.starts_with("https://") {
        return parse_https_url(location);
    }
    if location.starts_with("http://") {
        return Err("Insecure media redirect".into());
    }
    let base = parse_https_url(base)?;
    let joined = if let Some(rest) = location.strip_prefix("//") {
        format!("https://{rest}")
    } else if location.starts_with('/') {
        format!("https://{}{}", base.host, location)
    } else {
        let dir = base
            .path
            .rsplit_once('/')
            .map(|(head, _)| head)
            .unwrap_or("");
        format!("https://{}{dir}/{location}", base.host)
    };
    parse_https_url(&joined)
}

/// The configured GitHub Enterprise host, or `None` on github.com.
fn enterprise_host() -> Option<String> {
    let host = crate::github_host::current();
    (!crate::github_host::is_dotcom(&host)).then_some(host)
}

/// The site host whose `gh` login owns `url`, when it is a GitHub upload:
/// `/user-attachments/`, `/<owner>/<repo>/assets/<id>/`, or GHES `/storage/`.
fn github_attachment_host<'a>(url: &MediaUrl, enterprise: Option<&'a str>) -> Option<&'a str> {
    let site = github_site_host(&url.host, enterprise)?;
    let upload = is_github_attachment_path(&url.path)
        || (Some(site) == enterprise && is_enterprise_storage_path(&url.path));
    upload.then_some(site)
}

/// `github.com` or the Enterprise host when `host` is that site (with or
/// without `www.`), so the caller knows which `gh` login it belongs to.
fn github_site_host<'a>(host: &str, enterprise: Option<&'a str>) -> Option<&'a str> {
    if is_github_site(host) {
        return Some(crate::github_host::DEFAULT_GITHUB_HOST);
    }
    let enterprise = enterprise?;
    let bare = host.strip_prefix("www.").unwrap_or(host);
    (bare == enterprise).then_some(enterprise)
}

/// Without subdomain isolation GHES serves the same uploads from `/storage/`.
fn is_enterprise_storage_path(path: &str) -> bool {
    path.to_ascii_lowercase().starts_with("/storage/")
}

fn is_github_attachment_path(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    if path.starts_with("/user-attachments/") {
        return true;
    }
    // /owner/repo/assets/<user-id>/<uuid>
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    parts.len() >= 4 && parts[2] == "assets" && parts[3].bytes().all(|byte| byte.is_ascii_digit())
}

fn is_github_site(host: &str) -> bool {
    host == "github.com" || host == "www.github.com"
}

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn path_has_dotdot(path: &str) -> bool {
    path.split('/').any(|segment| {
        let lower = segment.to_ascii_lowercase();
        lower == ".." || lower == "%2e%2e" || lower == "%2e." || lower == ".%2e"
    })
}

fn github_auth_token(host: &str) -> Option<String> {
    let program = crate::harness::resolve_gui_binary("gh")?;
    let home = dirs_home()?;
    let mut cmd = Command::new(program);
    cmd.current_dir(&home)
        // Only the site host gets a token: JWT-signed githubusercontent URLs
        // reject an extra Authorization header, and media CDNs need none.
        .args(["auth", "token", "--hostname", host])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PAGER", "cat");
    crate::harness::apply_gui_env(&mut cmd);
    crate::hide_window_console(&mut cmd);
    let output = cmd.output().ok()?;
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

#[cfg(test)]
mod tests {
    use super::*;

    const GHES: Option<&str> = Some("oss.example.com");

    fn attachment_host(raw: &str, enterprise: Option<&str>) -> Option<String> {
        let url = parse_https_url(raw).unwrap();
        github_attachment_host(&url, enterprise).map(str::to_string)
    }

    #[test]
    fn any_public_https_host_parses() {
        for url in [
            "https://github.com/user-attachments/assets/aaaaaaaa-bbbb",
            "https://img.shields.io/badge/ci-passing-green.svg",
            "https://wiki.example.com/download/attachments/1/image.png?version=1",
            "https://zenhub.oss.example.com/api/attachedFiles/abc/image.png",
        ] {
            assert!(parse_https_url(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn insecure_local_and_traversal_urls_are_rejected() {
        for url in [
            "http://github.com/user-attachments/assets/x",
            "https://github.com/user-attachments/../login",
            "https://github.com@evil.example/user-attachments/assets/x",
            "https://127.0.0.1/shot.png",
            "https://[::1]/shot.png",
            "https://localhost/shot.png",
            "https:///shot.png",
        ] {
            assert!(parse_https_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn only_github_uploads_get_a_token() {
        assert_eq!(
            attachment_host("https://github.com/user-attachments/assets/x", None).as_deref(),
            Some("github.com")
        );
        assert_eq!(
            attachment_host("https://github.com/acme/web/assets/12/aaaa", GHES).as_deref(),
            Some("github.com")
        );
        assert_eq!(
            attachment_host("https://oss.example.com/user-attachments/assets/x", GHES).as_deref(),
            Some("oss.example.com")
        );
        assert_eq!(
            attachment_host("https://www.oss.example.com/storage/user/1/files/x", GHES).as_deref(),
            Some("oss.example.com")
        );
        for (url, enterprise) in [
            ("https://oss.example.com/user-attachments/assets/x", None),
            ("https://github.com/acme/web/issues/1", None),
            ("https://github.com/storage/user/1/files/x", GHES),
            ("https://media.oss.example.com/user/1/files/x", GHES),
            ("https://evil.example/user-attachments/assets/x", GHES),
        ] {
            assert_eq!(attachment_host(url, enterprise), None, "{url}");
        }
    }

    #[test]
    fn redirects_resolve_and_stay_on_https() {
        let next = redirect_target(
            "https://github.com/user-attachments/assets/abcd",
            "https://objects.githubusercontent.com/github-production-user-asset/1",
        )
        .unwrap();
        assert_eq!(next.host, "objects.githubusercontent.com");
        let relative = redirect_target("https://cdn.example.com/a/b.png", "c.png").unwrap();
        assert_eq!(relative.url, "https://cdn.example.com/a/c.png");
        assert!(redirect_target(
            "https://github.com/user-attachments/assets/abcd",
            "http://objects.githubusercontent.com/x"
        )
        .is_err());
        assert!(redirect_target("https://cdn.example.com/a.png", "https://127.0.0.1/x").is_err());
    }
}
