pub mod db;
pub mod indexer;

use crate::config;
use rusqlite::Connection;
use std::sync::Mutex;

static DB: Mutex<Option<Connection>> = Mutex::new(None);

/// Path to the session-memory database.
pub fn memory_db_path() -> std::path::PathBuf {
    config::data_dir().join("session-memory.db")
}

/// Initialize the memory database (create if needed).
/// Call from app setup.
pub fn init() -> Result<(), String> {
    let db_path = memory_db_path();
    let conn = db::open_db(&db_path).map_err(|e| format!("Database init failed: {e}"))?;
    eprintln!("[memory] Database ready: {}", db_path.display());
    let mut guard = DB.lock().map_err(|e| format!("DB mutex poisoned: {e}"))?;
    *guard = Some(conn);
    Ok(())
}

/// Run a closure with the shared database connection.
/// If the connection was not initialized (init failed), opens a new one as fallback.
fn with_conn<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, String>,
{
    let mut guard = DB.lock().map_err(|e| format!("DB mutex poisoned: {e}"))?;
    if guard.is_none() {
        eprintln!("[memory] Re-opening DB connection (init was not called or failed)");
        let db_path = memory_db_path();
        let conn = db::open_db(&db_path)?;
        *guard = Some(conn);
    }
    f(guard.as_ref().unwrap())
}

/// Background-index sessions for a project. Call inside spawn_blocking.
pub fn background_index(project_path: &str) {
    match with_conn(|conn| indexer::index_project(conn, project_path)) {
        Ok(count) => {
            if count > 0 {
                eprintln!("[memory] Background index: {count} new messages");
            }
        }
        Err(e) => eprintln!("[memory] Background index error: {e}"),
    }
}

// --- Tauri commands ---

#[tauri::command]
pub async fn memory_search(
    project_path: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<db::SearchResult>, String> {
    let limit = limit.unwrap_or(10);
    tokio::task::spawn_blocking(move || {
        with_conn(|conn| db::search_messages(conn, &project_path, &query, limit))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn memory_list_sessions(
    project_path: String,
    limit: Option<usize>,
) -> Result<Vec<db::SessionInfo>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        with_conn(|conn| db::list_sessions(conn, &project_path, limit))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn memory_get_session(
    session_id: String,
    max_messages: Option<usize>,
) -> Result<Vec<db::SessionMessage>, String> {
    let max_messages = max_messages.unwrap_or(50);
    tokio::task::spawn_blocking(move || {
        with_conn(|conn| db::get_session_messages(conn, &session_id, max_messages))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn memory_stats(project_path: String) -> Result<db::MemoryStats, String> {
    tokio::task::spawn_blocking(move || {
        with_conn(|conn| db::get_stats(conn, &project_path))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn memory_index_project(project_path: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        with_conn(|conn| indexer::index_project(conn, &project_path))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
