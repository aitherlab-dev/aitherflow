pub mod parser;
pub mod process;
pub mod session;
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
    let project_path = options.project_path;
    let model = options.model;

    // Clone for the spawned task (State<'_> can't cross spawn boundary)
    let sessions_owned = sessions.inner().clone();
    let app_clone = app.clone();
    let agent_id_clone = agent_id.clone();

    // Spawn session in background — command returns immediately
    tokio::spawn(async move {
        if let Err(e) = process::run_cli_session(
            app_clone.clone(),
            sessions_owned,
            agent_id_clone.clone(),
            prompt,
            project_path,
            model,
        )
        .await
        {
            eprintln!("[conductor] Session error: {e}");
            let _ = tauri::Emitter::emit(
                &app_clone,
                "cli-event",
                &CliEvent::Error {
                    agent_id: agent_id_clone,
                    message: e,
                },
            );
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

    let ndjson = process::build_stdin_message(&options.prompt)?;

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
