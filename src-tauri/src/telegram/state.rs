use std::sync::Mutex;
use tokio::sync::mpsc;

use crate::config;
use crate::file_ops::atomic_write;

use super::types::*;

pub(crate) struct BotState {
    pub config: TelegramConfig,
    pub status: TelegramStatus,
    pub task_handle: Option<tokio::task::JoinHandle<()>>,
    pub outgoing_tx: Option<mpsc::UnboundedSender<TgOutgoing>>,
    pub incoming_tx: Option<mpsc::UnboundedSender<TgIncoming>>,
    pub incoming_rx: Option<mpsc::UnboundedReceiver<TgIncoming>>,
    pub http_client: Option<reqwest::Client>,
    pub current_project: Option<String>,
    pub current_project_path: Option<String>,
    pub recent_messages: Vec<RecentMsg>,
}

static BOT_STATE: Mutex<Option<BotState>> = Mutex::new(None);

pub(crate) fn with_state<F, R>(f: F) -> R
where
    F: FnOnce(&mut Option<BotState>) -> R,
{
    let mut guard = BOT_STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

/// Check if Telegram bot is enabled in config (for auto-start on launch).
pub fn is_enabled() -> bool {
    load_config_from_disk().map(|c| c.enabled).unwrap_or(false)
}

pub(crate) fn config_path() -> std::path::PathBuf {
    config::config_dir().join("telegram.json")
}

pub(crate) fn load_config_from_disk() -> Result<TelegramConfig, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(TelegramConfig::default());
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read telegram config: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse telegram config: {e}"))
}

pub(crate) fn save_config_to_disk(cfg: &TelegramConfig) -> Result<(), String> {
    let json =
        serde_json::to_string_pretty(cfg).map_err(|e| format!("Failed to serialize: {e}"))?;
    atomic_write(&config_path(), json.as_bytes())
}
