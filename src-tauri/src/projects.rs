use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

use crate::config;
use crate::file_ops::{read_json, write_json};

fn default_true() -> bool {
    true
}

/// A single project bookmark
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBookmark {
    pub path: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_dirs: Vec<String>,
    #[serde(default = "default_true", skip_serializing_if = "Clone::clone")]
    pub teamwork_enabled: bool,
}

/// A welcome screen card (user-pinned project)
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WelcomeCard {
    pub project_path: String,
    pub project_name: String,
}

/// Full projects config on disk
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsConfig {
    pub projects: Vec<ProjectBookmark>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened_project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_opened_chat_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub welcome_cards: Vec<WelcomeCard>,
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
                    teamwork_enabled: true,
                }],
                last_opened_project: None,
                last_opened_chat_id: None,
                welcome_cards: Vec::new(),
            });
        }

        let mut config: ProjectsConfig = read_json(&path)?;

        // Ensure Workspace is always present as first project
        let workspace = config::workspace_dir().to_string_lossy().into_owned();
        if !config.projects.iter().any(|p| p.path == workspace) {
            config.projects.insert(
                0,
                ProjectBookmark {
                    path: workspace,
                    name: "Workspace".to_string(),
                    additional_dirs: Vec::new(),
                    teamwork_enabled: true,
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
    last_opened_chat_id: Option<String>,
    welcome_cards: Vec<WelcomeCard>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let config = ProjectsConfig {
            projects,
            last_opened_project,
            last_opened_chat_id,
            welcome_cards,
        };
        write_json(&projects_path(), &config)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Initialize projects.json with Workspace if it doesn't exist yet.
/// Called from setup().
pub fn ensure_projects_file() -> Result<(), String> {
    let path = projects_path();
    if path.exists() {
        return Ok(());
    }
    let workspace = config::workspace_dir().to_string_lossy().into_owned();
    let config = ProjectsConfig {
        projects: vec![ProjectBookmark {
            path: workspace,
            name: "Workspace".to_string(),
            additional_dirs: Vec::new(),
            teamwork_enabled: true,
        }],
        last_opened_project: None,
        last_opened_chat_id: None,
        welcome_cards: Vec::new(),
    };
    write_json(&path, &config)
}

/// Check if teamwork is enabled for a project (sync, for use in spawn_blocking).
pub fn is_teamwork_enabled_sync(project_path: &str) -> bool {
    let path = projects_path();
    if !path.exists() {
        return true;
    }
    let config: ProjectsConfig = match read_json(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[projects] Failed to read projects.json: {e}");
            return false;
        }
    };
    config
        .projects
        .iter()
        .any(|p| p.path == project_path && p.teamwork_enabled)
}

/// Return the teamwork slug for a project path (for frontend use).
#[tauri::command]
pub async fn get_teamwork_slug(project_path: String) -> Result<String, String> {
    Ok(project_teamwork_slug(&project_path))
}

/// Generate a safe filesystem slug from a project path for mailbox/tasks isolation.
/// Returns `p_` + 16 hex chars of SHA-256 hash (first 8 bytes).
pub fn project_teamwork_slug(project_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(project_path.as_bytes());
    let hash = hasher.finalize();
    let bytes: [u8; 8] = hash[..8].try_into().expect("SHA-256 always has 32 bytes");
    format!("p_{:016x}", u64::from_be_bytes(bytes))
}
