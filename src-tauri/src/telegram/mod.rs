pub mod api;
mod bot;
pub mod commands;
mod handlers;

use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::config;
use crate::file_ops::atomic_write;
use crate::secrets;

/// Shared HTTP client — reuses connection pool and TLS state.
pub(crate) static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

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
    pub message: Option<TgCallbackMessage>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct TgCallbackMessage {
    pub message_id: i64,
}

#[derive(Deserialize, Clone)]
pub(crate) struct TgCallbackFrom {
    pub id: i64,
}

#[derive(Deserialize, Clone)]
pub(crate) struct TgMessage {
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
    /// Indexed callback registry: index → payload string.
    /// Used for inline keyboard callbacks where data might exceed 64 bytes.
    /// Populated when sending inline keyboards, consumed when handling callbacks.
    pub callback_registry: Vec<String>,
}

static BOT_STATE: Mutex<Option<BotState>> = Mutex::new(None);

/// Access bot state under a short-lived lock.
///
/// # Contract
/// The closure MUST be fast (no I/O, no network, no blocking waits).
/// All heavy operations must happen outside `with_state`.
///
/// # Poisoned mutex
/// If a previous holder panicked, the lock is recovered via `into_inner`
/// and a warning is logged. This prevents cascading failures but the
/// state may be inconsistent — callers should handle this gracefully.
pub(crate) fn with_state<F, R>(f: F) -> R
where
    F: FnOnce(&mut Option<BotState>) -> R,
{
    let mut guard = BOT_STATE.lock().unwrap_or_else(|e| {
        eprintln!("[TG] WARNING: BOT_STATE mutex was poisoned, recovering");
        e.into_inner()
    });
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
    } else if let Some(token) = cfg.bot_token.as_deref().filter(|t| !t.is_empty()) {
        if let Err(e) = secrets::set_secret(KEY_TG_BOT_TOKEN, token) {
            eprintln!("[TG] Failed to migrate bot token to keyring: {e}");
        }
        migrated = true;
    }

    // groq_api_key: same
    if let Some(kr) = secrets::get_secret(KEY_TG_GROQ) {
        cfg.groq_api_key = Some(kr);
    } else if let Some(key) = cfg.groq_api_key.as_deref().filter(|k| !k.is_empty()) {
        if let Err(e) = secrets::set_secret(KEY_TG_GROQ, key) {
            eprintln!("[TG] Failed to migrate groq key to keyring: {e}");
        }
        migrated = true;
    }

    if migrated {
        let mut disk = cfg.clone();
        disk.bot_token = None;
        disk.groq_api_key = None;
        let json = serde_json::to_string_pretty(&disk)
            .map_err(|e| format!("Failed to serialize: {e}"))?;
        if let Err(e) = atomic_write(&config_path(), json.as_bytes()) {
            eprintln!("[TG] Failed to write migrated config: {e}");
        }
    }

    Ok(cfg)
}

pub(crate) fn save_config_to_disk(cfg: &TelegramConfig) -> Result<(), String> {
    // Store secrets in keyring
    if let Some(token) = &cfg.bot_token {
        if let Err(e) = secrets::set_secret(KEY_TG_BOT_TOKEN, token) {
            eprintln!("[TG] Failed to store bot token: {e}");
        }
    } else if let Err(e) = secrets::delete_secret(KEY_TG_BOT_TOKEN) {
        eprintln!("[TG] Failed to delete bot token: {e}");
    }
    if let Some(key) = &cfg.groq_api_key {
        if let Err(e) = secrets::set_secret(KEY_TG_GROQ, key) {
            eprintln!("[TG] Failed to store groq key: {e}");
        }
    } else if let Err(e) = secrets::delete_secret(KEY_TG_GROQ) {
        eprintln!("[TG] Failed to delete groq key: {e}");
    }

    // Write JSON without secrets
    let mut disk = cfg.clone();
    disk.bot_token = None;
    disk.groq_api_key = None;
    let json =
        serde_json::to_string_pretty(&disk).map_err(|e| format!("Failed to serialize: {e}"))?;
    atomic_write(&config_path(), json.as_bytes())
}
