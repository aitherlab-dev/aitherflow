use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use tokio::sync::Notify;

use crate::config;
use crate::file_ops::atomic_write;
use crate::named_mutex_pool::NamedMutexPool;

use super::validate_name;

/// Per-inbox lock to prevent concurrent write races.
static INBOX_LOCKS: LazyLock<NamedMutexPool> =
    LazyLock::new(|| NamedMutexPool::new("teamwork/inbox"));

/// Push-notification registry: when a message lands in an inbox,
/// the corresponding Notify is triggered so the polling task wakes immediately.
static INBOX_NOTIFIERS: LazyLock<Mutex<HashMap<String, Arc<Notify>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Subscribe to push notifications for a specific agent's inbox.
/// Returns an `Arc<Notify>` that will be notified on every new message.
pub(crate) fn subscribe_inbox(team: &str, agent_id: &str) -> Arc<Notify> {
    let key = inbox_lock_key(team, agent_id);
    let mut map = INBOX_NOTIFIERS.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(key).or_insert_with(|| Arc::new(Notify::new())).clone()
}

/// Unsubscribe from push notifications (cleanup on agent shutdown).
pub(crate) fn unsubscribe_inbox(team: &str, agent_id: &str) {
    let key = inbox_lock_key(team, agent_id);
    let mut map = INBOX_NOTIFIERS.lock().unwrap_or_else(|e| e.into_inner());
    map.remove(&key);
}

/// Notify the subscriber (if any) that a new message arrived.
fn notify_inbox(team: &str, agent_id: &str) {
    let key = inbox_lock_key(team, agent_id);
    let map = INBOX_NOTIFIERS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(notifier) = map.get(&key) {
        notifier.notify_one();
    }
}

fn inbox_lock(key: &str) -> Arc<Mutex<()>> {
    INBOX_LOCKS.lock(key)
}

/// Remove lock and notifier entries for a given team prefix (called on team deletion).
#[allow(dead_code)] // reserved for team lifecycle management
pub(crate) fn remove_inbox_locks(team: &str) {
    let prefix = format!("{team}/");
    INBOX_LOCKS.remove_by_prefix(&prefix);

    // Also clean up push-notification subscriptions for this team
    let mut notifiers = INBOX_NOTIFIERS.lock().unwrap_or_else(|e| e.into_inner());
    notifiers.retain(|key, notify| {
        if key.starts_with(&prefix) {
            Arc::strong_count(notify) > 1 // keep if someone is still subscribed
        } else {
            true
        }
    });
}

/// A message in an agent's inbox
#[derive(Serialize, Deserialize, Clone)]
pub struct TeamMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub text: String,
    pub timestamp: String,
    pub read: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broadcast_id: Option<String>,
}

/// Directory for team inboxes: ~/.config/aither-flow/teams/{team_name}/inboxes/
fn inboxes_dir(team: &str) -> PathBuf {
    config::config_dir()
        .join("teams")
        .join(team)
        .join("inboxes")
}

/// Path to an agent's inbox file
fn inbox_path(team: &str, agent_id: &str) -> PathBuf {
    inboxes_dir(team).join(format!("{agent_id}.jsonl"))
}

/// Path to the persistent feed log (append-only, for UI display)
fn feed_path(team: &str) -> PathBuf {
    inboxes_dir(team).join("feed.jsonl")
}

/// Lock key for an inbox
fn inbox_lock_key(team: &str, agent_id: &str) -> String {
    format!("{team}/{agent_id}")
}

/// Create a new message with UUID and ISO-8601 timestamp
fn new_message(from: &str, to: &str, text: &str, broadcast_id: Option<String>) -> TeamMessage {
    TeamMessage {
        id: uuid::Uuid::new_v4().to_string(),
        from: from.to_string(),
        to: to.to_string(),
        text: text.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        read: false,
        broadcast_id,
    }
}

/// Append a single message line to an inbox file (O(1) write).
fn append_to_inbox(team: &str, msg: &TeamMessage) -> Result<(), String> {
    let path = inbox_path(team, &msg.to);
    let key = inbox_lock_key(team, &msg.to);
    let lock = inbox_lock(&key);
    let _guard = lock
        .lock()
        .map_err(|e| format!("Inbox lock poisoned: {e}"))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create inboxes dir: {e}"))?;
    }

    let mut line =
        serde_json::to_string(msg).map_err(|e| format!("Failed to serialize message: {e}"))?;
    line.push('\n');

    let mut opts = fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(&path)
        .map_err(|e| format!("Failed to open inbox {}: {e}", path.display()))?;

    file.write_all(line.as_bytes())
        .map_err(|e| format!("Failed to write to inbox: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("Failed to sync inbox: {e}"))?;

    // Push-notify the agent's polling task (if subscribed)
    notify_inbox(team, &msg.to);

    Ok(())
}

/// Append a message to the persistent feed log (for UI display).
/// The feed is append-only; messages are never removed except by team_clear_messages.
fn append_to_feed(team: &str, msg: &TeamMessage) -> Result<(), String> {
    let path = feed_path(team);
    let key = format!("{team}/__feed__");
    let lock = inbox_lock(&key);
    let _guard = lock
        .lock()
        .map_err(|e| format!("Feed lock poisoned: {e}"))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create inboxes dir: {e}"))?;
    }

    let mut line =
        serde_json::to_string(msg).map_err(|e| format!("Failed to serialize message: {e}"))?;
    line.push('\n');

    let mut opts = fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(&path)
        .map_err(|e| format!("Failed to open feed {}: {e}", path.display()))?;

    file.write_all(line.as_bytes())
        .map_err(|e| format!("Failed to write to feed: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("Failed to sync feed: {e}"))?;

    Ok(())
}

/// Send a message (sync, for use inside spawn_blocking).
pub(crate) fn send_message_sync(
    team: &str,
    from: &str,
    to: &str,
    text: &str,
) -> Result<(), String> {
    validate_name(team, "team")?;
    validate_name(from, "from")?;
    validate_name(to, "to")?;
    let msg = new_message(from, to, text, None);
    append_to_inbox(team, &msg)?;
    append_to_feed(team, &msg)?;
    Ok(())
}

/// Broadcast a message to specified agents except sender (sync).
pub(crate) fn broadcast_sync(
    team: &str,
    from: &str,
    text: &str,
    agent_ids: &[String],
) -> Result<(), String> {
    validate_name(team, "team")?;
    validate_name(from, "from")?;
    let bid = uuid::Uuid::new_v4().to_string();
    // Write one copy to the persistent feed for UI display
    let feed_msg = new_message(from, "broadcast", text, Some(bid.clone()));
    append_to_feed(team, &feed_msg)?;
    // Write to each agent's inbox (consumed by MCP read_inbox)
    for agent_id in agent_ids {
        validate_name(agent_id, "agent_id")?;
        if agent_id == from {
            continue;
        }
        let msg = new_message(from, agent_id, text, Some(bid.clone()));
        append_to_inbox(team, &msg)?;
    }
    Ok(())
}

/// Send a message from one agent to another. Returns the message ID.
#[allow(dead_code)] // available as tauri command when needed
#[tauri::command]
pub async fn team_send_message(
    team: String,
    from: String,
    to: String,
    text: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        validate_name(&team, "team")?;
        validate_name(&from, "from")?;
        validate_name(&to, "to")?;
        let msg = new_message(&from, &to, &text, None);
        let id = msg.id.clone();
        append_to_inbox(&team, &msg)?;
        append_to_feed(&team, &msg)?;
        Ok(id)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Broadcast a message to specified agents (except sender).
/// Returns a map of agent_id → message_id for each recipient.
#[tauri::command]
pub async fn team_broadcast(
    team: String,
    from: String,
    text: String,
    agent_ids: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    tokio::task::spawn_blocking(move || {
        validate_name(&team, "team")?;
        validate_name(&from, "from")?;

        let bid = uuid::Uuid::new_v4().to_string();
        // Write one copy to the persistent feed for UI display
        let feed_msg = new_message(&from, "broadcast", &text, Some(bid.clone()));
        append_to_feed(&team, &feed_msg)?;
        // Write to each agent's inbox
        let mut ids = HashMap::new();
        for agent_id in &agent_ids {
            validate_name(agent_id, "agent_id")?;
            if *agent_id == from {
                continue;
            }
            let msg = new_message(&from, agent_id, &text, Some(bid.clone()));
            ids.insert(agent_id.clone(), msg.id.clone());
            append_to_inbox(&team, &msg)?;
        }

        Ok(ids)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Read all unread messages (synchronous, for use inside spawn_blocking).
pub(crate) fn read_inbox_sync(team: &str, agent_id: &str) -> Result<Vec<TeamMessage>, String> {
    validate_name(team, "team")?;
    validate_name(agent_id, "agent_id")?;

    let path = inbox_path(team, agent_id);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let key = inbox_lock_key(team, agent_id);
    let lock = inbox_lock(&key);
    let _guard = lock
        .lock()
        .map_err(|e| format!("Inbox lock poisoned: {e}"))?;

    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read inbox: {e}"))?;

    let mut unread = Vec::new();
    for (i, line) in data.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<TeamMessage>(line) {
            Ok(msg) if !msg.read => unread.push(msg),
            Ok(_) => {}
            Err(e) => {
                eprintln!("[teamwork] Bad line {} in {}: {e}", i + 1, path.display())
            }
        }
    }

    Ok(unread)
}

/// Read all unread messages from an agent's inbox
#[allow(dead_code)] // available as tauri command when needed
#[tauri::command]
pub async fn team_read_inbox(team: String, agent_id: String) -> Result<Vec<TeamMessage>, String> {
    tokio::task::spawn_blocking(move || read_inbox_sync(&team, &agent_id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Mark specific messages as read (synchronous, for use inside spawn_blocking).
pub(crate) fn mark_read_sync(
    team: &str,
    agent_id: &str,
    message_ids: &[String],
) -> Result<(), String> {
    validate_name(team, "team")?;
    validate_name(agent_id, "agent_id")?;

    let path = inbox_path(team, agent_id);
    if !path.exists() {
        return Ok(());
    }

    let key = inbox_lock_key(team, agent_id);
    let lock = inbox_lock(&key);
    let _guard = lock
        .lock()
        .map_err(|e| format!("Inbox lock poisoned: {e}"))?;

    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read inbox: {e}"))?;

    let ids_set: std::collections::HashSet<&str> =
        message_ids.iter().map(|s| s.as_str()).collect();

    // Keep only messages that are NOT being marked as read now and were not
    // already read — this prevents the file from growing unboundedly.
    let mut lines = Vec::new();
    for line in data.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<TeamMessage>(line) {
            Ok(msg) => {
                // Drop messages being marked as read now, and already-read messages
                if ids_set.contains(msg.id.as_str()) || msg.read {
                    continue;
                }
                lines.push(line.to_string());
            }
            Err(e) => {
                eprintln!("[teamwork] Skipping bad line during mark_read: {e}");
            }
        }
    }

    if lines.is_empty() {
        // All messages read — remove the file entirely
        if let Err(e) = fs::remove_file(&path) {
            eprintln!("[teamwork] Failed to remove empty inbox {}: {e}", path.display());
        }
        return Ok(());
    }

    let mut output = lines.join("\n");
    output.push('\n');

    atomic_write(&path, output.as_bytes())
}

/// Read ALL messages from the persistent feed log, sorted by timestamp.
#[tauri::command]
pub async fn team_read_all_messages(team: String) -> Result<Vec<TeamMessage>, String> {
    tokio::task::spawn_blocking(move || {
        validate_name(&team, "team")?;

        let path = feed_path(&team);
        if !path.exists() {
            return Ok(Vec::new());
        }

        let key = format!("{team}/__feed__");
        let lock = inbox_lock(&key);
        let _guard = lock
            .lock()
            .map_err(|e| format!("Feed lock poisoned: {e}"))?;

        let data =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read feed: {e}"))?;

        let mut all = Vec::new();
        for (i, line) in data.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<TeamMessage>(line) {
                Ok(msg) => all.push(msg),
                Err(e) => {
                    eprintln!("[teamwork] Bad line {} in feed: {e}", i + 1);
                }
            }
        }

        all.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
        Ok(all)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Delete all inbox JSONL files for a team (clears message history).
#[tauri::command]
pub async fn team_clear_messages(team: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        validate_name(&team, "team")?;

        let dir = inboxes_dir(&team);
        if !dir.exists() {
            return Ok(());
        }

        let entries =
            fs::read_dir(&dir).map_err(|e| format!("Failed to read inboxes dir: {e}"))?;

        for entry in entries.flatten() {
            let ft = entry
                .file_type()
                .map_err(|e| format!("Failed to get file type: {e}"))?;
            if ft.is_dir() || ft.is_symlink() {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Err(e) = fs::remove_file(&path) {
                eprintln!("[teamwork] Failed to remove inbox {}: {e}", path.display());
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Mark specific messages as read in an agent's inbox.
/// Rewrites the JSONL file with updated read flags.
#[allow(dead_code)] // available as tauri command when needed
#[tauri::command]
pub async fn team_mark_read(
    team: String,
    agent_id: String,
    message_ids: Vec<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || mark_read_sync(&team, &agent_id, &message_ids))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}
