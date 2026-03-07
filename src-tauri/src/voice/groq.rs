#[tauri::command]
pub async fn voice_transcribe(
    audio_data: Vec<u8>,
    api_key: String,
    language: String,
    post_process: bool,
    post_model: String,
) -> Result<String, String> {
    if api_key.is_empty() {
        return Err("Groq API key is not set. Go to Settings → Voice.".into());
    }

    let file_part = reqwest::multipart::Part::bytes(audio_data)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("Multipart error: {e}"))?;

    let mut form = reqwest::multipart::Form::new()
        .part("file", file_part)
        .text("model", "whisper-large-v3-turbo");

    if !language.is_empty() {
        form = form.text("language", language);
    }

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .bearer_auth(&api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Groq API request failed: {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {e}"))?;

    if !status.is_success() {
        return Err(format!("Groq API error ({status}): {body}"));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {e}"))?;

    let raw_text = parsed["text"]
        .as_str()
        .ok_or_else(|| format!("Unexpected response format: {body}"))?;

    if raw_text.trim().is_empty() {
        return Ok(String::new());
    }

    if !post_process || post_model.is_empty() {
        return Ok(raw_text.to_string());
    }

    let cleaned = polish_with_llm(&client, &api_key, raw_text, &post_model).await;
    Ok(cleaned.unwrap_or_else(|_| raw_text.to_string()))
}

/// Send raw STT text to LLM for cleanup (punctuation, capitalization, minor fixes).
async fn polish_with_llm(
    client: &reqwest::Client,
    api_key: &str,
    raw: &str,
    model: &str,
) -> Result<String, String> {
    let payload = serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "You are a text post-processor for speech-to-text output. \
                    Fix punctuation, capitalization, and obvious speech recognition errors. \
                    Do NOT change the meaning, do NOT add or remove words, do NOT translate. \
                    Return ONLY the cleaned text, nothing else."
            },
            {
                "role": "user",
                "content": raw
            }
        ],
        "temperature": 0.0,
        "max_tokens": 2048
    });

    let resp = client
        .post("https://api.groq.com/openai/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Llama request failed: {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read Llama response: {e}"))?;

    if !status.is_success() {
        return Err(format!("Llama API error ({status}): {body}"));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Llama JSON parse error: {e}"))?;

    parsed["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "Unexpected Llama response format".into())
}
