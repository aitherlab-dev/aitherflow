use axum::extract::{Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use futures_util::stream::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::{mpsc, RwLock};

use super::client;
use super::config;
use super::types::{
    ChatMessage, ContentPart, ImageUrlData, MessageContent, Provider, Role,
};
use super::vision;

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

// NOTE: std::sync::Mutex intentional — lock held briefly, no .await inside
static MCP_INFO: Mutex<Option<McpInfo>> = Mutex::new(None);

struct McpInfo {
    port: u16,
    shutdown_tx: tokio::sync::watch::Sender<bool>,
}

struct ModelsMcpState {
    sessions: RwLock<HashMap<String, mpsc::Sender<String>>>,
}

// ---------------------------------------------------------------------------
// SSE stream
// ---------------------------------------------------------------------------

struct McpSseStream {
    rx: mpsc::Receiver<String>,
    initial_event: Option<String>,
    session_id: String,
    state: Arc<ModelsMcpState>,
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

/// Get the MCP server port, or None if not running.
pub fn get_port() -> Option<u16> {
    MCP_INFO.lock().ok().and_then(|info| info.as_ref().map(|i| i.port))
}

/// Check if the MCP server is running.
pub fn is_running() -> bool {
    get_port().is_some()
}

/// Start the external models MCP server on a random free port.
pub async fn start_server() -> Result<u16, String> {
    {
        let info = MCP_INFO.lock().map_err(|e| format!("Lock error: {e}"))?;
        if info.is_some() {
            return Err("External models MCP server already running".into());
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
        *info = Some(McpInfo {
            port,
            shutdown_tx,
        });
    }

    let state = Arc::new(ModelsMcpState {
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
                    eprintln!("[ext-models-mcp] Shutdown watch error: {e}");
                }
            })
            .await
        {
            eprintln!("[ext-models-mcp] Server error: {e}");
        }
        // Clear state on shutdown
        if let Ok(mut info) = MCP_INFO.lock() {
            *info = None;
        }
    });

    // Register in Claude CLI config
    if let Err(e) = register_in_claude_config(port).await {
        eprintln!("[ext-models-mcp] Failed to register in Claude config: {e}");
    }

    eprintln!("[ext-models-mcp] Listening on 127.0.0.1:{port}");
    Ok(port)
}

/// Stop the external models MCP server.
pub async fn stop_server() -> Result<(), String> {
    let shutdown_tx = {
        let mut info = MCP_INFO.lock().map_err(|e| format!("Lock error: {e}"))?;
        match info.take() {
            Some(i) => i.shutdown_tx,
            None => return Err("MCP server is not running".into()),
        }
    };

    shutdown_tx
        .send(true)
        .map_err(|e| format!("Failed to send shutdown: {e}"))?;

    // Unregister from Claude config
    if let Err(e) = unregister_from_claude_config().await {
        eprintln!("[ext-models-mcp] Failed to unregister from Claude config: {e}");
    }

    eprintln!("[ext-models-mcp] Server stopped");
    Ok(())
}

/// Synchronous shutdown for use in app exit handler.
pub fn stop_server_sync() {
    if let Ok(mut info) = MCP_INFO.lock() {
        if let Some(i) = info.take() {
            if let Err(e) = i.shutdown_tx.send(true) {
                eprintln!("[ext-models-mcp] Failed to send shutdown: {e}");
            }
        }
    }
    if let Err(e) = unregister_from_claude_config_sync() {
        eprintln!("[ext-models-mcp] Failed to unregister from Claude config: {e}");
    }
}

// ---------------------------------------------------------------------------
// SSE handler
// ---------------------------------------------------------------------------

const MAX_SSE_SESSIONS: usize = 100;

async fn handle_sse(
    State(state): State<Arc<ModelsMcpState>>,
) -> Response {
    {
        let sessions = state.sessions.read().await;
        if sessions.len() >= MAX_SSE_SESSIONS {
            return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel(32);

    state
        .sessions
        .write()
        .await
        .insert(session_id.clone(), tx);

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
    State(state): State<Arc<ModelsMcpState>>,
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

    // Notifications — no response needed
    if id.is_none() || method == "notifications/initialized" {
        return axum::http::StatusCode::ACCEPTED.into_response();
    }

    // Spawn processing and return 202 immediately (SSE transport)
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
                eprintln!("[ext-models-mcp] Failed to send SSE response: {e}");
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
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "aitherflow-models",
                "version": "0.1.0"
            }
        }
    })
}

fn handle_tools_list(id: Option<Value>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "tools": tool_definitions()
        }
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

async fn execute_tool(name: &str, args: &Value) -> Result<String, String> {
    match name {
        "call_model" => tool_call_model(args).await,
        "call_vision" => tool_call_vision(args).await,
        "list_models" => tool_list_models(args).await,
        "analyze_directory" => tool_analyze_directory(args).await,
        _ => Err(format!("Unknown tool: {name}")),
    }
}

async fn tool_call_model(args: &Value) -> Result<String, String> {
    let provider = parse_provider(args)?;
    let model = args["model"]
        .as_str()
        .ok_or("Missing 'model' parameter")?;
    let prompt = args["prompt"]
        .as_str()
        .ok_or("Missing 'prompt' parameter")?;
    let system_prompt = args["system_prompt"].as_str();
    let max_tokens = args["max_tokens"].as_u64().map(|n| n as u32);

    let ctx = get_provider_context(&provider).await?;

    let mut messages = Vec::new();
    if let Some(sys) = system_prompt {
        messages.push(ChatMessage {
            role: Role::System,
            content: MessageContent::Text(sys.to_string()),
        });
    }
    messages.push(ChatMessage {
        role: Role::User,
        content: MessageContent::Text(prompt.to_string()),
    });

    let response = client::call_model(&provider, &ctx.api_key, model, messages, max_tokens, ctx.base_url.as_deref()).await?;

    let text = response
        .choices
        .first()
        .and_then(|c| c.message.content.as_ref())
        .cloned()
        .unwrap_or_default();

    Ok(text)
}

async fn tool_call_vision(args: &Value) -> Result<String, String> {
    let provider = parse_provider(args)?;
    let model = args["model"]
        .as_str()
        .ok_or("Missing 'model' parameter")?;
    let prompt = args["prompt"]
        .as_str()
        .ok_or("Missing 'prompt' parameter")?;
    let file_paths = args["file_paths"]
        .as_array()
        .ok_or("Missing 'file_paths' parameter")?;
    let max_tokens = args["max_tokens"].as_u64().map(|n| n as u32);

    if file_paths.is_empty() {
        return Err("file_paths must not be empty".into());
    }

    let paths: Vec<String> = file_paths
        .iter()
        .filter_map(|p| p.as_str().map(String::from))
        .collect();

    let profile = parse_vision_profile_with_config(args).await;
    let strategy = vision::resolve_strategy(&profile, model);

    // Process each file based on strategy
    let mut all_parts = Vec::new();
    for path in &paths {
        if vision::is_video_file(path) {
            if strategy == vision::VisionStrategy::NativeVideo {
                let p = path.clone();
                match tokio::task::spawn_blocking(move || vision::encode_video_native(&p))
                    .await
                    .map_err(|e| format!("Task join error: {e}"))?
                {
                    Ok(part) => all_parts.push(part),
                    Err(e) => {
                        eprintln!("[ext-models-mcp] Native video failed, falling back to frames: {e}");
                        let frames = vision::extract_frames(path, &profile, None).await?;
                        for frame in frames {
                            all_parts.push(ContentPart::ImageUrl {
                                image_url: ImageUrlData {
                                    url: format!("data:image/jpeg;base64,{}", frame.base64),
                                },
                            });
                        }
                    }
                }
            } else {
                let frames = vision::extract_frames(path, &profile, None).await?;
                for frame in frames {
                    all_parts.push(ContentPart::ImageUrl {
                        image_url: ImageUrlData {
                            url: format!("data:image/jpeg;base64,{}", frame.base64),
                        },
                    });
                }
            }
        } else {
            let p = path.clone();
            let part = tokio::task::spawn_blocking(move || encode_image_file(&p))
                .await
                .map_err(|e| format!("Task join error: {e}"))??;
            all_parts.push(part);
        }
    }

    if all_parts.is_empty() {
        return Err("No frames or images could be extracted".into());
    }

    let ctx = get_provider_context(&provider).await?;

    // Build multimodal message: images/frames first, then text prompt
    all_parts.push(ContentPart::Text {
        text: prompt.to_string(),
    });

    let messages = vec![ChatMessage {
        role: Role::User,
        content: MessageContent::Parts(all_parts),
    }];

    let response = client::call_model(&provider, &ctx.api_key, model, messages, max_tokens, ctx.base_url.as_deref()).await?;

    let text = response
        .choices
        .first()
        .and_then(|c| c.message.content.as_ref())
        .cloned()
        .unwrap_or_default();

    Ok(text)
}

async fn tool_analyze_directory(args: &Value) -> Result<String, String> {
    let provider = parse_provider(args)?;
    let model = args["model"]
        .as_str()
        .ok_or("Missing 'model' parameter")?;
    let prompt = args["prompt"]
        .as_str()
        .ok_or("Missing 'prompt' parameter")?;
    let directory = args["directory"]
        .as_str()
        .ok_or("Missing 'directory' parameter")?;
    let max_tokens = args["max_tokens"].as_u64().map(|n| n as u32);
    let profile = parse_vision_profile_with_config(args).await;

    let results = vision::analyze_directory(
        directory, &profile, &provider, model, prompt, max_tokens,
    )
    .await?;

    serde_json::to_string_pretty(&results).map_err(|e| format!("Serialize error: {e}"))
}

async fn tool_list_models(args: &Value) -> Result<String, String> {
    let provider = parse_provider(args)?;
    let ctx = get_provider_context(&provider).await?;
    let models = client::list_models(&provider, &ctx.api_key, ctx.base_url.as_deref()).await?;
    serde_json::to_string_pretty(&models).map_err(|e| format!("Serialize error: {e}"))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_provider(args: &Value) -> Result<Provider, String> {
    let s = args["provider"]
        .as_str()
        .ok_or("Missing 'provider' parameter")?;
    match s {
        "openrouter" => Ok(Provider::OpenRouter),
        "groq" => Ok(Provider::Groq),
        "ollama" => Ok(Provider::Ollama),
        _ => Err(format!(
            "Unknown provider: {s}. Use 'openrouter', 'groq', or 'ollama'"
        )),
    }
}

/// Parse VisionProfile from args. If not provided, load from saved config.
/// Falls back to default if neither is available.
async fn parse_vision_profile_with_config(args: &Value) -> vision::VisionProfile {
    if let Some(profile) = args
        .get("profile")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
    {
        return profile;
    }

    // Try loading saved profile from config
    tokio::task::spawn_blocking(|| {
        config::load_config()
            .ok()
            .and_then(|c| c.vision_profile)
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Provider credentials: API key + optional custom base URL.
struct ProviderContext {
    api_key: String,
    base_url: Option<String>,
}

/// Load API key and base_url for a provider in a single blocking config read.
async fn get_provider_context(provider: &Provider) -> Result<ProviderContext, String> {
    let provider = provider.clone();
    tokio::task::spawn_blocking(move || {
        let api_key = if provider.requires_api_key() {
            config::get_api_key(&provider).ok_or_else(|| {
                format!("No API key configured for {}", provider.display_name())
            })?
        } else {
            String::new()
        };

        let base_url = config::load_config()
            .ok()
            .and_then(|c| {
                c.providers
                    .iter()
                    .find(|p| p.provider == provider)
                    .and_then(|p| p.base_url.clone())
            });

        Ok(ProviderContext { api_key, base_url })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

const MAX_IMAGE_SIZE: u64 = 20 * 1024 * 1024; // 20 MB

/// Read an image file and encode it as a base64 data URL content part.
/// Blocking I/O — must be called from spawn_blocking.
pub fn encode_image_file(path: &str) -> Result<ContentPart, String> {
    let p = Path::new(path);
    crate::files::validate_path_safe(p)?;

    let meta = std::fs::metadata(p)
        .map_err(|e| format!("Cannot read {path}: {e}"))?;
    if meta.len() > MAX_IMAGE_SIZE {
        return Err(format!(
            "File too large: {} ({} bytes, max {})",
            path,
            meta.len(),
            MAX_IMAGE_SIZE
        ));
    }

    let data = std::fs::read(p).map_err(|e| format!("Failed to read {path}: {e}"))?;

    let mime = match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => return Err(format!("Unsupported image format: {path}")),
    };

    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);

    Ok(ContentPart::ImageUrl {
        image_url: ImageUrlData {
            url: format!("data:{mime};base64,{b64}"),
        },
    })
}

// ---------------------------------------------------------------------------
// Claude CLI config registration
// ---------------------------------------------------------------------------

const MCP_SERVER_NAME: &str = "aitherflow-models";

async fn register_in_claude_config(port: u16) -> Result<(), String> {
    tokio::task::spawn_blocking(move || register_in_claude_config_sync(port))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

// NOTE: read-modify-write without file lock — known limitation.
// Low risk in practice: MCP start/stop are rare, single-instance operations.
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

async fn unregister_from_claude_config() -> Result<(), String> {
    tokio::task::spawn_blocking(unregister_from_claude_config_sync)
        .await
        .map_err(|e| format!("Task join error: {e}"))?
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
// Tool definitions
// ---------------------------------------------------------------------------

fn tool_definitions() -> Value {
    json!([
        {
            "name": "call_model",
            "description": "Call an external AI model (OpenRouter/Groq) with a prompt. Use this to get responses from models like GPT-4o, Llama, Gemini, Mixtral, etc.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "provider": {
                        "type": "string",
                        "enum": ["openrouter", "groq", "ollama"],
                        "description": "The model provider to use"
                    },
                    "model": {
                        "type": "string",
                        "description": "Model ID (e.g. 'openai/gpt-4o', 'llama-3.1-70b-versatile')"
                    },
                    "prompt": {
                        "type": "string",
                        "description": "The prompt text to send to the model"
                    },
                    "system_prompt": {
                        "type": "string",
                        "description": "Optional system prompt to set context"
                    },
                    "max_tokens": {
                        "type": "number",
                        "description": "Maximum tokens in response (optional, model default if omitted)"
                    }
                },
                "required": ["provider", "model", "prompt"]
            }
        },
        {
            "name": "call_vision",
            "description": "Analyze images or video files using a vision-capable model. Images are encoded directly; video files have frames extracted via ffmpeg. Supports PNG, JPG, GIF, WebP, BMP images and MP4, MOV, AVI, MKV, MTS, MXF, R3D, WebM video.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "provider": {
                        "type": "string",
                        "enum": ["openrouter", "groq", "ollama"],
                        "description": "The model provider to use"
                    },
                    "model": {
                        "type": "string",
                        "description": "Vision-capable model ID (e.g. 'openai/gpt-4o', 'google/gemini-2.0-flash-001')"
                    },
                    "prompt": {
                        "type": "string",
                        "description": "What to analyze or look for in the images/video"
                    },
                    "file_paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Absolute paths to image or video files"
                    },
                    "profile": {
                        "type": "object",
                        "description": "Video processing profile (optional, defaults used if omitted)",
                        "properties": {
                            "strategy": { "type": "string", "enum": ["auto", "native_video", "extract_frames"], "description": "Video processing strategy. Auto sends native video to Gemini, extracts frames for others (default: auto)" },
                            "framesPerClip": { "type": "number", "description": "Extract exactly N frames evenly spaced (default: 5)" },
                            "fps": { "type": "number", "description": "Frames per second (alternative to framesPerClip)" },
                            "sceneDetection": { "type": "boolean", "description": "Use ffmpeg scene detection" },
                            "sceneThreshold": { "type": "number", "description": "Scene change threshold 0.0-1.0 (default: 0.3)" },
                            "resolution": { "type": "number", "description": "Frame width in pixels (default: 720)" },
                            "jpegQuality": { "type": "number", "description": "JPEG quality 2-31, lower=better (default: 5)" }
                        }
                    },
                    "max_tokens": {
                        "type": "number",
                        "description": "Maximum tokens in response (optional, model default if omitted)"
                    }
                },
                "required": ["provider", "model", "prompt", "file_paths"]
            }
        },
        {
            "name": "analyze_directory",
            "description": "Analyze all video and image files in a directory using a vision model. Processes files sequentially, extracts frames from videos via ffmpeg, and returns per-file analysis.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "provider": {
                        "type": "string",
                        "enum": ["openrouter", "groq", "ollama"],
                        "description": "The model provider to use"
                    },
                    "model": {
                        "type": "string",
                        "description": "Vision-capable model ID"
                    },
                    "prompt": {
                        "type": "string",
                        "description": "What to analyze or look for in each file"
                    },
                    "directory": {
                        "type": "string",
                        "description": "Absolute path to the directory containing video/image files"
                    },
                    "profile": {
                        "type": "object",
                        "description": "Video processing profile (optional)",
                        "properties": {
                            "strategy": { "type": "string", "enum": ["auto", "native_video", "extract_frames"] },
                            "framesPerClip": { "type": "number" },
                            "fps": { "type": "number" },
                            "sceneDetection": { "type": "boolean" },
                            "sceneThreshold": { "type": "number" },
                            "resolution": { "type": "number" },
                            "jpegQuality": { "type": "number" }
                        }
                    },
                    "max_tokens": {
                        "type": "number",
                        "description": "Maximum tokens per file analysis (optional)"
                    }
                },
                "required": ["provider", "model", "prompt", "directory"]
            }
        },
        {
            "name": "list_models",
            "description": "List available models from a provider. Returns model IDs, names, and context lengths.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "provider": {
                        "type": "string",
                        "enum": ["openrouter", "groq", "ollama"],
                        "description": "The provider to list models for"
                    }
                },
                "required": ["provider"]
            }
        }
    ])
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

fn jsonrpc_error(id: Option<Value>, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    })
}
