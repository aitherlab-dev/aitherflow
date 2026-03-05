use serde::Deserialize;

use super::types::*;

pub const TG_API: &str = "https://api.telegram.org/bot";
pub const TELEGRAM_TAG: &str = "[TG] ";

pub(crate) fn sanitize_error(err: &str, token: &str) -> String {
    if token.is_empty() {
        return err.to_string();
    }
    err.replace(token, "<TOKEN>")
}

pub(crate) async fn tg_get_me(
    client: &reqwest::Client,
    token: &str,
) -> Result<TgUser, String> {
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

pub(crate) async fn tg_get_updates(
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

pub(crate) async fn tg_send_message(
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
pub(crate) async fn tg_send_and_get_id(
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
pub(crate) async fn tg_edit_message(
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

pub(crate) async fn tg_send_inline_keyboard(
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
    client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| sanitize_error(&format!("sendInlineKeyboard: {e}"), token))?;
    Ok(())
}

pub(crate) async fn tg_answer_callback(
    client: &reqwest::Client,
    token: &str,
    callback_id: &str,
) -> Result<(), String> {
    let url = format!("{TG_API}{token}/answerCallbackQuery");
    let body = serde_json::json!({ "callback_query_id": callback_id });
    client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| sanitize_error(&format!("answerCallback: {e}"), token))?;
    Ok(())
}

pub(crate) fn split_message(text: &str, max_len: usize) -> Vec<String> {
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

pub(crate) async fn tg_download_file(
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

pub(crate) async fn tg_set_my_commands(
    client: &reqwest::Client,
    token: &str,
) -> Result<(), String> {
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

pub(crate) async fn groq_transcribe(
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
