use serde::{Deserialize, Serialize};

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

#[derive(Clone)]
pub(crate) struct RecentMsg {
    pub role: String,
    pub text: String,
}

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
