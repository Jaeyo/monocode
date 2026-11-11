//! A color theme another app (Scene) can set by writing files, the same way it
//! themes Zed or ZapFast: it drops a theme file into `<app data>/themes/` and
//! names it in `<app data>/appearance.json` as `colorTheme`. Restoring the
//! original key (or removing it) brings the built-in theme back.
//!
//! Rust only finds and reads the selected file; the webview validates the JSON
//! and turns it into CSS variables (`settings/model/externalTheme.ts`).
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::jsonc::strip_jsonc_comments;

pub const CHANGED_EVENT: &str = "monocode:external-theme-changed";
const SELECTION_FILE: &str = "appearance.json";
const SELECTION_KEY: &str = "colorTheme";
const THEMES_DIR: &str = "themes";
const MAX_THEME_BYTES: u64 = 512 * 1024;
const POLL_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalThemeFile {
    /// The file name `colorTheme` names, such as `scene.json`.
    pub name: String,
    /// The file's text, unparsed.
    pub source: String,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// A plain `*.json` file name directly inside `themes/`: no separators, no
/// parent references, nothing hidden.
fn is_theme_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.ends_with(".json")
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn read_selection(base: &Path) -> Result<Option<serde_json::Map<String, Value>>, String> {
    let path = base.join(SELECTION_FILE);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let stripped = strip_jsonc_comments(&raw)
        .ok_or_else(|| format!("{}: unterminated comment", path.display()))?;
    match serde_json::from_str::<Value>(&stripped) {
        Ok(Value::Object(map)) => Ok(Some(map)),
        Ok(_) => Err(format!("{}: expected a JSON object", path.display())),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

/// The selected theme file name, when `colorTheme` names one.
fn selected_name(base: &Path) -> Result<Option<String>, String> {
    let Some(map) = read_selection(base)? else {
        return Ok(None);
    };
    match map.get(SELECTION_KEY) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(name)) if name.is_empty() => Ok(None),
        Some(Value::String(name)) if is_theme_file_name(name) => Ok(Some(name.clone())),
        Some(other) => Err(format!("{SELECTION_KEY} is not a theme file name: {other}")),
    }
}

/// The selected theme, or `None` when no theme is selected or its file is gone.
pub(crate) fn read_from(base: &Path) -> Result<Option<ExternalThemeFile>, String> {
    let Some(name) = selected_name(base)? else {
        return Ok(None);
    };
    let path = base.join(THEMES_DIR).join(&name);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    if !metadata.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if metadata.len() > MAX_THEME_BYTES {
        return Err(format!("{} is larger than 512 KB", path.display()));
    }
    let source = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Some(ExternalThemeFile { name, source }))
}

/// Removes `colorTheme` and keeps every other key.
pub(crate) fn clear_in(base: &Path) -> Result<(), String> {
    let Some(mut map) = read_selection(base)? else {
        return Ok(());
    };
    if map.remove(SELECTION_KEY).is_none() {
        return Ok(());
    }
    let text = serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
    let path = base.join(SELECTION_FILE);
    let temp = base.join(format!(".{SELECTION_FILE}.tmp"));
    std::fs::write(&temp, format!("{text}\n")).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())
}

/// What the watcher compares: size and modification time of the selection file
/// and of every theme file. Theme files are few and small, and listing them also
/// sees a selected file appear after `appearance.json` names it.
type Signature = Vec<(PathBuf, u64, Option<SystemTime>)>;

fn signature(base: &Path) -> Signature {
    let mut paths = vec![base.join(SELECTION_FILE)];
    if let Ok(entries) = std::fs::read_dir(base.join(THEMES_DIR)) {
        paths.extend(
            entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path()),
        );
    }
    paths.sort();
    paths
        .into_iter()
        .filter_map(|path| {
            let metadata = std::fs::metadata(&path).ok()?;
            Some((path, metadata.len(), metadata.modified().ok()))
        })
        .collect()
}

/// Polls the files once a second and tells every window when they change.
/// Polling a few small files costs less than a file-system watcher dependency,
/// and a theme switch only needs to show within a second.
pub fn init(app: &AppHandle) {
    let Ok(base) = data_dir(app) else {
        return;
    };
    let app = app.clone();
    std::thread::Builder::new()
        .name("external-theme-watch".into())
        .spawn(move || {
            let mut last = signature(&base);
            loop {
                std::thread::sleep(POLL_INTERVAL);
                let next = signature(&base);
                if next == last {
                    continue;
                }
                last = next;
                // Windows read the theme again themselves, so they also see why
                // a selection cannot be read.
                let _ = app.emit(CHANGED_EVENT, ());
            }
        })
        .ok();
}

#[tauri::command]
pub fn read_external_theme(app: AppHandle) -> Result<Option<ExternalThemeFile>, String> {
    read_from(&data_dir(&app)?)
}

/// Settings → "Use built-in theme". The watcher then tells every window.
#[tauri::command]
pub fn clear_external_theme(app: AppHandle) -> Result<(), String> {
    clear_in(&data_dir(&app)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monocode-external-theme-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(THEMES_DIR)).unwrap();
        dir
    }

    #[test]
    fn theme_file_names_stay_inside_the_themes_folder() {
        assert!(is_theme_file_name("scene.json"));
        assert!(is_theme_file_name("scene-dark_2.json"));
        assert!(!is_theme_file_name("../scene.json"));
        assert!(!is_theme_file_name("a/scene.json"));
        assert!(!is_theme_file_name(".scene.json"));
        assert!(!is_theme_file_name("scene.toml"));
        assert!(!is_theme_file_name(""));
    }

    #[test]
    fn reads_the_selected_theme_and_ignores_a_missing_one() {
        let base = scratch("read");
        assert_eq!(read_from(&base).unwrap(), None);

        std::fs::write(
            base.join(SELECTION_FILE),
            "{\n  // set by Scene\n  \"colorTheme\": \"scene.json\"\n}",
        )
        .unwrap();
        assert_eq!(read_from(&base).unwrap(), None);

        std::fs::write(base.join(THEMES_DIR).join("scene.json"), "{\"format\":1}").unwrap();
        assert_eq!(
            read_from(&base).unwrap(),
            Some(ExternalThemeFile {
                name: "scene.json".into(),
                source: "{\"format\":1}".into(),
            })
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_a_selection_outside_the_themes_folder() {
        let base = scratch("escape");
        std::fs::write(base.join(SELECTION_FILE), "{\"colorTheme\":\"../x.json\"}").unwrap();
        assert!(read_from(&base).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn clearing_keeps_other_keys() {
        let base = scratch("clear");
        std::fs::write(
            base.join(SELECTION_FILE),
            "{\"colorTheme\":\"scene.json\",\"other\":1}",
        )
        .unwrap();
        clear_in(&base).unwrap();
        let text = std::fs::read_to_string(base.join(SELECTION_FILE)).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value, serde_json::json!({ "other": 1 }));
        clear_in(&base).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn signature_changes_when_a_theme_file_appears() {
        let base = scratch("signature");
        let before = signature(&base);
        std::fs::write(base.join(THEMES_DIR).join("scene.json"), "{}").unwrap();
        assert_ne!(signature(&base), before);
        let _ = std::fs::remove_dir_all(&base);
    }
}
