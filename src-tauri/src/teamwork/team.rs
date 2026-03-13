use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::State;

use crate::conductor::session::SessionManager;
use crate::config;
use crate::file_ops::{read_json, write_json};

use super::validate_name;

/// Update agent status in team file (sync). Used by team commands and process exit handler.
pub(crate) fn update_agent_status_sync(
    team_id: &str,
    agent_id: &str,
    status: AgentStatus,
) -> Result<(), String> {
    validate_name(team_id, "team_id")?;

    let lock = team_lock(team_id);
    let _guard = lock
        .lock()
        .map_err(|e| format!("Team lock poisoned: {e}"))?;

    let mut team = read_team_sync(team_id)?;
    let agent = team
        .agents
        .iter_mut()
        .find(|a| a.agent_id == agent_id)
        .ok_or_else(|| format!("Agent {agent_id} not found in team {team_id}"))?;
    agent.status = status;
    write_team_sync(&team)?;
    Ok(())
}

/// Resolve worktree branch to its filesystem path (sync).
fn resolve_worktree_path(project_path: &str, branch: &str) -> Result<String, String> {
    crate::files::validate_path_safe(std::path::Path::new(project_path))?;

    let output = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("Failed to run git worktree list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut current_path: Option<String> = None;

    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(path.to_string());
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            if b == branch {
                if let Some(path) = current_path {
                    return Ok(path);
                }
            }
        } else if line.is_empty() {
            current_path = None;
        }
    }

    Err(format!("No worktree found for branch '{branch}'"))
}

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
pub async fn team_remove_agent(
    sessions: State<'_, SessionManager>,
    team_id: String,
    agent_id: String,
) -> Result<(), String> {
    // Kill session first (stops process + polling). Safe to call if no session exists.
    sessions.kill(&agent_id).await;

    // Then remove from team config
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

#[tauri::command]
pub async fn team_start_agent(
    app: tauri::AppHandle,
    sessions: State<'_, SessionManager>,
    team_id: String,
    agent_id: String,
) -> Result<(), String> {
    // Don't start if already running
    if sessions.is_alive(&agent_id).await {
        return Err("Agent is already running".to_string());
    }

    // Read team and resolve project path (blocking)
    let tid = team_id.clone();
    let aid = agent_id.clone();
    let (project_path, team_name) = tokio::task::spawn_blocking(move || {
        validate_name(&tid, "team_id")?;
        let team = read_team_sync(&tid)?;
        let agent = team
            .agents
            .iter()
            .find(|a| a.agent_id == aid)
            .ok_or_else(|| format!("Agent {aid} not found in team {tid}"))?;

        let path = if let Some(ref branch) = agent.worktree_branch {
            resolve_worktree_path(&team.project_path, branch)?
        } else {
            team.project_path.clone()
        };

        Ok::<_, String>((path, team.name))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    // Update status to running
    {
        let tid = team_id.clone();
        let aid = agent_id.clone();
        tokio::task::spawn_blocking(move || {
            update_agent_status_sync(&tid, &aid, AgentStatus::Running)
        })
        .await
        .map_err(|e| format!("Task join error: {e}"))??;
    }

    // Spawn CLI session in background
    let sessions_owned = sessions.inner().clone();
    let app_clone = app.clone();
    let agent_id_spawn = agent_id.clone();
    let team_id_spawn = team_id.clone();

    tokio::spawn(async move {
        if let Err(e) = crate::conductor::process::run_cli_session(
            crate::conductor::process::EventSink::new(app_clone.clone()),
            sessions_owned,
            crate::conductor::process::CliSessionConfig {
                agent_id: agent_id_spawn.clone(),
                prompt: "You are a team agent. Collaborate with other agents via team messages. \
                         Wait for instructions."
                    .to_string(),
                project_path: Some(project_path),
                model: None,
                effort: None,
                resume_session_id: None,
                permission_mode: None,
                chrome: false,
                image_attachments: vec![],
                team: Some(team_name),
                team_id: Some(team_id_spawn.clone()),
            },
        )
        .await
        {
            eprintln!(
                "[teamwork] Session error for agent {}: {e}",
                agent_id_spawn
            );
            if let Err(e2) = tauri::Emitter::emit(
                &app_clone,
                "cli-event",
                &crate::conductor::types::CliEvent::Error {
                    agent_id: agent_id_spawn.clone(),
                    message: e,
                },
            ) {
                eprintln!("[teamwork] Failed to emit error: {e2}");
            }
        }

        // Process exited — reset status to idle
        let tid = team_id_spawn;
        let aid = agent_id_spawn;
        if let Err(e) = tokio::task::spawn_blocking(move || {
            update_agent_status_sync(&tid, &aid, AgentStatus::Idle)
        })
        .await
        .unwrap_or_else(|e| Err(format!("Task panic: {e}")))
        {
            eprintln!("[teamwork] Failed to reset agent status: {e}");
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn team_stop_agent(
    sessions: State<'_, SessionManager>,
    team_id: String,
    agent_id: String,
) -> Result<(), String> {
    sessions.kill(&agent_id).await;

    tokio::task::spawn_blocking(move || {
        update_agent_status_sync(&team_id, &agent_id, AgentStatus::Stopped)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    Ok(())
}
