use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use super::parser::parse_line;
use super::session::{AgentSession, SessionManager};
use super::types::{CliEvent, SessionStatus};

/// Maximum stderr buffer size (64 KB) to prevent memory issues.
const MAX_STDERR_BYTES: usize = 64 * 1024;

/// Spawn Claude CLI and run the session until the process exits.
///
/// This is a long-running function — call it inside `tokio::spawn`.
/// Events are emitted via `app.emit("cli-event", ...)`.
pub async fn run_cli_session(
    app: AppHandle,
    sessions: SessionManager,
    agent_id: String,
    prompt: String,
    project_path: Option<String>,
    model: Option<String>,
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
    let ndjson = build_stdin_message(&prompt)?;
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
/// Format: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`
pub fn build_stdin_message(prompt: &str) -> Result<String, String> {
    let msg = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "text",
                "text": prompt
            }]
        }
    });
    serde_json::to_string(&msg).map_err(|e| format!("Failed to serialize message: {e}"))
}
