use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tracing::{info, warn};

use crate::config;
use crate::file_ops::{atomic_write, read_json, write_json};
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

/// Repo+file pair for a HuggingFace component (matches MCP server format).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoFile {
    pub repo: String,
    pub file: String,
}

/// Model definition as stored in ~/.config/aither-flow/image-gen/models.json.
/// Shared format between MCP server and Tauri app.
// Keep in sync with mcp-image-gen/src/tools.rs::ModelDefinition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDefinition {
    pub id: String,
    pub name: String,
    pub diffusion: RepoFile,
    #[serde(default)]
    pub vae: Option<RepoFile>,
    #[serde(default)]
    pub llm: Option<RepoFile>,
    #[serde(default)]
    pub clip_l: Option<RepoFile>,
    #[serde(default)]
    pub t5xxl: Option<RepoFile>,
    #[serde(default)]
    pub single_file: bool,
    #[serde(default = "default_json_steps")]
    pub steps: i32,
    #[serde(default = "default_json_cfg_scale")]
    pub cfg_scale: f32,
    #[serde(default = "default_size")]
    pub width: i32,
    #[serde(default = "default_size")]
    pub height: i32,
    #[serde(default)]
    pub offload_cpu: bool,
    #[serde(default)]
    pub flash_attn: bool,
    #[serde(default)]
    pub vae_tiling: bool,
    #[serde(default)]
    pub size_mb: u64,
    #[serde(default)]
    pub lora: Option<String>,
    #[serde(default = "default_lora_strength")]
    pub lora_strength: f32,
    #[serde(default = "default_true")]
    pub lora_enabled: bool,
}

fn default_json_steps() -> i32 { 4 }
fn default_json_cfg_scale() -> f32 { 1.0 }
fn default_lora_strength() -> f32 { 1.0 }

/// Model info returned to frontend
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageModel {
    pub id: String,
    pub name: String,
    pub repo_id: String,
    pub size_mb: u64,
    pub downloaded: bool,
    pub lora: Option<String>,
    pub lora_strength: f32,
    pub lora_enabled: bool,
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
    #[serde(default)]
    pub lora_directory: String,
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
            lora_directory: String::new(),
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

/// Default model used as fallback when models.json doesn't exist.
fn default_model_definition() -> ModelDefinition {
    ModelDefinition {
        id: "flux2-klein-4b".into(),
        name: "FLUX.2 Klein 4B".into(),
        diffusion: RepoFile {
            repo: "leejet/FLUX.2-klein-4B-GGUF".into(),
            file: "flux-2-klein-4b-Q8_0.gguf".into(),
        },
        vae: Some(RepoFile {
            repo: "black-forest-labs/FLUX.2-dev".into(),
            file: "vae/diffusion_pytorch_model.safetensors".into(),
        }),
        llm: Some(RepoFile {
            repo: "unsloth/Qwen3-4B-GGUF".into(),
            file: "Qwen3-4B-Q8_0.gguf".into(),
        }),
        clip_l: None,
        t5xxl: None,
        single_file: false,
        steps: 4,
        cfg_scale: 1.0,
        width: 1024,
        height: 1024,
        offload_cpu: true,
        flash_attn: true,
        vae_tiling: true,
        size_mb: 4403,
        lora: None,
        lora_strength: 1.0,
        lora_enabled: true,
    }
}

/// Path to the shared models.json config file.
pub fn models_json_path() -> PathBuf {
    config::config_dir().join("image-gen").join("models.json")
}

/// Load model definitions from models.json.
/// Creates the file with the default model if it doesn't exist.
pub fn load_model_definitions() -> Result<Vec<ModelDefinition>, String> {
    let path = models_json_path();

    if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
        let models: Vec<ModelDefinition> = serde_json::from_str(&content)
            .map_err(|e| {
                warn!("Failed to parse {}: {e}, using defaults", path.display());
                format!("Failed to parse {}: {e}", path.display())
            })?;
        info!("Loaded {} model(s) from {}", models.len(), path.display());
        Ok(models)
    } else {
        info!("No models.json found, creating default at {}", path.display());
        let models = vec![default_model_definition()];
        save_model_definitions(&path, &models)?;
        Ok(models)
    }
}

/// Write model definitions to models.json atomically.
pub fn save_model_definitions(path: &Path, models: &[ModelDefinition]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create dir {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(models)
        .map_err(|e| format!("Failed to serialize models: {e}"))?;
    atomic_write(path, json.as_bytes())
}

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
        let definitions = load_model_definitions()?;
        let models: Vec<ImageModel> = definitions
            .iter()
            .map(|m| ImageModel {
                id: m.id.clone(),
                name: m.name.clone(),
                repo_id: m.diffusion.repo.clone(),
                size_mb: m.size_mb,
                downloaded: is_model_downloaded(&dir, &m.diffusion.repo, &m.diffusion.file),
                lora: m.lora.clone(),
                lora_strength: m.lora_strength,
                lora_enabled: m.lora_enabled,
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

#[tauri::command]
pub async fn add_image_gen_model(model: ModelDefinition) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut models = load_model_definitions()?;
        if models.iter().any(|m| m.id == model.id) {
            return Err(format!("Model with id '{}' already exists", model.id));
        }
        models.push(model);
        save_model_definitions(&models_json_path(), &models)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn remove_image_gen_model(model_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        if model_id == default_model_definition().id {
            return Err("Cannot remove the default model".into());
        }
        let mut models = load_model_definitions()?;
        let before = models.len();
        models.retain(|m| m.id != model_id);
        if models.len() == before {
            return Err(format!("Model '{}' not found", model_id));
        }
        save_model_definitions(&models_json_path(), &models)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn update_image_gen_model_lora(
    model_id: String,
    lora_path: Option<String>,
    lora_strength: f32,
    enabled: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        if let Some(ref p) = lora_path {
            validate_path_safe(Path::new(p))?;
        }
        let mut models = load_model_definitions()?;
        let model = models
            .iter_mut()
            .find(|m| m.id == model_id)
            .ok_or_else(|| format!("Model '{}' not found", model_id))?;
        model.lora = lora_path;
        model.lora_strength = lora_strength;
        model.lora_enabled = enabled;
        save_model_definitions(&models_json_path(), &models)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn list_lora_files(directory: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        if directory.is_empty() {
            return Ok(Vec::new());
        }
        let dir = PathBuf::from(&directory);
        validate_path_safe(&dir)?;
        if !dir.is_dir() {
            return Ok(Vec::new());
        }
        let mut files: Vec<String> = Vec::new();
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| format!("Failed to read {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let ft = entry.file_type();
            if ft.map(|t| t.is_file()).unwrap_or(false) {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".safetensors") {
                    files.push(name);
                }
            }
        }
        files.sort();
        Ok(files)
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
    fn default_model_definition_valid() {
        let def = default_model_definition();
        assert_eq!(def.id, "flux2-klein-4b");
        assert_eq!(def.name, "FLUX.2 Klein 4B");
        assert!(!def.diffusion.repo.is_empty());
        assert!(!def.diffusion.file.is_empty());
        assert!(def.vae.is_some());
        assert!(def.llm.is_some());
        assert!(def.size_mb > 0);
    }

    #[test]
    fn default_model_matches_selected() {
        let default_id = default_selected_model();
        let def = default_model_definition();
        assert_eq!(def.id, default_id, "Default model definition must match default_selected_model()");
    }

    #[test]
    fn model_definition_serde_roundtrip() {
        let def = default_model_definition();
        let json = serde_json::to_string_pretty(&def).unwrap();
        let restored: ModelDefinition = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.id, def.id);
        assert_eq!(restored.steps, def.steps);
        assert_eq!(restored.diffusion.repo, def.diffusion.repo);
    }

    #[test]
    fn model_definitions_json_array() {
        let models = vec![default_model_definition()];
        let json = serde_json::to_string_pretty(&models).unwrap();
        let restored: Vec<ModelDefinition> = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].id, "flux2-klein-4b");
    }

    #[test]
    fn save_and_load_model_definitions() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("models.json");
        let models = vec![default_model_definition()];
        save_model_definitions(&path, &models).unwrap();
        assert!(path.exists());

        let content = fs::read_to_string(&path).unwrap();
        let loaded: Vec<ModelDefinition> = serde_json::from_str(&content).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "flux2-klein-4b");
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
    fn image_model_serde() {
        let m = ImageModel {
            id: "test".into(),
            name: "Test Model".into(),
            repo_id: "org/repo".into(),
            size_mb: 1000,
            downloaded: true,
            lora: Some("/path/to/lora.safetensors".into()),
            lora_strength: 0.8,
            lora_enabled: true,
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
