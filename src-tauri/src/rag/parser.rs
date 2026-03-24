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
/// Applies sanitize_text() to all output.
pub fn parse_file(path: &Path) -> Result<ParsedDocument, String> {
    validate_path_safe(path)?;

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let mut doc = match ext.as_str() {
        "pdf" => parse_pdf(path)?,
        "epub" => parse_epub(path)?,
        _ => parse_text(path, &ext)?,
    };

    doc.text = sanitize_text(&doc.text);
    Ok(doc)
}

/// Also exposed for web/youtube content that bypasses parse_file.
pub fn sanitize_text(text: &str) -> String {
    let mut output = String::with_capacity(text.len());

    for line in text.lines() {
        // Remove lines that consist only of special/decorative characters
        let stripped = line.trim();
        if !stripped.is_empty() && stripped.chars().all(|c| is_decorative(c) || c.is_whitespace()) {
            continue;
        }

        // Remove non-printable characters (keep \t, spaces are already fine)
        let clean: String = line
            .chars()
            .filter(|&c| !c.is_control() || c == '\t')
            .collect();

        // Collapse repeated decorative sequences (3+ of same → removed)
        let clean = collapse_repeated_decorative(&clean);

        output.push_str(&clean);
        output.push('\n');
    }

    // Normalize multiple blank lines: 3+ consecutive → 2
    normalize_blank_lines(&output)
}

fn is_decorative(c: char) -> bool {
    matches!(c,
        '◆' | '●' | '▶' | '◀' | '▸' | '◂' | '■' | '□' | '▪' | '▫'
        | '★' | '☆' | '♦' | '♠' | '♣' | '♥' | '►' | '◄' | '▼' | '▲'
        | '○' | '◇' | '△' | '▽' | '⬤' | '⬥' | '⬦' | '─' | '━'
        | '═' | '│' | '┃' | '┌' | '┐' | '└' | '┘' | '├' | '┤'
        | '┬' | '┴' | '┼' | '╔' | '╗' | '╚' | '╝' | '╠' | '╣'
        | '╦' | '╩' | '╬' | '•'
    )
}

fn collapse_repeated_decorative(s: &str) -> String {
    if s.len() < 3 {
        return s.to_string();
    }
    let chars: Vec<char> = s.chars().collect();
    let mut result = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if is_decorative(chars[i]) {
            let c = chars[i];
            let mut count = 0;
            while i < chars.len() && chars[i] == c {
                count += 1;
                i += 1;
            }
            if count < 3 {
                for _ in 0..count {
                    result.push(c);
                }
            }
            // 3+ repeated decorative chars → skip entirely
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }
    result
}

fn normalize_blank_lines(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut blank_count = 0;
    for line in text.lines() {
        if line.trim().is_empty() {
            blank_count += 1;
            if blank_count <= 2 {
                result.push('\n');
            }
        } else {
            blank_count = 0;
            result.push_str(line);
            result.push('\n');
        }
    }
    result.trim().to_string()
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
/// Tries pdftotext first, then pdf-extract, then OCR for scanned documents.
fn parse_pdf(path: &Path) -> Result<ParsedDocument, String> {
    // Try pdftotext CLI first (better quality for complex PDFs)
    match parse_pdf_pdftotext(path) {
        Ok(doc) => return Ok(doc),
        Err(e) => {
            eprintln!("[rag] pdftotext failed, falling back to pdf-extract: {e}");
        }
    }

    // Fallback: pdf-extract crate
    match parse_pdf_extract(path) {
        Ok(doc) => return Ok(doc),
        Err(e) => {
            eprintln!("[rag] pdf-extract failed, falling back to OCR: {e}");
        }
    }

    // Final fallback: OCR for scanned documents (images without text layer)
    parse_pdf_ocr(path)
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

/// Fallback OCR extraction for scanned PDFs using PP-OCR ONNX models.
fn parse_pdf_ocr(path: &Path) -> Result<ParsedDocument, String> {
    eprintln!("[rag] Attempting OCR for scanned PDF: {}", path.display());
    let text = super::ocr::ocr_pdf(path)?;
    Ok(ParsedDocument {
        text,
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
pub(crate) fn extract_markdown_text(md: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    // --- sanitize_text ---

    #[test]
    fn sanitize_removes_decorative_only_lines() {
        let input = "Hello\n●●●\nWorld";
        let result = sanitize_text(input);
        assert_eq!(result, "Hello\nWorld");
    }

    #[test]
    fn sanitize_removes_control_chars() {
        let input = "Hello\x01\x02World";
        let result = sanitize_text(input);
        assert_eq!(result, "HelloWorld");
    }

    #[test]
    fn sanitize_keeps_tabs() {
        let input = "Hello\tWorld";
        let result = sanitize_text(input);
        assert_eq!(result, "Hello\tWorld");
    }

    #[test]
    fn sanitize_collapses_blank_lines() {
        let input = "A\n\n\n\n\nB";
        let result = sanitize_text(input);
        assert_eq!(result, "A\n\n\nB");
    }

    #[test]
    fn sanitize_empty_input() {
        assert_eq!(sanitize_text(""), "");
    }

    // --- collapse_repeated_decorative ---

    #[test]
    fn collapse_keeps_two_decorative() {
        assert_eq!(collapse_repeated_decorative("══"), "══");
    }

    #[test]
    fn collapse_removes_three_plus_decorative() {
        assert_eq!(collapse_repeated_decorative("═══"), "");
        assert_eq!(collapse_repeated_decorative("══════"), "");
    }

    #[test]
    fn collapse_preserves_normal_text() {
        assert_eq!(collapse_repeated_decorative("hello"), "hello");
    }

    #[test]
    fn collapse_mixed_content() {
        assert_eq!(collapse_repeated_decorative("text═══more"), "textmore");
    }

    #[test]
    fn collapse_short_string() {
        assert_eq!(collapse_repeated_decorative("ab"), "ab");
        assert_eq!(collapse_repeated_decorative(""), "");
    }

    // --- normalize_blank_lines ---

    #[test]
    fn normalize_keeps_two_blanks() {
        let input = "A\n\n\nB";
        let result = normalize_blank_lines(input);
        assert_eq!(result, "A\n\n\nB");
    }

    #[test]
    fn normalize_collapses_many_blanks() {
        let input = "A\n\n\n\n\n\nB";
        let result = normalize_blank_lines(input);
        assert_eq!(result, "A\n\n\nB");
    }

    #[test]
    fn normalize_no_blanks() {
        let input = "A\nB\nC";
        let result = normalize_blank_lines(input);
        assert_eq!(result, "A\nB\nC");
    }

    // --- is_decorative ---

    #[test]
    fn decorative_chars() {
        assert!(is_decorative('●'));
        assert!(is_decorative('═'));
        assert!(is_decorative('•'));
        assert!(!is_decorative('A'));
        assert!(!is_decorative(' '));
        assert!(!is_decorative('1'));
    }

    // --- extract_markdown_text ---

    #[test]
    fn markdown_extracts_plain_text() {
        let md = "# Title\n\nSome **bold** and *italic* text.";
        let result = extract_markdown_text(md);
        assert!(result.contains("Title"));
        assert!(result.contains("Some bold and italic text."));
    }

    #[test]
    fn markdown_skips_code_blocks() {
        let md = "Text before\n\n```rust\nlet x = 1;\n```\n\nText after";
        let result = extract_markdown_text(md);
        assert!(result.contains("Text before"));
        assert!(result.contains("Text after"));
        assert!(!result.contains("let x = 1"));
    }

    #[test]
    fn markdown_keeps_inline_code() {
        let md = "Use `println!` for output.";
        let result = extract_markdown_text(md);
        assert!(result.contains("println!"));
    }

    #[test]
    fn markdown_empty() {
        assert_eq!(extract_markdown_text(""), "");
    }

    // --- html_to_text ---

    #[test]
    fn html_basic_conversion() {
        let html = "<p>Hello <b>world</b></p>";
        let result = html_to_text(html);
        assert!(result.contains("Hello"));
        assert!(result.contains("world"));
    }

    #[test]
    fn html_empty() {
        assert_eq!(html_to_text("").trim(), "");
    }
}
