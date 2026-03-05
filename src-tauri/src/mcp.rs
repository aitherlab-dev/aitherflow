use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

/// A single MCP server entry as stored in config files.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    /// "stdio" | "sse" | "http"  (defaults to "stdio" when absent)
    #[serde(rename = "type", default = "default_type")]
    pub server_type: String,

    // stdio fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,

    // sse / http fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,

    // common
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub env: HashMap<String, String>,
}

fn default_type() -> String {
    "stdio".into()
}

/// Server entry returned to the frontend (with name attached).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub server_type: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub url: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub env: HashMap<String, String>,
}

impl McpServer {
    fn from_config(name: String, cfg: &McpServerConfig) -> Self {
        Self {
            name,
            server_type: cfg.server_type.clone(),
            command: cfg.command.clone(),
            args: cfg.args.clone(),
            url: cfg.url.clone(),
            headers: cfg.headers.clone(),
            env: cfg.env.clone(),
        }
    }
}

/// Full data returned by list_mcp_servers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpData {
    pub global: Vec<McpServer>,
    pub project: Vec<McpServer>,
    pub global_path: String,
    pub project_path: Option<String>,
}

/// Result of testing a server connection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTestResult {
    pub ok: bool,
    pub message: String,
}

// ─── helpers ───

fn claude_json_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("~"))
        .join(".claude.json")
}

fn read_json_file(path: &Path) -> Option<serde_json::Value> {
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

/// Extract mcpServers map from a JSON value that has { "mcpServers": { ... } }.
fn extract_servers(val: &serde_json::Value) -> Vec<McpServer> {
    let Some(obj) = val.get("mcpServers").and_then(|v| v.as_object()) else {
        return vec![];
    };
    let mut servers = Vec::new();
    for (name, cfg_val) in obj {
        if let Ok(cfg) = serde_json::from_value::<McpServerConfig>(cfg_val.clone()) {
            servers.push(McpServer::from_config(name.clone(), &cfg));
        }
    }
    servers.sort_by(|a, b| a.name.cmp(&b.name));
    servers
}

fn mcp_json_path(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".mcp.json")
}

// ─── commands ───

/// List MCP servers from both global (~/.claude.json) and project (.mcp.json).
#[tauri::command]
pub async fn list_mcp_servers(project_path: Option<String>) -> Result<McpData, String> {
    let project_path_clone = project_path.clone();
    tokio::task::spawn_blocking(move || {
        let claude_path = claude_json_path();
        let global_path_str = claude_path.to_string_lossy().to_string();

        // Global servers: top-level mcpServers in ~/.claude.json
        let global = read_json_file(&claude_path)
            .map(|v| extract_servers(&v))
            .unwrap_or_default();

        // Project servers: .mcp.json in project root
        let (project, project_path_display) = match &project_path_clone {
            Some(pp) => {
                let p = mcp_json_path(pp);
                let servers = read_json_file(&p)
                    .map(|v| extract_servers(&v))
                    .unwrap_or_default();
                (servers, Some(p.to_string_lossy().to_string()))
            }
            None => (vec![], None),
        };

        McpData {
            global,
            project,
            global_path: global_path_str,
            project_path: project_path_display,
        }
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))
}

/// Add a global MCP server via CLI.
#[tauri::command]
pub async fn add_global_mcp_server(name: String, config: McpServerConfig) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let json = serde_json::to_string(&config)
            .map_err(|e| format!("Failed to serialize config: {e}"))?;

        let output = Command::new("claude")
            .args(["mcp", "add-json", "--scope", "user", &name, &json])
            .output()
            .map_err(|e| format!("Failed to run claude CLI: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("claude mcp add-json failed: {stderr}"));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Remove a global MCP server via CLI.
#[tauri::command]
pub async fn remove_global_mcp_server(name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("claude")
            .args(["mcp", "remove", "--scope", "user", &name])
            .output()
            .map_err(|e| format!("Failed to run claude CLI: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("claude mcp remove failed: {stderr}"));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Save all project MCP servers (atomic write to .mcp.json).
#[tauri::command]
pub async fn save_project_mcp_servers(
    project_path: String,
    servers: HashMap<String, McpServerConfig>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = mcp_json_path(&project_path);
        let wrapper = serde_json::json!({ "mcpServers": servers });
        let data = serde_json::to_string_pretty(&wrapper)
            .map_err(|e| format!("Failed to serialize: {e}"))?;
        crate::file_ops::atomic_write(&path, data.as_bytes())
            .map_err(|e| format!("Failed to write .mcp.json: {e}"))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Test an MCP server connection.
/// For stdio: spawns the process for up to 500ms and checks it starts.
/// For sse/http: sends an HTTP GET and checks response.
#[tauri::command]
pub async fn test_mcp_server(config: McpServerConfig) -> Result<McpTestResult, String> {
    tokio::task::spawn_blocking(move || match config.server_type.as_str() {
        "stdio" => test_stdio(&config),
        "sse" | "http" => test_http(&config),
        other => Ok(McpTestResult {
            ok: false,
            message: format!("Unknown server type: {other}"),
        }),
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

fn test_stdio(config: &McpServerConfig) -> Result<McpTestResult, String> {
    let Some(cmd) = &config.command else {
        return Ok(McpTestResult {
            ok: false,
            message: "No command specified".into(),
        });
    };

    let mut command = Command::new(cmd);
    if let Some(args) = &config.args {
        command.args(args);
    }
    for (k, v) in &config.env {
        command.env(k, v);
    }

    let child = command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    match child {
        Ok(mut c) => {
            std::thread::sleep(std::time::Duration::from_millis(500));
            match c.try_wait() {
                Ok(Some(status)) if !status.success() => {
                    let stderr = c
                        .stderr
                        .take()
                        .and_then(|mut s| {
                            let mut buf = String::new();
                            std::io::Read::read_to_string(&mut s, &mut buf).ok()?;
                            Some(buf)
                        })
                        .unwrap_or_default();
                    Ok(McpTestResult {
                        ok: false,
                        message: format!("Process exited with {status}: {stderr}"),
                    })
                }
                Ok(Some(_)) => {
                    Ok(McpTestResult {
                        ok: true,
                        message: "Process started and exited successfully".into(),
                    })
                }
                Ok(None) => {
                    // Still running after 500ms — good sign
                    if let Err(e) = c.kill() {
                        eprintln!("[mcp] Failed to kill test process: {e}");
                    }
                    Ok(McpTestResult {
                        ok: true,
                        message: "Process started successfully".into(),
                    })
                }
                Err(e) => Ok(McpTestResult {
                    ok: false,
                    message: format!("Failed to check process: {e}"),
                }),
            }
        }
        Err(e) => Ok(McpTestResult {
            ok: false,
            message: format!("Failed to start: {e}"),
        }),
    }
}

fn test_http(config: &McpServerConfig) -> Result<McpTestResult, String> {
    let Some(url) = &config.url else {
        return Ok(McpTestResult {
            ok: false,
            message: "No URL specified".into(),
        });
    };

    // Use curl for HTTP test to avoid pulling in reqwest
    let mut cmd = Command::new("curl");
    cmd.args(["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5"]);

    if let Some(headers) = &config.headers {
        for (k, v) in headers {
            cmd.args(["-H", &format!("{k}: {v}")]);
        }
    }

    cmd.arg(url);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run curl: {e}"))?;

    let code = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() && code.starts_with('2') {
        Ok(McpTestResult {
            ok: true,
            message: format!("HTTP {code}"),
        })
    } else if output.status.success() {
        Ok(McpTestResult {
            ok: true,
            message: format!("HTTP {code} (server responded)"),
        })
    } else {
        Ok(McpTestResult {
            ok: false,
            message: if stderr.is_empty() {
                format!("HTTP {code}")
            } else {
                stderr
            },
        })
    }
}

/// Reset project MCP choices via CLI.
#[tauri::command]
pub async fn reset_mcp_project_choices(project_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("claude")
            .args(["mcp", "reset-project-choices"])
            .current_dir(&project_path)
            .output()
            .map_err(|e| format!("Failed to run claude CLI: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("reset-project-choices failed: {stderr}"));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
