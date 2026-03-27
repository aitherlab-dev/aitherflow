pub mod commands;
pub mod runner;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub project_path: String,
    pub schedule: TaskSchedule,
    pub enabled: bool,
    pub notify_telegram: bool,
    pub created_at: String,
    pub last_run: Option<String>,
    pub last_status: Option<TaskRunStatus>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TaskSchedule {
    #[serde(rename = "interval")]
    Interval { minutes: u32 },
    #[serde(rename = "daily")]
    Daily { hour: u8, minute: u8 },
    #[serde(rename = "weekly")]
    Weekly { day: u8, hour: u8, minute: u8 },
    #[serde(rename = "cron")]
    Cron { expression: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskRunStatus {
    Success,
    Error,
    Running,
}

/// Load scheduled tasks from config file. Returns empty vec if file doesn't exist.
pub fn load_tasks() -> Vec<ScheduledTask> {
    let path = crate::config::config_dir().join("scheduled_tasks.json");
    if !path.exists() {
        return Vec::new();
    }
    match crate::file_ops::read_json::<Vec<ScheduledTask>>(&path) {
        Ok(tasks) => tasks,
        Err(e) => {
            eprintln!("[scheduler] Failed to load tasks: {e}");
            Vec::new()
        }
    }
}

/// Save scheduled tasks to config file (atomic write).
pub fn save_tasks(tasks: &[ScheduledTask]) -> Result<(), String> {
    let path = crate::config::config_dir().join("scheduled_tasks.json");
    let data = serde_json::to_string_pretty(tasks)
        .map_err(|e| format!("Failed to serialize tasks: {e}"))?;
    crate::file_ops::atomic_write(&path, data.as_bytes())
        .map_err(|e| format!("Failed to write tasks: {e}"))
}
