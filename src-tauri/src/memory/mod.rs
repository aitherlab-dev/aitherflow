pub mod db;
pub mod indexer;

use crate::config;

/// Path to the session-memory database.
pub fn memory_db_path() -> std::path::PathBuf {
    config::data_dir().join("session-memory.db")
}

/// Initialize the memory database (create if needed).
/// Call from app setup.
pub fn init() {
    let db_path = memory_db_path();
    match db::open_db(&db_path) {
        Ok(_) => eprintln!("[memory] Database ready: {}", db_path.display()),
        Err(e) => eprintln!("[memory] Database init failed: {e}"),
    }
}

/// Background-index sessions for a project. Call inside spawn_blocking.
#[allow(dead_code)]
pub fn background_index(project_path: &str) {
    let db_path = memory_db_path();
    match db::open_db(&db_path) {
        Ok(conn) => match indexer::index_project(&conn, project_path) {
            Ok(count) => {
                if count > 0 {
                    eprintln!("[memory] Background index: {count} new messages");
                }
            }
            Err(e) => eprintln!("[memory] Background index error: {e}"),
        },
        Err(e) => eprintln!("[memory] Failed to open db for indexing: {e}"),
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
        let db_path = memory_db_path();
        let conn = db::open_db(&db_path)?;
        db::search_messages(&conn, &project_path, &query, limit)
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
        let db_path = memory_db_path();
        let conn = db::open_db(&db_path)?;
        db::list_sessions(&conn, &project_path, limit)
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
        let db_path = memory_db_path();
        let conn = db::open_db(&db_path)?;
        db::get_session_messages(&conn, &session_id, max_messages)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn memory_index_project(project_path: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let db_path = memory_db_path();
        let conn = db::open_db(&db_path)?;
        indexer::index_project(&conn, &project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
