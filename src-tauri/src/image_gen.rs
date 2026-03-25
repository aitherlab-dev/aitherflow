use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::config;
use crate::file_ops::{read_json, write_json};

/// Resolution preset names
#[derive(Default, Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ResolutionPreset {
    #[default]
    Square,
    Portrait,
    Landscape,
    Custom,
}

/// Known models that can be downloaded (stub list for now)
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageModel {
    pub id: String,
    pub name: String,
    pub filename: String,
    pub size_mb: u64,
    pub downloaded: bool,
}

/// Image generation settings stored on disk
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenSettings {
    #[serde(default = "default_models_path")]
    pub models_path: String,
    #[serde(default = "default_images_path")]
    pub images_path: String,
    #[serde(default)]
    pub resolution_preset: ResolutionPreset,
    #[serde(default = "default_size")]
    pub width: u32,
    #[serde(default = "default_size")]
    pub height: u32,
    #[serde(default = "default_steps")]
    pub steps: u32,
    #[serde(default)]
    pub selected_model: String,
}

impl Default for ImageGenSettings {
    fn default() -> Self {
        Self {
            models_path: default_models_path(),
            images_path: default_images_path(),
            resolution_preset: ResolutionPreset::default(),
            width: default_size(),
            height: default_size(),
            steps: default_steps(),
            selected_model: String::new(),
        }
    }
}

fn default_models_path() -> String {
    config::data_dir()
        .join("models")
        .to_string_lossy()
        .into_owned()
}

fn default_images_path() -> String {
    config::data_dir()
        .join("images")
        .to_string_lossy()
        .into_owned()
}

fn default_size() -> u32 {
    1024
}

fn default_steps() -> u32 {
    20
}

/// Path to image-gen settings file
fn settings_path() -> PathBuf {
    config::config_dir().join("image-gen").join("settings.json")
}

/// Available models (hardcoded for now — will come from MCP later)
const KNOWN_MODELS: &[(&str, &str, &str, u64)] = &[
    (
        "stable-diffusion-xl",
        "Stable Diffusion XL",
        "sd_xl_base_1.0.safetensors",
        6938,
    ),
    (
        "stable-diffusion-1.5",
        "Stable Diffusion 1.5",
        "v1-5-pruned-emaonly.safetensors",
        4265,
    ),
    ("flux-schnell", "FLUX.1 Schnell", "flux1-schnell.safetensors", 23800),
];

#[tauri::command]
pub async fn load_image_gen_settings() -> Result<ImageGenSettings, String> {
    tokio::task::spawn_blocking(|| {
        let path = settings_path();
        if path.exists() {
            read_json::<ImageGenSettings>(&path)
        } else {
            Ok(ImageGenSettings::default())
        }
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn save_image_gen_settings(settings: ImageGenSettings) -> Result<(), String> {
    tokio::task::spawn_blocking(move || write_json(&settings_path(), &settings))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn list_image_gen_models(models_path: String) -> Result<Vec<ImageModel>, String> {
    tokio::task::spawn_blocking(move || {
        let dir = PathBuf::from(&models_path);
        let models: Vec<ImageModel> = KNOWN_MODELS
            .iter()
            .map(|(id, name, filename, size_mb)| {
                let downloaded = dir.join(filename).exists();
                ImageModel {
                    id: id.to_string(),
                    name: name.to_string(),
                    filename: filename.to_string(),
                    size_mb: *size_mb,
                    downloaded,
                }
            })
            .collect();
        Ok(models)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn delete_image_gen_model(models_path: String, filename: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = PathBuf::from(&models_path).join(&filename);
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete {}: {e}", path.display()))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_defaults() {
        let s = ImageGenSettings::default();
        assert_eq!(s.width, 1024);
        assert_eq!(s.height, 1024);
        assert_eq!(s.steps, 20);
        assert_eq!(s.resolution_preset, ResolutionPreset::Square);
        assert!(s.selected_model.is_empty());
    }

    #[test]
    fn settings_serde_roundtrip() {
        let s = ImageGenSettings {
            models_path: "/tmp/models".into(),
            images_path: "/tmp/images".into(),
            resolution_preset: ResolutionPreset::Portrait,
            width: 576,
            height: 1024,
            steps: 30,
            selected_model: "flux-schnell".into(),
        };
        let json = serde_json::to_string(&s).unwrap();
        let restored: ImageGenSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.width, 576);
        assert_eq!(restored.height, 1024);
        assert_eq!(restored.steps, 30);
        assert_eq!(restored.selected_model, "flux-schnell");
    }

    #[test]
    fn settings_serde_defaults_from_empty() {
        let s: ImageGenSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.width, 1024);
        assert_eq!(s.height, 1024);
        assert_eq!(s.steps, 20);
    }

    #[test]
    fn known_models_list() {
        assert_eq!(KNOWN_MODELS.len(), 3);
        for (id, name, filename, size) in KNOWN_MODELS {
            assert!(!id.is_empty());
            assert!(!name.is_empty());
            assert!(filename.ends_with(".safetensors"));
            assert!(*size > 0);
        }
    }
}
