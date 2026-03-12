use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::config;
use crate::file_ops::{read_json, write_json};

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

fn project_settings_path(project_path: &str) -> Result<PathBuf, String> {
    let p = std::path::Path::new(project_path);
    crate::files::validate_path_safe(p)?;
    Ok(p.join(".claude/settings.json"))
}

fn settings_path(scope: &str, project_path: &Option<String>) -> Result<PathBuf, String> {
    match scope {
        "global" => Ok(global_settings_path()),
        "project" => {
            let pp = project_path
                .as_deref()
                .ok_or("project_path is required for project scope")?;
            project_settings_path(pp)
        }
        _ => Err(format!("Invalid scope: {scope}")),
    }
}

// ── Internal helpers ──

fn read_settings_json(path: &std::path::Path) -> Result<serde_json::Value, String> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let val: serde_json::Value = read_json(path)?;
    if val.is_null() {
        return Ok(serde_json::json!({}));
    }
    Ok(val)
}

// ── Command validation ──

const MAX_HOOK_COMMAND_LEN: usize = 1024;

/// Shell meta-characters that enable command chaining / injection.
const SHELL_INJECTION_CHARS: &[char] = &[';', '|', '`', '>', '<', '&'];

fn validate_hook_command(command: &str) -> Result<(), String> {
    let cmd = command.trim();
    if cmd.is_empty() {
        return Err("Hook command is empty".into());
    }
    if cmd.len() > MAX_HOOK_COMMAND_LEN {
        return Err(format!(
            "Hook command too long ({} chars, max {MAX_HOOK_COMMAND_LEN})",
            cmd.len()
        ));
    }
    // Block shell injection patterns: $() ${} and meta-chars
    if cmd.contains("$(") || cmd.contains("${") {
        return Err("Hook command must not contain subshell expansions ($() or ${})".into());
    }
    for ch in SHELL_INJECTION_CHARS {
        if cmd.contains(*ch) {
            return Err(format!(
                "Hook command must not contain shell meta-character '{ch}'"
            ));
        }
    }
    Ok(())
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
        write_json(&path, &settings)
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
        validate_hook_command(&command)?;

        let mut cmd = std::process::Command::new("sh");
        cmd.arg("-c").arg(&command);
        if let Some(ref dir) = cwd {
            crate::files::validate_path_safe(std::path::Path::new(dir))?;
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
