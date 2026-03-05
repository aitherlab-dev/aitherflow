pub mod parser;
pub mod process;
pub mod session;
pub mod stats;
pub mod types;

use tauri::State;

use session::SessionManager;
use types::{CliEvent, SendMessageOptions, StartSessionOptions, DEFAULT_AGENT_ID};

/// Start a new CLI session. Spawns the process, writes the first message,
/// and returns immediately. All events are delivered via global "cli-event".
#[tauri::command]
pub async fn start_session(
    app: tauri::AppHandle,
    sessions: State<'_, SessionManager>,
    options: StartSessionOptions,
) -> Result<(), String> {
    let agent_id = options
        .agent_id
        .unwrap_or_else(|| DEFAULT_AGENT_ID.to_string());
    let prompt = options.prompt;
    let project_path = options
        .project_path
        .or_else(|| Some(crate::config::workspace_dir().to_string_lossy().into_owned()));
    let model = options.model;
    let effort = options.effort;
    let resume_session_id = options.resume_session_id;
    let permission_mode = options.permission_mode;
    let chrome = options.chrome;
    let image_attachments = options.attachments;

    // Clone for the spawned task (State<'_> can't cross spawn boundary)
    let sessions_owned = sessions.inner().clone();
    let app_clone = app.clone();
    let agent_id_clone = agent_id.clone();

    // Spawn session in background — command returns immediately
    tokio::spawn(async move {
        if let Err(e) = process::run_cli_session(
            process::EventSink::Tauri(app_clone.clone()),
            sessions_owned,
            agent_id_clone.clone(),
            prompt,
            project_path,
            model,
            effort,
            resume_session_id,
            permission_mode,
            chrome,
            image_attachments,
        )
        .await
        {
            eprintln!("[conductor] Session error: {e}");
            if let Err(e2) = tauri::Emitter::emit(
                &app_clone,
                "cli-event",
                &CliEvent::Error {
                    agent_id: agent_id_clone,
                    message: e,
                },
            ) {
                eprintln!("[conductor] Failed to emit error event: {e2}");
            }
        }
    });

    Ok(())
}

/// Send a follow-up message to an existing CLI session via stdin.
#[tauri::command]
pub async fn send_message(
    sessions: State<'_, SessionManager>,
    options: SendMessageOptions,
) -> Result<(), String> {
    let agent_id = options
        .agent_id
        .unwrap_or_else(|| DEFAULT_AGENT_ID.to_string());

    let mut stdin = sessions
        .take_stdin(&agent_id)
        .await
        .ok_or_else(|| "No active session for this agent".to_string())?;

    let ndjson = process::build_stdin_message(&options.prompt, &options.attachments)?;

    let result = async {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(ndjson.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok::<(), std::io::Error>(())
    }
    .await;

    // Always return stdin, even on error
    sessions.return_stdin(&agent_id, stdin).await;

    result.map_err(|e| format!("Failed to send message: {e}"))
}

/// Respond to a control_request (permission or interactive tool) via control_response.
///
/// `response` is a JSON value:
/// - `{ "behavior": "allow", ... }` → success (allow tool execution)
/// - `{ "error": "reason" }` → deny (reject tool execution)
#[tauri::command]
pub async fn respond_to_tool(
    sessions: State<'_, SessionManager>,
    agent_id: Option<String>,
    request_id: String,
    response: serde_json::Value,
) -> Result<(), String> {
    let agent_id = agent_id.unwrap_or_else(|| DEFAULT_AGENT_ID.to_string());

    let mut stdin = sessions
        .take_stdin(&agent_id)
        .await
        .ok_or_else(|| "No active session for this agent".to_string())?;

    let ndjson = process::build_control_response(&request_id, &response)?;

    let write_result = async {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(ndjson.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok::<(), std::io::Error>(())
    }
    .await;

    sessions.return_stdin(&agent_id, stdin).await;

    write_result.map_err(|e| format!("Failed to send control_response: {e}"))
}

/// Stop (kill) an agent's CLI process.
#[tauri::command]
pub async fn stop_session(
    sessions: State<'_, SessionManager>,
    agent_id: Option<String>,
) -> Result<(), String> {
    let agent_id = agent_id.unwrap_or_else(|| DEFAULT_AGENT_ID.to_string());
    sessions.kill(&agent_id).await;
    Ok(())
}

/// Check if an agent has an active (alive) CLI session.
#[tauri::command]
pub async fn has_active_session(
    sessions: State<'_, SessionManager>,
    agent_id: Option<String>,
) -> Result<bool, String> {
    let agent_id = agent_id.unwrap_or_else(|| DEFAULT_AGENT_ID.to_string());
    Ok(sessions.is_alive(&agent_id).await)
}

/// Aggregate CLI usage statistics from all JSONL session files.
#[tauri::command]
pub async fn get_cli_stats(days: u32) -> Result<stats::AggregatedStats, String> {
    tokio::task::spawn_blocking(move || stats::aggregate_cli_stats(days))
        .await
        .map_err(|e| format!("Task failed: {e}"))?
}

/// Read usage from the last assistant + result events in a CLI session JSONL file.
/// Returns context usage, cost, and context window so the UI can show data before new messages.
#[tauri::command]
pub async fn get_session_usage(
    session_id: String,
    project_path: String,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let home = dirs::home_dir().ok_or("No home directory")?;
        let encoded = project_path.replace(['/', '.', '_'], "-");
        let jsonl_path = home
            .join(".claude")
            .join("projects")
            .join(encoded)
            .join(format!("{session_id}.jsonl"));

        if !jsonl_path.exists() {
            return Ok(serde_json::json!(null));
        }

        let content = std::fs::read_to_string(&jsonl_path)
            .map_err(|e| format!("Failed to read JSONL: {e}"))?;

        let mut context_usage: Option<serde_json::Value> = None;
        let mut cost_usd: f64 = 0.0;
        let mut context_window: u64 = 0;

        // Iterate in reverse: find last assistant (context) and last result (cost/window)
        for line in content.lines().rev() {
            // Stop early if we have everything
            if context_usage.is_some() && (cost_usd > 0.0 || context_window > 0) {
                break;
            }

            let parsed: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let event_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");

            // Last assistant event → context usage (per-turn = real context size)
            if event_type == "assistant" && context_usage.is_none() {
                if let Some(usage) = parsed.pointer("/message/usage") {
                    let input = usage
                        .get("input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let cache_creation = usage
                        .get("cache_creation_input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let cache_read = usage
                        .get("cache_read_input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let output = usage
                        .get("output_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);

                    context_usage = Some(serde_json::json!({
                        "input_tokens": input,
                        "output_tokens": output,
                        "cache_creation_input_tokens": cache_creation,
                        "cache_read_input_tokens": cache_read,
                        "context_used": input + cache_creation + cache_read,
                    }));
                }
            }

            // Last result event → cost and context window
            if event_type == "result" && cost_usd == 0.0 {
                cost_usd = parsed
                    .get("total_cost_usd")
                    .and_then(|v| v.as_f64())
                    .or_else(|| parsed.get("cost_usd").and_then(|v| v.as_f64()))
                    .unwrap_or(0.0);

                context_window = parsed
                    .get("modelUsage")
                    .and_then(|mu| mu.as_object())
                    .and_then(|obj| obj.values().next())
                    .and_then(|entry| entry.get("contextWindow"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
            }
        }

        match context_usage {
            Some(mut usage) => {
                if let Some(obj) = usage.as_object_mut() {
                    obj.insert("cost_usd".into(), serde_json::json!(cost_usd));
                    if context_window > 0 {
                        obj.insert(
                            "context_window".into(),
                            serde_json::json!(context_window),
                        );
                    }
                }
                Ok(usage)
            }
            None => Ok(serde_json::json!(null)),
        }
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}
