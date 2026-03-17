use tokio::sync::mpsc;

use super::api::{
    tg_send_inline_keyboard, tg_send_message,
    tg_send_with_reply_keyboard,
};
use super::bot::{bot_loop, get_bot_connection};
use super::{
    load_config_from_disk, save_config_to_disk, with_state, BotState, TelegramConfig,
    TelegramStatus, TgIncoming, TgOutgoing,
};

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
    let disk_config = tokio::task::spawn_blocking(load_config_from_disk)
        .await
        .unwrap_or_else(|e| {
            eprintln!("[TG] spawn_blocking panic: {e}");
            Err(e.to_string())
        })
        .unwrap_or_else(|e| {
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
            stream_message_id: 0,
            callback_registry: Vec::new(),
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
    let voice_language = tokio::task::spawn_blocking(crate::settings::get_voice_language)
        .await
        .unwrap_or_default();

    let client = super::HTTP_CLIENT.clone();
    let me = super::api::tg_get_me(&client, &token).await?;

    let (incoming_tx, incoming_rx) = mpsc::unbounded_channel::<TgIncoming>();
    let (outgoing_tx, outgoing_rx) = mpsc::unbounded_channel::<TgOutgoing>();

    let bot_token = token.clone();
    let task = tokio::spawn(bot_loop(
        bot_token,
        chat_id,
        groq_key,
        voice_language,
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
            stream_message_id: 0,
            callback_registry: Vec::new(),
        });

        // Guard: if another start/stop happened while we were connecting, abort our task
        if state.task_handle.is_some() {
            task.abort();
            return;
        }

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
    let handle = with_state(|s| {
        if let Some(state) = s.as_mut() {
            let handle = state.task_handle.take();
            state.outgoing_tx = None;
            state.incoming_tx = None;
            state.incoming_rx = None;
            state.status = TelegramStatus::default();
            handle
        } else {
            None
        }
    });

    // Outgoing channel was dropped above → bot_loop will break on next select! cycle.
    // Wait up to 3s for graceful exit, then abort as safety net.
    if let Some(mut handle) = handle {
        tokio::select! {
            _ = &mut handle => {} // Graceful exit via channel close
            _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => {
                eprintln!("[TG] Graceful shutdown timed out, aborting");
                handle.abort();
                let _ = handle.await;
            }
        }
    }
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

/// Register a callback payload in BotState and return its index-based callback_data.
/// Format: "cb:{index}" — always under 64 bytes.
fn register_callback(payload: &str) -> String {
    with_state(|s| {
        if let Some(state) = s.as_mut() {
            let idx = state.callback_registry.len();
            state.callback_registry.push(payload.to_string());
            format!("cb:{idx}")
        } else {
            // Fallback — should not happen when bot is running
            payload.to_string()
        }
    })
}

/// Clear the callback registry (called before populating new inline keyboards)
fn clear_callbacks() {
    with_state(|s| {
        if let Some(state) = s.as_mut() {
            state.callback_registry.clear();
        }
    });
}

/// Send dashboard: current agent + last message + reply keyboard (2×2 grid)
#[tauri::command]
pub async fn telegram_send_menu(
    agents: Vec<serde_json::Value>,
    current_agent: Option<String>,
    last_message: Option<String>,
    is_thinking: bool,
) -> Result<(), String> {
    let (token, chat_id, client) = get_bot_connection()?;

    let keyboard = vec![
        vec!["Active".to_string(), "Projects".to_string()],
        vec!["Skills".to_string(), "Stop".to_string()],
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
        clear_callbacks();
        let mut buttons: Vec<Vec<serde_json::Value>> = Vec::new();
        for agent in &agents {
            let id = agent["id"].as_str().unwrap_or("");
            let name = agent["projectName"].as_str().unwrap_or("Agent");
            let cb = register_callback(&format!("agent:{id}"));
            buttons.push(vec![serde_json::json!({
                "text": format!("-> {name}"),
                "callback_data": cb,
            })]);
        }
        buttons.push(vec![serde_json::json!({
            "text": "\u{2715} Cancel",
            "callback_data": "cancel",
        })]);
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

    clear_callbacks();
    let mut seen = std::collections::HashSet::new();
    let mut buttons: Vec<Vec<serde_json::Value>> = Vec::new();
    for agent in &agents {
        let id = agent["id"].as_str().unwrap_or("");
        if !seen.insert(id.to_string()) {
            continue; // skip duplicates
        }
        let name = agent["projectName"].as_str().unwrap_or("Agent");
        let active = agent["active"].as_bool().unwrap_or(false);
        let prefix = if active { ">> " } else { "" };
        let cb = register_callback(&format!("agent:{id}"));
        buttons.push(vec![serde_json::json!({
            "text": format!("{prefix}{name}"),
            "callback_data": cb,
        })]);
    }
    buttons.push(vec![serde_json::json!({
        "text": "\u{2715} Cancel",
        "callback_data": "cancel",
    })]);
    tg_send_inline_keyboard(&client, &token, chat_id, "Active agents:", buttons).await
}

/// Send projects list with inline keyboard
#[tauri::command]
pub async fn telegram_send_projects(projects: Vec<serde_json::Value>) -> Result<(), String> {
    let (token, chat_id, client) = get_bot_connection()?;

    if projects.is_empty() {
        tg_send_message(&client, &token, chat_id, "No projects configured").await?;
        return Ok(());
    }

    clear_callbacks();
    let mut buttons: Vec<Vec<serde_json::Value>> = Vec::new();
    for project in &projects {
        let path = project["path"].as_str().unwrap_or("");
        let name = project["name"].as_str().unwrap_or("Project");
        let cb = register_callback(&format!("project:{path}"));
        buttons.push(vec![serde_json::json!({
            "text": name,
            "callback_data": cb,
        })]);
    }
    buttons.push(vec![serde_json::json!({
        "text": "\u{2715} Cancel",
        "callback_data": "cancel",
    })]);

    tg_send_inline_keyboard(&client, &token, chat_id, "Start session:", buttons).await
}

/// Stream via sendMessage + editMessageText.
/// First call sends a new message; subsequent calls edit it.
#[tauri::command]
pub async fn telegram_stream_edit(text: String) -> Result<(), String> {
    use super::api::{tg_edit_message_text, tg_send_message_returning_id};
    let (token, chat_id, client) = get_bot_connection()?;

    let msg_id = with_state(|s| {
        s.as_ref().map(|st| st.stream_message_id).unwrap_or(0)
    });

    if msg_id == 0 {
        let new_id = tg_send_message_returning_id(&client, &token, chat_id, &text).await?;
        with_state(|s| {
            if let Some(state) = s.as_mut() {
                state.stream_message_id = new_id;
            }
        });
    } else {
        tg_edit_message_text(&client, &token, chat_id, msg_id, &text).await?;
    }
    Ok(())
}

/// Send skills list with inline keyboard
#[tauri::command]
pub async fn telegram_send_skills(skills: Vec<serde_json::Value>) -> Result<(), String> {
    let (token, chat_id, client) = get_bot_connection()?;

    if skills.is_empty() {
        tg_send_message(&client, &token, chat_id, "No skills available").await?;
        return Ok(());
    }

    clear_callbacks();
    let mut buttons: Vec<Vec<serde_json::Value>> = Vec::new();
    for skill in &skills {
        let id = skill["id"].as_str().unwrap_or("");
        let name = skill["name"].as_str().unwrap_or(id);
        let cb = register_callback(&format!("skill:{id}"));
        buttons.push(vec![serde_json::json!({
            "text": name,
            "callback_data": cb,
        })]);
    }
    buttons.push(vec![serde_json::json!({
        "text": "\u{2715} Cancel",
        "callback_data": "cancel",
    })]);

    tg_send_inline_keyboard(&client, &token, chat_id, "Skills:", buttons).await
}

/// Send stop menu with inline keyboard listing active agents
#[tauri::command]
pub async fn telegram_send_stop(agents: Vec<serde_json::Value>) -> Result<(), String> {
    let (token, chat_id, client) = get_bot_connection()?;

    if agents.is_empty() {
        tg_send_message(&client, &token, chat_id, "No active sessions").await?;
        return Ok(());
    }

    clear_callbacks();
    let mut buttons: Vec<Vec<serde_json::Value>> = Vec::new();
    for agent in &agents {
        let id = agent["id"].as_str().unwrap_or("");
        let name = agent["projectName"].as_str().unwrap_or("Agent");
        let cb = register_callback(&format!("stop:{id}"));
        buttons.push(vec![serde_json::json!({
            "text": format!("Stop {name}"),
            "callback_data": cb,
        })]);
    }
    buttons.push(vec![serde_json::json!({
        "text": "\u{2715} Cancel",
        "callback_data": "cancel",
    })]);

    tg_send_inline_keyboard(&client, &token, chat_id, "Stop session:", buttons).await
}

/// Reset stream message_id (call after streaming finishes)
#[tauri::command]
pub fn telegram_stream_reset() {
    with_state(|s| {
        if let Some(state) = s.as_mut() {
            state.stream_message_id = 0;
        }
    });
}
