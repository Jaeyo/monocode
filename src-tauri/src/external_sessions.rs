//! Read-only discovery of Claude Code and Codex sessions started outside
//! MonoCode, so they can be imported and resumed. Nothing here writes to the
//! provider stores: Codex `thread/resume` appends to its rollout, so previews
//! must come from the files alone.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

const DEFAULT_ACCOUNT_ID: &str = "default";
const DEFAULT_LIST_LIMIT: usize = 100;
const MAX_LIST_LIMIT: usize = 500;
const PROMPT_PREVIEW_CHARS: usize = 200;
/// Claude Code caps sanitized project directory names at this length.
const CLAUDE_PROJECT_DIR_MAX: usize = 200;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSession {
    provider: &'static str,
    id: String,
    account_id: String,
    cwd: String,
    title: Option<String>,
    first_prompt: Option<String>,
    /// Milliseconds since the Unix epoch.
    updated_at: u64,
    size_bytes: u64,
}

#[tauri::command(async)]
pub fn list_external_sessions(
    app: AppHandle,
    provider: String,
    account_ids: Vec<String>,
    project_paths: Vec<String>,
    limit: Option<usize>,
) -> Result<Vec<ExternalSession>, String> {
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT);
    let mut sessions = Vec::new();
    for account_id in unique(account_ids) {
        let Some(root) = provider_root(&app, &provider, &account_id)? else {
            continue;
        };
        match provider.as_str() {
            "claude" => sessions.extend(list_claude_sessions(
                &root,
                &account_id,
                &project_paths,
                limit,
            )),
            "codex" => sessions.extend(list_codex_sessions(
                &root,
                &account_id,
                &project_paths,
                limit,
            )),
            _ => return Err("External sessions are not supported for this provider".into()),
        }
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    sessions.truncate(limit);
    Ok(sessions)
}

/// Look a session up by id in every given account of both providers.
#[tauri::command(async)]
pub fn find_external_session(
    app: AppHandle,
    session_id: String,
    claude_account_ids: Vec<String>,
    codex_account_ids: Vec<String>,
) -> Result<Vec<ExternalSession>, String> {
    let id = session_id.trim();
    validate_session_id(id)?;
    let mut found = Vec::new();
    for account_id in unique(claude_account_ids) {
        if let Some(root) = provider_root(&app, "claude", &account_id)? {
            found.extend(find_claude_session(&root, &account_id, id));
        }
    }
    for account_id in unique(codex_account_ids) {
        if let Some(root) = provider_root(&app, "codex", &account_id)? {
            found.extend(find_codex_session(&root, &account_id, id));
        }
    }
    Ok(found)
}

/// Main-thread user and assistant records of a Claude transcript, trimmed to
/// the fields the importer reads.
#[tauri::command(async)]
pub fn read_claude_session_records(
    app: AppHandle,
    session_id: String,
    account_id: Option<String>,
) -> Result<Vec<Value>, String> {
    validate_session_id(&session_id)?;
    let account_id = account_id.unwrap_or_else(|| DEFAULT_ACCOUNT_ID.to_owned());
    let root = provider_root(&app, "claude", &account_id)?
        .ok_or("The Claude account directory does not exist")?;
    let path = claude_transcript_path(&root, &session_id)
        .ok_or("The Claude session transcript was not found")?;
    read_claude_records(&path)
}

fn provider_root(
    app: &AppHandle,
    provider: &str,
    account_id: &str,
) -> Result<Option<PathBuf>, String> {
    let root = if account_id == DEFAULT_ACCOUNT_ID {
        let (env, dir) = match provider {
            "claude" => ("CLAUDE_CONFIG_DIR", ".claude"),
            "codex" => ("CODEX_HOME", ".codex"),
            _ => return Err("External sessions are not supported for this provider".into()),
        };
        match std::env::var_os(env).filter(|value| !value.is_empty()) {
            Some(path) => PathBuf::from(path),
            None => {
                PathBuf::from(crate::dirs_home().ok_or("Home directory is unavailable")?).join(dir)
            }
        }
    } else {
        // Not provider_account_dir: that creates the directory.
        crate::harness::provider_account_path(app, provider, account_id)?
    };
    Ok(root.is_dir().then_some(root))
}

fn unique(ids: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    for id in ids {
        if !seen.contains(&id) {
            seen.push(id);
        }
    }
    seen
}

fn validate_session_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid session id".into());
    }
    Ok(())
}

/// Same normalization as `pathKey` in src/shared/lib/paths.ts.
fn path_key(path: &str) -> String {
    let windows = path.contains('\\') || is_drive_path(path);
    let slashed = if windows {
        path.replace('\\', "/")
    } else {
        path.to_owned()
    };
    let trimmed = slashed.trim_end_matches('/');
    let trimmed = if trimmed.is_empty() { "/" } else { trimmed };
    if is_drive_path(trimmed) || trimmed.starts_with("//") {
        trimmed.to_lowercase()
    } else {
        trimmed.to_owned()
    }
}

fn is_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes.len() == 2 || bytes[2] == b'/' || bytes[2] == b'\\')
}

fn matches_project(cwd: &str, project_keys: &[String]) -> bool {
    project_keys.contains(&path_key(cwd))
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map_or(0, |meta| meta.len())
}

/// Newest first, so callers can stop once they have enough matches.
fn newest_first(paths: Vec<PathBuf>) -> Vec<(PathBuf, u64)> {
    let mut stamped: Vec<(PathBuf, u64)> = paths
        .into_iter()
        .map(|path| {
            let modified = modified_ms(&path);
            (path, modified)
        })
        .collect();
    stamped.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    stamped
}

fn preview(text: &str) -> Option<String> {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.chars().count() <= PROMPT_PREVIEW_CHARS {
        return Some(collapsed);
    }
    let mut cut: String = collapsed.chars().take(PROMPT_PREVIEW_CHARS).collect();
    cut.push('…');
    Some(cut)
}

// ---------------------------------------------------------------------------
// Claude Code: <config>/projects/<sanitized cwd>/<session id>.jsonl

/// Claude Code replaces every non-alphanumeric character of the cwd with '-'.
fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn claude_project_dirs(root: &Path, project_paths: &[String]) -> Vec<PathBuf> {
    let projects = root.join("projects");
    let Ok(entries) = std::fs::read_dir(&projects) else {
        return Vec::new();
    };
    let names: Vec<String> = project_paths
        .iter()
        .map(|path| claude_project_dir_name(path.trim_end_matches(['/', '\\'])))
        .collect();
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            names.iter().any(|wanted| {
                // Long names are truncated and suffixed with a hash.
                name == *wanted
                    || (wanted.len() > CLAUDE_PROJECT_DIR_MAX
                        && name.starts_with(&format!("{}-", &wanted[..CLAUDE_PROJECT_DIR_MAX])))
            })
        })
        .map(|entry| entry.path())
        .collect()
}

fn list_claude_sessions(
    root: &Path,
    account_id: &str,
    project_paths: &[String],
    limit: usize,
) -> Vec<ExternalSession> {
    let keys: Vec<String> = project_paths.iter().map(|path| path_key(path)).collect();
    let files: Vec<PathBuf> = claude_project_dirs(root, project_paths)
        .into_iter()
        .flat_map(|dir| std::fs::read_dir(dir).into_iter().flatten().flatten())
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "jsonl"))
        .collect();
    let mut sessions = Vec::new();
    for (path, updated_at) in newest_first(files) {
        if sessions.len() >= limit {
            break;
        }
        let Some(session) = claude_session_from_file(&path, account_id, updated_at) else {
            continue;
        };
        if matches_project(&session.cwd, &keys) {
            sessions.push(session);
        }
    }
    sessions
}

fn claude_transcript_path(root: &Path, id: &str) -> Option<PathBuf> {
    let name = format!("{id}.jsonl");
    std::fs::read_dir(root.join("projects"))
        .ok()?
        .flatten()
        .map(|project| project.path().join(&name))
        .find(|candidate| candidate.is_file())
}

fn find_claude_session(root: &Path, account_id: &str, id: &str) -> Option<ExternalSession> {
    let path = claude_transcript_path(root, id)?;
    claude_session_from_file(&path, account_id, modified_ms(&path))
}

/// None when the file is not a resumable conversation (no cwd or no prompt).
fn claude_session_from_file(
    path: &Path,
    account_id: &str,
    updated_at: u64,
) -> Option<ExternalSession> {
    let id = path.file_stem()?.to_string_lossy().into_owned();
    let file = std::fs::File::open(path).ok()?;
    let mut cwd = None;
    let mut title = None;
    let mut first_prompt = None;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        // Skip the JSON parse for the bulk of a transcript.
        let wants_cwd = cwd.is_none() && line.contains("\"cwd\"");
        let wants_prompt = first_prompt.is_none() && line.contains("\"type\":\"user\"");
        let wants_title = line.contains("\"type\":\"ai-title\"")
            || line.contains("\"type\":\"custom-title\"")
            || line.contains("\"type\":\"summary\"");
        if !(wants_cwd || wants_prompt || wants_title) {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if cwd.is_none() {
            cwd = record
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
        }
        match record.get("type").and_then(Value::as_str) {
            Some("user") if first_prompt.is_none() => {
                first_prompt = claude_prompt_text(&record).and_then(|text| preview(&text));
            }
            Some("custom-title") => {
                title = record
                    .get("customTitle")
                    .and_then(Value::as_str)
                    .and_then(preview)
                    .or(title);
            }
            Some("ai-title") => {
                title = record
                    .get("aiTitle")
                    .and_then(Value::as_str)
                    .and_then(preview)
                    .or(title);
            }
            Some("summary") if title.is_none() => {
                title = record
                    .get("summary")
                    .and_then(Value::as_str)
                    .and_then(preview);
            }
            _ => {}
        }
    }
    let first_prompt = first_prompt?;
    Some(ExternalSession {
        provider: "claude",
        id,
        account_id: account_id.to_owned(),
        cwd: cwd?,
        title,
        first_prompt: Some(first_prompt),
        updated_at,
        size_bytes: file_size(path),
    })
}

/// Text the user typed, ignoring tool results, meta rows and command wrappers.
fn claude_prompt_text(record: &Value) -> Option<String> {
    if is_true(record, "isMeta")
        || is_true(record, "isSidechain")
        || is_true(record, "isCompactSummary")
    {
        return None;
    }
    let content = record.pointer("/message/content")?;
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty() && !text.starts_with('<')).then(|| text.to_owned())
}

fn is_true(record: &Value, key: &str) -> bool {
    record.get(key).and_then(Value::as_bool) == Some(true)
}

fn read_claude_records(path: &Path) -> Result<Vec<Value>, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut records = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| error.to_string())?;
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let kind = record.get("type").and_then(Value::as_str);
        if !matches!(kind, Some("user" | "assistant")) || is_true(&record, "isSidechain") {
            continue;
        }
        // Drop toolUseResult and friends: they duplicate message content.
        let mut trimmed = serde_json::Map::new();
        for key in [
            "type",
            "uuid",
            "timestamp",
            "isMeta",
            "isCompactSummary",
            "message",
        ] {
            if let Some(value) = record.get(key) {
                trimmed.insert(key.to_owned(), value.clone());
            }
        }
        records.push(Value::Object(trimmed));
    }
    Ok(records)
}

// ---------------------------------------------------------------------------
// Codex: <home>/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl[.zst]

fn codex_rollouts(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            codex_rollouts(&path, out);
        } else if kind.is_file() && is_rollout_name(&entry.file_name().to_string_lossy()) {
            out.push(path);
        }
    }
}

fn is_rollout_name(name: &str) -> bool {
    name.starts_with("rollout-") && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
}

fn open_rollout(path: &Path) -> Option<BufReader<Box<dyn Read>>> {
    let file = std::fs::File::open(path).ok()?;
    let reader: Box<dyn Read> = if path.extension().is_some_and(|ext| ext == "zst") {
        Box::new(zstd::stream::read::Decoder::new(file).ok()?)
    } else {
        Box::new(file)
    };
    Some(BufReader::new(reader))
}

/// Latest `thread_name` per thread id from `session_index.jsonl`.
fn codex_thread_names(home: &Path) -> HashMap<String, String> {
    let mut names = HashMap::new();
    let Ok(file) = std::fs::File::open(home.join("session_index.jsonl")) else {
        return names;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let (Some(id), Some(name)) = (
            record.get("id").and_then(Value::as_str),
            record.get("thread_name").and_then(Value::as_str),
        ) {
            if let Some(name) = preview(name) {
                names.insert(id.to_owned(), name);
            }
        }
    }
    names
}

fn list_codex_sessions(
    home: &Path,
    account_id: &str,
    project_paths: &[String],
    limit: usize,
) -> Vec<ExternalSession> {
    let keys: Vec<String> = project_paths.iter().map(|path| path_key(path)).collect();
    let mut files = Vec::new();
    codex_rollouts(&home.join("sessions"), &mut files);
    let names = codex_thread_names(home);
    let mut sessions: Vec<ExternalSession> = Vec::new();
    for (path, updated_at) in newest_first(files) {
        if sessions.len() >= limit {
            break;
        }
        let Some(mut session) = codex_session_from_file(&path, account_id, updated_at) else {
            continue;
        };
        // A compressed rollout and its plain tail are one thread.
        if !matches_project(&session.cwd, &keys) || sessions.iter().any(|s| s.id == session.id) {
            continue;
        }
        session.title = names.get(&session.id).cloned();
        sessions.push(session);
    }
    sessions
}

fn find_codex_session(home: &Path, account_id: &str, id: &str) -> Option<ExternalSession> {
    let mut files = Vec::new();
    codex_rollouts(&home.join("sessions"), &mut files);
    let path = newest_first(files).into_iter().find_map(|(path, _)| {
        let name = path.file_name()?.to_string_lossy().into_owned();
        (name.ends_with(&format!("-{id}.jsonl")) || name.ends_with(&format!("-{id}.jsonl.zst")))
            .then_some(path)
    })?;
    let mut session = codex_session_from_file(&path, account_id, modified_ms(&path))?;
    session.title = codex_thread_names(home).remove(&session.id);
    Some(session)
}

/// None for subagent and review threads, which are not user conversations.
fn codex_session_from_file(
    path: &Path,
    account_id: &str,
    updated_at: u64,
) -> Option<ExternalSession> {
    let mut reader = open_rollout(path)?;
    let mut first = String::new();
    reader.read_line(&mut first).ok()?;
    let meta: Value = serde_json::from_str(&first).ok()?;
    if meta.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = meta.get("payload")?;
    if !is_user_thread(payload) {
        return None;
    }
    let id = payload.get("id").and_then(Value::as_str)?.to_owned();
    let cwd = payload.get("cwd").and_then(Value::as_str)?.to_owned();
    let mut first_prompt = None;
    for line in reader.lines().map_while(Result::ok) {
        if !(line.contains("\"UserMessage\"") || line.contains("\"user_message\"")) {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(text) = codex_prompt_text(&record) {
            first_prompt = preview(&text);
            break;
        }
    }
    Some(ExternalSession {
        provider: "codex",
        id,
        account_id: account_id.to_owned(),
        cwd,
        title: None,
        first_prompt,
        updated_at,
        size_bytes: file_size(path),
    })
}

fn is_user_thread(payload: &Value) -> bool {
    match payload.get("thread_source").and_then(Value::as_str) {
        Some(source) => source == "user",
        // Older rollouts: subagent threads record an object source.
        None => payload.get("source").is_none_or(Value::is_string),
    }
}

fn codex_prompt_text(record: &Value) -> Option<String> {
    let payload = record.get("payload")?;
    let text = match payload.get("type").and_then(Value::as_str)? {
        "item_completed" => {
            let item = payload.get("item")?;
            if item.get("type").and_then(Value::as_str) != Some("UserMessage") {
                return None;
            }
            item.get("content")?
                .as_array()?
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        }
        "user_message" => payload.get("message").and_then(Value::as_str)?.to_owned(),
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    struct Tmp(PathBuf);

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tmp(label: &str) -> Tmp {
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "monocode-external-{label}-{}-{seq}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }

    fn write_jsonl(path: &Path, records: &[Value]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body = records.iter().map(|r| format!("{r}\n")).collect::<String>();
        std::fs::write(path, body).unwrap();
    }

    fn claude_fixture(root: &Path, cwd: &str, id: &str, prompt: &str) -> PathBuf {
        let path = root
            .join("projects")
            .join(claude_project_dir_name(cwd))
            .join(format!("{id}.jsonl"));
        write_jsonl(
            &path,
            &[
                json!({"type": "permission-mode", "permissionMode": "default"}),
                json!({"type": "user", "cwd": cwd, "isMeta": true,
                       "message": {"role": "user", "content": "<local-command-caveat>x"}}),
                json!({"type": "user", "cwd": cwd,
                       "message": {"role": "user", "content": prompt}}),
                json!({"type": "assistant", "cwd": cwd, "isSidechain": true,
                       "message": {"role": "assistant", "content": [{"type": "text", "text": "side"}]}}),
                json!({"type": "assistant", "cwd": cwd, "toolUseResult": {"big": true},
                       "message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}}),
                json!({"type": "ai-title", "aiTitle": "Old title"}),
                json!({"type": "ai-title", "aiTitle": "New title"}),
            ],
        );
        path
    }

    fn codex_fixture(home: &Path, cwd: &str, id: &str, thread_source: Option<&str>) -> PathBuf {
        let path = home
            .join("sessions/2026/09/02")
            .join(format!("rollout-2026-09-02T11-20-41-{id}.jsonl"));
        let mut payload = json!({"id": id, "cwd": cwd, "source": "cli"});
        if let Some(source) = thread_source {
            payload["thread_source"] = json!(source);
        }
        write_jsonl(
            &path,
            &[
                json!({"type": "session_meta", "payload": payload}),
                json!({"type": "response_item", "payload": {"type": "message", "role": "user",
                       "content": [{"type": "input_text", "text": "# AGENTS.md instructions"}]}}),
                json!({"type": "event_msg", "payload": {"type": "item_completed", "item": {
                       "type": "UserMessage", "id": "u1",
                       "content": [{"type": "text", "text": "Review the PR", "text_elements": []}]}}}),
            ],
        );
        path
    }

    #[test]
    fn claude_project_dir_name_matches_claude_code() {
        assert_eq!(
            claude_project_dir_name("/Users/user/vault-work"),
            "-Users-user-vault-work"
        );
        assert_eq!(claude_project_dir_name("/a/b.c_d e"), "-a-b-c-d-e");
    }

    #[test]
    fn path_key_trims_slashes_and_folds_windows_case() {
        assert_eq!(path_key("/repo/"), "/repo");
        assert_eq!(path_key("/"), "/");
        assert_eq!(path_key("C:\\Repo\\"), "c:/repo");
        assert_eq!(path_key("/Repo"), "/Repo");
    }

    #[test]
    fn lists_claude_sessions_for_the_project_only() {
        let root = tmp("claude-list");
        claude_fixture(&root.0, "/work/app", "aaa", "Fix the login bug");
        claude_fixture(&root.0, "/work/other", "bbb", "Elsewhere");
        // Same sanitized dir name, different real cwd.
        claude_fixture(&root.0, "/work-app", "ccc", "Collision");

        let sessions = list_claude_sessions(&root.0, "default", &["/work/app/".into()], 10);

        assert_eq!(sessions.len(), 1);
        let session = &sessions[0];
        assert_eq!(session.provider, "claude");
        assert_eq!(session.id, "aaa");
        assert_eq!(session.cwd, "/work/app");
        assert_eq!(session.title.as_deref(), Some("New title"));
        assert_eq!(session.first_prompt.as_deref(), Some("Fix the login bug"));
        assert_eq!(session.account_id, "default");
    }

    #[test]
    fn claude_session_without_a_prompt_is_skipped() {
        let root = tmp("claude-empty");
        let path = root.0.join("projects/-w/empty.jsonl");
        write_jsonl(
            &path,
            &[json!({"type": "user", "cwd": "/w", "isMeta": true,
                                    "message": {"content": "meta"}})],
        );
        assert!(claude_session_from_file(&path, "default", 0).is_none());
    }

    #[test]
    fn finds_claude_session_by_id_in_any_project() {
        let root = tmp("claude-find");
        claude_fixture(&root.0, "/work/app", "aaa", "Prompt");
        let found = find_claude_session(&root.0, "work", "aaa").unwrap();
        assert_eq!(found.cwd, "/work/app");
        assert_eq!(found.account_id, "work");
        assert!(find_claude_session(&root.0, "work", "missing").is_none());
    }

    #[test]
    fn claude_records_keep_main_thread_messages_only() {
        let root = tmp("claude-records");
        let path = claude_fixture(&root.0, "/work/app", "aaa", "Prompt");
        let records = read_claude_records(&path).unwrap();
        let kinds: Vec<&str> = records
            .iter()
            .map(|r| r["type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["user", "user", "assistant"]);
        assert!(records.iter().all(|r| r.get("toolUseResult").is_none()));
        assert!(records.iter().all(|r| r.get("cwd").is_none()));
    }

    #[test]
    fn lists_codex_user_threads_for_the_project() {
        let home = tmp("codex-list");
        codex_fixture(&home.0, "/work/app", "t-user", Some("user"));
        codex_fixture(&home.0, "/work/app", "t-sub", Some("subagent"));
        codex_fixture(&home.0, "/work/app", "t-review", Some("guardian_review"));
        codex_fixture(&home.0, "/work/other", "t-other", Some("user"));
        write_jsonl(
            &home.0.join("session_index.jsonl"),
            &[
                json!({"id": "t-user", "thread_name": "First name", "updated_at": "x"}),
                json!({"id": "t-user", "thread_name": "Renamed", "updated_at": "y"}),
            ],
        );

        let sessions = list_codex_sessions(&home.0, "default", &["/work/app".into()], 10);

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "t-user");
        assert_eq!(sessions[0].title.as_deref(), Some("Renamed"));
        assert_eq!(sessions[0].first_prompt.as_deref(), Some("Review the PR"));
    }

    #[test]
    fn codex_threads_without_thread_source_use_the_source_shape() {
        let home = tmp("codex-legacy");
        codex_fixture(&home.0, "/work/app", "legacy", None);
        let sessions = list_codex_sessions(&home.0, "default", &["/work/app".into()], 10);
        assert_eq!(sessions.len(), 1);
        assert!(is_user_thread(&json!({"source": "vscode"})));
        assert!(!is_user_thread(
            &json!({"source": {"subagent": {"other": "guardian"}}})
        ));
    }

    #[test]
    fn reads_compressed_codex_rollouts() {
        let home = tmp("codex-zst");
        let plain = codex_fixture(&home.0, "/work/app", "zipped", Some("user"));
        let bytes = std::fs::read(&plain).unwrap();
        let compressed = plain.with_extension("jsonl.zst");
        std::fs::write(
            &compressed,
            zstd::stream::encode_all(&bytes[..], 0).unwrap(),
        )
        .unwrap();
        std::fs::remove_file(&plain).unwrap();

        let found = find_codex_session(&home.0, "default", "zipped").unwrap();
        assert_eq!(found.cwd, "/work/app");
        assert_eq!(found.first_prompt.as_deref(), Some("Review the PR"));
    }

    #[test]
    fn list_limit_stops_after_enough_matches() {
        let root = tmp("claude-limit");
        for id in ["a", "b", "c"] {
            claude_fixture(&root.0, "/w", id, "Prompt");
        }
        assert_eq!(
            list_claude_sessions(&root.0, "default", &["/w".into()], 2).len(),
            2
        );
    }

    #[test]
    fn rejects_unsafe_session_ids() {
        assert!(validate_session_id("../etc").is_err());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id("bb34a24b-d38c-45d5-be24-fd0faee669d7").is_ok());
    }
}
