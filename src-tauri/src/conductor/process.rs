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
    /// Team name for mailbox polling (None = no polling)
    pub team: Option<String>,
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
        team,
    } = config;

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
    let polling_handle = if let Some(ref team) = team {
        let writer_poll = Arc::clone(&writer);
        let agent_id_poll = agent_id.clone();
        let team_poll = team.clone();

        Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(3));
            // Skip the first immediate tick
            interval.tick().await;

            loop {
                interval.tick().await;

                // Quick status check (avoids inbox I/O when not idle)
                match writer_poll.get_status().await {
                    SessionStatus::Exited => break,
                    SessionStatus::Thinking => continue,
                    SessionStatus::Idle => {}
                }

                // Read inbox (blocking I/O via spawn_blocking)
                let team_r = team_poll.clone();
                let agent_r = agent_id_poll.clone();
                let messages = match tokio::task::spawn_blocking(move || {
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

                if messages.is_empty() {
                    continue;
                }

                // Build combined text: [Сообщение от {from}]: {text}
                let text: String = messages
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

                // Atomic: check idle → write → set thinking
                match writer_poll.write_if_idle(&ndjson).await {
                    Ok(true) => {}     // sent successfully
                    Ok(false) => continue, // no longer idle (user sent something between check and now)
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
