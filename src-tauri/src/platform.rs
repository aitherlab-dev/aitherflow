//! Platform-specific abstractions.
//! All OS-dependent code lives here — the rest of the app doesn't know about the OS.
//! See ARCHITECTURE.md section "platform.rs"

/// Send a desktop notification.
#[allow(dead_code)]
pub fn notify(title: &str, body: &str) {
    #[cfg(target_os = "linux")]
    {
        if let Err(e) = std::process::Command::new("notify-send")
            .args([title, body])
            .spawn()
        {
            eprintln!("[platform] notify-send failed: {e}");
        }
    }

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            body, title
        );
        if let Err(e) = std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
        {
            eprintln!("[platform] osascript failed: {e}");
        }
    }
}
