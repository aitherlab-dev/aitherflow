use futures_util::StreamExt;
use reqwest::Client;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Emitter;

use super::types::{
    ApiErrorResponse, ChatRequest, ChatResponse, ModelInfo, ModelsResponse, OllamaTagsResponse,
    ProviderConfig,
};

const TIMEOUT_SECS: u64 = 120;
const APP_TITLE: &str = "Aitherflow";
const APP_URL: &str = "https://github.com/aitherlab-dev/aitherflow";

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

/// Get or create the shared reqwest client.
fn get_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(TIMEOUT_SECS))
            .build()
            .expect("Failed to build HTTP client — TLS backend unavailable")
    })
}

/// Parse API error response body into a human-readable message
fn parse_api_error(provider_name: &str, status: u16, body: &str) -> String {
    let msg = serde_json::from_str::<ApiErrorResponse>(body)
        .ok()
        .and_then(|r| r.error)
        .map(|e| e.message)
        .unwrap_or_else(|| body.to_string());
    format!("{provider_name} API error ({status}): {msg}")
}

/// Add provider-specific headers to a request
fn add_provider_headers(
    mut req: reqwest::RequestBuilder,
    pc: &ProviderConfig,
    api_key: &str,
) -> reqwest::RequestBuilder {
    if pc.requires_api_key {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }
    // OpenRouter-specific headers
    if pc.id == "openrouter" {
        req = req
            .header("HTTP-Referer", APP_URL)
            .header("X-Title", APP_TITLE);
    }
    req
}

/// Format connection error message
fn format_connection_error(pc: &ProviderConfig, e: &reqwest::Error) -> String {
    if e.is_timeout() {
        format!("{}: request timed out after {TIMEOUT_SECS}s", pc.name)
    } else if e.is_connect() {
        if pc.is_ollama() {
            format!("{} not running — connection refused. Start it first.", pc.name)
        } else {
            format!("{}: connection failed — check your network", pc.name)
        }
    } else {
        format!("{}: request failed: {e}", pc.name)
    }
}

/// Call a chat completions model via OpenAI-compatible API.
pub async fn call_model(
    pc: &ProviderConfig,
    api_key: &str,
    model: &str,
    messages: Vec<super::types::ChatMessage>,
    max_tokens: Option<u32>,
) -> Result<ChatResponse, String> {
    let client = get_client();
    let base = pc.effective_base_url();
    let url = format!("{base}/chat/completions");

    let request = ChatRequest {
        model: model.to_string(),
        messages,
        max_tokens,
        temperature: None,
    };

    let req = client.post(&url).json(&request);
    let req = add_provider_headers(req, pc, api_key);

    let response = req.send().await.map_err(|e| format_connection_error(pc, &e))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(parse_api_error(&pc.name, status.as_u16(), &body));
    }

    response
        .json::<ChatResponse>()
        .await
        .map_err(|e| format!("{}: failed to parse response: {e}", pc.name))
}

/// List available models from the provider.
/// Ollama uses /api/tags instead of /v1/models.
pub async fn list_models(
    pc: &ProviderConfig,
    api_key: &str,
) -> Result<Vec<ModelInfo>, String> {
    if pc.is_ollama() {
        return list_ollama_models(pc).await;
    }

    let client = get_client();
    let base = pc.effective_base_url();
    let url = format!("{base}/models");

    let req = client.get(&url);
    let req = add_provider_headers(req, pc, api_key);

    let response = req.send().await.map_err(|e| {
        format!("{}: failed to fetch models: {e}", pc.name)
    })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(parse_api_error(&pc.name, status.as_u16(), &body));
    }

    let mut models_resp = response
        .json::<ModelsResponse>()
        .await
        .map_err(|e| format!("{}: failed to parse models list: {e}", pc.name))?;

    // Google Gemini returns model IDs with "models/" prefix — strip it
    if pc.id == "google" {
        for model in &mut models_resp.data {
            if let Some(stripped) = model.id.strip_prefix("models/") {
                model.id = stripped.to_string();
            }
        }
    }

    Ok(models_resp.data)
}

/// List models from Ollama via /api/tags endpoint.
async fn list_ollama_models(
    pc: &ProviderConfig,
) -> Result<Vec<ModelInfo>, String> {
    let client = get_client();
    let server = pc.ollama_server_url();
    let url = format!("{server}/api/tags");

    let response = client.get(&url).send().await.map_err(|e| {
        if e.is_connect() {
            format!("{} not running — connection refused. Start it first.", pc.name)
        } else {
            format!("{}: failed to fetch models: {e}", pc.name)
        }
    })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("{} API error ({status}): {body}", pc.name));
    }

    let tags = response
        .json::<OllamaTagsResponse>()
        .await
        .map_err(|e| format!("{}: failed to parse models: {e}", pc.name))?;

    Ok(tags
        .models
        .into_iter()
        .map(|m| ModelInfo {
            id: m.name.clone(),
            name: Some(m.name),
            context_length: None,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/// Chat request with streaming enabled
#[derive(serde::Serialize)]
struct StreamChatRequest {
    model: String,
    messages: Vec<super::types::ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    stream: bool,
}

/// Event emitted to the frontend during streaming
#[derive(serde::Serialize, Clone)]
#[serde(tag = "type")]
pub enum LocalModelEvent {
    Chunk { text: String },
    Complete { full_text: String, model: String, provider: String },
    Error { error: String },
}

/// SSE delta structure from OpenAI-compatible streaming response
#[derive(serde::Deserialize)]
struct StreamDelta {
    content: Option<String>,
}

#[derive(serde::Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
}

#[derive(serde::Deserialize)]
struct StreamChunkResponse {
    choices: Vec<StreamChoice>,
}

const STREAM_EVENT_NAME: &str = "local-model-stream";

/// Call a chat completions model with streaming via SSE.
pub async fn call_model_stream(
    app: &tauri::AppHandle,
    pc: &ProviderConfig,
    api_key: &str,
    model: &str,
    messages: Vec<super::types::ChatMessage>,
    max_tokens: Option<u32>,
) -> Result<(), String> {
    let client = get_client();
    let base = pc.effective_base_url();
    let url = format!("{base}/chat/completions");

    let request = StreamChatRequest {
        model: model.to_string(),
        messages,
        max_tokens,
        stream: true,
    };

    let req = client.post(&url).json(&request);
    let req = add_provider_headers(req, pc, api_key);

    let response = req.send().await.map_err(|e| format_connection_error(pc, &e))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(parse_api_error(&pc.name, status.as_u16(), &body));
    }

    let mut full_text = String::new();
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result
            .map_err(|e| format!("{}: stream read error: {e}", pc.name))?;

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete SSE lines from buffer
        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                let data = data.trim();

                if data == "[DONE]" {
                    app.emit(STREAM_EVENT_NAME, LocalModelEvent::Complete {
                        full_text: full_text.clone(),
                        model: model.to_string(),
                        provider: pc.name.clone(),
                    }).map_err(|e| format!("Failed to emit stream complete event: {e}"))?;
                    return Ok(());
                }

                match serde_json::from_str::<StreamChunkResponse>(data) {
                    Ok(parsed) => {
                        if let Some(content) = parsed.choices.first()
                            .and_then(|c| c.delta.content.as_deref())
                        {
                            if !content.is_empty() {
                                full_text.push_str(content);
                                app.emit(STREAM_EVENT_NAME, LocalModelEvent::Chunk {
                                    text: content.to_string(),
                                }).map_err(|e| format!("Failed to emit stream chunk event: {e}"))?;
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to parse SSE chunk: {e}, data: {data}");
                    }
                }
            }
        }
    }

    // Stream ended without [DONE] — emit complete with what we have
    app.emit(STREAM_EVENT_NAME, LocalModelEvent::Complete {
        full_text: full_text.clone(),
        model: model.to_string(),
        provider: pc.name.clone(),
    }).map_err(|e| format!("Failed to emit stream complete event: {e}"))?;

    Ok(())
}
