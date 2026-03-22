use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::parser::parse_line;
use super::session::{AgentSession, AgentWriter, SessionManager};
use super::types::{AttachmentPayload, CliEvent, SessionStatus};
use crate::attachments;

/// Maximum stderr buffer size (64 KB) to prevent memory issues.
const MAX_STDERR_BYTES: usize = 64 * 1024;

/// Resolve the `claude` CLI binary path.
/// Checks PATH first, then common install locations per platform.
fn resolve_claude_binary() -> String {
    // Check if `claude` is already in PATH
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = std::process::Command::new(which_cmd)
        .arg("claude")
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .lines().next().unwrap_or("").trim().to_string();
            if !path.is_empty() {
                return path;
            }
        }
    }

    // Common locations to check
    let home = dirs::home_dir().unwrap_or_default();
    eprintln!("[conductor] resolve_claude_binary: home={}", home.display());
    let mut candidates: Vec<std::path::PathBuf> = vec![
        // npm global (unix)
        home.join(".local/node/bin/claude"),
        home.join(".local/bin/claude"),
        home.join(".nvm/current/bin/claude"),
    ];
    // macOS / Homebrew
    #[cfg(target_os = "macos")]
    {
        candidates.push("/usr/local/bin/claude".into());
        candidates.push("/opt/homebrew/bin/claude".into());
    }
    candidates.extend([
        // npm global (default)
        home.join(".npm-global/bin/claude"),
        // fnm / volta
        home.join(".local/share/fnm/aliases/default/bin/claude"),
        home.join(".volta/bin/claude"),
    ]);
    // Windows
    #[cfg(target_os = "windows")]
    {
        candidates.push(home.join("AppData/Roaming/npm/claude.cmd"));
        candidates.push(home.join("AppData/Roaming/npm/claude"));
    }

    for candidate in &candidates {
        let exists = candidate.exists();
        eprintln!("[conductor] checking {}: {}", candidate.display(), exists);
        if exists {
            eprintln!("[conductor] resolved claude at: {}", candidate.display());
            return candidate.to_string_lossy().into_owned();
        }
    }

    eprintln!("[conductor] claude not found in any known location");
    // Fallback — let the OS try to find it
    "claude".to_string()
}

/// Guard that removes a temp file on drop. Call `disarm()` to take
/// ownership of the path and prevent automatic deletion.
struct TempFileGuard(Option<std::path::PathBuf>);

impl TempFileGuard {
    fn new(path: std::path::PathBuf) -> Self {
        Self(Some(path))
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(ref path) = self.0 {
            if let Err(e) = std::fs::remove_file(path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("[conductor] Failed to cleanup MCP config: {e}");
                }
            }
        }
    }
}

/// Delivers CLI events to the Tauri frontend via emit.
pub struct EventSink(AppHandle);

impl EventSink {
    pub fn new(app: AppHandle) -> Self {
        Self(app)
    }

    fn emit(&self, event: &CliEvent) {
        if let Err(e) = self.0.emit("cli-event", event) {
            eprintln!("[conductor] Failed to emit event: {e}");
        }
    }
}

/// Configuration for a CLI session.
pub struct CliSessionConfig {
    pub agent_id: String,
    pub prompt: String,
    pub project_path: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub resume_session_id: Option<String>,
    pub permission_mode: Option<String>,
    pub chrome: bool,
    pub image_attachments: Vec<AttachmentPayload>,
    /// Project path for teamwork (None = no project teamwork).
    pub teamwork_project_path: Option<String>,
    /// Additional directories to include in CLI context (--add-dir)
    pub additional_dirs: Vec<String>,
    /// Standalone role system prompt (not from team — applied via --append-system-prompt)
    pub role_system_prompt: Option<String>,
    /// Standalone role allowed tools (not from team — applied via --allowedTools)
    pub role_allowed_tools: Option<Vec<String>>,
}

/// Spawn Claude CLI and run the session until the process exits.
///
/// This is a long-running function — call it inside `tokio::spawn`.
/// Events are delivered through the provided `EventSink`.
pub async fn run_cli_session(
    sink: EventSink,
    sessions: SessionManager,
    config: CliSessionConfig,
) -> Result<(), String> {
    let tag = "conductor";
    let CliSessionConfig {
        agent_id,
        prompt,
        project_path,
        model,
        effort,
        resume_session_id,
        permission_mode,
        chrome,
        image_attachments,
        teamwork_project_path,
        additional_dirs,
        role_system_prompt,
        role_allowed_tools,
    } = config;

    // For project teamwork, use the project slug as the mailbox namespace.
    let project_teamwork_slug =
        teamwork_project_path.as_deref().map(crate::projects::project_teamwork_slug);

    // Register agent in MCP server so it can use teamwork tools.
    let mcp_generation = if let (Some(ref pp), Some(ref slug)) =
        (&teamwork_project_path, &project_teamwork_slug)
    {
        let default_role = crate::teamwork::roles::AgentRole {
            name: "Agent".to_string(),
            system_prompt: String::new(),
            allowed_tools: Vec::new(),
            can_manage: false,
            start_message: None,
        };
        if let Some(mcp) = crate::teamwork::mcp_server::get_state() {
            mcp.register_project_agent(&agent_id, pp, slug, default_role)
                .await
        } else {
            0
        }
    } else {
        0
    };

    // Build command arguments
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
    ];

    // model is intentionally not passed — CLI auto-selects 1M context variant
    let _ = model;

    if let Some(ref e) = effort {
        args.push("--effort".into());
        args.push(e.clone());
    }

    if let Some(ref sid) = resume_session_id {
        args.push("--resume".into());
        args.push(sid.clone());
    }

    if let Some(ref pm) = permission_mode {
        args.push("--permission-mode".into());
        args.push(pm.clone());
    }

    if chrome {
        args.push("--chrome".into());
    }

    // Additional directories (--add-dir for each)
    for dir in &additional_dirs {
        crate::files::validate_path_safe(std::path::Path::new(dir))?;
        args.push("--add-dir".into());
        args.push(dir.clone());
    }

    // Standalone role — apply system prompt and allowed tools
    if let Some(ref sp) = role_system_prompt {
        if !sp.is_empty() {
            args.push("--append-system-prompt".into());
            args.push(sp.clone());
        }
    }
    if let Some(ref tools) = role_allowed_tools {
        if !tools.is_empty() {
            args.push("--allowedTools".into());
            args.push(tools.join(","));
        }
    }

    // Create MCP config file with all built-in MCP servers.
    // Wrapped in TempFileGuard so the file is cleaned up on early return.
    let safe_agent_id: String = agent_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe_agent_id.is_empty() {
        return Err("invalid agent_id: empty after sanitization".into());
    }

    let mut mcp_servers = serde_json::Map::new();

    // Teamwork MCP (only if agent belongs to a project team)
    if project_teamwork_slug.is_some() {
        if let (Some(port), Some(token)) = (
            crate::teamwork::mcp_server::get_mcp_port(),
            crate::teamwork::mcp_server::get_mcp_token(),
        ) {
            mcp_servers.insert("teamwork".into(), serde_json::json!({
                "type": "http",
                "url": format!("http://127.0.0.1:{port}/mcp/{safe_agent_id}"),
                "headers": {
                    "Authorization": format!("Bearer {token}")
                }
            }));
        } else {
            eprintln!("[{tag}] Teamwork MCP server not running or token unavailable, skipping");
        }
    }

    // External models MCP (always, if running)
    if let Some(port) = crate::external_models::mcp_server::get_port() {
        if let Some(token) = crate::external_models::mcp_server::get_token() {
            mcp_servers.insert("aitherflow-models".into(), serde_json::json!({
                "type": "sse",
                "url": format!("http://127.0.0.1:{port}/sse"),
                "headers": {
                    "Authorization": format!("Bearer {token}")
                }
            }));
        }
    }

    // Knowledge MCP (only if running — controlled by knowledge_mcp_enabled setting)
    if let Some(port) = crate::rag::mcp_server::get_port() {
        if let Some(token) = crate::rag::mcp_server::get_token() {
            mcp_servers.insert("aitherflow-knowledge".into(), serde_json::json!({
                "type": "sse",
                "url": format!("http://127.0.0.1:{port}/sse"),
                "headers": {
                    "Authorization": format!("Bearer {token}")
                }
            }));
        }
    }

    let mcp_config_guard = if !mcp_servers.is_empty() {
        let path =
            std::env::temp_dir().join(format!("aitherflow-mcp-{safe_agent_id}.json"));
        let config_json = serde_json::json!({ "mcpServers": mcp_servers });
        let path_clone = path.clone();
        tokio::task::spawn_blocking(move || {
            let json_str = serde_json::to_string_pretty(&config_json)
                .map_err(|e| format!("Failed to serialize MCP config: {e}"))?;
            crate::file_ops::atomic_write(&path_clone, json_str.as_bytes())
        })
        .await
        .map_err(|e| format!("MCP config task panic: {e}"))??;

        args.push("--mcp-config".into());
        args.push(path.to_string_lossy().into_owned());
        TempFileGuard::new(path)
    } else {
        TempFileGuard(None)
    };

    // Build command
    let claude_bin = tokio::task::spawn_blocking(resolve_claude_binary)
        .await
        .map_err(|e| format!("resolve_claude_binary task panic: {e}"))?;
    let mut cmd = Command::new(&claude_bin);

    // Extend PATH so child process can find node, claude, etc.
    {
        let current_path = std::env::var("PATH").unwrap_or_default();
        let home = dirs::home_dir().unwrap_or_default();
        let extra_paths = [
            home.join(".local/bin"),
            home.join(".local/node/bin"),
            home.join(".cargo/bin"),
            "/usr/local/bin".into(),
            "/opt/homebrew/bin".into(),
        ];
        let extended = std::env::join_paths(
            extra_paths.iter().chain(std::env::split_paths(&current_path).collect::<Vec<_>>().iter())
        ).unwrap_or_default();
        cmd.env("PATH", extended);
    }

    cmd.args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(ref dir) = project_path {
        crate::files::validate_path_safe(std::path::Path::new(dir))?;
        cmd.current_dir(dir);
    }

    // Spawn process
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Claude CLI not found. Make sure 'claude' is installed and in PATH.".to_string()
        } else {
            format!("Failed to spawn claude: {e}")
        }
    })?;

    // Take ownership of IO handles
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    // Create writer (single lock for stdin + status)
    let writer = Arc::new(AgentWriter::new(stdin));

    // Store session immediately (so kill works even during first write)
    let generation = sessions
        .insert(
            agent_id.clone(),
            AgentSession {
                child,
                writer: Arc::clone(&writer),
                generation: 0, // assigned by insert()
            },
        )
        .await;

    // Write first message (skip if resuming with empty prompt — e.g. permission mode switch)
    if !prompt.trim().is_empty() || !image_attachments.is_empty() {
        let ndjson = build_stdin_message(&prompt, &image_attachments)?;
        writer
            .write_message(&ndjson)
            .await
            .map_err(|e| format!("Failed to write first message: {e}"))?;
    }

    // Spawn mailbox polling task if project teamwork is enabled
    let (polling_handle, polling_stop_tx) = if let Some(ref team) = project_teamwork_slug {
        let writer_poll = Arc::clone(&writer);
        let agent_id_poll = agent_id.clone();
        let team_poll = team.clone();
        let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();

        // Subscribe to push notifications for instant message delivery
        let inbox_notify = crate::teamwork::mailbox::subscribe_inbox(&team_poll, &agent_id_poll);
        let team_cleanup = team_poll.clone();
        let agent_cleanup = agent_id_poll.clone();

        let handle = tokio::spawn(async move {
            // Fallback interval: 30s in case push notification was missed
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
            // Skip the first immediate tick
            interval.tick().await;

            // Buffer for messages that couldn't be sent (agent was busy)
            let mut pending_messages: Vec<crate::teamwork::mailbox::TeamMessage> = Vec::new();
            let mut pending_ndjson: Option<String> = None;

            loop {
                // Wait for: stop signal, push notification, or fallback interval
                tokio::select! {
                    _ = &mut stop_rx => {
                        // Graceful shutdown: process any pending messages before exiting
                        if !pending_messages.is_empty() {
                            let ids: Vec<String> = pending_messages.iter().map(|m| m.id.clone()).collect();
                            let team_m = team_poll.clone();
                            let agent_m = agent_id_poll.clone();
                            if let Err(e) = tokio::task::spawn_blocking(move || {
                                crate::teamwork::mailbox::mark_read_sync(&team_m, &agent_m, &ids)
                            })
                            .await
                            .unwrap_or_else(|e| Err(format!("Task panic: {e}")))
                            {
                                eprintln!("[teamwork] Failed to mark pending messages as read on shutdown: {e}");
                            }
                        }
                        break;
                    }
                    _ = inbox_notify.notified() => {}
                    _ = interval.tick() => {}
                }

                // Quick status check (avoids inbox I/O when not idle)
                match writer_poll.get_status().await {
                    SessionStatus::Exited => break,
                    SessionStatus::Thinking => continue,
                    SessionStatus::Idle => {}
                }

                // Use buffered messages if available, otherwise read from inbox
                let (messages, ndjson) = if let Some(ndjson) = pending_ndjson.take() {
                    let msgs = std::mem::take(&mut pending_messages);
                    (msgs, ndjson)
                } else {
                    // Read inbox (blocking I/O via spawn_blocking)
                    let team_r = team_poll.clone();
                    let agent_r = agent_id_poll.clone();
                    let msgs = match tokio::task::spawn_blocking(move || {
                        crate::teamwork::mailbox::read_inbox_sync(&team_r, &agent_r)
                    })
                    .await
                    {
                        Ok(Ok(msgs)) => msgs,
                        Ok(Err(e)) => {
                            eprintln!("[teamwork] Polling inbox error: {e}");
                            continue;
                        }
                        Err(e) => {
                            eprintln!("[teamwork] Polling task panic: {e}");
                            break;
                        }
                    };

                    if msgs.is_empty() {
                        continue;
                    }

                    // Build combined text: [Сообщение от {from}]: {text}
                    let text: String = msgs
                        .iter()
                        .map(|m| format!("[Сообщение от {}]: {}", m.from, m.text))
                        .collect::<Vec<_>>()
                        .join("\n\n");

                    let ndjson = match build_stdin_message(&text, &[]) {
                        Ok(n) => n,
                        Err(e) => {
                            eprintln!("[teamwork] Failed to build stdin message: {e}");
                            continue;
                        }
                    };

                    (msgs, ndjson)
                };

                // Atomic: check idle → write → set thinking
                match writer_poll.write_if_idle(&ndjson).await {
                    Ok(true) => {}     // sent successfully
                    Ok(false) => {
                        // Buffer messages for next tick (avoid re-reading file)
                        pending_messages = messages;
                        pending_ndjson = Some(ndjson);
                        continue;
                    }
                    Err(e) => {
                        eprintln!("[teamwork] Failed to write to stdin: {e}");
                        break;
                    }
                }

                // Mark messages as read
                let ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
                let team_m = team_poll.clone();
                let agent_m = agent_id_poll.clone();
                if let Err(e) = tokio::task::spawn_blocking(move || {
                    crate::teamwork::mailbox::mark_read_sync(&team_m, &agent_m, &ids)
                })
                .await
                .unwrap_or_else(|e| Err(format!("Task panic: {e}")))
                {
                    eprintln!("[teamwork] Failed to mark messages as read: {e}");
                }
            }

            // Cleanup: unsubscribe from push notifications
            crate::teamwork::mailbox::unsubscribe_inbox(&team_cleanup, &agent_cleanup);
        });

        (Some(handle), Some(stop_tx))
    } else {
        (None, None)
    };

    // Spawn stderr reader in background (capped at 64KB)
    let stderr_handle = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = String::new();
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break, // EOF
                Ok(_) => {
                    if buf.len() + line.len() > MAX_STDERR_BYTES {
                        // Cap: keep only the tail
                        let excess = (buf.len() + line.len()) - MAX_STDERR_BYTES;
                        if excess < buf.len() {
                            buf.drain(..excess);
                        } else {
                            buf.clear();
                        }
                    }
                    buf.push_str(&line);
                }
                Err(e) => {
                    eprintln!("[conductor] stderr read error: {e}");
                    break;
                }
            }
        }
        buf
    });

    // Read stdout line by line (NDJSON)
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    let mut completed_text = String::new();
    let mut delta_text = String::new();
    let mut combined_buf = String::new();
    let agent_id_arc: Arc<str> = Arc::from(agent_id.as_str());

    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }

        match parse_line(&line, &agent_id, &mut completed_text, &mut delta_text, &mut combined_buf) {
            Ok(events) => {
                for event in &events {
                    if matches!(event, CliEvent::TurnComplete { .. }) {
                        writer.set_status(SessionStatus::Idle).await;
                    }
                    sink.emit(event);
                }
            }
            Err(e) => {
                eprintln!("[{tag}] Parse error: {e} — line: {line}");
                sink.emit(&CliEvent::Error {
                    agent_id: agent_id_arc.clone(),
                    message: format!("Parse error: {e}"),
                });
            }
        }
    }

    // stdout closed — process is finishing; gracefully stop mailbox polling
    if let Some(stop_tx) = polling_stop_tx {
        if stop_tx.send(()).is_err() {
            eprintln!("[{tag}] Polling stop signal already consumed (receiver dropped)");
        }
    }
    if let Some(handle) = polling_handle {
        // Give the polling task time to flush pending messages
        let abort_handle = handle.abort_handle();
        match tokio::time::timeout(std::time::Duration::from_secs(5), handle).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => eprintln!("[{tag}] Polling task panic on shutdown: {e}"),
            Err(_) => {
                eprintln!("[{tag}] Polling task did not finish within 5s, aborting");
                abort_handle.abort();
            }
        }
    }

    writer.set_status(SessionStatus::Exited).await;

    // Collect stderr
    let stderr_output = stderr_handle.await.unwrap_or_default();

    // Report stderr if non-empty and not just whitespace
    let stderr_trimmed = stderr_output.trim();
    if !stderr_trimmed.is_empty() {
        eprintln!("[{tag}] CLI stderr: {stderr_trimmed}");
        // Only emit as error if it looks like a real problem
        // (CLI writes debug info to stderr with --verbose, which is normal)
    }

    // Try to capture exit code before cleanup
    let exit_code = sessions.try_exit_code(&agent_id).await;

    // Emit process exited
    sink.emit(&CliEvent::ProcessExited {
        agent_id: agent_id_arc.clone(),
        exit_code,
    });

    // Clean up session — only if it's still ours (same generation)
    sessions.cleanup(&agent_id, generation).await;

    // Unregister from MCP server (only if generation matches — prevents
    // removing a fresh registration after restart)
    if mcp_generation > 0 {
        if let Some(mcp) = crate::teamwork::mcp_server::get_state() {
            mcp.unregister_agent_if_current(&agent_id, mcp_generation)
                .await;
        }
    }

    // Clean up MCP config temp file (guard handles deletion on drop,
    // but we disarm + delete explicitly here for clarity in the normal path)
    drop(mcp_config_guard);

    Ok(())
}

/// Build NDJSON message for stdin.
///
/// Images go before text as content blocks.
/// Format: `{"type":"user","message":{"role":"user","content":[...]}}`
pub fn build_stdin_message(prompt: &str, images: &[AttachmentPayload]) -> Result<String, String> {
    let mut content: Vec<serde_json::Value> = Vec::new();

    // Add image blocks first
    for img in images {
        if img.file_type != "image" {
            continue;
        }
        if let Some((media_type, data)) = attachments::parse_data_uri(&img.content) {
            content.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": data
                }
            }));
        }
    }

    // CLI in -p mode adds cache_control to text blocks, so a text block is always
    // required. If the user sent only images, use a default prompt.
    let has_images = content.iter().any(|b| b.get("type").and_then(|t| t.as_str()) == Some("image"));
    let text = prompt.trim();
    let text = if text.is_empty() {
        if has_images {
            "What's in this image?"
        } else {
            return Err("Cannot send empty message".to_string());
        }
    } else {
        text
    };
    content.push(serde_json::json!({
        "type": "text",
        "text": text
    }));

    let msg = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": content
        }
    });
    serde_json::to_string(&msg).map_err(|e| format!("Failed to serialize message: {e}"))
}

/// Build NDJSON control_response for stdin (reply to a control_request).
///
/// If `response` contains a `"behavior"` key, it's a success response.
/// If `response` contains an `"error"` key, it's an error/deny response.
pub fn build_control_response(
    request_id: &str,
    response: &serde_json::Value,
) -> Result<String, String> {
    let msg = if response.get("error").is_some() {
        serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": request_id,
                "error": response["error"]
            }
        })
    } else {
        serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": response
            }
        })
    };
    serde_json::to_string(&msg).map_err(|e| format!("Failed to serialize control_response: {e}"))
}
