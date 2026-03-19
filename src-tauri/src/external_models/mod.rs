mod client;
pub mod config;
pub mod types;

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
    let api_key = config::get_api_key(&provider)
        .ok_or_else(|| format!("No API key configured for {}", provider.display_name()))?;

    client::call_model(&provider, &api_key, &model, messages, max_tokens).await
}

/// Test connection to a provider by sending a simple "say hi" request
#[tauri::command]
pub async fn external_models_test_connection(provider: Provider) -> Result<String, String> {
    let api_key = config::get_api_key(&provider)
        .ok_or_else(|| format!("No API key configured for {}", provider.display_name()))?;

    let test_model = get_test_model(&provider);
    let messages = vec![ChatMessage {
        role: Role::User,
        content: MessageContent::Text("Say hi in one word.".to_string()),
    }];

    let response =
        client::call_model(&provider, &api_key, &test_model, messages, Some(10)).await?;

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
    let api_key = config::get_api_key(&provider)
        .ok_or_else(|| format!("No API key configured for {}", provider.display_name()))?;

    client::list_models(&provider, &api_key).await
}

/// Save external models configuration (provider settings + API keys)
#[tauri::command]
pub async fn external_models_save_config(
    providers_config: ExternalModelsConfig,
    openrouter_api_key: Option<String>,
    groq_api_key: Option<String>,
) -> Result<(), String> {
    // Store API keys in keyring (only if provided and not masked)
    if let Some(key) = openrouter_api_key {
        if !key.is_empty() && !key.starts_with("****") {
            config::set_api_key(&Provider::OpenRouter, &key)
                .map_err(|e| format!("Failed to store OpenRouter API key: {e}"))?;
        }
    }
    if let Some(key) = groq_api_key {
        if !key.is_empty() && !key.starts_with("****") {
            config::set_api_key(&Provider::Groq, &key)
                .map_err(|e| format!("Failed to store Groq API key: {e}"))?;
        }
    }

    // Save config to disk (no API keys in the file)
    tokio::task::spawn_blocking(move || config::save_config(&providers_config))
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
        let groq_key = config::get_api_key(&Provider::Groq)
            .map(|k| mask_key(&k))
            .unwrap_or_default();

        Ok(ExternalModelsConfigWithKeys {
            config: cfg,
            openrouter_api_key: openrouter_key,
            groq_api_key: groq_key,
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
    pub groq_api_key: String,
}

/// Mask an API key for display: "sk-abc123xyz" → "****3xyz"
fn mask_key(key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    if key.len() > 4 {
        format!("****{}", &key[key.len() - 4..])
    } else {
        "****".to_string()
    }
}

/// Pick a small/cheap model for connection testing
fn get_test_model(provider: &Provider) -> String {
    match provider {
        Provider::OpenRouter => "openrouter/auto".to_string(),
        Provider::Groq => "llama-3.1-8b-instant".to_string(),
    }
}
