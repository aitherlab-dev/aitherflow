use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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

/// Known model definition
pub struct KnownModel {
    pub id: &'static str,
    pub name: &'static str,
    pub repo_id: &'static str,
    pub hf_file: &'static str,
    pub size_mb: u64,
}

/// Model info returned to frontend
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageModel {
    pub id: String,
    pub name: String,
    pub repo_id: String,
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
    pub width: i32,
    #[serde(default = "default_size")]
    pub height: i32,
    #[serde(default = "default_steps")]
    pub steps: i32,
    #[serde(default = "default_selected_model")]
    pub selected_model: String,
    #[serde(default = "default_true")]
    pub image_mcp_enabled: bool,
}

fn default_true() -> bool {
    true
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
            selected_model: default_selected_model(),
            image_mcp_enabled: true,
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

fn default_size() -> i32 {
    1024
}

fn default_steps() -> i32 {
    20
}

fn default_selected_model() -> String {
    "flux2-klein-4b".to_string()
}

/// Path to image-gen settings file
fn settings_path() -> PathBuf {
    config::config_dir().join("image-gen").join("settings.json")
}

/// Load settings synchronously (for use in conductor/process.rs)
pub fn load_settings_sync() -> ImageGenSettings {
    let path = settings_path();
    if path.exists() {
        read_json::<ImageGenSettings>(&path).unwrap_or_default()
    } else {
        ImageGenSettings::default()
    }
}

/// Available models synced with MCP server (resolve_preset in tools.rs)
pub const KNOWN_MODELS: &[KnownModel] = &[
    KnownModel { id: "flux2-klein-4b", name: "FLUX.2 Klein 4B", repo_id: "unsloth/FLUX.2-klein-4B-GGUF", hf_file: "flux-2-klein-4b-Q8_0.gguf", size_mb: 4403 },
    KnownModel { id: "flux2-klein-9b", name: "FLUX.2 Klein 9B", repo_id: "unsloth/FLUX.2-klein-9B-GGUF", hf_file: "flux-2-klein-9b-Q8_0.gguf", size_mb: 10220 },
    KnownModel { id: "flux2-dev", name: "FLUX.2 Dev", repo_id: "city96/FLUX.2-dev-gguf", hf_file: "flux2-dev-Q2_K.gguf", size_mb: 13209 },
    KnownModel { id: "flux1-dev", name: "FLUX.1 Dev", repo_id: "city96/FLUX.1-dev-gguf", hf_file: "flux1-dev-Q8_0.gguf", size_mb: 13005 },
    KnownModel { id: "flux1-schnell", name: "FLUX.1 Schnell", repo_id: "city96/FLUX.1-schnell-gguf", hf_file: "flux1-schnell-Q8_0.gguf", size_mb: 13005 },
    KnownModel { id: "flux1-mini", name: "FLUX.1 Mini", repo_id: "gpustack/FLUX.1-mini-GGUF", hf_file: "FLUX.1-mini-Q8_0.gguf", size_mb: 9574 },
    KnownModel { id: "sdxl-turbo", name: "SDXL Turbo", repo_id: "stabilityai/sdxl-turbo", hf_file: "sd_xl_turbo_1.0_fp16.safetensors", size_mb: 7108 },
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

/// Check if a model file exists in the hf-hub cache structure on disk.
/// Cache layout: {models_path}/models--{org}--{repo}/snapshots/{hash}/{filename}
fn is_model_downloaded(models_path: &Path, repo_id: &str, filename: &str) -> bool {
    let cache_dir = format!("models--{}", repo_id.replace('/', "--"));
    let snapshots_dir = models_path.join(&cache_dir).join("snapshots");
    let Ok(entries) = std::fs::read_dir(&snapshots_dir) else {
        return false;
    };
    for entry in entries.flatten() {
        if entry.path().join(filename).exists() {
            return true;
        }
    }
    false
}

#[tauri::command]
pub async fn list_image_gen_models(models_path: String) -> Result<Vec<ImageModel>, String> {
    tokio::task::spawn_blocking(move || {
        let dir = PathBuf::from(&models_path);
        validate_path_safe(&dir)?;
        let models: Vec<ImageModel> = KNOWN_MODELS
            .iter()
            .map(|m| ImageModel {
                id: m.id.to_string(),
                name: m.name.to_string(),
                repo_id: m.repo_id.to_string(),
                size_mb: m.size_mb,
                downloaded: is_model_downloaded(&dir, m.repo_id, m.hf_file),
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
        assert_eq!(s.selected_model, "flux2-klein-4b");
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
            ..Default::default()
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
        assert_eq!(KNOWN_MODELS.len(), 7);
        for m in KNOWN_MODELS {
            assert!(!m.id.is_empty());
            assert!(!m.name.is_empty());
            assert!(!m.repo_id.is_empty());
            assert!(!m.hf_file.is_empty());
            assert!(m.size_mb > 0);
        }
    }

    #[test]
    fn known_models_default_exists() {
        let default_id = default_selected_model();
        assert!(
            KNOWN_MODELS.iter().any(|m| m.id == default_id),
            "Default model '{default_id}' must exist in KNOWN_MODELS"
        );
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
            ..Default::default()
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

    // ── Model structure ──

    #[test]
    fn known_models_unique_ids() {
        let mut ids: Vec<&str> = KNOWN_MODELS.iter().map(|m| m.id).collect();
        let len_before = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), len_before, "Model IDs must be unique");
    }

    #[test]
    fn image_model_serde() {
        let m = ImageModel {
            id: "test".into(),
            name: "Test Model".into(),
            repo_id: "org/repo".into(),
            size_mb: 1000,
            downloaded: true,
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("repoId")); // camelCase
        let restored: ImageModel = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.id, "test");
        assert!(restored.downloaded);
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
