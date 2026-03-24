use std::process::Command;

/// A single video entry from a playlist.
pub struct PlaylistEntry {
    pub url: String,
    pub title: String,
}

/// Check if a URL looks like a YouTube playlist (not a single video).
/// Note: watch?v=...&list=... is treated as a single video, not a playlist —
/// the user likely wants that specific video, not the entire playlist.
pub fn is_playlist_url(url: &str) -> bool {
    // Dedicated playlist page: youtube.com/playlist?list=...
    if url.contains("/playlist?") {
        return true;
    }
    // URL with list= but NO v= → playlist page (e.g. shortened links)
    if url.contains("list=") && !url.contains("v=") {
        return true;
    }
    false
}

/// Fetch the list of video URLs and titles from a YouTube playlist using yt-dlp.
/// NOTE: always called from spawn_blocking.
pub fn fetch_playlist_urls(url: &str) -> Result<Vec<PlaylistEntry>, String> {
    let output = Command::new("yt-dlp")
        .args([
            "--flat-playlist",
            "--print",
            "url",
            "--print",
            "title",
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

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp playlist fetch failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.lines().collect();

    // --print url + --print title outputs pairs of lines: url\ntitle\nurl\ntitle\n...
    let mut entries = Vec::new();
    for chunk in lines.chunks(2) {
        if chunk.len() == 2 {
            let video_url = chunk[0].trim().to_string();
            let title = chunk[1].trim().to_string();
            if !video_url.is_empty() {
                entries.push(PlaylistEntry {
                    url: video_url,
                    title,
                });
            }
        }
    }

    if entries.is_empty() {
        return Err("Playlist is empty or could not be parsed".into());
    }

    Ok(entries)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_vtt ---

    #[test]
    fn vtt_basic_transcript() {
        let vtt = "WEBVTT\nKind: captions\nLanguage: en\n\n00:00:00.000 --> 00:00:02.000\nHello world\n\n00:00:02.000 --> 00:00:04.000\nGoodbye world";
        let result = parse_vtt(vtt);
        assert_eq!(result, "Hello world Goodbye world");
    }

    #[test]
    fn vtt_deduplicates_consecutive_lines() {
        let vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n\n00:00:01.000 --> 00:00:02.000\nHello\n\n00:00:02.000 --> 00:00:03.000\nWorld";
        let result = parse_vtt(vtt);
        assert_eq!(result, "Hello World");
    }

    #[test]
    fn vtt_strips_tags() {
        let vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<c>Hello</c> <00:00:01.234>world";
        let result = parse_vtt(vtt);
        assert_eq!(result, "Hello world");
    }

    #[test]
    fn vtt_skips_numeric_cues() {
        let vtt = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nHello\n\n2\n00:00:02.000 --> 00:00:04.000\nWorld";
        let result = parse_vtt(vtt);
        assert_eq!(result, "Hello World");
    }

    #[test]
    fn vtt_empty() {
        assert_eq!(parse_vtt(""), "");
        assert_eq!(parse_vtt("WEBVTT\n\n"), "");
    }

    #[test]
    fn vtt_skips_note() {
        let vtt = "WEBVTT\n\nNOTE This is a comment\n\n00:00:00.000 --> 00:00:02.000\nHello";
        let result = parse_vtt(vtt);
        assert_eq!(result, "Hello");
    }

    // --- strip_vtt_tags ---

    #[test]
    fn strip_tags_basic() {
        assert_eq!(strip_vtt_tags("<c>Hello</c>"), "Hello");
    }

    #[test]
    fn strip_tags_timestamp() {
        assert_eq!(strip_vtt_tags("<00:00:01.234>world"), "world");
    }

    #[test]
    fn strip_tags_no_tags() {
        assert_eq!(strip_vtt_tags("plain text"), "plain text");
    }

    #[test]
    fn strip_tags_empty() {
        assert_eq!(strip_vtt_tags(""), "");
    }

    // --- is_playlist_url ---

    #[test]
    fn playlist_dedicated_page() {
        assert!(is_playlist_url("https://youtube.com/playlist?list=PLxxx"));
    }

    #[test]
    fn playlist_list_without_video() {
        assert!(is_playlist_url("https://youtube.com/?list=PLxxx"));
    }

    #[test]
    fn playlist_single_video_with_list() {
        // watch?v=...&list=... is a single video, not a playlist
        assert!(!is_playlist_url("https://youtube.com/watch?v=abc&list=PLxxx"));
    }

    #[test]
    fn playlist_regular_video() {
        assert!(!is_playlist_url("https://youtube.com/watch?v=abc123"));
    }

    #[test]
    fn playlist_empty() {
        assert!(!is_playlist_url(""));
    }
}
