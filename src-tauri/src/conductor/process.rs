use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::message::build_stdin_message;
use super::parser::parse_line;
use super::resolve::{read_hf_token, resolve_claude_binary, resolve_mcp_image_gen_binary};
use super::session::{AgentSession, AgentWriter, SessionManager};
use super::types::{AttachmentPayload, CliEvent, SessionStatus};

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
    /// Role name for teamwork MCP registration
    pub role_name: Option<String>,
    /// Human-readable team name for @mention routing (e.g. "coder-1")
    pub team_agent_name: Option<String>,
    /// Team roster suffix to append to system prompt
    pub team_roster_prompt: Option<String>,
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
        role_name,
        team_agent_name,
        team_roster_prompt,
    } = config;

    // For project teamwork, use the project slug as the mailbox namespace.
    let _project_teamwork_slug =
        teamwork_project_path.as_deref().map(crate::projects::project_teamwork_slug);

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

    // Additional directories (--add-dir for each)
    for dir in &additional_dirs {
        crate::files::validate_path_safe(std::path::Path::new(dir))?;
        args.push("--add-dir".into());
        args.push(dir.clone());
    }

    // Standalone role — apply system prompt and allowed tools
    // If team roster prompt exists, append it to the role system prompt
    let combined_system_prompt = match (&role_system_prompt, &team_roster_prompt) {
        (Some(sp), Some(roster)) if !sp.is_empty() => Some(format!("{sp}\n\n{roster}")),
        (Some(sp), None) if !sp.is_empty() => Some(sp.clone()),
        (None, Some(roster)) => Some(roster.clone()),
        _ => None,
    };
    if let Some(ref sp) = combined_system_prompt {
        args.push("--append-system-prompt".into());
        args.push(sp.clone());
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

    // Image generation MCP (stdio sidecar — controlled by image_mcp_enabled setting)
    {
        let image_settings = crate::image_gen::load_settings_sync();
        if image_settings.image_mcp_enabled {
            if let Some(bin_path) = resolve_mcp_image_gen_binary() {
                let mut env = serde_json::json!({
                    "HF_HOME": &image_settings.models_path,
                    "AITHERFLOW_MODELS_PATH": &image_settings.models_path,
                    "AITHERFLOW_IMAGES_PATH": &image_settings.images_path,
                    "AITHERFLOW_SELECTED_MODEL": &image_settings.selected_model
                });
                // Pass HF token so gated models can be downloaded
                if let Some(token) = read_hf_token() {
                    if let Some(obj) = env.as_object_mut() {
                        obj.insert(
                            "HF_TOKEN".into(),
                            serde_json::Value::String(token),
                        );
                    }
                }
                mcp_servers.insert("aitherflow-image-gen".into(), serde_json::json!({
                    "type": "stdio",
                    "command": bin_path.to_string_lossy(),
                    "env": env
                }));
            } else {
                eprintln!("[{tag}] mcp-image-gen binary not found, skipping image generation MCP");
            }
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

    // Enable 1M context window for Opus
    cmd.env("ANTHROPIC_DEFAULT_OPUS_MODEL", "claude-opus-4-6[1m]");

    // Apply custom environment variables from settings
    {
        let cli_env = tokio::task::spawn_blocking(|| {
            let path = crate::settings::settings_path();
            crate::file_ops::read_json::<crate::settings::AppSettings>(&path)
                .map(|s| s.cli_env)
                .unwrap_or_default()
        })
        .await
        .unwrap_or_default();
        for (key, value) in &cli_env {
            cmd.env(key, value);
        }
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

    // Register agent in team router (if this is a team agent)
    if let (Some(ref name), Some(ref rn)) = (&team_agent_name, &role_name) {
        if let Some(router) = crate::teamwork::router::get_router() {
            router.register(&agent_id, name, rn, Arc::clone(&writer)).await;
        }
    }

    // Write first message (skip if resuming with empty prompt — e.g. permission mode switch)
    if !prompt.trim().is_empty() || !image_attachments.is_empty() {
        let ndjson = build_stdin_message(&prompt, &image_attachments)?;
        writer
            .write_message(&ndjson)
            .await
            .map_err(|e| format!("Failed to write first message: {e}"))?;
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
    let agent_id_arc: Arc<str> = Arc::from(agent_id.as_str());

    // Track whether we've sent readiness notification (for non-lead team agents)
    let mut readiness_sent = false;

    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }

        match parse_line(&line, &agent_id, &mut completed_text, &mut delta_text, &mut combined_buf) {
            Ok(events) => {
                for event in &events {
                    // On TurnComplete: set idle + flush pending team messages + send readiness
                    if matches!(event, CliEvent::TurnComplete { .. }) {
                        writer.set_status(SessionStatus::Idle).await;

                        if let Some(ref name) = team_agent_name {
                            // Flush pending messages BEFORE emitting TurnComplete to frontend:
                            // the agent is now idle, so queued messages must be injected first,
                            // ensuring the frontend sees the up-to-date mailbox state.
                            if let Some(router) = crate::teamwork::router::get_router() {
                                if let Err(e) = router.flush_pending(name).await {
                                    eprintln!("[{tag}] Failed to flush pending for {name}: {e}");
                                }

                                // Send readiness notification on first TurnComplete (non-lead)
                                if !readiness_sent && !name.starts_with("team-lead") {
                                    readiness_sent = true;
                                    if let Err(e) = router.notify_ready(name).await {
                                        eprintln!("[{tag}] Failed to notify ready for {name}: {e}");
                                    }
                                }
                            }
                        }
                    }

                    // On MessageComplete: parse @mentions and route
                    if let CliEvent::MessageComplete { text, .. } = event {
                        if let Some(ref name) = team_agent_name {
                            if let Some(router) = crate::teamwork::router::get_router() {
                                let known = router.known_names().await;
                                let known_refs: Vec<&str> = known.iter().map(|s| s.as_str()).collect();
                                let mentions = crate::teamwork::mention_parser::parse_mentions(text, &known_refs);
                                if mentions.is_empty() && text.contains('@') {
                                    let preview: String = text.chars().take(200).collect();
                                    eprintln!("[{tag}] MessageComplete has @ but no parsed mentions. known={known_refs:?} text={preview:?}");
                                } else if !mentions.is_empty() {
                                    eprintln!("[{tag}] Parsed {} mention(s) from {name}", mentions.len());
                                }

                                for m in &mentions {
                                    if m.target == "all" {
                                        if let Err(e) = router.broadcast(name, &m.message).await {
                                            eprintln!("[{tag}] Broadcast error: {e}");
                                        }
                                    } else if let Err(e) = router.route(name, &m.target, &m.message).await {
                                        eprintln!("[{tag}] Route error to {}: {e}", m.target);
                                    }

                                    // Emit TeamMessage event for frontend
                                    sink.emit(&CliEvent::TeamMessage {
                                        agent_id: agent_id_arc.clone(),
                                        from_name: name.clone(),
                                        to_name: m.target.clone(),
                                        text: m.message.clone(),
                                    });
                                }
                            }
                        }
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

    // stdout closed — process is finishing
    // Unregister agent from team router
    if let Some(ref name) = team_agent_name {
        if let Some(router) = crate::teamwork::router::get_router() {
            router.unregister(name).await;
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

    // Clean up MCP config temp file (guard handles deletion on drop,
    // but we disarm + delete explicitly here for clarity in the normal path)
    drop(mcp_config_guard);

    Ok(())
}

