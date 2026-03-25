use hf_hub::api::sync::ApiBuilder;
use std::path::PathBuf;
use tracing::{error, info, warn};

use crate::files::validate_path_safe;
use crate::image_gen::KNOWN_MODELS;

/// Parse a HuggingFace URL into (repo_id, filename).
/// Supports: https://huggingface.co/{org}/{repo}/resolve/main/{filename}
///           https://huggingface.co/{org}/{repo}/blob/main/{filename}
fn parse_hf_url(url: &str) -> Result<(String, String), String> {
    let url = url.trim();

    let path = url
        .strip_prefix("https://huggingface.co/")
        .or_else(|| url.strip_prefix("http://huggingface.co/"))
        .ok_or_else(|| format!("Not a HuggingFace URL: {url}"))?;

    // path: {org}/{repo}/resolve/main/{filename...}
    //    or {org}/{repo}/blob/main/{filename...}
    let parts: Vec<&str> = path.splitn(5, '/').collect();
    if parts.len() < 5 {
        return Err(format!("Cannot parse HuggingFace URL: {url}"));
    }

    let org = parts[0];
    let repo = parts[1];
    let kind = parts[2]; // "resolve" or "blob"
    // parts[3] = "main" (branch)
    let filename = parts[4];

    if kind != "resolve" && kind != "blob" {
        warn!("Unexpected URL segment '{kind}', expected 'resolve' or 'blob'");
    }

    if org.is_empty() || repo.is_empty() || filename.is_empty() {
        return Err(format!("Invalid HuggingFace URL components: {url}"));
    }

    Ok((format!("{org}/{repo}"), filename.to_string()))
}

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

#[tauri::command]
pub async fn download_model_by_url(
    url: String,
    models_path: String,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let dir = PathBuf::from(&models_path);
        validate_path_safe(&dir)?;

        let (repo_id, filename) = parse_hf_url(&url)?;

        info!(
            repo_id = %repo_id,
            filename = %filename,
            "Downloading model by URL"
        );

        let api = ApiBuilder::new()
            .with_cache_dir(dir)
            .build()
            .map_err(|e| format!("Failed to init HF API: {e}"))?;

        let repo = api.model(repo_id.clone());
        let path = repo.get(&filename).map_err(|e| {
            error!(repo_id = %repo_id, filename = %filename, "Download failed: {e}");
            format!("Failed to download {filename} from {repo_id}: {e}")
        })?;

        info!(path = %path.display(), "Model downloaded successfully");

        Ok(serde_json::json!({
            "status": "ok",
            "path": path.to_string_lossy()
        }))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
