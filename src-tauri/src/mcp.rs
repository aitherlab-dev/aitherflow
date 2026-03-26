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
    crate::config::home_dir().join(".claude.json")
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

fn mcp_json_path(project_path: &str) -> Result<PathBuf, String> {
    let p = Path::new(project_path);
    crate::files::validate_path_safe(p)?;
    Ok(p.join(".mcp.json"))
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
        let global = crate::file_ops::read_json::<serde_json::Value>(&claude_path)
            .ok()
            .map(|v| extract_servers(&v))
            .unwrap_or_default();

        // Project servers: .mcp.json in project root
        let (project, project_path_display) = match &project_path_clone {
            Some(pp) => {
                match mcp_json_path(pp) {
                    Ok(p) => {
                        let servers = crate::file_ops::read_json::<serde_json::Value>(&p)
                            .ok()
                            .map(|v| extract_servers(&v))
                            .unwrap_or_default();
                        (servers, Some(p.to_string_lossy().to_string()))
                    }
                    Err(e) => {
                        eprintln!("[mcp] Invalid project path: {e}");
                        (vec![], None)
                    }
                }
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
        let path = mcp_json_path(&project_path)?;
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

/// Env vars that can hijack process loading or escalate privileges.
const DANGEROUS_ENV_VARS: &[&str] = &[
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "PATH",
];

fn validate_stdio_command(cmd: &str, env: &HashMap<String, String>) -> Result<(), String> {
    if cmd.is_empty() {
        return Err("Empty command".into());
    }
    // If absolute path — validate it lands in an allowed directory
    if cmd.starts_with('/') {
        crate::files::validate_path_safe(Path::new(cmd))?;
    }
    // Block shell meta-characters in command name
    if cmd.contains(';') || cmd.contains('|') || cmd.contains('`') || cmd.contains("$(") {
        return Err(format!("Command contains shell meta-characters: {cmd}"));
    }
    // Block dangerous env vars
    for key in env.keys() {
        let upper = key.to_uppercase();
        if DANGEROUS_ENV_VARS.contains(&upper.as_str()) {
            return Err(format!("Env variable '{key}' is not allowed"));
        }
    }
    Ok(())
}

fn validate_http_url(url: &str) -> Result<(), String> {
    // Only http/https schemes
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("Only http/https URLs allowed, got: {url}"));
    }
    // Extract host portion (after scheme, before port/path)
    let after_scheme = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .unwrap_or(url);
    let host = after_scheme
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    let host_lower = host.to_lowercase();

    // Block localhost and loopback
    if host_lower == "localhost"
        || host_lower.ends_with(".localhost")
        || host_lower == "[::1]"
    {
        return Err("Localhost URLs are not allowed".into());
    }

    // Block private/link-local IPs (literal)
    check_ip_not_private(host)?;

    // DNS rebinding protection: resolve hostname and check all resulting IPs
    if host.parse::<std::net::Ipv4Addr>().is_err()
        && host.parse::<std::net::Ipv6Addr>().is_err()
    {
        // It's a hostname, resolve it
        let host_with_port = format!("{}:0", host);
        if let Ok(addrs) = std::net::ToSocketAddrs::to_socket_addrs(&host_with_port) {
            for addr in addrs {
                check_ip_not_private(&addr.ip().to_string())?;
            }
        }
        // If resolution fails, allow — the actual connection will fail later
    }

    Ok(())
}

/// Check that an IP address (as string) is not in a private/loopback/link-local range.
fn check_ip_not_private(host: &str) -> Result<(), String> {
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        if ip.is_loopback()           // 127.0.0.0/8
            || ip.is_private()         // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
            || ip.is_link_local()      // 169.254.0.0/16 (includes AWS metadata)
            || ip.is_unspecified()     // 0.0.0.0
        {
            return Err(format!("Private/loopback IP not allowed: {ip}"));
        }
    }
    if let Ok(ip) = host.parse::<std::net::Ipv6Addr>() {
        if ip.is_loopback() || ip.is_unspecified() {
            return Err(format!("Loopback/unspecified IPv6 not allowed: {ip}"));
        }
        // Check IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1)
        if let Some(mapped) = ip.to_ipv4_mapped() {
            if mapped.is_loopback() || mapped.is_private() || mapped.is_link_local() || mapped.is_unspecified() {
                return Err(format!("Private/loopback IPv4-mapped IPv6 not allowed: {ip}"));
            }
        }
    }
    Ok(())
}

fn test_stdio(config: &McpServerConfig) -> Result<McpTestResult, String> {
    let Some(cmd) = &config.command else {
        return Ok(McpTestResult {
            ok: false,
            message: "No command specified".into(),
        });
    };

    validate_stdio_command(cmd, &config.env)?;

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
                    // Reap zombie
                    if let Err(e) = c.wait() {
                        eprintln!("[mcp] Failed to reap test process: {e}");
                    }
                    Ok(McpTestResult {
                        ok: true,
                        message: "Process started successfully".into(),
                    })
                }
                Err(e) => {
                    // Reap in case of error too
                    if let Err(ke) = c.kill() {
                        eprintln!("[mcp] Failed to kill test process: {ke}");
                    }
                    if let Err(we) = c.wait() {
                        eprintln!("[mcp] Failed to reap test process: {we}");
                    }
                    Ok(McpTestResult {
                        ok: false,
                        message: format!("Failed to check process: {e}"),
                    })
                }
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

    validate_http_url(url)?;

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

/// Status of a built-in MCP server.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinMcpStatus {
    pub name: String,
    pub running: bool,
    pub port: Option<u16>,
}

/// Get status of all built-in MCP servers.
#[tauri::command]
pub async fn get_builtin_mcp_status() -> Vec<BuiltinMcpStatus> {
    let teamwork_port = crate::teamwork::mcp_server::get_mcp_port();
    let models_port = crate::external_models::mcp_server::get_port();
    let knowledge_port = crate::rag::mcp_server::get_port();

    // Image Gen: stdio sidecar, no port — check settings + binary existence
    let image_gen_running = tokio::task::spawn_blocking(|| {
        let settings = crate::image_gen::load_settings_sync();
        settings.image_mcp_enabled
            && crate::conductor::resolve::resolve_mcp_image_gen_binary().is_some()
    })
    .await
    .unwrap_or(false);

    vec![
        BuiltinMcpStatus {
            name: "Teamwork".into(),
            running: teamwork_port.is_some(),
            port: teamwork_port,
        },
        BuiltinMcpStatus {
            name: "Models".into(),
            running: models_port.is_some(),
            port: models_port,
        },
        BuiltinMcpStatus {
            name: "Knowledge".into(),
            running: knowledge_port.is_some(),
            port: knowledge_port,
        },
        BuiltinMcpStatus {
            name: "Image Gen".into(),
            running: image_gen_running,
            port: None,
        },
    ]
}

/// Reset project MCP choices via CLI.
#[tauri::command]
pub async fn reset_mcp_project_choices(project_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::files::validate_path_safe(Path::new(&project_path))?;
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
