use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::config;
use crate::file_ops::{read_json, write_json};

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

        read_json(&path)
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
        write_json(&agents_path(), &config)
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
pub fn ensure_agents_file() -> Result<(), String> {
    let path = agents_path();

    let config = AgentsConfig {
        active_agent_id: None,
        agents: vec![],
    };

    write_json(&path, &config)
}

