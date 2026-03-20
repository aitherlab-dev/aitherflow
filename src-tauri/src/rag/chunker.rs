use text_splitter::{ChunkConfig, MarkdownSplitter, TextSplitter};

const DEFAULT_CHUNK_SIZE: usize = 512;
const DEFAULT_OVERLAP: usize = 64;

/// A single text chunk with its position in the original document.
pub struct Chunk {
    pub text: String,
    #[allow(dead_code)]
    pub index: usize,
}

/// Split text into overlapping chunks for embedding.
/// Uses markdown-aware splitting for markdown content, plain text splitting otherwise.
pub fn split_text(text: &str, is_markdown: bool) -> Result<Vec<Chunk>, String> {
    split_text_with_params(text, is_markdown, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP)
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
        .enumerate()
        .filter(|(_, t)| !t.trim().is_empty())
        .map(|(i, t)| Chunk {
            text: t.to_string(),
            index: i,
        })
        .collect())
}
