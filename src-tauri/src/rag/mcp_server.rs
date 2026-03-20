use axum::extract::{Query, State};
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
use std::sync::Mutex;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::{mpsc, RwLock};

use std::sync::Arc;

use super::{chunker, commands, embedder, index, parser, rag_settings, store};

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

// NOTE: std::sync::Mutex intentional — lock held briefly, no .await inside
static MCP_INFO: Mutex<Option<McpInfo>> = Mutex::new(None);

#[allow(dead_code)]
struct McpInfo {
    port: u16,
    shutdown_tx: tokio::sync::watch::Sender<bool>,
}

struct KnowledgeMcpState {
    sessions: RwLock<HashMap<String, mpsc::Sender<String>>>,
}

// ---------------------------------------------------------------------------
// SSE stream
// ---------------------------------------------------------------------------

struct McpSseStream {
    rx: mpsc::Receiver<String>,
    initial_event: Option<String>,
    session_id: String,
    state: Arc<KnowledgeMcpState>,
}

impl Stream for McpSseStream {
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

impl Drop for McpSseStream {
    fn drop(&mut self) {
        let session_id = self.session_id.clone();
        let state = self.state.clone();
        tokio::spawn(async move {
            state.sessions.write().await.remove(&session_id);
        });
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub fn get_port() -> Option<u16> {
    MCP_INFO.lock().ok().and_then(|info| info.as_ref().map(|i| i.port))
}

pub async fn start_server() -> Result<u16, String> {
    {
        let info = MCP_INFO.lock().map_err(|e| format!("Lock error: {e}"))?;
        if info.is_some() {
            return Err("Knowledge MCP server already running".into());
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
        let mut info = MCP_INFO.lock().map_err(|e| format!("Lock error: {e}"))?;
        *info = Some(McpInfo { port, shutdown_tx });
    }

    let state = Arc::new(KnowledgeMcpState {
        sessions: RwLock::new(HashMap::new()),
    });

    let app = Router::new()
        .route("/sse", get(handle_sse))
        .route("/message", post(handle_message))
        .with_state(state);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                if let Err(e) = shutdown_rx.wait_for(|&v| v).await {
                    eprintln!("[knowledge-mcp] Shutdown watch error: {e}");
                }
            })
            .await
        {
            eprintln!("[knowledge-mcp] Server error: {e}");
        }
        if let Ok(mut info) = MCP_INFO.lock() {
            *info = None;
        }
    });

    if let Err(e) = register_in_claude_config(port).await {
        eprintln!("[knowledge-mcp] Failed to register in Claude config: {e}");
    }

    eprintln!("[knowledge-mcp] Listening on 127.0.0.1:{port}");
    Ok(port)
}

pub fn stop_server_sync() {
    if let Ok(mut info) = MCP_INFO.lock() {
        if let Some(i) = info.take() {
            if let Err(e) = i.shutdown_tx.send(true) {
                eprintln!("[knowledge-mcp] Failed to send shutdown: {e}");
            }
        }
    }
    if let Err(e) = unregister_from_claude_config_sync() {
        eprintln!("[knowledge-mcp] Failed to unregister from Claude config: {e}");
    }
}

// ---------------------------------------------------------------------------
// SSE handler
// ---------------------------------------------------------------------------

const MAX_SSE_SESSIONS: usize = 50;

async fn handle_sse(State(state): State<Arc<KnowledgeMcpState>>) -> Response {
    {
        let sessions = state.sessions.read().await;
        if sessions.len() >= MAX_SSE_SESSIONS {
            return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel(32);

    state.sessions.write().await.insert(session_id.clone(), tx);

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

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct MessageQuery {
    #[serde(rename = "sessionId")]
    session_id: String,
}

async fn handle_message(
    State(state): State<Arc<KnowledgeMcpState>>,
    Query(query): Query<MessageQuery>,
    Json(msg): Json<Value>,
) -> Response {
    let session_id = query.session_id;
    let method = msg
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let id = msg.get("id").cloned();

    if id.is_none() || method == "notifications/initialized" {
        return axum::http::StatusCode::ACCEPTED.into_response();
    }

    tokio::spawn(async move {
        let response_json = match method.as_str() {
            "initialize" => handle_initialize(id),
            "tools/list" => handle_tools_list(id),
            "tools/call" => handle_tools_call(id, &msg).await,
            _ => jsonrpc_error(id, -32601, &format!("Method not found: {method}")),
        };

        let sessions = state.sessions.read().await;
        if let Some(tx) = sessions.get(&session_id) {
            let response_str = serde_json::to_string(&response_json).unwrap_or_default();
            if let Err(e) = tx.send(response_str).await {
                eprintln!("[knowledge-mcp] Failed to send SSE response: {e}");
            }
        }
    });

    axum::http::StatusCode::ACCEPTED.into_response()
}

// ---------------------------------------------------------------------------
// MCP protocol handlers
// ---------------------------------------------------------------------------

fn handle_initialize(id: Option<Value>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": "aitherflow-knowledge",
                "version": "0.1.0"
            }
        }
    })
}

fn handle_tools_list(id: Option<Value>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "tools": tool_definitions() }
    })
}

async fn handle_tools_call(id: Option<Value>, msg: &Value) -> Value {
    let tool_name = msg
        .pointer("/params/name")
        .and_then(|n| n.as_str())
        .unwrap_or("");
    let args = msg
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or(json!({}));

    match execute_tool(tool_name, &args).await {
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

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

fn validate_uuid(s: &str, label: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(s)
        .map_err(|_| format!("Invalid {label}: '{s}' is not a valid UUID"))?;
    Ok(())
}

async fn execute_tool(name: &str, args: &Value) -> Result<String, String> {
    match name {
        "search_knowledge_base" => tool_search(args).await,
        "list_knowledge_bases" => tool_list_bases().await,
        "get_document_info" => tool_get_documents(args).await,
        "reindex_document" => tool_reindex_document(args).await,
        _ => Err(format!("Unknown tool: {name}")),
    }
}

async fn tool_search(args: &Value) -> Result<String, String> {
    let query = args["query"]
        .as_str()
        .ok_or("Missing 'query' parameter")?;
    let default_limit = rag_settings::load().search_results_limit as u64;
    let limit = (args["limit"].as_u64().unwrap_or(default_limit) as usize).clamp(1, 100);

    // Embed the query
    let q = query.to_string();
    let embeddings = tokio::task::spawn_blocking(move || embedder::embed_texts(&[q]))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    let query_vec = embeddings
        .into_iter()
        .next()
        .ok_or("Failed to embed query")?;

    // Determine which bases to search
    let base_ids: Vec<String> = if let Some(id) = args["base_id"].as_str() {
        validate_uuid(id, "base_id")?;
        vec![id.to_string()]
    } else {
        // Search all bases
        let bases = tokio::task::spawn_blocking(store::list_bases)
            .await
            .map_err(|e| format!("Task join error: {e}"))??;
        bases.into_iter().map(|b| b.id).collect()
    };

    let mut all_results = Vec::new();
    for base_id in &base_ids {
        let raw = index::search(base_id, &query_vec, limit).await?;
        if !raw.is_empty() {
            let enriched = commands::enrich_results(base_id, raw).await?;
            all_results.extend(enriched);
        }
    }

    // Sort by score descending, take top N
    all_results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    all_results.truncate(limit);

    if all_results.is_empty() {
        return Ok("No results found.".into());
    }

    let mut output = String::new();
    for r in &all_results {
        output.push_str(&format!(
            "--- From: {} (score: {:.0}%) ---\n{}\n\n",
            r.document_name,
            r.score * 100.0,
            r.chunk_text
        ));
    }

    Ok(output.trim().to_string())
}

async fn tool_list_bases() -> Result<String, String> {
    let bases = tokio::task::spawn_blocking(store::list_bases)
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    if bases.is_empty() {
        return Ok("No knowledge bases found.".into());
    }

    let mut output = String::new();
    for b in &bases {
        output.push_str(&format!(
            "- {} (id: {}, {} documents)\n",
            b.name, b.id, b.document_count
        ));
    }

    Ok(output.trim().to_string())
}

async fn tool_get_documents(args: &Value) -> Result<String, String> {
    let base_id = args["base_id"]
        .as_str()
        .ok_or("Missing 'base_id' parameter")?;
    validate_uuid(base_id, "base_id")?;
    let base_id = base_id.to_string();

    let docs = tokio::task::spawn_blocking(move || store::list_documents(&base_id))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    if docs.is_empty() {
        return Ok("No documents in this knowledge base.".into());
    }

    let mut output = String::new();
    for d in &docs {
        output.push_str(&format!(
            "- {} (id: {}, {} chunks, {} bytes)\n",
            d.filename, d.id, d.chunk_count, d.size_bytes
        ));
    }

    Ok(output.trim().to_string())
}

async fn tool_reindex_document(args: &Value) -> Result<String, String> {
    let base_id = args["base_id"]
        .as_str()
        .ok_or("Missing 'base_id' parameter")?;
    validate_uuid(base_id, "base_id")?;
    let document_id = args["document_id"]
        .as_str()
        .ok_or("Missing 'document_id' parameter")?;
    validate_uuid(document_id, "document_id")?;
    let chunk_size = (args["chunk_size"].as_u64().unwrap_or(512) as usize).clamp(64, 4096);
    let chunk_overlap = args["chunk_overlap"].as_u64().unwrap_or(64) as usize;
    if chunk_overlap >= chunk_size {
        return Err(format!(
            "chunk_overlap ({chunk_overlap}) must be less than chunk_size ({chunk_size})"
        ));
    }

    // Get document metadata to find its file path
    let bid = base_id.to_string();
    let did = document_id.to_string();
    let doc = tokio::task::spawn_blocking(move || {
        let docs = store::list_documents(&bid)?;
        docs.into_iter()
            .find(|d| d.id == did)
            .ok_or_else(|| format!("Document '{did}' not found"))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    // Web/YouTube sources cannot be reindexed (no local file)
    if doc.path.starts_with("http://") || doc.path.starts_with("https://") {
        return Err(format!(
            "Reindex not supported for web/YouTube sources: {}. Remove and re-add the document instead.",
            doc.filename
        ));
    }

    // Remove old chunks from index
    index::remove_document_chunks(base_id, document_id).await?;

    // Re-parse the file
    let file_path = doc.path.clone();
    let (texts, new_chunk_count) = tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&file_path);
        let parsed = parser::parse_file(path)?;
        let chunks = chunker::split_text_with_params(
            &parsed.text,
            parsed.is_markdown,
            chunk_size,
            chunk_overlap,
        )?;
        let texts: Vec<String> = chunks.into_iter().map(|c| c.text).collect();
        let count = texts.len();
        Ok::<_, String>((texts, count))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    if texts.is_empty() {
        return Err("No content after re-chunking".into());
    }

    // Re-embed
    let texts_for_embed = texts.clone();
    let embeddings = tokio::task::spawn_blocking(move || embedder::embed_texts(&texts_for_embed))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    // Re-index
    index::add_chunks(base_id, document_id, &texts, &embeddings).await?;

    // Update chunk count in metadata
    let bid = base_id.to_string();
    let did = document_id.to_string();
    tokio::task::spawn_blocking(move || {
        let mut meta = store::get_base(&bid)?;
        if let Some(doc) = meta.documents.iter_mut().find(|d| d.id == did) {
            doc.chunk_count = new_chunk_count;
        }
        crate::file_ops::write_json(
            &super::config::base_meta_path(&bid),
            &meta,
        )
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    Ok(format!(
        "Document '{}' reindexed: {} chunks (size={}, overlap={})",
        doc.filename, new_chunk_count, chunk_size, chunk_overlap
    ))
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

fn tool_definitions() -> Value {
    json!([
        {
            "name": "search_knowledge_base",
            "description": "Search knowledge bases for relevant information. Returns text chunks from indexed documents ranked by semantic similarity. Use this to find answers in uploaded documents, web pages, or YouTube transcripts.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query — formulate in the same language as the documents for best results"
                    },
                    "base_id": {
                        "type": "string",
                        "description": "Optional: search only this knowledge base. If omitted, searches all bases."
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum number of results (default: 10)"
                    }
                },
                "required": ["query"]
            }
        },
        {
            "name": "list_knowledge_bases",
            "description": "List all available knowledge bases with their document counts.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "get_document_info",
            "description": "Get the list of documents in a knowledge base (name, chunks, size).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "base_id": {
                        "type": "string",
                        "description": "Knowledge base ID"
                    }
                },
                "required": ["base_id"]
            }
        },
        {
            "name": "reindex_document",
            "description": "Re-index a single document with different chunk parameters. Use when search results are too short/long or missing context.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "base_id": {
                        "type": "string",
                        "description": "Knowledge base ID"
                    },
                    "document_id": {
                        "type": "string",
                        "description": "Document ID to reindex"
                    },
                    "chunk_size": {
                        "type": "number",
                        "description": "Token count per chunk (default: 512)"
                    },
                    "chunk_overlap": {
                        "type": "number",
                        "description": "Overlap between chunks (default: 64)"
                    }
                },
                "required": ["base_id", "document_id"]
            }
        }
    ])
}

// ---------------------------------------------------------------------------
// Claude CLI config registration
// ---------------------------------------------------------------------------

const MCP_SERVER_NAME: &str = "aitherflow-knowledge";

async fn register_in_claude_config(port: u16) -> Result<(), String> {
    tokio::task::spawn_blocking(move || register_in_claude_config_sync(port))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

fn register_in_claude_config_sync(port: u16) -> Result<(), String> {
    let path = crate::config::home_dir().join(".claude.json");
    let mut root = if path.exists() {
        crate::file_ops::read_json::<Value>(&path).map_err(|e| {
            format!("Failed to parse {}: {e} — not overwriting", path.display())
        })?
    } else {
        json!({})
    };

    let servers = root
        .as_object_mut()
        .ok_or("Invalid .claude.json format")?
        .entry("mcpServers")
        .or_insert(json!({}));

    servers[MCP_SERVER_NAME] = json!({
        "type": "sse",
        "url": format!("http://127.0.0.1:{port}/sse")
    });

    let data = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("Failed to serialize: {e}"))?;
    crate::file_ops::atomic_write(&path, data.as_bytes())
}

fn unregister_from_claude_config_sync() -> Result<(), String> {
    let path = crate::config::home_dir().join(".claude.json");
    if !path.exists() {
        return Ok(());
    }

    let mut root = crate::file_ops::read_json::<Value>(&path).map_err(|e| {
        format!("Failed to parse {}: {e} — not overwriting", path.display())
    })?;

    if let Some(servers) = root.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
        servers.remove(MCP_SERVER_NAME);
    }

    let data = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("Failed to serialize: {e}"))?;
    crate::file_ops::atomic_write(&path, data.as_bytes())
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

fn jsonrpc_error(id: Option<Value>, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}
