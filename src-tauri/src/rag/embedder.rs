use std::sync::OnceLock;

use fastembed::{InitOptions, TextEmbedding};

use super::config as rag_config;
use super::rag_settings;

/// Global embedding model instance (initialized once on first use).
/// NOTE: embed_texts must always be called from tokio::task::spawn_blocking.
/// Model is determined at init time from rag_settings. Changing model requires app restart.
static EMBEDDER: OnceLock<EmbedderInfo> = OnceLock::new();

struct EmbedderInfo {
    model: TextEmbedding,
    dimension: usize,
}

fn get_or_init() -> Result<&'static EmbedderInfo, String> {
    if let Some(info) = EMBEDDER.get() {
        return Ok(info);
    }

    let settings = rag_settings::load();
    let cache_dir = rag_config::models_dir();
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create models dir: {e}"))?;

    let fastembed_model = rag_settings::resolve_model(&settings.embedding_model);
    let dimension = rag_settings::model_dimension(&settings.embedding_model);

    eprintln!(
        "[rag] Initializing embedding model: {} (dim={})",
        settings.embedding_model, dimension
    );

    let model = TextEmbedding::try_new(
        InitOptions::new(fastembed_model).with_cache_dir(cache_dir),
    )
    .map_err(|e| format!("Failed to initialize embedding model: {e}"))?;

    let info = EmbedderInfo { model, dimension };
    let _ = EMBEDDER.set(info);
    Ok(EMBEDDER.get().expect("just initialized"))
}

/// Generate embeddings for a batch of text chunks.
pub fn embed_texts(texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }

    let info = get_or_init()?;
    info.model
        .embed(texts.to_vec(), None)
        .map_err(|e| format!("Embedding failed: {e}"))
}

/// Get the dimension of the current embedding model.
pub fn embedding_dimension() -> usize {
    EMBEDDER
        .get()
        .map(|info| info.dimension)
        .unwrap_or_else(|| rag_settings::model_dimension(&rag_settings::load().embedding_model))
}
