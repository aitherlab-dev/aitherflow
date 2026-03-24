mod client;
pub mod config;
pub mod mcp_server;
pub mod types;
pub mod vision;

use types::{
    ChatMessage, ChatResponse, ExternalModelsConfig, MessageContent, ModelInfo, Provider, Role,
};

/// Call an external model via OpenAI-compatible API
#[tauri::command]
pub async fn external_models_call(
    provider: Provider,
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
) -> Result<ChatResponse, String> {
    let (api_key, base_url) = get_provider_credentials(&provider).await?;
    client::call_model(&provider, &api_key, &model, messages, max_tokens, base_url.as_deref())
        .await
}

/// Test connection to a provider by sending a simple "say hi" request
#[tauri::command]
pub async fn external_models_test_connection(provider: Provider) -> Result<String, String> {
    let (api_key, base_url) = get_provider_credentials(&provider).await?;

    let test_model = get_test_model(&provider, base_url.as_deref()).await?;
    let messages = vec![ChatMessage {
        role: Role::User,
        content: MessageContent::Text("Say hi in one word.".to_string()),
    }];

    let response =
        client::call_model(&provider, &api_key, &test_model, messages, Some(10), base_url.as_deref())
            .await?;

    let reply = response
        .choices
        .first()
        .and_then(|c| c.message.content.as_ref())
        .cloned()
        .unwrap_or_default();

    Ok(reply)
}

/// List available models from a provider
#[tauri::command]
pub async fn external_models_list_models(
    provider: Provider,
) -> Result<Vec<ModelInfo>, String> {
    let (api_key, base_url) = get_provider_credentials(&provider).await?;
    client::list_models(&provider, &api_key, base_url.as_deref()).await
}

/// Save external models configuration (provider settings + API keys)
#[tauri::command]
pub async fn external_models_save_config(
    providers_config: ExternalModelsConfig,
    openrouter_api_key: Option<String>,
    openrouter_mgmt_key: Option<String>,
    google_api_key: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // Store API keys in keyring (only if provided and not masked)
        if let Some(key) = openrouter_api_key {
            if !key.is_empty() && !key.starts_with("****") {
                config::set_api_key(&Provider::OpenRouter, &key)
                    .map_err(|e| format!("Failed to store OpenRouter API key: {e}"))?;
            }
        }
        if let Some(key) = openrouter_mgmt_key {
            if !key.is_empty() && !key.starts_with("****") {
                crate::secrets::set_secret(OR_MGMT_KEY, &key)
                    .map_err(|e| format!("Failed to store OpenRouter management key: {e}"))?;
            }
        }
        if let Some(key) = google_api_key {
            if !key.is_empty() && !key.starts_with("****") {
                config::set_api_key(&Provider::Google, &key)
                    .map_err(|e| format!("Failed to store Google API key: {e}"))?;
            }
        }

        // Save config to disk (no API keys in the file)
        config::save_config(&providers_config)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Load external models configuration
#[tauri::command]
pub async fn external_models_load_config() -> Result<ExternalModelsConfigWithKeys, String> {
    tokio::task::spawn_blocking(move || {
        let cfg = config::load_config()?;

        // Return masked API keys so the frontend knows if keys are set
        let openrouter_key = config::get_api_key(&Provider::OpenRouter)
            .map(|k| mask_key(&k))
            .unwrap_or_default();
        let google_key = config::get_api_key(&Provider::Google)
            .map(|k| mask_key(&k))
            .unwrap_or_default();

        let mgmt_key = crate::secrets::get_secret(OR_MGMT_KEY)
            .map(|k| mask_key(&k))
            .unwrap_or_default();

        Ok(ExternalModelsConfigWithKeys {
            config: cfg,
            openrouter_api_key: openrouter_key,
            openrouter_mgmt_key: mgmt_key,
            google_api_key: google_key,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Config response that includes masked API key status
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalModelsConfigWithKeys {
    #[serde(flatten)]
    pub config: ExternalModelsConfig,
    pub openrouter_api_key: String,
    pub openrouter_mgmt_key: String,
    pub google_api_key: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Get API key and base URL for a provider (single config read in blocking context).
async fn get_provider_credentials(
    provider: &Provider,
) -> Result<(String, Option<String>), String> {
    let provider = provider.clone();
    tokio::task::spawn_blocking(move || {
        let api_key = if provider.requires_api_key() {
            config::get_api_key(&provider).ok_or_else(|| {
                format!("No API key configured for {}", provider.display_name())
            })?
        } else {
            String::new()
        };
        // Single config read for base_url
        let base_url = config::load_config()
            .ok()
            .and_then(|c| {
                c.providers
                    .iter()
                    .find(|p| p.provider == provider)
                    .and_then(|p| p.base_url.clone())
            });
        Ok((api_key, base_url))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Mask an API key for display: "sk-abc123xyz" → "****3xyz"
fn mask_key(key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    let last4: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if last4.len() < key.len() {
        format!("****{last4}")
    } else {
        "****".to_string()
    }
}

/// Pick a model for connection testing.
/// For Ollama: pick the first installed model.
async fn get_test_model(
    provider: &Provider,
    base_url: Option<&str>,
) -> Result<String, String> {
    match provider {
        Provider::OpenRouter => Ok("openrouter/auto".to_string()),
        Provider::Google => Ok("gemini-2.5-flash".to_string()),
        Provider::Ollama => {
            let models = client::list_models(provider, "", base_url).await?;
            models
                .first()
                .map(|m| m.id.clone())
                .ok_or_else(|| "No models installed in Ollama. Run: ollama pull <model>".into())
        }
    }
}

// ---------------------------------------------------------------------------
// OpenRouter balance
// ---------------------------------------------------------------------------

const OR_MGMT_KEY: &str = "external-openrouter-mgmt-key";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterBalance {
    pub total_credits: Option<f64>,
    pub total_usage: f64,
    pub remaining: Option<f64>,
}

/// Fetch OpenRouter account balance.
/// Uses management key (/api/v1/credits) if available, otherwise API key (/api/v1/key).
#[tauri::command]
pub async fn external_models_openrouter_balance() -> Result<OpenRouterBalance, String> {
    let (api_key, mgmt_key) = tokio::task::spawn_blocking(|| {
        let api = config::get_api_key(&Provider::OpenRouter);
        let mgmt = crate::secrets::get_secret(OR_MGMT_KEY);
        (api, mgmt)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?;

    let client = reqwest::Client::new();

    // Try management key first for full balance
    if let Some(mgmt) = mgmt_key {
        #[derive(serde::Deserialize)]
        struct CreditsResponse { data: CreditsData }
        #[derive(serde::Deserialize)]
        struct CreditsData { total_credits: Option<f64>, total_usage: Option<f64> }

        let resp = client
            .get("https://openrouter.ai/api/v1/credits")
            .header("Authorization", format!("Bearer {mgmt}"))
            .send()
            .await
            .map_err(|e| format!("OpenRouter credits request failed: {e}"))?;

        if resp.status().is_success() {
            let cr: CreditsResponse = resp.json().await
                .map_err(|e| format!("Failed to parse credits response: {e}"))?;
            let total = cr.data.total_credits.unwrap_or(0.0);
            let usage = cr.data.total_usage.unwrap_or(0.0);
            return Ok(OpenRouterBalance {
                total_credits: Some(total),
                total_usage: usage,
                remaining: Some(total - usage),
            });
        }
    }

    // Fallback: use API key for usage only
    let api_key = api_key.ok_or("OpenRouter API key not configured")?;

    #[derive(serde::Deserialize)]
    struct KeyResponse { data: KeyData }
    #[derive(serde::Deserialize)]
    struct KeyData { usage: Option<f64> }

    let resp = client
        .get("https://openrouter.ai/api/v1/key")
        .header("Authorization", format!("Bearer {api_key}"))
        .send()
        .await
        .map_err(|e| format!("OpenRouter key request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("OpenRouter API error: {body}"));
    }

    let kr: KeyResponse = resp.json().await
        .map_err(|e| format!("Failed to parse key response: {e}"))?;

    Ok(OpenRouterBalance {
        total_credits: None,
        total_usage: kr.data.usage.unwrap_or(0.0),
        remaining: None,
    })
}

// ---------------------------------------------------------------------------
// MCP server management commands
// ---------------------------------------------------------------------------

/// MCP server status info
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub port: Option<u16>,
}

/// Start the external models MCP server
#[tauri::command]
pub async fn external_models_start_mcp() -> Result<u16, String> {
    mcp_server::start_server().await
}

/// Stop the external models MCP server
#[tauri::command]
pub async fn external_models_stop_mcp() -> Result<(), String> {
    mcp_server::stop_server().await
}

/// Get MCP server status
#[tauri::command]
pub async fn external_models_mcp_status() -> Result<McpStatus, String> {
    Ok(McpStatus {
        running: mcp_server::is_running(),
        port: mcp_server::get_port(),
    })
}

