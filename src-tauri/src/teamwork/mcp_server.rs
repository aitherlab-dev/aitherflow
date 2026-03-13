use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::RwLock;

use super::{mailbox, tasks};

// ---------------------------------------------------------------------------
// Global state (set once at startup)
// ---------------------------------------------------------------------------

static MCP_STATE: OnceLock<Arc<McpServerState>> = OnceLock::new();

pub struct McpServerState {
    pub port: u16,
    /// agent_id → team info (registered when agent starts, removed on stop/exit)
    agents: RwLock<HashMap<String, AgentMcpInfo>>,
    /// session_id → agent_id (MCP sessions, spec compliance)
    sessions: RwLock<HashMap<String, String>>,
}

struct AgentMcpInfo {
    team_name: String,
    team_agent_ids: Vec<String>,
}

impl McpServerState {
    /// Register a team agent so the MCP server knows its team context.
    pub async fn register_agent(
        &self,
        agent_id: &str,
        team_name: &str,
        agent_ids: Vec<String>,
    ) {
        self.agents.write().await.insert(
            agent_id.to_string(),
            AgentMcpInfo {
                team_name: team_name.to_string(),
                team_agent_ids: agent_ids,
            },
        );
    }

    /// Remove agent on stop / process exit.
    pub async fn unregister_agent(&self, agent_id: &str) {
        self.agents.write().await.remove(agent_id);
        self.sessions
            .write()
            .await
            .retain(|_, v| v != agent_id);
    }
}

/// Get the MCP server port (None if server not started yet).
pub fn get_mcp_port() -> Option<u16> {
    MCP_STATE.get().map(|s| s.port)
}

/// Get a reference to the global MCP state.
pub fn get_state() -> Option<&'static Arc<McpServerState>> {
    MCP_STATE.get()
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

/// Start the MCP HTTP server on 127.0.0.1 with a random free port.
pub async fn start_mcp_server() -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind MCP server: {e}"))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local addr: {e}"))?
        .port();

    let state = Arc::new(McpServerState {
        port,
        agents: RwLock::new(HashMap::new()),
        sessions: RwLock::new(HashMap::new()),
    });

    MCP_STATE
        .set(state.clone())
        .map_err(|_| "MCP server already started".to_string())?;

    let app = Router::new()
        .route(
            "/mcp/:agent_id",
            post(handle_post)
                .get(handle_get)
                .delete(handle_delete),
        )
        .with_state(state);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[mcp-server] Server error: {e}");
        }
    });

    eprintln!("[mcp-server] Listening on 127.0.0.1:{port}");
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

async fn handle_post(
    Path(agent_id): Path<String>,
    State(state): State<Arc<McpServerState>>,
    headers: HeaderMap,
    Json(msg): Json<Value>,
) -> Response {
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = msg.get("id").cloned();

    // initialize — no session required
    if method == "initialize" {
        return handle_initialize(id, &agent_id, &state).await;
    }

    // Notifications (no id) — always accept
    if id.is_none() {
        return StatusCode::ACCEPTED.into_response();
    }

    // Validate session: must exist AND belong to the agent_id from URL
    let sid = match headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
    {
        Some(s) => s.to_string(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                "Missing Mcp-Session-Id header",
            )
                .into_response();
        }
    };

    let session_agent = state.sessions.read().await.get(&sid).cloned();
    match session_agent {
        Some(ref owner) if owner == &agent_id => {}
        Some(_) => {
            return (
                StatusCode::FORBIDDEN,
                "Session does not belong to this agent",
            )
                .into_response();
        }
        None => {
            return (
                StatusCode::BAD_REQUEST,
                "Invalid Mcp-Session-Id",
            )
                .into_response();
        }
    }

    match method {
        "tools/list" => handle_tools_list(id),
        "tools/call" => handle_tools_call(id, &agent_id, &state, &msg).await,
        _ => jsonrpc_error_response(id, -32601, &format!("Method not found: {method}")),
    }
}

async fn handle_get(Path(_agent_id): Path<String>) -> Response {
    // Server-initiated SSE not supported yet
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

async fn handle_delete(
    Path(_agent_id): Path<String>,
    State(state): State<Arc<McpServerState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(sid) = headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
    {
        state.sessions.write().await.remove(sid);
    }
    StatusCode::OK.into_response()
}

// ---------------------------------------------------------------------------
// MCP protocol handlers
// ---------------------------------------------------------------------------

async fn handle_initialize(
    id: Option<Value>,
    agent_id: &str,
    state: &McpServerState,
) -> Response {
    let session_id = uuid::Uuid::new_v4().to_string();
    state
        .sessions
        .write()
        .await
        .insert(session_id.clone(), agent_id.to_string());

    let body = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocolVersion": "2025-03-26",
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "aitherflow-teamwork",
                "version": "0.1.0"
            }
        }
    });

    let mut resp = Json(body).into_response();
    if let Ok(val) = HeaderValue::from_str(&session_id) {
        resp.headers_mut()
            .insert(HeaderName::from_static("mcp-session-id"), val);
    }
    resp
}

fn handle_tools_list(id: Option<Value>) -> Response {
    let body = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "tools": tool_definitions()
        }
    });
    Json(body).into_response()
}

async fn handle_tools_call(
    id: Option<Value>,
    agent_id: &str,
    state: &McpServerState,
    msg: &Value,
) -> Response {
    let tool_name = msg
        .pointer("/params/name")
        .and_then(|n| n.as_str())
        .unwrap_or("");

    if !is_known_tool(tool_name) {
        return jsonrpc_error_response(
            id,
            -32602,
            &format!("Unknown tool: {tool_name}"),
        );
    }

    match execute_tool(agent_id, state, msg).await {
        Ok(text) => tool_success_response(id, &text),
        Err(e) => tool_error_response(id, &e),
    }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

fn is_known_tool(name: &str) -> bool {
    matches!(
        name,
        "send_message"
            | "broadcast"
            | "read_inbox"
            | "list_tasks"
            | "create_task"
            | "claim_task"
            | "complete_task"
    )
}

async fn execute_tool(
    agent_id: &str,
    state: &McpServerState,
    msg: &Value,
) -> Result<String, String> {
    let tool_name = msg
        .pointer("/params/name")
        .and_then(|n| n.as_str())
        .unwrap_or("");
    let args = msg
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or(json!({}));

    // Look up agent's team info
    let (team_name, team_agent_ids) = {
        let agents = state.agents.read().await;
        let info = agents
            .get(agent_id)
            .ok_or_else(|| format!("Agent {agent_id} not registered in MCP server"))?;
        (info.team_name.clone(), info.team_agent_ids.clone())
    };

    let agent_id = agent_id.to_string();

    match tool_name {
        "send_message" => {
            let to = args["to"]
                .as_str()
                .ok_or("Missing 'to' parameter")?
                .to_string();
            let text = args["text"]
                .as_str()
                .ok_or("Missing 'text' parameter")?
                .to_string();
            let team = team_name;
            let from = agent_id;
            tokio::task::spawn_blocking(move || {
                mailbox::send_message_sync(&team, &from, &to, &text)
            })
            .await
            .map_err(|e| format!("Task panic: {e}"))??;
            Ok("Message sent".to_string())
        }

        "broadcast" => {
            let text = args["text"]
                .as_str()
                .ok_or("Missing 'text' parameter")?
                .to_string();
            let team = team_name;
            let from = agent_id;
            tokio::task::spawn_blocking(move || {
                mailbox::broadcast_sync(&team, &from, &text, &team_agent_ids)
            })
            .await
            .map_err(|e| format!("Task panic: {e}"))??;
            Ok("Broadcast sent".to_string())
        }

        "read_inbox" => {
            let team = team_name.clone();
            let aid = agent_id.clone();
            let messages =
                tokio::task::spawn_blocking(move || mailbox::read_inbox_sync(&team, &aid))
                    .await
                    .map_err(|e| format!("Task panic: {e}"))??;

            if messages.is_empty() {
                return Ok("No unread messages".to_string());
            }

            let text = serde_json::to_string_pretty(&messages)
                .map_err(|e| format!("Serialize error: {e}"))?;

            // Mark as read in background
            let ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
            let team_m = team_name;
            let aid_m = agent_id;
            tokio::spawn(async move {
                let _ = tokio::task::spawn_blocking(move || {
                    if let Err(e) = mailbox::mark_read_sync(&team_m, &aid_m, &ids) {
                        eprintln!("[mcp-server] Failed to mark messages as read: {e}");
                    }
                })
                .await;
            });

            Ok(text)
        }

        "list_tasks" => {
            let team = team_name;
            let task_list =
                tokio::task::spawn_blocking(move || tasks::list_tasks_sync(&team))
                    .await
                    .map_err(|e| format!("Task panic: {e}"))??;
            serde_json::to_string_pretty(&task_list)
                .map_err(|e| format!("Serialize error: {e}"))
        }

        "create_task" => {
            let title = args["title"]
                .as_str()
                .ok_or("Missing 'title' parameter")?
                .to_string();
            let description = args["description"]
                .as_str()
                .ok_or("Missing 'description' parameter")?
                .to_string();
            let team = team_name;
            let task = tokio::task::spawn_blocking(move || {
                tasks::create_task_sync(&team, title, description)
            })
            .await
            .map_err(|e| format!("Task panic: {e}"))??;
            serde_json::to_string_pretty(&task)
                .map_err(|e| format!("Serialize error: {e}"))
        }

        "claim_task" => {
            let task_id = args["task_id"]
                .as_str()
                .ok_or("Missing 'task_id' parameter")?
                .to_string();
            let team = team_name;
            let aid = agent_id;
            let task = tokio::task::spawn_blocking(move || {
                tasks::claim_task_sync(&team, &task_id, &aid)
            })
            .await
            .map_err(|e| format!("Task panic: {e}"))??;
            serde_json::to_string_pretty(&task)
                .map_err(|e| format!("Serialize error: {e}"))
        }

        "complete_task" => {
            let task_id = args["task_id"]
                .as_str()
                .ok_or("Missing 'task_id' parameter")?
                .to_string();
            let team = team_name;
            let aid = agent_id;
            let task = tokio::task::spawn_blocking(move || {
                tasks::complete_task_sync(&team, &task_id, &aid)
            })
            .await
            .map_err(|e| format!("Task panic: {e}"))??;
            serde_json::to_string_pretty(&task)
                .map_err(|e| format!("Serialize error: {e}"))
        }

        _ => Err(format!("Unknown tool: {tool_name}")),
    }
}

// ---------------------------------------------------------------------------
// Tool definitions (MCP JSON Schema)
// ---------------------------------------------------------------------------

fn tool_definitions() -> Value {
    json!([
        {
            "name": "send_message",
            "description": "Send a message to another agent in your team. The 'from' field is set automatically from your identity.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to": {
                        "type": "string",
                        "description": "The agent_id of the recipient"
                    },
                    "text": {
                        "type": "string",
                        "description": "The message text"
                    }
                },
                "required": ["to", "text"]
            }
        },
        {
            "name": "broadcast",
            "description": "Send a message to all other agents in your team.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The message text to broadcast"
                    }
                },
                "required": ["text"]
            }
        },
        {
            "name": "read_inbox",
            "description": "Read your unread messages. Messages are automatically marked as read after retrieval.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        },
        {
            "name": "list_tasks",
            "description": "List all tasks for your team, sorted by status (pending first, then in-progress, then completed).",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        },
        {
            "name": "create_task",
            "description": "Create a new task for the team.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short title for the task"
                    },
                    "description": {
                        "type": "string",
                        "description": "Detailed description of what needs to be done"
                    }
                },
                "required": ["title", "description"]
            }
        },
        {
            "name": "claim_task",
            "description": "Claim a pending task for yourself. Only pending tasks can be claimed. Once claimed, the task moves to in-progress status.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The ID of the task to claim"
                    }
                },
                "required": ["task_id"]
            }
        },
        {
            "name": "complete_task",
            "description": "Mark a task as completed. Only the agent who claimed the task can complete it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The ID of the task to complete"
                    }
                },
                "required": ["task_id"]
            }
        }
    ])
}

// ---------------------------------------------------------------------------
// JSON-RPC response helpers
// ---------------------------------------------------------------------------

fn tool_success_response(id: Option<Value>, text: &str) -> Response {
    let body = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{ "type": "text", "text": text }],
            "isError": false
        }
    });
    Json(body).into_response()
}

fn tool_error_response(id: Option<Value>, text: &str) -> Response {
    let body = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{ "type": "text", "text": text }],
            "isError": true
        }
    });
    Json(body).into_response()
}

fn jsonrpc_error_response(id: Option<Value>, code: i32, message: &str) -> Response {
    let body = json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    });
    Json(body).into_response()
}
