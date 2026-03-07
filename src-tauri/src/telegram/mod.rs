pub mod api;
pub mod commands;

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::config;
use crate::file_ops::atomic_write;
use crate::secrets;

// ── Public types (shared with frontend via serde) ──

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

/// Message from Telegram bot -> app (polled by frontend)
#[derive(Debug, Clone, Serialize)]
pub struct TgIncoming {
    pub kind: String,
    pub text: String,
    pub project_path: Option<String>,
    pub project_name: Option<String>,
    pub attachment_path: Option<String>,
}

/// Message from app -> Telegram bot
#[derive(Debug, Clone)]
pub struct TgOutgoing {
    pub text: String,
    pub chat_id: i64,
}

// ── Telegram API types (internal) ──

#[derive(Deserialize)]
pub(crate) struct TgResponse<T> {
    pub ok: bool,
    pub result: Option<T>,
    pub description: Option<String>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct TgUpdate {
    pub update_id: i64,
    pub message: Option<TgMessage>,
    pub callback_query: Option<TgCallbackQuery>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct TgCallbackQuery {
    pub id: String,
    pub from: TgCallbackFrom,
    pub data: Option<String>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct TgCallbackFrom {
    pub id: i64,
}

#[derive(Deserialize, Clone)]
#[allow(dead_code)]
pub(crate) struct TgMessage {
    pub message_id: i64,
    pub chat: TgChat,
    pub text: Option<String>,
    pub voice: Option<TgVoice>,
    pub photo: Option<Vec<TgPhotoSize>>,
    pub document: Option<TgDocument>,
    pub caption: Option<String>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct TgPhotoSize {
    pub file_id: String,
    #[allow(dead_code)]
    pub width: u32,
    #[allow(dead_code)]
    pub height: u32,
}

#[derive(Deserialize, Clone)]
pub(crate) struct TgDocument {
    pub file_id: String,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct TgChat {
    pub id: i64,
}

#[derive(Deserialize, Clone)]
pub(crate) struct TgVoice {
    pub file_id: String,
    #[allow(dead_code)]
    pub duration: Option<u32>,
}

#[derive(Deserialize)]
pub(crate) struct TgFile {
    pub file_path: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct TgUser {
    pub username: Option<String>,
}

// ── Bot state ──

pub(crate) struct BotState {
    pub config: TelegramConfig,
    pub status: TelegramStatus,
    pub task_handle: Option<tokio::task::JoinHandle<()>>,
    pub outgoing_tx: Option<mpsc::UnboundedSender<TgOutgoing>>,
    pub incoming_tx: Option<mpsc::UnboundedSender<TgIncoming>>,
    pub incoming_rx: Option<mpsc::UnboundedReceiver<TgIncoming>>,
    pub http_client: Option<reqwest::Client>,
    /// Message ID for edit-based streaming; 0 = no active stream
    pub stream_message_id: i64,
}

static BOT_STATE: Mutex<Option<BotState>> = Mutex::new(None);

pub(crate) fn with_state<F, R>(f: F) -> R
where
    F: FnOnce(&mut Option<BotState>) -> R,
{
    let mut guard = BOT_STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

// ── Config persistence ──

pub fn is_enabled() -> bool {
    load_config_from_disk().map(|c| c.enabled).unwrap_or(false)
}

pub(crate) fn config_path() -> std::path::PathBuf {
    config::config_dir().join("telegram.json")
}

const KEY_TG_BOT_TOKEN: &str = "telegram-bot-token";
const KEY_TG_GROQ: &str = "telegram-groq-api-key";

pub(crate) fn load_config_from_disk() -> Result<TelegramConfig, String> {
    let path = config_path();
    let mut cfg = if path.exists() {
        let data = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read telegram config: {e}"))?;
        serde_json::from_str::<TelegramConfig>(&data)
            .map_err(|e| format!("Failed to parse telegram config: {e}"))?
    } else {
        return Ok(TelegramConfig::default());
    };

    let mut migrated = false;

    // bot_token: prefer keyring, migrate from JSON
    if let Some(kr) = secrets::get_secret(KEY_TG_BOT_TOKEN) {
        cfg.bot_token = Some(kr);
    } else if cfg.bot_token.as_ref().is_some_and(|t| !t.is_empty()) {
        let _ = secrets::set_secret(KEY_TG_BOT_TOKEN, cfg.bot_token.as_ref().unwrap());
        migrated = true;
    }

    // groq_api_key: same
    if let Some(kr) = secrets::get_secret(KEY_TG_GROQ) {
        cfg.groq_api_key = Some(kr);
    } else if cfg.groq_api_key.as_ref().is_some_and(|k| !k.is_empty()) {
        let _ = secrets::set_secret(KEY_TG_GROQ, cfg.groq_api_key.as_ref().unwrap());
        migrated = true;
    }

    if migrated {
        let mut disk = cfg.clone();
        disk.bot_token = None;
        disk.groq_api_key = None;
        let json = serde_json::to_string_pretty(&disk)
            .map_err(|e| format!("Failed to serialize: {e}"))?;
        let _ = atomic_write(&config_path(), json.as_bytes());
    }

    Ok(cfg)
}

pub(crate) fn save_config_to_disk(cfg: &TelegramConfig) -> Result<(), String> {
    // Store secrets in keyring
    if let Some(token) = &cfg.bot_token {
        let _ = secrets::set_secret(KEY_TG_BOT_TOKEN, token);
    } else {
        let _ = secrets::delete_secret(KEY_TG_BOT_TOKEN);
    }
    if let Some(key) = &cfg.groq_api_key {
        let _ = secrets::set_secret(KEY_TG_GROQ, key);
    } else {
        let _ = secrets::delete_secret(KEY_TG_GROQ);
    }

    // Write JSON without secrets
    let mut disk = cfg.clone();
    disk.bot_token = None;
    disk.groq_api_key = None;
    let json =
        serde_json::to_string_pretty(&disk).map_err(|e| format!("Failed to serialize: {e}"))?;
    atomic_write(&config_path(), json.as_bytes())
}
