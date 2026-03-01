use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;

use crate::config;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub added_at: u64,
}

fn projects_path() -> std::path::PathBuf {
    config::config_dir().join("projects.json")
}

#[tauri::command]
pub async fn load_projects() -> Result<Vec<ProjectEntry>, String> {
    tokio::task::spawn_blocking(|| {
        let path = projects_path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        let data = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read projects.json: {e}"))?;
        let projects: Vec<ProjectEntry> = serde_json::from_str(&data)
            .map_err(|e| format!("Failed to parse projects.json: {e}"))?;
        Ok(projects)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn save_projects(projects: Vec<ProjectEntry>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = projects_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config dir: {e}"))?;
        }

        let data = serde_json::to_string_pretty(&projects)
            .map_err(|e| format!("Failed to serialize projects: {e}"))?;

        // Atomic write: temp file + rename
        let tmp = path.with_extension("json.tmp");
        let mut file = fs::File::create(&tmp)
            .map_err(|e| format!("Failed to create temp file: {e}"))?;
        file.write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write temp file: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync temp file: {e}"))?;
        fs::rename(&tmp, &path)
            .map_err(|e| format!("Failed to rename temp file: {e}"))?;

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
