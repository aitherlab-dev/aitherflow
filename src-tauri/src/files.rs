use serde::Serialize;
use std::fs;
use std::path::Path;

/// Single entry in a directory listing
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Names to skip when listing directories
const IGNORED: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".cache",
    ".venv",
    "__pycache__",
];

/// Check that path is under $HOME, /tmp, /mnt, or /run/media (canonicalized).
pub fn validate_path_safe(path: &Path) -> Result<(), String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve path: {e}"))?;

    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let allowed: &[&Path] = &[
        &home,
        Path::new("/tmp"),
        Path::new("/mnt"),
        Path::new("/run/media"),
    ];

    if allowed.iter().any(|prefix| canonical.starts_with(prefix)) {
        Ok(())
    } else {
        Err("Path is outside allowed directories".into())
    }
}

/// Mount point entry
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountEntry {
    pub name: String,
    pub path: String,
}

/// List mounted drives from /mnt/* and /run/media/$USER/*.
/// Uses file_type() from dir entry (no stat call) to avoid blocking on slow mounts.
#[tauri::command]
pub async fn list_mounts() -> Result<Vec<MountEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let mut mounts: Vec<MountEntry> = Vec::new();

        let collect_dirs = |dir: &Path, out: &mut Vec<MountEntry>| {
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let is_dir = entry
                        .file_type()
                        .map(|ft| ft.is_dir())
                        .unwrap_or(false);
                    if is_dir {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        out.push(MountEntry {
                            name,
                            path: entry.path().to_string_lossy().into_owned(),
                        });
                    }
                }
            }
        };

        // /mnt/* subdirectories
        collect_dirs(Path::new("/mnt"), &mut mounts);

        // /run/media/$USER/* subdirectories
        if let Some(user) = std::env::var_os("USER") {
            let media_dir = Path::new("/run/media").join(user);
            collect_dirs(&media_dir, &mut mounts);
        }

        mounts.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(mounts)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Return the user's home directory path.
#[tauri::command]
pub async fn get_home_path() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    Ok(home.to_string_lossy().into_owned())
}

/// List a single directory level: folders first, then files, alphabetically.
#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let dir = Path::new(&path);

        if !dir.exists() {
            return Err(format!("Directory not found: {path}"));
        }
        if !dir.is_dir() {
            return Err(format!("Not a directory: {path}"));
        }

        validate_path_safe(dir)?;

        let entries = fs::read_dir(dir)
            .map_err(|e| format!("Failed to read directory: {e}"))?;

        let mut dirs: Vec<FileEntry> = Vec::new();
        let mut files: Vec<FileEntry> = Vec::new();

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();

            // Skip ignored directories/files
            if IGNORED.contains(&name.as_str()) {
                continue;
            }

            let entry_path = entry.path();
            let is_dir = entry_path.is_dir();
            let path_str = entry_path.to_string_lossy().into_owned();

            let fe = FileEntry {
                name: name.clone(),
                path: path_str,
                is_dir,
            };

            if is_dir {
                dirs.push(fe);
            } else {
                files.push(fe);
            }
        }

        // Sort alphabetically, case-insensitive
        dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        // Folders first, then files
        dirs.extend(files);
        Ok(dirs)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
