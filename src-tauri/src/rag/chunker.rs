use text_splitter::{ChunkConfig, MarkdownSplitter, TextSplitter};

use super::rag_settings;

/// A single text chunk from the original document.
pub struct Chunk {
    pub text: String,
}

/// Split text into overlapping chunks for embedding.
/// Uses markdown-aware splitting for markdown content, plain text splitting otherwise.
/// Split text using defaults from RAG settings.
pub fn split_text(text: &str, is_markdown: bool) -> Result<Vec<Chunk>, String> {
    let settings = rag_settings::load();
    split_text_with_params(text, is_markdown, settings.chunk_size, settings.chunk_overlap)
}

/// Split text with custom chunk size and overlap parameters.
pub fn split_text_with_params(
    text: &str,
    is_markdown: bool,
    chunk_size: usize,
    overlap: usize,
) -> Result<Vec<Chunk>, String> {
    let chunk_config = ChunkConfig::new(chunk_size)
        .with_overlap(overlap)
        .map_err(|e| format!("Invalid chunk config: {e}"))?;

    let pieces: Vec<&str> = if is_markdown {
        let splitter = MarkdownSplitter::new(chunk_config);
        splitter.chunks(text).collect()
    } else {
        let splitter = TextSplitter::new(chunk_config);
        splitter.chunks(text).collect()
    };

    Ok(pieces
        .into_iter()
        .filter(|t| !t.trim().is_empty())
        .map(|t| Chunk {
            text: t.to_string(),
        })
        .collect())
}
