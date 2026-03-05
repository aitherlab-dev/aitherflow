use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

use crate::config;
use crate::file_ops::atomic_write;

use super::api::*;
use super::state::with_state;
use super::types::*;

pub(crate) async fn bot_loop(
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
                                        eprintln!("[TG] failed to send access denied: {e}");
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
                                        eprintln!("[TG] failed to send unsupported format msg: {e}");
                                    }
                                    continue;
                                }

                                // Text
                                if let Some(text) = msg.text {
                                    if text.starts_with('/') {
                                        handle_command(&client, &token, owner_chat_id, &text, &incoming_tx).await;
                                    } else if let Err(e) = incoming_tx.send(TgIncoming {
                                        kind: "text".into(),
                                        text: format!("{text}{TELEGRAM_TAG}"),
                                        project_path: None,
                                        project_name: None,
                                        attachment_path: None,
                                    }) {
                                        eprintln!("[TG] failed to send incoming text: {e}");
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
                    eprintln!("[TG] failed to send outgoing message: {e}");
                }
            }
        }
    }
}

async fn handle_callback(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    data: &str,
    incoming_tx: &mpsc::UnboundedSender<TgIncoming>,
) {
    if data == "newchat" {
        if let Err(e) = incoming_tx.send(TgIncoming {
            kind: "new_chat".into(),
            text: String::new(),
            project_path: None,
            project_name: None,
            attachment_path: None,
        }) {
            eprintln!("[TG] failed to send new_chat callback: {e}");
        }
        if let Err(e) = tg_send_message(client, token, chat_id, "New chat").await {
            eprintln!("[TG] failed to confirm new_chat: {e}");
        }
    } else if let Some(session_id) = data.strip_prefix("chat:") {
        if let Err(e) = incoming_tx.send(TgIncoming {
            kind: "load_chat".into(),
            text: session_id.to_string(),
            project_path: None,
            project_name: None,
            attachment_path: None,
        }) {
            eprintln!("[TG] failed to send load_chat callback: {e}");
        }
        if let Err(e) = tg_send_message(client, token, chat_id, "Loading chat...").await {
            eprintln!("[TG] failed to confirm load_chat: {e}");
        }
    } else if let Some(path) = data.strip_prefix("project:") {
        let name = path.rsplit('/').next().unwrap_or(path);
        if let Err(e) = incoming_tx.send(TgIncoming {
            kind: "switch_project".into(),
            text: String::new(),
            project_path: Some(path.to_string()),
            project_name: Some(name.to_string()),
            attachment_path: None,
        }) {
            eprintln!("[TG] failed to send switch_project callback: {e}");
        }
        if let Err(e) = tg_send_message(client, token, chat_id, &format!("Switched to: {name}")).await {
            eprintln!("[TG] failed to confirm switch_project: {e}");
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
        if let Err(e) =
            tg_send_message(client, token, chat_id, "Groq API key not configured for voice")
                .await
        {
            eprintln!("[TG] failed to send groq key missing msg: {e}");
        }
        return;
    };

    if let Err(e) = tg_send_message(client, token, chat_id, "Transcribing voice...").await {
        eprintln!("[TG] failed to send transcribing status: {e}");
    }
    match tg_download_file(client, token, file_id).await {
        Ok((audio, _)) => match groq_transcribe(client, key, audio).await {
            Ok(text) => {
                if text.trim().is_empty() {
                    if let Err(e) =
                        tg_send_message(client, token, chat_id, "Could not recognize speech")
                            .await
                    {
                        eprintln!("[TG] failed to send speech not recognized msg: {e}");
                    }
                } else if let Err(e) = incoming_tx.send(TgIncoming {
                    kind: "text".into(),
                    text: format!("{text}{TELEGRAM_TAG}"),
                    project_path: None,
                    project_name: None,
                    attachment_path: None,
                }) {
                    eprintln!("[TG] failed to send transcribed voice text: {e}");
                }
            }
            Err(e) => {
                if let Err(send_err) =
                    tg_send_message(client, token, chat_id, &format!("Transcription error: {e}"))
                        .await
                {
                    eprintln!("[TG] failed to send transcription error msg: {send_err}");
                }
            }
        },
        Err(e) => {
            if let Err(send_err) = tg_send_message(client, token, chat_id, &format!("Voice download error: {e}"))
                .await
            {
                eprintln!("[TG] failed to send voice download error msg: {send_err}");
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
                        Some(c) if !c.is_empty() => format!("{c}{TELEGRAM_TAG}"),
                        _ => format!("[Photo]{TELEGRAM_TAG}"),
                    };
                    if let Err(e) = incoming_tx.send(TgIncoming {
                        kind: "text".into(),
                        text,
                        project_path: None,
                        project_name: None,
                        attachment_path: Some(path),
                    }) {
                        eprintln!("[TG] failed to send photo incoming: {e}");
                    }
                }
                Err(e) => {
                    if let Err(send_err) = tg_send_message(client, token, chat_id, &format!("Save error: {e}"))
                        .await
                    {
                        eprintln!("[TG] failed to send save error msg: {send_err}");
                    }
                }
            }
        }
        Err(e) => {
            if let Err(send_err) =
                tg_send_message(client, token, chat_id, &format!("Photo download error: {e}"))
                    .await
            {
                eprintln!("[TG] failed to send photo download error msg: {send_err}");
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
                        Some(c) if !c.is_empty() => format!("{c}{TELEGRAM_TAG}"),
                        _ => format!("[Photo]{TELEGRAM_TAG}"),
                    };
                    if let Err(e) = incoming_tx.send(TgIncoming {
                        kind: "text".into(),
                        text,
                        project_path: None,
                        project_name: None,
                        attachment_path: Some(path),
                    }) {
                        eprintln!("[TG] failed to send document image incoming: {e}");
                    }
                }
                Err(e) => {
                    if let Err(send_err) = tg_send_message(client, token, chat_id, &format!("Save error: {e}"))
                        .await
                    {
                        eprintln!("[TG] failed to send save error msg: {send_err}");
                    }
                }
            }
        }
        Err(e) => {
            if let Err(send_err) =
                tg_send_message(client, token, chat_id, &format!("File download error: {e}"))
                    .await
            {
                eprintln!("[TG] failed to send file download error msg: {send_err}");
            }
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
    match cmd {
        "/start" | "/connect" => {
            if let Err(e) = tg_send_message(
                client,
                token,
                chat_id,
                "Connected to Aither Flow\nSend messages — they go to the agent.",
            )
            .await
            {
                eprintln!("[TG] failed to send connect msg: {e}");
            }
        }
        "/status" => {
            let project = with_state(|s| {
                s.as_ref().and_then(|st| st.current_project.clone())
            });
            let msg = match project {
                Some(name) => format!("Bot is running\nProject: {name}"),
                None => "Bot is running\nNo project selected".to_string(),
            };
            if let Err(e) = tg_send_message(client, token, chat_id, &msg).await {
                eprintln!("[TG] failed to send status msg: {e}");
            }
        }
        "/projects" | "/menu" => {
            send_projects_menu(client, token, chat_id).await;
        }
        "/chats" => {
            send_chats_menu(client, token, chat_id).await;
        }
        "/newchat" => {
            if let Err(e) = incoming_tx.send(TgIncoming {
                kind: "new_chat".into(),
                text: String::new(),
                project_path: None,
                project_name: None,
                attachment_path: None,
            }) {
                eprintln!("[TG] failed to send new_chat command: {e}");
            }
            if let Err(e) = tg_send_message(client, token, chat_id, "New chat").await {
                eprintln!("[TG] failed to confirm new_chat command: {e}");
            }
        }
        "/history" => {
            let msgs = with_state(|s| {
                s.as_ref()
                    .map(|st| st.recent_messages.clone())
                    .unwrap_or_default()
            });
            if msgs.is_empty() {
                if let Err(e) =
                    tg_send_message(client, token, chat_id, "No messages in current chat").await
                {
                    eprintln!("[TG] failed to send empty history msg: {e}");
                }
            } else {
                let mut out = String::from("Recent messages:\n\n");
                for m in &msgs {
                    let icon = if m.role == "user" { ">" } else { "<" };
                    let preview = if m.text.len() > 300 {
                        let end = m
                            .text
                            .char_indices()
                            .nth(300)
                            .map(|(i, _)| i)
                            .unwrap_or(m.text.len());
                        format!("{}...", &m.text[..end])
                    } else {
                        m.text.clone()
                    };
                    out.push_str(&format!("{icon} {preview}\n\n"));
                }
                if let Err(e) = tg_send_message(client, token, chat_id, out.trim()).await {
                    eprintln!("[TG] failed to send history: {e}");
                }
            }
        }
        "/help" => {
            let help = "Commands:\n\
                /projects — select project\n\
                /chats — chat history\n\
                /newchat — new chat\n\
                /history — recent messages\n\
                /status — bot status\n\
                /help — this help\n\n\
                Just type text — it goes to the agent.\n\
                Voice messages — via Groq Whisper.";
            if let Err(e) = tg_send_message(client, token, chat_id, help).await {
                eprintln!("[TG] failed to send help: {e}");
            }
        }
        _ => {
            if let Err(e) =
                tg_send_message(client, token, chat_id, "Unknown command. /help for reference.")
                    .await
            {
                eprintln!("[TG] failed to send unknown command msg: {e}");
            }
        }
    }
}

async fn send_projects_menu(client: &reqwest::Client, token: &str, chat_id: i64) {
    let projects = match crate::projects::load_projects().await {
        Ok(cfg) => cfg.projects,
        Err(_) => Vec::new(),
    };

    let workspace_path = config::workspace_dir().to_string_lossy().to_string();

    let mut buttons: Vec<Vec<serde_json::Value>> = Vec::new();
    buttons.push(vec![serde_json::json!({
        "text": "Workspace",
        "callback_data": format!("project:{workspace_path}"),
    })]);

    for p in &projects {
        buttons.push(vec![serde_json::json!({
            "text": p.name,
            "callback_data": format!("project:{}", p.path),
        })]);
    }

    buttons.push(vec![serde_json::json!({
        "text": "New chat",
        "callback_data": "newchat",
    })]);

    if let Err(e) = tg_send_inline_keyboard(client, token, chat_id, "Select project:", buttons).await {
        eprintln!("[TG] failed to send projects menu: {e}");
    }
}

async fn send_chats_menu(client: &reqwest::Client, token: &str, chat_id: i64) {
    let project_path = with_state(|s| {
        s.as_ref().and_then(|st| st.current_project_path.clone())
    });

    let Some(project_path) = project_path else {
        if let Err(e) = tg_send_message(client, token, chat_id, "No project selected").await {
            eprintln!("[TG] failed to send no project msg: {e}");
        }
        return;
    };

    let chats = match crate::chats::list_chats(project_path).await {
        Ok(c) => c,
        Err(e) => {
            if let Err(send_err) = tg_send_message(client, token, chat_id, &format!("Error: {e}")).await {
                eprintln!("[TG] failed to send chats list error: {send_err}");
            }
            return;
        }
    };

    if chats.is_empty() {
        if let Err(e) = tg_send_message(client, token, chat_id, "No saved chats").await {
            eprintln!("[TG] failed to send no saved chats msg: {e}");
        }
        return;
    }

    let display: Vec<_> = chats.into_iter().take(10).collect();
    let mut buttons: Vec<Vec<serde_json::Value>> = Vec::new();
    for c in &display {
        let pin = if c.pinned { "[pin] " } else { "" };
        let title = if c.title.len() > 40 {
            let end = c
                .title
                .char_indices()
                .nth(40)
                .map(|(i, _)| i)
                .unwrap_or(c.title.len());
            format!("{}...", &c.title[..end])
        } else {
            c.title.clone()
        };
        if let Some(ref sid) = c.session_id {
            buttons.push(vec![serde_json::json!({
                "text": format!("{pin}{title}"),
                "callback_data": format!("chat:{sid}"),
            })]);
        }
    }

    let project_name = with_state(|s| {
        s.as_ref()
            .and_then(|st| st.current_project.clone())
            .unwrap_or_else(|| "?".into())
    });
    if let Err(e) =
        tg_send_inline_keyboard(client, token, chat_id, &format!("Chats ({project_name})"), buttons)
            .await
    {
        eprintln!("[TG] failed to send chats menu: {e}");
    }
}
