mod client;
pub mod config;
pub mod mcp_server;
pub mod types;
pub mod vision;

use std::collections::HashMap;
use tauri::Emitter;
use types::{
    ChatMessage, ChatResponse, ExternalModelsConfig, MessageContent, ModelInfo, ProviderConfig, Role,
};

pub use client::LocalModelEvent;

/// Call an external model via OpenAI-compatible API
#[tauri::command]
pub async fn external_models_call(
    provider_id: String,
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
) -> Result<ChatResponse, String> {
    let (pc, api_key) = get_provider_credentials(&provider_id).await?;
    client::call_model(&pc, &api_key, &model, messages, max_tokens).await
}

/// Call an external model with streaming — chunks emitted as "local-model-stream" events
#[tauri::command]
pub async fn external_models_call_stream(
    app: tauri::AppHandle,
    provider_id: String,
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
) -> Result<(), String> {
    let (pc, api_key) = get_provider_credentials(&provider_id).await?;

    if let Err(e) = client::call_model_stream(
        &app, &pc, &api_key, &model, messages, max_tokens,
    ).await {
        if let Err(emit_err) = app.emit("local-model-stream", LocalModelEvent::Error {
            error: e.clone(),
        }) {
            eprintln!("Failed to emit stream error event: {emit_err}");
        }
        return Err(e);
    }

    Ok(())
}

/// Test connection to a provider by sending a simple "say hi" request
#[tauri::command]
pub async fn external_models_test_connection(provider_id: String) -> Result<String, String> {
    let (pc, api_key) = get_provider_credentials(&provider_id).await?;

    let test_model = get_test_model(&pc, &api_key).await?;
    let messages = vec![ChatMessage {
        role: Role::User,
        content: MessageContent::Text("Say hi in one word.".to_string()),
    }];

    let response = client::call_model(&pc, &api_key, &test_model, messages, Some(10)).await?;

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
    provider_id: String,
) -> Result<Vec<ModelInfo>, String> {
    let (pc, api_key) = get_provider_credentials(&provider_id).await?;
    client::list_models(&pc, &api_key).await
}

/// Save external models configuration (provider settings + API keys)
#[tauri::command]
pub async fn external_models_save_config(
    providers_config: ExternalModelsConfig,
    api_keys: HashMap<String, String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // Store API keys in keyring (only if provided and not masked)
        for (id, key) in &api_keys {
            if !key.is_empty() && !key.starts_with("****") {
                config::set_api_key(id, key)
                    .map_err(|e| format!("Failed to store API key for {id}: {e}"))?;
            }
        }

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

        // Return masked API keys for each provider
        let mut keys = HashMap::new();
        for p in &cfg.providers {
            if p.requires_api_key {
                let masked = config::get_api_key(&p.id)
                    .map(|k| mask_key(&k))
                    .unwrap_or_default();
                keys.insert(p.id.clone(), masked);
            }
        }

        Ok(ExternalModelsConfigWithKeys {
            config: cfg,
            keys,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Add a new provider to the config
#[tauri::command]
pub async fn external_models_add_provider(
    provider: ProviderConfig,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut cfg = config::load_config()?;
        if cfg.providers.iter().any(|p| p.id == provider.id) {
            return Err(format!("Provider with id '{}' already exists", provider.id));
        }
        cfg.providers.push(provider);
        config::save_config(&cfg)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Remove a provider from the config
#[tauri::command]
pub async fn external_models_remove_provider(
    provider_id: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut cfg = config::load_config()?;
        let before = cfg.providers.len();
        cfg.providers.retain(|p| p.id != provider_id);
        if cfg.providers.len() == before {
            return Err(format!("Provider not found: {provider_id}"));
        }
        // Remove API key from keyring
        let secret_key = format!("external-{provider_id}-api-key");
        if let Err(e) = crate::secrets::delete_secret(&secret_key) {
            eprintln!("[external_models] Failed to delete secret for {provider_id}: {e}");
        }
        config::save_config(&cfg)
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
    pub keys: HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Get provider config and API key by string id.
async fn get_provider_credentials(
    provider_id: &str,
) -> Result<(ProviderConfig, String), String> {
    let id = provider_id.to_string();
    tokio::task::spawn_blocking(move || {
        let pc = config::find_provider(&id)?;
        let api_key = if pc.requires_api_key {
            config::get_api_key(&id).ok_or_else(|| {
                format!("No API key configured for {}", pc.name)
            })?
        } else {
            String::new()
        };
        Ok((pc, api_key))
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
async fn get_test_model(
    pc: &ProviderConfig,
    api_key: &str,
) -> Result<String, String> {
    if pc.is_ollama() {
        let models = client::list_models(pc, api_key).await?;
        models
            .first()
            .map(|m| m.id.clone())
            .ok_or_else(|| "No models installed in Ollama. Run: ollama pull <model>".into())
    } else if !pc.default_model.is_empty() {
        Ok(pc.default_model.clone())
    } else {
        Err(format!("No default model configured for {}", pc.name))
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
#[tauri::command]
pub async fn external_models_openrouter_balance() -> Result<OpenRouterBalance, String> {
    let (api_key, mgmt_key) = tokio::task::spawn_blocking(|| {
        let api = config::get_api_key("openrouter");
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
