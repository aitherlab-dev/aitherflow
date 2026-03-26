use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::RwLock;

use super::roles::AgentRole;
use super::{mailbox, tasks};
use crate::conductor::session::SessionManager;

// ---------------------------------------------------------------------------
// Global state (set once at startup)
// ---------------------------------------------------------------------------

static MCP_STATE: OnceLock<Arc<McpServerState>> = OnceLock::new();
static SHUTDOWN_TX: OnceLock<tokio::sync::watch::Sender<bool>> = OnceLock::new();

pub struct McpServerState {
    pub port: u16,
    /// Shared secret token — must be sent as `Authorization: Bearer <token>` in every request.
    pub auth_token: String,
    /// agent_id → project info (registered when agent starts, removed on stop/exit)
    agents: RwLock<HashMap<String, AgentMcpInfo>>,
    /// session_id → agent_id (MCP sessions, spec compliance)
    sessions: RwLock<HashMap<String, String>>,
    session_manager: SessionManager,
    /// Generation counter for register/unregister race protection.
    gen_counter: AtomicU64,
}

struct AgentMcpInfo {
    /// Mailbox/tasks directory name: project slug for project teamwork.
    team_name: String,
    role: AgentRole,
    generation: u64,
    /// Project path for project teamwork agents.
    project_path: String,
}

impl McpServerState {
    /// Register a standalone project agent for project-level teamwork.
    /// Uses project slug as the mailbox namespace.
    pub async fn register_project_agent(
        &self,
        agent_id: &str,
        project_path: &str,
        project_slug: &str,
        role: AgentRole,
    ) -> u64 {
        let generation = self.gen_counter.fetch_add(1, Ordering::Relaxed) + 1;
        self.agents.write().await.insert(
            agent_id.to_string(),
            AgentMcpInfo {
                team_name: project_slug.to_string(),
                role,
                generation,
                project_path: project_path.to_string(),
            },
        );
        generation
    }

    /// Get all agent_ids that share the same project_path.
    async fn project_agent_ids(&self, project_path: &str) -> Vec<String> {
        self.agents
            .read()
            .await
            .iter()
            .filter(|(_, info)| info.project_path == project_path)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Remove agent unconditionally (explicit stop / remove).
    #[allow(dead_code)] // reserved for explicit agent stop/remove
    pub async fn unregister_agent(&self, agent_id: &str) {
        self.agents.write().await.remove(agent_id);
        self.sessions
            .write()
            .await
            .retain(|_, v| v != agent_id);
    }

    /// Remove agent only if its generation matches (process exit cleanup).
    /// Prevents a finishing old session from removing a freshly re-registered agent.
    pub async fn unregister_agent_if_current(&self, agent_id: &str, generation: u64) {
        let removed = {
            let mut agents = self.agents.write().await;
            match agents.get(agent_id) {
                Some(info) if info.generation == generation => {
                    agents.remove(agent_id);
                    true
                }
                _ => false,
            }
        };
        if removed {
            self.sessions
                .write()
                .await
                .retain(|_, v| v != agent_id);
        }
    }
}

/// Get the MCP server port (None if server not started yet).
pub fn get_mcp_port() -> Option<u16> {
    MCP_STATE.get().map(|s| s.port)
}

/// Get the MCP server auth token (None if server not started yet).
pub fn get_mcp_token() -> Option<&'static str> {
    MCP_STATE.get().map(|s| s.auth_token.as_str())
}

/// Get a reference to the global MCP state.
pub fn get_state() -> Option<&'static Arc<McpServerState>> {
    MCP_STATE.get()
}

/// Return registered agents for a project slug: Vec<{ agent_id, role_name, can_manage }>.
#[tauri::command]
pub async fn team_list_agents(
    team: String,
) -> Result<Vec<serde_json::Value>, String> {
    let state = get_state().ok_or("MCP server not running")?;
    let agents = state.agents.read().await;
    let mut result = Vec::new();
    for (id, info) in agents.iter() {
        if info.team_name == team {
            result.push(serde_json::json!({
                "agent_id": id,
                "role_name": info.role.name,
                "can_manage": info.role.can_manage,
            }));
        }
    }
    Ok(result)
}

/// Signal the MCP server to shut down gracefully.
pub fn shutdown_mcp_server() {
    if let Some(tx) = SHUTDOWN_TX.get() {
        if let Err(e) = tx.send(true) {
            eprintln!("[mcp-server] Failed to send shutdown signal: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

/// Start the MCP HTTP server on 127.0.0.1 with a random free port.
pub async fn start_mcp_server(
    session_manager: SessionManager,
) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind MCP server: {e}"))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local addr: {e}"))?
        .port();

    let auth_token = uuid::Uuid::new_v4().to_string();

    let state = Arc::new(McpServerState {
        port,
        auth_token,
        agents: RwLock::new(HashMap::new()),
        sessions: RwLock::new(HashMap::new()),
        session_manager,
        gen_counter: AtomicU64::new(0),
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

    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    SHUTDOWN_TX.set(shutdown_tx).map_err(|_| "Shutdown channel already initialized".to_string())?;

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                if let Err(e) = shutdown_rx.wait_for(|&v| v).await {
                    eprintln!("[mcp-server] Shutdown watch error: {e}");
                }
            })
            .await
        {
            eprintln!("[mcp-server] Server error: {e}");
        }
    });

    eprintln!("[mcp-server] Listening on 127.0.0.1:{port}");
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

/// Check Authorization: Bearer <token> header against the server's shared secret.
/// Returns Some(response) if auth fails, None if ok.
fn check_auth(headers: &HeaderMap, expected: &str) -> Option<Response> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = auth.strip_prefix("Bearer ").unwrap_or("");
    if token != expected {
        return Some((StatusCode::UNAUTHORIZED, "Invalid or missing auth token").into_response());
    }
    None
}

async fn handle_post(
    Path(agent_id): Path<String>,
    State(state): State<Arc<McpServerState>>,
    headers: HeaderMap,
    Json(msg): Json<Value>,
) -> Response {
    if let Some(resp) = check_auth(&headers, &state.auth_token) {
        return resp;
    }

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
        "tools/list" => handle_tools_list(id, &agent_id, &state).await,
        "tools/call" => handle_tools_call(id, &agent_id, &state, &msg).await,
        _ => jsonrpc_error_response(id, -32601, &format!("Method not found: {method}")),
    }
}

async fn handle_get(Path(_agent_id): Path<String>) -> Response {
    // Server-initiated SSE not supported yet
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

async fn handle_delete(
    Path(agent_id): Path<String>,
    State(state): State<Arc<McpServerState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(resp) = check_auth(&headers, &state.auth_token) {
        return resp;
    }

    let sid = match headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
    {
        Some(s) => s.to_string(),
        None => {
            return (StatusCode::BAD_REQUEST, "Missing Mcp-Session-Id header")
                .into_response();
        }
    };

    let mut sessions = state.sessions.write().await;
    match sessions.get(&sid) {
        Some(owner) if owner == &agent_id => {
            sessions.remove(&sid);
            StatusCode::OK.into_response()
        }
        Some(_) => (
            StatusCode::FORBIDDEN,
            "Session does not belong to this agent",
        )
            .into_response(),
        None => (StatusCode::BAD_REQUEST, "Invalid Mcp-Session-Id").into_response(),
    }
}

// ---------------------------------------------------------------------------
// MCP protocol handlers
// ---------------------------------------------------------------------------

async fn handle_initialize(
    id: Option<Value>,
    agent_id: &str,
    state: &McpServerState,
) -> Response {
    // Only registered agents can open MCP sessions
    if !state.agents.read().await.contains_key(agent_id) {
        return jsonrpc_error_response(
            id,
            -32600,
            &format!("Agent '{agent_id}' is not registered"),
        );
    }

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

async fn handle_tools_list(
    id: Option<Value>,
    agent_id: &str,
    state: &McpServerState,
) -> Response {
    let role = {
        let agents = state.agents.read().await;
        agents.get(agent_id).map(|info| info.role.clone())
    };
    let body = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "tools": tool_definitions_for_role(role.as_ref())
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
            | "list_agents"
            | "send_prompt"
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

    // Look up agent's project info
    let (team_name, project_path) = {
        let agents = state.agents.read().await;
        let info = agents
            .get(agent_id)
            .ok_or_else(|| format!("Agent {agent_id} not registered in MCP server"))?;
        (
            info.team_name.clone(),
            info.project_path.clone(),
        )
    };

    // Compute agent_ids dynamically from all agents sharing the same project
    let team_agent_ids = state.project_agent_ids(&project_path).await;

    let agent_id = agent_id.to_string();

    match tool_name {
        // ---- Communication tools ----

        "send_message" => {
            let to = args["to"]
                .as_str()
                .ok_or("Missing 'to' parameter")?
                .to_string();
            if to == agent_id {
                return Err("Cannot send message to yourself".into());
            }
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
                if let Err(e) = tokio::task::spawn_blocking(move || {
                    if let Err(e) = mailbox::mark_read_sync(&team_m, &aid_m, &ids) {
                        eprintln!("[mcp-server] Failed to mark messages as read: {e}");
                    }
                })
                .await {
                    eprintln!("[mcp-server] mark_read task panicked: {e}");
                }
            });

            Ok(text)
        }

        // ---- Task tools ----

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

        // ---- Info tools ----

        "list_agents" => {
            let agents = state.agents.read().await;
            let agent_list: Vec<Value> = agents
                .iter()
                .filter(|(_, info)| info.project_path == project_path)
                .map(|(id, info)| {
                    json!({
                        "agent_id": id,
                        "role": info.role.name,
                        "can_manage": info.role.can_manage,
                        "is_self": id == &agent_id,
                    })
                })
                .collect();
            serde_json::to_string_pretty(&agent_list)
                .map_err(|e| format!("Serialize error: {e}"))
        }

        "send_prompt" => {
            let target_id = args["agent_id"]
                .as_str()
                .ok_or("Missing 'agent_id' parameter")?
                .to_string();
            if target_id == agent_id {
                return Err("Cannot send prompt to yourself".to_string());
            }
            if !team_agent_ids.contains(&target_id) {
                return Err(format!("Agent {target_id} is not in your project"));
            }
            let prompt = args["prompt"]
                .as_str()
                .ok_or("Missing 'prompt' parameter")?
                .to_string();
            eprintln!(
                "[mcp-server] Agent {} sending prompt to agent {}",
                agent_id, target_id
            );
            let ndjson =
                crate::conductor::message::build_stdin_message(&prompt, &[])?;
            let writer = state
                .session_manager
                .get_writer(&target_id)
                .await
                .ok_or_else(|| format!("No active session for agent {target_id}"))?;
            let sent = writer.write_if_idle(&ndjson).await?;
            if sent {
                Ok("Prompt sent".to_string())
            } else {
                Err(format!("Agent {target_id} is busy (not idle), message not sent"))
            }
        }

        _ => Err(format!("Unknown tool: {tool_name}")),
    }
}

// ---------------------------------------------------------------------------
// Tool definitions (MCP JSON Schema)
// ---------------------------------------------------------------------------

/// Communication and task tools — available to all roles.
fn communication_tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "send_message",
            "description": "Send a message to another agent in your project. The 'from' field is set automatically from your identity.",
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
        }),
        json!({
            "name": "broadcast",
            "description": "Send a message to all other agents in your project.",
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
        }),
        json!({
            "name": "read_inbox",
            "description": "Read your unread messages. Messages are automatically marked as read after retrieval.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "list_tasks",
            "description": "List all tasks for your project, sorted by status (pending first, then in-progress, then completed).",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "create_task",
            "description": "Create a new task for the project.",
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
        }),
        json!({
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
        }),
        json!({
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
        }),
        json!({
            "name": "list_agents",
            "description": "List all agents in your project with their current role.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "send_prompt",
            "description": "Send a prompt directly to another agent's CLI session. The prompt is injected into the agent's stdin and will be processed immediately (or after current turn completes).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "description": "The agent_id of the target agent"
                    },
                    "prompt": {
                        "type": "string",
                        "description": "The prompt text to send"
                    }
                },
                "required": ["agent_id", "prompt"]
            }
        }),
    ]
}

/// Get tool definitions filtered by agent role.
fn tool_definitions_for_role(_role: Option<&AgentRole>) -> Value {
    // All tools are available to all project agents now
    json!(communication_tool_definitions())
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
