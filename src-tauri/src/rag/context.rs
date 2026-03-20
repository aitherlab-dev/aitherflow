use super::{commands, embedder, index};

const DEFAULT_CONTEXT_LIMIT: usize = 5;

/// Build RAG context from multiple knowledge bases for a given query.
/// Returns a formatted text block ready to prepend to the user's message.
pub async fn build_rag_context(
    base_ids: &[String],
    query: &str,
    limit: usize,
) -> Result<String, String> {
    if base_ids.is_empty() || query.trim().is_empty() {
        return Ok(String::new());
    }

    // Embed the query once
    let q = query.to_string();
    let embeddings = tokio::task::spawn_blocking(move || embedder::embed_texts(&[q]))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    let query_vec = embeddings
        .into_iter()
        .next()
        .ok_or("Failed to embed query")?;

    let mut context_parts = Vec::new();

    for base_id in base_ids {
        let raw_results = index::search(base_id, &query_vec, limit).await?;
        if raw_results.is_empty() {
            continue;
        }

        let enriched = commands::enrich_results(base_id, raw_results).await?;
        for r in &enriched {
            context_parts.push(format!("From {}:\n{}", r.document_name, r.chunk_text));
        }
    }

    if context_parts.is_empty() {
        return Ok(String::new());
    }

    Ok(format!(
        "--- Knowledge Base Context ---\n\n{}\n\n--- End Context ---",
        context_parts.join("\n\n")
    ))
}

/// Tauri command wrapper.
pub async fn build_context_command(
    base_ids: Vec<String>,
    query: String,
    limit: Option<usize>,
) -> Result<String, String> {
    let limit = limit.unwrap_or(DEFAULT_CONTEXT_LIMIT);
    build_rag_context(&base_ids, &query, limit).await
}
