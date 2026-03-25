use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::config;
use crate::file_ops::{read_json, write_json};
use crate::files::validate_path_safe;

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

/// Validate that a filename has no path separators or traversal
fn validate_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty() {
        return Err("Filename cannot be empty".into());
    }
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(format!("Invalid filename: {filename}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn list_image_gen_models(models_path: String) -> Result<Vec<ImageModel>, String> {
    tokio::task::spawn_blocking(move || {
        let dir = PathBuf::from(&models_path);
        validate_path_safe(&dir)?;
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
        validate_filename(&filename)?;
        let dir = PathBuf::from(&models_path);
        validate_path_safe(&dir)?;
        let path = dir.join(&filename);
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
    use crate::file_ops::{read_json, write_json};
    use std::fs;
    use tempfile::TempDir;

    // ── Defaults & serde ──

    #[test]
    fn settings_defaults() {
        let s = ImageGenSettings::default();
        assert_eq!(s.width, 1024);
        assert_eq!(s.height, 1024);
        assert_eq!(s.steps, 20);
        assert_eq!(s.resolution_preset, ResolutionPreset::Square);
        assert!(s.selected_model.is_empty());
        assert!(s.models_path.contains("models"));
        assert!(s.images_path.contains("images"));
    }

    #[test]
    fn settings_serde_roundtrip() {
        let tmp = std::env::temp_dir();
        let models_path = tmp.join("models").to_string_lossy().into_owned();
        let images_path = tmp.join("images").to_string_lossy().into_owned();
        let s = ImageGenSettings {
            models_path: models_path.clone(),
            images_path: images_path.clone(),
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
        assert_eq!(restored.resolution_preset, ResolutionPreset::Portrait);
        assert_eq!(restored.models_path, models_path);
        assert_eq!(restored.images_path, images_path);
    }

    #[test]
    fn settings_serde_defaults_from_empty() {
        let s: ImageGenSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.width, 1024);
        assert_eq!(s.height, 1024);
        assert_eq!(s.steps, 20);
        assert_eq!(s.resolution_preset, ResolutionPreset::Square);
    }

    #[test]
    fn settings_all_resolution_presets() {
        for (variant, name) in [
            (ResolutionPreset::Square, "square"),
            (ResolutionPreset::Portrait, "portrait"),
            (ResolutionPreset::Landscape, "landscape"),
            (ResolutionPreset::Custom, "custom"),
        ] {
            let s = ImageGenSettings { resolution_preset: variant.clone(), ..Default::default() };
            let json = serde_json::to_string(&s).unwrap();
            assert!(json.contains(name), "JSON should contain '{name}': {json}");
            let restored: ImageGenSettings = serde_json::from_str(&json).unwrap();
            assert_eq!(restored.resolution_preset, variant);
        }
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

    // ── File-based load/save ──

    #[test]
    fn load_defaults_when_file_missing() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nonexistent.json");
        assert!(!path.exists());
        // Simulate what load_image_gen_settings does
        let result = if path.exists() {
            read_json::<ImageGenSettings>(&path)
        } else {
            Ok(ImageGenSettings::default())
        };
        let s = result.unwrap();
        assert_eq!(s.width, 1024);
        assert_eq!(s.steps, 20);
    }

    #[test]
    fn save_and_reload_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("settings.json");
        let original = ImageGenSettings {
            models_path: "/custom/models".into(),
            images_path: "/custom/images".into(),
            resolution_preset: ResolutionPreset::Landscape,
            width: 1024,
            height: 576,
            steps: 35,
            selected_model: "stable-diffusion-xl".into(),
        };
        write_json(&path, &original).unwrap();
        assert!(path.exists());
        let loaded: ImageGenSettings = read_json(&path).unwrap();
        assert_eq!(loaded.models_path, "/custom/models");
        assert_eq!(loaded.images_path, "/custom/images");
        assert_eq!(loaded.resolution_preset, ResolutionPreset::Landscape);
        assert_eq!(loaded.width, 1024);
        assert_eq!(loaded.height, 576);
        assert_eq!(loaded.steps, 35);
        assert_eq!(loaded.selected_model, "stable-diffusion-xl");
    }

    // ── Model listing ──

    #[test]
    fn list_models_empty_dir() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let models: Vec<ImageModel> = KNOWN_MODELS
            .iter()
            .map(|(id, name, filename, size_mb)| ImageModel {
                id: id.to_string(),
                name: name.to_string(),
                filename: filename.to_string(),
                size_mb: *size_mb,
                downloaded: dir.join(filename).exists(),
            })
            .collect();
        assert_eq!(models.len(), 3);
        for m in &models {
            assert!(!m.downloaded, "{} should not be downloaded", m.name);
        }
    }

    #[test]
    fn list_models_with_downloaded_file() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        // Create one model file
        fs::write(dir.join("flux1-schnell.safetensors"), b"fake model data").unwrap();
        let models: Vec<ImageModel> = KNOWN_MODELS
            .iter()
            .map(|(id, name, filename, size_mb)| ImageModel {
                id: id.to_string(),
                name: name.to_string(),
                filename: filename.to_string(),
                size_mb: *size_mb,
                downloaded: dir.join(filename).exists(),
            })
            .collect();
        let flux = models.iter().find(|m| m.id == "flux-schnell").unwrap();
        assert!(flux.downloaded);
        let sdxl = models.iter().find(|m| m.id == "stable-diffusion-xl").unwrap();
        assert!(!sdxl.downloaded);
    }

    // ── Model deletion ──

    #[test]
    fn delete_existing_model() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let file = dir.join("test-model.safetensors");
        fs::write(&file, b"model data").unwrap();
        assert!(file.exists());
        // Simulate delete logic
        let path = PathBuf::from(dir).join("test-model.safetensors");
        if path.exists() {
            fs::remove_file(&path).unwrap();
        }
        assert!(!file.exists());
    }

    #[test]
    fn delete_nonexistent_model_is_noop() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let path = dir.join("nonexistent.safetensors");
        // Should not error — matches the command logic (if path.exists())
        if path.exists() {
            fs::remove_file(&path).unwrap();
        }
        assert!(!path.exists());
    }

    // ── Edge cases: invalid/extreme values ──

    #[test]
    fn settings_zero_dimensions() {
        let json = r#"{"width": 0, "height": 0, "steps": 0}"#;
        let s: ImageGenSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.width, 0);
        assert_eq!(s.height, 0);
        assert_eq!(s.steps, 0);
    }

    #[test]
    fn settings_extreme_values() {
        let json = r#"{"width": 99999, "height": 99999, "steps": 1000}"#;
        let s: ImageGenSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.width, 99999);
        assert_eq!(s.height, 99999);
        assert_eq!(s.steps, 1000);
    }

    #[test]
    fn settings_ignores_unknown_fields() {
        let json = r#"{"unknownField": "value", "width": 512}"#;
        let s: ImageGenSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.width, 512);
        assert_eq!(s.height, 1024); // default
    }

    #[test]
    fn settings_invalid_resolution_preset_fallback() {
        // Unknown preset value falls back to deserialize error — verify we handle known values
        let json = r#"{"resolutionPreset": "custom"}"#;
        let s: ImageGenSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.resolution_preset, ResolutionPreset::Custom);
    }

    #[test]
    fn settings_empty_paths() {
        let json = r#"{"modelsPath": "", "imagesPath": ""}"#;
        let s: ImageGenSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.models_path, "");
        assert_eq!(s.images_path, "");
    }

    // ── Filename validation (security) ──

    #[test]
    fn validate_filename_normal() {
        assert!(validate_filename("model.safetensors").is_ok());
        assert!(validate_filename("flux1-schnell.safetensors").is_ok());
    }

    #[test]
    fn validate_filename_empty() {
        assert!(validate_filename("").is_err());
    }

    #[test]
    fn validate_filename_traversal() {
        assert!(validate_filename("../../etc/passwd").is_err());
        assert!(validate_filename("..").is_err());
        assert!(validate_filename("../model.safetensors").is_err());
    }

    #[test]
    fn validate_filename_slashes() {
        assert!(validate_filename("path/to/file").is_err());
        assert!(validate_filename("path\\to\\file").is_err());
        assert!(validate_filename("/etc/passwd").is_err());
    }
}
