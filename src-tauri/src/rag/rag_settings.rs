use serde::{Deserialize, Serialize};

use crate::file_ops::{read_json, write_json};

use super::config as rag_config;

/// Available embedding models (fastembed v4).
pub const AVAILABLE_MODELS: &[(&str, &str, usize)] = &[
    ("all-MiniLM-L6-v2", "Fast, English-focused, 23MB", 384),
    ("multilingual-e5-small", "Multilingual (ru/en/zh/...), 118MB", 384),
    ("multilingual-e5-large", "Multilingual, higher quality, 560MB", 1024),
    ("nomic-embed-text-v1.5", "Good quality, English, 137MB", 768),
];

/// RAG module settings stored in rag/settings.json.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RagSettings {
    #[serde(default = "default_model")]
    pub embedding_model: String,
    #[serde(default = "default_chunk_size")]
    pub chunk_size: usize,
    #[serde(default = "default_chunk_overlap")]
    pub chunk_overlap: usize,
    #[serde(default = "default_search_limit")]
    pub search_results_limit: usize,
    #[serde(default = "default_true")]
    pub knowledge_mcp_enabled: bool,
}

impl Default for RagSettings {
    fn default() -> Self {
        Self {
            embedding_model: default_model(),
            chunk_size: default_chunk_size(),
            chunk_overlap: default_chunk_overlap(),
            search_results_limit: default_search_limit(),
            knowledge_mcp_enabled: true,
        }
    }
}

fn default_model() -> String {
    "all-MiniLM-L6-v2".to_string()
}
fn default_chunk_size() -> usize {
    512
}
fn default_chunk_overlap() -> usize {
    64
}
fn default_search_limit() -> usize {
    10
}
fn default_true() -> bool {
    true
}

fn settings_path() -> std::path::PathBuf {
    rag_config::rag_dir().join("settings.json")
}

/// Load RAG settings (blocking I/O).
pub fn load() -> RagSettings {
    let path = settings_path();
    read_json::<RagSettings>(&path).unwrap_or_default()
}

/// Save RAG settings (blocking I/O).
pub fn save(settings: &RagSettings) -> Result<(), String> {
    std::fs::create_dir_all(rag_config::rag_dir())
        .map_err(|e| format!("Failed to create rag dir: {e}"))?;
    write_json(&settings_path(), settings)
}

/// Map model name string to fastembed EmbeddingModel enum.
pub fn resolve_model(name: &str) -> fastembed::EmbeddingModel {
    match name {
        "multilingual-e5-small" => fastembed::EmbeddingModel::MultilingualE5Small,
        "multilingual-e5-large" => fastembed::EmbeddingModel::MultilingualE5Large,
        "nomic-embed-text-v1.5" => fastembed::EmbeddingModel::NomicEmbedTextV15,
        _ => fastembed::EmbeddingModel::AllMiniLML6V2,
    }
}

/// Get embedding dimension for a model name.
pub fn model_dimension(name: &str) -> usize {
    AVAILABLE_MODELS
        .iter()
        .find(|(n, _, _)| *n == name)
        .map(|(_, _, dim)| *dim)
        .unwrap_or(384)
}
