use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::files::validate_path_safe;

use super::{chunker, embedder, index, parser, rag_settings, store, validate_uuid, web, youtube};

/// Playlist progress event emitted after each video is processed.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistProgress {
    processed: usize,
    total: usize,
    current_title: String,
    skipped: usize,
}

/// Playlist completion summary.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSummary {
    pub added: usize,
    pub skipped: usize,
    pub total: usize,
    pub is_playlist: bool,
}

const DEFAULT_SEARCH_LIMIT: usize = 10;
const MAX_PLAYLIST_VIDEOS: usize = 300;

/// Reindex progress event emitted after each document.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReindexProgress {
    processed: usize,
    total: usize,
    current_filename: String,
}

/// Reindex completion summary.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReindexSummary {
    pub reindexed: usize,
    pub skipped: usize,
    pub total: usize,
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
        let chunks = chunker::split_text(&parsed.text, parsed.is_markdown)?;
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

/// Progress event for document add operations.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AddProgress {
    processed: usize,
    total: usize,
    current_filename: String,
}

#[tauri::command]
pub async fn rag_add_documents(
    app: AppHandle,
    base_id: String,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    validate_uuid(&base_id, "base_id")?;

    // Verify base exists
    let bid = base_id.clone();
    tokio::task::spawn_blocking(move || store::get_base(&bid))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    let total = paths.len();
    let mut doc_ids = Vec::new();
    for (i, file_path) in paths.iter().enumerate() {
        let filename = std::path::Path::new(file_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| file_path.clone());

        if let Err(e) = app.emit(
            "rag-add-progress",
            AddProgress {
                processed: i,
                total,
                current_filename: filename,
            },
        ) {
            eprintln!("[rag] Failed to emit add progress: {e}");
        }

        match add_single_document(&base_id, file_path).await {
            Ok(doc_id) => doc_ids.push(doc_id),
            Err(e) => {
                eprintln!("[rag] Failed to add document {}/{}: {} — {e}", i + 1, total, file_path);
            }
        }
    }

    // Emit completion
    if let Err(e) = app.emit(
        "rag-add-progress",
        AddProgress {
            processed: total,
            total,
            current_filename: String::new(),
        },
    ) {
        eprintln!("[rag] Failed to emit final add progress: {e}");
    }

    if doc_ids.is_empty() && !paths.is_empty() {
        return Err("All documents failed to add".into());
    }

    Ok(doc_ids)
}

/// Process raw text content: sanitize → chunk → embed → store → index.
/// Used by URL and YouTube importers.
async fn add_text_document(
    base_id: &str,
    filename: &str,
    source: &str,
    text: &str,
) -> Result<String, String> {
    let sanitized = parser::sanitize_text(text);
    let is_markdown = false;
    let size = sanitized.len() as u64;

    let text_owned = sanitized.clone();
    let chunks = tokio::task::spawn_blocking(move || chunker::split_text(&text_owned, is_markdown))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    let texts: Vec<String> = chunks.into_iter().map(|c| c.text).collect();
    if texts.is_empty() {
        return Err(format!("No content extracted from: {source}"));
    }

    let texts_for_embed = texts.clone();
    let embeddings = tokio::task::spawn_blocking(move || embedder::embed_texts(&texts_for_embed))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    let bid = base_id.to_string();
    let fname = filename.to_string();
    let src = source.to_string();
    let chunk_count = texts.len();
    let doc_id = tokio::task::spawn_blocking(move || {
        store::add_document_meta(&bid, &fname, &src, size, chunk_count)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    index::add_chunks(base_id, &doc_id, &texts, &embeddings).await?;
    Ok(doc_id)
}

#[tauri::command]
pub async fn rag_add_url(base_id: String, url: String) -> Result<String, String> {
    validate_uuid(&base_id, "base_id")?;

    // Verify base exists
    let bid = base_id.clone();
    tokio::task::spawn_blocking(move || store::get_base(&bid))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    let text = web::fetch_article(&url).await?;

    // Use domain + path as filename
    let filename = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .chars()
        .take(80)
        .collect::<String>();

    add_text_document(&base_id, &filename, &url, &text).await
}

#[tauri::command]
pub async fn rag_add_youtube(
    app: AppHandle,
    base_id: String,
    url: String,
) -> Result<PlaylistSummary, String> {
    validate_uuid(&base_id, "base_id")?;

    // Verify base exists
    let bid = base_id.clone();
    tokio::task::spawn_blocking(move || store::get_base(&bid))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    // Check if URL is a playlist (pure string check, no I/O)
    if youtube::is_playlist_url(&url) {
        add_youtube_playlist(&app, &base_id, &url).await
    } else {
        add_single_youtube(&base_id, &url).await
    }
}

/// Add a single YouTube video to the knowledge base.
async fn add_single_youtube(base_id: &str, url: &str) -> Result<PlaylistSummary, String> {
    let u = url.to_string();
    let text = tokio::task::spawn_blocking(move || youtube::fetch_youtube_transcript(&u))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    let filename = extract_youtube_id(url)
        .map(|id| format!("youtube-{id}"))
        .unwrap_or_else(|| "youtube-video".into());

    add_text_document(base_id, &filename, url, &text).await?;

    Ok(PlaylistSummary {
        added: 1,
        skipped: 0,
        total: 1,
        is_playlist: false,
    })
}

/// Add all videos from a YouTube playlist to the knowledge base.
/// Emits "rag-playlist-progress" events after each video.
async fn add_youtube_playlist(
    app: &AppHandle,
    base_id: &str,
    url: &str,
) -> Result<PlaylistSummary, String> {
    let u = url.to_string();
    let mut entries = tokio::task::spawn_blocking(move || youtube::fetch_playlist_urls(&u))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    if entries.len() > MAX_PLAYLIST_VIDEOS {
        eprintln!(
            "[rag] Playlist has {} videos, limiting to first {MAX_PLAYLIST_VIDEOS}",
            entries.len()
        );
        entries.truncate(MAX_PLAYLIST_VIDEOS);
    }

    let total = entries.len();
    let mut added: usize = 0;
    let mut skipped: usize = 0;

    for (i, entry) in entries.iter().enumerate() {
        // Emit progress event
        if let Err(e) = app.emit(
            "rag-playlist-progress",
            PlaylistProgress {
                processed: i,
                total,
                current_title: entry.title.clone(),
                skipped,
            },
        ) {
            eprintln!("[rag] Failed to emit playlist progress: {e}");
        }

        let video_url = entry.url.clone();
        let result = tokio::task::spawn_blocking(move || {
            youtube::fetch_youtube_transcript(&video_url)
        })
        .await
        .map_err(|e| format!("Task join error: {e}"))?;

        match result {
            Ok(text) => {
                let filename = extract_youtube_id(&entry.url)
                    .map(|id| format!("youtube-{id}"))
                    .unwrap_or_else(|| format!("youtube-playlist-{}", i + 1));

                match add_text_document(base_id, &filename, &entry.url, &text).await {
                    Ok(_) => added += 1,
                    Err(e) => {
                        eprintln!(
                            "[rag] Failed to index playlist video {}/{}: {} — {e}",
                            i + 1,
                            total,
                            entry.title
                        );
                        skipped += 1;
                    }
                }
            }
            Err(e) => {
                eprintln!(
                    "[rag] No transcript for playlist video {}/{}: {} — {e}",
                    i + 1,
                    total,
                    entry.title
                );
                skipped += 1;
            }
        }
    }

    // Emit final progress
    if let Err(e) = app.emit(
        "rag-playlist-progress",
        PlaylistProgress {
            processed: total,
            total,
            current_title: String::new(),
            skipped,
        },
    ) {
        eprintln!("[rag] Failed to emit final playlist progress: {e}");
    }

    if added == 0 {
        return Err(format!(
            "No videos could be added from playlist ({skipped} skipped, no subtitles)"
        ));
    }

    Ok(PlaylistSummary {
        added,
        skipped,
        total,
        is_playlist: true,
    })
}

fn extract_youtube_id(url: &str) -> Option<String> {
    // Handle youtu.be/ID and youtube.com/watch?v=ID
    if let Some(rest) = url.strip_prefix("https://youtu.be/").or_else(|| url.strip_prefix("http://youtu.be/")) {
        return Some(rest.split(['?', '&', '/']).next()?.to_string());
    }
    if url.contains("youtube.com") {
        if let Some(pos) = url.find("v=") {
            let id = &url[pos + 2..];
            return Some(id.split(['&', '#']).next()?.to_string());
        }
    }
    None
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

/// Enrich raw search results with document names from metadata.
pub async fn enrich_results(
    base_id: &str,
    raw_results: Vec<index::RawSearchResult>,
) -> Result<Vec<index::SearchResult>, String> {
    let bid = base_id.to_string();
    let docs = tokio::task::spawn_blocking(move || store::list_documents(&bid))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    let doc_map: std::collections::HashMap<&str, &str> = docs
        .iter()
        .map(|d| (d.id.as_str(), d.filename.as_str()))
        .collect();

    Ok(raw_results
        .into_iter()
        .map(|r| {
            let doc_name = doc_map
                .get(r.document_id.as_str())
                .map(|s| (*s).to_owned())
                .unwrap_or_else(|| "unknown".into());
            index::SearchResult {
                chunk_text: r.chunk_text,
                document_id: r.document_id,
                document_name: doc_name,
                chunk_index: r.chunk_index,
                score: r.score,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn rag_search(
    base_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<index::SearchResult>, String> {
    validate_uuid(&base_id, "base_id")?;
    let limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT);

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
    enrich_results(&base_id, raw_results).await
}

#[tauri::command]
pub async fn rag_get_index_status(base_id: String) -> Result<index::IndexStatus, String> {
    validate_uuid(&base_id, "base_id")?;
    index::get_status(&base_id).await
}

#[derive(Clone, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub dimension: usize,
}

#[tauri::command]
pub fn rag_get_available_models() -> Vec<ModelInfo> {
    rag_settings::AVAILABLE_MODELS
        .iter()
        .map(|(id, label, dim)| ModelInfo {
            id: id.to_string(),
            label: label.to_string(),
            dimension: *dim,
        })
        .collect()
}

#[tauri::command]
pub async fn rag_load_settings() -> Result<rag_settings::RagSettings, String> {
    tokio::task::spawn_blocking(|| Ok(rag_settings::load()))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Returns true if the embedding model was changed (requires restart + reindex).
#[tauri::command]
pub async fn rag_save_settings(settings: rag_settings::RagSettings) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let old = rag_settings::load();
        let model_changed = old.embedding_model != settings.embedding_model;
        rag_settings::save(&settings)?;
        Ok(model_changed)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

// --- Reindex ---

/// Reindex a single document: remove old chunks → parse → chunk → embed → re-add.
/// Returns new chunk count on success. Used by both rag_reindex_base and mcp tool.
/// If chunk_size/chunk_overlap are None, uses defaults from rag settings.
pub async fn reindex_single_document(
    base_id: &str,
    doc: &store::DocumentMeta,
    chunk_size: Option<usize>,
    chunk_overlap: Option<usize>,
) -> Result<usize, String> {
    let bid = base_id.to_string();
    let did = doc.id.clone();

    // Remove old chunks
    index::remove_document_chunks(&bid, &did).await?;

    // Re-parse with optional custom chunk params
    let file_path = doc.path.clone();
    let (texts, new_chunk_count) = tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&file_path);
        let parsed = parser::parse_file(path)?;
        let chunks = match (chunk_size, chunk_overlap) {
            (Some(size), Some(overlap)) => {
                chunker::split_text_with_params(&parsed.text, parsed.is_markdown, size, overlap)?
            }
            _ => chunker::split_text(&parsed.text, parsed.is_markdown)?,
        };
        let texts: Vec<String> = chunks.into_iter().map(|c| c.text).collect();
        let count = texts.len();
        Ok::<_, String>((texts, count))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    if texts.is_empty() {
        return Err("No content after re-parsing".into());
    }

    // Re-embed
    let texts_for_embed = texts.clone();
    let embeddings = tokio::task::spawn_blocking(move || embedder::embed_texts(&texts_for_embed))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    // Re-add to index
    index::add_chunks(&bid, &did, &texts, &embeddings).await?;

    // Update chunk count in metadata
    let bid2 = base_id.to_string();
    let did2 = doc.id.clone();
    let count = new_chunk_count;
    tokio::task::spawn_blocking(move || {
        let mut meta = store::get_base(&bid2)?;
        if let Some(d) = meta.documents.iter_mut().find(|d| d.id == did2) {
            d.chunk_count = count;
        }
        crate::file_ops::write_json(&super::config::base_meta_path(&bid2), &meta)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    Ok(new_chunk_count)
}

#[tauri::command]
pub async fn rag_reindex_base(
    app: AppHandle,
    base_id: String,
) -> Result<ReindexSummary, String> {
    validate_uuid(&base_id, "base_id")?;

    let bid = base_id.clone();
    let documents = tokio::task::spawn_blocking(move || store::list_documents(&bid))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    let total = documents.len();
    let mut reindexed: usize = 0;
    let mut skipped: usize = 0;

    for (i, doc) in documents.iter().enumerate() {
        // Emit progress
        if let Err(e) = app.emit(
            "rag-reindex-progress",
            ReindexProgress {
                processed: i,
                total,
                current_filename: doc.filename.clone(),
            },
        ) {
            eprintln!("[rag] Failed to emit reindex progress: {e}");
        }

        // Skip web/YouTube sources (no local file to re-parse)
        if doc.path.starts_with("http://") || doc.path.starts_with("https://") {
            eprintln!(
                "[rag] Skipping web/YouTube source: {} ({})",
                doc.filename, doc.path
            );
            skipped += 1;
            continue;
        }

        match reindex_single_document(&base_id, doc, None, None).await {
            Ok(chunks) => {
                eprintln!(
                    "[rag] Reindexed {}/{}: {} ({} chunks)",
                    i + 1,
                    total,
                    doc.filename,
                    chunks
                );
                reindexed += 1;
            }
            Err(e) => {
                eprintln!(
                    "[rag] Failed to reindex {}/{}: {} — {e}",
                    i + 1,
                    total,
                    doc.filename
                );
                skipped += 1;
            }
        }
    }

    // Emit final progress
    if let Err(e) = app.emit(
        "rag-reindex-progress",
        ReindexProgress {
            processed: total,
            total,
            current_filename: String::new(),
        },
    ) {
        eprintln!("[rag] Failed to emit final reindex progress: {e}");
    }

    Ok(ReindexSummary {
        reindexed,
        skipped,
        total,
    })
}
