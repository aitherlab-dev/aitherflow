use std::io::Cursor;
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tokio::sync::Mutex;

/// Shared state managed by Tauri.
/// We only store the audio buffer and a stop signal — the cpal stream
/// lives on its own dedicated thread (not Send).
pub struct VoiceState {
    inner: Arc<Mutex<Option<ActiveRecording>>>,
}

// Safety: ActiveRecording only contains Send types (no cpal::Stream).
// The stream lives on a dedicated std::thread and is stopped via the channel.
unsafe impl Send for VoiceState {}
unsafe impl Sync for VoiceState {}

impl VoiceState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
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
