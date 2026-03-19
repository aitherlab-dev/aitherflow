use reqwest::Client;
use std::sync::OnceLock;
use std::time::Duration;

use super::types::{
    ApiErrorResponse, ChatRequest, ChatResponse, ModelInfo, ModelsResponse, Provider,
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

/// Parse API error response body into a human-readable message
fn parse_api_error(provider: &Provider, status: u16, body: &str) -> String {
    let msg = serde_json::from_str::<ApiErrorResponse>(body)
        .ok()
        .and_then(|r| r.error)
        .map(|e| e.message)
        .unwrap_or_else(|| body.to_string());
    format!("{} API error ({status}): {msg}", provider.display_name())
}

/// Call a chat completions model via OpenAI-compatible API
pub async fn call_model(
    provider: &Provider,
    api_key: &str,
    model: &str,
    messages: Vec<super::types::ChatMessage>,
    max_tokens: Option<u32>,
) -> Result<ChatResponse, String> {
    let client = get_client();
    let url = format!("{}/chat/completions", provider.base_url());

    let request = ChatRequest {
        model: model.to_string(),
        messages,
        max_tokens,
        temperature: None,
    };

    let mut req = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&request);

    if *provider == Provider::OpenRouter {
        req = req
            .header("HTTP-Referer", APP_URL)
            .header("X-Title", APP_TITLE);
    }

    let response = req.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("{}: request timed out after {TIMEOUT_SECS}s", provider.display_name())
        } else if e.is_connect() {
            format!("{}: connection failed — check your network", provider.display_name())
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

/// List available models from the provider
pub async fn list_models(
    provider: &Provider,
    api_key: &str,
) -> Result<Vec<ModelInfo>, String> {
    let client = get_client();
    let url = format!("{}/models", provider.base_url());

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
