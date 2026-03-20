use serde::Serialize;
use std::fs;
use std::path::PathBuf;

use crate::config;
use crate::file_ops::atomic_write;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMdEntry {
    pub label: String,
    pub path: String,
    pub exists: bool,
}

/// List all known CLAUDE.md locations: global + per-project
#[tauri::command]
pub async fn list_claude_md_files() -> Result<Vec<ClaudeMdEntry>, String> {
    tokio::task::spawn_blocking(|| {
        let mut entries = Vec::new();

        // Global ~/.claude/CLAUDE.md
        let global = crate::config::home_dir()
            .join(".claude")
            .join("CLAUDE.md");
        entries.push(ClaudeMdEntry {
            label: "Global".to_string(),
            path: global.to_string_lossy().into_owned(),
            exists: global.exists(),
        });

        // Per-project: read projects.json and check each
        let claude_home = crate::config::home_dir().join(".claude");
        let projects_path = config::config_dir().join("projects.json");
        match fs::read_to_string(&projects_path) {
            Ok(data) => match serde_json::from_str::<serde_json::Value>(&data) {
                Ok(config) => {
                    if let Some(projects) = config.get("projects").and_then(|v| v.as_array()) {
                        for proj in projects {
                            let name = proj.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                            let path = proj.get("path").and_then(|v| v.as_str()).unwrap_or("");
                            if path.is_empty() {
                                continue;
                            }
                            let claude_md = PathBuf::from(path).join("CLAUDE.md");
                            entries.push(ClaudeMdEntry {
                                label: name.to_string(),
                                path: claude_md.to_string_lossy().into_owned(),
                                exists: claude_md.exists(),
                            });

                            // Memory files: ~/.claude/projects/{hash}/memory/
                            let project_hash = path.replace('/', "-");
                            let memory_dir = claude_home.join("projects").join(&project_hash).join("memory");
                            if memory_dir.is_dir() {
                                if let Ok(dir_entries) = fs::read_dir(&memory_dir) {
                                    for entry in dir_entries.flatten() {
                                        let ft = entry.file_type();
                                        if ft.map(|t| !t.is_file()).unwrap_or(true) {
                                            continue;
                                        }
                                        let file_name = entry.file_name();
                                        let file_name_str = file_name.to_string_lossy();
                                        if !file_name_str.ends_with(".md") {
                                            continue;
                                        }
                                        let label = if file_name_str == "MEMORY.md" {
                                            format!("{name}: Memory Index")
                                        } else {
                                            let stem = file_name_str.trim_end_matches(".md");
                                            format!("{name}: Memory: {stem}")
                                        };
                                        let file_path = entry.path();
                                        entries.push(ClaudeMdEntry {
                                            label,
                                            path: file_path.to_string_lossy().into_owned(),
                                            exists: true,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => eprintln!("[claude_md] Failed to parse {}: {e}", projects_path.display()),
            },
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                eprintln!("[claude_md] Failed to read {}: {e}", projects_path.display());
            }
            _ => {}
        }

        Ok(entries)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Read CLAUDE.md content. Returns empty string if file doesn't exist.
#[tauri::command]
pub async fn read_claude_md(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        crate::files::validate_path_safe(p)?;
        if !p.exists() {
            return Ok(String::new());
        }
        fs::read_to_string(p).map_err(|e| format!("Failed to read CLAUDE.md: {e}"))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Save CLAUDE.md content (atomic write). Creates parent dirs if needed.
#[tauri::command]
pub async fn save_claude_md(path: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        crate::files::validate_path_safe(p)?;
        atomic_write(p, content.as_bytes())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
