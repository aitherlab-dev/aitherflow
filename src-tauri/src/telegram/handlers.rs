use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;

use crate::file_ops::atomic_write;

use super::api::{
    groq_transcribe, tg_delete_message, tg_download_file, tg_edit_message_with_inline_keyboard,
    tg_send_inline_keyboard_returning_id, tg_send_message,
};
use super::TeamBuilder;
use super::TgIncoming;

/// Resolve an indexed callback ("cb:N") to its registered payload.
fn resolve_callback(data: &str) -> Option<String> {
    let idx_str = data.strip_prefix("cb:")?;
    let idx: usize = idx_str.parse().ok()?;
    super::with_state(|s| {
        let state = s.as_ref()?;
        state.callback_registry.get(idx).cloned()
    })
}

pub(super) fn keyboard_button_kind(text: &str) -> Option<&'static str> {
    match text {
        "Active" => Some("request_agents"),
        "Projects" => Some("request_projects"),
        "Skills" => Some("request_skills"),
        "Stop" => Some("request_stop"),
        "Team" => Some("request_team"),
        _ => None,
    }
}

pub(super) async fn handle_callback(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    data: &str,
    message_id: Option<i64>,
    incoming_tx: &mpsc::UnboundedSender<TgIncoming>,
) {
    // Resolve indexed callback to actual payload first
    let resolved;
    let data = if data.starts_with("cb:") {
        resolved = match resolve_callback(data) {
            Some(r) => r,
            None => {
                eprintln!("[TG] Unknown callback index: {data}");
                return;
            }
        };
        &resolved
    } else {
        data
    };

    // Team project selection: delete picker, show role builder
    if let Some(path) = data.strip_prefix("t_proj:") {
        if let Some(mid) = message_id {
            if let Err(e) = tg_delete_message(client, token, chat_id, mid).await {
                eprintln!("[telegram] Failed to delete picker message: {e}");
            }
        }
        let name = path.rsplit('/').next().unwrap_or(path);
        send_team_role_picker(client, token, chat_id, path, name).await;
        return;
    }

    // Team builder callbacks: edit in place, don't delete
    if data.starts_with("t_") {
        handle_team_callback(client, token, chat_id, data, message_id, incoming_tx).await;
        return;
    }

    // Delete the inline keyboard message for non-team callbacks
    if let Some(mid) = message_id {
        if let Err(e) = tg_delete_message(client, token, chat_id, mid).await {
            eprintln!("[TG] delete callback message: {e}");
        }
    }

    // Cancel button — just delete, no action
    if data == "cancel" {
        return;
    }

    if let Some(agent_id) = data.strip_prefix("agent:") {
        if let Err(e) = incoming_tx.send(TgIncoming {
            kind: "switch_agent".into(),
            text: agent_id.to_string(),
            project_path: None,
            project_name: None,
            attachment_path: None,
        }) {
            eprintln!("[TG] send switch_agent: {e}");
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
    } else if let Some(agent_id) = data.strip_prefix("stop:") {
        if let Err(e) = incoming_tx.send(TgIncoming {
            kind: "stop_agent".into(),
            text: agent_id.to_string(),
            project_path: None,
            project_name: None,
            attachment_path: None,
        }) {
            eprintln!("[TG] send stop_agent: {e}");
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
        "/start" | "/menu_bot" | "/restart" => {
            if let Err(e) = send_request("request_menu") {
                eprintln!("[TG] send request_menu: {e}");
            }
        }
        "/help_bot" => {
            let help = "\
/start — dashboard\n\
/restart — restart dashboard\n\n\
Use dashboard buttons to navigate.\n\
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

// ── Team builder ──

const TEAM_ROLES: &[&str] = &["Team Lead", "Coder", "Reviewer", "Researcher"];
const MAX_ROLE_COUNT: u8 = 3;

fn build_role_picker_buttons(builder: &TeamBuilder) -> Vec<Vec<serde_json::Value>> {
    let mut buttons: Vec<Vec<serde_json::Value>> = Vec::new();
    for (name, count) in &builder.roles {
        buttons.push(vec![
            serde_json::json!({ "text": "\u{2796}", "callback_data": format!("t_dec:{name}") }),
            serde_json::json!({ "text": format!("{name}: {count}"), "callback_data": "t_noop" }),
            serde_json::json!({ "text": "\u{2795}", "callback_data": format!("t_inc:{name}") }),
        ]);
    }
    let total: u8 = builder.roles.iter().map(|(_, c)| c).sum();
    if total > 0 {
        buttons.push(vec![
            serde_json::json!({ "text": "\u{1F680} Launch", "callback_data": "t_launch" }),
            serde_json::json!({ "text": "\u{2715} Cancel", "callback_data": "t_cancel" }),
        ]);
    } else {
        buttons.push(vec![
            serde_json::json!({ "text": "\u{2715} Cancel", "callback_data": "t_cancel" }),
        ]);
    }
    buttons
}

fn role_picker_text(builder: &TeamBuilder) -> String {
    format!("Team for {}:", builder.project_name)
}

/// Send the initial role picker message and store its message_id.
pub(super) async fn send_team_role_picker(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    project_path: &str,
    project_name: &str,
) {
    let mut builder = TeamBuilder {
        project_path: project_path.to_string(),
        project_name: project_name.to_string(),
        roles: TEAM_ROLES.iter().map(|r| (r.to_string(), 0u8)).collect(),
        message_id: 0,
    };

    let text = role_picker_text(&builder);
    let buttons = build_role_picker_buttons(&builder);

    match tg_send_inline_keyboard_returning_id(client, token, chat_id, &text, buttons).await {
        Ok(mid) => {
            builder.message_id = mid;
            super::with_state(|s| {
                if let Some(state) = s.as_mut() {
                    state.team_builder = Some(builder);
                }
            });
        }
        Err(e) => eprintln!("[TG] send role picker: {e}"),
    }
}

async fn handle_team_callback(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    data: &str,
    message_id: Option<i64>,
    incoming_tx: &mpsc::UnboundedSender<TgIncoming>,
) {
    if data == "t_cancel" {
        super::with_state(|s| {
            if let Some(state) = s.as_mut() {
                state.team_builder = None;
            }
        });
        if let Some(mid) = message_id {
            if let Err(e) = tg_delete_message(client, token, chat_id, mid).await {
                eprintln!("[telegram] Failed to delete message: {e}");
            }
        }
        return;
    }

    if data == "t_noop" {
        return;
    }

    if data == "t_launch" {
        let builder = super::with_state(|s| {
            s.as_mut().and_then(|state| state.team_builder.take())
        });
        let Some(builder) = builder else { return };

        // Delete the picker message
        if builder.message_id != 0 {
            if let Err(e) = tg_delete_message(client, token, chat_id, builder.message_id).await {
                eprintln!("[telegram] Failed to delete builder message: {e}");
            }
        }

        // Build roles list: ["Coder", "Coder", "Reviewer", ...]
        let mut roles: Vec<String> = Vec::new();
        for (name, count) in &builder.roles {
            for _ in 0..*count {
                roles.push(name.clone());
            }
        }

        if roles.is_empty() {
            if let Err(e) = tg_send_message(client, token, chat_id, "No roles selected").await {
                eprintln!("[TG] send no roles: {e}");
            }
            return;
        }

        let summary = roles.join(", ");
        if let Err(e) = tg_send_message(client, token, chat_id, &format!("Launching team: {summary}")).await {
            eprintln!("[TG] send team launch: {e}");
        }

        if let Err(e) = incoming_tx.send(TgIncoming {
            kind: "launch_team".into(),
            text: serde_json::json!({ "roles": roles }).to_string(),
            project_path: Some(builder.project_path),
            project_name: Some(builder.project_name),
            attachment_path: None,
        }) {
            eprintln!("[TG] send launch_team: {e}");
        }
        return;
    }

    // t_inc:RoleName or t_dec:RoleName
    let (is_inc, role_name) = if let Some(name) = data.strip_prefix("t_inc:") {
        (true, name)
    } else if let Some(name) = data.strip_prefix("t_dec:") {
        (false, name)
    } else {
        return;
    };

    let updated = super::with_state(|s| {
        let state = s.as_mut()?;
        let builder = state.team_builder.as_mut()?;
        for (name, count) in &mut builder.roles {
            if name == role_name {
                if is_inc {
                    if *count < MAX_ROLE_COUNT {
                        *count += 1;
                    }
                } else if *count > 0 {
                    *count -= 1;
                }
                break;
            }
        }
        Some((role_picker_text(builder), build_role_picker_buttons(builder), builder.message_id))
    });

    if let Some((text, buttons, mid)) = updated {
        if mid != 0 {
            if let Err(e) = tg_edit_message_with_inline_keyboard(client, token, chat_id, mid, &text, buttons).await {
                eprintln!("[TG] edit role picker: {e}");
            }
        }
    }
}
