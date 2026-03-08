use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};

use crate::config;
use crate::file_ops::atomic_write;

/// Per-chat-id lock to prevent concurrent read-modify-write races.
static CHAT_LOCKS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Cached chat metadata to avoid re-reading the whole file in save_chat_messages.
static META_CACHE: LazyLock<Mutex<HashMap<String, ChatFileMeta>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Lightweight metadata (everything except messages).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatFileMeta {
    id: String,
    project_path: String,
    agent_id: Option<String>,
    title: String,
    created_at: u64,
    session_id: Option<String>,
    custom_title: Option<String>,
    pinned: Option<bool>,
}

impl ChatFileMeta {
    fn from_chat(chat: &ChatFile) -> Self {
        Self {
            id: chat.id.clone(),
            project_path: chat.project_path.clone(),
            agent_id: chat.agent_id.clone(),
            title: chat.title.clone(),
            created_at: chat.created_at,
            session_id: chat.session_id.clone(),
            custom_title: chat.custom_title.clone(),
            pinned: chat.pinned,
        }
    }

    fn into_chat_file(self, messages: Vec<ChatMessageStored>) -> ChatFile {
        ChatFile {
            id: self.id,
            project_path: self.project_path,
            agent_id: self.agent_id,
            title: self.title,
            created_at: self.created_at,
            session_id: self.session_id,
            custom_title: self.custom_title,
            pinned: self.pinned,
            messages,
        }
    }
}

fn cache_meta(chat: &ChatFile) {
    if let Ok(mut map) = META_CACHE.lock() {
        map.insert(chat.id.clone(), ChatFileMeta::from_chat(chat));
    }
}

fn get_cached_meta(chat_id: &str) -> Option<ChatFileMeta> {
    META_CACHE.lock().ok()?.get(chat_id).cloned()
}

/// Path to the lightweight index file
fn index_path() -> PathBuf {
    chats_dir().join("index.json")
}

/// Read index from disk (returns empty vec on any error)
fn read_index() -> Vec<ChatFileMeta> {
    let path = index_path();
    match fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Write index to disk
fn write_index(entries: &[ChatFileMeta]) -> Result<(), String> {
    let data = serde_json::to_string_pretty(entries)
        .map_err(|e| format!("Failed to serialize index: {e}"))?;
    atomic_write(&index_path(), data.as_bytes())
}

/// Rebuild index by scanning all chat files (fallback when index.json is missing)
fn rebuild_index() -> Result<Vec<ChatFileMeta>, String> {
    let dir = chats_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read chats dir: {e}"))?;

    let mut index = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // Skip the index file itself
        if path.file_stem().and_then(|s| s.to_str()) == Some("index") {
            continue;
        }
        if let Ok(data) = fs::read_to_string(&path) {
            if let Ok(chat) = serde_json::from_str::<ChatFileLight>(&data) {
                index.push(ChatFileMeta {
                    id: chat.id,
                    project_path: chat.project_path,
                    agent_id: chat.agent_id,
                    title: chat.title,
                    created_at: chat.created_at,
                    session_id: chat.session_id,
                    custom_title: chat.custom_title,
                    pinned: chat.pinned,
                });
            }
        }
    }
    write_index(&index)?;
    Ok(index)
}

/// Get the index, rebuilding if the file doesn't exist yet
fn get_or_rebuild_index() -> Result<Vec<ChatFileMeta>, String> {
    if index_path().exists() {
        Ok(read_index())
    } else {
        rebuild_index()
    }
}

/// Update a single entry in the index (insert or replace by id)
fn upsert_index_entry(meta: &ChatFileMeta) -> Result<(), String> {
    let mut index = get_or_rebuild_index()?;
    if let Some(pos) = index.iter().position(|e| e.id == meta.id) {
        index[pos] = meta.clone();
    } else {
        index.push(meta.clone());
    }
    write_index(&index)
}

/// Remove an entry from the index by id
fn remove_index_entry(chat_id: &str) -> Result<(), String> {
    let mut index = get_or_rebuild_index()?;
    index.retain(|e| e.id != chat_id);
    write_index(&index)
}

fn chat_lock(chat_id: &str) -> Arc<Mutex<()>> {
    let mut map = CHAT_LOCKS.lock().unwrap_or_else(|e| {
        eprintln!("[chats] WARNING: CHAT_LOCKS mutex was poisoned, recovering");
        e.into_inner()
    });
    map.entry(chat_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_response: Option<String>,
}

/// Stored file attachment
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentStored {
    pub id: String,
    pub name: String,
    pub content: String,
    pub size: u64,
    pub file_type: String,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentStored>,
}

/// Full chat file on disk
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatFile {
    pub id: String,
    pub project_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub title: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
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
    pub custom_title: Option<String>,
    pub pinned: bool,
}

/// Lightweight struct for list_chats — skips messages during deserialization
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatFileLight {
    id: String,
    project_path: String,
    #[serde(default)]
    agent_id: Option<String>,
    title: String,
    created_at: u64,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    custom_title: Option<String>,
    #[serde(default)]
    pinned: Option<bool>,
}

/// Directory where chat JSON files live: ~/.config/aither-flow/chats/
fn chats_dir() -> PathBuf {
    config::config_dir().join("chats")
}

/// Path for a single chat file
fn chat_path(chat_id: &str) -> PathBuf {
    chats_dir().join(format!("{chat_id}.json"))
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
        let index = get_or_rebuild_index()?;

        let mut chats: Vec<ChatMeta> = index
            .into_iter()
            .filter(|e| e.project_path == project_path)
            .map(|e| ChatMeta {
                id: e.id,
                title: e.title,
                created_at: e.created_at,
                session_id: e.session_id,
                custom_title: e.custom_title,
                pinned: e.pinned.unwrap_or(false),
            })
            .collect();

        // Pinned first, then newest first within each group
        chats.sort_by(|a, b| {
            b.pinned.cmp(&a.pinned).then(b.created_at.cmp(&a.created_at))
        });
        Ok(chats)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Create a new chat with a title (from first message)
#[tauri::command]
pub async fn create_chat(
    project_path: String,
    agent_id: String,
    title: String,
) -> Result<ChatFile, String> {
    tokio::task::spawn_blocking(move || {
        let id = uuid::Uuid::new_v4().to_string();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let chat = ChatFile {
            id: id.clone(),
            project_path,
            agent_id: Some(agent_id),
            title,
            created_at: now,
            session_id: None,
            custom_title: None,
            pinned: None,
            messages: Vec::new(),
        };

        let data = serde_json::to_string_pretty(&chat)
            .map_err(|e| format!("Failed to serialize chat: {e}"))?;
        atomic_write(&chat_path(&id), data.as_bytes())?;

        cache_meta(&chat);
        upsert_index_entry(&ChatFileMeta::from_chat(&chat))
            .map_err(|e| eprintln!("[chats] Failed to update chat index: {e}"))
            .ok();
        Ok(chat)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Load a full chat (with messages) for display
#[tauri::command]
pub async fn load_chat(chat_id: String) -> Result<ChatFile, String> {
    tokio::task::spawn_blocking(move || {
        let chat = read_chat_file(&chat_id)
            .ok_or_else(|| format!("Chat {chat_id} not found"))?;
        cache_meta(&chat);
        Ok(chat)
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
        let lock = chat_lock(&chat_id);
        let _guard = lock.lock().map_err(|e| format!("Chat lock poisoned: {e}"))?;

        // Try cached metadata first (avoids reading+parsing the whole file)
        let meta = get_cached_meta(&chat_id);
        let chat = if let Some(meta) = meta {
            meta.into_chat_file(messages)
        } else {
            // Cache miss: fall back to full read (first save before load_chat)
            let mut chat = read_chat_file(&chat_id)
                .ok_or_else(|| format!("Chat {chat_id} not found"))?;
            chat.messages = messages;
            cache_meta(&chat);
            chat
        };

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
        let lock = chat_lock(&chat_id);
        let _guard = lock.lock().map_err(|e| format!("Chat lock poisoned: {e}"))?;
        let mut chat = read_chat_file(&chat_id)
            .ok_or_else(|| format!("Chat {chat_id} not found"))?;
        chat.session_id = Some(session_id);
        let meta = ChatFileMeta::from_chat(&chat);
        cache_meta(&chat);
        upsert_index_entry(&meta)
            .map_err(|e| eprintln!("[chats] Failed to update chat index: {e}"))
            .ok();
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
        // Clean up caches
        if let Ok(mut map) = CHAT_LOCKS.lock() {
            map.remove(&chat_id);
        }
        if let Ok(mut map) = META_CACHE.lock() {
            map.remove(&chat_id);
        }
        remove_index_entry(&chat_id)
            .map_err(|e| eprintln!("[chats] Failed to update chat index: {e}"))
            .ok();
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Rename a chat (set custom display title)
#[tauri::command]
pub async fn rename_chat(chat_id: String, custom_title: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let lock = chat_lock(&chat_id);
        let _guard = lock.lock().map_err(|e| format!("Chat lock poisoned: {e}"))?;
        let mut chat = read_chat_file(&chat_id)
            .ok_or_else(|| format!("Chat {chat_id} not found"))?;
        let trimmed = custom_title.trim();
        chat.custom_title = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
        let meta = ChatFileMeta::from_chat(&chat);
        cache_meta(&chat);
        upsert_index_entry(&meta)
            .map_err(|e| eprintln!("[chats] Failed to update chat index: {e}"))
            .ok();
        let data = serde_json::to_string_pretty(&chat)
            .map_err(|e| format!("Failed to serialize chat: {e}"))?;
        atomic_write(&chat_path(&chat_id), data.as_bytes())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Toggle chat pin status
#[tauri::command]
pub async fn toggle_chat_pin(chat_id: String, pinned: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let lock = chat_lock(&chat_id);
        let _guard = lock.lock().map_err(|e| format!("Chat lock poisoned: {e}"))?;
        let mut chat = read_chat_file(&chat_id)
            .ok_or_else(|| format!("Chat {chat_id} not found"))?;
        chat.pinned = if pinned { Some(true) } else { None };
        let meta = ChatFileMeta::from_chat(&chat);
        cache_meta(&chat);
        upsert_index_entry(&meta)
            .map_err(|e| eprintln!("[chats] Failed to update chat index: {e}"))
            .ok();
        let data = serde_json::to_string_pretty(&chat)
            .map_err(|e| format!("Failed to serialize chat: {e}"))?;
        atomic_write(&chat_path(&chat_id), data.as_bytes())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
