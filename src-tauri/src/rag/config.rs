use std::path::PathBuf;

use crate::config;

/// Root directory for all RAG data: ~/.local/share/aither-flow/rag/
pub fn rag_dir() -> PathBuf {
    config::data_dir().join("rag")
}

/// Directory for a specific knowledge base: rag/{base_id}/
pub fn base_dir(base_id: &str) -> PathBuf {
    rag_dir().join(base_id)
}

/// Metadata file for a knowledge base: rag/{base_id}/meta.json
pub fn base_meta_path(base_id: &str) -> PathBuf {
    base_dir(base_id).join("meta.json")
}

/// LanceDB storage directory for a knowledge base: rag/{base_id}/lance/
pub fn base_lance_dir(base_id: &str) -> PathBuf {
    base_dir(base_id).join("lance")
}

/// Directory for cached fastembed models: rag/models/
pub fn models_dir() -> PathBuf {
    rag_dir().join("models")
}
