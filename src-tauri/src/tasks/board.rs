//! The task folder on disk: `.tasks.json` lists the columns, each column is a
//! subfolder holding one markdown file per task plus a `.order` hint, and
//! deleted tasks wait in `.trash` until the undo window passes.
//!
//! Reading never writes. A file gets a real id, and the canonical layout, only
//! when the app first changes it.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use yaml_rust2::Yaml;

use super::format::{self, Doc, Parsed, TaskLink, Todo};

pub const CONFIG_FILE: &str = ".tasks.json";
pub const ORDER_FILE: &str = ".order";
pub const ASSETS_DIR: &str = ".assets";
pub const TRASH_DIR: &str = ".trash";
pub const DEFAULT_COLUMNS: [&str; 3] = ["TODO", "In Progress", "Done"];
const FILE_MAX_BYTES: u64 = 4 * 1024 * 1024;
const NAME_MAX_CHARS: usize = 80;
/// Errors starting with this tell the UI to reload instead of showing a failure.
pub const STALE: &str = "stale:";

/// Every write to the folder goes through this lock, so a read-modify-write of
/// one file can never interleave with another.
static LOCK: Mutex<()> = Mutex::new(());

pub fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "config_version")]
    pub version: u32,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub done_column: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn config_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    /// False while the id is a placeholder for a file without one.
    pub persisted: bool,
    /// Relative to the root, `/`-separated.
    pub path: String,
    pub column: String,
    pub file_name: String,
    pub title: String,
    pub status: String,
    pub due: Option<String>,
    pub priority: Option<String>,
    pub tags: Vec<String>,
    pub links: Vec<TaskLink>,
    pub sessions: Vec<String>,
    pub project: Option<String>,
    pub todos: Vec<Todo>,
    pub document: String,
    /// The file cannot be parsed safely; the app shows it but never writes it.
    pub read_only: bool,
    pub error: Option<String>,
    /// Another file already uses this file's id.
    pub duplicate: bool,
    pub modified_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    /// Listed in `.tasks.json`; false for a folder found on disk only.
    pub configured: bool,
    pub exists: bool,
    pub tasks: Vec<Task>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub root: String,
    pub configured: bool,
    pub columns: Vec<Column>,
    pub done_column: Option<String>,
    pub warnings: Vec<String>,
}

// ---- paths ----------------------------------------------------------------

pub fn root_path(root: &str) -> Result<PathBuf, String> {
    let path = crate::fs::expand_home(root.trim());
    if !path.is_absolute() {
        return Err("The tasks folder must be an absolute path".into());
    }
    match fs::metadata(&path) {
        Ok(meta) if meta.is_dir() => Ok(path),
        Ok(_) => Err(format!("not_found: {} is not a folder", path.display())),
        Err(_) => Err(format!("not_found: {} does not exist", path.display())),
    }
}

pub fn nfc(text: &str) -> String {
    text.nfc().collect()
}

/// A file or folder name made from user text: separators and characters
/// Finder or Windows reject are dropped, as are leading dots and edge spaces.
pub fn sanitize_name(text: &str) -> String {
    let cleaned: String = nfc(&format::one_line(text))
        .chars()
        .filter(|c| {
            !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control()
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = collapsed
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .chars()
        .take(NAME_MAX_CHARS)
        .collect();
    trimmed
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .to_string()
}

pub fn column_name(text: &str) -> Result<String, String> {
    let name = sanitize_name(text);
    if name.is_empty() {
        return Err("Enter a column name".into());
    }
    Ok(name)
}

/// Resolves a root-relative path from the UI, refusing anything that leaves
/// the root or passes through a symlink.
fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    let mut path = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(part) => {
                path.push(part);
                if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                    return Err("Symlinked task paths are not supported".into());
                }
            }
            _ => return Err("Invalid task path".into()),
        }
    }
    Ok(path)
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn temp_id(relative: &str) -> String {
    format!("~{relative}")
}

/// Time-ordered and URL-safe: 48 bits of milliseconds, 80 random bits, in
/// Crockford base32 — the ULID layout.
pub fn new_id() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let millis = now_millis() as u128 & ((1 << 48) - 1);
    let random = uuid::Uuid::new_v4().as_u128() & ((1 << 80) - 1);
    let mut value = (millis << 80) | random;
    let mut out = [0u8; 26];
    for slot in out.iter_mut().rev() {
        *slot = ALPHABET[(value & 31) as usize];
        value >>= 5;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

pub fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("Invalid path")?;
    let name = path.file_name().ok_or("Invalid path")?.to_string_lossy();
    let temporary = dir.join(format!(".{name}.tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&temporary, contents).map_err(|e| e.to_string())?;
    fs::rename(&temporary, path).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        e.to_string()
    })
}

/// `name.md`, or `name (2).md`… when taken. Comparison is NFC and
/// case-insensitive, matching how macOS volumes treat names.
fn unique_file(dir: &Path, stem: &str, except: Option<&Path>) -> PathBuf {
    let taken: HashSet<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| except.is_none_or(|except| entry.path() != except))
        .map(|entry| nfc(&entry.file_name().to_string_lossy()).to_lowercase())
        .collect();
    let stem = if stem.is_empty() { "Untitled" } else { stem };
    for n in 1.. {
        let name = if n == 1 {
            format!("{stem}.md")
        } else {
            format!("{stem} ({n}).md")
        };
        if !taken.contains(&nfc(&name).to_lowercase()) {
            return dir.join(name);
        }
    }
    unreachable!()
}

// ---- config and order -----------------------------------------------------

pub fn read_config(root: &Path) -> Result<Option<Config>, String> {
    match fs::read_to_string(root.join(CONFIG_FILE)) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("{CONFIG_FILE} could not be read: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn write_config(root: &Path, config: &Config) -> Result<(), String> {
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    write_atomic(&root.join(CONFIG_FILE), &(text + "\n"))
}

fn read_order(dir: &Path) -> Vec<String> {
    fs::read_to_string(dir.join(ORDER_FILE))
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

fn write_order(dir: &Path, ids: &[String]) -> Result<(), String> {
    let mut seen = HashSet::new();
    let lines: Vec<&str> = ids
        .iter()
        .filter(|id| format::valid_id(id) && seen.insert(id.as_str()))
        .map(String::as_str)
        .collect();
    write_atomic(&dir.join(ORDER_FILE), &(lines.join("\n") + "\n"))
}

fn column_dirs(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort_by_key(|name| nfc(name).to_lowercase());
    names
}

/// The on-disk folder for a column name, matched by NFC so a name typed in
/// the app finds a folder macOS reports decomposed.
fn column_dir(root: &Path, name: &str) -> Result<PathBuf, String> {
    let wanted = nfc(name);
    if let Some(found) = column_dirs(root).into_iter().find(|dir| nfc(dir) == wanted) {
        return resolve(root, &found);
    }
    if sanitize_name(name) != wanted || wanted.is_empty() {
        return Err("Invalid column name".into());
    }
    resolve(root, &wanted)
}

// ---- reading --------------------------------------------------------------

struct Scanned {
    task: Task,
    created: i64,
}

fn read_task(root: &Path, column: &str, path: &Path) -> Scanned {
    let rel = relative(root, path);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = nfc(file_name
        .strip_suffix(".md")
        .or_else(|| file_name.strip_suffix(".MD"))
        .unwrap_or(&file_name));
    let meta = fs::metadata(path).ok();
    let modified_at = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    let created = meta
        .as_ref()
        .and_then(|m| m.created().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(modified_at);
    let mut task = Task {
        id: temp_id(&rel),
        persisted: false,
        path: rel,
        column: column.to_string(),
        file_name,
        title: stem.clone(),
        status: String::new(),
        due: None,
        priority: None,
        tags: Vec::new(),
        links: Vec::new(),
        sessions: Vec::new(),
        project: None,
        todos: Vec::new(),
        document: String::new(),
        read_only: false,
        error: None,
        duplicate: false,
        modified_at,
    };
    if meta.as_ref().is_some_and(|m| m.len() > FILE_MAX_BYTES) {
        task.read_only = true;
        task.error = Some("The file is too large to open".into());
        return Scanned { task, created };
    }
    let parsed = fs::read(path)
        .map_err(|e| e.to_string())
        .and_then(|bytes| {
            String::from_utf8(bytes).map_err(|_| "The file is not UTF-8 text".to_string())
        })
        .and_then(|text| Doc::split(&text))
        .and_then(|doc| doc.parse(&stem));
    match parsed {
        Ok(parsed) => apply_parsed(&mut task, parsed),
        Err(error) => {
            task.read_only = true;
            task.error = Some(error);
        }
    }
    Scanned { task, created }
}

fn apply_parsed(task: &mut Task, parsed: Parsed) {
    if let Some(id) = parsed.id {
        task.id = id;
        task.persisted = true;
    }
    task.title = parsed.title;
    task.status = parsed.status;
    task.due = parsed.due;
    task.priority = parsed.priority;
    task.tags = parsed.tags;
    task.links = parsed.links;
    task.sessions = parsed.sessions;
    task.project = parsed.project;
    task.todos = parsed.todos;
    task.document = parsed.document;
}

fn task_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            !name.starts_with('.') && name.to_lowercase().ends_with(".md")
        })
        .collect();
    files.sort_by_key(|path| {
        nfc(&path.file_name().unwrap_or_default().to_string_lossy()).to_lowercase()
    });
    files
}

pub fn load(root: &Path) -> Result<Board, String> {
    let mut warnings = Vec::new();
    let config = match read_config(root) {
        Ok(config) => config,
        Err(error) => {
            warnings.push(error);
            None
        }
    };
    let dirs = column_dirs(root);
    let mut names: Vec<(String, bool)> = Vec::new();
    let mut listed = HashSet::new();
    if let Some(config) = &config {
        for name in &config.columns {
            let key = nfc(name);
            if listed.insert(key.clone()) {
                names.push((key, true));
            }
        }
    }
    for dir in &dirs {
        if listed.insert(nfc(dir)) {
            names.push((nfc(dir), false));
        }
    }

    let mut scanned: Vec<(Column, Vec<Scanned>, Vec<String>)> = Vec::new();
    for (name, configured) in names {
        let dir = dirs.iter().find(|d| nfc(d) == name).map(|d| root.join(d));
        let (tasks, order) = match &dir {
            Some(dir) => (
                task_files(dir)
                    .iter()
                    .map(|path| read_task(root, &name, path))
                    .collect(),
                read_order(dir),
            ),
            None => (Vec::new(), Vec::new()),
        };
        scanned.push((
            Column {
                name,
                configured,
                exists: dir.is_some(),
                tasks: Vec::new(),
            },
            tasks,
            order,
        ));
    }

    // A copied file shares its id with the original; the newer copy yields.
    let mut owners: HashMap<String, (i64, usize, usize)> = HashMap::new();
    for (c, (_, tasks, _)) in scanned.iter().enumerate() {
        for (t, entry) in tasks.iter().enumerate() {
            if !entry.task.persisted {
                continue;
            }
            let candidate = (entry.created, c, t);
            owners
                .entry(entry.task.id.clone())
                .and_modify(|owner| {
                    if (candidate.0, &entry.task.path) < (owner.0, &scanned_path(&scanned, owner)) {
                        *owner = candidate;
                    }
                })
                .or_insert(candidate);
        }
    }
    let mut columns = Vec::new();
    for (c, (mut column, tasks, order)) in scanned.into_iter().enumerate() {
        let mut tasks: Vec<Task> = tasks
            .into_iter()
            .enumerate()
            .map(|(t, entry)| {
                let mut task = entry.task;
                if task.persisted && owners.get(&task.id).is_some_and(|o| (o.1, o.2) != (c, t)) {
                    task.duplicate = true;
                    task.persisted = false;
                    task.id = temp_id(&task.path);
                }
                task
            })
            .collect();
        let rank: HashMap<&str, usize> = order
            .iter()
            .enumerate()
            .map(|(i, id)| (id.as_str(), i))
            .collect();
        tasks.sort_by_key(|task| rank.get(task.id.as_str()).copied().unwrap_or(usize::MAX));
        column.tasks = tasks;
        columns.push(column);
    }
    Ok(Board {
        root: root.to_string_lossy().into_owned(),
        configured: config.is_some(),
        done_column: config.and_then(|c| c.done_column).map(|d| nfc(&d)),
        columns,
        warnings,
    })
}

fn scanned_path(
    scanned: &[(Column, Vec<Scanned>, Vec<String>)],
    owner: &(i64, usize, usize),
) -> String {
    scanned[owner.1].1[owner.2].task.path.clone()
}

/// Turns the folder into a task board: an empty folder gets the default
/// columns, a folder with subfolders adopts them.
pub fn init(root: &Path) -> Result<Board, String> {
    if read_config(root)?.is_none() {
        let mut columns = column_dirs(root);
        if columns.is_empty() {
            for name in DEFAULT_COLUMNS {
                fs::create_dir_all(root.join(name)).map_err(|e| e.to_string())?;
            }
            columns = DEFAULT_COLUMNS.iter().map(|s| s.to_string()).collect();
        }
        let columns: Vec<String> = columns.iter().map(|c| nfc(c)).collect();
        let done_column = columns
            .iter()
            .find(|c| c.eq_ignore_ascii_case("done"))
            .cloned();
        write_config(
            root,
            &Config {
                version: 1,
                columns,
                done_column,
                extra: Default::default(),
            },
        )?;
    }
    load(root)
}

// ---- locating and mutating one task -----------------------------------------

struct Located {
    path: PathBuf,
    column: String,
}

fn locate(root: &Path, id: &str, hint: &str) -> Result<Located, String> {
    let column_of = |path: &Path| {
        path.parent()
            .and_then(|p| p.file_name())
            .map(|n| nfc(&n.to_string_lossy()))
            .unwrap_or_default()
    };
    if let Some(rel) = id.strip_prefix('~') {
        let path = resolve(root, rel)?;
        if !path.is_file() {
            return Err(format!("{STALE} the file was moved or deleted"));
        }
        return Ok(Located {
            column: column_of(&path),
            path,
        });
    }
    let has_id = |path: &Path| {
        fs::read_to_string(path)
            .ok()
            .and_then(|text| Doc::split(&text).ok())
            .and_then(|doc| doc.parse("").ok())
            .and_then(|parsed| parsed.id)
            .is_some_and(|found| found == id)
    };
    if let Ok(path) = resolve(root, hint) {
        if path.is_file() && has_id(&path) {
            return Ok(Located {
                column: column_of(&path),
                path,
            });
        }
    }
    for dir in column_dirs(root) {
        for path in task_files(&root.join(&dir)) {
            if has_id(&path) {
                return Ok(Located {
                    column: nfc(&dir),
                    path,
                });
            }
        }
    }
    Err(format!("{STALE} the task was not found"))
}

fn task_at(root: &Path, column: &str, path: &Path) -> Task {
    read_task(root, column, path).task
}

/// Read-modify-write of one task file, from what is on disk now. Files
/// without an id (or sharing one) get a fresh id and the canonical layout
/// first. `edit` returns the new title when the file should be renamed.
pub fn mutate(
    root: &Path,
    id: &str,
    hint: &str,
    edit: impl FnOnce(&mut Doc) -> Result<Option<String>, String>,
) -> Result<Task, String> {
    let found = locate(root, id, hint)?;
    let (mut doc, title, persisted_id) = open_doc(&found.path)?;
    let new_id = match (&persisted_id, id.starts_with('~')) {
        (Some(existing), false) => existing.clone(),
        _ => new_id(),
    };
    doc.normalize(&new_id, &title);
    let rename_to = edit(&mut doc)?;
    write_atomic(&found.path, &doc.render())?;
    let mut path = found.path.clone();
    if let Some(title) = rename_to {
        path = rename_for_title(&found.path, &title)?;
    }
    Ok(task_at(root, &found.column, &path))
}

fn open_doc(path: &Path) -> Result<(Doc, String, Option<String>), String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let doc =
        Doc::split(&text).map_err(|e| format!("This file cannot be edited in the app: {e}"))?;
    let stem = path
        .file_stem()
        .map(|s| nfc(&s.to_string_lossy()))
        .unwrap_or_default();
    let parsed = doc
        .parse(&stem)
        .map_err(|e| format!("This file cannot be edited in the app: {e}"))?;
    Ok((doc, parsed.title, parsed.id))
}

fn rename_for_title(path: &Path, title: &str) -> Result<PathBuf, String> {
    let stem = sanitize_name(title);
    let current = path
        .file_stem()
        .map(|s| nfc(&s.to_string_lossy()))
        .unwrap_or_default();
    if stem.is_empty() || stem == current {
        return Ok(path.to_path_buf());
    }
    let dir = path.parent().ok_or("Invalid path")?;
    let target = unique_file(dir, &stem, Some(path));
    fs::rename(path, &target).map_err(|e| e.to_string())?;
    Ok(target)
}

/// Gives every placeholder-id task in `tasks` a real id so `.order` can name it.
fn persist_ids(root: &Path, tasks: &[Task]) -> Vec<String> {
    tasks
        .iter()
        .filter_map(|task| {
            if task.persisted {
                return Some(task.id.clone());
            }
            if task.read_only {
                return None;
            }
            mutate(root, &task.id, &task.path, |_| Ok(None))
                .ok()
                .map(|t| t.id)
        })
        .collect()
}

pub fn create(root: &Path, column: &str, title: &str) -> Result<Task, String> {
    let title = format::one_line(title);
    if title.is_empty() {
        return Err("Enter a title".into());
    }
    if title.chars().count() > format::TITLE_MAX {
        return Err("The title is too long".into());
    }
    let dir = column_dir(root, column)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = new_id();
    let path = unique_file(&dir, &sanitize_name(&title), None);
    write_atomic(&path, &format::new_task_text(&id, &title))?;
    let board = load(root)?;
    let existing = board
        .columns
        .iter()
        .find(|c| c.name == nfc(column))
        .map(|c| {
            c.tasks
                .iter()
                .filter(|t| t.id != id)
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut ids = vec![id];
    ids.extend(persist_ids(root, &existing));
    write_order(&dir, &ids)?;
    Ok(task_at(root, &nfc(column), &path))
}

/// Moves a task to `column` at `index` (within that column, after the move).
/// Moving within the same column only reorders.
pub fn move_task(
    root: &Path,
    id: &str,
    hint: &str,
    column: &str,
    index: usize,
) -> Result<Board, String> {
    let found = locate(root, id, hint)?;
    let target_column = nfc(column);
    let target_dir = column_dir(root, &target_column)?;
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let mut path = found.path.clone();
    let source_dir = found.path.parent().ok_or("Invalid path")?.to_path_buf();
    if found.column != target_column {
        let stem = found
            .path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        path = unique_file(&target_dir, &stem, None);
        fs::rename(&found.path, &path).map_err(|e| e.to_string())?;
        let remaining: Vec<String> = read_order(&source_dir)
            .into_iter()
            .filter(|o| o != id)
            .collect();
        write_order(&source_dir, &remaining)?;
    }
    let board = load(root)?;
    let tasks = board
        .columns
        .iter()
        .find(|c| c.name == target_column)
        .map(|c| c.tasks.clone())
        .unwrap_or_default();
    let moved_rel = relative(root, &path);
    let (moved, others): (Vec<Task>, Vec<Task>) =
        tasks.into_iter().partition(|t| t.path == moved_rel);
    let mut ids = persist_ids(root, &others);
    let moved_id = persist_ids(root, &moved);
    let at = index.min(ids.len());
    for (offset, id) in moved_id.into_iter().enumerate() {
        ids.insert(at + offset, id);
    }
    write_order(&target_dir, &ids)?;
    load(root)
}

/// Saves the order the user arranged. `ids` may include placeholder ids,
/// which become real ones.
pub fn reorder(root: &Path, column: &str, ids: &[String]) -> Result<Board, String> {
    let column = nfc(column);
    let dir = column_dir(root, &column)?;
    let board = load(root)?;
    let mut tasks = board
        .columns
        .into_iter()
        .find(|c| c.name == column)
        .map(|c| c.tasks)
        .unwrap_or_default();
    let rank: HashMap<&str, usize> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    tasks.sort_by_key(|task| rank.get(task.id.as_str()).copied().unwrap_or(usize::MAX));
    write_order(&dir, &persist_ids(root, &tasks))?;
    load(root)
}

// ---- images -------------------------------------------------------------------

const IMAGE_MAX_BYTES: u64 = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    pub name: String,
    /// Relative to the task file, so other markdown tools show it too:
    /// `../.assets/<id>/<file>`. Every column sits at the same depth.
    pub markdown_path: String,
    /// The task after the save; it gains an id if it had none.
    pub task: Task,
}

/// Copies an image into `.assets/<task id>/` for the task's document.
pub fn save_image(root: &Path, id: &str, hint: &str, source: &str) -> Result<SavedImage, String> {
    let source = PathBuf::from(source);
    let meta = fs::metadata(&source).map_err(|e| format!("{}: {e}", source.display()))?;
    if !meta.is_file() {
        return Err("Not a file".into());
    }
    if meta.len() > IMAGE_MAX_BYTES {
        return Err(format!(
            "Image is too large (maximum {} MB).",
            IMAGE_MAX_BYTES / 1024 / 1024
        ));
    }
    let extension = source
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Use a PNG, JPG, GIF, WebP, or SVG image.".into());
    }
    let task = if id.starts_with('~') {
        mutate(root, id, hint, |_| Ok(None))?
    } else {
        let found = locate(root, id, hint)?;
        task_at(root, &found.column, &found.path)
    };
    let display = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| format!("image.{extension}"));
    // Markdown links break on spaces and parentheses; keep the name plain.
    let stem: String = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(60)
        .collect();
    let stored = format!("{}-{}.{extension}", now_millis(), stem.trim_matches('-'));
    let dir = root.join(ASSETS_DIR).join(&task.id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::copy(&source, dir.join(&stored)).map_err(|e| e.to_string())?;
    Ok(SavedImage {
        name: display,
        markdown_path: format!("../{ASSETS_DIR}/{}/{stored}", task.id),
        task,
    })
}

// ---- delete and undo --------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashMeta {
    id: String,
    column: String,
    file_name: String,
    index: usize,
}

/// Moves the task (and its images) into `.trash`, returning a token that
/// restores it until `flush_trash` sends it to the system trash.
pub fn delete(root: &Path, id: &str, hint: &str) -> Result<String, String> {
    let found = locate(root, id, hint)?;
    let dir = found.path.parent().ok_or("Invalid path")?.to_path_buf();
    let board = load(root)?;
    let rel = relative(root, &found.path);
    let index = board
        .columns
        .iter()
        .find(|c| c.name == found.column)
        .and_then(|c| c.tasks.iter().position(|t| t.path == rel))
        .unwrap_or(0);
    let real_id = (!id.starts_with('~')).then(|| id.to_string());
    let token = format!("{}-{}", now_millis(), uuid::Uuid::new_v4().simple());
    let staging = root.join(TRASH_DIR).join(&token);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let file_name = found
        .path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    fs::rename(&found.path, staging.join("task.md")).map_err(|e| e.to_string())?;
    if let Some(real_id) = &real_id {
        let assets = root.join(ASSETS_DIR).join(real_id);
        if assets.is_dir() {
            let _ = fs::rename(&assets, staging.join("assets"));
        }
        let order: Vec<String> = read_order(&dir)
            .into_iter()
            .filter(|o| o != real_id)
            .collect();
        write_order(&dir, &order)?;
    }
    let meta = TrashMeta {
        id: real_id.unwrap_or_default(),
        column: found.column,
        file_name,
        index,
    };
    write_atomic(
        &staging.join("meta.json"),
        &serde_json::to_string(&meta).map_err(|e| e.to_string())?,
    )?;
    Ok(token)
}

/// Moves a path to the system trash. On macOS this goes through
/// NSFileManager: the default Finder route needs Apple Events permission,
/// which would prompt the user the first time a task is deleted.
#[cfg(not(test))]
fn to_system_trash(path: &Path) -> Result<(), trash::Error> {
    #[allow(unused_mut)]
    let mut context = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context.delete(path)
}

/// Tests must not fill the developer's Trash.
#[cfg(test)]
fn to_system_trash(path: &Path) -> Result<(), String> {
    fs::remove_dir_all(path).map_err(|e| e.to_string())
}

fn trash_entry(root: &Path, token: &str) -> Result<PathBuf, String> {
    if token.is_empty()
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid undo token".into());
    }
    Ok(root.join(TRASH_DIR).join(token))
}

pub fn restore(root: &Path, token: &str) -> Result<Board, String> {
    let staging = trash_entry(root, token)?;
    let meta: TrashMeta = serde_json::from_str(
        &fs::read_to_string(staging.join("meta.json"))
            .map_err(|_| format!("{STALE} nothing to undo"))?,
    )
    .map_err(|e| e.to_string())?;
    let dir = column_dir(root, &meta.column)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = meta
        .file_name
        .strip_suffix(".md")
        .unwrap_or(&meta.file_name)
        .to_string();
    let path = unique_file(&dir, &stem, None);
    fs::rename(staging.join("task.md"), &path).map_err(|e| e.to_string())?;
    if !meta.id.is_empty() {
        let assets = root.join(ASSETS_DIR).join(&meta.id);
        if staging.join("assets").is_dir() && !assets.exists() {
            fs::create_dir_all(root.join(ASSETS_DIR)).map_err(|e| e.to_string())?;
            let _ = fs::rename(staging.join("assets"), &assets);
        }
        let mut order = read_order(&dir);
        order.retain(|o| o != &meta.id);
        order.insert(meta.index.min(order.len()), meta.id.clone());
        write_order(&dir, &order)?;
    }
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir(root.join(TRASH_DIR));
    load(root)
}

/// Sends staged deletions to the system trash: one token, or all of them.
pub fn flush_trash(root: &Path, token: Option<&str>) -> Result<(), String> {
    let entries: Vec<PathBuf> = match token {
        Some(token) => vec![trash_entry(root, token)?],
        None => fs::read_dir(root.join(TRASH_DIR))
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .collect(),
    };
    for entry in entries.into_iter().filter(|e| e.exists()) {
        to_system_trash(&entry).map_err(|e| e.to_string())?;
    }
    let _ = fs::remove_dir(root.join(TRASH_DIR));
    Ok(())
}

// ---- columns ----------------------------------------------------------------

/// The config as the board shows it now, written out on the first column edit
/// of a folder that has none.
fn effective_config(root: &Path) -> Result<Config, String> {
    let board = load(root)?;
    let mut config = read_config(root).ok().flatten().unwrap_or_default();
    config.version = 1;
    config.columns = board.columns.iter().map(|c| c.name.clone()).collect();
    Ok(config)
}

fn same_name(a: &str, b: &str) -> bool {
    nfc(a).to_lowercase() == nfc(b).to_lowercase()
}

pub fn add_column(root: &Path, name: &str, after: Option<&str>) -> Result<Board, String> {
    let name = column_name(name)?;
    let mut config = effective_config(root)?;
    if config.columns.iter().any(|c| same_name(c, &name)) {
        return Err(format!("A column named \"{name}\" already exists"));
    }
    fs::create_dir_all(resolve(root, &name)?).map_err(|e| e.to_string())?;
    let at = after
        .and_then(|after| config.columns.iter().position(|c| c == &nfc(after)))
        .map(|i| i + 1)
        .unwrap_or(config.columns.len());
    config.columns.insert(at, name);
    write_config(root, &config)?;
    load(root)
}

pub fn rename_column(root: &Path, from: &str, to: &str) -> Result<Board, String> {
    let to = column_name(to)?;
    let from = nfc(from);
    let mut config = effective_config(root)?;
    if config
        .columns
        .iter()
        .any(|c| c != &from && same_name(c, &to))
    {
        return Err(format!("A column named \"{to}\" already exists"));
    }
    let source = column_dir(root, &from)?;
    if source.exists() && from != to {
        fs::rename(&source, resolve(root, &to)?).map_err(|e| e.to_string())?;
    }
    for column in config.columns.iter_mut().filter(|c| **c == from) {
        *column = to.clone();
    }
    if config.done_column.as_deref().map(nfc) == Some(from) {
        config.done_column = Some(to);
    }
    write_config(root, &config)?;
    load(root)
}

/// Deletes a column. One that still holds tasks needs `move_to`, and its tasks
/// go there first, after that column's own tasks.
pub fn delete_column(root: &Path, name: &str, move_to: Option<&str>) -> Result<Board, String> {
    let name = nfc(name);
    let mut config = effective_config(root)?;
    if config.columns.len() <= 1 {
        return Err("The last column cannot be deleted".into());
    }
    let board = load(root)?;
    let tasks = board
        .columns
        .iter()
        .find(|c| c.name == name)
        .map(|c| c.tasks.clone())
        .unwrap_or_default();
    if !tasks.is_empty() {
        let target = move_to
            .map(nfc)
            .filter(|t| *t != name)
            .ok_or("not_empty: choose where its tasks go")?;
        let target_dir = column_dir(root, &target)?;
        fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
        let mut order: Vec<String> = board
            .columns
            .iter()
            .find(|c| c.name == target)
            .map(|c| persist_ids(root, &c.tasks))
            .unwrap_or_default();
        let source_dir = column_dir(root, &name)?;
        for task in &tasks {
            let from = source_dir.join(&task.file_name);
            let stem = from
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let to = unique_file(&target_dir, &stem, None);
            fs::rename(&from, &to).map_err(|e| e.to_string())?;
            if task.persisted {
                order.push(task.id.clone());
            }
        }
        write_order(&target_dir, &order)?;
    }
    let dir = column_dir(root, &name)?;
    if dir.exists() {
        to_system_trash(&dir).map_err(|e| e.to_string())?;
    }
    config.columns.retain(|c| *c != name);
    if config.done_column.as_deref().map(nfc) == Some(name) {
        config.done_column = None;
    }
    write_config(root, &config)?;
    load(root)
}

pub fn reorder_columns(root: &Path, names: &[String]) -> Result<Board, String> {
    let mut config = effective_config(root)?;
    let rank: HashMap<String, usize> = names.iter().enumerate().map(|(i, n)| (nfc(n), i)).collect();
    config
        .columns
        .sort_by_key(|c| rank.get(c).copied().unwrap_or(usize::MAX));
    write_config(root, &config)?;
    load(root)
}

pub fn set_done_column(root: &Path, name: Option<&str>) -> Result<Board, String> {
    let mut config = effective_config(root)?;
    config.done_column = name.map(nfc).filter(|n| config.columns.contains(n));
    write_config(root, &config)?;
    load(root)
}

// ---- field edits ------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Edit {
    SetTitle {
        title: String,
    },
    SetStatus {
        status: String,
    },
    SetDue {
        due: Option<String>,
    },
    SetPriority {
        priority: Option<String>,
    },
    SetTags {
        tags: Vec<String>,
    },
    SetProject {
        project: Option<String>,
    },
    AddLink {
        link: TaskLink,
    },
    RemoveLink {
        url: String,
    },
    AddSession {
        session_id: String,
    },
    RemoveSession {
        session_id: String,
    },
    AddTodo {
        text: String,
        index: Option<usize>,
    },
    ToggleTodo {
        index: usize,
        text: String,
        done: bool,
    },
    RenameTodo {
        index: usize,
        text: String,
        new_text: String,
    },
    RemoveTodo {
        index: usize,
        text: String,
    },
    MoveTodo {
        index: usize,
        text: String,
        to: usize,
    },
    SaveDocument {
        document: String,
    },
}

fn valid_date(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    let [year, month, day] = parts.as_slice() else {
        return false;
    };
    if year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) =
        (year.parse::<i32>(), month.parse::<u8>(), day.parse::<u8>())
    else {
        return false;
    };
    time::Month::try_from(month)
        .ok()
        .is_some_and(|month| time::Date::from_calendar_date(year, month, day).is_ok())
}

fn stale_todo() -> String {
    format!("{STALE} the todo changed outside the app")
}

fn optional_string(value: Option<String>) -> Option<Yaml> {
    value
        .map(|v| format::one_line(&v))
        .filter(|v| !v.is_empty())
        .map(Yaml::String)
}

fn string_array(values: &[String]) -> Option<Yaml> {
    (!values.is_empty()).then(|| Yaml::Array(values.iter().cloned().map(Yaml::String).collect()))
}

pub fn apply(doc: &mut Doc, edit: Edit) -> Result<Option<String>, String> {
    match edit {
        Edit::SetTitle { title } => {
            let title = format::one_line(&title);
            if title.is_empty() {
                return Err("Enter a title".into());
            }
            if title.chars().count() > format::TITLE_MAX {
                return Err("The title is too long".into());
            }
            doc.set_key("title", Some(Yaml::String(title.clone())), false);
            return Ok(Some(title));
        }
        Edit::SetStatus { status } => doc.set_key("status", optional_string(Some(status)), false),
        Edit::SetDue { due } => {
            let due = due.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
            if let Some(due) = &due {
                if !valid_date(due) {
                    return Err("Use a YYYY-MM-DD date".into());
                }
            }
            doc.set_key("due", due.map(Yaml::String), false);
        }
        Edit::SetPriority { priority } => doc.set_key("priority", optional_string(priority), false),
        Edit::SetTags { tags } => {
            let mut seen = HashSet::new();
            let tags: Vec<String> = tags
                .iter()
                .map(|t| format::one_line(t))
                .filter(|t| !t.is_empty() && seen.insert(t.to_lowercase()))
                .collect();
            doc.set_key("tags", string_array(&tags), false);
        }
        Edit::SetProject { project } => doc.set_key("project", optional_string(project), false),
        Edit::AddLink { link } => {
            let mut items = match doc.front_value("links") {
                Some(Yaml::Array(items)) => items,
                _ => Vec::new(),
            };
            if !items
                .iter()
                .any(|item| format::yaml_link_url(item).as_deref() == Some(link.url.as_str()))
            {
                items.push(format::link_to_yaml(&link));
            }
            doc.set_key("links", Some(Yaml::Array(items)), false);
        }
        Edit::RemoveLink { url } => {
            let mut items = match doc.front_value("links") {
                Some(Yaml::Array(items)) => items,
                _ => Vec::new(),
            };
            items.retain(|item| format::yaml_link_url(item).as_deref() != Some(url.as_str()));
            doc.set_key(
                "links",
                (!items.is_empty()).then_some(Yaml::Array(items)),
                false,
            );
        }
        Edit::AddSession { session_id } | Edit::RemoveSession { session_id }
            if !format::valid_id(&session_id) =>
        {
            return Err("Invalid session id".into());
        }
        Edit::AddSession { session_id } => {
            let mut items = match doc.front_value("sessions") {
                Some(Yaml::Array(items)) => items,
                _ => Vec::new(),
            };
            if !items
                .iter()
                .any(|i| format::scalar(i).as_deref() == Some(session_id.as_str()))
            {
                items.push(Yaml::String(session_id));
            }
            doc.set_key("sessions", Some(Yaml::Array(items)), false);
        }
        Edit::RemoveSession { session_id } => {
            let mut items = match doc.front_value("sessions") {
                Some(Yaml::Array(items)) => items,
                _ => Vec::new(),
            };
            items.retain(|i| format::scalar(i).as_deref() != Some(session_id.as_str()));
            doc.set_key(
                "sessions",
                (!items.is_empty()).then_some(Yaml::Array(items)),
                false,
            );
        }
        Edit::AddTodo { text, index } => {
            let text = format::one_line(&text);
            if text.is_empty() {
                return Err("Enter a todo".into());
            }
            let at = index.unwrap_or(doc.todo_count());
            doc.insert_todo(at, &text, false);
        }
        Edit::ToggleTodo { index, text, done } => {
            let position = doc.find_todo(index, &text).ok_or_else(stale_todo)?;
            doc.set_todo_done(position, done);
        }
        Edit::RenameTodo {
            index,
            text,
            new_text,
        } => {
            let position = doc.find_todo(index, &text).ok_or_else(stale_todo)?;
            if format::one_line(&new_text).is_empty() {
                doc.remove_todo(position);
            } else {
                doc.set_todo_text(position, &new_text);
            }
        }
        Edit::RemoveTodo { index, text } => {
            let position = doc.find_todo(index, &text).ok_or_else(stale_todo)?;
            doc.remove_todo(position);
        }
        Edit::MoveTodo { index, text, to } => {
            let position = doc.find_todo(index, &text).ok_or_else(stale_todo)?;
            doc.move_todo(position, to);
        }
        Edit::SaveDocument { document } => doc.set_document(&document),
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("monocode-tasks-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn column<'a>(board: &'a Board, name: &str) -> &'a Column {
        board.columns.iter().find(|c| c.name == name).unwrap()
    }

    #[test]
    fn init_creates_default_columns_in_an_empty_folder() {
        let root = temp_root();
        let board = init(&root).unwrap();
        let names: Vec<&str> = board.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, DEFAULT_COLUMNS);
        assert_eq!(board.done_column.as_deref(), Some("Done"));
        assert!(board.configured);
    }

    #[test]
    fn init_adopts_existing_folders() {
        let root = temp_root();
        fs::create_dir_all(root.join("Later")).unwrap();
        fs::create_dir_all(root.join("Backlog")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        let board = init(&root).unwrap();
        let names: Vec<&str> = board.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Backlog", "Later"]);
        assert_eq!(board.done_column, None);
    }

    #[test]
    fn create_puts_new_tasks_first_and_load_never_writes() {
        let root = temp_root();
        init(&root).unwrap();
        create(&root, "TODO", "첫 작업").unwrap();
        create(&root, "TODO", "두 번째").unwrap();
        fs::write(root.join("TODO/hand.md"), "# 손으로 만든 작업\n").unwrap();
        let before = fs::read_to_string(root.join("TODO/hand.md")).unwrap();
        let board = load(&root).unwrap();
        let titles: Vec<&str> = column(&board, "TODO")
            .tasks
            .iter()
            .map(|t| t.title.as_str())
            .collect();
        assert_eq!(titles, ["두 번째", "첫 작업", "손으로 만든 작업"]);
        assert_eq!(
            fs::read_to_string(root.join("TODO/hand.md")).unwrap(),
            before
        );
        let hand = &column(&board, "TODO").tasks[2];
        assert!(!hand.persisted);
    }

    #[test]
    fn first_mutation_gives_a_hand_made_file_an_id() {
        let root = temp_root();
        init(&root).unwrap();
        fs::write(root.join("TODO/hand.md"), "메모\n").unwrap();
        let task = mutate(&root, "~TODO/hand.md", "TODO/hand.md", |doc| {
            apply(
                doc,
                Edit::AddTodo {
                    text: "할 일".into(),
                    index: None,
                },
            )
        })
        .unwrap();
        assert!(task.persisted);
        assert_eq!(task.todos.len(), 1);
        assert_eq!(task.document, "메모");
    }

    #[test]
    fn title_edits_rename_the_file() {
        let root = temp_root();
        init(&root).unwrap();
        let task = create(&root, "TODO", "old").unwrap();
        create(&root, "TODO", "new").unwrap();
        let renamed = mutate(&root, &task.id, &task.path, |doc| {
            apply(
                doc,
                Edit::SetTitle {
                    title: "new".into(),
                },
            )
        })
        .unwrap();
        assert_eq!(renamed.file_name, "new (2).md");
        assert_eq!(renamed.id, task.id);
    }

    #[test]
    fn stale_todo_edits_are_refused() {
        let root = temp_root();
        init(&root).unwrap();
        let task = create(&root, "TODO", "t").unwrap();
        mutate(&root, &task.id, &task.path, |doc| {
            apply(
                doc,
                Edit::AddTodo {
                    text: "a".into(),
                    index: None,
                },
            )
        })
        .unwrap();
        let error = mutate(&root, &task.id, &task.path, |doc| {
            apply(
                doc,
                Edit::ToggleTodo {
                    index: 0,
                    text: "b".into(),
                    done: true,
                },
            )
        })
        .unwrap_err();
        assert!(error.starts_with(STALE));
    }

    #[test]
    fn locate_finds_a_task_moved_outside_the_app() {
        let root = temp_root();
        init(&root).unwrap();
        let task = create(&root, "TODO", "t").unwrap();
        fs::rename(root.join(&task.path), root.join("Done/t.md")).unwrap();
        let updated = mutate(&root, &task.id, &task.path, |doc| {
            apply(
                doc,
                Edit::SetStatus {
                    status: "moved".into(),
                },
            )
        })
        .unwrap();
        assert_eq!(updated.column, "Done");
    }

    #[test]
    fn move_and_reorder_maintain_order_files() {
        let root = temp_root();
        init(&root).unwrap();
        let a = create(&root, "TODO", "a").unwrap();
        let b = create(&root, "TODO", "b").unwrap();
        let c = create(&root, "In Progress", "c").unwrap();
        let board = move_task(&root, &a.id, &a.path, "In Progress", 0).unwrap();
        let ids: Vec<&str> = column(&board, "In Progress")
            .tasks
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        assert_eq!(ids, [a.id.as_str(), c.id.as_str()]);
        assert_eq!(read_order(&root.join("TODO")), std::slice::from_ref(&b.id));
        let board = reorder(&root, "In Progress", &[c.id.clone(), a.id.clone()]).unwrap();
        let ids: Vec<&str> = column(&board, "In Progress")
            .tasks
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        assert_eq!(ids, [c.id.as_str(), a.id.as_str()]);
    }

    #[test]
    fn delete_then_restore_puts_the_task_back() {
        let root = temp_root();
        init(&root).unwrap();
        let a = create(&root, "TODO", "a").unwrap();
        let b = create(&root, "TODO", "b").unwrap();
        fs::create_dir_all(root.join(ASSETS_DIR).join(&a.id)).unwrap();
        fs::write(root.join(ASSETS_DIR).join(&a.id).join("x.png"), "img").unwrap();
        let token = delete(&root, &a.id, &a.path).unwrap();
        assert!(column(&load(&root).unwrap(), "TODO")
            .tasks
            .iter()
            .all(|t| t.id != a.id));
        assert!(!root.join(ASSETS_DIR).join(&a.id).exists());
        let board = restore(&root, &token).unwrap();
        let ids: Vec<&str> = column(&board, "TODO")
            .tasks
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        assert_eq!(ids, [b.id.as_str(), a.id.as_str()]);
        assert!(root.join(ASSETS_DIR).join(&a.id).join("x.png").exists());
        assert!(!root.join(TRASH_DIR).exists());
    }

    #[test]
    fn duplicate_ids_mark_the_newer_copy() {
        let root = temp_root();
        init(&root).unwrap();
        let a = create(&root, "TODO", "a").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::copy(root.join(&a.path), root.join("TODO/copy.md")).unwrap();
        let board = load(&root).unwrap();
        let tasks = &column(&board, "TODO").tasks;
        let copy = tasks.iter().find(|t| t.file_name == "copy.md").unwrap();
        assert!(copy.duplicate && !copy.persisted);
        assert!(tasks.iter().any(|t| t.id == a.id && !t.duplicate));
        let fixed = mutate(&root, &copy.id, &copy.path, |_| Ok(None)).unwrap();
        assert_ne!(fixed.id, a.id);
    }

    #[test]
    fn column_edits() {
        let root = temp_root();
        init(&root).unwrap();
        let task = create(&root, "Done", "t").unwrap();
        let board = rename_column(&root, "Done", "완료").unwrap();
        assert_eq!(board.done_column.as_deref(), Some("완료"));
        assert!(column(&board, "완료").tasks.iter().any(|t| t.id == task.id));
        let board = add_column(&root, "Blocked", Some("TODO")).unwrap();
        assert_eq!(board.columns[1].name, "Blocked");
        assert!(delete_column(&root, "완료", None)
            .unwrap_err()
            .starts_with("not_empty"));
        let board = delete_column(&root, "완료", Some("TODO")).unwrap();
        assert!(column(&board, "TODO").tasks.iter().any(|t| t.id == task.id));
        assert_eq!(board.done_column, None);
        let board = reorder_columns(
            &root,
            &["In Progress".into(), "TODO".into(), "Blocked".into()],
        )
        .unwrap();
        assert_eq!(board.columns[0].name, "In Progress");
    }

    #[test]
    fn images_land_beside_the_columns_and_give_the_task_an_id() {
        let root = temp_root();
        init(&root).unwrap();
        fs::write(root.join("TODO/hand.md"), "memo\n").unwrap();
        let source = root.join("my shot (1).PNG");
        fs::write(&source, "png").unwrap();
        let saved = save_image(
            &root,
            "~TODO/hand.md",
            "TODO/hand.md",
            &source.to_string_lossy(),
        )
        .unwrap();
        assert!(saved.task.persisted);
        assert_eq!(saved.name, "my shot (1).PNG");
        let prefix = format!("../{ASSETS_DIR}/{}/", saved.task.id);
        assert!(saved.markdown_path.starts_with(&prefix));
        assert!(saved.markdown_path.ends_with("-my-shot--1.png"));
        let stored = root.join("TODO").join(&saved.markdown_path);
        assert_eq!(fs::read_to_string(stored).unwrap(), "png");
        let text = root.join("x.txt");
        fs::write(&text, "t").unwrap();
        assert!(save_image(
            &root,
            &saved.task.id,
            &saved.task.path,
            &text.to_string_lossy()
        )
        .is_err());
    }

    #[test]
    fn malformed_files_are_read_only() {
        let root = temp_root();
        init(&root).unwrap();
        fs::write(root.join("TODO/bad.md"), "---\nid: [\n---\n").unwrap();
        let board = load(&root).unwrap();
        let bad = &column(&board, "TODO").tasks[0];
        assert!(bad.read_only);
        assert!(mutate(&root, &bad.id, &bad.path, |_| Ok(None)).is_err());
        assert_eq!(
            fs::read_to_string(root.join("TODO/bad.md")).unwrap(),
            "---\nid: [\n---\n"
        );
    }

    #[test]
    fn paths_cannot_escape_the_root() {
        let root = temp_root();
        assert!(resolve(&root, "../x").is_err());
        assert!(resolve(&root, "/etc/passwd").is_err());
        assert!(column_dir(&root, "a/b").is_err());
    }

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize_name("  a/b:c?  "), "abc");
        assert_eq!(sanitize_name("..hidden."), "hidden");
        assert_eq!(sanitize_name("한글 제목"), "한글 제목");
        let decomposed: String = "한글".nfd().collect();
        assert_eq!(sanitize_name(&decomposed), "한글");
    }
}
