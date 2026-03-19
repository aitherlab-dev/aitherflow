use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::client;
use super::config;
use super::types::{
    ChatMessage, ContentPart, ImageUrlData, MessageContent, Provider, Role,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "avi", "mkv", "mts", "mxf", "r3d", "webm",
];

const MAX_FRAME_SIZE: usize = 10 * 1024 * 1024; // 10 MB per frame

/// JPEG stream markers
const JPEG_SOI: [u8; 2] = [0xFF, 0xD8];
const JPEG_EOI: [u8; 2] = [0xFF, 0xD9];

/// A single extracted frame
#[derive(Debug, Clone)]
pub struct FrameData {
    pub base64: String,
}

/// Vision processing profile
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionProfile {
    #[serde(default)]
    pub frames_per_clip: Option<u32>,
    #[serde(default)]
    pub fps: Option<f32>,
    #[serde(default)]
    pub scene_detection: bool,
    #[serde(default = "default_scene_threshold")]
    pub scene_threshold: f32,
    #[serde(default = "default_resolution")]
    pub resolution: u32,
    #[serde(default = "default_jpeg_quality")]
    pub jpeg_quality: u32,
}

fn default_scene_threshold() -> f32 {
    0.3
}
fn default_resolution() -> u32 {
    720
}
fn default_jpeg_quality() -> u32 {
    5
}

impl Default for VisionProfile {
    fn default() -> Self {
        Self {
            frames_per_clip: Some(5),
            fps: None,
            scene_detection: false,
            scene_threshold: default_scene_threshold(),
            resolution: default_resolution(),
            jpeg_quality: default_jpeg_quality(),
        }
    }
}

/// Result of analyzing a single clip
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipAnalysis {
    pub file_path: String,
    pub file_name: String,
    pub duration_secs: f64,
    pub frames_extracted: usize,
    pub analysis: String,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Check if a file extension indicates a video file.
pub fn is_video_file(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Extract frames from a video file using ffmpeg (pipe, no disk writes).
pub async fn extract_frames(
    video_path: &str,
    profile: &VisionProfile,
) -> Result<Vec<FrameData>, String> {
    check_ffmpeg().await?;
    let p = Path::new(video_path);
    crate::files::validate_path_safe(p)?;

    if !tokio::fs::metadata(p)
        .await
        .map_err(|e| format!("Cannot access {video_path}: {e}"))?
        .is_file()
    {
        return Err(format!("Not a file: {video_path}"));
    }

    let vf_filter = build_video_filter(video_path, profile).await?;

    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-i",
        video_path,
        "-vf",
        &vf_filter,
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-q:v",
        &profile.jpeg_quality.to_string(),
    ]);

    // scene detection needs variable frame rate
    if profile.scene_detection && profile.frames_per_clip.is_none() {
        cmd.args(["-vsync", "vfr"]);
    }

    cmd.args(["pipe:1"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture ffmpeg stdout")?;

    let frames = parse_mjpeg_stream(stdout).await?;

    let status = child
        .wait()
        .await
        .map_err(|e| format!("ffmpeg wait error: {e}"))?;

    if !status.success() && frames.is_empty() {
        let mut stderr_buf = Vec::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_end(&mut stderr_buf).await;
        }
        let stderr_str = String::from_utf8_lossy(&stderr_buf);
        return Err(format!("ffmpeg failed ({}): {}", status, stderr_str));
    }

    Ok(frames)
}

/// Analyze all video/image files in a directory.
pub async fn analyze_directory(
    dir_path: &str,
    profile: &VisionProfile,
    provider: &Provider,
    model: &str,
    prompt: &str,
    max_tokens: Option<u32>,
) -> Result<Vec<ClipAnalysis>, String> {
    let p = Path::new(dir_path);
    crate::files::validate_path_safe(p)?;

    // Get API key in blocking context
    let api_key = {
        let prov = provider.clone();
        tokio::task::spawn_blocking(move || {
            config::get_api_key(&prov)
                .ok_or_else(|| format!("No API key configured for {}", prov.display_name()))
        })
        .await
        .map_err(|e| format!("Task join error: {e}"))??
    };

    // Scan directory for media files in blocking context
    let dir_str = dir_path.to_string();
    let files = tokio::task::spawn_blocking(move || scan_media_files(&dir_str))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    if files.is_empty() {
        return Ok(vec![]);
    }

    let total = files.len();
    let mut results = Vec::with_capacity(total);

    for (idx, file_path) in files.iter().enumerate() {
        eprintln!(
            "[ext-models-vision] Processing {}/{}: {}",
            idx + 1,
            total,
            file_path
        );

        match analyze_single_file(file_path, profile, provider, model, prompt, &api_key, max_tokens)
            .await
        {
            Ok(analysis) => results.push(analysis),
            Err(e) => {
                eprintln!("[ext-models-vision] Error processing {}: {e}", file_path);
                results.push(ClipAnalysis {
                    file_path: file_path.clone(),
                    file_name: Path::new(file_path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    duration_secs: 0.0,
                    frames_extracted: 0,
                    analysis: format!("Error: {e}"),
                });
            }
        }
    }

    eprintln!("[ext-models-vision] Done: {}/{} files processed", results.len(), total);
    Ok(results)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Check that ffmpeg is available.
async fn check_ffmpeg() -> Result<(), String> {
    Command::new("ffmpeg")
        .arg("-version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map_err(|_| "ffmpeg not found, please install ffmpeg".to_string())?;
    Ok(())
}

/// Get video duration in seconds using ffprobe.
async fn get_duration(video_path: &str) -> Result<f64, String> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "quiet",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            video_path,
        ])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| format!("ffprobe failed: {e}"))?;

    if !output.status.success() {
        return Err(format!("ffprobe failed for {video_path}"));
    }

    let duration_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    duration_str
        .parse::<f64>()
        .map_err(|e| format!("Failed to parse duration '{duration_str}': {e}"))
}

/// Build the -vf filter string based on profile strategy.
/// Priority: frames_per_clip > scene_detection > fps
async fn build_video_filter(
    video_path: &str,
    profile: &VisionProfile,
) -> Result<String, String> {
    let scale = format!("scale={}:-1", profile.resolution);

    if let Some(n) = profile.frames_per_clip {
        let duration = get_duration(video_path).await?;
        if duration <= 0.0 {
            return Err("Video has zero duration".into());
        }
        // Extract N frames evenly spaced
        let interval = duration / n as f64;
        Ok(format!("fps=1/{interval:.4},{scale}"))
    } else if profile.scene_detection {
        Ok(format!(
            "select='gt(scene,{threshold})',{scale}",
            threshold = profile.scene_threshold,
        ))
    } else if let Some(fps) = profile.fps {
        Ok(format!("fps={fps},{scale}"))
    } else {
        // Fallback: 5 frames
        let duration = get_duration(video_path).await?;
        let interval = if duration > 0.0 {
            duration / 5.0
        } else {
            1.0
        };
        Ok(format!("fps=1/{interval:.4},{scale}"))
    }
}

/// Parse MJPEG stream from ffmpeg pipe: find JPEG boundaries via SOI/EOI markers.
async fn parse_mjpeg_stream(
    mut reader: tokio::process::ChildStdout,
) -> Result<Vec<FrameData>, String> {
    let mut buf = Vec::with_capacity(512 * 1024);
    let mut frames = Vec::new();

    // Read entire output into memory
    reader
        .read_to_end(&mut buf)
        .await
        .map_err(|e| format!("Failed to read ffmpeg output: {e}"))?;

    // Parse JPEG frames from the MJPEG stream
    let mut pos = 0;
    while pos + 1 < buf.len() {
        // Find SOI marker (0xFF 0xD8)
        let soi_pos = match find_marker(&buf[pos..], &JPEG_SOI) {
            Some(offset) => pos + offset,
            None => break,
        };

        // Find EOI marker (0xFF 0xD9) after SOI
        let search_start = soi_pos + 2;
        let eoi_pos = match find_marker(&buf[search_start..], &JPEG_EOI) {
            Some(offset) => search_start + offset + 2, // include the EOI marker itself
            None => break,
        };

        let frame_data = &buf[soi_pos..eoi_pos];

        if frame_data.len() > MAX_FRAME_SIZE {
            eprintln!(
                "[ext-models-vision] Skipping frame {} — too large ({} bytes)",
                frames.len(),
                frame_data.len()
            );
            pos = eoi_pos;
            continue;
        }

        let b64 = base64::engine::general_purpose::STANDARD.encode(frame_data);
        frames.push(FrameData { base64: b64 });

        pos = eoi_pos;
    }

    Ok(frames)
}

/// Find a 2-byte marker in a byte slice. Returns offset of the marker start.
fn find_marker(data: &[u8], marker: &[u8; 2]) -> Option<usize> {
    data.windows(2).position(|w| w == marker)
}

/// Scan a directory for video and image files. Returns sorted paths.
/// Blocking I/O — must be called from spawn_blocking.
fn scan_media_files(dir_path: &str) -> Result<Vec<String>, String> {
    let p = Path::new(dir_path);
    if !p.is_dir() {
        return Err(format!("Not a directory: {dir_path}"));
    }

    let image_exts = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

    let mut files: Vec<String> = std::fs::read_dir(p)
        .map_err(|e| format!("Failed to read directory {dir_path}: {e}"))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            // Use file_type() instead of path().is_file() to avoid blocking stat()
            let ft = entry.file_type().ok()?;
            if !ft.is_file() {
                return None;
            }
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase())?;

            if VIDEO_EXTENSIONS.contains(&ext.as_str()) || image_exts.contains(&ext.as_str()) {
                Some(path.to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect();

    files.sort();
    Ok(files)
}

/// Analyze a single file (video or image).
async fn analyze_single_file(
    file_path: &str,
    profile: &VisionProfile,
    provider: &Provider,
    model: &str,
    prompt: &str,
    api_key: &str,
    max_tokens: Option<u32>,
) -> Result<ClipAnalysis, String> {
    let file_name = Path::new(file_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let (content_parts, duration, frame_count) = if is_video_file(file_path) {
        let duration = get_duration(file_path).await.unwrap_or(0.0);
        let frames = extract_frames(file_path, profile).await?;
        let count = frames.len();

        let parts: Vec<ContentPart> = frames
            .into_iter()
            .map(|f| ContentPart::ImageUrl {
                image_url: ImageUrlData {
                    url: format!("data:image/jpeg;base64,{}", f.base64),
                },
            })
            .collect();

        (parts, duration, count)
    } else {
        // Image file — encode directly in blocking context
        let path = file_path.to_string();
        let part = tokio::task::spawn_blocking(move || {
            super::mcp_server::encode_image_file(&path)
        })
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

        (vec![part], 0.0, 1)
    };

    if content_parts.is_empty() {
        return Err(format!("No frames extracted from {file_path}"));
    }

    // Build message: images + prompt
    let mut parts = content_parts;
    parts.push(ContentPart::Text {
        text: prompt.to_string(),
    });

    let messages = vec![ChatMessage {
        role: Role::User,
        content: MessageContent::Parts(parts),
    }];

    let response = client::call_model(provider, api_key, model, messages, max_tokens).await?;

    let analysis = response
        .choices
        .first()
        .and_then(|c| c.message.content.as_ref())
        .cloned()
        .unwrap_or_default();

    Ok(ClipAnalysis {
        file_path: file_path.to_string(),
        file_name,
        duration_secs: duration,
        frames_extracted: frame_count,
        analysis,
    })
}
