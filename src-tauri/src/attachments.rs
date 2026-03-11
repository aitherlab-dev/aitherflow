use base64::Engine;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Temp directory for paste images
fn temp_dir() -> PathBuf {
    PathBuf::from("/tmp/aither-flow")
}

/// Delete temp files older than `max_age_secs`
pub fn cleanup_old_temp(max_age_secs: u64) {
    cleanup_dir_old_files(&temp_dir(), max_age_secs);
    cleanup_dir_old_files(&std::env::temp_dir().join("aitherflow-tg"), max_age_secs);
}

fn cleanup_dir_old_files(dir: &Path, max_age_secs: u64) {
    if !dir.exists() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    for entry in entries.flatten() {
        if let Ok(meta) = entry.metadata() {
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if now.saturating_sub(modified) > max_age_secs {
                if let Err(e) = fs::remove_file(entry.path()) {
                    eprintln!("[attachments] Failed to remove expired file {:?}: {e}", entry.path());
                }
            }
        }
    }
}

/// Parse a data URI into (media_type, raw_base64).
/// e.g. "data:image/png;base64,iVBOR..." → ("image/png", "iVBOR...")
pub fn parse_data_uri(uri: &str) -> Option<(&str, &str)> {
    let rest = uri.strip_prefix("data:")?;
    let semi = rest.find(';')?;
    let media_type = &rest[..semi];
    let after_semi = &rest[semi + 1..];
    let data = after_semi.strip_prefix("base64,")?;
    Some((media_type, data))
}

/// Determine MIME type from file extension
fn mime_from_ext(ext: &str) -> Option<(&'static str, &'static str)> {
    // Returns (mime_type, category)
    match ext.to_lowercase().as_str() {
        "png" => Some(("image/png", "image")),
        "jpg" | "jpeg" => Some(("image/jpeg", "image")),
        "gif" => Some(("image/gif", "image")),
        "webp" => Some(("image/webp", "image")),
        "svg" => Some(("image/svg+xml", "image")),
        "txt" | "log" => Some(("text/plain", "text")),
        "rs" => Some(("text/x-rust", "text")),
        "ts" | "tsx" => Some(("text/typescript", "text")),
        "js" | "jsx" => Some(("text/javascript", "text")),
        "py" => Some(("text/x-python", "text")),
        "md" => Some(("text/markdown", "text")),
        "toml" => Some(("text/toml", "text")),
        "json" => Some(("application/json", "text")),
        "yaml" | "yml" => Some(("text/yaml", "text")),
        "css" => Some(("text/css", "text")),
        "html" | "htm" => Some(("text/html", "text")),
        "sh" | "bash" | "fish" | "zsh" => Some(("text/x-shellscript", "text")),
        "c" | "h" => Some(("text/x-c", "text")),
        "cpp" | "hpp" | "cc" => Some(("text/x-c++", "text")),
        "go" => Some(("text/x-go", "text")),
        "rb" => Some(("text/x-ruby", "text")),
        "java" => Some(("text/x-java", "text")),
        "xml" => Some(("text/xml", "text")),
        "csv" => Some(("text/csv", "text")),
        "sql" => Some(("text/x-sql", "text")),
        _ => None,
    }
}

/// Result of processing a file
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessedFile {
    pub name: String,
    /// For images: data URI. For text: file content as string.
    pub content: String,
    pub size: u64,
    pub file_type: String,
}

/// Read a file, determine type, encode for frontend
#[tauri::command]
pub async fn process_file(path: String) -> Result<ProcessedFile, String> {
    tokio::task::spawn_blocking(move || {
        let file_path = Path::new(&path);
        crate::files::validate_path_safe(file_path)?;
        if !file_path.exists() {
            return Err(format!("File not found: {path}"));
        }

        let meta = fs::metadata(file_path)
            .map_err(|e| format!("Failed to read file metadata: {e}"))?;
        let size = meta.len();

        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        let (mime, category) = mime_from_ext(ext)
            .ok_or_else(|| format!("Unsupported file type: .{ext}"))?;

        let name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();

        match category {
            "image" => {
                if size > 20 * 1024 * 1024 {
                    return Err("Image too large (max 20 MB)".into());
                }
                let bytes = fs::read(file_path)
                    .map_err(|e| format!("Failed to read file: {e}"))?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let data_uri = format!("data:{mime};base64,{b64}");
                Ok(ProcessedFile {
                    name,
                    content: data_uri,
                    size,
                    file_type: "image".into(),
                })
            }
            "text" => {
                if size > 1024 * 1024 {
                    return Err("Text file too large (max 1 MB)".into());
                }
                let text = fs::read_to_string(file_path)
                    .map_err(|e| format!("Failed to read text file: {e}"))?;
                Ok(ProcessedFile {
                    name,
                    content: text,
                    size,
                    file_type: "text".into(),
                })
            }
            _ => Err(format!("Unsupported category: {category}")),
        }
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Result of reading clipboard image
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImage {
    pub path: String,
    pub preview: String,
    pub size: u64,
    pub filename: String,
}

/// Read image from system clipboard (Wayland/X11 fallback)
#[tauri::command]
pub async fn read_clipboard_image() -> Result<ClipboardImage, String> {
    tokio::task::spawn_blocking(move || {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|e| format!("Failed to open clipboard: {e}"))?;

        let img = clipboard
            .get_image()
            .map_err(|e| format!("No image in clipboard: {e}"))?;

        // Encode RGBA data to PNG
        let mut png_buf: Vec<u8> = Vec::new();
        {
            let encoder = image::codecs::png::PngEncoder::new(&mut png_buf);
            use image::ImageEncoder;
            encoder
                .write_image(
                    &img.bytes,
                    img.width as u32,
                    img.height as u32,
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| format!("Failed to encode PNG: {e}"))?;
        }

        // Save to temp
        let dir = temp_dir();
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create temp dir: {e}"))?;

        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let filename = format!("paste-{ts}.png");
        let file_path = dir.join(&filename);

        let mut file = fs::File::create(&file_path)
            .map_err(|e| format!("Failed to create temp file: {e}"))?;
        file.write_all(&png_buf)
            .map_err(|e| format!("Failed to write temp file: {e}"))?;

        let size = png_buf.len() as u64;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png_buf);
        let preview = format!("data:image/png;base64,{b64}");

        Ok(ClipboardImage {
            path: file_path.to_string_lossy().into_owned(),
            preview,
            size,
            filename,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Read text from system clipboard (Wayland/X11 fallback)
#[tauri::command]
pub async fn read_clipboard_text() -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|e| format!("Failed to open clipboard: {e}"))?;

        clipboard
            .get_text()
            .map_err(|e| format!("No text in clipboard: {e}"))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Delete a temp file (only within /tmp/aither-flow/)
#[tauri::command]
pub async fn cleanup_temp_file(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let file_path = Path::new(&path);
        let dir = temp_dir();
        // Safety: canonicalize to resolve symlinks and ".." before checking prefix
        let canonical = file_path
            .canonicalize()
            .map_err(|e| format!("Cannot resolve path: {e}"))?;
        let canonical_dir = dir
            .canonicalize()
            .map_err(|e| format!("Cannot resolve temp dir: {e}"))?;
        if !canonical.starts_with(&canonical_dir) {
            return Err("Path is outside temp directory".into());
        }
        fs::remove_file(&canonical)
            .map_err(|e| format!("Failed to delete temp file: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_data_uri_png() {
        let uri = "data:image/png;base64,iVBORw0KGgo=";
        let result = parse_data_uri(uri);
        assert_eq!(result, Some(("image/png", "iVBORw0KGgo=")));
    }

    #[test]
    fn parse_data_uri_jpeg() {
        let uri = "data:image/jpeg;base64,/9j/4AAQ";
        let result = parse_data_uri(uri);
        assert_eq!(result, Some(("image/jpeg", "/9j/4AAQ")));
    }

    #[test]
    fn parse_data_uri_no_prefix() {
        assert_eq!(parse_data_uri("image/png;base64,abc"), None);
    }

    #[test]
    fn parse_data_uri_no_base64() {
        assert_eq!(parse_data_uri("data:image/png;charset=utf-8,abc"), None);
    }

    #[test]
    fn parse_data_uri_no_semicolon() {
        assert_eq!(parse_data_uri("data:image/png"), None);
    }

    #[test]
    fn parse_data_uri_empty() {
        assert_eq!(parse_data_uri(""), None);
    }
}
