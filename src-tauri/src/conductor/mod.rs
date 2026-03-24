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
    let role_system_prompt = options.role_system_prompt;
    let role_allowed_tools = options.role_allowed_tools;
    let role_name = options.role_name;

    // Teamwork is always enabled for projects
    let teamwork_project_path = project_path.clone();

    // Load additional directories for the project
    let additional_dirs = if let Some(ref pp) = project_path {
        let pp_check = pp.clone();
        tokio::task::spawn_blocking(move || {
            crate::projects::get_additional_dirs_sync(&pp_check)
        })
        .await
        .unwrap_or_default()
    } else {
        Vec::new()
    };

    // Clone for the spawned task (State<'_> can't cross spawn boundary)
    let sessions_owned = sessions.inner().clone();
    let app_clone = app.clone();
    let agent_id_clone = agent_id.clone();

    // Spawn session in background — command returns immediately
    tokio::spawn(async move {
        if let Err(e) = process::run_cli_session(
            process::EventSink::new(app_clone.clone()),
            sessions_owned,
            process::CliSessionConfig {
                agent_id: agent_id_clone.clone(),
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
            },
        )
        .await
        {
            eprintln!("[conductor] Session error: {e}");
            if let Err(e2) = tauri::Emitter::emit(
                &app_clone,
                "cli-event",
                &CliEvent::Error {
                    agent_id: agent_id_clone.into(),
                    message: e,
                },
            ) {
                eprintln!("[conductor] Failed to emit error event: {e2}");
            }
        }
    });

    Ok(())
}

/// Write an NDJSON line to an agent's stdin and set status to Thinking.
/// Uses AgentWriter's single lock for atomic stdin + status update.
async fn write_stdin(sessions: &SessionManager, agent_id: &str, ndjson: &str) -> Result<(), String> {
    let writer = sessions
        .get_writer(agent_id)
        .await
        .ok_or_else(|| "No active session for this agent".to_string())?;
    writer.write_message(ndjson).await
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
    let ndjson = process::build_stdin_message(&options.prompt, &options.attachments)?;
    write_stdin(&sessions, &agent_id, &ndjson).await
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
    let ndjson = process::build_control_response(&request_id, &response)?;
    write_stdin(&sessions, &agent_id, &ndjson).await
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
        let home = crate::config::home_dir();
        let encoded = project_path.replace(['/', '.', '_'], "-");
        let safe_session_id: String = session_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if safe_session_id.is_empty() {
            return Err("invalid session_id: empty after sanitization".into());
        }
        let jsonl_path = home
            .join(".claude")
            .join("projects")
            .join(encoded)
            .join(format!("{safe_session_id}.jsonl"));
        crate::files::validate_path_safe(&jsonl_path)?;

        if !jsonl_path.exists() {
            return Ok(serde_json::json!(null));
        }

        // Read only the tail of the file — last assistant+result events are near the end
        let tail = {
            use std::io::{Read, Seek, SeekFrom};
            let mut file = std::fs::File::open(&jsonl_path)
                .map_err(|e| format!("Failed to open JSONL: {e}"))?;
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            const TAIL_SIZE: u64 = 32 * 1024;
            if len > TAIL_SIZE {
                file.seek(SeekFrom::End(-(TAIL_SIZE as i64)))
                    .map_err(|e| format!("Seek failed: {e}"))?;
            }
            let mut raw = Vec::new();
            file.read_to_end(&mut raw)
                .map_err(|e| format!("Failed to read JSONL tail: {e}"))?;
            // After seek we land mid-line; skip to first \n to get a clean JSONL start
            let start = if len > TAIL_SIZE {
                raw.iter().position(|&b| b == b'\n').map(|p| p + 1).unwrap_or(0)
            } else {
                0
            };
            String::from_utf8_lossy(&raw[start..]).into_owned()
        };

        let mut context_usage: Option<serde_json::Value> = None;
        let mut cost_usd: f64 = 0.0;
        let mut context_window: u64 = 0;
        let mut result_found = false;

        // Iterate in reverse: find last assistant (context) and last result (cost/window)
        for line in tail.lines().rev() {
            // Stop early if we have everything
            if context_usage.is_some() && result_found {
                break;
            }

            let parsed: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[conductor] Failed to parse JSONL line: {e}");
                    continue;
                }
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
            if event_type == "result" && !result_found {
                result_found = true;
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
