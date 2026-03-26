//! Shared MCP SSE transport — generic server infrastructure for SSE-based MCP servers.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::{mpsc, RwLock};

// ── Auth & JSON-RPC helpers ──

pub fn check_auth(headers: &HeaderMap, expected: &str) -> Option<Response> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = auth.strip_prefix("Bearer ").unwrap_or("");
    if token != expected {
        return Some(StatusCode::UNAUTHORIZED.into_response());
    }
    None
}

pub fn jsonrpc_error(id: Option<Value>, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

// ── McpServerInfo ──

pub struct McpServerInfo {
    pub port: u16,
    pub auth_token: String,
    pub shutdown_tx: tokio::sync::watch::Sender<bool>,
}

// ── McpState trait ──

pub trait McpState: Send + Sync + 'static {
    fn sessions(&self) -> &RwLock<HashMap<String, mpsc::Sender<String>>>;
    fn auth_token(&self) -> &str;
}

// ── McpToolHandler trait ──

#[axum::async_trait]
pub trait McpToolHandler: Send + Sync + 'static {
    fn server_name(&self) -> &str;
    fn server_version(&self) -> &str { "0.1.0" }
    fn tool_definitions(&self) -> Value;
    async fn execute_tool(&self, name: &str, args: &Value) -> Result<String, String>;
    fn max_sessions(&self) -> usize { 50 }
}

// ── McpSseStream ──

pub struct McpSseStream<S: McpState> {
    rx: mpsc::Receiver<String>,
    initial_event: Option<String>,
    session_id: String,
    state: Arc<S>,
}

impl<S: McpState> Stream for McpSseStream<S> {
    type Item = Result<Event, Infallible>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if let Some(endpoint) = this.initial_event.take() {
            return Poll::Ready(Some(Ok(
                Event::default().event("endpoint").data(endpoint),
            )));
        }
        match this.rx.poll_recv(cx) {
            Poll::Ready(Some(msg)) => {
                Poll::Ready(Some(Ok(Event::default().event("message").data(msg))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl<S: McpState> Drop for McpSseStream<S> {
    fn drop(&mut self) {
        let session_id = self.session_id.clone();
        let state = self.state.clone();
        tokio::spawn(async move {
            state.sessions().write().await.remove(&session_id);
        });
    }
}

// ── SSE handler ──

async fn handle_sse<S: McpState, H: McpToolHandler>(
    State((state, handler)): State<(Arc<S>, Arc<H>)>,
    headers: HeaderMap,
) -> Response {
    if let Some(resp) = check_auth(&headers, state.auth_token()) {
        return resp;
    }
    {
        let sessions = state.sessions().read().await;
        if sessions.len() >= handler.max_sessions() {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel(32);

    state.sessions().write().await.insert(session_id.clone(), tx);

    let stream = McpSseStream {
        rx,
        initial_event: Some(format!("/message?sessionId={session_id}")),
        session_id,
        state,
    };

    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(30)))
        .into_response()
}

// ── Message handler ──

#[derive(Deserialize)]
struct MessageQuery {
    #[serde(rename = "sessionId")]
    session_id: String,
}

async fn handle_message<S: McpState, H: McpToolHandler>(
    State((state, handler)): State<(Arc<S>, Arc<H>)>,
    headers: HeaderMap,
    Query(query): Query<MessageQuery>,
    Json(msg): Json<Value>,
) -> Response {
    if let Some(resp) = check_auth(&headers, state.auth_token()) {
        return resp;
    }

    let session_id = query.session_id;
    let method = msg
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let id = msg.get("id").cloned();

    // Notifications — no response needed
    if id.is_none() || method == "notifications/initialized" {
        return StatusCode::ACCEPTED.into_response();
    }

    let server_name = handler.server_name().to_string();

    tokio::spawn(async move {
        let response_json = match method.as_str() {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": {
                        "name": server_name,
                        "version": handler.server_version()
                    }
                }
            }),
            "tools/list" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "tools": handler.tool_definitions() }
            }),
            "tools/call" => {
                let tool_name = msg.pointer("/params/name").and_then(|n| n.as_str()).unwrap_or("");
                let args = msg.pointer("/params/arguments").cloned().unwrap_or(json!({}));
                match handler.execute_tool(tool_name, &args).await {
                    Ok(text) => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [{ "type": "text", "text": text }],
                            "isError": false
                        }
                    }),
                    Err(e) => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [{ "type": "text", "text": e }],
                            "isError": true
                        }
                    }),
                }
            }
            _ => jsonrpc_error(id, -32601, &format!("Method not found: {method}")),
        };

        let sessions = state.sessions().read().await;
        if let Some(tx) = sessions.get(&session_id) {
            let response_str = serde_json::to_string(&response_json).unwrap_or_default();
            if let Err(e) = tx.send(response_str).await {
                eprintln!("[{server_name}] Failed to send SSE response: {e}");
            }
        }
    });

    StatusCode::ACCEPTED.into_response()
}

// ── Server lifecycle ──

pub async fn start_sse_server<S: McpState, H: McpToolHandler>(
    name: &str,
    mcp_info: &Mutex<Option<McpServerInfo>>,
    state: Arc<S>,
    handler: Arc<H>,
) -> Result<u16, String> {
    {
        let info = mcp_info.lock().map_err(|e| format!("Lock error: {e}"))?;
        if info.is_some() {
            return Err(format!("{name} MCP server already running"));
        }
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind: {e}"))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local addr: {e}"))?
        .port();

    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);

    {
        let mut info = mcp_info.lock().map_err(|e| format!("Lock error: {e}"))?;
        *info = Some(McpServerInfo {
            port,
            auth_token: state.auth_token().to_string(),
            shutdown_tx,
        });
    }

    let app_state = (state, handler);
    let app = Router::new()
        .route("/sse", get(handle_sse::<S, H>))
        .route("/message", post(handle_message::<S, H>))
        .with_state(app_state);

    let shutdown_name = name.to_string();
    let server_err_name = name.to_string();
    let mcp_info_ptr: &'static Mutex<Option<McpServerInfo>> =
        // SAFETY: mcp_info is a module-level static, lives for 'static
        unsafe { &*(mcp_info as *const _) };

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                if let Err(e) = shutdown_rx.wait_for(|&v| v).await {
                    eprintln!("[{shutdown_name}] Shutdown watch error: {e}");
                }
            })
            .await
        {
            eprintln!("[{server_err_name}] Server error: {e}");
        }
        if let Ok(mut info) = mcp_info_ptr.lock() {
            *info = None;
        }
    });

    eprintln!("[{name}] Listening on 127.0.0.1:{port}");
    Ok(port)
}

pub fn stop_server_sync(name: &str, mcp_info: &Mutex<Option<McpServerInfo>>) {
    if let Ok(mut info) = mcp_info.lock() {
        if let Some(i) = info.take() {
            if let Err(e) = i.shutdown_tx.send(true) {
                eprintln!("[{name}] Failed to send shutdown: {e}");
            }
        }
    }
}

pub fn get_port(mcp_info: &Mutex<Option<McpServerInfo>>) -> Option<u16> {
    mcp_info.lock().ok().and_then(|info| info.as_ref().map(|i| i.port))
}

pub fn get_token(mcp_info: &Mutex<Option<McpServerInfo>>) -> Option<String> {
    mcp_info.lock().ok().and_then(|info| info.as_ref().map(|i| i.auth_token.clone()))
}
