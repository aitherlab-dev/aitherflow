use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};

use crate::config;
use crate::file_ops::{read_json, write_json};

use super::validate_name;

/// Per-team lock for concurrent access.
static TEAM_LOCKS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn team_lock(team_id: &str) -> Arc<Mutex<()>> {
    let mut map = TEAM_LOCKS.lock().unwrap_or_else(|e| {
        eprintln!("[teamwork] WARNING: TEAM_LOCKS mutex poisoned, recovering");
        e.into_inner()
    });
    map.entry(team_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Coder,
    Reviewer,
    Architect,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Idle,
    Running,
    Stopped,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TeamAgent {
    pub agent_id: String,
    pub role: AgentRole,
    pub worktree_branch: Option<String>,
    pub status: AgentStatus,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Team {
    pub id: String,
    pub name: String,
    pub project_path: String,
    pub agents: Vec<TeamAgent>,
    pub created_at: String,
}

/// Directory: ~/.config/aither-flow/teams/
fn teams_dir() -> PathBuf {
    config::config_dir().join("teams")
}

/// Path to team file: ~/.config/aither-flow/teams/{team_id}.json
fn team_path(team_id: &str) -> PathBuf {
    teams_dir().join(format!("{team_id}.json"))
}

/// CLI launch arguments based on agent role.
fn launch_args_for_role(role: &AgentRole) -> Vec<String> {
    let tools = match role {
        AgentRole::Coder => "Edit,Write,Bash,Glob,Grep,Read",
        AgentRole::Reviewer | AgentRole::Architect => "Read,Glob,Grep",
    };
    vec!["--allowedTools".to_string(), tools.to_string()]
}

/// Read team from disk (sync).
fn read_team_sync(team_id: &str) -> Result<Team, String> {
    read_json(&team_path(team_id))
}

/// Write team to disk (sync).
fn write_team_sync(team: &Team) -> Result<(), String> {
    write_json(&team_path(&team.id), team)
}

/// Get CLI launch args and team name for a team agent (sync, for conductor).
/// Returns (cli_args, team_name).
pub(crate) fn get_agent_launch_args_sync(
    team_id: &str,
    agent_id: &str,
) -> Result<(Vec<String>, String), String> {
    validate_name(team_id, "team_id")?;

    let team = read_team_sync(team_id)?;
    let agent = team
        .agents
        .iter()
        .find(|a| a.agent_id == agent_id)
        .ok_or_else(|| format!("Agent {agent_id} not found in team {team_id}"))?;

    Ok((launch_args_for_role(&agent.role), team.name.clone()))
}

// --- Tauri commands ---

#[tauri::command]
pub async fn team_create(name: String, project_path: String) -> Result<Team, String> {
    tokio::task::spawn_blocking(move || {
        if name.trim().is_empty() {
            return Err("Team name cannot be empty".to_string());
        }

        let team = Team {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            project_path,
            agents: Vec::new(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };

        write_team_sync(&team)?;
        Ok(team)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn team_add_agent(
    team_id: String,
    role: AgentRole,
    worktree_branch: Option<String>,
) -> Result<TeamAgent, String> {
    tokio::task::spawn_blocking(move || {
        validate_name(&team_id, "team_id")?;

        let lock = team_lock(&team_id);
        let _guard = lock
            .lock()
            .map_err(|e| format!("Team lock poisoned: {e}"))?;

        let mut team = read_team_sync(&team_id)?;

        let agent = TeamAgent {
            agent_id: uuid::Uuid::new_v4().to_string(),
            role,
            worktree_branch,
            status: AgentStatus::Idle,
        };

        team.agents.push(agent.clone());
        write_team_sync(&team)?;
        Ok(agent)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn team_remove_agent(team_id: String, agent_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        validate_name(&team_id, "team_id")?;
        validate_name(&agent_id, "agent_id")?;

        let lock = team_lock(&team_id);
        let _guard = lock
            .lock()
            .map_err(|e| format!("Team lock poisoned: {e}"))?;

        let mut team = read_team_sync(&team_id)?;
        let before = team.agents.len();
        team.agents.retain(|a| a.agent_id != agent_id);

        if team.agents.len() == before {
            return Err(format!("Agent {agent_id} not found in team {team_id}"));
        }

        write_team_sync(&team)?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn team_get(team_id: String) -> Result<Team, String> {
    tokio::task::spawn_blocking(move || {
        validate_name(&team_id, "team_id")?;
        read_team_sync(&team_id)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn team_list() -> Result<Vec<Team>, String> {
    tokio::task::spawn_blocking(|| {
        let dir = teams_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let entries =
            fs::read_dir(&dir).map_err(|e| format!("Failed to read teams dir: {e}"))?;

        let mut teams = Vec::new();
        for entry in entries.flatten() {
            let ft = entry
                .file_type()
                .map_err(|e| format!("Failed to get file type: {e}"))?;
            if ft.is_symlink() || ft.is_dir() {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match read_json::<Team>(&path) {
                Ok(team) => teams.push(team),
                Err(e) => eprintln!("[teamwork] Bad team file {}: {e}", path.display()),
            }
        }

        teams.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(teams)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn team_get_launch_args(
    team_id: String,
    agent_id: String,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let (args, _name) = get_agent_launch_args_sync(&team_id, &agent_id)?;
        Ok(args)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
