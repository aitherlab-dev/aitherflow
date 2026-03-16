use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};

use crate::config;
use crate::file_ops::{read_json, write_json};

use super::validate_name;

/// Per-task lock to prevent concurrent claim races.
static TASK_LOCKS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn task_lock(key: &str) -> Arc<Mutex<()>> {
    let mut map = TASK_LOCKS.lock().unwrap_or_else(|e| {
        eprintln!("[teamwork] WARNING: TASK_LOCKS mutex poisoned, recovering");
        e.into_inner()
    });
    // Evict stale entries (no one else holds the lock)
    map.retain(|_, arc| Arc::strong_count(arc) > 1);
    map.entry(key.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Remove lock entries for a given team prefix (called on team deletion).
#[allow(dead_code)] // reserved for team lifecycle management
pub(crate) fn remove_task_locks(team: &str) {
    let prefix = format!("{team}/");
    let mut map = TASK_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    map.retain(|key, arc| {
        if key.starts_with(&prefix) {
            Arc::strong_count(arc) > 1
        } else {
            true
        }
    });
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TeamTask {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    pub owner: Option<String>,
    pub blocked_by: Vec<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

/// Directory for team tasks: ~/.config/aither-flow/tasks/{team_name}/
fn tasks_dir(team: &str) -> PathBuf {
    config::config_dir().join("tasks").join(team)
}

/// Path to a task file
fn task_path(team: &str, task_id: &str) -> PathBuf {
    tasks_dir(team).join(format!("{task_id}.json"))
}

/// Lock key for a task
fn task_lock_key(team: &str, task_id: &str) -> String {
    format!("{team}/{task_id}")
}

/// Create a new task (sync, for use inside spawn_blocking).
pub(crate) fn create_task_sync(
    team: &str,
    title: String,
    description: String,
) -> Result<TeamTask, String> {
    validate_name(team, "team")?;
    let task = TeamTask {
        id: uuid::Uuid::new_v4().to_string(),
        title,
        description,
        status: TaskStatus::Pending,
        owner: None,
        blocked_by: Vec::new(),
        created_at: chrono::Utc::now().to_rfc3339(),
        completed_at: None,
    };
    write_json(&task_path(team, &task.id), &task)?;
    Ok(task)
}

/// Claim a task for an agent (sync, with lock to prevent double-claim).
pub(crate) fn claim_task_sync(
    team: &str,
    task_id: &str,
    agent_id: &str,
) -> Result<TeamTask, String> {
    validate_name(team, "team")?;
    validate_name(task_id, "task_id")?;
    validate_name(agent_id, "agent_id")?;

    let key = task_lock_key(team, task_id);
    let lock = task_lock(&key);
    let _guard = lock
        .lock()
        .map_err(|e| format!("Task lock poisoned: {e}"))?;

    let path = task_path(team, task_id);
    let mut task: TeamTask = read_json(&path)?;

    if task.status != TaskStatus::Pending {
        return Err(format!("Task {task_id} is not pending, cannot claim"));
    }

    task.status = TaskStatus::InProgress;
    task.owner = Some(agent_id.to_string());
    write_json(&path, &task)?;
    Ok(task)
}

/// Complete a task (sync, only the owner can complete it).
pub(crate) fn complete_task_sync(
    team: &str,
    task_id: &str,
    agent_id: &str,
) -> Result<TeamTask, String> {
    validate_name(team, "team")?;
    validate_name(task_id, "task_id")?;
    validate_name(agent_id, "agent_id")?;

    let key = task_lock_key(team, task_id);
    let lock = task_lock(&key);
    let _guard = lock
        .lock()
        .map_err(|e| format!("Task lock poisoned: {e}"))?;

    let path = task_path(team, task_id);
    let mut task: TeamTask = read_json(&path)?;

    match &task.owner {
        Some(owner) if owner == agent_id => {}
        Some(owner) => {
            return Err(format!(
                "Task {task_id} is owned by {owner}, not {agent_id}"
            ));
        }
        None => {
            return Err(format!("Task {task_id} has no owner, cannot complete"));
        }
    }

    task.status = TaskStatus::Completed;
    task.completed_at = Some(chrono::Utc::now().to_rfc3339());
    write_json(&path, &task)?;
    Ok(task)
}

/// List all tasks for a team (sync).
pub(crate) fn list_tasks_sync(team: &str) -> Result<Vec<TeamTask>, String> {
    validate_name(team, "team")?;

    let dir = tasks_dir(team);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(&dir).map_err(|e| format!("Failed to read tasks dir: {e}"))?;

    let mut tasks = Vec::new();
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
        match read_json::<TeamTask>(&path) {
            Ok(task) => tasks.push(task),
            Err(e) => eprintln!("[teamwork] Bad task file {}: {e}", path.display()),
        }
    }

    tasks.sort_by(|a, b| {
        let order = |s: &TaskStatus| match s {
            TaskStatus::Pending => 0,
            TaskStatus::InProgress => 1,
            TaskStatus::Completed => 2,
        };
        order(&a.status)
            .cmp(&order(&b.status))
            .then_with(|| a.created_at.cmp(&b.created_at))
    });

    Ok(tasks)
}

/// Create a new task
#[allow(dead_code)] // available as tauri command when needed
#[tauri::command]
pub async fn team_create_task(
    team: String,
    title: String,
    description: String,
    blocked_by: Vec<String>,
) -> Result<TeamTask, String> {
    tokio::task::spawn_blocking(move || {
        validate_name(&team, "team")?;

        let task = TeamTask {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            description,
            status: TaskStatus::Pending,
            owner: None,
            blocked_by,
            created_at: chrono::Utc::now().to_rfc3339(),
            completed_at: None,
        };

        write_json(&task_path(&team, &task.id), &task)?;
        Ok(task)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Claim a task for an agent (with lock to prevent double-claim)
#[allow(dead_code)] // available as tauri command when needed
#[tauri::command]
pub async fn team_claim_task(
    team: String,
    task_id: String,
    agent_id: String,
) -> Result<TeamTask, String> {
    tokio::task::spawn_blocking(move || {
        validate_name(&team, "team")?;
        validate_name(&task_id, "task_id")?;
        validate_name(&agent_id, "agent_id")?;

        let key = task_lock_key(&team, &task_id);
        let lock = task_lock(&key);
        let _guard = lock
            .lock()
            .map_err(|e| format!("Task lock poisoned: {e}"))?;

        let path = task_path(&team, &task_id);
        let mut task: TeamTask = read_json(&path)?;

        if task.status != TaskStatus::Pending {
            return Err(format!("Task {task_id} is not pending, cannot claim"));
        }

        task.status = TaskStatus::InProgress;
        task.owner = Some(agent_id);
        write_json(&path, &task)?;
        Ok(task)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Complete a task (only the owner can complete it)
#[allow(dead_code)] // available as tauri command when needed
#[tauri::command]
pub async fn team_complete_task(
    team: String,
    task_id: String,
    agent_id: String,
) -> Result<TeamTask, String> {
    tokio::task::spawn_blocking(move || {
        validate_name(&team, "team")?;
        validate_name(&task_id, "task_id")?;
        validate_name(&agent_id, "agent_id")?;

        let key = task_lock_key(&team, &task_id);
        let lock = task_lock(&key);
        let _guard = lock
            .lock()
            .map_err(|e| format!("Task lock poisoned: {e}"))?;

        let path = task_path(&team, &task_id);
        let mut task: TeamTask = read_json(&path)?;

        match &task.owner {
            Some(owner) if owner == &agent_id => {}
            Some(owner) => {
                return Err(format!(
                    "Task {task_id} is owned by {owner}, not {agent_id}"
                ));
            }
            None => {
                return Err(format!("Task {task_id} has no owner, cannot complete"));
            }
        }

        task.status = TaskStatus::Completed;
        task.completed_at = Some(chrono::Utc::now().to_rfc3339());
        write_json(&path, &task)?;
        Ok(task)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// List all tasks for a team with current statuses
#[allow(dead_code)] // available as tauri command when needed
#[tauri::command]
pub async fn team_list_tasks(team: String) -> Result<Vec<TeamTask>, String> {
    tokio::task::spawn_blocking(move || {
        validate_name(&team, "team")?;

        let dir = tasks_dir(&team);
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let entries =
            fs::read_dir(&dir).map_err(|e| format!("Failed to read tasks dir: {e}"))?;

        let mut tasks = Vec::new();
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
            match read_json::<TeamTask>(&path) {
                Ok(task) => tasks.push(task),
                Err(e) => eprintln!("[teamwork] Bad task file {}: {e}", path.display()),
            }
        }

        tasks.sort_by(|a, b| {
            let order = |s: &TaskStatus| match s {
                TaskStatus::Pending => 0,
                TaskStatus::InProgress => 1,
                TaskStatus::Completed => 2,
            };
            order(&a.status)
                .cmp(&order(&b.status))
                .then_with(|| a.created_at.cmp(&b.created_at))
        });

        Ok(tasks)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
