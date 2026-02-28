use std::path::PathBuf;

use crate::config;

const DEFAULT_CLAUDE_MD: &str = r#"# Workspace

This is the default workspace for Aither Flow.
"#;

/// Ensure the default workspace directory exists with a CLAUDE.md file.
/// Returns the workspace path.
#[tauri::command]
pub async fn ensure_default_workspace() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let workspace_dir: PathBuf = config::config_dir().join("workspace");
        std::fs::create_dir_all(&workspace_dir).map_err(|e| {
            eprintln!("[aitherflow] failed to create workspace dir: {e}");
            format!("Failed to create workspace directory: {e}")
        })?;

        let claude_md = workspace_dir.join("CLAUDE.md");
        if !claude_md.exists() {
            std::fs::write(&claude_md, DEFAULT_CLAUDE_MD).map_err(|e| {
                eprintln!("[aitherflow] failed to write CLAUDE.md: {e}");
                format!("Failed to write CLAUDE.md: {e}")
            })?;
        }

        Ok(workspace_dir.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
