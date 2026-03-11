use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use cpal::traits::DeviceTrait;

/// ~60 MB limit for the audio buffer (~10 min at f32 mono 16 kHz).
const MAX_BUFFER_SAMPLES: usize = 15_000_000;

/// Build a cpal input stream that writes f32 samples into a shared buffer.
/// Supports F32 and I16 sample formats.
pub(super) fn build_input_stream(
    device: &cpal::Device,
    config: cpal::SupportedStreamConfig,
    buffer: Arc<std::sync::Mutex<Vec<f32>>>,
    log_prefix: &'static str,
) -> Result<cpal::Stream, String> {
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => {
            let buf = buffer;
            let warned = Arc::new(AtomicBool::new(false));
            device.build_input_stream(
                &config.into(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if let Ok(mut b) = buf.lock() {
                        if b.len() + data.len() > MAX_BUFFER_SAMPLES {
                            if !warned.swap(true, Ordering::Relaxed) {
                                eprintln!("[{log_prefix}] Audio buffer limit reached (~60 MB), dropping new samples");
                            }
                            return;
                        }
                        b.extend_from_slice(data);
                    }
                },
                move |err| eprintln!("[{log_prefix}] Stream error: {err}"),
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let buf = buffer;
            let warned = Arc::new(AtomicBool::new(false));
            device.build_input_stream(
                &config.into(),
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if let Ok(mut b) = buf.lock() {
                        if b.len() + data.len() > MAX_BUFFER_SAMPLES {
                            if !warned.swap(true, Ordering::Relaxed) {
                                eprintln!("[{log_prefix}] Audio buffer limit reached (~60 MB), dropping new samples");
                            }
                            return;
                        }
                        b.extend(data.iter().map(|&s| s as f32 / i16::MAX as f32));
                    }
                },
                move |err| eprintln!("[{log_prefix}] Stream error: {err}"),
                None,
            )
        }
        format => {
            return Err(format!("[{log_prefix}] Unsupported sample format: {format:?}"));
        }
    };

    stream.map_err(|e| format!("[{log_prefix}] Build stream error: {e}"))
}
