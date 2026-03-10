use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::config;
use crate::file_ops::atomic_write;

/// A single agent entry (tab in sidebar)
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentEntry {
    pub id: String,
    pub project_path: String,
    pub project_name: String,
    pub created_at: u64,
    #[serde(default)]
    pub order: u32,
}

/// Full agents config on disk
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentsConfig {
    pub agents: Vec<AgentEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_agent_id: Option<String>,
}

/// Path to agents.json
fn agents_path() -> PathBuf {
    config::config_dir().join("agents.json")
}


/// Load agents config from disk. Returns empty config if file doesn't exist.
#[tauri::command]
pub async fn load_agents() -> Result<AgentsConfig, String> {
    tokio::task::spawn_blocking(move || {
        let path = agents_path();
        if !path.exists() {
            return Ok(AgentsConfig {
                active_agent_id: None,
                agents: vec![],
            });
        }

        let data = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read agents.json: {e}"))?;
        serde_json::from_str(&data).map_err(|e| format!("Failed to parse agents.json: {e}"))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Save agents config to disk (atomic write)
#[tauri::command]
pub async fn save_agents(
    agents: Vec<AgentEntry>,
    active_agent_id: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let config = AgentsConfig {
            agents,
            active_agent_id,
        };
        let data = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize agents: {e}"))?;
        atomic_write(&agents_path(), data.as_bytes())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Initialize agents.json on startup.
///
/// Resets to empty state — no tabs open. The user picks a project
/// from the Welcome screen, which creates the first tab.
///
/// Called from setup().
pub fn ensure_agents_file() {
    let path = agents_path();

    if path.exists() {
        return;
    }

    let config = AgentsConfig {
        active_agent_id: None,
        agents: vec![],
    };

    match serde_json::to_string_pretty(&config) {
        Ok(data) => {
            if let Err(e) = atomic_write(&path, data.as_bytes()) {
                eprintln!("[aitherflow] Failed to write agents.json: {e}");
            }
        }
        Err(e) => eprintln!("[aitherflow] Failed to serialize agents: {e}"),
    }
}

