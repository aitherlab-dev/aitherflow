use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::types::*;

/// Count skills and commands inside a plugin's install path
pub(super) fn count_skills(install_path: &Path) -> usize {
    let mut count = 0;

    // Count skills/<name>/SKILL.md
    let skills_dir = install_path.join("skills");
    if skills_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&skills_dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false)
                    && entry.path().join("SKILL.md").exists()
                {
                    count += 1;
                }
            }
        }
    }

    // Fallback: count root SKILL.md only if skills/ had nothing
    if count == 0 && install_path.join("SKILL.md").exists() {
        count += 1;
    }

    // Count commands/ (flat .md or nested COMMAND.md)
    let commands_dir = install_path.join("commands");
    if commands_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&commands_dir) {
            for entry in entries.flatten() {
                let ft = entry.file_type();
                let path = entry.path();
                let is_md_file = ft.as_ref().is_ok_and(|t| t.is_file())
                    && path.extension().and_then(|e| e.to_str()) == Some("md");
                let is_command_dir =
                    ft.as_ref().is_ok_and(|t| t.is_dir()) && path.join("COMMAND.md").exists();

                if is_md_file || is_command_dir {
                    count += 1;
                }
            }
        }
    }

    count
}

/// Read plugin.json from an install path to get description
pub(super) fn read_plugin_description(install_path: &Path) -> String {
    let plugin_json = install_path.join(".claude-plugin/plugin.json");
    if let Ok(content) = fs::read_to_string(&plugin_json) {
        if let Ok(pj) = serde_json::from_str::<PluginJson>(&content) {
            return pj.description;
        }
    }
    String::new()
}

/// Load install counts from cache
pub(super) fn load_install_counts() -> HashMap<String, u64> {
    let path = super::plugins_dir().join("install-counts-cache.json");
    let data = match fs::read_to_string(&path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[plugins] Failed to read install counts cache: {e}");
            return HashMap::new();
        }
    };
    let file: InstallCountsFile = match serde_json::from_str(&data) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[plugins] Failed to parse install counts cache: {e}");
            return HashMap::new();
        }
    };
    file.counts
        .into_iter()
        .map(|e| (e.plugin, e.unique_installs))
        .collect()
}

/// Resolve the actual directory of a plugin inside a marketplace using the `source` field
pub(super) fn resolve_plugin_source(
    base: &Path,
    marketplace: &str,
    plugin_name: &str,
) -> Option<PathBuf> {
    let mkt_dir = base.join("marketplaces").join(marketplace);
    let manifest_path = mkt_dir.join(".claude-plugin/marketplace.json");
    let data = fs::read_to_string(&manifest_path).ok()?;
    let manifest: MarketplaceManifest = serde_json::from_str(&data).ok()?;

    for plugin in &manifest.plugins {
        if plugin.name == plugin_name {
            if let Some(src) = plugin.source.as_ref().and_then(|s| s.as_local_path()) {
                let resolved = mkt_dir.join(src.trim_start_matches("./"));
                if resolved.exists() {
                    return Some(resolved);
                }
            }
            break;
        }
    }

    // Fallback: try common directory layouts
    for subdir in &["plugins", "external_plugins", ""] {
        let candidate = if subdir.is_empty() {
            mkt_dir.join(plugin_name)
        } else {
            mkt_dir.join(subdir).join(plugin_name)
        };
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

/// Get the remote URL for a plugin from marketplace.json (if it's a remote-source plugin)
pub(super) fn get_plugin_remote_url(
    base: &Path,
    marketplace: &str,
    plugin_name: &str,
) -> Option<String> {
    let mkt_dir = base.join("marketplaces").join(marketplace);
    let manifest_path = mkt_dir.join(".claude-plugin/marketplace.json");
    let data = fs::read_to_string(&manifest_path).ok()?;
    let manifest: MarketplaceManifest = serde_json::from_str(&data).ok()?;

    manifest
        .plugins
        .iter()
        .find(|p| p.name == plugin_name)
        .and_then(|p| p.source.as_ref())
        .and_then(|s| s.as_remote_url())
        .map(|s| s.to_string())
}

/// Get the current git SHA of a repo
pub(super) fn get_git_sha(repo_path: &Path) -> String {
    Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_path)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_default()
}

/// Generate an ISO 8601 timestamp.
pub(super) fn chrono_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
