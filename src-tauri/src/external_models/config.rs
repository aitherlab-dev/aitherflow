use std::path::PathBuf;

use crate::config;
use crate::file_ops::write_json;
use crate::secrets;

use super::types::{ExternalModelsConfig, ProviderConfig};

/// Path to external_models.json config file
fn config_path() -> PathBuf {
    config::config_dir().join("external_models.json")
}

/// Load external models configuration from disk.
/// Migrates legacy enum-based format if detected.
/// Blocking I/O — must be called from spawn_blocking.
pub fn load_config() -> Result<ExternalModelsConfig, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(default_config());
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config: {e}"))?;

    // Try parsing new format first
    if let Ok(cfg) = serde_json::from_str::<ExternalModelsConfig>(&data) {
        // Check if this is actually new format (providers have "id" field)
        if cfg.providers.is_empty() || !data.contains("\"provider\"") {
            return Ok(cfg);
        }
        // If all providers have id field, it's the new format
        let raw: serde_json::Value = serde_json::from_str(&data)
            .map_err(|e| format!("Failed to parse config: {e}"))?;
        if let Some(providers) = raw.get("providers").and_then(|v| v.as_array()) {
            let all_have_id = providers.iter().all(|p| p.get("id").is_some());
            if all_have_id {
                return Ok(cfg);
            }
        }
    }

    // Try legacy migration
    migrate_legacy_config(&data)
}

/// Save external models configuration to disk.
/// Blocking I/O — must be called from spawn_blocking.
pub fn save_config(config: &ExternalModelsConfig) -> Result<(), String> {
    write_json(&config_path(), config)
}

/// Get API key for a provider by its string id
pub fn get_api_key(provider_id: &str) -> Option<String> {
    let key = format!("external-{provider_id}-api-key");
    secrets::get_secret(&key)
}

/// Store API key for a provider by its string id
pub fn set_api_key(provider_id: &str, api_key: &str) -> Result<bool, String> {
    let key = format!("external-{provider_id}-api-key");
    secrets::set_secret(&key, api_key)
}

/// Find a provider in config by id.
/// Blocking I/O — must be called from spawn_blocking.
pub fn find_provider(provider_id: &str) -> Result<ProviderConfig, String> {
    let cfg = load_config()?;
    cfg.providers
        .into_iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("Provider not found: {provider_id}"))
}

/// Default configuration — empty providers list, user adds their own.
fn default_config() -> ExternalModelsConfig {
    ExternalModelsConfig {
        providers: vec![],
        vision_profile: None,
    }
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/// Legacy provider config (enum-based format)
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProviderConfig {
    provider: String,
    enabled: bool,
    #[serde(default)]
    default_model: String,
    #[serde(default)]
    base_url: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyConfig {
    #[serde(default)]
    providers: Vec<LegacyProviderConfig>,
    #[serde(default)]
    vision_profile: Option<crate::external_models::vision::VisionProfile>,
}

fn migrate_legacy_config(data: &str) -> Result<ExternalModelsConfig, String> {
    // Handle groq → google rename from even older format
    let data = data.replace("\"groq\"", "\"google\"");
    let legacy: LegacyConfig = serde_json::from_str(&data)
        .map_err(|e| format!("Failed to parse legacy config: {e}"))?;

    let mut providers = Vec::new();
    for lp in legacy.providers {
        let (id, name, provider_type, base_url, requires_api_key) = match lp.provider.as_str() {
            "openrouter" => (
                "openrouter".to_string(),
                "OpenRouter".to_string(),
                "openai_compatible".to_string(),
                lp.base_url.unwrap_or_else(|| "https://openrouter.ai/api/v1".to_string()),
                true,
            ),
            "google" => (
                "google".to_string(),
                "Google Gemini".to_string(),
                "openai_compatible".to_string(),
                lp.base_url.unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta/openai".to_string()),
                true,
            ),
            "ollama" => (
                "ollama".to_string(),
                "Ollama".to_string(),
                "ollama".to_string(),
                lp.base_url.unwrap_or_else(|| "http://localhost:11434".to_string()),
                false,
            ),
            other => {
                eprintln!("[external_models] Skipping unknown legacy provider: {other}");
                continue;
            }
        };

        // Migrate keyring keys: old format used "external-openrouter-api-key" etc.
        // New format uses the same pattern, so no keyring migration needed for these three.

        providers.push(ProviderConfig {
            id,
            name,
            provider_type,
            base_url,
            default_model: lp.default_model,
            enabled: lp.enabled,
            requires_api_key,
        });
    }

    let new_config = ExternalModelsConfig {
        providers,
        vision_profile: legacy.vision_profile,
    };

    // Save migrated config
    if let Err(e) = save_config(&new_config) {
        eprintln!("[external_models] Failed to save migrated config: {e}");
    } else {
        eprintln!("[external_models] Migrated legacy config to new format");
    }

    Ok(new_config)
}
