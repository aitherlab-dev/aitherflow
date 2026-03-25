use hf_hub::api::sync::{ApiBuilder, ApiRepo};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tracing::{error, info, warn};

use crate::files::validate_path_safe;
use crate::image_gen::KNOWN_MODELS;

const STALE_LOCK_AGE: Duration = Duration::from_secs(5 * 60);

/// Remove .lock files older than 5 minutes in the HF cache for a given repo.
/// HF Hub cache layout: {cache_dir}/models--{org}--{repo}/blobs/*.lock
fn cleanup_stale_locks(cache_dir: &Path, repo_id: &str) {
    let repo_dir_name = format!("models--{}", repo_id.replace('/', "--"));
    let blobs_dir = cache_dir.join(repo_dir_name).join("blobs");

    let entries = match std::fs::read_dir(&blobs_dir) {
        Ok(e) => e,
        Err(_) => return, // dir doesn't exist yet — nothing to clean
    };

    let now = SystemTime::now();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("lock") {
            continue;
        }
        let age = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| now.duration_since(t).ok());

        if let Some(age) = age {
            if age > STALE_LOCK_AGE {
                warn!(path = %path.display(), age_secs = age.as_secs(), "Removing stale lock");
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// Remove ALL lock files for a repo (used after a failed download).
fn force_cleanup_locks(cache_dir: &Path, repo_id: &str) {
    let repo_dir_name = format!("models--{}", repo_id.replace('/', "--"));
    let blobs_dir = cache_dir.join(repo_dir_name).join("blobs");

    let entries = match std::fs::read_dir(&blobs_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("lock") {
            warn!(path = %path.display(), "Force-removing lock after failure");
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Download a file via hf-hub with stale lock cleanup and one retry on lock failure.
fn download_with_retry(
    repo: &ApiRepo,
    filename: &str,
    cache_dir: &Path,
    repo_id: &str,
) -> Result<PathBuf, String> {
    match repo.get(filename) {
        Ok(path) => Ok(path),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("Lock") || msg.contains("lock") {
                warn!(repo_id = repo_id, "Lock error, cleaning up and retrying");
                force_cleanup_locks(cache_dir, repo_id);
                repo.get(filename)
                    .map_err(|e2| format!("Retry failed: {e2}"))
            } else {
                force_cleanup_locks(cache_dir, repo_id);
                Err(msg)
            }
        }
    }
}

/// Parse a HuggingFace URL into (repo_id, filename).
/// Supports: https://huggingface.co/{org}/{repo}/resolve/main/{filename}
///           https://huggingface.co/{org}/{repo}/blob/main/{filename}
fn parse_hf_url(url: &str) -> Result<(String, String), String> {
    let url = url.trim();

    let path = url
        .strip_prefix("https://huggingface.co/")
        .or_else(|| url.strip_prefix("http://huggingface.co/"))
        .ok_or_else(|| format!("Not a HuggingFace URL: {url}"))?;

    let parts: Vec<&str> = path.splitn(5, '/').collect();
    if parts.len() < 5 {
        return Err(format!("Cannot parse HuggingFace URL: {url}"));
    }

    let org = parts[0];
    let repo = parts[1];
    let kind = parts[2];
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

        cleanup_stale_locks(&dir, model.repo_id);

        let api = ApiBuilder::new()
            .with_cache_dir(dir.clone())
            .build()
            .map_err(|e| format!("Failed to init HF API: {e}"))?;

        let repo = api.model(model.repo_id.to_string());
        let path = download_with_retry(&repo, model.hf_file, &dir, model.repo_id)
            .map_err(|e| {
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

        cleanup_stale_locks(&dir, &repo_id);

        let api = ApiBuilder::new()
            .with_cache_dir(dir.clone())
            .build()
            .map_err(|e| format!("Failed to init HF API: {e}"))?;

        let repo = api.model(repo_id.clone());
        let path = download_with_retry(&repo, &filename, &dir, &repo_id)
            .map_err(|e| {
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
