use std::path::Path;

use crate::files::validate_path_safe;

use super::{chunker, embedder, index, parser, store};

const DEFAULT_SEARCH_LIMIT: usize = 10;

/// Validate that a string is a valid UUID v4 format.
fn validate_uuid(s: &str, label: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(s)
        .map_err(|_| format!("Invalid {label}: '{s}' is not a valid UUID"))?;
    Ok(())
}

#[tauri::command]
pub async fn rag_list_bases() -> Result<Vec<store::BaseInfo>, String> {
    tokio::task::spawn_blocking(store::list_bases)
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn rag_create_base(name: String, description: String) -> Result<store::BaseMeta, String> {
    tokio::task::spawn_blocking(move || store::create_base(&name, &description))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn rag_delete_base(base_id: String) -> Result<(), String> {
    validate_uuid(&base_id, "base_id")?;
    tokio::task::spawn_blocking(move || store::delete_base(&base_id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn rag_get_base(base_id: String) -> Result<store::BaseMeta, String> {
    validate_uuid(&base_id, "base_id")?;
    tokio::task::spawn_blocking(move || store::get_base(&base_id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Process a single file: parse → chunk → embed → store metadata → index.
async fn add_single_document(
    base_id: &str,
    file_path: &str,
) -> Result<String, String> {
    let p = file_path.to_string();

    // Parse and chunk in a blocking task
    let (texts, filename, size) = tokio::task::spawn_blocking(move || {
        let path = Path::new(&p);
        validate_path_safe(path)?;
        let parsed = parser::parse_file(path)?;
        let chunks = chunker::split_text(&parsed.text, parsed.is_markdown);
        let texts: Vec<String> = chunks.into_iter().map(|c| c.text).collect();

        let filename = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "unknown".into());
        let size = std::fs::metadata(path)
            .map(|m| m.len())
            .unwrap_or(0);

        Ok::<_, String>((texts, filename, size))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    if texts.is_empty() {
        return Err(format!("No content extracted from file: {file_path}"));
    }

    // Generate embeddings (CPU-bound, blocking)
    let texts_for_embed = texts.clone();
    let embeddings = tokio::task::spawn_blocking(move || embedder::embed_texts(&texts_for_embed))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    // Save document metadata
    let bid = base_id.to_string();
    let fname = filename.clone();
    let fp = file_path.to_string();
    let chunk_count = texts.len();
    let doc_id = tokio::task::spawn_blocking(move || {
        store::add_document_meta(&bid, &fname, &fp, size, chunk_count)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    // Add to vector index
    index::add_chunks(base_id, &doc_id, &texts, &embeddings).await?;

    Ok(doc_id)
}

#[tauri::command]
pub async fn rag_add_documents(base_id: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    validate_uuid(&base_id, "base_id")?;

    // Verify base exists
    let bid = base_id.clone();
    tokio::task::spawn_blocking(move || store::get_base(&bid))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    let mut doc_ids = Vec::new();
    for file_path in &paths {
        let doc_id = add_single_document(&base_id, file_path).await?;
        doc_ids.push(doc_id);
    }

    Ok(doc_ids)
}

#[tauri::command]
pub async fn rag_remove_document(base_id: String, document_id: String) -> Result<(), String> {
    validate_uuid(&base_id, "base_id")?;
    validate_uuid(&document_id, "document_id")?;

    // Remove from vector index first
    index::remove_document_chunks(&base_id, &document_id).await?;

    // Then remove metadata
    tokio::task::spawn_blocking(move || store::remove_document_meta(&base_id, &document_id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn rag_list_documents(
    base_id: String,
) -> Result<Vec<store::DocumentMeta>, String> {
    validate_uuid(&base_id, "base_id")?;
    tokio::task::spawn_blocking(move || store::list_documents(&base_id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn rag_search(
    base_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<index::SearchResult>, String> {
    validate_uuid(&base_id, "base_id")?;
    let limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT);

    // Embed the query
    let embeddings = tokio::task::spawn_blocking(move || {
        embedder::embed_texts(&[query])
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    let query_vec = embeddings
        .into_iter()
        .next()
        .ok_or("Failed to embed query")?;

    let raw_results = index::search(&base_id, &query_vec, limit).await?;

    // Enrich with document names from metadata
    let bid = base_id.clone();
    let docs = tokio::task::spawn_blocking(move || store::list_documents(&bid))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    let results = raw_results
        .into_iter()
        .map(|r| {
            let doc_name = docs
                .iter()
                .find(|d| d.id == r.document_id)
                .map(|d| d.filename.clone())
                .unwrap_or_else(|| "unknown".into());
            index::SearchResult {
                text: r.text,
                document_id: r.document_id,
                document_name: doc_name,
                chunk_index: r.chunk_index,
                score: r.score,
            }
        })
        .collect();

    Ok(results)
}

#[tauri::command]
pub async fn rag_get_index_status(base_id: String) -> Result<index::IndexStatus, String> {
    validate_uuid(&base_id, "base_id")?;
    index::get_status(&base_id).await
}
