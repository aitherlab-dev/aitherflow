use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::config;
use crate::file_ops::atomic_write;

// ── Types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookTestResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

// ── Path helpers ──

fn global_settings_path() -> PathBuf {
    config::claude_home().join("settings.json")
}

fn project_settings_path(project_path: &str) -> PathBuf {
    PathBuf::from(project_path).join(".claude/settings.json")
}

fn settings_path(scope: &str, project_path: &Option<String>) -> Result<PathBuf, String> {
    match scope {
        "global" => Ok(global_settings_path()),
        "project" => {
            let pp = project_path
                .as_deref()
                .ok_or("project_path is required for project scope")?;
            Ok(project_settings_path(pp))
        }
        _ => Err(format!("Invalid scope: {scope}")),
    }
}

// ── Internal helpers ──

fn read_settings_json(path: &std::path::Path) -> Result<serde_json::Value, String> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let data = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    if data.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(&data)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

fn write_settings_json(path: &std::path::Path, value: &serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize: {e}"))?;
    atomic_write(path, json.as_bytes())
}

// ── Tauri commands ──

#[tauri::command]
pub async fn load_hooks(
    scope: String,
    project_path: Option<String>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let path = settings_path(&scope, &project_path)?;
        let settings = read_settings_json(&path)?;
        Ok(settings.get("hooks").cloned().unwrap_or(serde_json::json!({})))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn save_hooks(
    scope: String,
    project_path: Option<String>,
    hooks: serde_json::Value,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = settings_path(&scope, &project_path)?;
        let mut settings = read_settings_json(&path)?;
        let obj = settings
            .as_object_mut()
            .ok_or("Settings file is not a JSON object")?;
        obj.insert("hooks".to_string(), hooks);
        write_settings_json(&path, &settings)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn test_hook_command(
    command: String,
    cwd: Option<String>,
) -> Result<HookTestResult, String> {
    tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("sh");
        cmd.arg("-c").arg(&command);
        if let Some(ref dir) = cwd {
            cmd.current_dir(dir);
        }
        // Provide empty stdin
        cmd.stdin(std::process::Stdio::piped());

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to execute command: {e}"))?;

        Ok(HookTestResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout)
                .chars()
                .take(10_000)
                .collect(),
            stderr: String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(10_000)
                .collect(),
        })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
