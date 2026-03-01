use std::path::PathBuf;

/// XDG config directory: ~/.config/aither-flow/
pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("~/.config"))
        .join("aither-flow")
}

/// XDG data directory: ~/.local/share/aither-flow/
pub fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("~/.local/share"))
        .join("aither-flow")
}

/// Default workspace: ~/.config/aither-flow/Workspace/
pub fn workspace_dir() -> PathBuf {
    config_dir().join("Workspace")
}

/// Claude CLI home: ~/.claude/
#[allow(dead_code)]
pub fn claude_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("~"))
        .join(".claude")
}
