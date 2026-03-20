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
fn parse_pdf_pdftotext(path: &Path) -> Result<ParsedDocument, String> {
    let output = Command::new("pdftotext")
        .args([
            path.to_str().ok_or("Invalid path encoding")?,
            "-",
            "-enc",
            "UTF-8",
            "-layout",
        ])
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
            let chapter_text = strip_html_tags(&content);
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

/// Strip HTML tags from a string, preserving text content.
/// Handles block-level elements by inserting newlines.
fn strip_html_tags(html: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag_name = String::new();
    let mut collecting_tag_name = false;

    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag_name.clear();
                collecting_tag_name = true;
            }
            '>' if in_tag => {
                in_tag = false;
                collecting_tag_name = false;
                // Insert newlines for block-level tags
                let name = tag_name.to_lowercase();
                let name = name.trim_start_matches('/');
                if matches!(
                    name,
                    "p" | "div" | "br" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                        | "li" | "tr" | "blockquote" | "section" | "article"
                ) && !output.ends_with('\n')
                {
                    output.push('\n');
                }
            }
            _ if in_tag => {
                if collecting_tag_name {
                    if ch.is_whitespace() {
                        collecting_tag_name = false;
                    } else {
                        tag_name.push(ch);
                    }
                }
            }
            '&' => {
                // Simple HTML entity handling
                output.push('&'); // Will be part of entity, but good enough for text extraction
            }
            _ => {
                output.push(ch);
            }
        }
    }

    // Clean up: collapse multiple newlines, trim
    let mut result = String::with_capacity(output.len());
    let mut prev_newline = false;
    for ch in output.chars() {
        if ch == '\n' {
            if !prev_newline {
                result.push('\n');
            }
            prev_newline = true;
        } else {
            prev_newline = false;
            result.push(ch);
        }
    }

    result.trim().to_string()
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
