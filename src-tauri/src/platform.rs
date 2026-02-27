//! Platform-specific abstractions.
//! All OS-dependent code lives here — the rest of the app doesn't know about the OS.
//! See ARCHITECTURE.md section "platform.rs"

/// Send a desktop notification.
pub fn notify(title: &str, body: &str) {
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("notify-send")
            .args([title, body])
            .spawn()
            .map_err(|e| eprintln!("[platform] notify-send failed: {e}"));
    }

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            body, title
        );
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| eprintln!("[platform] osascript failed: {e}"));
    }
}
