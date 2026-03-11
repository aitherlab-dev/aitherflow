use rusqlite::Connection;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::db;

/// Cached history index: global byte offset + accumulated entries per session.
static HISTORY_CACHE: Mutex<Option<HistoryCache>> = Mutex::new(None);

struct HistoryCache {
    byte_offset: u64,
    /// session_id → (display_text, timestamp_iso)
    entries: std::collections::HashMap<String, (String, String)>,
}

/// Compute a deterministic content hash (FNV-1a) for a list of messages.
/// Uses a fixed algorithm so hashes are stable across restarts.
fn compute_content_hash(messages: &[(String, String, String, String)]) -> String {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x00000100000001B3;

    let mut h = FNV_OFFSET;
    for (_, role, text, ts) in messages {
        for b in role.bytes().chain(text.bytes()).chain(ts.bytes()) {
            h ^= b as u64;
            h = h.wrapping_mul(FNV_PRIME);
        }
    }
    format!("{:016x}", h)
}

/// Encode a project path the same way CLI does: `/`, `.`, `_` → `-`.
/// e.g. `/home/sasha/WORK/AITHEFLOW` → `-home-sasha-WORK-AITHEFLOW`
/// e.g. `/home/sasha/.config/aither-flow` → `-home-sasha--config-aither-flow`
pub fn encode_project_path(project_path: &str) -> String {
    project_path.replace(['/', '.', '_'], "-")
}

/// Find the CLI projects directory for a given project path.
/// Returns `~/.claude/projects/<encoded-path>/`
fn cli_sessions_dir(project_path: &str) -> Option<PathBuf> {
    let encoded = encode_project_path(project_path);
    let dir = crate::config::home_dir().join(".claude").join("projects").join(encoded);
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// Load the global history index and pass a reference to the caller via closure.
/// Uses incremental reading: remembers byte offset and only reads new lines on subsequent calls.
/// Avoids cloning the entire HashMap — the closure receives a borrowed reference while the lock is held.
fn with_history_index<R>(f: impl FnOnce(&std::collections::HashMap<String, (String, String)>) -> R) -> R {
    use std::io::{BufRead, Seek, SeekFrom};

    static EMPTY: std::sync::LazyLock<std::collections::HashMap<String, (String, String)>> =
        std::sync::LazyLock::new(std::collections::HashMap::new);

    let home = crate::config::home_dir();
    let history_path = home.join(".claude").join("history.jsonl");

    let mut file = match std::fs::File::open(&history_path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return f(&EMPTY);
        }
        Err(e) => {
            eprintln!("[memory] Failed to read {}: {e}", history_path.display());
            return f(&EMPTY);
        }
    };

    let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);

    let mut cache = HISTORY_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache_inner = cache.get_or_insert_with(|| HistoryCache {
        byte_offset: 0,
        entries: std::collections::HashMap::new(),
    });

    // If file was truncated/rotated, reset offset
    if file_len < cache_inner.byte_offset {
        cache_inner.byte_offset = 0;
        cache_inner.entries.clear();
    }

    // Nothing new to read
    if file_len == cache_inner.byte_offset {
        return f(&cache_inner.entries);
    }

    // Seek to last known offset and read only new lines
    if let Err(e) = file.seek(SeekFrom::Start(cache_inner.byte_offset)) {
        eprintln!("[memory] Failed to seek history.jsonl: {e}");
        return f(&cache_inner.entries);
    }

    let reader = std::io::BufReader::new(&file);
    for line in reader.lines().map_while(Result::ok) {
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[memory] Failed to parse history.jsonl line: {e}");
                continue;
            }
        };
        if let (Some(sid), Some(display), Some(ts)) = (
            v.get("sessionId").and_then(|s| s.as_str()),
            v.get("display").and_then(|d| d.as_str()),
            v.get("timestamp").and_then(|t| t.as_u64()),
        ) {
            let secs = ts / 1000;
            let iso = timestamp_to_iso(secs);
            cache_inner
                .entries
                .insert(sid.to_string(), (display.to_string(), iso));
        }
    }

    cache_inner.byte_offset = file_len;

    f(&cache_inner.entries)
}

/// Convert unix timestamp (seconds) to ISO 8601 string.
fn timestamp_to_iso(secs: u64) -> String {
    use chrono::TimeZone;
    chrono::Utc
        .timestamp_opt(secs as i64, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

/// Parse a single JSONL session file and extract user/assistant text messages.
/// Returns: Vec<(session_id, role, text, timestamp)>
fn parse_session_file(
    path: &Path,
    session_id: &str,
) -> Vec<(String, String, String, String)> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[memory] Failed to read {}: {e}", path.display());
            return Vec::new();
        }
    };

    let mut messages = Vec::new();

    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }

        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[memory] Failed to parse JSONL line in {}: {e}", path.display());
                continue;
            }
        };

        let msg_type = match v.get("type").and_then(|t| t.as_str()) {
            Some(t) => t,
            None => continue,
        };

        let timestamp = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        match msg_type {
            "user" => {
                // Extract text from message.content[] where type == "text"
                if let Some(content_arr) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for block in content_arr {
                        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                let text = text.trim();
                                if !text.is_empty() {
                                    messages.push((
                                        session_id.to_string(),
                                        "user".to_string(),
                                        text.to_string(),
                                        timestamp.clone(),
                                    ));
                                }
                            }
                        }
                    }
                }
            }
            "assistant" => {
                // Extract only text blocks (skip thinking, tool_use)
                if let Some(content_arr) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for block in content_arr {
                        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                let text = text.trim();
                                if !text.is_empty() {
                                    messages.push((
                                        session_id.to_string(),
                                        "assistant".to_string(),
                                        text.to_string(),
                                        timestamp.clone(),
                                    ));
                                }
                            }
                        }
                    }
                }
            }
            _ => {} // skip queue-operation, system, etc.
        }
    }

    messages
}

/// Index all CLI sessions for a specific project.
/// Skips already-indexed sessions. Returns count of new messages indexed.
pub fn index_project(conn: &Connection, project_path: &str) -> Result<usize, String> {
    let sessions_dir = match cli_sessions_dir(project_path) {
        Some(d) => d,
        None => {
            eprintln!(
                "[memory] No CLI sessions directory for project: {project_path}"
            );
            return Ok(0);
        }
    };

    // Find all .jsonl files
    let entries: Vec<_> = match std::fs::read_dir(&sessions_dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .extension()
                    .map(|ext| ext == "jsonl")
                    .unwrap_or(false)
            })
            .collect(),
        Err(e) => {
            eprintln!("[memory] Failed to read sessions dir: {e}");
            return Ok(0);
        }
    };

    // Pre-fetch history entries only for sessions we have on disk (avoids cloning entire HashMap)
    let session_ids: Vec<String> = entries
        .iter()
        .filter_map(|e| e.path().file_stem().and_then(|s| s.to_str()).map(String::from))
        .collect();
    let history: std::collections::HashMap<String, (String, String)> =
        with_history_index(|all| {
            session_ids
                .iter()
                .filter_map(|id| all.get(id).map(|v| (id.clone(), v.clone())))
                .collect()
        });

    let mut total_messages = 0usize;
    let mut updated_sessions = 0usize;

    for entry in &entries {
        let path = entry.path();
        let session_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };

        // Parse the JSONL file
        let messages = parse_session_file(&path, &session_id);
        if messages.is_empty() {
            continue;
        }

        let already_indexed = db::session_exists(conn, &session_id);

        if !already_indexed {
            // New session — insert session record + all messages
            let (first_msg, created_at) = history
                .get(&session_id)
                .map(|(d, t)| (Some(d.as_str()), t.as_str()))
                .unwrap_or_else(|| {
                    let first = messages.first().map(|m| m.2.as_str());
                    let ts = messages
                        .first()
                        .map(|m| m.3.as_str())
                        .unwrap_or("unknown");
                    (first, ts)
                });

            db::insert_session(conn, &session_id, project_path, first_msg, created_at)?;
            let count = db::insert_messages(conn, &messages)?;
            db::set_content_hash(conn, &session_id, &compute_content_hash(&messages))?;
            total_messages += count;
            updated_sessions += 1;
        } else {
            // Resumed session — check for new or rewritten messages
            let existing_count = db::message_count_for_session(conn, &session_id);
            let new_hash = compute_content_hash(&messages);
            let stored_hash = db::get_content_hash(conn, &session_id);

            if messages.len() > existing_count && stored_hash.is_none() {
                // Appended messages (legacy: no hash stored yet) — index only the new ones
                let new_messages = &messages[existing_count..];
                let count = db::insert_messages(conn, new_messages)?;
                db::set_content_hash(conn, &session_id, &new_hash)?;
                total_messages += count;
                updated_sessions += 1;
            } else if stored_hash.as_deref() != Some(&new_hash) {
                // Content changed (different count or same count but different hash) — re-index
                db::delete_messages_for_session(conn, &session_id)?;
                let count = db::insert_messages(conn, &messages)?;
                db::set_content_hash(conn, &session_id, &new_hash)?;
                total_messages += count;
                updated_sessions += 1;
            }
        }
    }

    if total_messages > 0 {
        eprintln!(
            "[memory] Indexed {total_messages} messages from {updated_sessions} sessions for {project_path}",
        );
    }

    Ok(total_messages)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_to_iso_epoch() {
        assert_eq!(timestamp_to_iso(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn timestamp_to_iso_known_timestamp() {
        // 2024-01-01 00:00:00 UTC = 1704067200
        assert_eq!(timestamp_to_iso(1704067200), "2024-01-01T00:00:00Z");
    }

    #[test]
    fn timestamp_to_iso_with_time() {
        // 2026-03-08 14:30:45 UTC = 1772980245
        assert_eq!(timestamp_to_iso(1772980245), "2026-03-08T14:30:45Z");
    }
}
