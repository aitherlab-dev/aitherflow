use serde::{Deserialize, Serialize};

use crate::config;
use crate::file_ops::{read_json, write_json};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
pub struct AgentRole {
    pub name: String,
    pub system_prompt: String,
    pub allowed_tools: Vec<String>,
    pub can_manage: bool,
}

impl PartialEq for AgentRole {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
    }
}

/// Predefined roles shipped with the app.
pub fn default_roles() -> Vec<AgentRole> {
    vec![
        AgentRole {
            name: "Coder".into(),
            system_prompt: "You are an expert developer in a multi-agent team. Your job is to write clean, tested code following project standards from CLAUDE.md. You receive tasks from the architect via team messages. After completing a task, report back what you changed. Do not review code — that's the reviewer's job. Do not coordinate tasks — that's the architect's job.".into(),
            allowed_tools: vec!["Edit","Write","Bash","Glob","Grep","Read"].into_iter().map(String::from).collect(),
            can_manage: false,
        },
        AgentRole {
            name: "Reviewer".into(),
            system_prompt: "You are an expert code reviewer in a multi-agent team. You ONLY read files and write reports — never edit, write, or commit anything. You receive review tasks from the architect. Check code against CLAUDE.md rules, look for bugs, style violations, unused code, and security issues. Write a detailed report with file paths, line numbers, and specific findings.".into(),
            allowed_tools: vec!["Read","Glob","Grep"].into_iter().map(String::from).collect(),
            can_manage: false,
        },
        AgentRole {
            name: "Architect".into(),
            system_prompt: "You are a software architect coordinating a multi-agent team. You discuss tasks with the user, break them into subtasks, and delegate to coder and reviewer agents. You write detailed prompts for each agent. You read code to understand context but never edit files directly. After the coder reports completion, you send the reviewer a targeted review task. After the reviewer reports, you decide if fixes are needed and send them to the coder. You are the only one who communicates with the user.".into(),
            allowed_tools: vec!["Read","Glob","Grep"].into_iter().map(String::from).collect(),
            can_manage: true,
        },
    ]
}

/// Wrapper returned by roles_list — includes is_default flag.
#[derive(Serialize)]
pub struct RoleEntry {
    #[serde(flatten)]
    pub role: AgentRole,
    pub is_default: bool,
}

/// Path to custom roles file: ~/.config/aither-flow/custom_roles.json
fn custom_roles_path() -> PathBuf {
    config::config_dir().join("custom_roles.json")
}

/// Read custom roles from disk (sync).
fn read_custom_roles_sync() -> Vec<AgentRole> {
    let path = custom_roles_path();
    if !path.exists() {
        return Vec::new();
    }
    read_json::<Vec<AgentRole>>(&path).unwrap_or_else(|e| {
        eprintln!("[teamwork] Failed to read custom roles: {e}");
        Vec::new()
    })
}

/// Write custom roles to disk (sync).
fn write_custom_roles_sync(roles: &[AgentRole]) -> Result<(), String> {
    write_json(&custom_roles_path(), roles)
}

/// Names of default roles.
fn default_role_names() -> Vec<String> {
    default_roles().into_iter().map(|r| r.name).collect()
}

#[tauri::command]
pub async fn roles_list() -> Result<Vec<RoleEntry>, String> {
    tokio::task::spawn_blocking(|| {
        let defaults = default_roles();
        let default_names = default_role_names();
        let custom = read_custom_roles_sync();

        let mut entries: Vec<RoleEntry> = Vec::new();

        // For each default role: use custom override if present, otherwise default
        for def in defaults {
            let is_default = true;
            if let Some(overridden) = custom.iter().find(|c| c.name.eq_ignore_ascii_case(&def.name)) {
                entries.push(RoleEntry { role: overridden.clone(), is_default });
            } else {
                entries.push(RoleEntry { role: def, is_default });
            }
        }

        // Add purely custom roles (not overriding a default)
        for cr in custom {
            if !default_names.iter().any(|n| n.eq_ignore_ascii_case(&cr.name)) {
                entries.push(RoleEntry { role: cr, is_default: false });
            }
        }

        Ok(entries)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn roles_save(role: AgentRole) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        if role.name.trim().is_empty() {
            return Err("Role name cannot be empty".to_string());
        }
        let mut custom = read_custom_roles_sync();
        // Update existing or append (case-insensitive match)
        if let Some(existing) = custom.iter_mut().find(|r| r.name.eq_ignore_ascii_case(&role.name)) {
            *existing = role;
        } else {
            custom.push(role);
        }
        write_custom_roles_sync(&custom)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn roles_delete(name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut custom = read_custom_roles_sync();
        let before = custom.len();
        custom.retain(|r| !r.name.eq_ignore_ascii_case(&name));
        if custom.len() == before {
            return Err(format!("Custom role '{name}' not found"));
        }
        write_custom_roles_sync(&custom)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
