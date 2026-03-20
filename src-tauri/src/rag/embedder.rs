use std::sync::OnceLock;

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

use super::config as rag_config;

/// Global embedding model instance (initialized once on first use).
/// NOTE: embed_texts must always be called from tokio::task::spawn_blocking.
static EMBEDDER: OnceLock<TextEmbedding> = OnceLock::new();

/// Initialize or get the embedding model.
/// Uses all-MiniLM-L6-v2 (384 dimensions) — small and fast.
fn get_or_init() -> Result<&'static TextEmbedding, String> {
    if let Some(model) = EMBEDDER.get() {
        return Ok(model);
    }

    let cache_dir = rag_config::models_dir();
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create models dir: {e}"))?;

    let model = TextEmbedding::try_new(
        InitOptions::new(EmbeddingModel::AllMiniLML6V2)
            .with_cache_dir(cache_dir),
    )
    .map_err(|e| format!("Failed to initialize embedding model: {e}"))?;

    // OnceLock::set may fail if another thread initialized concurrently — that's fine,
    // we just use whichever was stored first.
    let _ = EMBEDDER.set(model);
    Ok(EMBEDDER.get().expect("just initialized"))
}

/// Generate embeddings for a batch of text chunks.
/// Returns a Vec of f32 vectors, one per input chunk.
pub fn embed_texts(texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }

    let model = get_or_init()?;
    model
        .embed(texts.to_vec(), None)
        .map_err(|e| format!("Embedding failed: {e}"))
}

/// Get the dimension of the embedding model output.
pub fn embedding_dimension() -> usize {
    384 // all-MiniLM-L6-v2
}
