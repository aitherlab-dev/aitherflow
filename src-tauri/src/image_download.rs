use hf_hub::api::sync::ApiBuilder;
use std::path::{Path, PathBuf};
use tracing::{error, info, warn};

use crate::files::validate_path_safe;
use crate::image_gen::{
    load_model_definitions, models_json_path, save_model_definitions, ModelDefinition, RepoFile,
};

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

        let definitions = load_model_definitions()?;
        let model = definitions
            .iter()
            .find(|m| m.id == model_id)
            .ok_or_else(|| format!("Unknown model: {model_id}"))?;

        info!(
            model_id = %model.id,
            repo = %model.diffusion.repo,
            file = %model.diffusion.file,
            "Downloading model and all components from HuggingFace"
        );

        let api = ApiBuilder::new()
            .with_cache_dir(dir)
            .build()
            .map_err(|e| format!("Failed to init HF API: {e}"))?;

        // Helper: download a single component, skip if already cached
        let download_component = |rf: &RepoFile, label: &str| -> Result<(), String> {
            info!(component = label, repo = %rf.repo, file = %rf.file, "Downloading component");
            let repo_api = api.model(rf.repo.clone());
            repo_api.get(&rf.file).map_err(|e| {
                error!(component = label, repo = %rf.repo, file = %rf.file, "Download failed: {e}");
                format!("Failed to download {label} ({}/{}): {e}", rf.repo, rf.file)
            })?;
            info!(component = label, "Component ready");
            Ok(())
        };

        // 1. Diffusion model (main)
        download_component(&model.diffusion, "diffusion")?;

        // 2. VAE
        if let Some(ref vae) = model.vae {
            download_component(vae, "vae")?;
        }

        // 3. LLM encoder
        if let Some(ref llm) = model.llm {
            download_component(llm, "llm")?;
        }

        // 4. CLIP-L
        if let Some(ref clip_l) = model.clip_l {
            download_component(clip_l, "clip_l")?;
        }

        // 5. T5-XXL
        if let Some(ref t5xxl) = model.t5xxl {
            download_component(t5xxl, "t5xxl")?;
        }

        info!(model_id = %model.id, "All components downloaded successfully");

        Ok(serde_json::json!({
            "status": "ok",
            "modelId": model.id
        }))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Detect model type from filename and build a ModelDefinition.
fn build_definition_from_filename(filename: &str, repo_id: &str) -> ModelDefinition {
    let lower = filename.to_lowercase();
    let stem = Path::new(filename)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let id = stem
        .to_lowercase()
        .replace(' ', "-")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>();
    let name = stem.replace(['-', '_'], " ");

    let mut def = ModelDefinition {
        id,
        name,
        diffusion: RepoFile {
            repo: repo_id.to_string(),
            file: filename.to_string(),
        },
        vae: None,
        llm: None,
        clip_l: None,
        t5xxl: None,
        single_file: false,
        steps: 4,
        cfg_scale: 1.0,
        width: 1024,
        height: 1024,
        offload_cpu: false,
        flash_attn: false,
        vae_tiling: false,
        size_mb: 0,
        lora: None,
        lora_strength: 1.0,
        lora_enabled: true,
    };

    if lower.contains("z-image") || lower.contains("z_image") {
        // Z-Image: FLUX.1 VAE + Qwen3 LLM
        def.vae = Some(RepoFile {
            repo: "ffxvs/vae-flux".into(),
            file: "ae.safetensors".into(),
        });
        def.llm = Some(RepoFile {
            repo: "unsloth/Qwen3-4B-GGUF".into(),
            file: "Qwen3-4B-Q8_0.gguf".into(),
        });
        def.steps = 8;
        def.offload_cpu = true;
        def.flash_attn = true;
        def.vae_tiling = true;
    } else if lower.contains("flux-2") || lower.contains("flux2") {
        // FLUX.2: FLUX.2 VAE + Qwen3 LLM
        def.vae = Some(RepoFile {
            repo: "black-forest-labs/FLUX.2-dev".into(),
            file: "vae/diffusion_pytorch_model.safetensors".into(),
        });
        def.llm = Some(RepoFile {
            repo: "unsloth/Qwen3-4B-GGUF".into(),
            file: "Qwen3-4B-Q8_0.gguf".into(),
        });
        def.steps = 4;
        def.offload_cpu = true;
        def.flash_attn = true;
        def.vae_tiling = true;
    } else if lower.contains("flux-1")
        || lower.contains("flux1")
        || lower.contains("flux-schnell")
        || lower.contains("flux-dev")
    {
        // FLUX.1: FLUX.1 VAE + CLIP-L + T5-XXL
        def.vae = Some(RepoFile {
            repo: "ffxvs/vae-flux".into(),
            file: "ae.safetensors".into(),
        });
        def.clip_l = Some(RepoFile {
            repo: "comfyanonymous/flux_text_encoders".into(),
            file: "clip_l.safetensors".into(),
        });
        def.t5xxl = Some(RepoFile {
            repo: "Green-Sky/flux.1-schnell-GGUF".into(),
            file: "t5xxl_q8_0.gguf".into(),
        });
        def.steps = 28;
        def.vae_tiling = true;
    } else {
        // Fallback: SDXL single-file
        def.vae = Some(RepoFile {
            repo: "madebyollin/sdxl-vae-fp16-fix".into(),
            file: "sdxl.vae.safetensors".into(),
        });
        def.single_file = true;
        def.steps = 4;
    }

    def
}

/// Try to register a downloaded model in models.json (skip if id already exists).
fn auto_register_model(def: &ModelDefinition) {
    match load_model_definitions() {
        Ok(mut models) => {
            if models.iter().any(|m| m.id == def.id) {
                info!(id = %def.id, "Model already registered, skipping");
                return;
            }
            models.push(def.clone());
            if let Err(e) = save_model_definitions(&models_json_path(), &models) {
                warn!("Failed to auto-register model: {e}");
            } else {
                info!(id = %def.id, name = %def.name, "Model auto-registered in models.json");
            }
        }
        Err(e) => warn!("Failed to load model definitions for auto-register: {e}"),
    }
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

        // Auto-register in models.json
        let mut def = build_definition_from_filename(&filename, &repo_id);
        if let Ok(meta) = std::fs::metadata(&path) {
            def.size_mb = meta.len() / (1024 * 1024);
        }
        auto_register_model(&def);

        Ok(serde_json::json!({
            "status": "ok",
            "modelId": def.id,
            "path": path.to_string_lossy()
        }))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
