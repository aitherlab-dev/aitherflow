use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;

use crate::files::validate_path_safe;

const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024; // 5 MB

/// Result of reading a file
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub is_binary: bool,
    pub content: Option<String>,
    pub size: u64,
    pub language: Option<String>,
}

/// Map file extension to highlight.js language name
fn detect_language(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    let lang = match ext.as_str() {
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "json" => "json",
        "md" | "markdown" => "markdown",
        "css" | "scss" | "less" => "css",
        "html" | "htm" | "xml" | "svg" => "xml",
        "py" | "pyw" => "python",
        "sh" | "bash" | "zsh" | "fish" => "bash",
        "toml" => "ini",
        "yaml" | "yml" => "yaml",
        "sql" => "sql",
        _ => return None,
    };
    Some(lang.to_string())
}

/// Check if content is likely binary by scanning for null bytes
fn is_binary(data: &[u8]) -> bool {
    let check_len = data.len().min(8192);
    data[..check_len].contains(&0)
}

/// Atomic write: write to temp file, then rename
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create dir {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("aither_tmp");
    let mut file =
        fs::File::create(&tmp).map_err(|e| format!("Failed to create temp file: {e}"))?;
    file.write_all(data)
        .map_err(|e| format!("Failed to write temp file: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("Failed to sync temp file: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("Failed to rename temp file: {e}"))?;
    Ok(())
}

/// Read file content with size/binary checks and language detection
#[tauri::command]
pub async fn read_file(path: String) -> Result<FileContent, String> {
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);

        validate_path_safe(p)?;

        let meta = fs::metadata(p).map_err(|e| format!("Cannot read file: {e}"))?;
        let size = meta.len();

        if size > MAX_FILE_SIZE {
            return Err(format!("File too large ({} MB, limit 5 MB)", size / 1024 / 1024));
        }

        let raw = fs::read(p).map_err(|e| format!("Failed to read file: {e}"))?;

        if is_binary(&raw) {
            return Ok(FileContent {
                is_binary: true,
                content: None,
                size,
                language: None,
            });
        }

        let text = String::from_utf8_lossy(&raw).into_owned();
        let language = detect_language(p);

        Ok(FileContent {
            is_binary: false,
            content: Some(text),
            size,
            language,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Write file content (atomic: temp + rename)
#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        validate_path_safe(p)?;
        atomic_write(p, content.as_bytes())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Delete a file
#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        validate_path_safe(p)?;
        fs::remove_file(p).map_err(|e| format!("Failed to delete file: {e}"))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Move file or directory to system trash
#[tauri::command]
pub async fn trash_entry(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        validate_path_safe(p)?;
        trash::delete(p).map_err(|e| format!("Failed to move to trash: {e}"))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Create a new directory
#[tauri::command]
pub async fn create_directory(path: String, name: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let parent = Path::new(&path);
        validate_path_safe(parent)?;
        // Reject path separators and traversal in name
        if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
            return Err(format!("Invalid name: '{}'", name));
        }
        let target = parent.join(&name);
        if target.exists() {
            return Err(format!("'{}' already exists", name));
        }
        fs::create_dir(&target).map_err(|e| format!("Failed to create directory: {e}"))?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Create a new empty file
#[tauri::command]
pub async fn create_file(path: String, name: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let parent = Path::new(&path);
        validate_path_safe(parent)?;
        // Reject path separators and traversal in name
        if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
            return Err(format!("Invalid name: '{}'", name));
        }
        let target = parent.join(&name);
        if target.exists() {
            return Err(format!("'{}' already exists", name));
        }
        fs::File::create(&target).map_err(|e| format!("Failed to create file: {e}"))?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Copy a file or directory recursively
#[tauri::command]
pub async fn copy_entry(src: String, dest_dir: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let src_path = Path::new(&src);
        let dest_parent = Path::new(&dest_dir);
        validate_path_safe(src_path)?;
        validate_path_safe(dest_parent)?;

        let file_name = src_path
            .file_name()
            .ok_or("Invalid source path")?
            .to_string_lossy();

        // Find a unique name if target exists
        let mut target = dest_parent.join(file_name.as_ref());
        if target.exists() {
            let stem = src_path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let ext = src_path
                .extension()
                .map(|s| format!(".{}", s.to_string_lossy()))
                .unwrap_or_default();
            let mut i = 1u32;
            loop {
                let candidate = format!("{stem} (copy{i_suffix}){ext}",
                    i_suffix = if i == 1 { String::new() } else { format!(" {i}") });
                target = dest_parent.join(&candidate);
                if !target.exists() {
                    break;
                }
                i += 1;
            }
        }

        if src_path.is_dir() {
            copy_dir_recursive(src_path, &target)?;
        } else {
            fs::copy(src_path, &target)
                .map_err(|e| format!("Failed to copy file: {e}"))?;
        }

        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Recursively copy a directory
fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir(dest).map_err(|e| format!("Failed to create dir: {e}"))?;
    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read dir: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        let ft = entry.file_type().map_err(|e| format!("Failed to get file type: {e}"))?;
        let dest_child = dest.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_child)?;
        } else {
            fs::copy(entry.path(), &dest_child)
                .map_err(|e| format!("Failed to copy: {e}"))?;
        }
    }
    Ok(())
}

/// Get current file content as a snapshot (for reject support).
/// Returns None if the file doesn't exist.
#[tauri::command]
pub async fn file_snapshot(path: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        if !p.exists() {
            return Ok(None);
        }
        validate_path_safe(p)?;

        let meta = fs::metadata(p).map_err(|e| format!("Cannot read file: {e}"))?;
        if meta.len() > MAX_FILE_SIZE {
            return Err("File too large for snapshot".into());
        }

        let raw = fs::read(p).map_err(|e| format!("Failed to read file: {e}"))?;
        if is_binary(&raw) {
            return Err("Cannot snapshot binary file".into());
        }

        Ok(Some(String::from_utf8_lossy(&raw).into_owned()))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
