use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

use crate::file_ops::atomic_write;

use super::api::*;
use super::*;

// ── Bot loop ──

async fn bot_loop(
    token: String,
    owner_chat_id: i64,
    groq_key: Option<String>,
    incoming_tx: mpsc::UnboundedSender<TgIncoming>,
    mut outgoing_rx: mpsc::UnboundedReceiver<TgOutgoing>,
) {
    let client = reqwest::Client::new();
    let mut update_offset: i64 = 0;

    if let Err(e) = tg_set_my_commands(&client, &token).await {
        eprintln!("[TG] setMyCommands failed: {e}");
    }

    loop {
        tokio::select! {
            updates_result = tg_get_updates(&client, &token, update_offset) => {
                match updates_result {
                    Ok(updates) => {
                        for update in updates {
                            update_offset = update.update_id + 1;

                            if let Some(cb) = update.callback_query {
                                if cb.from.id == owner_chat_id {
                                    if let Err(e) = tg_answer_callback(&client, &token, &cb.id).await {
                                        eprintln!("[TG] answerCallback failed: {e}");
                                    }
                                    if let Some(data) = cb.data {
                                        handle_callback(&client, &token, owner_chat_id, &data, &incoming_tx).await;
                                    }
                                }
                                continue;
                            }

                            if let Some(msg) = update.message {
                                if msg.chat.id != owner_chat_id {
                                    if let Err(e) = tg_send_message(&client, &token, msg.chat.id, "Access denied").await {
                                        eprintln!("[TG] send access denied: {e}");
                                    }
                                    continue;
                                }

                                // Voice
                                if let Some(voice) = msg.voice {
                                    handle_voice(&client, &token, owner_chat_id, &voice.file_id, &groq_key, &incoming_tx).await;
                                    continue;
                                }

                                // Photo
                                if let Some(photos) = msg.photo {
                                    if let Some(photo) = photos.last() {
                                        handle_photo(&client, &token, owner_chat_id, &photo.file_id, msg.caption.as_deref(), &incoming_tx).await;
                                    }
                                    continue;
                                }

                                // Document (image only)
                                if let Some(doc) = msg.document {
                                    let mime = doc.mime_type.as_deref().unwrap_or("");
                                    if mime.starts_with("image/") {
                                        let name = doc.file_name.as_deref().unwrap_or("photo.jpg");
                                        handle_document_image(&client, &token, owner_chat_id, &doc.file_id, name, msg.caption.as_deref(), &incoming_tx).await;
                                    } else if let Err(e) = tg_send_message(&client, &token, owner_chat_id, "Only images are supported").await {
                                        eprintln!("[TG] send unsupported format: {e}");
                                    }
                                    continue;
                                }

                                // Text
                                if let Some(text) = msg.text {
                                    if text.starts_with('/') {
                                        handle_command(&client, &token, owner_chat_id, &text, &incoming_tx).await;
                                    } else if let Some(kind) = keyboard_button_kind(&text) {
                                        if let Err(e) = incoming_tx.send(TgIncoming {
                                            kind: kind.into(),
                                            text: String::new(),
                                            project_path: None,
                                            project_name: None,
                                            attachment_path: None,
                                        }) {
                                            eprintln!("[TG] send keyboard button: {e}");
                                        }
                                    } else if let Err(e) = incoming_tx.send(TgIncoming {
                                        kind: "text".into(),
                                        text,
                                        project_path: None,
                                        project_name: None,
                                        attachment_path: None,
                                    }) {
                                        eprintln!("[TG] send incoming text: {e}");
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[TG] getUpdates error: {e}");
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                }
            }

            Some(outgoing) = outgoing_rx.recv() => {
                if let Err(e) = tg_send_message(&client, &token, outgoing.chat_id, &outgoing.text).await {
                    eprintln!("[TG] send outgoing: {e}");
                }
            }
        }
    }
}

fn keyboard_button_kind(text: &str) -> Option<&'static str> {
    match text {
        "Agents" => Some("request_agents"),
        "Projects" => Some("request_projects"),
        "Status" => Some("request_status"),
        "History" => Some("request_history"),
        _ => None,
    }
}

// ── Handlers ──

async fn handle_callback(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    data: &str,
    incoming_tx: &mpsc::UnboundedSender<TgIncoming>,
) {
    if let Some(agent_id) = data.strip_prefix("agent:") {
        if let Err(e) = incoming_tx.send(TgIncoming {
            kind: "switch_agent".into(),
            text: agent_id.to_string(),
            project_path: None,
            project_name: None,
            attachment_path: None,
        }) {
            eprintln!("[TG] send switch_agent: {e}");
        }
    } else if let Some(path) = data.strip_prefix("project:") {
        let name = path.rsplit('/').next().unwrap_or(path);
        if let Err(e) = incoming_tx.send(TgIncoming {
            kind: "new_session".into(),
            text: String::new(),
            project_path: Some(path.to_string()),
            project_name: Some(name.to_string()),
            attachment_path: None,
        }) {
            eprintln!("[TG] send new_session: {e}");
        }
        if let Err(e) = tg_send_message(client, token, chat_id, &format!("Starting session in: {name}")).await {
            eprintln!("[TG] confirm new_session: {e}");
        }
    }
}

async fn handle_command(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    text: &str,
    incoming_tx: &mpsc::UnboundedSender<TgIncoming>,
) {
    let cmd = text.split_whitespace().next().unwrap_or("");
    let send_request = |kind: &str| {
        incoming_tx.send(TgIncoming {
            kind: kind.into(),
            text: String::new(),
            project_path: None,
            project_name: None,
            attachment_path: None,
        })
    };
    match cmd {
        "/start" | "/menu" => {
            if let Err(e) = send_request("request_menu") {
                eprintln!("[TG] send request_menu: {e}");
            }
        }
        "/agents" => {
            if let Err(e) = send_request("request_agents") {
                eprintln!("[TG] send request_agents: {e}");
            }
        }
        "/projects" => {
            if let Err(e) = send_request("request_projects") {
                eprintln!("[TG] send request_projects: {e}");
            }
        }
        "/history" => {
            if let Err(e) = send_request("request_history") {
                eprintln!("[TG] send request_history: {e}");
            }
        }
        "/status" => {
            if let Err(e) = send_request("request_status") {
                eprintln!("[TG] send request_status: {e}");
            }
        }
        "/help" => {
            let help = "\
/start — dashboard\n\
/agents — active agents\n\
/projects — start new session\n\
/history — recent messages\n\
/status — current status\n\n\
Text or voice goes to the active agent.";
            if let Err(e) = tg_send_message(client, token, chat_id, help).await {
                eprintln!("[TG] send help: {e}");
            }
        }
        _ => {
            if let Err(e) = tg_send_message(client, token, chat_id, "Unknown command. /help").await {
                eprintln!("[TG] send unknown cmd: {e}");
            }
        }
    }
}

async fn handle_voice(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    file_id: &str,
    groq_key: &Option<String>,
    incoming_tx: &mpsc::UnboundedSender<TgIncoming>,
) {
    let Some(key) = groq_key.as_deref() else {
        if let Err(e) = tg_send_message(client, token, chat_id, "Groq API key not configured").await {
            eprintln!("[TG] send groq key missing: {e}");
        }
        return;
    };

    if let Err(e) = tg_send_message(client, token, chat_id, "Transcribing...").await {
        eprintln!("[TG] send transcribing: {e}");
    }

    match tg_download_file(client, token, file_id).await {
        Ok((audio, _)) => match groq_transcribe(client, key, audio).await {
            Ok(text) => {
                if text.trim().is_empty() {
                    if let Err(e) = tg_send_message(client, token, chat_id, "Could not recognize speech").await {
                        eprintln!("[TG] send speech fail: {e}");
                    }
                } else if let Err(e) = incoming_tx.send(TgIncoming {
                    kind: "text".into(),
                    text,
                    project_path: None,
                    project_name: None,
                    attachment_path: None,
                }) {
                    eprintln!("[TG] send transcribed: {e}");
                }
            }
            Err(e) => {
                if let Err(se) = tg_send_message(client, token, chat_id, &format!("Transcription error: {e}")).await {
                    eprintln!("[TG] send transcription error: {se}");
                }
            }
        },
        Err(e) => {
            if let Err(se) = tg_send_message(client, token, chat_id, &format!("Voice download error: {e}")).await {
                eprintln!("[TG] send download error: {se}");
            }
        }
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn save_to_tmp(bytes: &[u8], filename: &str) -> Result<String, String> {
    let tmp_dir = std::env::temp_dir().join("aitherflow-tg");
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create tmp dir: {e}"))?;
    let tmp_path = tmp_dir.join(filename);
    atomic_write(&tmp_path, bytes)?;
    Ok(tmp_path.to_string_lossy().to_string())
}

async fn handle_photo(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    file_id: &str,
    caption: Option<&str>,
    incoming_tx: &mpsc::UnboundedSender<TgIncoming>,
) {
    match tg_download_file(client, token, file_id).await {
        Ok((bytes, ext)) => {
            let filename = format!("tg_photo_{}.{ext}", now_millis());
            match save_to_tmp(&bytes, &filename) {
                Ok(path) => {
                    let text = match caption {
                        Some(c) if !c.is_empty() => c.to_string(),
                        _ => "[Photo]".to_string(),
                    };
                    if let Err(e) = incoming_tx.send(TgIncoming {
                        kind: "text".into(),
                        text,
                        project_path: None,
                        project_name: None,
                        attachment_path: Some(path),
                    }) {
                        eprintln!("[TG] send photo: {e}");
                    }
                }
                Err(e) => {
                    if let Err(se) = tg_send_message(client, token, chat_id, &format!("Save error: {e}")).await {
                        eprintln!("[TG] send save error: {se}");
                    }
                }
            }
        }
        Err(e) => {
            if let Err(se) = tg_send_message(client, token, chat_id, &format!("Photo download error: {e}")).await {
                eprintln!("[TG] send photo dl error: {se}");
            }
        }
    }
}

async fn handle_document_image(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    file_id: &str,
    file_name: &str,
    caption: Option<&str>,
    incoming_tx: &mpsc::UnboundedSender<TgIncoming>,
) {
    match tg_download_file(client, token, file_id).await {
        Ok((bytes, _)) => {
            let safe_name = std::path::Path::new(file_name)
                .file_name()
                .and_then(|n| n.to_str())
                .filter(|n| !n.is_empty() && *n != "." && *n != "..")
                .unwrap_or("photo.jpg");
            let filename = format!("tg_{safe_name}");
            match save_to_tmp(&bytes, &filename) {
                Ok(path) => {
                    let text = match caption {
                        Some(c) if !c.is_empty() => c.to_string(),
                        _ => "[Photo]".to_string(),
                    };
                    if let Err(e) = incoming_tx.send(TgIncoming {
                        kind: "text".into(),
                        text,
                        project_path: None,
                        project_name: None,
                        attachment_path: Some(path),
                    }) {
                        eprintln!("[TG] send doc image: {e}");
                    }
                }
                Err(e) => {
                    if let Err(se) = tg_send_message(client, token, chat_id, &format!("Save error: {e}")).await {
                        eprintln!("[TG] send save error: {se}");
                    }
                }
            }
        }
        Err(e) => {
            if let Err(se) = tg_send_message(client, token, chat_id, &format!("File download error: {e}")).await {
                eprintln!("[TG] send file dl error: {se}");
            }
        }
    }
}

// ── Tauri commands ──

#[tauri::command]
pub async fn load_telegram_config() -> Result<TelegramConfig, String> {
    tokio::task::spawn_blocking(load_config_from_disk)
        .await
        .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn save_telegram_config(config: TelegramConfig) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        save_config_to_disk(&config)?;
        with_state(|s| {
            if let Some(state) = s.as_mut() {
                state.config = config;
            }
        });
        Ok(())
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub fn get_telegram_status() -> Result<TelegramStatus, String> {
    Ok(with_state(|s| {
        s.as_ref()
            .map(|st| st.status.clone())
            .unwrap_or_default()
    }))
}

#[tauri::command]
pub async fn start_telegram_bot() -> Result<TelegramStatus, String> {
    let disk_config = load_config_from_disk().unwrap_or_else(|e| {
        eprintln!("[TG] {e}");
        TelegramConfig::default()
    });

    let config = with_state(|s| {
        let state = s.get_or_insert_with(|| BotState {
            config: disk_config.clone(),
            status: TelegramStatus::default(),
            task_handle: None,
            outgoing_tx: None,
            incoming_tx: None,
            incoming_rx: None,
            http_client: None,
        });

        if state.task_handle.is_some() {
            state.status.running = true;
            return Err(state.status.clone());
        }

        Ok(state.config.clone())
    });

    let config = match config {
        Ok(c) => c,
        Err(status) => return Ok(status),
    };

    let token = config
        .bot_token
        .as_ref()
        .filter(|t| !t.is_empty())
        .ok_or("Bot token is not configured")?
        .clone();

    let chat_id = config.chat_id.ok_or("Telegram chat ID is not configured")?;
    let groq_key = config.groq_api_key.clone().filter(|k| !k.is_empty());

    let client = reqwest::Client::new();
    let me = tg_get_me(&client, &token).await?;

    let (incoming_tx, incoming_rx) = mpsc::unbounded_channel::<TgIncoming>();
    let (outgoing_tx, outgoing_rx) = mpsc::unbounded_channel::<TgOutgoing>();

    let bot_token = token.clone();
    let task = tokio::spawn(bot_loop(
        bot_token,
        chat_id,
        groq_key,
        incoming_tx.clone(),
        outgoing_rx,
    ));

    let status = TelegramStatus {
        running: true,
        connected: true,
        error: None,
        bot_username: me.username,
    };

    with_state(|s| {
        let state = s.get_or_insert_with(|| BotState {
            config: disk_config,
            status: TelegramStatus::default(),
            task_handle: None,
            outgoing_tx: None,
            incoming_tx: None,
            incoming_rx: None,
            http_client: None,
        });
        state.status = status.clone();
        state.task_handle = Some(task);
        state.outgoing_tx = Some(outgoing_tx);
        state.incoming_tx = Some(incoming_tx);
        state.incoming_rx = Some(incoming_rx);
        state.http_client = Some(client);
    });

    Ok(status)
}

#[tauri::command]
pub async fn stop_telegram_bot() -> Result<(), String> {
    with_state(|s| {
        if let Some(state) = s.as_mut() {
            if let Some(handle) = state.task_handle.take() {
                handle.abort();
            }
            state.outgoing_tx = None;
            state.incoming_tx = None;
            state.incoming_rx = None;
            state.status = TelegramStatus::default();
        }
    });
    Ok(())
}

#[tauri::command]
pub fn poll_telegram_messages() -> Result<Vec<TgIncoming>, String> {
    Ok(with_state(|s| {
        let mut messages = Vec::new();
        if let Some(state) = s.as_mut() {
            if let Some(rx) = state.incoming_rx.as_mut() {
                while let Ok(msg) = rx.try_recv() {
                    messages.push(msg);
                }
            }
        }
        messages
    }))
}

#[tauri::command]
pub fn send_to_telegram(text: String) -> Result<(), String> {
    with_state(|s| {
        if let Some(state) = s.as_ref() {
            if let Some(tx) = &state.outgoing_tx {
                let chat_id = state.config.chat_id.unwrap_or(0);
                if chat_id != 0 {
                    tx.send(TgOutgoing { text, chat_id })
                        .map_err(|e| format!("Failed to send: {e}"))?;
                }
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub fn notify_telegram(text: String) -> Result<(), String> {
    with_state(|s| {
        if let Some(state) = s.as_ref() {
            if state.config.notify_on_complete {
                if let Some(tx) = &state.outgoing_tx {
                    let chat_id = state.config.chat_id.unwrap_or(0);
                    if chat_id != 0 {
                        if let Err(e) = tx.send(TgOutgoing { text, chat_id }) {
                            eprintln!("[TG] send notification: {e}");
                        }
                    }
                }
            }
        }
        Ok(())
    })
}

fn get_bot_connection() -> Result<(String, i64, reqwest::Client), String> {
    with_state(|s| {
        let state = s.as_ref().ok_or("Bot not running")?;
        let token = state.config.bot_token.clone().filter(|t| !t.is_empty()).ok_or("No token")?;
        let chat_id = state.config.chat_id.ok_or("No chat_id")?;
        let client = state.http_client.clone().unwrap_or_else(reqwest::Client::new);
        Ok((token, chat_id, client))
    })
}

/// Send dashboard: current agent + last message + reply keyboard
#[tauri::command]
pub async fn telegram_send_menu(
    agents: Vec<serde_json::Value>,
    _projects: Vec<serde_json::Value>,
    current_agent: Option<String>,
    last_message: Option<String>,
    is_thinking: bool,
) -> Result<(), String> {
    let (token, chat_id, client) = get_bot_connection()?;

    let keyboard = vec![
        vec!["Agents".to_string(), "Projects".to_string()],
        vec!["Status".to_string(), "History".to_string()],
    ];

    // Build dashboard text
    let mut text = String::new();
    if let Some(agent) = &current_agent {
        let status = if is_thinking { "thinking..." } else { "idle" };
        text.push_str(&format!("*{agent}* — {status}\n\n"));
    }
    if let Some(msg) = &last_message {
        text.push_str(msg);
    }
    if text.is_empty() {
        text.push_str("No active session");
    }

    // Send dashboard with persistent keyboard
    tg_send_with_reply_keyboard(&client, &token, chat_id, &text, keyboard).await?;

    // If agents > 1, also show inline switch buttons
    if agents.len() > 1 {
        let mut buttons: Vec<Vec<serde_json::Value>> = Vec::new();
        for agent in &agents {
            let id = agent["id"].as_str().unwrap_or("");
            let name = agent["projectName"].as_str().unwrap_or("Agent");
            buttons.push(vec![serde_json::json!({
                "text": format!("-> {name}"),
                "callback_data": format!("agent:{id}"),
            })]);
        }
        tg_send_inline_keyboard(&client, &token, chat_id, "Switch agent:", buttons).await?;
    }

    Ok(())
}

/// Send agents list with inline switch buttons
#[tauri::command]
pub async fn telegram_send_agents(agents: Vec<serde_json::Value>) -> Result<(), String> {
    let (token, chat_id, client) = get_bot_connection()?;

    if agents.is_empty() {
        tg_send_message(&client, &token, chat_id, "No active agents").await?;
        return Ok(());
    }

    let mut buttons: Vec<Vec<serde_json::Value>> = Vec::new();
    for agent in &agents {
        let id = agent["id"].as_str().unwrap_or("");
        let name = agent["projectName"].as_str().unwrap_or("Agent");
        let active = agent["active"].as_bool().unwrap_or(false);
        let prefix = if active { ">> " } else { "" };
        buttons.push(vec![serde_json::json!({
            "text": format!("{prefix}{name}"),
            "callback_data": format!("agent:{id}"),
        })]);
    }
    tg_send_inline_keyboard(&client, &token, chat_id, "Active agents:", buttons).await
}

/// Send projects list with inline buttons
#[tauri::command]
pub async fn telegram_send_projects(projects: Vec<serde_json::Value>) -> Result<(), String> {
    let (token, chat_id, client) = get_bot_connection()?;

    if projects.is_empty() {
        tg_send_message(&client, &token, chat_id, "No projects configured").await?;
        return Ok(());
    }

    let mut buttons: Vec<Vec<serde_json::Value>> = Vec::new();
    for project in &projects {
        let path = project["path"].as_str().unwrap_or("");
        let name = project["name"].as_str().unwrap_or("Project");
        buttons.push(vec![serde_json::json!({
            "text": name,
            "callback_data": format!("project:{path}"),
        })]);
    }
    tg_send_inline_keyboard(&client, &token, chat_id, "Start session:", buttons).await
}

/// Send status info
#[tauri::command]
pub async fn telegram_send_status(
    current_agent: Option<String>,
    model: Option<String>,
    is_thinking: bool,
) -> Result<(), String> {
    let (token, chat_id, client) = get_bot_connection()?;

    let agent = current_agent.as_deref().unwrap_or("none");
    let model = model.as_deref().unwrap_or("unknown");
    let status = if is_thinking { "thinking..." } else { "idle" };

    let text = format!("Agent: *{agent}*\nModel: {model}\nStatus: {status}");
    tg_send_message(&client, &token, chat_id, &text).await
}

/// Send chat history snippet to Telegram
#[tauri::command]
pub async fn telegram_send_history(messages: Vec<serde_json::Value>) -> Result<(), String> {
    let (token, chat_id, client) = with_state(|s| {
        let state = s.as_ref().ok_or("Bot not running")?;
        let token = state.config.bot_token.clone().filter(|t| !t.is_empty()).ok_or("No token")?;
        let chat_id = state.config.chat_id.ok_or("No chat_id")?;
        let client = state.http_client.clone().unwrap_or_else(reqwest::Client::new);
        Ok::<_, String>((token, chat_id, client))
    })?;

    if messages.is_empty() {
        tg_send_message(&client, &token, chat_id, "No messages yet").await?;
        return Ok(());
    }

    let mut out = String::new();
    for m in &messages {
        let role = m["role"].as_str().unwrap_or("?");
        let text = m["text"].as_str().unwrap_or("");
        let icon = if role == "user" { "👤" } else { "🤖" };
        let preview = if text.len() > 500 {
            let end = text
                .char_indices()
                .nth(500)
                .map(|(i, _)| i)
                .unwrap_or(text.len());
            format!("{}…", &text[..end])
        } else {
            text.to_string()
        };
        out.push_str(&format!("{icon} {preview}\n\n"));
    }

    tg_send_message(&client, &token, chat_id, out.trim()).await
}

/// Stream a draft message (Bot API 9.3+ sendMessageDraft)
#[tauri::command]
pub async fn telegram_stream_draft(text: String) -> Result<(), String> {
    let (token, chat_id, client) = get_bot_connection()?;
    tg_send_message_draft(&client, &token, chat_id, &text).await
}
