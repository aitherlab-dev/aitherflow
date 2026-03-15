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
    #[allow(dead_code)]
    pub effort: Option<String>,
    pub resume_session_id: Option<String>,
    pub permission_mode: Option<String>,
    pub chrome: bool,
    pub image_attachments: Vec<AttachmentPayload>,
    /// Team name for mailbox polling (None = no polling)
    pub team: Option<String>,
    /// Team ID for role-based launch args (None = no team restrictions)
    pub team_id: Option<String>,
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
        effort: _,
        resume_session_id,
        permission_mode,
        chrome,
        image_attachments,
        team,
        team_id,
    } = config;

    // If agent belongs to a team, look up role-based launch args, team name, and
    // agent list for MCP registration. Errors are fatal — agent must not start
    // without correct permissions.
    let (team_extra_args, team_name_from_id, team_agent_ids, team_role, team_system_prompt) =
        if let Some(ref tid) = team_id {
            let tid_clone = tid.clone();
            let aid_clone = agent_id.clone();
            let info = tokio::task::spawn_blocking(move || {
                crate::teamwork::team::get_agent_launch_args_sync(&tid_clone, &aid_clone)
            })
            .await
            .map_err(|e| format!("Team args task panic: {e}"))??;
            (
                info.cli_args,
                Some(info.team_name),
                Some(info.agent_ids),
                Some(info.role),
                info.system_prompt,
            )
        } else {
            (Vec::new(), None, None, None, None)
        };

    // Team name for mailbox: explicit `team` field takes priority, otherwise derive from team_id
    let team_for_mailbox = team.or(team_name_from_id.clone());

    // Register agent in MCP server so it can use teamwork tools.
    // This runs inside run_cli_session (not start_agent_core) so it works
    // regardless of how the session is started (team panel, chat UI, restart).
    let mcp_generation = if let (Some(ref tid), Some(ref tn), Some(ref aids), Some(ref role)) =
        (&team_id, &team_name_from_id, &team_agent_ids, &team_role)
    {
        if let Some(mcp) = crate::teamwork::mcp_server::get_state() {
            mcp.register_agent(&agent_id, tn, tid, aids.clone(), role.clone())
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

    if let Some(ref m) = model {
        args.push("--model".into());
        args.push(m.clone());
    }

    // effort intentionally not passed — let CLI use its default

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

    // Add role-based args from team config (e.g. --allowedTools)
    args.extend(team_extra_args);

    // Add role system prompt via --append-system-prompt
    if let Some(ref sp) = team_system_prompt {
        if !sp.is_empty() {
            args.push("--append-system-prompt".into());
            args.push(sp.clone());
        }
    }

    // Create MCP config file for team agents (points to the built-in MCP server).
    // Wrapped in TempFileGuard so the file is cleaned up on early return.
    let mcp_config_guard = if team_id.is_some() {
        if let Some(port) = crate::teamwork::mcp_server::get_mcp_port() {
            let path =
                std::env::temp_dir().join(format!("aitherflow-mcp-{agent_id}.json"));
            let config_json = serde_json::json!({
                "mcpServers": {
                    "teamwork": {
                        "type": "http",
                        "url": format!("http://127.0.0.1:{port}/mcp/{agent_id}")
                    }
                }
            });
            let path_clone = path.clone();
            tokio::task::spawn_blocking(move || {
                std::fs::write(
                    &path_clone,
                    serde_json::to_string_pretty(&config_json)
                        .expect("Failed to serialize MCP config"),
                )
                .map_err(|e| format!("Failed to write MCP config: {e}"))
            })
            .await
            .map_err(|e| format!("MCP config task panic: {e}"))??;

            args.push("--mcp-config".into());
            args.push(path.to_string_lossy().into_owned());
            TempFileGuard::new(path)
        } else {
            eprintln!("[{tag}] MCP server not running, skipping --mcp-config for team agent");
            TempFileGuard(None)
        }
    } else {
        TempFileGuard(None)
    };

    // Build command
    let mut cmd = Command::new("claude");
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

    // Spawn mailbox polling task if agent belongs to a team
    let polling_handle = if let Some(ref team) = team_for_mailbox {
        let writer_poll = Arc::clone(&writer);
        let agent_id_poll = agent_id.clone();
        let team_poll = team.clone();

        Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(3));
            // Skip the first immediate tick
            interval.tick().await;

            // Buffer for messages that couldn't be sent (agent was busy)
            let mut pending_messages: Vec<crate::teamwork::mailbox::TeamMessage> = Vec::new();
            let mut pending_ndjson: Option<String> = None;

            loop {
                interval.tick().await;

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
        }))
    } else {
        None
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
                }
                for event in events {
                    sink.emit(&event);
                }
            }
            Err(e) => {
                eprintln!("[{tag}] Parse error: {e} — line: {line}");
                sink.emit(&CliEvent::Error {
                    agent_id: agent_id.clone(),
                    message: format!("Parse error: {e}"),
                });
            }
        }
    }

    // stdout closed — process is finishing; stop mailbox polling
    if let Some(handle) = polling_handle {
        handle.abort();
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
        agent_id: agent_id.clone(),
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
