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
/// can render without opening `img-src` / `media-src` to GitHub's CDNs.
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
    let mut current = parse_allowed_media_url(url, enterprise)?;
    // The token belongs to the site host the URL started on, and is only ever
    // sent back to that same host.
    let token_host = github_site_host(&current.host, enterprise).map(str::to_string);
    let token = token_host.as_deref().and_then(github_auth_token);
    let agent = ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT)
        .redirects(0)
        .build();

    for _ in 0..MAX_REDIRECTS {
        if !is_allowed_media_target(&current, enterprise) {
            return Err("That media host is not allowed".into());
        }
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

fn parse_allowed_media_url(raw: &str, enterprise: Option<&str>) -> Result<MediaUrl, String> {
    let parsed = parse_https_url(raw)?;
    if !is_allowed_media_target(&parsed, enterprise) {
        return Err("That media host is not allowed".into());
    }
    Ok(parsed)
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

fn is_allowed_media_target(url: &MediaUrl, enterprise: Option<&str>) -> bool {
    if let Some(site) = github_site_host(&url.host, enterprise) {
        return is_github_attachment_path(&url.path)
            || (Some(site) == enterprise && is_enterprise_storage_path(&url.path));
    }
    if enterprise.is_some_and(|host| is_enterprise_media_host(&url.host, host)) {
        return true;
    }
    is_github_media_cdn(&url.host) || is_linear_uploads(&url.host) || is_github_asset_s3(&url.host)
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

/// GHES with subdomain isolation serves uploads from `media.<host>`; the
/// `/user-attachments/` URL redirects there with a signed `?token=`.
fn is_enterprise_media_host(host: &str, enterprise: &str) -> bool {
    host.strip_prefix("media.") == Some(enterprise)
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

fn is_github_media_cdn(host: &str) -> bool {
    host == "githubusercontent.com" || host.ends_with(".githubusercontent.com")
}

fn is_linear_uploads(host: &str) -> bool {
    host == "uploads.linear.app" || host.ends_with(".uploads.linear.app")
}

fn is_github_asset_s3(host: &str) -> bool {
    let s3 = host.ends_with(".s3.amazonaws.com")
        || (host.contains(".s3.") && host.ends_with(".amazonaws.com"));
    s3 && (host.starts_with("github-production-user-asset-")
        || host.starts_with("github-production-media.")
        || host.starts_with("github-production-media-"))
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

    fn parse_allowed_media_url_dotcom(raw: &str) -> Result<MediaUrl, String> {
        parse_allowed_media_url(raw, None)
    }

    #[test]
    fn enterprise_attachments_are_allowed_only_when_configured() {
        for url in [
            "https://oss.example.com/user-attachments/assets/aaaaaaaa-bbbb",
            "https://oss.example.com/acme/web/assets/12/aaaaaaaa-bbbb",
            "https://oss.example.com/storage/user/12/files/aaaaaaaa-bbbb",
            "https://media.oss.example.com/user/12/files/aaaaaaaa-bbbb?token=x",
        ] {
            assert!(parse_allowed_media_url(url, GHES).is_ok(), "{url}");
            assert!(parse_allowed_media_url(url, None).is_err(), "{url}");
        }
        assert!(
            parse_allowed_media_url("https://oss.example.com/acme/web/issues/1", GHES).is_err()
        );
        assert!(
            parse_allowed_media_url("https://github.com/storage/user/1/files/x", GHES).is_err()
        );
        assert!(
            parse_allowed_media_url("https://media.evil.example/user/1/files/x", GHES).is_err()
        );
        assert!(parse_allowed_media_url("https://x.media.oss.example.com/user/1", GHES).is_err());
    }

    #[test]
    fn site_host_names_the_token_login() {
        assert_eq!(github_site_host("github.com", GHES), Some("github.com"));
        assert_eq!(
            github_site_host("www.oss.example.com", GHES),
            Some("oss.example.com")
        );
        assert_eq!(github_site_host("oss.example.com", None), None);
        assert_eq!(github_site_host("media.oss.example.com", GHES), None);
    }

    #[test]
    fn github_and_linear_attachments_are_allowed() {
        assert!(parse_allowed_media_url_dotcom(
            "https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        )
        .is_ok());
        assert!(parse_allowed_media_url_dotcom(
            "https://user-images.githubusercontent.com/1/shot.png"
        )
        .is_ok());
        assert!(
            parse_allowed_media_url_dotcom("https://uploads.linear.app/org/uuid/file.png").is_ok()
        );
        assert!(parse_allowed_media_url_dotcom(
            "https://github-production-user-asset-6210df.s3.amazonaws.com/1/shot.png"
        )
        .is_ok());
        assert!(parse_allowed_media_url_dotcom(
            "https://github.com/acme/web/assets/12/aaaaaaaa-bbbb-cccc"
        )
        .is_ok());
    }

    #[test]
    fn github_pages_other_hosts_and_traversal_are_rejected() {
        assert!(parse_allowed_media_url_dotcom("https://github.com/acme/web/issues/1").is_err());
        assert!(parse_allowed_media_url_dotcom("https://github.com/acme/web/assets").is_err());
        assert!(
            parse_allowed_media_url_dotcom("https://github.com/user-attachments/../login").is_err()
        );
        assert!(
            parse_allowed_media_url_dotcom("http://github.com/user-attachments/assets/x").is_err()
        );
        assert!(parse_allowed_media_url_dotcom("https://evil.example/shot.png").is_err());
        assert!(parse_allowed_media_url_dotcom(
            "https://github.com@evil.example/user-attachments/assets/x"
        )
        .is_err());
        assert!(parse_allowed_media_url_dotcom("https://127.0.0.1/shot.png").is_err());
    }

    #[test]
    fn redirects_stay_on_allowed_hosts() {
        let next = redirect_target(
            "https://github.com/user-attachments/assets/abcd",
            "https://objects.githubusercontent.com/github-production-user-asset/1",
        )
        .unwrap();
        assert_eq!(next.host, "objects.githubusercontent.com");
        assert!(redirect_target(
            "https://github.com/user-attachments/assets/abcd",
            "https://evil.example/shot.png"
        )
        .is_ok());
        assert!(!is_allowed_media_target(
            &redirect_target(
                "https://github.com/user-attachments/assets/abcd",
                "https://evil.example/shot.png"
            )
            .unwrap(),
            None
        ));
        assert!(redirect_target(
            "https://github.com/user-attachments/assets/abcd",
            "http://objects.githubusercontent.com/x"
        )
        .is_err());
    }
}
