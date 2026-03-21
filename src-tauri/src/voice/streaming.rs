use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use tauri::Emitter;

use super::recording::VoiceState;

// ── Anthropic auth ──────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicAuthStatus {
    pub available: bool,
    pub expired: bool,
}

/// Read OAuth credentials from CLI's credentials file.
fn read_oauth_token() -> Result<(String, u64), String> {
    use std::os::unix::fs::MetadataExt;

    let home = crate::config::home_dir();
    let cred_path = home.join(".claude").join(".credentials.json");

    // Check file permissions before reading sensitive data
    let meta = std::fs::metadata(&cred_path)
        .map_err(|_| "Not logged in to Claude CLI (no credentials file)")?;
    let mode = meta.mode();
    if mode & 0o077 != 0 {
        return Err(format!(
            "Credentials file {:?} has unsafe permissions ({:o}). Run: chmod 600 {:?}",
            cred_path,
            mode & 0o777,
            cred_path
        ));
    }

    let data = std::fs::read_to_string(&cred_path)
        .map_err(|_| "Failed to read credentials file")?;

    let parsed: serde_json::Value =
        serde_json::from_str(&data).map_err(|e| format!("Failed to parse credentials: {e}"))?;

    let oauth = &parsed["claudeAiOauth"];
    let token = oauth["accessToken"]
        .as_str()
        .ok_or("No accessToken in credentials")?
        .to_string();
    let expires_at = oauth["expiresAt"].as_u64().unwrap_or(0);

    Ok((token, expires_at))
}

#[tauri::command]
pub async fn voice_check_anthropic_auth() -> Result<AnthropicAuthStatus, String> {
    tokio::task::spawn_blocking(|| match read_oauth_token() {
        Ok((_, expires_at)) => {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            Ok(AnthropicAuthStatus {
                available: true,
                expired: expires_at > 0 && now_ms > expires_at,
            })
        }
        Err(e) => {
            eprintln!("[voice] Anthropic auth check failed: {e}");
            Ok(AnthropicAuthStatus {
                available: false,
                expired: false,
            })
        }
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

// ── Stream session ──────────────────────────────────────────────

pub(crate) struct StreamSession {
    stop_tx: tokio::sync::watch::Sender<bool>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    audio_thread: Option<std::thread::JoinHandle<()>>,
}

#[tauri::command]
pub async fn voice_start_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, VoiceState>,
    language: String,
    provider: String,
) -> Result<(), String> {
    let mut guard = state.stream_state.lock().await;
    if guard.is_some() {
        return Err("Already streaming".into());
    }

    let target_rate = 16000u32;
    let lang = if language.is_empty() {
        "en".to_string()
    } else {
        language
    };

    // Build WebSocket URL and auth based on provider
    let (ws_url, auth_header) = match provider.as_str() {
        "anthropic" => {
            let (token, expires_at) = tokio::task::spawn_blocking(read_oauth_token)
                .await
                .map_err(|e| format!("Task join error: {e}"))??;

            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;

            if expires_at > 0 && now_ms > expires_at {
                return Err("OAuth token expired. Run `claude` in terminal to refresh.".into());
            }

            let url = format!(
                "wss://platform.claude.com/api/ws/speech_to_text/voice_stream\
                 ?encoding=linear16&sample_rate={target_rate}&channels=1\
                 &endpointing_ms=300&utterance_end_ms=1000&language={lang}"
            );
            (url, format!("Bearer {token}"))
        }
        "deepgram" => {
            let api_key = tokio::task::spawn_blocking(|| {
                crate::secrets::get_secret("deepgram-api-key").unwrap_or_default()
            })
            .await
            .map_err(|e| format!("Task join error: {e}"))?;
            if api_key.is_empty() {
                return Err("Deepgram API key is not set. Go to Settings → Voice.".into());
            }
            let url = format!(
                "wss://api.deepgram.com/v1/listen\
                 ?model=nova-3&language={lang}&punctuate=true\
                 &interim_results=true&utterance_end_ms=1000\
                 &encoding=linear16&sample_rate={target_rate}&channels=1"
            );
            (url, format!("Token {api_key}"))
        }
        _ => return Err(format!("Unknown streaming provider: {provider}")),
    };

    // Get audio device + config once; pass both into the capture thread to avoid
    // a second default_input_device() call that could return a different device.
    let (device, supported_config) =
        tokio::task::spawn_blocking(|| -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
            let host = cpal::default_host();
            let device = host
                .default_input_device()
                .ok_or("No input device found")?;
            let config = device
                .default_input_config()
                .map_err(|e| format!("Failed to get input config: {e}"))?;
            Ok((device, config))
        })
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    // Channel for audio chunks: cpal thread → tokio task → WebSocket
    let (audio_tx, audio_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);

    // Stop signal
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let stop_rx2 = stop_rx.clone();

    // Spawn cpal recording thread
    let audio_thread = {
        let stop_rx = stop_rx.clone();
        std::thread::spawn(move || {
            run_audio_capture(
                device,
                supported_config,
                target_rate,
                audio_tx,
                stop_rx,
            );
        })
    };

    // Spawn WebSocket task — sends stop signal on exit so audio_thread is always cleaned up
    let prov = provider.clone();
    let stop_tx_ws = stop_tx.clone();
    let ws_task = tokio::spawn(async move {
        run_websocket(
            ws_url,
            auth_header,
            audio_rx,
            stop_rx2,
            app.clone(),
            prov,
        )
        .await;
        // Ensure audio_thread stops even if WebSocket exits before voice_stop_stream
        if let Err(e) = stop_tx_ws.send(true) {
            eprintln!("[voice] Failed to send stop signal after WebSocket exit: {e}");
        }
    });

    *guard = Some(StreamSession {
        stop_tx,
        tasks: vec![ws_task],
        audio_thread: Some(audio_thread),
    });

    Ok(())
}

#[tauri::command]
pub async fn voice_stop_stream(state: tauri::State<'_, VoiceState>) -> Result<(), String> {
    let mut guard = state.stream_state.lock().await;
    let session = guard.take().ok_or("Not streaming")?;

    if let Err(e) = session.stop_tx.send(true) {
        eprintln!("[voice-stream] Failed to send stop signal: {e}");
    }

    for task in session.tasks {
        if let Err(e) = tokio::time::timeout(std::time::Duration::from_secs(2), task).await {
            eprintln!("[voice-stream] Task did not finish within timeout: {e}");
        }
    }

    if let Some(thread) = session.audio_thread {
        if thread.join().is_err() {
            eprintln!("[voice-stream] Audio capture thread panicked");
        }
    }

    Ok(())
}

// ── Audio capture ───────────────────────────────────────────────

fn run_audio_capture(
    device: cpal::Device,
    config: cpal::SupportedStreamConfig,
    target_rate: u32,
    audio_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    stop_rx: tokio::sync::watch::Receiver<bool>,
) {
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
    };

    let device_rate = config.sample_rate().0;
    let device_channels = config.channels();

    let shared_buf: Arc<std::sync::Mutex<Vec<f32>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));

    let stream = match super::capture::build_input_stream(&device, config, shared_buf.clone(), "voice-stream") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            return;
        }
    };

    if let Err(e) = stream.play() {
        eprintln!("[voice-stream] Play error: {e}");
        return;
    }

    // Set up resampler if needed
    let needs_resample = device_rate != target_rate;
    let mut resampler = if needs_resample {
        let params = SincInterpolationParameters {
            sinc_len: 16,
            f_cutoff: 0.90,
            interpolation: SincInterpolationType::Nearest,
            oversampling_factor: 16,
            window: WindowFunction::Blackman2,
        };
        let chunk_size = (device_rate as usize) / 100;
        match SincFixedIn::<f32>::new(
            target_rate as f64 / device_rate as f64,
            2.0,
            params,
            chunk_size,
            1,
        ) {
            Ok(r) => Some((r, chunk_size)),
            Err(e) => {
                eprintln!("[voice-stream] Resampler init error: {e}");
                return;
            }
        }
    } else {
        None
    };

    let channels = device_channels as usize;

    loop {
        if *stop_rx.borrow() {
            break;
        }

        std::thread::sleep(std::time::Duration::from_millis(10));

        let raw_samples: Vec<f32> = {
            let mut b = match shared_buf.lock() {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("[voice] Audio buffer mutex poisoned: {e}");
                    break;
                }
            };
            std::mem::take(&mut *b)
        };

        if raw_samples.is_empty() {
            continue;
        }

        // Convert to mono if stereo
        let mono: Vec<f32> = if channels > 1 {
            raw_samples
                .chunks(channels)
                .map(|ch| ch.iter().sum::<f32>() / channels as f32)
                .collect()
        } else {
            raw_samples
        };

        // Resample to target rate
        let resampled = if let Some((ref mut resampler, chunk_size)) = resampler {
            let mut output = Vec::new();
            for chunk in mono.chunks(chunk_size) {
                let mut input_chunk = chunk.to_vec();
                if input_chunk.len() < chunk_size {
                    input_chunk.resize(chunk_size, 0.0);
                }
                match resampler.process(&[input_chunk], None) {
                    Ok(result) => {
                        if !result.is_empty() {
                            output.extend_from_slice(&result[0]);
                        }
                    }
                    Err(e) => {
                        eprintln!("[voice-stream] Resample error: {e}");
                        continue;
                    }
                }
            }
            output
        } else {
            mono
        };

        if resampled.is_empty() {
            continue;
        }

        // Convert f32 → i16 → bytes (little-endian PCM)
        let mut pcm_bytes: Vec<u8> = Vec::with_capacity(resampled.len() * 2);
        for &s in &resampled {
            let clamped = s.clamp(-1.0, 1.0);
            let sample = (clamped * i16::MAX as f32) as i16;
            pcm_bytes.extend_from_slice(&sample.to_le_bytes());
        }

        if audio_tx.blocking_send(pcm_bytes).is_err() {
            break;
        }
    }

    drop(stream);
}

// ── WebSocket ───────────────────────────────────────────────────

async fn run_websocket(
    url: String,
    auth_header: String,
    mut audio_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    mut stop_rx: tokio::sync::watch::Receiver<bool>,
    app: tauri::AppHandle,
    provider: String,
) {
    use tokio_tungstenite::tungstenite::{
        client::IntoClientRequest, http::HeaderValue, Message,
    };

    let mut request = match url.into_client_request() {
        Ok(r) => r,
        Err(e) => {
            emit_voice_error(&app, &format!("Invalid WebSocket URL: {e}"));
            return;
        }
    };

    request.headers_mut().insert(
        "Authorization",
        match HeaderValue::from_str(&auth_header) {
            Ok(v) => v,
            Err(e) => {
                emit_voice_error(&app, &format!("Invalid auth header: {e}"));
                return;
            }
        },
    );

    let (ws_stream, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(r) => r,
        Err(e) => {
            emit_voice_error(&app, &format!("WebSocket connection failed: {e}"));
            return;
        }
    };

    eprintln!("[voice-stream] WebSocket connected ({provider})");

    use futures_util::{SinkExt, StreamExt};
    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(8));
    keepalive.tick().await;

    let is_deepgram = provider == "deepgram";

    loop {
        tokio::select! {
            chunk = audio_rx.recv() => {
                match chunk {
                    Some(data) => {
                        if let Err(e) = ws_tx.send(Message::Binary(data.into())).await {
                            eprintln!("[voice-stream] Send error: {e}");
                            break;
                        }
                    }
                    None => break,
                }
            }

            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if is_deepgram {
                            handle_deepgram_message(&text, &app);
                        } else {
                            handle_anthropic_message(&text, &app);
                        }
                    }
                    Some(Err(e)) => {
                        emit_voice_error(&app, &format!("WebSocket error: {e}"));
                        break;
                    }
                    None => break,
                    _ => {}
                }
            }

            _ = keepalive.tick() => {
                let ka = serde_json::json!({"type": "KeepAlive"}).to_string();
                if let Err(e) = ws_tx.send(Message::Text(ka.into())).await {
                    eprintln!("[voice-stream] Keepalive error: {e}");
                    break;
                }
            }

            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    let close = serde_json::json!({"type": "CloseStream"}).to_string();
                    if let Err(e) = ws_tx.send(Message::Text(close.into())).await {
                        eprintln!("[voice-stream] ws send CloseStream error: {e}");
                    }
                    // Wait briefly for final transcript
                    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
                    loop {
                        let timeout = tokio::time::timeout_at(deadline, ws_rx.next()).await;
                        match timeout {
                            Ok(Some(Ok(Message::Text(text)))) => {
                                if is_deepgram {
                                    handle_deepgram_message(&text, &app);
                                } else {
                                    handle_anthropic_message(&text, &app);
                                }
                            }
                            _ => break,
                        }
                    }
                    break;
                }
            }
        }
    }

    eprintln!("[voice-stream] WebSocket disconnected ({provider})");
}

// ── Message handlers ────────────────────────────────────────────

fn handle_anthropic_message(text: &str, app: &tauri::AppHandle) {
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[voice] Failed to parse Anthropic message: {e}");
            return;
        }
    };

    let msg_type = parsed["type"].as_str().unwrap_or("");

    match msg_type {
        "TranscriptText" => {
            if let Some(data) = parsed["data"].as_str() {
                if let Err(e) = app.emit("voice-interim", data) {
                    eprintln!("[voice-stream] Failed to emit voice-interim: {e}");
                }
            }
        }
        "TranscriptEndpoint" => {
            if let Err(e) = app.emit("voice-final", ()) {
                eprintln!("[voice-stream] Failed to emit voice-final: {e}");
            }
        }
        "TranscriptError" | "error" => {
            let desc = parsed["description"]
                .as_str()
                .or_else(|| parsed["message"].as_str())
                .unwrap_or("Unknown error");
            emit_voice_error(app, desc);
        }
        _ => {}
    }
}

fn handle_deepgram_message(text: &str, app: &tauri::AppHandle) {
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[voice] Failed to parse Deepgram message: {e}");
            return;
        }
    };

    let msg_type = parsed["type"].as_str().unwrap_or("");

    match msg_type {
        "Results" => {
            let transcript = parsed["channel"]["alternatives"][0]["transcript"]
                .as_str()
                .unwrap_or("");

            if transcript.is_empty() {
                return;
            }

            let is_final = parsed["is_final"].as_bool().unwrap_or(false);
            let speech_final = parsed["speech_final"].as_bool().unwrap_or(false);

            if is_final {
                if let Err(e) = app.emit("voice-interim", transcript) {
                    eprintln!("[voice-stream] Failed to emit voice-interim: {e}");
                }
                if speech_final {
                    if let Err(e) = app.emit("voice-final", ()) {
                        eprintln!("[voice-stream] Failed to emit voice-final: {e}");
                    }
                }
            } else if let Err(e) = app.emit("voice-interim", transcript) {
                eprintln!("[voice-stream] Failed to emit voice-interim: {e}");
            }
        }
        "Metadata" => {}
        "Error" | "error" => {
            let desc = parsed["message"]
                .as_str()
                .or_else(|| parsed["description"].as_str())
                .unwrap_or("Unknown Deepgram error");
            emit_voice_error(app, desc);
        }
        _ => {}
    }
}

fn emit_voice_error(app: &tauri::AppHandle, msg: &str) {
    eprintln!("[voice-stream] Error: {msg}");
    if let Err(e) = app.emit("voice-error", msg) {
        eprintln!("[voice-stream] Failed to emit voice-error: {e}");
    }
}
