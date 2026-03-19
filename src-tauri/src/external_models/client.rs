use reqwest::Client;
use std::time::Duration;

use super::types::{
    ApiErrorResponse, ChatRequest, ChatResponse, ModelInfo, ModelsResponse, Provider,
};

const TIMEOUT_SECS: u64 = 120;
const APP_TITLE: &str = "Aitherflow";
const APP_URL: &str = "https://github.com/aitherlab-dev/aitherflow";

/// Build a shared reqwest client with timeout
fn build_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

/// Call a chat completions model via OpenAI-compatible API
pub async fn call_model(
    provider: &Provider,
    api_key: &str,
    model: &str,
    messages: Vec<super::types::ChatMessage>,
    max_tokens: Option<u32>,
) -> Result<ChatResponse, String> {
    let client = build_client()?;
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

    // OpenRouter requires additional headers
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
        let api_msg = serde_json::from_str::<ApiErrorResponse>(&body)
            .ok()
            .and_then(|r| r.error)
            .map(|e| e.message)
            .unwrap_or(body);
        return Err(format!(
            "{} API error ({}): {}",
            provider.display_name(),
            status.as_u16(),
            api_msg
        ));
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
    let client = build_client()?;
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
        return Err(format!(
            "{} API error ({}): {}",
            provider.display_name(),
            status.as_u16(),
            body
        ));
    }

    let models_resp = response
        .json::<ModelsResponse>()
        .await
        .map_err(|e| format!("{}: failed to parse models list: {e}", provider.display_name()))?;

    Ok(models_resp.data)
}
