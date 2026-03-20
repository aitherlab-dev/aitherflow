use std::fs;
use std::path::Path;

use crate::files::validate_path_safe;

/// Parsed document content ready for chunking.
pub struct ParsedDocument {
    pub text: String,
    pub is_markdown: bool,
}

/// Parse a file into text content. Supports plain text, Markdown, and PDF.
pub fn parse_file(path: &Path) -> Result<ParsedDocument, String> {
    validate_path_safe(path)?;

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    // PDF: extract text via pdf-extract (binary format, skip UTF-8/null checks)
    if ext == "pdf" {
        return parse_pdf(path);
    }

    let raw = fs::read(path)
        .map_err(|e| format!("Failed to read file {}: {e}", path.display()))?;

    // Reject binary content (null bytes in first 8KB)
    let check_len = raw.len().min(8192);
    if raw[..check_len].contains(&0) {
        return Err(format!("Binary file not supported: {}", path.display()));
    }

    let text = String::from_utf8(raw)
        .map_err(|_| format!("File is not valid UTF-8: {}", path.display()))?;

    let is_markdown = matches!(ext.as_str(), "md" | "markdown" | "mdx");

    if is_markdown {
        Ok(ParsedDocument {
            text: extract_markdown_text(&text),
            is_markdown: true,
        })
    } else {
        Ok(ParsedDocument {
            text,
            is_markdown: false,
        })
    }
}

/// Extract text from a PDF file.
fn parse_pdf(path: &Path) -> Result<ParsedDocument, String> {
    let bytes = fs::read(path)
        .map_err(|e| format!("Failed to read PDF {}: {e}", path.display()))?;

    let text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| format!("Failed to extract text from PDF {}: {e}", path.display()))?;

    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err(format!("PDF contains no extractable text: {}", path.display()));
    }

    Ok(ParsedDocument {
        text: trimmed,
        is_markdown: false,
    })
}

/// Extract readable text from Markdown by stripping formatting via pulldown-cmark.
fn extract_markdown_text(md: &str) -> String {
    use pulldown_cmark::{Event, Parser, Tag, TagEnd};

    let parser = Parser::new(md);
    let mut output = String::with_capacity(md.len());
    let mut in_code_block = false;

    for event in parser {
        match event {
            Event::Start(Tag::CodeBlock(_)) => {
                in_code_block = true;
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
                output.push('\n');
            }
            Event::Start(Tag::Heading { .. }) => {
                if !output.is_empty() && !output.ends_with('\n') {
                    output.push('\n');
                }
            }
            Event::End(TagEnd::Heading(_)) => {
                output.push('\n');
            }
            Event::End(TagEnd::Paragraph) => {
                output.push_str("\n\n");
            }
            Event::Text(text) if !in_code_block => {
                output.push_str(&text);
            }
            Event::Code(code) => {
                output.push_str(&code);
            }
            Event::SoftBreak | Event::HardBreak if !in_code_block => {
                output.push(' ');
            }
            _ => {}
        }
    }

    output.trim().to_string()
}
