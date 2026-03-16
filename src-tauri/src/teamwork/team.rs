use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::State;

use crate::conductor::session::SessionManager;
use crate::config;
use crate::file_ops::{read_json, write_json};

use super::validate_name;

/// Update agent status in team file (sync). Used by team commands.
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

/// Atomically check that agent is NOT running and set status to Running (sync).
/// Returns Err if agent is already Running — prevents TOCTOU on double-click.
fn try_set_running_sync(team_id: &str, agent_id: &str) -> Result<(), String> {
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

    if agent.status == AgentStatus::Running {
        return Err("Agent is already running".to_string());
    }

    agent.status = AgentStatus::Running;
    write_team_sync(&team)?;
    Ok(())
}

/// Set status to Idle only if currently Running (sync).
/// If agent was explicitly Stopped, leave it as-is — Stopped is a terminal status
/// that should not be overwritten by the process exit handler.
fn reset_to_idle_if_running_sync(team_id: &str, agent_id: &str) -> Result<(), String> {
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

    if agent.status == AgentStatus::Running {
        agent.status = AgentStatus::Idle;
        write_team_sync(&team)?;
    }
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

/// Remove lock entry for a team (called on team deletion).
fn remove_team_lock(team_id: &str) {
    let mut map = TEAM_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(arc) = map.get(team_id) {
        if Arc::strong_count(arc) == 1 {
            map.remove(team_id);
        }
    }
}

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

/// Convert a legacy role name string to a full AgentRole.
fn default_role_by_name(name: &str) -> AgentRole {
    let lower = name.to_lowercase();
    default_roles()
        .into_iter()
        .find(|r| r.name.to_lowercase() == lower)
        .unwrap_or_else(|| AgentRole {
            name: name.to_string(),
            system_prompt: String::new(),
            allowed_tools: vec!["Read".into(), "Glob".into(), "Grep".into()],
            can_manage: false,
        })
}

/// Custom deserializer: accepts both a string (legacy) and an object (new format).
fn deserialize_role<'de, D>(deserializer: D) -> Result<AgentRole, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum RoleOrString {
        Role(AgentRole),
        Name(String),
    }
    match RoleOrString::deserialize(deserializer)? {
        RoleOrString::Role(r) => Ok(r),
        RoleOrString::Name(s) => Ok(default_role_by_name(&s)),
    }
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
    #[serde(deserialize_with = "deserialize_role")]
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

/// MCP teamwork tools available to all team agent roles.
const MCP_TEAMWORK_COMMON: &[&str] = &[
    "mcp__teamwork__send_message",
    "mcp__teamwork__broadcast",
    "mcp__teamwork__read_inbox",
    "mcp__teamwork__list_tasks",
    "mcp__teamwork__create_task",
    "mcp__teamwork__claim_task",
    "mcp__teamwork__complete_task",
];

/// Additional MCP teamwork tools for the architect role (management).
const MCP_TEAMWORK_ARCHITECT: &[&str] = &[
    "mcp__teamwork__start_agent",
    "mcp__teamwork__stop_agent",
    "mcp__teamwork__restart_agent",
    "mcp__teamwork__list_agents",
    "mcp__teamwork__send_prompt",
];

/// CLI launch arguments based on agent role.
fn launch_args_for_role(role: &AgentRole) -> Vec<String> {
    let mut tools: Vec<String> = role.allowed_tools.clone();
    tools.extend(MCP_TEAMWORK_COMMON.iter().map(|s| s.to_string()));
    if role.can_manage {
        tools.extend(MCP_TEAMWORK_ARCHITECT.iter().map(|s| s.to_string()));
    }
    vec!["--allowedTools".to_string(), tools.join(",")]
}

/// Read team from disk (sync).
pub(crate) fn read_team_sync(team_id: &str) -> Result<Team, String> {
    read_json(&team_path(team_id))
}

/// Write team to disk (sync).
fn write_team_sync(team: &Team) -> Result<(), String> {
    write_json(&team_path(&team.id), team)
}

/// Info needed by conductor to launch a team agent CLI session.
pub(crate) struct TeamLaunchInfo {
    pub cli_args: Vec<String>,
    pub team_name: String,
    pub agent_ids: Vec<String>,
    pub role: AgentRole,
    pub system_prompt: Option<String>,
}

/// Get CLI launch args and team context for a team agent (sync, for conductor).
pub(crate) fn get_agent_launch_args_sync(
    team_id: &str,
    agent_id: &str,
) -> Result<TeamLaunchInfo, String> {
    validate_name(team_id, "team_id")?;

    let team = read_team_sync(team_id)?;
    let agent = team
        .agents
        .iter()
        .find(|a| a.agent_id == agent_id)
        .ok_or_else(|| format!("Agent {agent_id} not found in team {team_id}"))?;

    let agent_ids: Vec<String> = team.agents.iter().map(|a| a.agent_id.clone()).collect();

    let system_prompt = if agent.role.system_prompt.is_empty() {
        None
    } else {
        Some(agent.role.system_prompt.clone())
    };

    Ok(TeamLaunchInfo {
        cli_args: launch_args_for_role(&agent.role),
        team_name: team.name.clone(),
        agent_ids,
        role: agent.role.clone(),
        system_prompt,
    })
}

// --- Tauri commands ---

#[tauri::command]
pub async fn team_create(name: String, project_path: String) -> Result<Team, String> {
    tokio::task::spawn_blocking(move || {
        if name.trim().is_empty() {
            return Err("Team name cannot be empty".to_string());
        }
        validate_name(&name, "team name")?;

        // Check name uniqueness among existing teams
        let dir = teams_dir();
        if dir.exists() {
            let entries =
                fs::read_dir(&dir).map_err(|e| format!("Failed to read teams dir: {e}"))?;
            for entry in entries.flatten() {
                let ft = entry
                    .file_type()
                    .map_err(|e| format!("Failed to get file type: {e}"))?;
                if ft.is_dir() || ft.is_symlink() {
                    continue;
                }
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(existing) = read_json::<Team>(&path) {
                    if existing.name == name {
                        return Err(format!("Team with name '{}' already exists", name));
                    }
                }
            }
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

    // Unregister from MCP server
    if let Some(mcp) = super::mcp_server::get_state() {
        mcp.unregister_agent(&agent_id).await;
    }

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
        let info = get_agent_launch_args_sync(&team_id, &agent_id)?;
        Ok(info.cli_args)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Core logic for starting a team agent. Shared by tauri command and MCP handler.
pub(crate) async fn start_agent_core(
    app: tauri::AppHandle,
    sessions: SessionManager,
    team_id: String,
    agent_id: String,
) -> Result<(), String> {
    // Atomic: check not running + set Running under one lock (prevents TOCTOU on double-click)
    let tid = team_id.clone();
    let aid = agent_id.clone();
    let (project_path, team_name) =
        tokio::task::spawn_blocking(move || {
            // Atomically claim the agent (fails if already Running)
            try_set_running_sync(&tid, &aid)?;

            // Read team data for project path / worktree resolution
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

    // Spawn CLI session in background
    // MCP registration/unregistration is handled inside run_cli_session,
    // so it works regardless of how the session is started.
    let agent_id_spawn = agent_id.clone();
    let team_id_spawn = team_id.clone();

    tokio::spawn(async move {
        if let Err(e) = crate::conductor::process::run_cli_session(
            crate::conductor::process::EventSink::new(app.clone()),
            sessions,
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
                teamwork_project_path: None,
            },
        )
        .await
        {
            eprintln!(
                "[teamwork] Session error for agent {}: {e}",
                agent_id_spawn
            );
            if let Err(e2) = tauri::Emitter::emit(
                &app,
                "cli-event",
                &crate::conductor::types::CliEvent::Error {
                    agent_id: agent_id_spawn.clone(),
                    message: e,
                },
            ) {
                eprintln!("[teamwork] Failed to emit error: {e2}");
            }
        }

        // Process exited — reset to idle only if still Running (Stopped stays Stopped)
        let tid = team_id_spawn;
        let aid = agent_id_spawn;
        if let Err(e) = tokio::task::spawn_blocking(move || {
            reset_to_idle_if_running_sync(&tid, &aid)
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
pub async fn team_start_agent(
    app: tauri::AppHandle,
    sessions: State<'_, SessionManager>,
    team_id: String,
    agent_id: String,
) -> Result<(), String> {
    start_agent_core(app, sessions.inner().clone(), team_id, agent_id).await
}

/// Core logic for stopping a team agent. Shared by tauri command and MCP handler.
pub(crate) async fn stop_agent_core(
    sessions: &SessionManager,
    team_id: String,
    agent_id: String,
) -> Result<(), String> {
    sessions.kill(&agent_id).await;

    // Unregister from MCP server
    if let Some(mcp) = super::mcp_server::get_state() {
        mcp.unregister_agent(&agent_id).await;
    }

    tokio::task::spawn_blocking(move || {
        update_agent_status_sync(&team_id, &agent_id, AgentStatus::Stopped)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    Ok(())
}

#[tauri::command]
pub async fn team_stop_agent(
    sessions: State<'_, SessionManager>,
    team_id: String,
    agent_id: String,
) -> Result<(), String> {
    stop_agent_core(sessions.inner(), team_id, agent_id).await
}

/// Push a message directly into a team agent's stdin (like a user prompt).
/// Returns true if pushed, false if agent has no active session.
#[tauri::command]
pub async fn team_push_message(
    sessions: State<'_, SessionManager>,
    agent_id: String,
    text: String,
) -> Result<bool, String> {
    let writer = match sessions.get_writer(&agent_id).await {
        Some(w) => w,
        None => return Ok(false),
    };
    let ndjson = crate::conductor::process::build_stdin_message(&text, &[])?;
    writer.write_if_idle(&ndjson).await
}

/// Delete a team: stop all agents, remove team JSON, inboxes dir, tasks dir.
#[tauri::command]
pub async fn team_delete(
    sessions: State<'_, SessionManager>,
    team_id: String,
) -> Result<(), String> {
    validate_name(&team_id, "team_id")?;

    // Read team to get agent list and name
    let team = tokio::task::spawn_blocking({
        let tid = team_id.clone();
        move || read_team_sync(&tid)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    // Stop all running agents
    for agent in &team.agents {
        if agent.status == AgentStatus::Running {
            sessions.kill(&agent.agent_id).await;
            if let Some(mcp) = super::mcp_server::get_state() {
                mcp.unregister_agent(&agent.agent_id).await;
            }
        }
    }

    // Remove files on blocking thread
    let team_name = team.name.clone();
    tokio::task::spawn_blocking(move || {
        // Remove team JSON
        let path = team_path(&team_id);
        if path.exists() {
            if let Err(e) = fs::remove_file(&path) {
                eprintln!("[teamwork] Failed to remove team file: {e}");
            }
        }

        // Remove inboxes directory
        let inboxes = config::config_dir()
            .join("teams")
            .join(&team_name)
            .join("inboxes");
        if inboxes.exists() {
            if let Err(e) = fs::remove_dir_all(&inboxes) {
                eprintln!("[teamwork] Failed to remove inboxes dir: {e}");
            }
        }

        // Remove tasks directory
        let tasks = config::config_dir().join("tasks").join(&team_name);
        if tasks.exists() {
            if let Err(e) = fs::remove_dir_all(&tasks) {
                eprintln!("[teamwork] Failed to remove tasks dir: {e}");
            }
        }

        // Clean up lock entries for this team
        remove_team_lock(&team_id);
        super::mailbox::remove_inbox_locks(&team_name);
        super::tasks::remove_task_locks(&team_name);

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
