//! Tasks: one markdown file per task, in column folders under a root the
//! user picks. See `board` for the folder layout and `format` for the file.

mod board;
mod format;

use board::{Board, Edit, Task};

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// Runs `work` on the resolved root while holding the folder lock.
async fn with_root<T: Send + 'static>(
    root: String,
    work: impl FnOnce(&std::path::Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    blocking(move || {
        let root = board::root_path(&root)?;
        let _guard = board::lock();
        work(&root)
    })
    .await
}

#[tauri::command]
pub async fn tasks_load(root: String) -> Result<Board, String> {
    with_root(root, board::load).await
}

#[tauri::command]
pub async fn tasks_init(root: String) -> Result<Board, String> {
    with_root(root, board::init).await
}

#[tauri::command]
pub async fn tasks_create(root: String, column: String, title: String) -> Result<Task, String> {
    with_root(root, move |root| board::create(root, &column, &title)).await
}

#[tauri::command]
pub async fn tasks_update(
    root: String,
    id: String,
    path: String,
    edit: Edit,
) -> Result<Task, String> {
    with_root(root, move |root| {
        board::mutate(root, &id, &path, |doc| board::apply(doc, edit))
    })
    .await
}

#[tauri::command]
pub async fn tasks_move(
    root: String,
    id: String,
    path: String,
    column: String,
    index: usize,
) -> Result<Board, String> {
    with_root(root, move |root| {
        board::move_task(root, &id, &path, &column, index)
    })
    .await
}

#[tauri::command]
pub async fn tasks_reorder(
    root: String,
    column: String,
    ids: Vec<String>,
) -> Result<Board, String> {
    with_root(root, move |root| board::reorder(root, &column, &ids)).await
}

#[tauri::command]
pub async fn tasks_delete(root: String, id: String, path: String) -> Result<String, String> {
    with_root(root, move |root| board::delete(root, &id, &path)).await
}

#[tauri::command]
pub async fn tasks_restore(root: String, token: String) -> Result<Board, String> {
    with_root(root, move |root| board::restore(root, &token)).await
}

#[tauri::command]
pub async fn tasks_trash_flush(root: String, token: Option<String>) -> Result<(), String> {
    with_root(root, move |root| board::flush_trash(root, token.as_deref())).await
}

#[tauri::command]
pub async fn tasks_column_add(
    root: String,
    name: String,
    after: Option<String>,
) -> Result<Board, String> {
    with_root(root, move |root| {
        board::add_column(root, &name, after.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn tasks_column_rename(root: String, from: String, to: String) -> Result<Board, String> {
    with_root(root, move |root| board::rename_column(root, &from, &to)).await
}

#[tauri::command]
pub async fn tasks_column_delete(
    root: String,
    name: String,
    move_to: Option<String>,
) -> Result<Board, String> {
    with_root(root, move |root| {
        board::delete_column(root, &name, move_to.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn tasks_column_reorder(root: String, names: Vec<String>) -> Result<Board, String> {
    with_root(root, move |root| board::reorder_columns(root, &names)).await
}

#[tauri::command]
pub async fn tasks_column_set_done(root: String, name: Option<String>) -> Result<Board, String> {
    with_root(root, move |root| {
        board::set_done_column(root, name.as_deref())
    })
    .await
}
