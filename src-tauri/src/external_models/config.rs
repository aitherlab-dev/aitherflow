use std::path::PathBuf;

use crate::config;
use crate::file_ops::{read_json, write_json};
use crate::secrets;

use super::types::{ExternalModelsConfig, Provider, ProviderConfig};

/// Path to external_models.json config file
fn config_path() -> PathBuf {
    config::config_dir().join("external_models.json")
}

/// Load external models configuration from disk.
/// API keys are NOT included — they live in the system keyring.
pub fn load_config() -> Result<ExternalModelsConfig, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(default_config());
    }
    read_json::<ExternalModelsConfig>(&path)
}

/// Save external models configuration to disk.
/// API keys are stored separately in the system keyring.
pub fn save_config(config: &ExternalModelsConfig) -> Result<(), String> {
    write_json(&config_path(), config)
}

/// Get API key for a provider from the system keyring
pub fn get_api_key(provider: &Provider) -> Option<String> {
    secrets::get_secret(provider.secret_key())
}

/// Store API key for a provider in the system keyring
pub fn set_api_key(provider: &Provider, key: &str) -> Result<bool, String> {
    secrets::set_secret(provider.secret_key(), key)
}

/// Default configuration with both providers disabled
fn default_config() -> ExternalModelsConfig {
    ExternalModelsConfig {
        providers: vec![
            ProviderConfig {
                provider: Provider::OpenRouter,
                enabled: false,
                default_model: String::new(),
            },
            ProviderConfig {
                provider: Provider::Groq,
                enabled: false,
                default_model: String::new(),
            },
        ],
    }
}
