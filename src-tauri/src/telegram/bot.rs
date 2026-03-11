use tokio::sync::mpsc;

use super::api::{tg_answer_callback, tg_get_updates, tg_send_message, tg_set_my_commands};
use super::{with_state, TgIncoming, TgOutgoing};

/// Get bot token, chat_id, and HTTP client from the current bot state.
pub(crate) fn get_bot_connection() -> Result<(String, i64, reqwest::Client), String> {
    with_state(|s| {
        let state = s.as_ref().ok_or("Bot not running")?;
        let token = state
            .config
            .bot_token
            .clone()
            .filter(|t| !t.is_empty())
            .ok_or("No token")?;
        let chat_id = state.config.chat_id.ok_or("No chat_id")?;
        let client = state
            .http_client
            .clone()
            .unwrap_or_else(|| super::HTTP_CLIENT.clone());
        Ok((token, chat_id, client))
    })
}

pub(super) async fn bot_loop(
    token: String,
    owner_chat_id: i64,
    groq_key: Option<String>,
    voice_language: String,
    incoming_tx: mpsc::UnboundedSender<TgIncoming>,
    mut outgoing_rx: mpsc::UnboundedReceiver<TgOutgoing>,
) {
    let client = super::HTTP_CLIENT.clone();
    let mut update_offset: i64 = 0;
    let mut error_backoff_secs: u64 = 0;

    if let Err(e) = tg_set_my_commands(&client, &token).await {
        eprintln!("[TG] setMyCommands failed: {e}");
    }

    loop {
        tokio::select! {
            updates_result = tg_get_updates(&client, &token, update_offset) => {
                match updates_result {
                    Ok(updates) => {
                        error_backoff_secs = 0; // reset on success
                        for update in updates {
                            update_offset = update.update_id + 1;

                            if let Some(cb) = update.callback_query {
                                if cb.from.id == owner_chat_id {
                                    if let Err(e) = tg_answer_callback(&client, &token, &cb.id).await {
                                        eprintln!("[TG] answerCallback failed: {e}");
                                    }
                                    if let Some(data) = cb.data {
                                        super::handlers::handle_callback(&client, &token, owner_chat_id, &data, &incoming_tx).await;
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
                                    super::handlers::handle_voice(&client, &token, owner_chat_id, &voice.file_id, &groq_key, &voice_language, &incoming_tx).await;
                                    continue;
                                }

                                // Photo
                                if let Some(photos) = msg.photo {
                                    if let Some(photo) = photos.last() {
                                        super::handlers::handle_photo(&client, &token, owner_chat_id, &photo.file_id, msg.caption.as_deref(), &incoming_tx).await;
                                    }
                                    continue;
                                }

                                // Document (image only)
                                if let Some(doc) = msg.document {
                                    let mime = doc.mime_type.as_deref().unwrap_or("");
                                    if mime.starts_with("image/") {
                                        let name = doc.file_name.as_deref().unwrap_or("photo.jpg");
                                        super::handlers::handle_document_image(&client, &token, owner_chat_id, &doc.file_id, name, msg.caption.as_deref(), &incoming_tx).await;
                                    } else if let Err(e) = tg_send_message(&client, &token, owner_chat_id, "Only images are supported").await {
                                        eprintln!("[TG] send unsupported format: {e}");
                                    }
                                    continue;
                                }

                                // Text
                                if let Some(text) = msg.text {
                                    if text.starts_with('/') {
                                        super::handlers::handle_command(&client, &token, owner_chat_id, &text, &incoming_tx).await;
                                    } else if let Some(kind) = super::handlers::keyboard_button_kind(&text) {
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
                        error_backoff_secs = (error_backoff_secs.max(5) * 2).min(60);
                        eprintln!("[TG] getUpdates error (retry in {error_backoff_secs}s): {e}");
                        tokio::time::sleep(std::time::Duration::from_secs(error_backoff_secs)).await;
                    }
                }
            }

            outgoing = outgoing_rx.recv() => {
                match outgoing {
                    Some(msg) => {
                        if let Err(e) = tg_send_message(&client, &token, msg.chat_id, &msg.text).await {
                            eprintln!("[TG] send outgoing: {e}");
                        }
                    }
                    None => {
                        // Channel closed by stop_telegram_bot → graceful exit
                        eprintln!("[TG] Outgoing channel closed, shutting down");
                        break;
                    }
                }
            }
        }
    }
}
