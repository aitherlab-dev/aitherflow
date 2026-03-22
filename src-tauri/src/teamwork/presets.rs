use serde::{Deserialize, Serialize};
use tauri::Manager;
use uuid::Uuid;

use crate::conductor::session::SessionManager;
use crate::conductor::types::StartSessionOptions;
use crate::config;
use crate::file_ops::{read_json, write_json};
use std::path::PathBuf;

use super::roles::{default_roles, AgentRole};

#[derive(Serialize, Deserialize, Clone)]
pub struct TeamPreset {
    pub id: String,
    pub name: String,
    pub roles: Vec<String>,
    pub is_builtin: bool,
}

pub fn default_presets() -> Vec<TeamPreset> {
    vec![
        TeamPreset {
            id: "builtin-feature".into(),
            name: "Feature".into(),
            roles: vec!["Architect".into(), "Coder".into(), "Reviewer".into()],
            is_builtin: true,
        },
        TeamPreset {
            id: "builtin-bugfix".into(),
            name: "Bug fix".into(),
            roles: vec!["Coder".into(), "Reviewer".into()],
            is_builtin: true,
        },
        TeamPreset {
            id: "builtin-research".into(),
            name: "Research".into(),
            roles: vec!["Architect".into(), "Researcher".into()],
            is_builtin: true,
        },
    ]
}

fn custom_presets_path() -> PathBuf {
    config::config_dir().join("team_presets.json")
}

fn read_custom_presets_sync() -> Vec<TeamPreset> {
    let path = custom_presets_path();
    if !path.exists() {
        return Vec::new();
    }
    read_json::<Vec<TeamPreset>>(&path).unwrap_or_else(|e| {
        eprintln!("[teamwork] Failed to read custom presets: {e}");
        Vec::new()
    })
}

fn write_custom_presets_sync(presets: &[TeamPreset]) -> Result<(), String> {
    write_json(&custom_presets_path(), presets)
}

fn all_presets_sync() -> Vec<TeamPreset> {
    let mut all = default_presets();
    let custom = read_custom_presets_sync();
    all.extend(custom);
    all
}

#[tauri::command]
pub async fn presets_list() -> Result<Vec<TeamPreset>, String> {
    tokio::task::spawn_blocking(|| {
        let mut result = default_presets();
        let custom = read_custom_presets_sync();
        result.extend(custom);
        Ok(result)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn presets_save(preset: TeamPreset) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        if preset.name.trim().is_empty() {
            return Err("Preset name cannot be empty".to_string());
        }
        if preset.roles.is_empty() {
            return Err("Preset must have at least one role".to_string());
        }
        let mut custom = read_custom_presets_sync();
        if let Some(existing) = custom.iter_mut().find(|p| p.id == preset.id) {
            existing.name = preset.name;
            existing.roles = preset.roles;
        } else {
            let mut new_preset = preset;
            new_preset.is_builtin = false;
            if new_preset.id.is_empty() {
                new_preset.id = Uuid::new_v4().to_string();
            }
            custom.push(new_preset);
        }
        write_custom_presets_sync(&custom)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn presets_delete(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // Cannot delete built-in presets
        if default_presets().iter().any(|p| p.id == id) {
            return Err("Cannot delete a built-in preset".to_string());
        }
        let mut custom = read_custom_presets_sync();
        let before = custom.len();
        custom.retain(|p| p.id != id);
        if custom.len() == before {
            return Err(format!("Preset '{id}' not found"));
        }
        write_custom_presets_sync(&custom)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Find an AgentRole by name from defaults + custom roles.
fn find_role_by_name(name: &str) -> Option<AgentRole> {
    let defaults = default_roles();
    if let Some(r) = defaults.into_iter().find(|r| r.name.eq_ignore_ascii_case(name)) {
        return Some(r);
    }
    // Check custom roles
    let custom_path = config::config_dir().join("custom_roles.json");
    if custom_path.exists() {
        if let Ok(custom) = read_json::<Vec<AgentRole>>(&custom_path) {
            if let Some(r) = custom.into_iter().find(|r| r.name.eq_ignore_ascii_case(name)) {
                return Some(r);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn presets_launch(
    app: tauri::AppHandle,
    project_path: String,
    preset_id: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<Vec<String>, String> {
    // Find the preset (sync file I/O for custom presets)
    let preset = tokio::task::spawn_blocking(move || {
        all_presets_sync()
            .into_iter()
            .find(|p| p.id == preset_id)
            .ok_or_else(|| format!("Preset '{preset_id}' not found"))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    // Resolve roles (sync file I/O for custom roles)
    let roles_to_launch: Vec<(String, AgentRole)> = tokio::task::spawn_blocking(move || {
        let mut resolved = Vec::new();
        for role_name in &preset.roles {
            let role = find_role_by_name(role_name)
                .ok_or_else(|| format!("Role '{}' not found", role_name))?;
            let agent_id = Uuid::new_v4().to_string();
            resolved.push((agent_id, role));
        }
        Ok::<_, String>(resolved)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    let mut agent_ids = Vec::new();

    for (agent_id, role) in roles_to_launch {
        agent_ids.push(agent_id.clone());

        let options = StartSessionOptions {
            agent_id: Some(agent_id),
            prompt: String::new(),
            project_path: Some(project_path.clone()),
            model: model.clone(),
            effort: effort.clone(),
            resume_session_id: None,
            permission_mode: None,
            chrome: false,
            attachments: vec![],
            role_system_prompt: Some(role.system_prompt),
            role_allowed_tools: Some(role.allowed_tools),
        };

        let sessions = app.state::<SessionManager>();
        crate::conductor::start_session(app.clone(), sessions, options).await?;
    }

    Ok(agent_ids)
}
