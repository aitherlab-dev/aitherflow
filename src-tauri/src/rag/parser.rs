use std::fs;
use std::path::Path;
use std::process::Command;

use crate::files::validate_path_safe;

/// Parsed document content ready for chunking.
pub struct ParsedDocument {
    pub text: String,
    pub is_markdown: bool,
}

/// Parse a file into text content. Supports plain text, Markdown, PDF, and EPUB.
pub fn parse_file(path: &Path) -> Result<ParsedDocument, String> {
    validate_path_safe(path)?;

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "pdf" => parse_pdf(path),
        "epub" => parse_epub(path),
        _ => parse_text(path, &ext),
    }
}

/// Parse a plain text or markdown file.
fn parse_text(path: &Path, ext: &str) -> Result<ParsedDocument, String> {
    let raw = fs::read(path)
        .map_err(|e| format!("Failed to read file {}: {e}", path.display()))?;

    // Reject binary content (null bytes in first 8KB)
    let check_len = raw.len().min(8192);
    if raw[..check_len].contains(&0) {
        return Err(format!("Binary file not supported: {}", path.display()));
    }

    let text = String::from_utf8(raw)
        .map_err(|_| format!("File is not valid UTF-8: {}", path.display()))?;

    let is_markdown = matches!(ext, "md" | "markdown" | "mdx");

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
/// Tries pdftotext (poppler-utils) first, falls back to pdf-extract crate.
fn parse_pdf(path: &Path) -> Result<ParsedDocument, String> {
    // Try pdftotext CLI first (better quality for complex PDFs)
    match parse_pdf_pdftotext(path) {
        Ok(doc) => return Ok(doc),
        Err(e) => {
            eprintln!("[rag] pdftotext failed, falling back to pdf-extract: {e}");
        }
    }

    // Fallback: pdf-extract crate
    parse_pdf_extract(path)
}

/// Extract text using pdftotext CLI from poppler-utils.
/// NOTE: parse_file is always called from spawn_blocking (see commands.rs),
/// so Command::new here does not block the async runtime.
fn parse_pdf_pdftotext(path: &Path) -> Result<ParsedDocument, String> {
    let path_str = path.to_str().ok_or("Invalid path encoding")?;
    let output = Command::new("pdftotext")
        .args(["-enc", "UTF-8", "-layout", path_str, "-"])
        .output()
        .map_err(|e| format!("pdftotext not available: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pdftotext failed: {stderr}"));
    }

    let text = String::from_utf8(output.stdout)
        .map_err(|_| "pdftotext output is not valid UTF-8".to_string())?;

    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("pdftotext returned empty text".into());
    }

    Ok(ParsedDocument {
        text: trimmed,
        is_markdown: false,
    })
}

/// Fallback PDF extraction using pdf-extract crate.
fn parse_pdf_extract(path: &Path) -> Result<ParsedDocument, String> {
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

/// Extract text from an EPUB file.
fn parse_epub(path: &Path) -> Result<ParsedDocument, String> {
    let mut doc = epub::doc::EpubDoc::new(path)
        .map_err(|e| format!("Failed to open EPUB {}: {e}", path.display()))?;

    let mut all_text = String::new();
    let spine_ids: Vec<String> = doc.spine.iter().map(|item| item.idref.clone()).collect();

    for id in &spine_ids {
        if let Some((content, _mime)) = doc.get_resource_str(id) {
            let chapter_text = html_to_text(&content);
            let trimmed = chapter_text.trim();
            if !trimmed.is_empty() {
                if !all_text.is_empty() {
                    all_text.push_str("\n\n");
                }
                all_text.push_str(trimmed);
            }
        }
    }

    if all_text.is_empty() {
        return Err(format!("EPUB contains no extractable text: {}", path.display()));
    }

    Ok(ParsedDocument {
        text: all_text,
        is_markdown: false,
    })
}

/// Convert HTML to plain text using html2text crate.
/// Handles entities, comments, CDATA, self-closing tags correctly.
fn html_to_text(html: &str) -> String {
    html2text::from_read(html.as_bytes(), 200)
        .unwrap_or_default()
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
