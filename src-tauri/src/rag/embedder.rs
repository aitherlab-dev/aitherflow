use std::sync::{LazyLock, Mutex};

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

use super::config as rag_config;

/// Global embedding model instance (lazy-initialized).
static EMBEDDER: LazyLock<Mutex<Option<TextEmbedding>>> =
    LazyLock::new(|| Mutex::new(None));

/// Initialize or get the embedding model.
/// Uses all-MiniLM-L6-v2 (384 dimensions) — small and fast.
fn get_or_init() -> Result<std::sync::MutexGuard<'static, Option<TextEmbedding>>, String> {
    let mut guard = EMBEDDER.lock().map_err(|e| format!("Embedder lock poisoned: {e}"))?;
    if guard.is_none() {
        let cache_dir = rag_config::models_dir();
        std::fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to create models dir: {e}"))?;

        let model = TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::AllMiniLML6V2)
                .with_cache_dir(cache_dir),
        )
        .map_err(|e| format!("Failed to initialize embedding model: {e}"))?;

        *guard = Some(model);
    }
    Ok(guard)
}

/// Generate embeddings for a batch of text chunks.
/// Returns a Vec of f32 vectors, one per input chunk.
pub fn embed_texts(texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }

    let guard = get_or_init()?;
    let model = guard.as_ref().expect("embedder is initialized");

    model
        .embed(texts.to_vec(), None)
        .map_err(|e| format!("Embedding failed: {e}"))
}

/// Get the dimension of the embedding model output.
pub fn embedding_dimension() -> usize {
    384 // all-MiniLM-L6-v2
}
