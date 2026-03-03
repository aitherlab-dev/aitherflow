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


/// Load agents config from disk. Returns default config with Workspace agent if file doesn't exist.
#[tauri::command]
pub async fn load_agents() -> Result<AgentsConfig, String> {
    tokio::task::spawn_blocking(move || {
        let path = agents_path();
        if !path.exists() {
            // Return default with one Workspace agent
            let agent = make_default_agent();
            return Ok(AgentsConfig {
                active_agent_id: Some(agent.id.clone()),
                agents: vec![agent],
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

/// Create a default Workspace agent entry
fn make_default_agent() -> AgentEntry {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    AgentEntry {
        id: uuid::Uuid::new_v4().to_string(),
        project_path: config::get_workspace_path(),
        project_name: "Workspace".to_string(),
        created_at: now,
        order: 0,
    }
}

/// Initialize agents.json on startup.
///
/// - First launch: create default Workspace agent + migrate old chats
/// - Subsequent launches: find Workspace agent by path, discard the rest
///
/// Called from setup().
pub fn ensure_agents_file() {
    let path = agents_path();

    if !path.exists() {
        // First launch: create Workspace agent
        let agent = make_default_agent();
        let agent_id = agent.id.clone();

        let config = AgentsConfig {
            active_agent_id: Some(agent.id.clone()),
            agents: vec![agent],
        };

        match serde_json::to_string_pretty(&config) {
            Ok(data) => {
                if let Err(e) = atomic_write(&path, data.as_bytes()) {
                    eprintln!("[aitherflow] Failed to write agents.json: {e}");
                    return;
                }
            }
            Err(e) => {
                eprintln!("[aitherflow] Failed to serialize agents: {e}");
                return;
            }
        }

        // Migrate old chats without agent_id
        migrate_old_chats(&agent_id);
        return;
    }

    // File exists: reset to only the Workspace agent
    let data = match fs::read_to_string(&path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[aitherflow] Failed to read agents.json: {e}");
            return;
        }
    };

    let mut config: AgentsConfig = match serde_json::from_str(&data) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[aitherflow] Failed to parse agents.json: {e}");
            return;
        }
    };

    // Find the Workspace agent by path (not by position — user may have reordered)
    let workspace_path = config::get_workspace_path();
    let workspace = config
        .agents
        .iter()
        .find(|a| a.project_path == workspace_path)
        .cloned()
        .unwrap_or_else(make_default_agent);

    config.active_agent_id = Some(workspace.id.clone());
    config.agents = vec![workspace];

    match serde_json::to_string_pretty(&config) {
        Ok(new_data) => {
            if let Err(e) = atomic_write(&path, new_data.as_bytes()) {
                eprintln!("[aitherflow] Failed to reset agents.json: {e}");
            }
        }
        Err(e) => eprintln!("[aitherflow] Failed to serialize agents: {e}"),
    }
}

/// Assign agent_id to all chats that don't have one yet
fn migrate_old_chats(default_agent_id: &str) {
    let chats_dir = config::config_dir().join("chats");
    if !chats_dir.exists() {
        return;
    }

    let entries = match fs::read_dir(&chats_dir) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[aitherflow] Failed to read chats dir for migration: {e}");
            return;
        }
    };

    let mut migrated = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        let data = match fs::read_to_string(&path) {
            Ok(d) => d,
            Err(_) => continue,
        };

        // Parse as generic JSON to check for agent_id field
        let mut json: serde_json::Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(obj) = json.as_object_mut() {
            if obj.get("agentId").is_none() || obj["agentId"].is_null() {
                obj.insert(
                    "agentId".to_string(),
                    serde_json::Value::String(default_agent_id.to_string()),
                );

                if let Ok(new_data) = serde_json::to_string_pretty(&json) {
                    if atomic_write(&path, new_data.as_bytes()).is_ok() {
                        migrated += 1;
                    }
                }
            }
        }
    }

    if migrated > 0 {
        eprintln!("[aitherflow] Migrated {migrated} chats with default agent_id");
    }
}
