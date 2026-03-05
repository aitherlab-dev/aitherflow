use tokio::sync::mpsc;

use super::api::*;
use super::bot::bot_loop;
use super::state::*;
use super::types::*;

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
    // Load config outside mutex to avoid blocking I/O under lock
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
            current_project: None,
            current_project_path: None,
            recent_messages: Vec::new(),
        });

        if state.task_handle.is_some() {
            state.status.running = true;
            return Err(state.status.clone());
        }

        Ok(state.config.clone())
    });

    let config = match config {
        Ok(c) => c,
        Err(status) => return Ok(status), // Already running
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
            current_project: None,
            current_project_path: None,
            recent_messages: Vec::new(),
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
                        .map_err(|e| format!("Failed to send to telegram: {e}"))?;
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
                            eprintln!("[TG] Failed to send notification: {e}");
                        }
                    }
                }
            }
        }
        Ok(())
    })
}

/// Send initial streaming message ("..."), return message_id for later editing
#[tauri::command]
pub async fn telegram_stream_start() -> Result<i64, String> {
    let (token, chat_id, client) = with_state(|s| {
        let state = s.as_ref().ok_or("Bot not running")?;
        let token = state
            .config
            .bot_token
            .clone()
            .filter(|t| !t.is_empty())
            .ok_or("No token")?;
        let chat_id = state.config.chat_id.ok_or("No chat_id")?;
        let client = state.http_client.clone().unwrap_or_else(reqwest::Client::new);
        Ok::<_, String>((token, chat_id, client))
    })?;

    tg_send_and_get_id(&client, &token, chat_id, "...").await
}

/// Edit a streaming message with updated text
#[tauri::command]
pub async fn telegram_stream_update(message_id: i64, text: String) -> Result<(), String> {
    let (token, chat_id, client) = with_state(|s| {
        let state = s.as_ref().ok_or("Bot not running")?;
        let token = state
            .config
            .bot_token
            .clone()
            .filter(|t| !t.is_empty())
            .ok_or("No token")?;
        let chat_id = state.config.chat_id.ok_or("No chat_id")?;
        let client = state.http_client.clone().unwrap_or_else(reqwest::Client::new);
        Ok::<_, String>((token, chat_id, client))
    })?;

    tg_edit_message(&client, &token, chat_id, message_id, &text).await
}

#[tauri::command]
pub fn telegram_set_project(project_name: Option<String>, project_path: Option<String>) {
    with_state(|s| {
        if let Some(state) = s.as_mut() {
            state.current_project = project_name;
            state.current_project_path = project_path;
        }
    });
}

#[tauri::command]
pub fn telegram_push_message(role: String, text: String) {
    with_state(|s| {
        if let Some(state) = s.as_mut() {
            state.recent_messages.push(RecentMsg { role, text });
            if state.recent_messages.len() > 4 {
                let len = state.recent_messages.len();
                state.recent_messages = state.recent_messages[len - 4..].to_vec();
            }
        }
    });
}
