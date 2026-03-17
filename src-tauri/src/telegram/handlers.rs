use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;

use crate::file_ops::atomic_write;

use super::api::{groq_transcribe, tg_download_file, tg_send_message};
use super::TgIncoming;

/// Check if text matches a pending skill name; if so, return the command and clear pending.
pub(super) fn take_pending_skill(text: &str) -> Option<String> {
    super::with_state(|s| {
        let state = s.as_mut()?;
        let cmd = state.pending_skills.remove(text)?;
        state.pending_skills.clear();
        Some(cmd)
    })
}

/// Check if text matches a pending project name; if so, return (path, name) and clear pending.
pub(super) fn take_pending_project(text: &str) -> Option<(String, String)> {
    super::with_state(|s| {
        let state = s.as_mut()?;
        let path = state.pending_projects.remove(text)?;
        let name = text.to_string();
        state.pending_projects.clear();
        Some((path, name))
    })
}

pub(super) fn keyboard_button_kind(text: &str) -> Option<&'static str> {
    match text {
        "Active" => Some("request_agents"),
        "Projects" => Some("request_projects"),
        "Status" => Some("request_status"),
        "History" => Some("request_history"),
        _ => None,
    }
}

pub(super) async fn handle_callback(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    data: &str,
    incoming_tx: &mpsc::UnboundedSender<TgIncoming>,
) {
    if let Some(payload) = data.strip_prefix("agent:") {
        let (agent_id, agent_name) = match payload.split_once('|') {
            Some((id, name)) => (id, name),
            None => (payload, payload),
        };
        if let Err(e) = incoming_tx.send(TgIncoming {
            kind: "switch_agent".into(),
            text: agent_id.to_string(),
            project_path: None,
            project_name: None,
            attachment_path: None,
        }) {
            eprintln!("[TG] send switch_agent: {e}");
        }
        if let Err(e) = tg_send_message(client, token, chat_id, &format!("Switched to: {agent_name}")).await {
            eprintln!("[TG] confirm switch_agent: {e}");
        }
    } else if let Some(skill_cmd) = data.strip_prefix("skill:") {
        if let Err(e) = incoming_tx.send(TgIncoming {
            kind: "text".into(),
            text: skill_cmd.to_string(),
            project_path: None,
            project_name: None,
            attachment_path: None,
        }) {
            eprintln!("[TG] send skill command: {e}");
        }
        if let Err(e) = tg_send_message(client, token, chat_id, &format!("Running {skill_cmd}")).await {
            eprintln!("[TG] confirm skill: {e}");
        }
    } else if let Some(path) = data.strip_prefix("project:") {
        if let Err(e) = crate::files::validate_path_safe(std::path::Path::new(path)) {
            eprintln!("[TG] Invalid project path from callback: {e}");
            if let Err(se) = tg_send_message(client, token, chat_id, &format!("Invalid path: {e}")).await {
                eprintln!("[TG] send path error: {se}");
            }
            return;
        }
        let name = path.rsplit('/').next().unwrap_or(path);
        if let Err(e) = incoming_tx.send(TgIncoming {
            kind: "new_session".into(),
            text: String::new(),
            project_path: Some(path.to_string()),
            project_name: Some(name.to_string()),
            attachment_path: None,
        }) {
            eprintln!("[TG] send new_session: {e}");
        }
        if let Err(e) = tg_send_message(client, token, chat_id, &format!("Starting session in: {name}")).await {
            eprintln!("[TG] confirm new_session: {e}");
        }
    }
}

pub(super) async fn handle_command(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    text: &str,
    incoming_tx: &mpsc::UnboundedSender<TgIncoming>,
) {
    let cmd = text.split_whitespace().next().unwrap_or("");
    let send_request = |kind: &str| {
        incoming_tx.send(TgIncoming {
            kind: kind.into(),
            text: String::new(),
            project_path: None,
            project_name: None,
            attachment_path: None,
        })
    };
    match cmd {
        "/start" | "/menu_bot" => {
            if let Err(e) = send_request("request_menu") {
                eprintln!("[TG] send request_menu: {e}");
            }
        }
        "/agents_bot" => {
            if let Err(e) = send_request("request_agents") {
                eprintln!("[TG] send request_agents: {e}");
            }
        }
        "/projects_bot" => {
            if let Err(e) = send_request("request_projects") {
                eprintln!("[TG] send request_projects: {e}");
            }
        }
        "/history_bot" => {
            if let Err(e) = send_request("request_history") {
                eprintln!("[TG] send request_history: {e}");
            }
        }
        "/status_bot" => {
            if let Err(e) = send_request("request_status") {
                eprintln!("[TG] send request_status: {e}");
            }
        }
        "/skills_bot" => {
            if let Err(e) = send_request("request_skills") {
                eprintln!("[TG] send request_skills: {e}");
            }
        }
        "/help_bot" => {
            let help = "\
/start — dashboard\n\
/agents_bot — active agents\n\
/projects_bot — start new session\n\
/skills_bot — favorite skills\n\
/history_bot — recent messages\n\
/status_bot — current status\n\n\
Text or voice goes to the active agent.";
            if let Err(e) = tg_send_message(client, token, chat_id, help).await {
                eprintln!("[TG] send help: {e}");
            }
        }
        _ => {
            // Not a bot command — forward as text to the agent (e.g. /commit, /simplify)
            if let Err(e) = incoming_tx.send(TgIncoming {
                kind: "text".into(),
                text: text.to_string(),
                project_path: None,
                project_name: None,
                attachment_path: None,
            }) {
                eprintln!("[TG] forward unknown cmd as text: {e}");
            }
        }
    }
}

pub(super) async fn handle_voice(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    file_id: &str,
    groq_key: &Option<String>,
    voice_language: &str,
    incoming_tx: &mpsc::UnboundedSender<TgIncoming>,
) {
    let Some(key) = groq_key.as_deref() else {
        if let Err(e) = tg_send_message(client, token, chat_id, "Groq API key not configured").await {
            eprintln!("[TG] send groq key missing: {e}");
        }
        return;
    };

    if let Err(e) = tg_send_message(client, token, chat_id, "Transcribing...").await {
        eprintln!("[TG] send transcribing: {e}");
    }

    match tg_download_file(client, token, file_id).await {
        Ok((audio, _)) => match groq_transcribe(client, key, audio, voice_language).await {
            Ok(text) => {
                if text.trim().is_empty() {
                    if let Err(e) = tg_send_message(client, token, chat_id, "Could not recognize speech").await {
                        eprintln!("[TG] send speech fail: {e}");
                    }
                } else if let Err(e) = incoming_tx.send(TgIncoming {
                    kind: "text".into(),
                    text,
                    project_path: None,
                    project_name: None,
                    attachment_path: None,
                }) {
                    eprintln!("[TG] send transcribed: {e}");
                }
            }
            Err(e) => {
                if let Err(se) = tg_send_message(client, token, chat_id, &format!("Transcription error: {e}")).await {
                    eprintln!("[TG] send transcription error: {se}");
                }
            }
        },
        Err(e) => {
            if let Err(se) = tg_send_message(client, token, chat_id, &format!("Voice download error: {e}")).await {
                eprintln!("[TG] send download error: {se}");
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

pub(super) async fn handle_photo(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    file_id: &str,
    caption: Option<&str>,
    incoming_tx: &mpsc::UnboundedSender<TgIncoming>,
) {
    match tg_download_file(client, token, file_id).await {
        Ok((bytes, ext)) => {
            use std::sync::atomic::{AtomicU64, Ordering};
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let filename = format!("tg_photo_{}_{}_{}.{ext}", now_millis(), std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed));
            match save_to_tmp(&bytes, &filename) {
                Ok(path) => {
                    let text = match caption {
                        Some(c) if !c.is_empty() => c.to_string(),
                        _ => "[Photo]".to_string(),
                    };
                    if let Err(e) = incoming_tx.send(TgIncoming {
                        kind: "text".into(),
                        text,
                        project_path: None,
                        project_name: None,
                        attachment_path: Some(path),
                    }) {
                        eprintln!("[TG] send photo: {e}");
                    }
                }
                Err(e) => {
                    if let Err(se) = tg_send_message(client, token, chat_id, &format!("Save error: {e}")).await {
                        eprintln!("[TG] send save error: {se}");
                    }
                }
            }
        }
        Err(e) => {
            if let Err(se) = tg_send_message(client, token, chat_id, &format!("Photo download error: {e}")).await {
                eprintln!("[TG] send photo dl error: {se}");
            }
        }
    }
}

pub(super) async fn handle_document_image(
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
            let filename = format!("tg_{}_{safe_name}", now_millis());
            match save_to_tmp(&bytes, &filename) {
                Ok(path) => {
                    let text = match caption {
                        Some(c) if !c.is_empty() => c.to_string(),
                        _ => "[Photo]".to_string(),
                    };
                    if let Err(e) = incoming_tx.send(TgIncoming {
                        kind: "text".into(),
                        text,
                        project_path: None,
                        project_name: None,
                        attachment_path: Some(path),
                    }) {
                        eprintln!("[TG] send doc image: {e}");
                    }
                }
                Err(e) => {
                    if let Err(se) = tg_send_message(client, token, chat_id, &format!("Save error: {e}")).await {
                        eprintln!("[TG] send save error: {se}");
                    }
                }
            }
        }
        Err(e) => {
            if let Err(se) = tg_send_message(client, token, chat_id, &format!("File download error: {e}")).await {
                eprintln!("[TG] send file dl error: {se}");
            }
        }
    }
}
