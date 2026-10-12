//! The on-disk task format: YAML frontmatter, a `## Todos` checklist and a
//! `## Document` body. Files are edited by hand as often as by the app, so the
//! parser is lenient and every write is a minimal edit: only the frontmatter
//! keys and checklist lines an operation touches are rewritten, and everything
//! else — comments, unknown keys, unknown sections — is kept byte for byte.

use serde::{Deserialize, Serialize};
use yaml_rust2::yaml::Hash;
use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};

pub const TITLE_MAX: usize = 200;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLink {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<i64>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub text: String,
    pub done: bool,
}

/// Everything the app reads from a task file.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Parsed {
    pub id: Option<String>,
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
    /// Has an id, a `## Todos` section and a `## Document` section, in order.
    pub canonical: bool,
}

/// A task file split into the parts edits work on. Line endings are normalised
/// to `\n` while editing and restored when rendering.
#[derive(Debug, Clone)]
pub struct Doc {
    bom: bool,
    crlf: bool,
    /// `None` when the file has no frontmatter block at all.
    front: Option<Vec<String>>,
    closer: String,
    body: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
struct TodoLine {
    line: usize,
    /// Exclusive end, past the todo's indented continuation lines.
    end: usize,
    done: bool,
}

#[derive(Debug, Clone, Default)]
struct Sections {
    /// Index of the `## Todos` heading line.
    todos: Option<usize>,
    /// Exclusive end of the todos section.
    todos_end: usize,
    /// Index of the `## Document` heading line.
    document: Option<usize>,
}

impl Doc {
    pub fn split(text: &str) -> Result<Doc, String> {
        let (bom, text) = match text.strip_prefix('\u{feff}') {
            Some(rest) => (true, rest),
            None => (false, text),
        };
        let crlf = text.contains("\r\n");
        let text = text.replace("\r\n", "\n");
        let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
        if lines.first().map(|line| line.trim_end()) == Some("---") {
            let close = lines
                .iter()
                .enumerate()
                .skip(1)
                .find(|(_, line)| matches!(line.trim_end(), "---" | "..."))
                .map(|(index, _)| index);
            let Some(close) = close else {
                return Err("The frontmatter block is never closed".into());
            };
            let body = lines.split_off(close + 1);
            let closer = lines.pop().unwrap_or_else(|| "---".into());
            let front = lines.split_off(1);
            return Ok(Doc {
                bom,
                crlf,
                front: Some(front),
                closer: closer.trim_end().to_string(),
                body,
            });
        }
        Ok(Doc {
            bom,
            crlf,
            front: None,
            closer: "---".into(),
            body: lines,
        })
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        if self.bom {
            out.push('\u{feff}');
        }
        if let Some(front) = &self.front {
            out.push_str("---\n");
            for line in front {
                out.push_str(line);
                out.push('\n');
            }
            out.push_str(&self.closer);
            out.push('\n');
        }
        out.push_str(&self.body.join("\n"));
        if self.crlf {
            out = out.replace('\n', "\r\n");
        }
        out
    }

    fn front_yaml(&self) -> Result<Hash, String> {
        let Some(front) = &self.front else {
            return Ok(Hash::new());
        };
        let source = front.join("\n");
        let docs = YamlLoader::load_from_str(&source).map_err(|e| e.to_string())?;
        match docs.into_iter().next() {
            None | Some(Yaml::Null) => Ok(Hash::new()),
            Some(Yaml::Hash(hash)) => Ok(hash),
            Some(_) => Err("The frontmatter is not a key/value mapping".into()),
        }
    }

    /// Reads the task. `fallback_title` is the file name, used when neither the
    /// frontmatter nor a leading `# H1` names the task.
    pub fn parse(&self, fallback_title: &str) -> Result<Parsed, String> {
        let hash = self.front_yaml()?;
        let get = |key: &str| hash.get(&Yaml::String(key.into()));
        let sections = self.sections();
        let todos = self.todo_lines(&sections);
        let id = get("id").and_then(scalar).filter(|id| valid_id(id));
        let title = get("title")
            .and_then(scalar)
            .map(|title| one_line(&title))
            .filter(|title| !title.is_empty())
            .or_else(|| self.first_h1())
            .unwrap_or_else(|| fallback_title.to_string());
        let links = match get("links") {
            Some(Yaml::Array(items)) => items.iter().filter_map(link_from_yaml).collect(),
            _ => Vec::new(),
        };
        Ok(Parsed {
            canonical: id.is_some() && sections.document.is_some() && sections.todos.is_some(),
            id,
            title,
            status: get("status")
                .and_then(scalar)
                .map(|s| one_line(&s))
                .unwrap_or_default(),
            due: get("due").and_then(scalar).filter(|s| !s.trim().is_empty()),
            priority: get("priority")
                .and_then(scalar)
                .filter(|s| !s.trim().is_empty()),
            tags: get("tags").map(string_list).unwrap_or_default(),
            links,
            sessions: get("sessions").map(string_list).unwrap_or_default(),
            project: get("project")
                .and_then(scalar)
                .filter(|s| !s.trim().is_empty()),
            todos: todos
                .iter()
                .map(|todo| Todo {
                    text: todo_text(&self.body[todo.line]),
                    done: todo.done,
                })
                .collect(),
            document: self.document_text(&sections),
        })
    }

    fn first_h1(&self) -> Option<String> {
        let mut fence = false;
        for line in &self.body {
            if is_fence(line) {
                fence = !fence;
                continue;
            }
            if fence {
                continue;
            }
            if let Some(rest) = line.strip_prefix("# ") {
                let title = one_line(rest.trim().trim_end_matches('#').trim());
                if !title.is_empty() {
                    return Some(title);
                }
            }
        }
        None
    }

    fn sections(&self) -> Sections {
        let mut headings = Vec::new();
        let mut fence = false;
        for (index, line) in self.body.iter().enumerate() {
            if is_fence(line) {
                fence = !fence;
                continue;
            }
            if fence {
                continue;
            }
            if let Some((level, name)) = heading(line) {
                headings.push((index, level, name));
            }
        }
        let document = headings
            .iter()
            .find(|(_, level, name)| *level == 2 && name.eq_ignore_ascii_case("document"))
            .map(|(index, _, _)| *index);
        let limit = document.unwrap_or(self.body.len());
        let todos = headings
            .iter()
            .find(|(index, level, name)| {
                *index < limit && *level == 2 && name.eq_ignore_ascii_case("todos")
            })
            .map(|(index, _, _)| *index);
        let todos_end = todos
            .and_then(|start| {
                headings
                    .iter()
                    .find(|(index, level, _)| *index > start && *level <= 2)
                    .map(|(index, _, _)| *index)
            })
            .unwrap_or(self.body.len());
        Sections {
            todos,
            todos_end,
            document,
        }
    }

    fn todo_lines(&self, sections: &Sections) -> Vec<TodoLine> {
        let Some(start) = sections.todos else {
            return Vec::new();
        };
        let range = start + 1..sections.todos_end;
        let base = range
            .clone()
            .filter_map(|index| checkbox(&self.body[index]).map(|c| c.indent))
            .min();
        let Some(base) = base else {
            return Vec::new();
        };
        let mut todos: Vec<TodoLine> = Vec::new();
        let mut index = range.start;
        while index < range.end {
            match checkbox(&self.body[index]) {
                Some(found) if found.indent == base => {
                    // Deeper lines, with blank lines between them, belong to this todo.
                    let mut end = index + 1;
                    let mut probe = end;
                    while probe < range.end {
                        let line = &self.body[probe];
                        if line.trim().is_empty() {
                            probe += 1;
                            continue;
                        }
                        if indent_of(line) > base {
                            probe += 1;
                            end = probe;
                            continue;
                        }
                        break;
                    }
                    todos.push(TodoLine {
                        line: index,
                        end,
                        done: found.done,
                    });
                    index = end;
                }
                _ => index += 1,
            }
        }
        todos
    }

    fn document_text(&self, sections: &Sections) -> String {
        let lines: Vec<&str> = match sections.document {
            Some(heading) => {
                let mut rest = &self.body[heading + 1..];
                if rest.first().is_some_and(|line| line.trim().is_empty()) {
                    rest = &rest[1..];
                }
                rest.iter().map(String::as_str).collect()
            }
            None => self
                .body
                .iter()
                .enumerate()
                .filter(|(index, _)| match sections.todos {
                    Some(start) => *index < start || *index >= sections.todos_end,
                    None => true,
                })
                .map(|(_, line)| line.as_str())
                .collect(),
        };
        lines.join("\n").trim_matches('\n').to_string()
    }

    // ---- frontmatter edits ----------------------------------------------

    fn front_mut(&mut self) -> &mut Vec<String> {
        self.front.get_or_insert_with(Vec::new)
    }

    /// Sets (or with `None`, removes) one top-level frontmatter key. Only that
    /// key's lines change; a new key goes at the end, or first with `first`.
    pub fn set_key(&mut self, key: &str, value: Option<Yaml>, first: bool) {
        let front = self.front_mut();
        let blocks = key_blocks(front);
        let existing = blocks
            .iter()
            .find(|block| block.key == key)
            .map(|b| b.start..b.end);
        let lines = value.map(|value| emit_key(key, value)).unwrap_or_default();
        match existing {
            Some(range) => {
                front.splice(range, lines);
            }
            None if lines.is_empty() => {}
            None if first => {
                front.splice(0..0, lines);
            }
            None => {
                // After the last key, so trailing comments and blank lines stay last.
                let at = blocks.last().map(|b| b.end).unwrap_or(front.len());
                front.splice(at..at, lines);
            }
        }
    }

    pub fn front_value(&self, key: &str) -> Option<Yaml> {
        self.front_yaml()
            .ok()?
            .get(&Yaml::String(key.into()))
            .cloned()
    }

    // ---- body edits -----------------------------------------------------

    /// Rewrites a file the user made by hand into the canonical layout, keeping
    /// every line: missing headings are added, and a body without a
    /// `## Document` heading becomes the document.
    pub fn normalize(&mut self, id: &str, title: &str) {
        let has_id = self
            .front_value("id")
            .as_ref()
            .and_then(scalar)
            .is_some_and(|value| value == id);
        if !has_id {
            self.set_key("id", Some(Yaml::String(id.into())), true);
        }
        if self
            .front_value("title")
            .as_ref()
            .and_then(scalar)
            .is_none()
        {
            self.set_key("title", Some(Yaml::String(title.into())), false);
        }
        let sections = self.sections();
        match (sections.document, sections.todos) {
            (Some(_), Some(_)) => {}
            (Some(document), None) => {
                let mut insert = vec!["## Todos".to_string(), String::new()];
                if document > 0 && !self.body[document - 1].trim().is_empty() {
                    insert.insert(0, String::new());
                }
                self.body.splice(document..document, insert);
            }
            (None, todos) => {
                let (mut section, rest): (Vec<String>, Vec<String>) = match todos {
                    Some(start) => {
                        let section = self.body[start..sections.todos_end].to_vec();
                        let rest = self.body[..start]
                            .iter()
                            .chain(&self.body[sections.todos_end..])
                            .cloned()
                            .collect();
                        (section, rest)
                    }
                    None => (vec!["## Todos".into()], self.body.clone()),
                };
                trim_blank_edges(&mut section);
                let mut rest = rest;
                trim_blank_edges(&mut rest);
                let mut body = vec![String::new()];
                body.append(&mut section);
                body.push(String::new());
                body.push("## Document".into());
                body.push(String::new());
                if !rest.is_empty() {
                    body.append(&mut rest);
                    body.push(String::new());
                }
                self.body = body;
            }
        }
    }

    pub fn todo_count(&self) -> usize {
        self.todo_lines(&self.sections()).len()
    }

    /// Finds the todo the caller saw at `index` with `text`. The file may have
    /// changed since, so the text decides, and the index only breaks ties.
    pub fn find_todo(&self, index: usize, text: &str) -> Option<usize> {
        let todos = self.todo_lines(&self.sections());
        todos
            .iter()
            .enumerate()
            .filter(|(_, todo)| todo_text(&self.body[todo.line]) == text)
            .min_by_key(|(position, _)| position.abs_diff(index))
            .map(|(position, _)| position)
    }

    pub fn set_todo_done(&mut self, position: usize, done: bool) {
        let todos = self.todo_lines(&self.sections());
        let Some(todo) = todos.get(position) else {
            return;
        };
        let line = &mut self.body[todo.line];
        if let Some(found) = checkbox(line) {
            let mark = if done { "x" } else { " " };
            line.replace_range(found.mark..found.mark + 1, mark);
        }
    }

    pub fn set_todo_text(&mut self, position: usize, text: &str) {
        let todos = self.todo_lines(&self.sections());
        let Some(todo) = todos.get(position) else {
            return;
        };
        let line = &mut self.body[todo.line];
        if let Some(found) = checkbox(line) {
            line.truncate(found.text);
            if !line.ends_with(' ') {
                line.push(' ');
            }
            line.push_str(&one_line(text));
        }
    }

    pub fn remove_todo(&mut self, position: usize) {
        let todos = self.todo_lines(&self.sections());
        let Some(todo) = todos.get(position) else {
            return;
        };
        self.body.drain(todo.line..todo.end);
    }

    /// Inserts a todo before the one at `position`, or last when out of range.
    pub fn insert_todo(&mut self, position: usize, text: &str, done: bool) {
        let sections = self.sections();
        let Some(start) = sections.todos else { return };
        let todos = self.todo_lines(&sections);
        let indent = todos
            .first()
            .and_then(|todo| checkbox(&self.body[todo.line]))
            .map(|found| self.body[todos[0].line][..found.indent].to_string())
            .unwrap_or_default();
        let line = format!(
            "{indent}- [{}] {}",
            if done { "x" } else { " " },
            one_line(text)
        );
        if let Some(todo) = todos.get(position) {
            self.body.insert(todo.line, line);
            return;
        }
        if let Some(last) = todos.last() {
            self.body.insert(last.end, line);
            return;
        }
        // An empty section: after its last non-blank line, set off by blank lines.
        let content_end = (start + 1..sections.todos_end)
            .rev()
            .find(|index| !self.body[*index].trim().is_empty())
            .map(|index| index + 1)
            .unwrap_or(start + 1);
        let mut insert = vec![String::new(), line];
        let next_blank = self
            .body
            .get(content_end)
            .is_none_or(|next| next.trim().is_empty());
        if !next_blank || content_end >= self.body.len() {
            insert.push(String::new());
        }
        self.body.splice(content_end..content_end, insert);
    }

    pub fn move_todo(&mut self, from: usize, to: usize) {
        let todos = self.todo_lines(&self.sections());
        let Some(todo) = todos.get(from).copied() else {
            return;
        };
        if from == to {
            return;
        }
        let block: Vec<String> = self.body.drain(todo.line..todo.end).collect();
        let todos = self.todo_lines(&self.sections());
        let at = match todos.get(to) {
            Some(target) => target.line,
            None => match todos.last() {
                Some(last) => last.end,
                None => todo.line,
            },
        };
        self.body.splice(at..at, block);
    }

    /// Replaces the document body. The file must be canonical.
    pub fn set_document(&mut self, document: &str) {
        let Some(heading) = self.sections().document else {
            return;
        };
        self.body.truncate(heading + 1);
        self.body.push(String::new());
        let document = document.replace("\r\n", "\n");
        let document = document.trim_matches('\n');
        if !document.is_empty() {
            self.body.extend(document.split('\n').map(str::to_string));
            self.body.push(String::new());
        }
    }
}

/// A fresh task file in the canonical layout.
pub fn new_task_text(id: &str, title: &str) -> String {
    let mut doc = Doc {
        bom: false,
        crlf: false,
        front: Some(Vec::new()),
        closer: "---".into(),
        body: vec![
            String::new(),
            "## Todos".into(),
            String::new(),
            "## Document".into(),
            String::new(),
        ],
    };
    doc.set_key("id", Some(Yaml::String(id.into())), false);
    doc.set_key("title", Some(Yaml::String(one_line(title))), false);
    doc.render()
}

// ---- helpers ------------------------------------------------------------

struct KeyBlock {
    key: String,
    start: usize,
    end: usize,
}

/// Top-level key blocks of the frontmatter. A block ends at its last indented
/// or `- ` line, so comments and blank lines after it are not part of it.
fn key_blocks(lines: &[String]) -> Vec<KeyBlock> {
    let mut blocks: Vec<KeyBlock> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if let Some(key) = top_level_key(line) {
            blocks.push(KeyBlock {
                key,
                start: index,
                end: index + 1,
            });
            continue;
        }
        let continues = line.starts_with([' ', '\t']) && !line.trim().is_empty()
            || line.starts_with("- ")
            || line == "-";
        if continues {
            if let Some(block) = blocks.last_mut() {
                block.end = index + 1;
            }
        }
    }
    blocks
}

fn top_level_key(line: &str) -> Option<String> {
    if line.is_empty() || line.starts_with([' ', '\t', '#', '-']) {
        return None;
    }
    let colon = line
        .char_indices()
        .find(|(index, c)| {
            *c == ':'
                && line[index + 1..]
                    .chars()
                    .next()
                    .is_none_or(char::is_whitespace)
        })
        .map(|(index, _)| index)?;
    let key = line[..colon].trim();
    let key = key
        .strip_prefix('"')
        .and_then(|k| k.strip_suffix('"'))
        .or_else(|| key.strip_prefix('\'').and_then(|k| k.strip_suffix('\'')))
        .unwrap_or(key);
    Some(key.to_string())
}

fn emit_key(key: &str, value: Yaml) -> Vec<String> {
    let mut hash = Hash::new();
    hash.insert(Yaml::String(key.into()), value);
    let mut out = String::new();
    let mut emitter = YamlEmitter::new(&mut out);
    if emitter.dump(&Yaml::Hash(hash)).is_err() {
        return Vec::new();
    }
    out.strip_prefix("---\n")
        .unwrap_or(&out)
        .lines()
        .map(str::to_string)
        .collect()
}

pub fn scalar(value: &Yaml) -> Option<String> {
    match value {
        Yaml::String(s) | Yaml::Real(s) => Some(s.clone()),
        Yaml::Integer(i) => Some(i.to_string()),
        Yaml::Boolean(b) => Some(b.to_string()),
        _ => None,
    }
}

fn string_list(value: &Yaml) -> Vec<String> {
    match value {
        Yaml::Array(items) => items
            .iter()
            .filter_map(scalar)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        other => scalar(other)
            .map(|s| {
                s.split(',')
                    .map(|part| part.trim().to_string())
                    .filter(|part| !part.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn link_from_yaml(value: &Yaml) -> Option<TaskLink> {
    let Yaml::Hash(hash) = value else { return None };
    let get = |key: &str| hash.get(&Yaml::String(key.into())).and_then(scalar);
    let link = TaskLink {
        provider: get("provider").unwrap_or_default(),
        repo: get("repo").unwrap_or_default(),
        kind: get("kind").unwrap_or_default(),
        number: get("number").and_then(|n| n.trim().parse().ok()),
        url: get("url").unwrap_or_default(),
        title: get("title").unwrap_or_default(),
        identifier: get("identifier"),
        id: get("id"),
        project_path: get("projectPath"),
    };
    (!link.url.is_empty() || !link.repo.is_empty() || link.identifier.is_some()).then_some(link)
}

pub fn link_to_yaml(link: &TaskLink) -> Yaml {
    let mut hash = Hash::new();
    let mut put = |key: &str, value: Yaml| {
        hash.insert(Yaml::String(key.into()), value);
    };
    put("provider", Yaml::String(link.provider.clone()));
    if !link.repo.is_empty() {
        put("repo", Yaml::String(link.repo.clone()));
    }
    if !link.kind.is_empty() {
        put("kind", Yaml::String(link.kind.clone()));
    }
    if let Some(number) = link.number {
        put("number", Yaml::Integer(number));
    }
    if let Some(identifier) = &link.identifier {
        put("identifier", Yaml::String(identifier.clone()));
    }
    if let Some(id) = &link.id {
        put("id", Yaml::String(id.clone()));
    }
    put("url", Yaml::String(link.url.clone()));
    put("title", Yaml::String(one_line(&link.title)));
    if let Some(project_path) = &link.project_path {
        put("projectPath", Yaml::String(project_path.clone()));
    }
    Yaml::Hash(hash)
}

/// Whether a `links` entry (in any shape) points at `url`.
pub fn yaml_link_url(value: &Yaml) -> Option<String> {
    link_from_yaml(value).map(|link| link.url)
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

pub fn one_line(text: &str) -> String {
    text.split(['\n', '\r'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_fence(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

fn heading(line: &str) -> Option<(usize, String)> {
    if line.starts_with([' ', '\t']) {
        return None;
    }
    let level = line.bytes().take_while(|b| *b == b'#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let rest = &line[level..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    Some((level, rest.trim().trim_end_matches('#').trim().to_string()))
}

struct Checkbox {
    indent: usize,
    /// Byte offset of the mark between the brackets.
    mark: usize,
    /// Byte offset where the todo text starts.
    text: usize,
    done: bool,
}

fn checkbox(line: &str) -> Option<Checkbox> {
    let indent = indent_of(line);
    let rest = &line[indent..];
    let mut chars = rest.char_indices();
    let (_, marker) = chars.next()?;
    if !matches!(marker, '-' | '*' | '+') {
        return None;
    }
    let rest_after = &rest[1..];
    if !rest_after.starts_with(" [") {
        return None;
    }
    let mark_char = rest_after[2..].chars().next()?;
    if !matches!(mark_char, ' ' | 'x' | 'X') || !rest_after[3..].starts_with(']') {
        return None;
    }
    let after = &rest_after[4..];
    if !after.is_empty() && !after.starts_with(' ') {
        return None;
    }
    let mark = indent + 3;
    let text = indent + 5 + usize::from(!after.is_empty());
    Some(Checkbox {
        indent,
        mark,
        text: text.min(line.len()),
        done: mark_char != ' ',
    })
}

fn todo_text(line: &str) -> String {
    checkbox(line)
        .map(|found| line[found.text..].trim().to_string())
        .unwrap_or_default()
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches([' ', '\t']).len()
}

fn trim_blank_edges(lines: &mut Vec<String>) {
    while lines.first().is_some_and(|line| line.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANONICAL: &str = "---\n# kept comment\nid: 01ABC\ntitle: 로그인 리팩터링\nstatus: 대기 중\ncustom: [a, b]\n---\n\n## Todos\n\n- [ ] API 스펙 확인\n  - 하위 메모\n- [x] 브랜치 생성\n\n## Notes\nunknown section\n\n## Document\n\n본문 첫 줄\n\n## 본문 안의 제목\n- [ ] not a todo\n";

    fn parsed(text: &str) -> Parsed {
        Doc::split(text).unwrap().parse("file").unwrap()
    }

    #[test]
    fn reads_the_canonical_layout() {
        let task = parsed(CANONICAL);
        assert!(task.canonical);
        assert_eq!(task.id.as_deref(), Some("01ABC"));
        assert_eq!(task.title, "로그인 리팩터링");
        assert_eq!(task.status, "대기 중");
        assert_eq!(
            task.todos,
            vec![
                Todo {
                    text: "API 스펙 확인".into(),
                    done: false
                },
                Todo {
                    text: "브랜치 생성".into(),
                    done: true
                },
            ]
        );
        assert_eq!(
            task.document,
            "본문 첫 줄\n\n## 본문 안의 제목\n- [ ] not a todo"
        );
    }

    #[test]
    fn rendering_an_untouched_file_is_byte_identical() {
        for text in [
            CANONICAL,
            "no frontmatter\n",
            "\u{feff}---\r\nid: x\r\n---\r\nbody\r\n",
            "",
        ] {
            assert_eq!(Doc::split(text).unwrap().render(), text);
        }
    }

    #[test]
    fn set_key_only_touches_that_key() {
        let mut doc = Doc::split(CANONICAL).unwrap();
        doc.set_key("status", Some(Yaml::String("진행 중".into())), false);
        let text = doc.render();
        assert_eq!(
            text,
            CANONICAL.replace("status: 대기 중", "status: 진행 중")
        );
        doc.set_key("due", Some(Yaml::String("2026-10-20".into())), false);
        assert!(doc
            .render()
            .contains("custom: [a, b]\ndue: 2026-10-20\n---"));
        doc.set_key("due", None, false);
        assert_eq!(doc.render(), text);
    }

    #[test]
    fn replaces_multi_line_values_as_one_block() {
        let text = "---\nid: a\ntags:\n  - one\n  - two\n# trailing\n---\n";
        let mut doc = Doc::split(text).unwrap();
        doc.set_key(
            "tags",
            Some(Yaml::Array(vec![Yaml::String("three".into())])),
            false,
        );
        assert_eq!(
            doc.render(),
            "---\nid: a\ntags:\n  - three\n# trailing\n---\n"
        );
    }

    #[test]
    fn links_round_trip() {
        let link = TaskLink {
            provider: "github".into(),
            repo: "o/r".into(),
            kind: "pr".into(),
            number: Some(7),
            url: "https://github.com/o/r/pull/7".into(),
            title: "Fix: things".into(),
            ..Default::default()
        };
        let mut doc = Doc::split(&new_task_text("01A", "t")).unwrap();
        doc.set_key("links", Some(Yaml::Array(vec![link_to_yaml(&link)])), false);
        assert_eq!(doc.parse("f").unwrap().links, vec![link]);
    }

    #[test]
    fn todo_edits_are_line_local() {
        let mut doc = Doc::split(CANONICAL).unwrap();
        let position = doc.find_todo(0, "API 스펙 확인").unwrap();
        doc.set_todo_done(position, true);
        assert_eq!(
            doc.render(),
            CANONICAL.replace("- [ ] API 스펙 확인", "- [x] API 스펙 확인")
        );
        doc.set_todo_text(1, "브랜치 만들기");
        assert!(doc.render().contains("- [x] 브랜치 만들기\n"));
        doc.move_todo(0, 1);
        let todos = doc.parse("f").unwrap().todos;
        assert_eq!(todos[0].text, "브랜치 만들기");
        // The child line travels with its todo.
        assert!(doc
            .render()
            .contains("- [x] API 스펙 확인\n  - 하위 메모\n"));
        doc.remove_todo(1);
        assert!(!doc.render().contains("하위 메모"));
        doc.insert_todo(9, "new", false);
        assert_eq!(doc.parse("f").unwrap().todos.last().unwrap().text, "new");
    }

    #[test]
    fn find_todo_prefers_text_over_position() {
        let doc = Doc::split(CANONICAL).unwrap();
        assert_eq!(doc.find_todo(0, "브랜치 생성"), Some(1));
        assert_eq!(doc.find_todo(1, "gone"), None);
    }

    #[test]
    fn inserts_into_an_empty_section() {
        let mut doc = Doc::split(&new_task_text("01A", "t")).unwrap();
        doc.insert_todo(0, "first", false);
        doc.insert_todo(1, "second", false);
        assert_eq!(
            doc.render(),
            "---\nid: 01A\ntitle: t\n---\n\n## Todos\n\n- [ ] first\n- [ ] second\n\n## Document\n"
        );
    }

    #[test]
    fn hand_written_files_keep_every_line_when_normalised() {
        let text = "# 직접 만든 작업\n\n메모입니다.\n\n## Todos\n- [ ] 하나\n\n## 기타\n끝\n";
        let task = parsed(text);
        assert!(!task.canonical);
        assert_eq!(task.title, "직접 만든 작업");
        assert_eq!(task.todos.len(), 1);
        let mut doc = Doc::split(text).unwrap();
        doc.normalize("01NEW", &task.title);
        let after = doc.parse("f").unwrap();
        assert!(after.canonical);
        assert_eq!(after.id.as_deref(), Some("01NEW"));
        assert_eq!(after.title, "직접 만든 작업");
        assert_eq!(after.todos, task.todos);
        assert_eq!(
            after.document,
            "# 직접 만든 작업\n\n메모입니다.\n\n## 기타\n끝"
        );
    }

    #[test]
    fn normalise_adds_a_missing_todos_heading() {
        let text = "---\ntitle: t\n---\nintro\n## Document\nbody\n";
        let mut doc = Doc::split(text).unwrap();
        doc.normalize("01X", "t");
        let after = doc.parse("f").unwrap();
        assert!(after.canonical);
        assert_eq!(after.document, "body");
        assert!(doc
            .render()
            .starts_with("---\nid: 01X\ntitle: t\n---\nintro\n\n## Todos\n"));
    }

    #[test]
    fn set_document_replaces_only_the_body() {
        let mut doc = Doc::split(CANONICAL).unwrap();
        doc.set_document("새 본문\n");
        let text = doc.render();
        assert!(text.ends_with("## Document\n\n새 본문\n"));
        assert!(text.contains("## Notes\nunknown section\n"));
    }

    #[test]
    fn malformed_yaml_is_an_error_not_a_guess() {
        assert!(Doc::split("---\nid: [unclosed\n---\n")
            .unwrap()
            .parse("f")
            .is_err());
        assert!(Doc::split("---\nid: a\nno closer\n").is_err());
    }

    #[test]
    fn todos_inside_code_fences_are_ignored() {
        let text = "## Todos\n```\n## Document\n```\n- [ ] real\n";
        assert_eq!(parsed(text).todos.len(), 1);
    }

    #[test]
    fn title_falls_back_to_the_file_name() {
        assert_eq!(parsed("just text").title, "file");
    }
}
