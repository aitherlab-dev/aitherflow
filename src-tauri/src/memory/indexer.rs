use rusqlite::Connection;
use serde_json::Value;
use std::path::{Path, PathBuf};

use super::db;

/// Encode a project path the same way CLI does: slashes → dashes.
/// e.g. `/home/sasha/WORK/AITHEFLOW` → `-home-sasha-WORK-AITHEFLOW`
pub fn encode_project_path(project_path: &str) -> String {
    project_path.replace(['/', '.', '_'], "-")
}

/// Find the CLI projects directory for a given project path.
/// Returns `~/.claude/projects/<encoded-path>/`
fn cli_sessions_dir(project_path: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let encoded = encode_project_path(project_path);
    let dir = home.join(".claude").join("projects").join(encoded);
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// Load the global history index to get first_message and created_at for sessions.
/// Returns a map: session_id → (display_text, timestamp_iso)
fn load_history_index(project_path: &str) -> std::collections::HashMap<String, (String, String)> {
    let mut map = std::collections::HashMap::new();

    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return map,
    };

    let history_path = home.join(".claude").join("history.jsonl");
    let content = match std::fs::read_to_string(&history_path) {
        Ok(c) => c,
        Err(_) => return map,
    };

    for line in content.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            let project = v.get("project").and_then(|p| p.as_str()).unwrap_or("");
            if project != project_path {
                continue;
            }
            if let (Some(sid), Some(display), Some(ts)) = (
                v.get("sessionId").and_then(|s| s.as_str()),
                v.get("display").and_then(|d| d.as_str()),
                v.get("timestamp").and_then(|t| t.as_u64()),
            ) {
                // Convert millis timestamp to ISO string
                let secs = ts / 1000;
                let nanos = (ts % 1000) * 1_000_000;
                let iso = chrono_like_iso(secs, nanos);
                map.insert(sid.to_string(), (display.to_string(), iso));
            }
        }
    }

    map
}

/// Simple timestamp conversion (avoids chrono dependency).
fn chrono_like_iso(secs: u64, _nanos: u64) -> String {
    // Use std::time for a rough ISO string — good enough for sorting
    // Format: 2026-03-03T20:53:35Z
    let d = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
    let dt = d;
    // humantime gives us a nice ISO format
    // But we don't have humantime, so format manually:
    let secs_since_epoch = dt
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let days = secs_since_epoch / 86400;
    let time_of_day = secs_since_epoch % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Days since epoch to Y-M-D (simplified)
    let (year, month, day) = days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    // Civil days algorithm (Howard Hinnant)
    days += 719_468;
    let era = days / 146_097;
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
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
            Err(_) => continue,
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

    // Load history index for first_message / created_at
    let history = load_history_index(project_path);

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

    let mut total_messages = 0usize;

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
            total_messages += count;
        } else {
            // Resumed session — only insert new messages (skip already indexed)
            let existing_count = db::message_count_for_session(conn, &session_id);
            if messages.len() > existing_count {
                let new_messages = &messages[existing_count..];
                let count = db::insert_messages(conn, new_messages)?;
                total_messages += count;
            }
        }
    }

    if total_messages > 0 {
        eprintln!(
            "[memory] Indexed {total_messages} messages from {} new sessions for {project_path}",
            entries.len()
        );
    }

    Ok(total_messages)
}
