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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_plain_text() {
        let text = "Hello world. This is a test. Some more text here for chunking purposes.";
        let chunks = split_text_with_params(text, false, 50, 10).unwrap();
        assert!(!chunks.is_empty());
        for chunk in &chunks {
            assert!(!chunk.text.trim().is_empty());
        }
    }

    #[test]
    fn split_markdown_text() {
        let text = "# Title\n\nParagraph one with some content.\n\n## Section\n\nParagraph two with more content.";
        let chunks = split_text_with_params(text, true, 50, 10).unwrap();
        assert!(!chunks.is_empty());
    }

    #[test]
    fn split_empty_text() {
        let chunks = split_text_with_params("", false, 100, 10).unwrap();
        assert!(chunks.is_empty());
    }

    #[test]
    fn split_whitespace_only() {
        let chunks = split_text_with_params("   \n\n   ", false, 100, 10).unwrap();
        assert!(chunks.is_empty());
    }

    #[test]
    fn split_short_text_single_chunk() {
        let text = "Short text.";
        let chunks = split_text_with_params(text, false, 1000, 100).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "Short text.");
    }

    #[test]
    fn split_invalid_overlap() {
        // overlap > chunk_size should error
        let result = split_text_with_params("text", false, 10, 20);
        assert!(result.is_err());
    }
}
