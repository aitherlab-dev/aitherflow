use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use crate::config;

/// Stored tool activity (mirrors frontend ToolActivity)
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivityStored {
    pub tool_use_id: String,
    pub tool_name: String,
    pub tool_input: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

/// Stored chat message (mirrors frontend ChatMessage, minus isStreaming)
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageStored {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolActivityStored>,
}

/// Full chat file on disk
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatFile {
    pub id: String,
    pub project_path: String,
    pub title: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub messages: Vec<ChatMessageStored>,
}

/// Metadata for sidebar listing (no messages — keep it light)
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMeta {
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub session_id: Option<String>,
}

/// Directory where chat JSON files live: ~/.config/aither-flow/chats/
fn chats_dir() -> PathBuf {
    config::config_dir().join("chats")
}

/// Path for a single chat file
fn chat_path(chat_id: &str) -> PathBuf {
    chats_dir().join(format!("{chat_id}.json"))
}

/// Atomic write helper: write to temp file, then rename
fn atomic_write(path: &PathBuf, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create dir {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&tmp)
        .map_err(|e| format!("Failed to create temp file: {e}"))?;
    file.write_all(data)
        .map_err(|e| format!("Failed to write temp file: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("Failed to sync temp file: {e}"))?;
    fs::rename(&tmp, path)
        .map_err(|e| format!("Failed to rename temp file: {e}"))?;
    Ok(())
}

/// Read a single chat file
fn read_chat_file(chat_id: &str) -> Option<ChatFile> {
    let path = chat_path(chat_id);
    let data = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

/// List chats for a project (metadata only, sorted newest first)
#[tauri::command]
pub async fn list_chats(project_path: String) -> Result<Vec<ChatMeta>, String> {
    tokio::task::spawn_blocking(move || {
        let dir = chats_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let entries = fs::read_dir(&dir)
            .map_err(|e| format!("Failed to read chats dir: {e}"))?;

        let mut chats: Vec<ChatMeta> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(data) = fs::read_to_string(&path) {
                if let Ok(chat) = serde_json::from_str::<ChatFile>(&data) {
                    if chat.project_path == project_path {
                        chats.push(ChatMeta {
                            id: chat.id,
                            title: chat.title,
                            created_at: chat.created_at,
                            session_id: chat.session_id,
                        });
                    }
                }
            }
        }

        // Newest first
        chats.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(chats)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Create a new chat with a title (from first message)
#[tauri::command]
pub async fn create_chat(project_path: String, title: String) -> Result<ChatFile, String> {
    tokio::task::spawn_blocking(move || {
        let id = uuid::Uuid::new_v4().to_string();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let chat = ChatFile {
            id: id.clone(),
            project_path,
            title,
            created_at: now,
            session_id: None,
            messages: Vec::new(),
        };

        let data = serde_json::to_string_pretty(&chat)
            .map_err(|e| format!("Failed to serialize chat: {e}"))?;
        atomic_write(&chat_path(&id), data.as_bytes())?;

        Ok(chat)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Load a full chat (with messages) for display
#[tauri::command]
pub async fn load_chat(chat_id: String) -> Result<ChatFile, String> {
    tokio::task::spawn_blocking(move || {
        read_chat_file(&chat_id).ok_or_else(|| format!("Chat {chat_id} not found"))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Save messages to an existing chat
#[tauri::command]
pub async fn save_chat_messages(
    chat_id: String,
    messages: Vec<ChatMessageStored>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut chat = read_chat_file(&chat_id)
            .ok_or_else(|| format!("Chat {chat_id} not found"))?;
        chat.messages = messages;
        let data = serde_json::to_string_pretty(&chat)
            .map_err(|e| format!("Failed to serialize chat: {e}"))?;
        atomic_write(&chat_path(&chat_id), data.as_bytes())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Save session_id from CLI to chat
#[tauri::command]
pub async fn update_chat_session(chat_id: String, session_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut chat = read_chat_file(&chat_id)
            .ok_or_else(|| format!("Chat {chat_id} not found"))?;
        chat.session_id = Some(session_id);
        let data = serde_json::to_string_pretty(&chat)
            .map_err(|e| format!("Failed to serialize chat: {e}"))?;
        atomic_write(&chat_path(&chat_id), data.as_bytes())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Delete a chat file
#[tauri::command]
pub async fn delete_chat(chat_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = chat_path(&chat_id);
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete chat file: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
