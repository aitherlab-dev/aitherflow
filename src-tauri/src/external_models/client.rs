use reqwest::Client;
use std::sync::OnceLock;
use std::time::Duration;

use super::types::{
    ApiErrorResponse, ChatRequest, ChatResponse, ModelInfo, ModelsResponse, OllamaTagsResponse,
    Provider,
};

const TIMEOUT_SECS: u64 = 120;
const APP_TITLE: &str = "Aitherflow";
const APP_URL: &str = "https://github.com/aitherlab-dev/aitherflow";

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

/// Get or create the shared reqwest client.
/// Client::builder().build() only fails on TLS backend init issues,
/// which would also fail on every retry, so panicking is acceptable here.
fn get_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(TIMEOUT_SECS))
            .build()
            .expect("Failed to build HTTP client — TLS backend unavailable")
    })
}

/// Resolve the effective base URL: custom override or provider default.
fn effective_base_url(provider: &Provider, base_url_override: Option<&str>) -> String {
    match base_url_override {
        Some(url) if !url.is_empty() => {
            // For Ollama: stored URL is the server root (e.g. http://localhost:11434),
            // chat completions need /v1 appended
            if *provider == Provider::Ollama && !url.contains("/v1") {
                format!("{}/v1", url.trim_end_matches('/'))
            } else {
                url.trim_end_matches('/').to_string()
            }
        }
        _ => provider.base_url().to_string(),
    }
}

/// Parse API error response body into a human-readable message
fn parse_api_error(provider: &Provider, status: u16, body: &str) -> String {
    let msg = serde_json::from_str::<ApiErrorResponse>(body)
        .ok()
        .and_then(|r| r.error)
        .map(|e| e.message)
        .unwrap_or_else(|| body.to_string());
    format!("{} API error ({status}): {msg}", provider.display_name())
}

/// Call a chat completions model via OpenAI-compatible API.
/// `base_url_override` allows custom server URLs (e.g. Ollama on non-default port).
pub async fn call_model(
    provider: &Provider,
    api_key: &str,
    model: &str,
    messages: Vec<super::types::ChatMessage>,
    max_tokens: Option<u32>,
    base_url_override: Option<&str>,
) -> Result<ChatResponse, String> {
    let client = get_client();
    let base = effective_base_url(provider, base_url_override);
    let url = format!("{base}/chat/completions");

    let request = ChatRequest {
        model: model.to_string(),
        messages,
        max_tokens,
        temperature: None,
    };

    let mut req = client.post(&url).json(&request);

    // Add auth header only for providers that need it
    if provider.requires_api_key() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }

    if *provider == Provider::OpenRouter {
        req = req
            .header("HTTP-Referer", APP_URL)
            .header("X-Title", APP_TITLE);
    }

    let response = req.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("{}: request timed out after {TIMEOUT_SECS}s", provider.display_name())
        } else if e.is_connect() {
            if *provider == Provider::Ollama {
                format!("Ollama not running — connection refused. Start Ollama first.")
            } else {
                format!("{}: connection failed — check your network", provider.display_name())
            }
        } else {
            format!("{}: request failed: {e}", provider.display_name())
        }
    })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(parse_api_error(provider, status.as_u16(), &body));
    }

    response
        .json::<ChatResponse>()
        .await
        .map_err(|e| format!("{}: failed to parse response: {e}", provider.display_name()))
}

/// List available models from the provider.
/// Ollama uses /api/tags instead of /v1/models.
pub async fn list_models(
    provider: &Provider,
    api_key: &str,
    base_url_override: Option<&str>,
) -> Result<Vec<ModelInfo>, String> {
    if *provider == Provider::Ollama {
        return list_ollama_models(base_url_override).await;
    }

    let client = get_client();
    let base = effective_base_url(provider, base_url_override);
    let url = format!("{base}/models");

    let mut req = client
        .get(&url)
        .header("Authorization", format!("Bearer {api_key}"));

    if *provider == Provider::OpenRouter {
        req = req
            .header("HTTP-Referer", APP_URL)
            .header("X-Title", APP_TITLE);
    }

    let response = req.send().await.map_err(|e| {
        format!("{}: failed to fetch models: {e}", provider.display_name())
    })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(parse_api_error(provider, status.as_u16(), &body));
    }

    let models_resp = response
        .json::<ModelsResponse>()
        .await
        .map_err(|e| format!("{}: failed to parse models list: {e}", provider.display_name()))?;

    Ok(models_resp.data)
}

/// List models from Ollama via /api/tags endpoint.
async fn list_ollama_models(
    base_url_override: Option<&str>,
) -> Result<Vec<ModelInfo>, String> {
    let client = get_client();
    let server = base_url_override
        .filter(|u| !u.is_empty())
        .unwrap_or("http://localhost:11434");
    let url = format!("{}/api/tags", server.trim_end_matches('/'));

    let response = client.get(&url).send().await.map_err(|e| {
        if e.is_connect() {
            "Ollama not running — connection refused. Start Ollama first.".to_string()
        } else {
            format!("Ollama: failed to fetch models: {e}")
        }
    })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Ollama API error ({status}): {body}"));
    }

    let tags = response
        .json::<OllamaTagsResponse>()
        .await
        .map_err(|e| format!("Ollama: failed to parse models: {e}"))?;

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
