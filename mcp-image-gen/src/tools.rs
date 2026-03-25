use crate::config::Config;
use chrono::Utc;
use diffusion_rs::api::{gen_img, ConfigBuilder, ModelConfigBuilder};
use hf_hub::api::sync::ApiBuilder;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tracing::{error, info, warn};

/// Redirect diffusion-rs C++ log and progress output to stderr
/// (instead of stdout which would corrupt MCP JSON-RPC).
/// Uses the stable-diffusion.cpp callback API.
/// Call once at startup before any gen_img() calls.
pub fn suppress_diffusion_output() {
    unsafe extern "C" fn stderr_log(
        _level: diffusion_rs_sys::sd_log_level_t,
        text: *const std::os::raw::c_char,
        _data: *mut std::ffi::c_void,
    ) {
        if !text.is_null() {
            let msg = std::ffi::CStr::from_ptr(text).to_string_lossy();
            eprint!("[sdcpp] {msg}");
        }
    }
    unsafe extern "C" fn noop_progress(
        _step: std::os::raw::c_int,
        _steps: std::os::raw::c_int,
        _time: f32,
        _data: *mut std::ffi::c_void,
    ) {
    }

    unsafe {
        diffusion_rs_sys::sd_set_log_callback(Some(stderr_log), std::ptr::null_mut());
        diffusion_rs_sys::sd_set_progress_callback(Some(noop_progress), std::ptr::null_mut());
    }
}

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

/// Download a file from HuggingFace Hub into models_path (used as cache dir).
fn download_hf_file(models_path: &Path, repo: &str, file: &str) -> Result<PathBuf, String> {
    let mut builder = ApiBuilder::new()
        .with_cache_dir(models_path.to_path_buf())
        .with_progress(false);

    // Try HF_TOKEN env first, then models_path/token file
    let token = std::env::var("HF_TOKEN")
        .ok()
        .filter(|t| !t.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string(models_path.join("token"))
                .ok()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
        });

    if let Some(t) = token {
        builder = builder.with_token(Some(t));
    }

    let api = builder.build().map_err(|e| format!("Failed to build HF API: {e}"))?;
    let repo_api = api.model(repo.to_string());
    repo_api.get(file).map_err(|e| {
        let msg = format!("Failed to download {repo}/{file}: {e}");
        let err_lower = e.to_string().to_lowercase();
        if err_lower.contains("401")
            || err_lower.contains("403")
            || err_lower.contains("unauthorized")
            || err_lower.contains("forbidden")
        {
            format!(
                "{msg}. This model requires a HuggingFace token and license acceptance. \
                 Set HF_TOKEN env variable and accept the license at huggingface.co"
            )
        } else {
            msg
        }
    })
}

/// Components needed for a model: (repo, file) pairs for each role.
#[derive(Debug)]
struct ModelComponents {
    /// Main diffusion model — set via .diffusion_model() for multi-component, .model() for single-file
    diffusion: (&'static str, &'static str),
    /// VAE decoder
    vae: Option<(&'static str, &'static str)>,
    /// LLM text encoder (Qwen3 for FLUX.2 Klein)
    llm: Option<(&'static str, &'static str)>,
    /// CLIP-L text encoder (for FLUX.1)
    clip_l: Option<(&'static str, &'static str)>,
    /// T5-XXL text encoder (for FLUX.1)
    t5xxl: Option<(&'static str, &'static str)>,
    /// Whether this is a single-file model (use .model() instead of .diffusion_model())
    single_file: bool,
    /// Default steps
    steps: i32,
    /// Default cfg_scale
    cfg_scale: f32,
    /// Default size
    width: i32,
    height: i32,
    /// Offload params to CPU
    offload_cpu: bool,
    /// Flash attention
    flash_attn: bool,
    /// VAE tiling
    vae_tiling: bool,
}

fn get_model_components(model_id: &str) -> Result<ModelComponents, String> {
    match model_id {
        "FLUX.2-klein-4B" | "flux2-klein-4b" => Ok(ModelComponents {
            diffusion: ("leejet/FLUX.2-klein-4B-GGUF", "flux-2-klein-4b-Q8_0.gguf"),
            vae: Some(("black-forest-labs/FLUX.2-dev", "vae/diffusion_pytorch_model.safetensors")),
            llm: Some(("unsloth/Qwen3-4B-GGUF", "Qwen3-4B-Q8_0.gguf")),
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
        }),
        "FLUX.2-klein-9B" | "flux2-klein-9b" => Ok(ModelComponents {
            diffusion: ("leejet/FLUX.2-klein-9B-GGUF", "flux-2-klein-9b-Q8_0.gguf"),
            vae: Some(("black-forest-labs/FLUX.2-dev", "vae/diffusion_pytorch_model.safetensors")),
            llm: Some(("unsloth/Qwen3-8B-GGUF", "Qwen3-8B-Q8_0.gguf")),
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
        }),
        "FLUX.2-dev" | "flux2-dev" => Ok(ModelComponents {
            diffusion: ("city96/FLUX.2-dev-gguf", "flux2-dev-Q2_K.gguf"),
            vae: Some(("black-forest-labs/FLUX.2-dev", "vae/diffusion_pytorch_model.safetensors")),
            llm: Some((
                "unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF",
                "Mistral-Small-3.2-24B-Instruct-2506-Q2_K.gguf",
            )),
            clip_l: None,
            t5xxl: None,
            single_file: false,
            steps: 20,
            cfg_scale: 1.0,
            width: 1024,
            height: 1024,
            offload_cpu: true,
            flash_attn: true,
            vae_tiling: true,
        }),
        "FLUX.1-dev" | "flux1-dev" => Ok(ModelComponents {
            diffusion: ("leejet/FLUX.1-dev-gguf", "flux1-dev-q8_0.gguf"),
            vae: Some(("ffxvs/vae-flux", "ae.safetensors")),
            llm: None,
            clip_l: Some(("comfyanonymous/flux_text_encoders", "clip_l.safetensors")),
            t5xxl: Some(("Green-Sky/flux.1-schnell-GGUF", "t5xxl_q8_0.gguf")),
            single_file: false,
            steps: 28,
            cfg_scale: 1.0,
            width: 1024,
            height: 1024,
            offload_cpu: false,
            flash_attn: false,
            vae_tiling: true,
        }),
        "FLUX.1-schnell" | "flux1-schnell" => Ok(ModelComponents {
            diffusion: ("leejet/FLUX.1-schnell-gguf", "flux1-schnell-q8_0.gguf"),
            vae: Some(("ffxvs/vae-flux", "ae.safetensors")),
            llm: None,
            clip_l: Some(("comfyanonymous/flux_text_encoders", "clip_l.safetensors")),
            t5xxl: Some(("Green-Sky/flux.1-schnell-GGUF", "t5xxl_q8_0.gguf")),
            single_file: false,
            steps: 4,
            cfg_scale: 1.0,
            width: 1024,
            height: 1024,
            offload_cpu: false,
            flash_attn: false,
            vae_tiling: true,
        }),
        "FLUX.1-mini" | "flux1-mini" => Ok(ModelComponents {
            diffusion: ("HyperX-Sentience/Flux-Mini-GGUF", "flux-mini-Q8_0.gguf"),
            vae: Some(("Green-Sky/flux.1-schnell-GGUF", "ae-f16.gguf")),
            llm: None,
            clip_l: Some(("Green-Sky/flux.1-schnell-GGUF", "clip_l-q8_0.gguf")),
            t5xxl: Some(("Green-Sky/flux.1-schnell-GGUF", "t5xxl_q8_0.gguf")),
            single_file: false,
            steps: 20,
            cfg_scale: 1.0,
            width: 1024,
            height: 1024,
            offload_cpu: false,
            flash_attn: false,
            vae_tiling: true,
        }),
        "SDXL-turbo" | "sdxl-turbo" => Ok(ModelComponents {
            diffusion: (
                "stabilityai/sdxl-turbo",
                "sd_xl_turbo_1.0_fp16.safetensors",
            ),
            vae: Some(("madebyollin/sdxl-vae-fp16-fix", "sdxl.vae.safetensors")),
            llm: None,
            clip_l: None,
            t5xxl: None,
            single_file: true,
            steps: 4,
            cfg_scale: 1.0,
            width: 1024,
            height: 1024,
            offload_cpu: false,
            flash_attn: false,
            vae_tiling: false,
        }),
        _ => Err(format!(
            "Unknown model: {model_id}. Supported: FLUX.2-klein-4B, FLUX.2-klein-9B, FLUX.2-dev, FLUX.1-dev, FLUX.1-schnell, FLUX.1-mini, SDXL-turbo"
        )),
    }
}

/// Build ConfigBuilder + ModelConfigBuilder from components, downloading files as needed.
fn build_model_config(
    components: &ModelComponents,
    models_path: &Path,
    diffusion_override: Option<PathBuf>,
) -> Result<(ConfigBuilder, ModelConfigBuilder), String> {
    let mut config = ConfigBuilder::default();
    let mut model_config = ModelConfigBuilder::default();

    // Download/resolve diffusion model
    let diffusion_path = match diffusion_override {
        Some(p) => p,
        None => download_hf_file(models_path, components.diffusion.0, components.diffusion.1)?,
    };

    if components.single_file {
        model_config.model(diffusion_path);
    } else {
        model_config.diffusion_model(diffusion_path);
    }

    // VAE
    if let Some((repo, file)) = components.vae {
        let vae_path = download_hf_file(models_path, repo, file)?;
        model_config.vae(vae_path);
    }

    // LLM (Qwen3 for FLUX.2 Klein, Mistral for FLUX.2 dev)
    if let Some((repo, file)) = components.llm {
        let llm_path = download_hf_file(models_path, repo, file)?;
        model_config.llm(llm_path);
    }

    // CLIP-L (for FLUX.1)
    if let Some((repo, file)) = components.clip_l {
        let clip_l_path = download_hf_file(models_path, repo, file)?;
        model_config.clip_l(clip_l_path);
    }

    // T5-XXL (for FLUX.1)
    if let Some((repo, file)) = components.t5xxl {
        let t5_path = download_hf_file(models_path, repo, file)?;
        model_config.t5xxl(t5_path);
    }

    // Model-specific flags
    if components.offload_cpu {
        model_config.offload_params_to_cpu(true);
    }
    if components.flash_attn {
        model_config.flash_attention(true);
    }
    if components.vae_tiling {
        model_config.vae_tiling(true);
    }

    config
        .cfg_scale(components.cfg_scale)
        .steps(components.steps)
        .width(components.width)
        .height(components.height);

    Ok((config, model_config))
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

    // Resolve model: either a known id or a file path
    let (components, diffusion_override) = resolve_model(&config.selected_model)?;

    // Build configs with direct paths (no PresetBuilder)
    let (mut img_config_builder, model_config_builder) =
        build_model_config(&components, &config.models_path, diffusion_override)?;

    // Apply user overrides
    let out = output_path.clone();
    let neg = negative_prompt.clone();
    img_config_builder
        .width(width)
        .height(height)
        .steps(steps)
        .seed(seed)
        .output(out)
        .prompt(prompt.clone());
    if !neg.is_empty() {
        img_config_builder.negative_prompt(neg);
    }

    let img_config = img_config_builder
        .build()
        .map_err(|e| format!("Failed to build image config: {e}"))?;
    let mut model_config = model_config_builder
        .build()
        .map_err(|e| format!("Failed to build model config: {e}"))?;

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

    let components = get_model_components(model_id)?;

    // Download all components
    download_hf_file(&config.models_path, components.diffusion.0, components.diffusion.1)?;
    if let Some((repo, file)) = components.vae {
        download_hf_file(&config.models_path, repo, file)?;
    }
    if let Some((repo, file)) = components.llm {
        download_hf_file(&config.models_path, repo, file)?;
    }
    if let Some((repo, file)) = components.clip_l {
        download_hf_file(&config.models_path, repo, file)?;
    }
    if let Some((repo, file)) = components.t5xxl {
        download_hf_file(&config.models_path, repo, file)?;
    }

    info!(model_id = model_id, "Model downloaded successfully");

    let result = serde_json::json!({
        "status": "ok",
        "model": model_id,
        "path": config.models_path.to_string_lossy()
    });

    Ok(result.to_string())
}

/// Check if selected_model is a file path or a model id.
/// Returns (ModelComponents, Option<PathBuf>) — components for config scaffolding,
/// and optional path override for diffusion_model.
fn resolve_model(selected: &str) -> Result<(ModelComponents, Option<PathBuf>), String> {
    // If it looks like a file path — extract components from filename
    if selected.contains('/') || selected.ends_with(".gguf") || selected.ends_with(".safetensors") {
        let path = PathBuf::from(selected);
        if !path.exists() {
            return Err(format!("Model file not found: {selected}"));
        }
        let filename = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let model_id = model_id_from_filename(&filename);
        let components = get_model_components(model_id)?;
        info!(path = selected, "Using model file directly");
        Ok((components, Some(path)))
    } else {
        let components = get_model_components(selected)?;
        Ok((components, None))
    }
}

/// Match a filename to the closest model id (for config scaffolding: vae, clip, steps, etc.)
fn model_id_from_filename(filename: &str) -> &'static str {
    if filename.contains("klein") && filename.contains("4b") {
        "flux2-klein-4b"
    } else if filename.contains("klein") && filename.contains("9b") {
        "flux2-klein-9b"
    } else if filename.contains("flux") && filename.contains("2") && filename.contains("dev") {
        "flux2-dev"
    } else if filename.contains("flux") && filename.contains("schnell") {
        "flux1-schnell"
    } else if filename.contains("flux") && filename.contains("mini") {
        "flux1-mini"
    } else if filename.contains("flux") && filename.contains("1") && filename.contains("dev") {
        "flux1-dev"
    } else if filename.contains("sdxl") || filename.contains("sd_xl") {
        "sdxl-turbo"
    } else if filename.contains("sd") && filename.contains("turbo") {
        "sdxl-turbo"
    } else {
        warn!("Cannot determine model type from filename '{filename}', defaulting to FLUX.1 Schnell");
        "flux1-schnell"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ── get_model_components ──

    #[test]
    fn test_get_model_components_all_ids() {
        let ids = [
            "flux2-klein-4b",
            "flux2-klein-9b",
            "flux2-dev",
            "flux1-dev",
            "flux1-schnell",
            "flux1-mini",
            "sdxl-turbo",
        ];
        for id in ids {
            let result = get_model_components(id);
            assert!(result.is_ok(), "get_model_components({id}) failed: {:?}", result.err());
        }
    }

    #[test]
    fn test_get_model_components_uppercase() {
        assert!(get_model_components("FLUX.2-klein-4B").is_ok());
        assert!(get_model_components("FLUX.1-schnell").is_ok());
        assert!(get_model_components("SDXL-turbo").is_ok());
    }

    #[test]
    fn test_get_model_components_unknown() {
        let result = get_model_components("nonexistent-model");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown model"));
    }

    // ── model_id_from_filename ──

    #[test]
    fn test_model_id_from_filename_klein_4b() {
        assert_eq!(model_id_from_filename("flux-2-klein-4b-Q8_0.gguf"), "flux2-klein-4b");
    }

    #[test]
    fn test_model_id_from_filename_klein_9b() {
        assert_eq!(model_id_from_filename("flux-2-klein-9b-Q8_0.gguf"), "flux2-klein-9b");
    }

    #[test]
    fn test_model_id_from_filename_flux2_dev() {
        assert_eq!(model_id_from_filename("flux2-dev-q2_k.gguf"), "flux2-dev");
    }

    #[test]
    fn test_model_id_from_filename_schnell() {
        assert_eq!(model_id_from_filename("flux1-schnell-q8_0.gguf"), "flux1-schnell");
    }

    #[test]
    fn test_model_id_from_filename_mini() {
        assert_eq!(model_id_from_filename("flux.1-mini-q8_0.gguf"), "flux1-mini");
    }

    #[test]
    fn test_model_id_from_filename_flux1_dev() {
        assert_eq!(model_id_from_filename("flux1-dev-q8_0.gguf"), "flux1-dev");
    }

    #[test]
    fn test_model_id_from_filename_sdxl() {
        assert_eq!(model_id_from_filename("sd_xl_turbo_1.0_fp16.safetensors"), "sdxl-turbo");
        assert_eq!(model_id_from_filename("sdxl-base.safetensors"), "sdxl-turbo");
    }

    #[test]
    fn test_model_id_from_filename_fallback() {
        assert_eq!(model_id_from_filename("totally-unknown-model.gguf"), "flux1-schnell");
    }

    // ── resolve_model ──

    #[test]
    fn test_resolve_model_by_id() {
        let (components, path) = resolve_model("flux2-klein-4b").unwrap();
        assert!(path.is_none());
        assert_eq!(components.steps, 4);
        assert!(components.llm.is_some());
    }

    #[test]
    fn test_resolve_model_by_path() {
        // Create a temp .gguf file
        let dir = std::env::temp_dir().join("mcp-image-gen-test");
        if let Err(e) = fs::create_dir_all(&dir) {
            warn!("Failed to create test dir: {e}");
        }
        let file = dir.join("flux-2-klein-4b-Q8_0.gguf");
        let mut f = std::fs::File::create(&file).unwrap();
        f.write_all(b"fake").unwrap();

        let (components, model_path) = resolve_model(file.to_str().unwrap()).unwrap();
        assert!(model_path.is_some());
        assert_eq!(model_path.unwrap(), file);
        assert!(components.llm.is_some());

        if let Err(e) = fs::remove_file(&file) {
            warn!("Failed to clean up test file: {e}");
        }
        if let Err(e) = fs::remove_dir(&dir) {
            warn!("Failed to clean up test dir: {e}");
        }
    }

    #[test]
    fn test_resolve_model_missing_file() {
        let result = resolve_model("/nonexistent/path/to/model.gguf");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    // ── validate_path_safe ──

    #[test]
    fn test_validate_path_safe_absolute() {
        assert!(validate_path_safe(Path::new("/home/user/models")).is_ok());
        assert!(validate_path_safe(Path::new("/tmp")).is_ok());
    }

    #[test]
    fn test_validate_path_safe_relative() {
        assert!(validate_path_safe(Path::new("relative/path")).is_err());
        assert!(validate_path_safe(Path::new("./here")).is_err());
    }

    #[test]
    fn test_validate_path_safe_traversal() {
        assert!(validate_path_safe(Path::new("/home/../etc/passwd")).is_err());
        assert!(validate_path_safe(Path::new("/tmp/models/../../etc")).is_err());
    }

    // ── set_hf_token ──

    #[test]
    fn test_hf_token_api_accessible() {
        diffusion_rs::util::set_hf_token("");
        diffusion_rs::util::set_hf_token("test-token");
    }

    // ── config ──

    #[test]
    fn test_config_loads_models_path() {
        let config = Config::new().unwrap();
        assert!(!config.models_path.as_os_str().is_empty());
        assert!(!config.images_path.as_os_str().is_empty());
        assert!(config.width > 0);
        assert!(config.height > 0);
        assert!(config.steps > 0);
    }

    // ── ModelComponents: verify public VAE repos ──

    #[test]
    fn test_klein4b_uses_flux2_vae() {
        let c = get_model_components("flux2-klein-4b").unwrap();
        let (repo, file) = c.vae.unwrap();
        assert!(repo.contains("FLUX.2"), "FLUX.2 Klein 4B should use FLUX.2 VAE (32 latent channels)");
        assert!(file.contains("diffusion_pytorch_model"), "FLUX.2 VAE file should be diffusion_pytorch_model.safetensors");
    }

    #[test]
    fn test_klein9b_uses_flux2_vae() {
        let c = get_model_components("flux2-klein-9b").unwrap();
        let (repo, file) = c.vae.unwrap();
        assert!(repo.contains("FLUX.2"), "FLUX.2 Klein 9B should use FLUX.2 VAE (32 latent channels)");
        assert!(file.contains("diffusion_pytorch_model"), "FLUX.2 VAE file should be diffusion_pytorch_model.safetensors");
    }

    #[test]
    fn test_flux1_schnell_uses_public_vae() {
        let c = get_model_components("flux1-schnell").unwrap();
        let (repo, _) = c.vae.unwrap();
        assert!(!repo.contains("black-forest-labs"), "FLUX.1 VAE should use public repo, not gated black-forest-labs");
    }
}
