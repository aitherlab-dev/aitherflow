use hf_hub::api::sync::ApiBuilder;
use std::path::PathBuf;
use tracing::{error, info};

use crate::files::validate_path_safe;
use crate::image_gen::KNOWN_MODELS;

#[tauri::command]
pub async fn download_image_gen_model(
    models_path: String,
    model_id: String,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let dir = PathBuf::from(&models_path);
        validate_path_safe(&dir)?;

        let model = KNOWN_MODELS
            .iter()
            .find(|m| m.id == model_id)
            .ok_or_else(|| format!("Unknown model: {model_id}"))?;

        info!(
            model_id = model.id,
            repo = model.repo_id,
            file = model.hf_file,
            "Downloading model from HuggingFace"
        );

        let api = ApiBuilder::new()
            .with_cache_dir(dir)
            .build()
            .map_err(|e| format!("Failed to init HF API: {e}"))?;

        let repo = api.model(model.repo_id.to_string());
        let path = repo.get(model.hf_file).map_err(|e| {
            error!(model_id = model.id, "Download failed: {e}");
            format!("Failed to download {}: {e}", model.name)
        })?;

        info!(
            model_id = model.id,
            path = %path.display(),
            "Model downloaded successfully"
        );

        Ok(serde_json::json!({
            "status": "ok",
            "modelId": model.id,
            "path": path.to_string_lossy()
        }))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
