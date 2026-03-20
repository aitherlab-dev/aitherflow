use std::path::Path;

use super::{chunker, embedder, index, parser, store};

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
    tokio::task::spawn_blocking(move || store::delete_base(&base_id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn rag_get_base(base_id: String) -> Result<store::BaseMeta, String> {
    tokio::task::spawn_blocking(move || store::get_base(&base_id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn rag_add_documents(base_id: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    // First verify base exists
    let bid = base_id.clone();
    tokio::task::spawn_blocking(move || store::get_base(&bid))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    let mut doc_ids = Vec::new();

    for file_path in &paths {
        let p = file_path.clone();

        // Parse and chunk in a blocking task
        let (texts, _is_md, filename, size) = tokio::task::spawn_blocking(move || {
            let path = Path::new(&p);
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

            Ok::<_, String>((texts, parsed.is_markdown, filename, size))
        })
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

        if texts.is_empty() {
            eprintln!("[rag] No chunks from file: {file_path}");
            continue;
        }

        // Generate embeddings (CPU-bound, blocking)
        let texts_for_embed = texts.clone();
        let embeddings = tokio::task::spawn_blocking(move || embedder::embed_texts(&texts_for_embed))
            .await
            .map_err(|e| format!("Task join error: {e}"))??;

        // Save document metadata
        let bid2 = base_id.clone();
        let fname = filename.clone();
        let fp = file_path.clone();
        let chunk_count = texts.len();
        let doc_id = tokio::task::spawn_blocking(move || {
            store::add_document_meta(&bid2, &fname, &fp, size, chunk_count)
        })
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

        // Add to vector index
        index::add_chunks(&base_id, &doc_id, &texts, &embeddings).await?;

        doc_ids.push(doc_id);
    }

    Ok(doc_ids)
}

#[tauri::command]
pub async fn rag_remove_document(base_id: String, document_id: String) -> Result<(), String> {
    // Remove from vector index first
    index::remove_document_chunks(&base_id, &document_id).await?;

    // Then remove metadata
    let bid = base_id;
    let did = document_id;
    tokio::task::spawn_blocking(move || store::remove_document_meta(&bid, &did))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn rag_list_documents(
    base_id: String,
) -> Result<Vec<store::DocumentMeta>, String> {
    tokio::task::spawn_blocking(move || store::list_documents(&base_id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn rag_search(
    base_id: String,
    query: String,
    limit: usize,
) -> Result<Vec<index::SearchResult>, String> {
    // Embed the query
    let q = query;
    let embeddings = tokio::task::spawn_blocking(move || {
        embedder::embed_texts(&[q])
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    let query_vec = embeddings
        .into_iter()
        .next()
        .ok_or("Failed to embed query")?;

    index::search(&base_id, &query_vec, limit).await
}

#[tauri::command]
pub async fn rag_get_index_status(base_id: String) -> Result<index::IndexStatus, String> {
    index::get_status(&base_id).await
}
