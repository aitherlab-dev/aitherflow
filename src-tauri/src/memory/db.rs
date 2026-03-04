use rusqlite::{Connection, params};
use std::path::Path;

/// Open (or create) the session-memory database with WAL mode and FTS5.
pub fn open_db(db_path: &Path) -> Result<Connection, String> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create memory db directory: {e}"))?;
    }

    let conn = Connection::open(db_path)
        .map_err(|e| format!("Failed to open memory db: {e}"))?;

    // WAL mode for concurrent reads (MCP binary reads while Tauri writes)
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("Failed to set WAL mode: {e}"))?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS sessions (
            session_id   TEXT PRIMARY KEY,
            project_path TEXT NOT NULL,
            first_message TEXT,
            created_at   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role       TEXT NOT NULL,
            text       TEXT NOT NULL,
            timestamp  TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            text,
            content=messages,
            content_rowid=id
        );

        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, text)
                VALUES ('delete', old.id, old.text);
        END;

        CREATE INDEX IF NOT EXISTS idx_messages_session
            ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_project
            ON sessions(project_path);
        ",
    )
    .map_err(|e| format!("Failed to create memory schema: {e}"))?;

    Ok(conn)
}

/// Check if a session is already indexed.
pub fn session_exists(conn: &Connection, session_id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sessions WHERE session_id = ?1",
        params![session_id],
        |_| Ok(()),
    )
    .is_ok()
}

/// Count how many messages are already indexed for a session.
pub fn message_count_for_session(conn: &Connection, session_id: &str) -> usize {
    conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
        params![session_id],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0) as usize
}

/// Insert a session record.
pub fn insert_session(
    conn: &Connection,
    session_id: &str,
    project_path: &str,
    first_message: Option<&str>,
    created_at: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO sessions (session_id, project_path, first_message, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![session_id, project_path, first_message, created_at],
    )
    .map_err(|e| format!("Failed to insert session: {e}"))?;
    Ok(())
}

/// Insert a batch of messages inside a transaction.
pub fn insert_messages(
    conn: &Connection,
    messages: &[(String, String, String, String)], // (session_id, role, text, timestamp)
) -> Result<usize, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin transaction: {e}"))?;

    let mut count = 0usize;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO messages (session_id, role, text, timestamp)
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| format!("Failed to prepare insert: {e}"))?;

        for (sid, role, text, ts) in messages {
            stmt.execute(params![sid, role, text, ts])
                .map_err(|e| format!("Failed to insert message: {e}"))?;
            count += 1;
        }
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit messages: {e}"))?;
    Ok(count)
}

/// Full-text search across messages for a specific project.
pub fn search_messages(
    conn: &Connection,
    project_path: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.session_id, m.role, m.text, m.timestamp,
                    snippet(messages_fts, 0, '>>>', '<<<', '...', 40) as snip
             FROM messages_fts f
             JOIN messages m ON m.id = f.rowid
             JOIN sessions s ON s.session_id = m.session_id
             WHERE messages_fts MATCH ?1
               AND s.project_path = ?2
             ORDER BY rank
             LIMIT ?3",
        )
        .map_err(|e| format!("FTS query failed: {e}"))?;

    let rows = stmt
        .query_map(params![query, project_path, limit as i64], |row| {
            Ok(SearchResult {
                session_id: row.get(0)?,
                role: row.get(1)?,
                text: row.get(2)?,
                timestamp: row.get(3)?,
                snippet: row.get(4)?,
            })
        })
        .map_err(|e| format!("FTS query failed: {e}"))?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| format!("Row read error: {e}"))?);
    }
    Ok(results)
}

/// List recent sessions for a project.
pub fn list_sessions(
    conn: &Connection,
    project_path: &str,
    limit: usize,
) -> Result<Vec<SessionInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.session_id, s.first_message, s.created_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.session_id) as msg_count
             FROM sessions s
             WHERE s.project_path = ?1
             ORDER BY s.created_at DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("List sessions failed: {e}"))?;

    let rows = stmt
        .query_map(params![project_path, limit as i64], |row| {
            Ok(SessionInfo {
                session_id: row.get(0)?,
                first_message: row.get(1)?,
                created_at: row.get(2)?,
                message_count: row.get(3)?,
            })
        })
        .map_err(|e| format!("List sessions failed: {e}"))?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| format!("Row read error: {e}"))?);
    }
    Ok(results)
}

/// Get all messages from a specific session.
pub fn get_session_messages(
    conn: &Connection,
    session_id: &str,
    max_messages: usize,
) -> Result<Vec<SessionMessage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT role, text, timestamp
             FROM messages
             WHERE session_id = ?1
             ORDER BY timestamp ASC
             LIMIT ?2",
        )
        .map_err(|e| format!("Get session failed: {e}"))?;

    let rows = stmt
        .query_map(params![session_id, max_messages as i64], |row| {
            Ok(SessionMessage {
                role: row.get(0)?,
                text: row.get(1)?,
                timestamp: row.get(2)?,
            })
        })
        .map_err(|e| format!("Get session failed: {e}"))?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| format!("Row read error: {e}"))?);
    }
    Ok(results)
}

/// Get stats for a project: session count and total message count.
pub fn get_stats(
    conn: &Connection,
    project_path: &str,
) -> Result<MemoryStats, String> {
    let session_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE project_path = ?1",
            params![project_path],
            |row| row.get(0),
        )
        .map_err(|e| format!("Stats query failed: {e}"))?;

    let message_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM messages m
             JOIN sessions s ON s.session_id = m.session_id
             WHERE s.project_path = ?1",
            params![project_path],
            |row| row.get(0),
        )
        .map_err(|e| format!("Stats query failed: {e}"))?;

    Ok(MemoryStats {
        session_count,
        message_count,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MemoryStats {
    pub session_count: i64,
    pub message_count: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchResult {
    pub session_id: String,
    pub role: String,
    pub text: String,
    pub timestamp: String,
    pub snippet: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub first_message: Option<String>,
    pub created_at: String,
    pub message_count: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionMessage {
    pub role: String,
    pub text: String,
    pub timestamp: String,
}
