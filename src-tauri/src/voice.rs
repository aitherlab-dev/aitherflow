use std::io::Cursor;
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::Resampler;
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::Mutex;

// ── Groq (existing) ─────────────────────────────────────────────

/// Shared state managed by Tauri.
/// We only store the audio buffer and a stop signal — the cpal stream
/// lives on its own dedicated thread (not Send).
pub struct VoiceState {
    inner: Arc<Mutex<Option<ActiveRecording>>>,
    stream_state: Arc<Mutex<Option<StreamSession>>>,
}

// Safety: ActiveRecording only contains Send types (no cpal::Stream).
// The stream lives on a dedicated std::thread and is stopped via the channel.
unsafe impl Send for VoiceState {}
unsafe impl Sync for VoiceState {}

impl VoiceState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            stream_state: Arc::new(Mutex::new(None)),
        }
    }
}

struct ActiveRecording {
    buffer: Arc<std::sync::Mutex<Vec<f32>>>,
    stop_tx: std::sync::mpsc::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
    sample_rate: u32,
    channels: u16,
}

#[tauri::command]
pub async fn voice_start(state: tauri::State<'_, VoiceState>) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if guard.is_some() {
        return Err("Already recording".into());
    }

    let buffer: Arc<std::sync::Mutex<Vec<f32>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let buf_clone = buffer.clone();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();

    // Query device config on a blocking thread first
    let (sample_rate, channels) = tokio::task::spawn_blocking(|| -> Result<(u32, u16), String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or("No input device found")?;
        let config = device
            .default_input_config()
            .map_err(|e| format!("Failed to get input config: {e}"))?;
        Ok((config.sample_rate().0, config.channels()))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    // Spawn a dedicated OS thread for the cpal stream (not Send, can't use tokio)
    let thread = std::thread::spawn(move || {
        let host = cpal::default_host();
        let device = match host.default_input_device() {
            Some(d) => d,
            None => {
                eprintln!("[voice] No input device");
                return;
            }
        };
        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[voice] Config error: {e}");
                return;
            }
        };

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => {
                let buf = buf_clone.clone();
                device.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        if let Ok(mut b) = buf.lock() {
                            b.extend_from_slice(data);
                        }
                    },
                    |err| eprintln!("[voice] Stream error: {err}"),
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let buf = buf_clone.clone();
                device.build_input_stream(
                    &config.into(),
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        if let Ok(mut b) = buf.lock() {
                            b.extend(data.iter().map(|&s| s as f32 / i16::MAX as f32));
                        }
                    },
                    |err| eprintln!("[voice] Stream error: {err}"),
                    None,
                )
            }
            format => {
                eprintln!("[voice] Unsupported format: {format:?}");
                return;
            }
        };

        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[voice] Build stream error: {e}");
                return;
            }
        };

        if let Err(e) = stream.play() {
            eprintln!("[voice] Play error: {e}");
            return;
        }

        // Block until stop signal
        let _ = stop_rx.recv();
        drop(stream);
    });

    *guard = Some(ActiveRecording {
        buffer,
        stop_tx,
        thread: Some(thread),
        sample_rate,
        channels,
    });

    Ok(())
}

#[tauri::command]
pub async fn voice_stop(state: tauri::State<'_, VoiceState>) -> Result<Vec<u8>, String> {
    let mut guard = state.inner.lock().await;
    let mut recording = guard.take().ok_or("Not recording")?;

    // Signal the recording thread to stop
    let _ = recording.stop_tx.send(());

    // Wait for the thread to finish
    if let Some(thread) = recording.thread.take() {
        thread.join().map_err(|_| "Recording thread panicked")?;
    }

    let buffer = recording.buffer;
    let sample_rate = recording.sample_rate;
    let channels = recording.channels;

    tokio::task::spawn_blocking(move || {
        let samples = buffer.lock().map_err(|e| format!("Lock error: {e}"))?;

        if samples.is_empty() {
            return Err("No audio recorded".into());
        }

        // Encode to WAV in memory
        let mut wav_buf = Cursor::new(Vec::new());
        let spec = hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::new(&mut wav_buf, spec)
            .map_err(|e| format!("WAV writer error: {e}"))?;

        for &sample in samples.iter() {
            let clamped = sample.clamp(-1.0_f32, 1.0_f32);
            let int_sample = (clamped * i16::MAX as f32) as i16;
            writer
                .write_sample(int_sample)
                .map_err(|e| format!("WAV write error: {e}"))?;
        }

        writer
            .finalize()
            .map_err(|e| format!("WAV finalize error: {e}"))?;

        Ok(wav_buf.into_inner())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

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

    // Response: { "text": "transcribed text" }
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

    // Post-process with LLM: fix punctuation, formatting, typos
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

// ── Anthropic native STT (streaming) ────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicAuthStatus {
    pub available: bool,
    pub expired: bool,
}

/// Read OAuth credentials from CLI's credentials file.
fn read_oauth_token() -> Result<(String, u64), String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let cred_path = home.join(".claude").join(".credentials.json");

    let data = std::fs::read_to_string(&cred_path)
        .map_err(|_| "Not logged in to Claude CLI (no credentials file)")?;

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
    tokio::task::spawn_blocking(|| {
        match read_oauth_token() {
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
            Err(_) => Ok(AnthropicAuthStatus {
                available: false,
                expired: false,
            }),
        }
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Active streaming session state
struct StreamSession {
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
    api_key: String,
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

    // Get audio device config
    let (device_sample_rate, device_channels) =
        tokio::task::spawn_blocking(|| -> Result<(u32, u16), String> {
            let host = cpal::default_host();
            let device = host
                .default_input_device()
                .ok_or("No input device found")?;
            let config = device
                .default_input_config()
                .map_err(|e| format!("Failed to get input config: {e}"))?;
            Ok((config.sample_rate().0, config.channels()))
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
                device_sample_rate,
                device_channels,
                target_rate,
                audio_tx,
                stop_rx,
            );
        })
    };

    // Spawn WebSocket task
    let prov = provider.clone();
    let ws_task = tokio::spawn(run_websocket(
        ws_url,
        auth_header,
        audio_rx,
        stop_rx2,
        app.clone(),
        prov,
    ));

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

    // Signal stop
    let _ = session.stop_tx.send(true);

    // Wait for tasks with timeout
    for task in session.tasks {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), task).await;
    }

    // Wait for audio thread
    if let Some(thread) = session.audio_thread {
        let _ = thread.join();
    }

    Ok(())
}

/// Capture audio from microphone, resample to target_rate, send as PCM i16 chunks.
fn run_audio_capture(
    device_rate: u32,
    device_channels: u16,
    target_rate: u32,
    audio_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    stop_rx: tokio::sync::watch::Receiver<bool>,
) {
    use rubato::{SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};

    let host = cpal::default_host();
    let device = match host.default_input_device() {
        Some(d) => d,
        None => {
            eprintln!("[voice-stream] No input device");
            return;
        }
    };
    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[voice-stream] Config error: {e}");
            return;
        }
    };

    // Shared buffer: cpal callback writes here, we read from it periodically
    let shared_buf: Arc<std::sync::Mutex<Vec<f32>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let buf_writer = shared_buf.clone();

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if let Ok(mut b) = buf_writer.lock() {
                    b.extend_from_slice(data);
                }
            },
            |err| eprintln!("[voice-stream] Stream error: {err}"),
            None,
        ),
        cpal::SampleFormat::I16 => {
            let buf = buf_writer;
            device.build_input_stream(
                &config.into(),
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if let Ok(mut b) = buf.lock() {
                        b.extend(data.iter().map(|&s| s as f32 / i16::MAX as f32));
                    }
                },
                |err| eprintln!("[voice-stream] Stream error: {err}"),
                None,
            )
        }
        format => {
            eprintln!("[voice-stream] Unsupported format: {format:?}");
            return;
        }
    };

    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[voice-stream] Build stream error: {e}");
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
        // Process in chunks of ~10ms
        let chunk_size = (device_rate as usize) / 100;
        match SincFixedIn::<f32>::new(
            target_rate as f64 / device_rate as f64,
            2.0,
            params,
            chunk_size,
            1, // mono
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

    // Read loop: grab from shared buffer, resample, send
    loop {
        // Check stop signal
        if *stop_rx.borrow() {
            break;
        }

        std::thread::sleep(std::time::Duration::from_millis(10));

        let raw_samples: Vec<f32> = {
            let mut b = match shared_buf.lock() {
                Ok(b) => b,
                Err(_) => break,
            };
            let data = b.clone();
            b.clear();
            data
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
                // Pad last chunk if needed
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
        let pcm_bytes: Vec<u8> = resampled
            .iter()
            .flat_map(|&s| {
                let clamped = s.clamp(-1.0, 1.0);
                let sample = (clamped * i16::MAX as f32) as i16;
                sample.to_le_bytes()
            })
            .collect();

        // Send to WebSocket task (non-blocking)
        if audio_tx.blocking_send(pcm_bytes).is_err() {
            break; // Receiver dropped
        }
    }

    drop(stream);
}

/// Connect to STT WebSocket, send audio, emit transcript events.
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

    // Keepalive timer (Anthropic needs it, Deepgram uses KeepAlive too)
    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(8));
    keepalive.tick().await; // skip first immediate tick

    let is_deepgram = provider == "deepgram";

    loop {
        tokio::select! {
            // Audio chunk from microphone
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

            // WebSocket message from server
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

            // Keepalive
            _ = keepalive.tick() => {
                let ka = if is_deepgram {
                    serde_json::json!({"type": "KeepAlive"}).to_string()
                } else {
                    serde_json::json!({"type": "KeepAlive"}).to_string()
                };
                if let Err(e) = ws_tx.send(Message::Text(ka.into())).await {
                    eprintln!("[voice-stream] Keepalive error: {e}");
                    break;
                }
            }

            // Stop signal
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    if is_deepgram {
                        // Deepgram: send CloseStream then wait for final
                        let close = serde_json::json!({"type": "CloseStream"}).to_string();
                        let _ = ws_tx.send(Message::Text(close.into())).await;
                    } else {
                        let close = serde_json::json!({"type": "CloseStream"}).to_string();
                        let _ = ws_tx.send(Message::Text(close.into())).await;
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

fn handle_anthropic_message(text: &str, app: &tauri::AppHandle) {
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    let msg_type = parsed["type"].as_str().unwrap_or("");

    match msg_type {
        "TranscriptText" => {
            if let Some(data) = parsed["data"].as_str() {
                let _ = app.emit("voice-interim", data);
            }
        }
        "TranscriptEndpoint" => {
            let _ = app.emit("voice-final", ());
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

/// Deepgram sends full transcript per segment.
/// is_final=false → interim (replaces previous), is_final=true → finalized segment.
/// speech_final=true → utterance boundary.
fn handle_deepgram_message(text: &str, app: &tauri::AppHandle) {
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
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
                // Finalized segment — emit as final text
                let _ = app.emit("voice-interim", transcript);
                if speech_final {
                    let _ = app.emit("voice-final", ());
                }
            } else {
                // Interim — emit for live preview (will be replaced)
                let _ = app.emit("voice-interim", transcript);
            }
        }
        "Metadata" => {} // ignore
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
    let _ = app.emit("voice-error", msg);
}
