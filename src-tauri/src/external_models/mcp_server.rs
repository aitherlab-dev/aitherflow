//! External Models MCP server — call external AI models (OpenRouter, Google, Ollama).

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;

use crate::mcp_transport::{self, McpServerInfo, McpState, McpToolHandler};
use super::client;
use super::config;
use super::types::{
    ChatMessage, ContentPart, ImageUrlData, MessageContent, Provider, Role,
};
use super::vision;

// ── State ──

static MCP_INFO: Mutex<Option<McpServerInfo>> = Mutex::new(None);

struct ModelsMcpState {
    auth_token: String,
    sessions: RwLock<HashMap<String, tokio::sync::mpsc::Sender<String>>>,
}

impl McpState for ModelsMcpState {
    fn sessions(&self) -> &RwLock<HashMap<String, tokio::sync::mpsc::Sender<String>>> {
        &self.sessions
    }
    fn auth_token(&self) -> &str {
        &self.auth_token
    }
}

struct ModelsToolHandler;

#[axum::async_trait]
impl McpToolHandler for ModelsToolHandler {
    fn server_name(&self) -> &str { "aitherflow-models" }
    fn tool_definitions(&self) -> Value { tool_definitions() }
    fn max_sessions(&self) -> usize { 100 }
    async fn execute_tool(&self, name: &str, args: &Value) -> Result<String, String> {
        execute_tool(name, args).await
    }
}

// ── Public API ──

pub fn get_port() -> Option<u16> {
    mcp_transport::get_port(&MCP_INFO)
}

pub fn get_token() -> Option<String> {
    mcp_transport::get_token(&MCP_INFO)
}

pub async fn start_server() -> Result<u16, String> {
    let auth_token = uuid::Uuid::new_v4().to_string();
    let state = Arc::new(ModelsMcpState {
        auth_token,
        sessions: RwLock::new(HashMap::new()),
    });
    let handler = Arc::new(ModelsToolHandler);
    mcp_transport::start_sse_server("ext-models-mcp", &MCP_INFO, state, handler).await
}

pub fn is_running() -> bool {
    get_port().is_some()
}

pub async fn stop_server() -> Result<(), String> {
    let shutdown_tx = {
        let mut info = MCP_INFO.lock().map_err(|e| format!("Lock error: {e}"))?;
        match info.take() {
            Some(i) => i.shutdown_tx,
            None => return Err("MCP server is not running".into()),
        }
    };
    shutdown_tx.send(true).map_err(|e| format!("Failed to send shutdown: {e}"))?;
    eprintln!("[ext-models-mcp] Server stopped");
    Ok(())
}

pub fn stop_server_sync() {
    mcp_transport::stop_server_sync("ext-models-mcp", &MCP_INFO);
}

// ── Tool execution ──

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
    let model = args["model"].as_str().ok_or("Missing 'model' parameter")?;
    let prompt = args["prompt"].as_str().ok_or("Missing 'prompt' parameter")?;
    let system_prompt = args["system_prompt"].as_str();
    let max_tokens = args["max_tokens"].as_u64().map(|n| n as u32);

    let ctx = get_provider_context(&provider).await?;

    let mut messages = Vec::new();
    if let Some(sys) = system_prompt {
        messages.push(ChatMessage { role: Role::System, content: MessageContent::Text(sys.to_string()) });
    }
    messages.push(ChatMessage { role: Role::User, content: MessageContent::Text(prompt.to_string()) });

    let response = client::call_model(&provider, &ctx.api_key, model, messages, max_tokens, ctx.base_url.as_deref()).await?;
    let text = response.choices.first().and_then(|c| c.message.content.as_ref()).cloned().unwrap_or_default();
    Ok(text)
}

async fn tool_call_vision(args: &Value) -> Result<String, String> {
    let provider = parse_provider(args)?;
    let model = args["model"].as_str().ok_or("Missing 'model' parameter")?;
    let prompt = args["prompt"].as_str().ok_or("Missing 'prompt' parameter")?;
    let file_paths = args["file_paths"].as_array().ok_or("Missing 'file_paths' parameter")?;
    let max_tokens = args["max_tokens"].as_u64().map(|n| n as u32);

    if file_paths.is_empty() {
        return Err("file_paths must not be empty".into());
    }

    let paths: Vec<String> = file_paths.iter().filter_map(|p| p.as_str().map(String::from)).collect();
    let profile = parse_vision_profile_with_config(args).await;
    let strategy = vision::resolve_strategy(&profile, model);

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
                                image_url: ImageUrlData { url: format!("data:image/jpeg;base64,{}", frame.base64) },
                            });
                        }
                    }
                }
            } else {
                let frames = vision::extract_frames(path, &profile, None).await?;
                for frame in frames {
                    all_parts.push(ContentPart::ImageUrl {
                        image_url: ImageUrlData { url: format!("data:image/jpeg;base64,{}", frame.base64) },
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
    all_parts.push(ContentPart::Text { text: prompt.to_string() });
    let messages = vec![ChatMessage { role: Role::User, content: MessageContent::Parts(all_parts) }];
    let response = client::call_model(&provider, &ctx.api_key, model, messages, max_tokens, ctx.base_url.as_deref()).await?;
    let text = response.choices.first().and_then(|c| c.message.content.as_ref()).cloned().unwrap_or_default();
    Ok(text)
}

async fn tool_analyze_directory(args: &Value) -> Result<String, String> {
    let provider = parse_provider(args)?;
    let model = args["model"].as_str().ok_or("Missing 'model' parameter")?;
    let prompt = args["prompt"].as_str().ok_or("Missing 'prompt' parameter")?;
    let directory = args["directory"].as_str().ok_or("Missing 'directory' parameter")?;
    let max_tokens = args["max_tokens"].as_u64().map(|n| n as u32);
    let profile = parse_vision_profile_with_config(args).await;

    let results = vision::analyze_directory(directory, &profile, &provider, model, prompt, max_tokens).await?;
    serde_json::to_string_pretty(&results).map_err(|e| format!("Serialize error: {e}"))
}

async fn tool_list_models(args: &Value) -> Result<String, String> {
    let provider = parse_provider(args)?;
    let ctx = get_provider_context(&provider).await?;
    let models = client::list_models(&provider, &ctx.api_key, ctx.base_url.as_deref()).await?;
    serde_json::to_string_pretty(&models).map_err(|e| format!("Serialize error: {e}"))
}

// ── Helpers ──

fn parse_provider(args: &Value) -> Result<Provider, String> {
    let s = args["provider"].as_str().ok_or("Missing 'provider' parameter")?;
    match s {
        "openrouter" => Ok(Provider::OpenRouter),
        "google" => Ok(Provider::Google),
        "ollama" => Ok(Provider::Ollama),
        _ => Err(format!("Unknown provider: {s}. Use 'openrouter', 'google', or 'ollama'")),
    }
}

async fn parse_vision_profile_with_config(args: &Value) -> vision::VisionProfile {
    if let Some(profile) = args.get("profile").and_then(|v| serde_json::from_value(v.clone()).ok()) {
        return profile;
    }
    tokio::task::spawn_blocking(|| {
        config::load_config().ok().and_then(|c| c.vision_profile).unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

struct ProviderContext {
    api_key: String,
    base_url: Option<String>,
}

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
        let base_url = config::load_config().ok().and_then(|c| {
            c.providers.iter().find(|p| p.provider == provider).and_then(|p| p.base_url.clone())
        });
        Ok(ProviderContext { api_key, base_url })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

const MAX_IMAGE_SIZE: u64 = 20 * 1024 * 1024; // 20 MB

pub fn encode_image_file(path: &str) -> Result<ContentPart, String> {
    let p = Path::new(path);
    crate::files::validate_path_safe(p)?;

    let meta = std::fs::metadata(p).map_err(|e| format!("Cannot read {path}: {e}"))?;
    if meta.len() > MAX_IMAGE_SIZE {
        return Err(format!("File too large: {} ({} bytes, max {})", path, meta.len(), MAX_IMAGE_SIZE));
    }

    let data = std::fs::read(p).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let mime = match p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => return Err(format!("Unsupported image format: {path}")),
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(ContentPart::ImageUrl { image_url: ImageUrlData { url: format!("data:{mime};base64,{b64}") } })
}

// ── Tool definitions ──

fn tool_definitions() -> Value {
    json!([
        {
            "name": "call_model",
            "description": "Call an external AI model (OpenRouter/Google Gemini) with a prompt. Use this to get responses from models like GPT-4o, Gemini, Llama, etc.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "provider": { "type": "string", "enum": ["openrouter", "google", "ollama"], "description": "The model provider to use" },
                    "model": { "type": "string", "description": "Model ID (e.g. 'openai/gpt-4o', 'llama-3.1-70b-versatile')" },
                    "prompt": { "type": "string", "description": "The prompt text to send to the model" },
                    "system_prompt": { "type": "string", "description": "Optional system prompt to set context" },
                    "max_tokens": { "type": "number", "description": "Maximum tokens in response (optional, model default if omitted)" }
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
                    "provider": { "type": "string", "enum": ["openrouter", "google", "ollama"], "description": "The model provider to use" },
                    "model": { "type": "string", "description": "Vision-capable model ID (e.g. 'openai/gpt-4o', 'google/gemini-2.0-flash-001')" },
                    "prompt": { "type": "string", "description": "What to analyze or look for in the images/video" },
                    "file_paths": { "type": "array", "items": { "type": "string" }, "description": "Absolute paths to image or video files" },
                    "profile": {
                        "type": "object", "description": "Video processing profile (optional, defaults used if omitted)",
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
                    "max_tokens": { "type": "number", "description": "Maximum tokens in response (optional, model default if omitted)" }
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
                    "provider": { "type": "string", "enum": ["openrouter", "google", "ollama"], "description": "The model provider to use" },
                    "model": { "type": "string", "description": "Vision-capable model ID" },
                    "prompt": { "type": "string", "description": "What to analyze or look for in each file" },
                    "directory": { "type": "string", "description": "Absolute path to the directory containing video/image files" },
                    "profile": {
                        "type": "object", "description": "Video processing profile (optional)",
                        "properties": {
                            "strategy": { "type": "string", "enum": ["auto", "native_video", "extract_frames"], "description": "Video processing strategy" },
                            "framesPerClip": { "type": "number", "description": "Extract exactly N frames evenly spaced (default: 5)" },
                            "fps": { "type": "number", "description": "Frames per second (alternative to framesPerClip)" },
                            "sceneDetection": { "type": "boolean", "description": "Use ffmpeg scene detection" },
                            "sceneThreshold": { "type": "number", "description": "Scene change threshold 0.0-1.0 (default: 0.3)" },
                            "resolution": { "type": "number", "description": "Frame width in pixels (default: 720)" },
                            "jpegQuality": { "type": "number", "description": "JPEG quality 2-31, lower=better (default: 5)" }
                        }
                    },
                    "max_tokens": { "type": "number", "description": "Maximum tokens per file analysis (optional)" }
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
                    "provider": { "type": "string", "enum": ["openrouter", "google", "ollama"], "description": "The provider to list models for" }
                },
                "required": ["provider"]
            }
        }
    ])
}
