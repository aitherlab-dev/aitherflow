use std::io::Cursor;
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tokio::sync::Mutex;

/// Shared state managed by Tauri.
/// We only store the audio buffer and a stop signal — the cpal stream
/// lives on its own dedicated thread (not Send).
pub struct VoiceState {
    pub(crate) inner: Arc<Mutex<Option<ActiveRecording>>>,
    pub(crate) stream_state: Arc<Mutex<Option<super::streaming::StreamSession>>>,
}

impl VoiceState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            stream_state: Arc::new(Mutex::new(None)),
        }
    }
}

pub(crate) struct ActiveRecording {
    pub buffer: Arc<std::sync::Mutex<Vec<f32>>>,
    pub stop_tx: std::sync::mpsc::Sender<()>,
    pub thread: Option<std::thread::JoinHandle<()>>,
    pub sample_rate: u32,
    pub channels: u16,
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

    // Query device + config once on a blocking thread, then move into the recording thread.
    // This avoids a second default_input_device() call that could return a different device.
    let (device, supported_config) = tokio::task::spawn_blocking(|| -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
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

    let sample_rate = supported_config.sample_rate().0;
    let channels = supported_config.channels();

    // Channel for the recording thread to signal successful start
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    // Spawn a dedicated OS thread for the cpal stream (not Send, can't use tokio)
    let thread = std::thread::spawn(move || {
        let stream = match super::capture::build_input_stream(&device, supported_config, buf_clone, "voice") {
            Ok(s) => s,
            Err(e) => {
                if let Err(send_err) = ready_tx.send(Err(e)) {
                    eprintln!("[voice] Failed to send build_input_stream error: {send_err:?}");
                }
                return;
            }
        };

        if let Err(e) = stream.play() {
            if let Err(send_err) = ready_tx.send(Err(format!("[voice] Play error: {e}"))) {
                eprintln!("[voice] Failed to send play error: {send_err:?}");
            }
            return;
        }

        if let Err(send_err) = ready_tx.send(Ok(())) {
            eprintln!("[voice] Failed to send ready signal: {send_err:?}");
        }

        // Block until stop signal
        if let Err(e) = stop_rx.recv() {
            eprintln!("[voice] Stop signal recv error: {e}");
        }
        drop(stream);
    });

    // Wait for the thread to report success or failure
    let start_result = ready_rx
        .recv()
        .unwrap_or_else(|_| Err("Recording thread exited unexpectedly".into()));

    if let Err(e) = start_result {
        // Thread failed — join it and don't store ActiveRecording
        if let Err(e) = thread.join() {
            eprintln!("[voice] Recording thread panicked on join: {e:?}");
        }
        return Err(e);
    }

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
    if let Err(e) = recording.stop_tx.send(()) {
        eprintln!("[voice] Failed to send stop signal: {e}");
    }

    // Wait for the thread to finish (blocking — run off tokio)
    let thread_handle = recording.thread.take();
    if let Some(t) = thread_handle {
        let join_result = tokio::task::spawn_blocking(move || t.join())
            .await
            .map_err(|e| format!("Join task error: {e}"))?;
        if join_result.is_err() {
            return Err("Recording thread panicked — audio data may be corrupted".into());
        }
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
