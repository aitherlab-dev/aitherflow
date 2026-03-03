use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use super::parser::parse_line;
use super::session::{AgentSession, SessionManager};
use super::types::{AttachmentPayload, CliEvent, SessionStatus};
use crate::attachments;

/// Maximum stderr buffer size (64 KB) to prevent memory issues.
const MAX_STDERR_BYTES: usize = 64 * 1024;

/// Spawn Claude CLI and run the session until the process exits.
///
/// This is a long-running function — call it inside `tokio::spawn`.
/// Events are emitted via `app.emit("cli-event", ...)`.
#[allow(clippy::too_many_arguments)]
pub async fn run_cli_session(
    app: AppHandle,
    sessions: SessionManager,
    agent_id: String,
    prompt: String,
    project_path: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    resume_session_id: Option<String>,
    permission_mode: Option<String>,
    image_attachments: Vec<AttachmentPayload>,
) -> Result<(), String> {
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

    // Attach built-in memory MCP server if binary is available
    if let Some(mcp_config) = build_memory_mcp_config(project_path.as_deref()) {
        args.push("--mcp-config".into());
        args.push(mcp_config);
    }

    // Build command
    let mut cmd = Command::new("claude");
    cmd.args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(ref dir) = project_path {
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

    // Store session immediately (so kill works even during first write)
    sessions
        .insert(
            agent_id.clone(),
            AgentSession {
                child,
                stdin: Some(stdin),
                status: SessionStatus::Thinking,
            },
        )
        .await;

    // Write first message
    let ndjson = build_stdin_message(&prompt, &image_attachments)?;
    {
        let mut process_stdin = sessions
            .take_stdin(&agent_id)
            .await
            .ok_or_else(|| "Session lost before first write".to_string())?;

        let write_result = async {
            process_stdin.write_all(ndjson.as_bytes()).await?;
            process_stdin.write_all(b"\n").await?;
            process_stdin.flush().await?;
            Ok::<(), std::io::Error>(())
        }
        .await;

        // Always return stdin, even on write error
        sessions.return_stdin(&agent_id, process_stdin).await;

        if let Err(e) = write_result {
            return Err(format!("Failed to write first message: {e}"));
        }
    }

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
                Err(_) => break,
            }
        }
        buf
    });

    // Read stdout line by line (NDJSON)
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    let mut completed_text = String::new();
    let mut delta_text = String::new();

    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }

        match parse_line(&line, &agent_id, &mut completed_text, &mut delta_text) {
            Ok(events) => {
                for event in events {
                    if let Err(e) = app.emit("cli-event", &event) {
                        eprintln!("[conductor] Failed to emit event: {e}");
                    }
                }
            }
            Err(e) => {
                eprintln!("[conductor] Parse error: {e} — line: {line}");
                let _ = app.emit(
                    "cli-event",
                    &CliEvent::Error {
                        agent_id: agent_id.clone(),
                        message: format!("Parse error: {e}"),
                    },
                );
            }
        }
    }

    // stdout closed — process is finishing
    sessions
        .set_status(&agent_id, SessionStatus::Exited)
        .await;

    // Collect stderr
    let stderr_output = stderr_handle.await.unwrap_or_default();

    // Report stderr if non-empty and not just whitespace
    let stderr_trimmed = stderr_output.trim();
    if !stderr_trimmed.is_empty() {
        eprintln!("[conductor] CLI stderr: {stderr_trimmed}");
        // Only emit as error if it looks like a real problem
        // (CLI writes debug info to stderr with --verbose, which is normal)
    }

    // Trigger background re-indexing for this project
    if let Some(ref pp) = project_path {
        let pp = pp.clone();
        tokio::task::spawn_blocking(move || {
            crate::memory::background_index(&pp);
        });
    }

    // Emit process exited
    let _ = app.emit(
        "cli-event",
        &CliEvent::ProcessExited {
            agent_id: agent_id.clone(),
            exit_code: None,
        },
    );

    // Clean up session
    sessions.kill(&agent_id).await;

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

/// Try to find the aither-flow-memory binary.
/// Checks: next to the current executable, then in PATH.
fn find_memory_binary() -> Option<String> {
    // Check next to the current binary
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("aither-flow-memory");
            if candidate.exists() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }

    // Check in Cargo target directory (development mode)
    // The workspace target is at AITHEFLOW/target/debug/
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // In dev, exe is in target/debug/ — memory binary is there too
            let candidate = dir.join("aither-flow-memory");
            if candidate.exists() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }

    // Check in PATH
    if let Ok(output) = std::process::Command::new("which")
        .arg("aither-flow-memory")
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }

    None
}

/// Build --mcp-config JSON string for the memory MCP server.
fn build_memory_mcp_config(project_path: Option<&str>) -> Option<String> {
    let binary = find_memory_binary()?;
    let db_path = crate::memory::memory_db_path();
    let project = project_path.unwrap_or("unknown");

    let config = serde_json::json!({
        "mcpServers": {
            "aither-memory": {
                "command": binary,
                "args": [
                    "--db", db_path.to_string_lossy(),
                    "--project", project
                ]
            }
        }
    });

    match serde_json::to_string(&config) {
        Ok(s) => {
            eprintln!("[conductor] Memory MCP: {s}");
            Some(s)
        }
        Err(e) => {
            eprintln!("[conductor] Failed to build MCP config: {e}");
            None
        }
    }
}
