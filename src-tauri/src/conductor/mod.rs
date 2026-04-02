pub mod message;
pub mod parser;
pub mod process;
pub mod resolve;
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
    let ndjson = message::build_stdin_message(&options.prompt, &options.attachments)?;
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
    let ndjson = message::build_control_response(&request_id, &response)?;
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


/// Check if any agent is actively thinking (for tray quit confirmation).
#[tauri::command]
pub async fn has_active_agents(sessions: State<'_, SessionManager>) -> Result<bool, String> {
    Ok(sessions.has_active_sessions())
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

// ── Subscription usage (OAuth rate limits) ──────────────────────────

const OAUTH_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const USAGE_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(60);
const RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

static USAGE_CACHE: std::sync::LazyLock<
    std::sync::Mutex<Option<(std::time::Instant, SubscriptionUsage)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct RateLimit {
    pub utilization: Option<f64>,
    pub resets_at: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SubscriptionUsage {
    pub five_hour: Option<RateLimit>,
    pub seven_day: Option<RateLimit>,
    pub seven_day_sonnet: Option<RateLimit>,
    pub seven_day_opus: Option<RateLimit>,
}

/// Fetch Claude subscription rate-limit usage via OAuth token.
/// Caches results for 60s; retries once on 429.
#[tauri::command]
pub async fn get_subscription_usage(force: bool) -> Result<SubscriptionUsage, String> {
    // Check cache (skip if force refresh)
    if !force {
        if let Ok(guard) = USAGE_CACHE.lock() {
            if let Some((ts, ref data)) = *guard {
                if ts.elapsed() < USAGE_CACHE_TTL {
                    return Ok(data.clone());
                }
            }
        }
    }

    let token = tokio::task::spawn_blocking(|| {
        let creds_path = crate::config::home_dir().join(".claude/.credentials.json");
        let raw = std::fs::read_to_string(&creds_path)
            .map_err(|e| format!("Failed to read credentials: {e}"))?;
        let parsed: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("Failed to parse credentials: {e}"))?;

        // Check token expiry if available (expiresAt is Unix timestamp in milliseconds)
        if let Some(expires_at) = parsed.pointer("/claudeAiOauth/expiresAt").and_then(|v| v.as_i64()) {
            let now_ms = chrono::Utc::now().timestamp_millis();
            if expires_at < now_ms {
                return Err("OAuth token expired".to_string());
            }
        }

        parsed
            .pointer("/claudeAiOauth/accessToken")
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| "No accessToken in credentials".to_string())
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))??;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let usage = fetch_usage_with_retry(&client, &token).await?;

    // Update cache
    if let Ok(mut guard) = USAGE_CACHE.lock() {
        *guard = Some((std::time::Instant::now(), usage.clone()));
    }

    Ok(usage)
}

async fn fetch_usage_with_retry(
    client: &reqwest::Client,
    token: &str,
) -> Result<SubscriptionUsage, String> {
    let resp = client
        .get(OAUTH_USAGE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("Content-Type", "application/json")
        .header("User-Agent", "claude-code/1.0.0")
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        tokio::time::sleep(RETRY_DELAY).await;

        let retry = client
            .get(OAUTH_USAGE_URL)
            .header("Authorization", format!("Bearer {token}"))
            .header("anthropic-beta", "oauth-2025-04-20")
            .header("Content-Type", "application/json")
            .header("User-Agent", "claude-code/1.0.0")
            .send()
            .await
            .map_err(|e| format!("HTTP retry failed: {e}"))?;

        if !retry.status().is_success() {
            let status = retry.status();
            let body = retry.text().await.unwrap_or_default();
            eprintln!("[conductor] OAuth usage API error {status}: {body}");
            return Err(format!("API returned {status} after retry"));
        }

        return retry
            .json::<SubscriptionUsage>()
            .await
            .map_err(|e| format!("Failed to parse usage response: {e}"));
    }

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        eprintln!("[conductor] OAuth usage API error {status}: {body}");
        return Err(format!("API returned {status}"));
    }

    resp.json::<SubscriptionUsage>()
        .await
        .map_err(|e| format!("Failed to parse usage response: {e}"))
}
