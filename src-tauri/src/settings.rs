use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::config;
use crate::file_ops::{read_json, write_json};
use crate::secrets;

const KEY_GROQ: &str = "groq-api-key";
const KEY_DEEPGRAM: &str = "deepgram-api-key";
const KEY_MASK_PREFIX: &str = "****";

/// Return masked version of an API key for frontend display.
/// e.g. "gsk_abc123xyz" → "****3xyz", empty → empty.
fn mask_key(key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    if key.len() > 4 {
        format!("{KEY_MASK_PREFIX}{}", &key[key.len() - 4..])
    } else {
        KEY_MASK_PREFIX.to_string()
    }
}

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
    /// Name of the default role applied when no role is explicitly selected
    #[serde(default)]
    pub default_role_name: String,
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
pub fn settings_path() -> PathBuf {
    config::config_dir().join("settings.json")
}

/// Read voice_language from settings (blocking I/O). Returns empty string if not set.
pub fn get_voice_language() -> String {
    let path = settings_path();
    read_json::<AppSettings>(&path)
        .map(|s| s.voice_language)
        .unwrap_or_default()
}

/// Load settings from disk. API keys are loaded from system keyring;
/// if not found there, migrates from JSON to keyring.
#[tauri::command]
pub async fn load_settings() -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(move || {
        let path = settings_path();
        let mut settings = if path.exists() {
            read_json::<AppSettings>(&path)?
        } else {
            return Ok(AppSettings::default());
        };

        let mut migrated = false;

        // Groq key: prefer keyring, migrate from JSON if needed
        if let Some(kr) = secrets::get_secret(KEY_GROQ) {
            settings.groq_api_key = kr;
        } else if !settings.groq_api_key.is_empty() {
            if let Err(e) = secrets::set_secret(KEY_GROQ, &settings.groq_api_key) {
                eprintln!("[settings] Failed to migrate groq key to keyring: {e}");
            }
            migrated = true;
        }

        // Deepgram key: same logic
        if let Some(kr) = secrets::get_secret(KEY_DEEPGRAM) {
            settings.deepgram_api_key = kr;
        } else if !settings.deepgram_api_key.is_empty() {
            if let Err(e) = secrets::set_secret(KEY_DEEPGRAM, &settings.deepgram_api_key) {
                eprintln!("[settings] Failed to migrate deepgram key to keyring: {e}");
            }
            migrated = true;
        }

        // If migrated, clear keys from JSON file
        if migrated {
            let mut disk = settings.clone();
            disk.groq_api_key = String::new();
            disk.deepgram_api_key = String::new();
            if let Err(e) = write_json(&settings_path(), &disk) {
                eprintln!("[settings] Failed to write migrated settings: {e}");
            }
        }

        // Mask keys before sending to frontend
        settings.groq_api_key = mask_key(&settings.groq_api_key);
        settings.deepgram_api_key = mask_key(&settings.deepgram_api_key);

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
        // Only update keyring if user provided a real key (not a mask from load_settings)
        if !settings.groq_api_key.starts_with(KEY_MASK_PREFIX) {
            if let Err(e) = secrets::set_secret(KEY_GROQ, &settings.groq_api_key) {
                eprintln!("[settings] Failed to store groq key: {e}");
            }
        }
        if !settings.deepgram_api_key.starts_with(KEY_MASK_PREFIX) {
            if let Err(e) = secrets::set_secret(KEY_DEEPGRAM, &settings.deepgram_api_key) {
                eprintln!("[settings] Failed to store deepgram key: {e}");
            }
        }

        // Write JSON without secrets
        let mut disk = settings;
        disk.groq_api_key = String::new();
        disk.deepgram_api_key = String::new();
        write_json(&settings_path(), &disk)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
