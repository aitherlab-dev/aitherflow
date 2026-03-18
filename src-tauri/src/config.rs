use std::path::PathBuf;

/// Home directory with fallback for environments where $HOME is unset.
pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(fallback_home)
}

/// Fallback home when $HOME is unset (containers, systemd units).
/// Uses XDG_RUNTIME_DIR (/run/user/{UID}) which is per-user and mode 0700.
fn fallback_home() -> PathBuf {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        eprintln!("[config] WARNING: $HOME unset, using XDG_RUNTIME_DIR={}", dir.to_string_lossy());
        return PathBuf::from(dir);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(meta) = std::fs::metadata("/proc/self") {
            let p = PathBuf::from(format!("/run/user/{}", meta.uid()));
            eprintln!("[config] WARNING: $HOME unset, falling back to {}", p.display());
            return p;
        }
    }
    let p = std::env::temp_dir().join("aither-flow-fallback");
    eprintln!("[config] WARNING: $HOME unset, falling back to {}", p.display());
    p
}

/// XDG config directory: ~/.config/aither-flow/
pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| fallback_home().join(".config"))
        .join("aither-flow")
}

/// XDG data directory: ~/.local/share/aither-flow/
pub fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| fallback_home().join(".local/share"))
        .join("aither-flow")
}

/// Default workspace: ~/.config/aither-flow/Workspace/
pub fn workspace_dir() -> PathBuf {
    config_dir().join("Workspace")
}

/// Return default workspace path (called from frontend on startup)
#[tauri::command]
pub fn get_workspace_path() -> String {
    workspace_dir().to_string_lossy().into_owned()
}

/// Claude CLI home: ~/.claude/
pub fn claude_home() -> PathBuf {
    home_dir().join(".claude")
}
