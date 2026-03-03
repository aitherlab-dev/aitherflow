use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::config;
use crate::file_ops::atomic_write;

/// A single project bookmark
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBookmark {
    pub path: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_dirs: Vec<String>,
}

/// Full projects config on disk
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsConfig {
    pub projects: Vec<ProjectBookmark>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened_project: Option<String>,
}

/// Path to projects.json
fn projects_path() -> PathBuf {
    config::config_dir().join("projects.json")
}


/// Load projects config from disk. Returns default config with Workspace if file doesn't exist.
#[tauri::command]
pub async fn load_projects() -> Result<ProjectsConfig, String> {
    tokio::task::spawn_blocking(move || {
        let path = projects_path();
        if !path.exists() {
            let workspace = config::workspace_dir().to_string_lossy().into_owned();
            return Ok(ProjectsConfig {
                projects: vec![ProjectBookmark {
                    path: workspace,
                    name: "Workspace".to_string(),
                    additional_dirs: Vec::new(),
                }],
                last_opened_project: None,
            });
        }

        let data = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read projects.json: {e}"))?;
        let mut config: ProjectsConfig =
            serde_json::from_str(&data).map_err(|e| format!("Failed to parse projects.json: {e}"))?;

        // Ensure Workspace is always present as first project
        let workspace = config::workspace_dir().to_string_lossy().into_owned();
        if !config.projects.iter().any(|p| p.path == workspace) {
            config.projects.insert(
                0,
                ProjectBookmark {
                    path: workspace,
                    name: "Workspace".to_string(),
                    additional_dirs: Vec::new(),
                },
            );
        }

        Ok(config)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Save projects config to disk (atomic write)
#[tauri::command]
pub async fn save_projects(
    projects: Vec<ProjectBookmark>,
    last_opened_project: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let config = ProjectsConfig {
            projects,
            last_opened_project,
        };
        let data = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize projects: {e}"))?;
        atomic_write(&projects_path(), data.as_bytes())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Initialize projects.json with Workspace if it doesn't exist yet.
/// Called from setup().
pub fn ensure_projects_file() {
    let path = projects_path();
    if path.exists() {
        return;
    }
    let workspace = config::workspace_dir().to_string_lossy().into_owned();
    let config = ProjectsConfig {
        projects: vec![ProjectBookmark {
            path: workspace,
            name: "Workspace".to_string(),
            additional_dirs: Vec::new(),
        }],
        last_opened_project: None,
    };
    match serde_json::to_string_pretty(&config) {
        Ok(data) => {
            if let Err(e) = atomic_write(&path, data.as_bytes()) {
                eprintln!("[aitherflow] Failed to write projects.json: {e}");
            }
        }
        Err(e) => eprintln!("[aitherflow] Failed to serialize projects: {e}"),
    }
}
