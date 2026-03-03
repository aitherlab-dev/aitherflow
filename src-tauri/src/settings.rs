use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::config;
use crate::file_ops::atomic_write;

/// App-wide settings stored on disk
#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub bypass_permissions: bool,
    /// Translation language code: "ru", "zh", "ja", "es", "fr", or "" (disabled)
    #[serde(default)]
    pub translation_language: String,
}

/// Path to settings.json
fn settings_path() -> PathBuf {
    config::config_dir().join("settings.json")
}


/// Load settings from disk. Returns defaults if file doesn't exist.
#[tauri::command]
pub async fn load_settings() -> Result<AppSettings, String> {
    tokio::task::spawn_blocking(move || {
        let path = settings_path();
        if !path.exists() {
            return Ok(AppSettings::default());
        }

        let data = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read settings.json: {e}"))?;
        let settings: AppSettings = serde_json::from_str(&data)
            .map_err(|e| format!("Failed to parse settings.json: {e}"))?;
        Ok(settings)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Save settings to disk (atomic write)
#[tauri::command]
pub async fn save_settings(settings: AppSettings) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let data = serde_json::to_string_pretty(&settings)
            .map_err(|e| format!("Failed to serialize settings: {e}"))?;
        atomic_write(&settings_path(), data.as_bytes())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
