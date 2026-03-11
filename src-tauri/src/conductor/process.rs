use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use super::parser::parse_line;
use super::session::{AgentSession, SessionManager};
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

    // Attach built-in memory MCP server if binary is available
    // build_memory_mcp_config calls find_memory_binary which may run `which` (blocking I/O)
    let pp_clone = project_path.clone();
    if let Ok(Some(mcp_config)) = tokio::task::spawn_blocking(move || {
        build_memory_mcp_config(pp_clone.as_deref())
    }).await {
        args.push("--mcp-config".into());
        args.push(mcp_config);
    }

    // Index any previously-unindexed sessions for this project (runs in background)
    if let Some(ref pp) = project_path {
        let pp = pp.clone();
        tokio::task::spawn_blocking(move || {
            crate::memory::background_index(&pp);
        });
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

    // Store session immediately (so kill works even during first write)
    let generation = sessions
        .insert(
            agent_id.clone(),
            AgentSession {
                child,
                stdin: std::sync::Arc::new(tokio::sync::Mutex::new(stdin)),
                status: SessionStatus::Thinking,
                generation: 0, // assigned by insert()
            },
        )
        .await;

    // Write first message (skip if resuming with empty prompt — e.g. permission mode switch)
    if !prompt.trim().is_empty() || !image_attachments.is_empty() {
        let ndjson = build_stdin_message(&prompt, &image_attachments)?;
        {
            let stdin_handle = sessions
                .get_stdin(&agent_id)
                .await
                .ok_or_else(|| "Session lost before first write".to_string())?;
            let mut process_stdin = stdin_handle.lock().await;

            let write_result = async {
                process_stdin.write_all(ndjson.as_bytes()).await?;
                process_stdin.write_all(b"\n").await?;
                process_stdin.flush().await?;
                Ok::<(), std::io::Error>(())
            }
            .await;

            if let Err(e) = write_result {
                return Err(format!("Failed to write first message: {e}"));
            }
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

    // stdout closed — process is finishing
    sessions
        .set_status(&agent_id, SessionStatus::Exited)
        .await;

    // Collect stderr
    let stderr_output = stderr_handle.await.unwrap_or_default();

    // Report stderr if non-empty and not just whitespace
    let stderr_trimmed = stderr_output.trim();
    if !stderr_trimmed.is_empty() {
        eprintln!("[{tag}] CLI stderr: {stderr_trimmed}");
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

/// Try to find the aither-flow-memory binary.
/// Checks: next to the current executable (with and without target triple), then in PATH.
fn find_memory_binary() -> Option<String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Production: Tauri externalBin adds target triple suffix
            let target_triple = format!(
                "{}-unknown-linux-gnu",
                std::env::consts::ARCH
            );
            let sidecar = dir.join(format!("aither-flow-memory-{target_triple}"));
            if sidecar.exists() {
                return Some(sidecar.to_string_lossy().into_owned());
            }

            // Dev mode: cargo workspace puts both binaries in target/debug/
            let dev = dir.join("aither-flow-memory");
            if dev.exists() {
                return Some(dev.to_string_lossy().into_owned());
            }
        }
    }

    // Fallback: check in PATH
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
