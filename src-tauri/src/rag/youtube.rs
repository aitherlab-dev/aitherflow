use std::process::Command;

/// Fetch YouTube video transcript using yt-dlp.
/// NOTE: always called from spawn_blocking (see commands.rs).
pub fn fetch_youtube_transcript(url: &str) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join(format!("aitherflow-yt-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {e}"))?;

    let output_template = temp_dir.join("%(id)s");

    let output = Command::new("yt-dlp")
        .args([
            "--skip-download",
            "--write-auto-sub",
            "--sub-lang",
            "en,ru",
            "--convert-subs",
            "vtt",
            "-o",
            output_template.to_str().ok_or("Invalid temp path")?,
            "--",
            url,
        ])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "yt-dlp not found, install it: pip install yt-dlp".to_string()
            } else {
                format!("Failed to run yt-dlp: {e}")
            }
        })?;

    // yt-dlp may return non-zero exit code even when some subtitles were downloaded
    // (e.g. en OK but ru got 429). Check for .vtt files regardless of exit code.
    let vtt_result = find_and_read_vtt(&temp_dir);

    if !output.status.success() && vtt_result.is_err() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Cleanup before returning error
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(format!("yt-dlp failed: {stderr}"));
    }

    let vtt_content = vtt_result.inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&temp_dir);
    })?;

    // Cleanup temp files
    if let Err(e) = std::fs::remove_dir_all(&temp_dir) {
        eprintln!("[rag] Failed to cleanup temp dir: {e}");
    }

    let text = parse_vtt(&vtt_content);
    if text.is_empty() {
        return Err("No transcript content found in subtitles".into());
    }

    Ok(text)
}

/// Find and read the first .vtt file in the temp directory.
fn find_and_read_vtt(dir: &std::path::Path) -> Result<String, String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to read temp dir: {e}"))?;

    for entry in entries.filter_map(|e| match e {
        Ok(entry) => Some(entry),
        Err(e) => {
            eprintln!("[rag] Failed to read temp dir entry: {e}");
            None
        }
    }) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("vtt") {
            return std::fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read VTT file: {e}"));
        }
    }

    Err("No subtitle file found — video may not have captions".into())
}

/// Parse VTT subtitle file into clean text.
/// Removes timestamps, duplicate lines, and VTT headers.
fn parse_vtt(vtt: &str) -> String {
    let mut lines = Vec::new();
    let mut prev_line = String::new();

    for line in vtt.lines() {
        let trimmed = line.trim();

        // Skip VTT header and empty lines
        if trimmed.is_empty()
            || trimmed.starts_with("WEBVTT")
            || trimmed.starts_with("Kind:")
            || trimmed.starts_with("Language:")
            || trimmed.starts_with("NOTE")
        {
            continue;
        }

        // Skip timestamp lines (00:00:00.000 --> 00:00:05.000)
        if trimmed.contains("-->") {
            continue;
        }

        // Skip numeric cue identifiers
        if trimmed.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }

        // Strip VTT tags like <c>, </c>, <00:00:01.234>
        let clean = strip_vtt_tags(trimmed);
        let clean = clean.trim();

        if clean.is_empty() {
            continue;
        }

        // Skip duplicate consecutive lines (common in auto-subs)
        if clean == prev_line {
            continue;
        }

        prev_line = clean.to_string();
        lines.push(clean.to_string());
    }

    lines.join(" ")
}

/// Remove VTT formatting tags: <c>, </c>, <00:00:01.234>, etc.
fn strip_vtt_tags(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut in_tag = false;

    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }

    result
}
