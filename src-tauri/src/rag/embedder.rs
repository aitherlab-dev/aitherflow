use std::sync::{Mutex, OnceLock};

use fastembed::{TextEmbedding, TextInitOptions};

use super::config as rag_config;
use super::rag_settings;

/// Global embedding model instance (initialized once on first use).
/// NOTE: embed_texts must always be called from tokio::task::spawn_blocking.
/// Model is determined at init time from rag_settings. Changing model requires app restart.
/// Mutex is needed because fastembed v5 embed() requires &mut self.
static EMBEDDER: OnceLock<Mutex<EmbedderInfo>> = OnceLock::new();

struct EmbedderInfo {
    model: TextEmbedding,
    dimension: usize,
}

fn get_or_init() -> Result<&'static Mutex<EmbedderInfo>, String> {
    if let Some(m) = EMBEDDER.get() {
        return Ok(m);
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
        TextInitOptions::new(fastembed_model).with_cache_dir(cache_dir),
    )
    .map_err(|e| format!("Failed to initialize embedding model: {e}"))?;

    let info = Mutex::new(EmbedderInfo { model, dimension });
    // OnceLock::set returns Err if already initialized by a concurrent caller —
    // that's fine, we just use whichever value won the race.
    let _ = EMBEDDER.set(info);
    Ok(EMBEDDER.get().expect("just initialized"))
}

/// Generate embeddings for a batch of text chunks.
pub fn embed_texts(texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }

    let mutex = get_or_init()?;
    let mut info = mutex
        .lock()
        .map_err(|e| format!("Embedder lock poisoned: {e}"))?;
    info.model
        .embed(texts, None)
        .map_err(|e| format!("Embedding failed: {e}"))
}

/// Get the dimension of the current embedding model.
pub fn embedding_dimension() -> usize {
    EMBEDDER
        .get()
        .and_then(|m| m.lock().ok())
        .map(|info| info.dimension)
        .unwrap_or_else(|| rag_settings::model_dimension(&rag_settings::load().embedding_model))
}
