use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::config;
use crate::file_ops::atomic_write;
use crate::secrets;

const KEY_GROQ: &str = "groq-api-key";
const KEY_DEEPGRAM: &str = "deepgram-api-key";

/// App-wide settings stored on disk
#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub bypass_permissions: bool,
    /// Translation language code: "ru", "zh", "ja", "es", "fr", or "" (disabled)
    #[serde(default)]
    pub translation_language: String,
    /// Enable --chrome flag for browser control
    #[serde(default = "default_true")]
    pub enable_chrome: bool,
    /// Groq API key for voice transcription (Whisper)
    #[serde(default)]
    pub groq_api_key: String,
    /// Language hint for Whisper STT (e.g. "en", "ru"). Empty = auto-detect.
    #[serde(default)]
    pub voice_language: String,
    /// Enable LLM post-processing of STT text
    #[serde(default = "default_true")]
    pub voice_post_process: bool,
    /// Model for post-processing: "llama-3.3-70b-versatile" or "llama-3.1-8b-instant"
    #[serde(default = "default_post_process_model")]
    pub voice_post_model: String,
    /// Voice provider: "groq" or "anthropic" or "deepgram"
    #[serde(default = "default_voice_provider")]
    pub voice_provider: String,
    /// Deepgram API key for streaming STT
    #[serde(default)]
    pub deepgram_api_key: String,
}

fn default_voice_provider() -> String {
    "groq".to_string()
}

fn default_post_process_model() -> String {
    "llama-3.3-70b-versatile".to_string()
}

fn default_true() -> bool {
    true
}

/// Path to settings.json
fn settings_path() -> PathBuf {
    config::config_dir().join("settings.json")
}


/// Load settings from disk. API keys are loaded from system keyring;
/// if not found there, migrates from JSON to keyring.
#[tauri::command]
pub async fn load_settings() -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(move || {
        let path = settings_path();
        let mut settings = if path.exists() {
            let data = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read settings.json: {e}"))?;
            serde_json::from_str::<AppSettings>(&data)
                .map_err(|e| format!("Failed to parse settings.json: {e}"))?
        } else {
            return Ok(AppSettings::default());
        };

        let mut migrated = false;

        // Groq key: prefer keyring, migrate from JSON if needed
        if let Some(kr) = secrets::get_secret(KEY_GROQ) {
            settings.groq_api_key = kr;
        } else if !settings.groq_api_key.is_empty() {
            let _ = secrets::set_secret(KEY_GROQ, &settings.groq_api_key);
            migrated = true;
        }

        // Deepgram key: same logic
        if let Some(kr) = secrets::get_secret(KEY_DEEPGRAM) {
            settings.deepgram_api_key = kr;
        } else if !settings.deepgram_api_key.is_empty() {
            let _ = secrets::set_secret(KEY_DEEPGRAM, &settings.deepgram_api_key);
            migrated = true;
        }

        // If migrated, clear keys from JSON file
        if migrated {
            let mut disk = settings.clone();
            disk.groq_api_key = String::new();
            disk.deepgram_api_key = String::new();
            let data = serde_json::to_string_pretty(&disk)
                .map_err(|e| format!("Failed to serialize settings: {e}"))?;
            let _ = atomic_write(&settings_path(), data.as_bytes());
        }

        Ok(settings)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Save settings to disk. API keys go to system keyring;
/// settings.json stores everything else with empty key fields.
#[tauri::command]
pub async fn save_settings(settings: AppSettings) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // Store secrets in keyring
        let _ = secrets::set_secret(KEY_GROQ, &settings.groq_api_key);
        let _ = secrets::set_secret(KEY_DEEPGRAM, &settings.deepgram_api_key);

        // Write JSON without secrets
        let mut disk = settings;
        disk.groq_api_key = String::new();
        disk.deepgram_api_key = String::new();
        let data = serde_json::to_string_pretty(&disk)
            .map_err(|e| format!("Failed to serialize settings: {e}"))?;
        atomic_write(&settings_path(), data.as_bytes())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
