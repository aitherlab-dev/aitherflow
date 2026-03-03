//! Aither Flow Memory — MCP stdio server for session history search.
//!
//! Usage: aither-flow-memory --db <path> --project <path>
//!
//! Implements minimal MCP protocol (JSON-RPC over stdin/stdout).
//! Tools: search_history, get_session, list_sessions

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let db_path = get_arg(&args, "--db").unwrap_or_else(|| {
        eprintln!("Usage: aither-flow-memory --db <path> --project <path>");
        std::process::exit(1);
    });

    let project_path = get_arg(&args, "--project").unwrap_or_else(|| {
        eprintln!("Usage: aither-flow-memory --db <path> --project <path>");
        std::process::exit(1);
    });

    // Open database read-only (Tauri app writes, we only read)
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap_or_else(|e| {
        eprintln!("Failed to open database {db_path}: {e}");
        std::process::exit(1);
    });

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        if line.trim().is_empty() {
            continue;
        }

        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let err = json_rpc_error(None, -32700, &format!("Parse error: {e}"));
                write_response(&mut stdout, &err);
                continue;
            }
        };

        let response = handle_request(&conn, &project_path, &request);
        write_response(&mut stdout, &response);
    }
}

fn get_arg(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn write_response(stdout: &mut io::Stdout, response: &Value) {
    let s = serde_json::to_string(response).unwrap_or_default();
    let _ = writeln!(stdout, "{s}");
    let _ = stdout.flush();
}

// --- JSON-RPC types ---

#[derive(Deserialize)]
struct JsonRpcRequest {
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

fn json_rpc_result(id: Option<&Value>, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn json_rpc_error(id: Option<&Value>, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    })
}

// --- Request handling ---

fn handle_request(conn: &Connection, project_path: &str, req: &JsonRpcRequest) -> Value {
    match req.method.as_str() {
        "initialize" => handle_initialize(req.id.as_ref()),

        "notifications/initialized" => {
            // Notification, no response needed — but we return empty to keep protocol happy
            json!(null)
        }

        "tools/list" => handle_tools_list(req.id.as_ref()),

        "tools/call" => handle_tools_call(conn, project_path, req.id.as_ref(), &req.params),

        _ => json_rpc_error(
            req.id.as_ref(),
            -32601,
            &format!("Method not found: {}", req.method),
        ),
    }
}

fn handle_initialize(id: Option<&Value>) -> Value {
    json_rpc_result(
        id,
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "aither-flow-memory",
                "version": "0.1.0"
            }
        }),
    )
}

fn handle_tools_list(id: Option<&Value>) -> Value {
    json_rpc_result(
        id,
        json!({
            "tools": [
                {
                    "name": "search_history",
                    "description": "Search through past conversation history for this project. Use this when the user asks about previous discussions, decisions, or topics from earlier sessions. Returns matching message snippets with context.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "Search terms (keywords or phrases)"
                            },
                            "limit": {
                                "type": "integer",
                                "description": "Max results (default 10)",
                                "default": 10
                            }
                        },
                        "required": ["query"]
                    }
                },
                {
                    "name": "get_session",
                    "description": "Retrieve the full conversation from a specific past session by its ID. Use after search_history to get more context from a particular session.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "session_id": {
                                "type": "string",
                                "description": "Session UUID"
                            },
                            "max_messages": {
                                "type": "integer",
                                "description": "Max messages to return (default 50)",
                                "default": 50
                            }
                        },
                        "required": ["session_id"]
                    }
                },
                {
                    "name": "list_sessions",
                    "description": "List recent conversation sessions for this project, ordered by date. Shows session ID, first message, date, and message count.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "limit": {
                                "type": "integer",
                                "description": "Max sessions (default 20)",
                                "default": 20
                            }
                        }
                    }
                }
            ]
        }),
    )
}

fn handle_tools_call(
    conn: &Connection,
    project_path: &str,
    id: Option<&Value>,
    params: &Value,
) -> Value {
    let tool_name = params
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("");

    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));

    let result = match tool_name {
        "search_history" => tool_search_history(conn, project_path, &arguments),
        "get_session" => tool_get_session(conn, &arguments),
        "list_sessions" => tool_list_sessions(conn, project_path, &arguments),
        _ => Err(format!("Unknown tool: {tool_name}")),
    };

    match result {
        Ok(content) => json_rpc_result(
            id,
            json!({
                "content": [{
                    "type": "text",
                    "text": content
                }]
            }),
        ),
        Err(e) => json_rpc_result(
            id,
            json!({
                "content": [{
                    "type": "text",
                    "text": format!("Error: {e}")
                }],
                "isError": true
            }),
        ),
    }
}

// --- Tool implementations ---

fn tool_search_history(
    conn: &Connection,
    project_path: &str,
    args: &Value,
) -> Result<String, String> {
    let query = args
        .get("query")
        .and_then(|q| q.as_str())
        .ok_or("Missing 'query' parameter")?;

    let limit = args
        .get("limit")
        .and_then(|l| l.as_u64())
        .unwrap_or(10) as usize;

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
        .map_err(|e| format!("Query failed: {e}"))?;

    let results: Vec<SearchHit> = stmt
        .query_map(params![query, project_path, limit as i64], |row| {
            Ok(SearchHit {
                session_id: row.get(0)?,
                role: row.get(1)?,
                text: {
                    let full: String = row.get(2)?;
                    if full.len() > 300 {
                        format!("{}...", &full[..300])
                    } else {
                        full
                    }
                },
                timestamp: row.get(3)?,
                snippet: row.get(4)?,
            })
        })
        .map_err(|e| format!("Query failed: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    if results.is_empty() {
        return Ok(format!("No results found for '{query}' in project history."));
    }

    let mut output = format!("Found {} results for '{query}':\n\n", results.len());
    for (i, hit) in results.iter().enumerate() {
        output.push_str(&format!(
            "{}. [{}] ({}) session:{}\n   {}\n\n",
            i + 1,
            hit.role,
            hit.timestamp,
            &hit.session_id[..8],
            hit.snippet
        ));
    }

    Ok(output)
}

fn tool_get_session(conn: &Connection, args: &Value) -> Result<String, String> {
    let session_id = args
        .get("session_id")
        .and_then(|s| s.as_str())
        .ok_or("Missing 'session_id' parameter")?;

    let max_messages = args
        .get("max_messages")
        .and_then(|m| m.as_u64())
        .unwrap_or(50) as usize;

    let mut stmt = conn
        .prepare(
            "SELECT role, text, timestamp
             FROM messages
             WHERE session_id = ?1
             ORDER BY timestamp ASC
             LIMIT ?2",
        )
        .map_err(|e| format!("Query failed: {e}"))?;

    let messages: Vec<(String, String, String)> = stmt
        .query_map(params![session_id, max_messages as i64], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| format!("Query failed: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    if messages.is_empty() {
        return Ok(format!("Session {session_id} not found or empty."));
    }

    let mut output = format!("Session {} ({} messages):\n\n", &session_id[..8], messages.len());
    for (role, text, ts) in &messages {
        let label = if role == "user" { "USER" } else { "ASSISTANT" };
        output.push_str(&format!("[{label}] ({ts})\n{text}\n\n---\n\n"));
    }

    Ok(output)
}

fn tool_list_sessions(
    conn: &Connection,
    project_path: &str,
    args: &Value,
) -> Result<String, String> {
    let limit = args
        .get("limit")
        .and_then(|l| l.as_u64())
        .unwrap_or(20) as usize;

    let mut stmt = conn
        .prepare(
            "SELECT s.session_id, s.first_message, s.created_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.session_id) as cnt
             FROM sessions s
             WHERE s.project_path = ?1
             ORDER BY s.created_at DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("Query failed: {e}"))?;

    let sessions: Vec<(String, Option<String>, String, i64)> = stmt
        .query_map(params![project_path, limit as i64], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| format!("Query failed: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    if sessions.is_empty() {
        return Ok("No sessions found for this project.".to_string());
    }

    let mut output = format!("{} recent sessions:\n\n", sessions.len());
    for (sid, first_msg, created, count) in &sessions {
        let preview = first_msg
            .as_deref()
            .unwrap_or("(no preview)")
            .chars()
            .take(80)
            .collect::<String>();
        output.push_str(&format!(
            "- {} | {} | {} msgs | {}\n",
            &sid[..8],
            created,
            count,
            preview
        ));
    }

    Ok(output)
}

#[derive(Debug, Serialize)]
struct SearchHit {
    session_id: String,
    role: String,
    text: String,
    timestamp: String,
    snippet: String,
}
