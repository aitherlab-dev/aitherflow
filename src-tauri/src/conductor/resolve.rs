//! Binary resolution helpers — find claude CLI and MCP sidecars on disk.

/// Find the mcp-image-gen binary. Checks next to current exe (workspace dev build
/// and Tauri sidecar bundle).
pub fn resolve_mcp_image_gen_binary() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;

    // Plain name (workspace dev build — both binaries in target/debug/)
    let plain = dir.join("mcp-image-gen");
    if plain.exists() {
        return Some(plain);
    }

    // Tauri sidecar with target triple
    let target_triple = if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin"
        } else {
            "x86_64-apple-darwin"
        }
    } else {
        "x86_64-unknown-linux-gnu"
    };
    let with_triple = dir.join(format!("mcp-image-gen-{target_triple}"));
    if with_triple.exists() {
        return Some(with_triple);
    }

    None
}

/// Read HuggingFace token from ~/.cache/huggingface/token (if it exists).
pub(super) fn read_hf_token() -> Option<String> {
    let path = dirs::home_dir()?.join(".cache/huggingface/token");
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Resolve the `claude` CLI binary path.
/// Checks PATH first, then common install locations per platform.
pub(super) fn resolve_claude_binary() -> String {
    // Check if `claude` is already in PATH
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = std::process::Command::new(which_cmd)
        .arg("claude")
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .lines().next().unwrap_or("").trim().to_string();
            if !path.is_empty() {
                return path;
            }
        }
    }

    // Common locations to check
    let home = dirs::home_dir().unwrap_or_default();
    eprintln!("[conductor] resolve_claude_binary: home={}", home.display());
    let mut candidates: Vec<std::path::PathBuf> = vec![
        // npm global (unix)
        home.join(".local/node/bin/claude"),
        home.join(".local/bin/claude"),
        home.join(".nvm/current/bin/claude"),
    ];
    // macOS / Homebrew
    #[cfg(target_os = "macos")]
    {
        candidates.push("/usr/local/bin/claude".into());
        candidates.push("/opt/homebrew/bin/claude".into());
    }
    candidates.extend([
        // npm global (default)
        home.join(".npm-global/bin/claude"),
        // fnm / volta
        home.join(".local/share/fnm/aliases/default/bin/claude"),
        home.join(".volta/bin/claude"),
    ]);
    // Windows
    #[cfg(target_os = "windows")]
    {
        candidates.push(home.join("AppData/Roaming/npm/claude.cmd"));
        candidates.push(home.join("AppData/Roaming/npm/claude"));
    }

    for candidate in &candidates {
        let exists = candidate.exists();
        eprintln!("[conductor] checking {}: {}", candidate.display(), exists);
        if exists {
            eprintln!("[conductor] resolved claude at: {}", candidate.display());
            return candidate.to_string_lossy().into_owned();
        }
    }

    eprintln!("[conductor] claude not found in any known location");
    // Fallback — let the OS try to find it
    "claude".to_string()
}
