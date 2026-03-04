use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

use crate::config;
use crate::file_ops::atomic_write;

// ── Types ──

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TelegramConfig {
    pub bot_token: Option<String>,
    pub chat_id: Option<i64>,
    pub groq_api_key: Option<String>,
    pub enabled: bool,
    pub notify_on_complete: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TelegramStatus {
    pub running: bool,
    pub connected: bool,
    pub error: Option<String>,
    pub bot_username: Option<String>,
}

/// Message from Telegram bot → app
#[derive(Debug, Clone, Serialize)]
pub struct TgIncoming {
    pub kind: String,
    pub text: String,
    pub project_path: Option<String>,
    pub project_name: Option<String>,
    pub attachment_path: Option<String>,
}

/// Message from app → Telegram bot
#[derive(Debug, Clone)]
pub struct TgOutgoing {
    pub text: String,
    pub chat_id: i64,
}

// ── Global state ──

#[derive(Clone)]
struct RecentMsg {
    role: String,
    text: String,
}

struct BotState {
    config: TelegramConfig,
    status: TelegramStatus,
    task_handle: Option<tokio::task::JoinHandle<()>>,
    outgoing_tx: Option<mpsc::UnboundedSender<TgOutgoing>>,
    incoming_tx: Option<mpsc::UnboundedSender<TgIncoming>>,
    incoming_rx: Option<mpsc::UnboundedReceiver<TgIncoming>>,
    http_client: Option<reqwest::Client>,
    current_project: Option<String>,
    current_project_path: Option<String>,
    recent_messages: Vec<RecentMsg>,
}

static BOT_STATE: Mutex<Option<BotState>> = Mutex::new(None);

fn with_state<F, R>(f: F) -> R
where
    F: FnOnce(&mut Option<BotState>) -> R,
{
    let mut guard = BOT_STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

// ── Config persistence ──

fn config_path() -> std::path::PathBuf {
    config::config_dir().join("telegram.json")
}

fn load_config_from_disk() -> Result<TelegramConfig, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(TelegramConfig::default());
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read telegram config: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse telegram config: {e}"))
}

fn save_config_to_disk(cfg: &TelegramConfig) -> Result<(), String> {
    let json =
        serde_json::to_string_pretty(cfg).map_err(|e| format!("Failed to serialize: {e}"))?;
    atomic_write(&config_path(), json.as_bytes())
}

// ── Telegram Bot API (raw HTTP) ──

const TG_API: &str = "https://api.telegram.org/bot";

fn sanitize_error(err: &str, token: &str) -> String {
    if token.is_empty() {
        return err.to_string();
    }
    err.replace(token, "<TOKEN>")
}

#[derive(Deserialize)]
struct TgResponse<T> {
    ok: bool,
    result: Option<T>,
    description: Option<String>,
}

#[derive(Deserialize, Clone)]
struct TgUpdate {
    update_id: i64,
    message: Option<TgMessage>,
    callback_query: Option<TgCallbackQuery>,
}

#[derive(Deserialize, Clone)]
struct TgCallbackQuery {
    id: String,
    from: TgCallbackFrom,
    data: Option<String>,
}

#[derive(Deserialize, Clone)]
struct TgCallbackFrom {
    id: i64,
}

#[derive(Deserialize, Clone)]
#[allow(dead_code)]
struct TgMessage {
    message_id: i64,
    chat: TgChat,
    text: Option<String>,
    voice: Option<TgVoice>,
    photo: Option<Vec<TgPhotoSize>>,
    document: Option<TgDocument>,
    caption: Option<String>,
}

#[derive(Deserialize, Clone)]
struct TgPhotoSize {
    file_id: String,
    #[allow(dead_code)]
    width: u32,
    #[allow(dead_code)]
    height: u32,
}

#[derive(Deserialize, Clone)]
struct TgDocument {
    file_id: String,
    file_name: Option<String>,
    mime_type: Option<String>,
}

#[derive(Deserialize, Clone)]
struct TgChat {
    id: i64,
}

#[derive(Deserialize, Clone)]
struct TgVoice {
    file_id: String,
    #[allow(dead_code)]
    duration: Option<u32>,
}

#[derive(Deserialize)]
struct TgFile {
    file_path: Option<String>,
}

#[derive(Deserialize)]
struct TgUser {
    username: Option<String>,
}

pub const TELEGRAM_TAG: &str = "[TG] ";

// ── API helpers ──

async fn tg_get_me(client: &reqwest::Client, token: &str) -> Result<TgUser, String> {
    let url = format!("{TG_API}{token}/getMe");
    let resp: TgResponse<TgUser> = client
        .get(&url)
        .send()
        .await
        .map_err(|e| sanitize_error(&format!("getMe request failed: {e}"), token))?
        .json()
        .await
        .map_err(|e| sanitize_error(&format!("getMe parse failed: {e}"), token))?;
    if !resp.ok {
        return Err(resp.description.unwrap_or_else(|| "getMe failed".into()));
    }
    resp.result.ok_or_else(|| "getMe: no result".into())
}

async fn tg_get_updates(
    client: &reqwest::Client,
    token: &str,
    offset: i64,
) -> Result<Vec<TgUpdate>, String> {
    let url = format!(
        "{TG_API}{token}/getUpdates?offset={offset}&timeout=30&allowed_updates=[\"message\",\"callback_query\"]"
    );
    let resp: TgResponse<Vec<TgUpdate>> = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(35))
        .send()
        .await
        .map_err(|e| sanitize_error(&format!("getUpdates: {e}"), token))?
        .json()
        .await
        .map_err(|e| sanitize_error(&format!("getUpdates parse: {e}"), token))?;
    if !resp.ok {
        return Err(resp
            .description
            .unwrap_or_else(|| "getUpdates failed".into()));
    }
    Ok(resp.result.unwrap_or_default())
}

async fn tg_send_message(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    text: &str,
) -> Result<(), String> {
    let chunks = split_message(text, 4000);
    for chunk in chunks {
        let url = format!("{TG_API}{token}/sendMessage");
        let body = serde_json::json!({
            "chat_id": chat_id,
            "text": chunk,
            "parse_mode": "Markdown",
            "disable_web_page_preview": true,
        });
        let resp = client.post(&url).json(&body).send().await;
        match resp {
            Ok(r) => {
                if !r.status().is_success() {
                    let body_plain = serde_json::json!({
                        "chat_id": chat_id,
                        "text": chunk,
                        "disable_web_page_preview": true,
                    });
                    if let Err(e) = client.post(&url).json(&body_plain).send().await {
                        eprintln!(
                            "[TG] sendMessage fallback error: {}",
                            sanitize_error(&e.to_string(), token)
                        );
                    }
                }
            }
            Err(e) => {
                eprintln!(
                    "[TG] sendMessage error: {}",
                    sanitize_error(&e.to_string(), token)
                );
            }
        }
    }
    Ok(())
}

/// Send a message and return its message_id (for later editing)
async fn tg_send_and_get_id(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    text: &str,
) -> Result<i64, String> {
    let url = format!("{TG_API}{token}/sendMessage");
    let body = serde_json::json!({
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": true,
    });
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| sanitize_error(&format!("sendMessage: {e}"), token))?;

    #[derive(Deserialize)]
    struct Msg {
        message_id: i64,
    }
    let parsed: TgResponse<Msg> = resp
        .json()
        .await
        .map_err(|e| sanitize_error(&format!("sendMessage parse: {e}"), token))?;
    parsed
        .result
        .map(|m| m.message_id)
        .ok_or_else(|| "sendMessage: no result".into())
}

/// Edit an existing message
async fn tg_edit_message(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    message_id: i64,
    text: &str,
) -> Result<(), String> {
    let url = format!("{TG_API}{token}/editMessageText");
    let body = serde_json::json!({
        "chat_id": chat_id,
        "message_id": message_id,
        "text": text,
        "disable_web_page_preview": true,
    });
    let resp = client.post(&url).json(&body).send().await;
    if let Err(e) = resp {
        eprintln!(
            "[TG] editMessage error: {}",
            sanitize_error(&e.to_string(), token)
        );
    }
    Ok(())
}

async fn tg_send_inline_keyboard(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    text: &str,
    buttons: Vec<Vec<serde_json::Value>>,
) -> Result<(), String> {
    let url = format!("{TG_API}{token}/sendMessage");
    let body = serde_json::json!({
        "chat_id": chat_id,
        "text": text,
        "reply_markup": { "inline_keyboard": buttons },
    });
    let _ = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| sanitize_error(&format!("sendInlineKeyboard: {e}"), token))?;
    Ok(())
}

async fn tg_answer_callback(
    client: &reqwest::Client,
    token: &str,
    callback_id: &str,
) -> Result<(), String> {
    let url = format!("{TG_API}{token}/answerCallbackQuery");
    let body = serde_json::json!({ "callback_query_id": callback_id });
    let _ = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| sanitize_error(&format!("answerCallback: {e}"), token))?;
    Ok(())
}

fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.len() <= max_len {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut remaining = text;
    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }
        let mut boundary = max_len;
        while boundary > 0 && !remaining.is_char_boundary(boundary) {
            boundary -= 1;
        }
        let split_at = remaining[..boundary].rfind('\n').unwrap_or(boundary);
        let split_at = if split_at == 0 { boundary } else { split_at };
        chunks.push(remaining[..split_at].to_string());
        remaining = remaining[split_at..].trim_start_matches('\n');
    }
    chunks
}

async fn tg_download_file(
    client: &reqwest::Client,
    token: &str,
    file_id: &str,
) -> Result<(Vec<u8>, String), String> {
    let url = format!("{TG_API}{token}/getFile?file_id={file_id}");
    let resp: TgResponse<TgFile> = client
        .get(&url)
        .send()
        .await
        .map_err(|e| sanitize_error(&format!("getFile: {e}"), token))?
        .json()
        .await
        .map_err(|e| sanitize_error(&format!("getFile parse: {e}"), token))?;
    let file_path = resp
        .result
        .and_then(|f| f.file_path)
        .ok_or("No file_path in getFile response")?;

    let ext = file_path.rsplit('.').next().unwrap_or("bin").to_string();
    let download_url = format!("https://api.telegram.org/file/bot{token}/{file_path}");
    let bytes = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| sanitize_error(&format!("download file: {e}"), token))?
        .bytes()
        .await
        .map_err(|e| sanitize_error(&format!("read file bytes: {e}"), token))?;
    Ok((bytes.to_vec(), ext))
}

async fn tg_set_my_commands(client: &reqwest::Client, token: &str) -> Result<(), String> {
    let url = format!("{TG_API}{token}/setMyCommands");
    let commands = serde_json::json!({
        "commands": [
            {"command": "menu", "description": "Project list"},
            {"command": "chats", "description": "Chat history"},
            {"command": "newchat", "description": "New chat"},
            {"command": "history", "description": "Recent messages"},
            {"command": "status", "description": "Bot status"},
            {"command": "help", "description": "Help"}
        ]
    });
    client
        .post(&url)
        .json(&commands)
        .send()
        .await
        .map_err(|e| sanitize_error(&format!("setMyCommands: {e}"), token))?;
    Ok(())
}

async fn groq_transcribe(
    client: &reqwest::Client,
    api_key: &str,
    audio_bytes: Vec<u8>,
) -> Result<String, String> {
    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name("voice.ogg")
        .mime_str("audio/ogg")
        .map_err(|e| format!("multipart: {e}"))?;

    let form = reqwest::multipart::Form::new()
        .text("model", "whisper-large-v3")
        .text("language", "ru")
        .part("file", part);

    let resp = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {api_key}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Groq request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Groq API error {status}: {body}"));
    }

    #[derive(Deserialize)]
    struct GroqResponse {
        text: String,
    }

    let result: GroqResponse = resp.json().await.map_err(|e| format!("Groq parse: {e}"))?;
    Ok(result.text)
}

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

    let _ = tg_set_my_commands(&client, &token).await;

    loop {
        tokio::select! {
            updates_result = tg_get_updates(&client, &token, update_offset) => {
                match updates_result {
                    Ok(updates) => {
                        for update in updates {
                            update_offset = update.update_id + 1;

                            if let Some(cb) = update.callback_query {
                                if cb.from.id == owner_chat_id {
                                    let _ = tg_answer_callback(&client, &token, &cb.id).await;
                                    if let Some(data) = cb.data {
                                        handle_callback(&client, &token, owner_chat_id, &data, &incoming_tx).await;
                                    }
                                }
                                continue;
                            }

                            if let Some(msg) = update.message {
                                if msg.chat.id != owner_chat_id {
                                    let _ = tg_send_message(&client, &token, msg.chat.id, "Access denied").await;
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
                                    } else {
                                        let _ = tg_send_message(&client, &token, owner_chat_id, "Only images are supported").await;
                                    }
                                    continue;
                                }

                                // Text
                                if let Some(text) = msg.text {
                                    if text.starts_with('/') {
                                        handle_command(&client, &token, owner_chat_id, &text, &incoming_tx).await;
                                    } else {
                                        let _ = incoming_tx.send(TgIncoming {
                                            kind: "text".into(),
                                            text: format!("{text}{TELEGRAM_TAG}"),
                                            project_path: None,
                                            project_name: None,
                                            attachment_path: None,
                                        });
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
                let _ = tg_send_message(&client, &token, outgoing.chat_id, &outgoing.text).await;
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
        let _ = incoming_tx.send(TgIncoming {
            kind: "new_chat".into(),
            text: String::new(),
            project_path: None,
            project_name: None,
            attachment_path: None,
        });
        let _ = tg_send_message(client, token, chat_id, "New chat").await;
    } else if let Some(session_id) = data.strip_prefix("chat:") {
        let _ = incoming_tx.send(TgIncoming {
            kind: "load_chat".into(),
            text: session_id.to_string(),
            project_path: None,
            project_name: None,
            attachment_path: None,
        });
        let _ = tg_send_message(client, token, chat_id, "Loading chat...").await;
    } else if let Some(path) = data.strip_prefix("project:") {
        let name = path.rsplit('/').next().unwrap_or(path);
        let _ = incoming_tx.send(TgIncoming {
            kind: "switch_project".into(),
            text: String::new(),
            project_path: Some(path.to_string()),
            project_name: Some(name.to_string()),
            attachment_path: None,
        });
        let _ = tg_send_message(client, token, chat_id, &format!("Switched to: {name}")).await;
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
        let _ =
            tg_send_message(client, token, chat_id, "Groq API key not configured for voice")
                .await;
        return;
    };

    let _ = tg_send_message(client, token, chat_id, "Transcribing voice...").await;
    match tg_download_file(client, token, file_id).await {
        Ok((audio, _)) => match groq_transcribe(client, key, audio).await {
            Ok(text) => {
                if text.trim().is_empty() {
                    let _ =
                        tg_send_message(client, token, chat_id, "Could not recognize speech")
                            .await;
                } else {
                    let _ = incoming_tx.send(TgIncoming {
                        kind: "text".into(),
                        text: format!("{text}{TELEGRAM_TAG}"),
                        project_path: None,
                        project_name: None,
                        attachment_path: None,
                    });
                }
            }
            Err(e) => {
                let _ =
                    tg_send_message(client, token, chat_id, &format!("Transcription error: {e}"))
                        .await;
            }
        },
        Err(e) => {
            let _ = tg_send_message(client, token, chat_id, &format!("Voice download error: {e}"))
                .await;
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
    std::fs::write(&tmp_path, bytes)
        .map_err(|e| format!("Failed to write tmp file: {e}"))?;
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
                    let _ = incoming_tx.send(TgIncoming {
                        kind: "text".into(),
                        text,
                        project_path: None,
                        project_name: None,
                        attachment_path: Some(path),
                    });
                }
                Err(e) => {
                    let _ = tg_send_message(client, token, chat_id, &format!("Save error: {e}"))
                        .await;
                }
            }
        }
        Err(e) => {
            let _ =
                tg_send_message(client, token, chat_id, &format!("Photo download error: {e}"))
                    .await;
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
                    let _ = incoming_tx.send(TgIncoming {
                        kind: "text".into(),
                        text,
                        project_path: None,
                        project_name: None,
                        attachment_path: Some(path),
                    });
                }
                Err(e) => {
                    let _ = tg_send_message(client, token, chat_id, &format!("Save error: {e}"))
                        .await;
                }
            }
        }
        Err(e) => {
            let _ =
                tg_send_message(client, token, chat_id, &format!("File download error: {e}"))
                    .await;
        }
    }
}

// ── Bot commands ──

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
            let _ = tg_send_message(
                client,
                token,
                chat_id,
                "Connected to Aither Flow\nSend messages — they go to the agent.",
            )
            .await;
        }
        "/status" => {
            let project = with_state(|s| {
                s.as_ref().and_then(|st| st.current_project.clone())
            });
            let msg = match project {
                Some(name) => format!("Bot is running\nProject: {name}"),
                None => "Bot is running\nNo project selected".to_string(),
            };
            let _ = tg_send_message(client, token, chat_id, &msg).await;
        }
        "/projects" | "/menu" => {
            send_projects_menu(client, token, chat_id).await;
        }
        "/chats" => {
            send_chats_menu(client, token, chat_id).await;
        }
        "/newchat" => {
            let _ = incoming_tx.send(TgIncoming {
                kind: "new_chat".into(),
                text: String::new(),
                project_path: None,
                project_name: None,
                attachment_path: None,
            });
            let _ = tg_send_message(client, token, chat_id, "New chat").await;
        }
        "/history" => {
            let msgs = with_state(|s| {
                s.as_ref()
                    .map(|st| st.recent_messages.clone())
                    .unwrap_or_default()
            });
            if msgs.is_empty() {
                let _ =
                    tg_send_message(client, token, chat_id, "No messages in current chat").await;
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
                let _ = tg_send_message(client, token, chat_id, out.trim()).await;
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
            let _ = tg_send_message(client, token, chat_id, help).await;
        }
        _ => {
            let _ =
                tg_send_message(client, token, chat_id, "Unknown command. /help for reference.")
                    .await;
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

    let _ = tg_send_inline_keyboard(client, token, chat_id, "Select project:", buttons).await;
}

async fn send_chats_menu(client: &reqwest::Client, token: &str, chat_id: i64) {
    let project_path = with_state(|s| {
        s.as_ref().and_then(|st| st.current_project_path.clone())
    });

    let Some(project_path) = project_path else {
        let _ = tg_send_message(client, token, chat_id, "No project selected").await;
        return;
    };

    let chats = match crate::chats::list_chats(project_path).await {
        Ok(c) => c,
        Err(e) => {
            let _ = tg_send_message(client, token, chat_id, &format!("Error: {e}")).await;
            return;
        }
    };

    if chats.is_empty() {
        let _ = tg_send_message(client, token, chat_id, "No saved chats").await;
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
    let _ =
        tg_send_inline_keyboard(client, token, chat_id, &format!("Chats ({project_name})"), buttons)
            .await;
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
