use std::path::PathBuf;

/// Fallback home when $HOME is unset (containers, systemd units)
fn fallback_home() -> PathBuf {
    PathBuf::from("/tmp")
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
    dirs::home_dir()
        .unwrap_or_else(fallback_home)
        .join(".claude")
}
