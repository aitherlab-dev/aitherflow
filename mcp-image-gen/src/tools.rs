use crate::config::Config;
use chrono::Utc;
use diffusion_rs::api::gen_img;
use diffusion_rs::preset::{
    Flux1MiniWeight, Flux1Weight, Flux2Klein4BWeight, Flux2Klein9BWeight, Flux2Weight, Preset,
    PresetBuilder,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path};
use tracing::{error, info};

/// Validate that a path is safe: no traversal components, must be absolute.
pub fn validate_path_safe(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("Path must be absolute: {}", path.display()));
    }
    for component in path.components() {
        if matches!(component, Component::ParentDir) {
            return Err(format!(
                "Path traversal detected (..): {}",
                path.display()
            ));
        }
    }
    Ok(())
}

pub fn generate_image(params: &Value, config: &Config) -> Result<String, String> {
    let args = params.get("arguments").ok_or("Missing arguments")?;

    let prompt = args
        .get("prompt")
        .and_then(|v| v.as_str())
        .ok_or("Missing required parameter: prompt")?
        .to_string();

    let negative_prompt = args
        .get("negative_prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let width = args
        .get("width")
        .and_then(|v| v.as_i64())
        .and_then(|v| i32::try_from(v).ok())
        .unwrap_or(config.width);

    let height = args
        .get("height")
        .and_then(|v| v.as_i64())
        .and_then(|v| i32::try_from(v).ok())
        .unwrap_or(config.height);

    let steps = args
        .get("steps")
        .and_then(|v| v.as_i64())
        .and_then(|v| i32::try_from(v).ok())
        .unwrap_or(config.steps);

    let seed = args
        .get("seed")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);

    // Validate output path
    validate_path_safe(&config.images_path)?;

    // Generate output filename: timestamp + short hash of prompt
    let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
    let mut hasher = Sha256::new();
    hasher.update(prompt.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let short_hash = &hash[..8];
    let filename = format!("{timestamp}_{short_hash}.png");
    let output_path = config.images_path.join(&filename);

    // Validate the full output path too
    validate_path_safe(&output_path)?;

    info!(
        prompt = %prompt,
        width = width,
        height = height,
        steps = steps,
        seed = seed,
        output = %output_path.display(),
        "Generating image"
    );

    let preset = resolve_preset(&config.selected_model)?;

    let out = output_path.clone();
    let neg = negative_prompt.clone();

    let (img_config, mut model_config) = PresetBuilder::default()
        .preset(preset)
        .prompt(prompt.clone())
        .with_modifier(move |mut configs| {
            configs.0.width(width);
            configs.0.height(height);
            configs.0.steps(steps);
            configs.0.seed(seed);
            configs.0.output(out);
            if !neg.is_empty() {
                configs.0.negative_prompt(neg);
            }
            Ok(configs)
        })
        .build()
        .map_err(|e| format!("Failed to build config: {e}"))?;

    gen_img(&img_config, &mut model_config).map_err(|e| {
        error!("Image generation failed: {e}");
        format!("Image generation failed: {e}")
    })?;

    info!("Image saved to {}", output_path.display());

    let result = serde_json::json!({
        "path": output_path.to_string_lossy(),
        "width": width,
        "height": height,
        "steps": steps,
        "seed": seed,
        "prompt": prompt
    });

    Ok(result.to_string())
}

pub fn list_models(config: &Config) -> Result<String, String> {
    let models_dir = &config.models_path;

    if !models_dir.exists() {
        return Ok(
            "No models directory found. Models will be downloaded automatically on first use."
                .into(),
        );
    }

    let entries = fs::read_dir(models_dir)
        .map_err(|e| format!("Failed to read models directory: {e}"))?;

    let mut models = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        let ft = entry
            .file_type()
            .map_err(|e| format!("Failed to get file type: {e}"))?;

        if ft.is_dir() || ft.is_file() {
            let name = entry.file_name().to_string_lossy().to_string();
            let kind = if ft.is_dir() { "directory" } else { "file" };
            models.push(format!("  - {} ({})", name, kind));
        }
    }

    if models.is_empty() {
        return Ok(
            "No models found. Models will be downloaded automatically on first use.".into(),
        );
    }

    let mut result = format!(
        "Models directory: {}\n\nAvailable models:\n",
        models_dir.display()
    );
    result.push_str(&models.join("\n"));
    result.push_str(&format!("\n\nDefault model: {}", config.selected_model));

    Ok(result)
}

pub fn download_model(params: &Value, config: &Config) -> Result<String, String> {
    let args = params.get("arguments").ok_or("Missing arguments")?;

    let model_id = args
        .get("model_id")
        .and_then(|v| v.as_str())
        .ok_or("Missing required parameter: model_id")?;

    info!(model_id = model_id, "Downloading model");

    let preset = resolve_preset(model_id)?;

    // Building a PresetBuilder triggers HF Hub download (HF_HOME is set in main)
    let (_img_config, _model_config) = PresetBuilder::default()
        .preset(preset)
        .prompt("test".to_string())
        .build()
        .map_err(|e| {
            error!("Model download failed: {e}");
            format!("Model download failed: {e}")
        })?;

    info!(model_id = model_id, "Model downloaded successfully");

    let result = serde_json::json!({
        "status": "ok",
        "model": model_id,
        "path": config.models_path.to_string_lossy()
    });

    Ok(result.to_string())
}

fn resolve_preset(model_name: &str) -> Result<Preset, String> {
    match model_name {
        "FLUX.2-klein-4B" | "flux2-klein-4b" => {
            Ok(Preset::Flux2Klein4B(Flux2Klein4BWeight::default()))
        }
        "FLUX.2-klein-9B" | "flux2-klein-9b" => {
            Ok(Preset::Flux2Klein9B(Flux2Klein9BWeight::default()))
        }
        "FLUX.2-dev" | "flux2-dev" => Ok(Preset::Flux2Dev(Flux2Weight::default())),
        "FLUX.1-dev" | "flux1-dev" => Ok(Preset::Flux1Dev(Flux1Weight::default())),
        "FLUX.1-schnell" | "flux1-schnell" => Ok(Preset::Flux1Schnell(Flux1Weight::default())),
        "FLUX.1-mini" | "flux1-mini" => Ok(Preset::Flux1Mini(Flux1MiniWeight::default())),
        "SDXL-turbo" | "sdxl-turbo" => Ok(Preset::SDXLTurbo1_0),
        _ => Err(format!(
            "Unknown model: {model_name}. Supported: FLUX.2-klein-4B, FLUX.2-klein-9B, FLUX.2-dev, FLUX.1-dev, FLUX.1-schnell, FLUX.1-mini, SDXL-turbo"
        )),
    }
}
