use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::file_ops::{read_json, write_json};

use super::marketplace::*;
use super::types::*;

/// Add or remove a plugin key in ~/.claude/settings.json → enabledPlugins
fn set_enabled_plugin(key: &str, enable: bool) -> Result<(), String> {
    let path = crate::config::claude_home().join("settings.json");

    let mut settings: serde_json::Value = if path.exists() {
        read_json(&path)?
    } else {
        serde_json::json!({})
    };

    let plugins = settings
        .as_object_mut()
        .ok_or("settings.json is not an object")?
        .entry("enabledPlugins")
        .or_insert_with(|| serde_json::json!({}));

    if let Some(obj) = plugins.as_object_mut() {
        if enable {
            obj.insert(key.to_string(), serde_json::Value::Bool(true));
        } else {
            obj.remove(key);
        }
    }

    write_json(&path, &settings)
}

/// Reject names containing path traversal sequences or separators
fn validate_plugin_name(name: &str, label: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name == "."
    {
        return Err(format!("Invalid {label}: '{name}'"));
    }
    Ok(())
}

/// Only allow https:// URLs for git clone (blocks file://, ssh://, git://, etc.)
fn validate_git_url(url: &str) -> Result<(), String> {
    // Length limit to prevent abuse
    if url.len() > 500 {
        return Err("Git URL too long (max 500 characters)".to_string());
    }
    // Block git argument injection (URLs starting with -)
    if url.starts_with('-') {
        return Err("Git URL must not start with '-'".to_string());
    }
    if !url.starts_with("https://") {
        return Err(format!(
            "Only HTTPS git URLs are allowed, got: {}",
            url.chars().take(60).collect::<String>()
        ));
    }
    if url.contains("..") {
        return Err("Git URL contains path traversal".to_string());
    }
    // Block URL-encoded traversal (case insensitive)
    let lower = url.to_ascii_lowercase();
    if lower.contains("%2e%2e") || lower.contains("%2f") || lower.contains("%5c") {
        return Err("Git URL contains encoded traversal sequences".to_string());
    }
    Ok(())
}

/// Load all plugin data: installed, available from marketplaces, sources
#[tauri::command]
pub async fn load_plugins() -> Result<PluginsData, String> {
    tokio::task::spawn_blocking(|| {
        let base = super::plugins_dir();

        // ── Installed plugins ──
        let installed_path = base.join("installed_plugins.json");
        let installed: Vec<InstalledPlugin> = if installed_path.exists() {
            let file: InstalledPluginsFile = read_json(&installed_path)?;

            let mut result = Vec::new();
            for (key, entries) in &file.plugins {
                let (plugin_name, marketplace) = super::types::parse_plugin_key(key);

                // Use first (most recent) entry
                if let Some(entry) = entries.first() {
                    let ip = PathBuf::from(&entry.install_path);
                    let skill_count = if ip.exists() { count_skills(&ip) } else { 0 };
                    let description = if ip.exists() {
                        read_plugin_description(&ip)
                    } else {
                        String::new()
                    };

                    result.push(InstalledPlugin {
                        id: key.clone(),
                        name: plugin_name,
                        marketplace,
                        version: entry.version.clone(),
                        scope: if entry.scope.is_empty() {
                            "user".to_string()
                        } else {
                            entry.scope.clone()
                        },
                        install_path: entry.install_path.clone(),
                        installed_at: entry.installed_at.clone(),
                        description,
                        skill_count,
                        enabled: true, // CLI doesn't have disable concept, all installed = enabled
                    });
                }
            }
            result.sort_by(|a, b| a.name.cmp(&b.name));
            result
        } else {
            Vec::new()
        };

        // Build set of installed plugin IDs for "isInstalled" check
        let installed_ids: std::collections::HashSet<String> =
            installed.iter().map(|p| p.id.clone()).collect();

        // ── Install counts ──
        let install_counts = load_install_counts();

        // ── Available plugins (from marketplace repos) ──
        let marketplaces_dir = base.join("marketplaces");
        let mut available: Vec<AvailablePlugin> = Vec::new();

        if marketplaces_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(&marketplaces_dir) {
                for entry in entries.flatten() {
                    let mkt_dir = entry.path();
                    if !mkt_dir.is_dir() {
                        continue;
                    }

                    let marketplace_name = entry.file_name().to_string_lossy().to_string();

                    let manifest_path = mkt_dir.join(".claude-plugin/marketplace.json");
                    if !manifest_path.exists() {
                        continue;
                    }

                    let manifest: MarketplaceManifest =
                        match read_json(&manifest_path) {
                            Ok(m) => m,
                            Err(e) => {
                                eprintln!("[aitherflow] {e}");
                                continue;
                            }
                        };

                    for plugin in manifest.plugins {
                        let plugin_id = format!("{}@{}", plugin.name, marketplace_name);
                        let count_key = plugin_id.clone();

                        available.push(AvailablePlugin {
                            name: plugin.name,
                            description: plugin.description,
                            author: plugin
                                .author
                                .as_ref()
                                .map(|a| a.name().to_string())
                                .unwrap_or_default(),
                            version: plugin.version,
                            category: plugin.category,
                            marketplace: marketplace_name.clone(),
                            is_installed: installed_ids.contains(&plugin_id),
                            install_count: install_counts
                                .get(&count_key)
                                .copied()
                                .unwrap_or(0),
                        });
                    }
                }
            }
        }
        available.sort_by(|a, b| a.name.cmp(&b.name));

        // ── Sources (known marketplaces) ──
        let sources_path = base.join("known_marketplaces.json");
        let sources: Vec<MarketplaceSource> = if sources_path.exists() {
            let file: KnownMarketplacesFile = read_json(&sources_path)?;

            let mut result: Vec<MarketplaceSource> = file
                .0
                .into_iter()
                .map(|(name, entry)| {
                    let (source_type, url) = match entry.source.source.as_str() {
                        "github" => (
                            "github".to_string(),
                            entry.source.repo.unwrap_or_default(),
                        ),
                        "git" => (
                            "git".to_string(),
                            entry.source.url.unwrap_or_default(),
                        ),
                        other => (other.to_string(), String::new()),
                    };
                    MarketplaceSource {
                        name,
                        source_type,
                        url,
                        install_location: entry.install_location,
                        last_updated: entry.last_updated,
                    }
                })
                .collect();
            result.sort_by(|a, b| a.name.cmp(&b.name));
            result
        } else {
            Vec::new()
        };

        Ok(PluginsData {
            installed,
            available,
            sources,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Install a plugin from a marketplace
#[tauri::command]
pub async fn install_plugin(name: String, marketplace: String) -> Result<(), String> {
    validate_plugin_name(&name, "plugin name")?;
    validate_plugin_name(&marketplace, "marketplace")?;
    tokio::task::spawn_blocking(move || {
        let base = super::plugins_dir();

        // Try to find plugin locally first; if not found, try cloning from remote URL
        let marketplace_plugin_dir = match resolve_plugin_source(&base, &marketplace, &name) {
            Some(dir) => dir,
            None => {
                // Check if plugin has a remote URL — clone it to cache directly
                let remote_url =
                    get_plugin_remote_url(&base, &marketplace, &name).ok_or_else(|| {
                        format!(
                            "Plugin '{}' not found in marketplace '{}'",
                            name, marketplace
                        )
                    })?;
                validate_git_url(&remote_url)?;

                let clone_dir = base.join("cache").join(&marketplace).join(&name).join("repo");
                if clone_dir.exists() {
                    // Already cloned, use it
                    clone_dir
                } else {
                    fs::create_dir_all(&clone_dir)
                        .map_err(|e| format!("Failed to create dir: {e}"))?;

                    let output = Command::new("git")
                        .args(["clone", "--depth", "1", &remote_url, "."])
                        .current_dir(&clone_dir)
                        .output()
                        .map_err(|e| format!("Failed to run git clone: {e}"))?;

                    if !output.status.success() {
                        if let Err(e) = fs::remove_dir_all(&clone_dir) {
                            eprintln!("[plugins] Failed to clean up clone dir: {e}");
                        }
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        return Err(format!("Failed to clone plugin: {}", stderr.trim()));
                    }
                    clone_dir
                }
            }
        };

        // Read plugin version from marketplace.json
        let manifest_path = base
            .join("marketplaces")
            .join(&marketplace)
            .join(".claude-plugin/marketplace.json");
        let version = if manifest_path.exists() {
            let manifest: MarketplaceManifest =
                read_json(&manifest_path).unwrap_or(MarketplaceManifest { plugins: vec![] });
            manifest
                .plugins
                .iter()
                .find(|p| p.name == name)
                .map(|p| p.version.clone())
                .unwrap_or_default()
        } else {
            String::new()
        };

        // Determine git commit SHA for the marketplace
        let git_sha = get_git_sha(&base.join("marketplaces").join(&marketplace));

        // Use short sha as version if plugin has no semantic version
        let effective_version = if version.is_empty() {
            git_sha.chars().take(12).collect::<String>()
        } else {
            version
        };

        // Create cache directory
        let cache_dir = base
            .join("cache")
            .join(&marketplace)
            .join(&name)
            .join(&effective_version);

        if cache_dir.exists() {
            // Already installed this version, just update the manifest
        } else {
            // Copy plugin files to cache
            crate::file_ops::copy_dir_recursive(&marketplace_plugin_dir, &cache_dir)?;
        }

        // Normalize: if root SKILL.md exists but skills/ is empty, copy into skills/<name>/
        normalize_plugin_skills(&cache_dir, &name);

        // Update installed_plugins.json
        let installed_path = base.join("installed_plugins.json");
        let mut file: serde_json::Value = if installed_path.exists() {
            read_json(&installed_path)?
        } else {
            serde_json::json!({ "version": 2, "plugins": {} })
        };

        let key = format!("{}@{}", name, marketplace);
        let now = chrono_now();

        let entry = serde_json::json!([{
            "scope": "user",
            "installPath": cache_dir.to_string_lossy(),
            "version": effective_version,
            "installedAt": now,
            "lastUpdated": now,
            "gitCommitSha": git_sha
        }]);

        if let Some(plugins) = file.get_mut("plugins") {
            plugins[&key] = entry;
        }

        write_json(&installed_path, &file)?;

        set_enabled_plugin(&key, true)?;

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// If root SKILL.md exists but skills/ is empty, copy it into skills/<name>/SKILL.md
/// so CLI can discover the skill. Also copies related dirs (references/, prompts/, etc.)
fn normalize_plugin_skills(install_dir: &Path, plugin_name: &str) {
    let root_skill = install_dir.join("SKILL.md");
    if !root_skill.exists() {
        return;
    }

    let skills_dir = install_dir.join("skills");
    // If skills/ already has subdirs with SKILL.md, nothing to do
    if skills_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&skills_dir) {
            let has_skills = entries
                .flatten()
                .any(|e| e.file_type().is_ok_and(|ft| ft.is_dir()) && e.path().join("SKILL.md").exists());
            if has_skills {
                return;
            }
        }
    }

    let target_dir = skills_dir.join(plugin_name);
    if let Err(e) = fs::create_dir_all(&target_dir) {
        eprintln!("[plugins] Failed to create {}: {e}", target_dir.display());
        return;
    }
    if let Err(e) = fs::copy(&root_skill, target_dir.join("SKILL.md")) {
        eprintln!("[plugins] Failed to copy SKILL.md: {e}");
        return;
    }
    for dir_name in &["references", "prompts", "examples", "templates"] {
        let src = install_dir.join(dir_name);
        if src.is_dir() {
            let _ = crate::file_ops::copy_dir_recursive(&src, &target_dir.join(dir_name))
                .map_err(|e| eprintln!("[plugins] Failed to copy {dir_name}/: {e}"));
        }
    }
}

/// Uninstall a plugin
#[tauri::command]
pub async fn uninstall_plugin(name: String, marketplace: String) -> Result<(), String> {
    validate_plugin_name(&name, "plugin name")?;
    validate_plugin_name(&marketplace, "marketplace")?;
    tokio::task::spawn_blocking(move || {
        let base = super::plugins_dir();
        let key = format!("{}@{}", name, marketplace);

        // Read and update installed_plugins.json
        let installed_path = base.join("installed_plugins.json");
        if !installed_path.exists() {
            return Err("No installed plugins file found".to_string());
        }

        let mut file: serde_json::Value = read_json(&installed_path)?;

        if let Some(plugins) = file.get_mut("plugins").and_then(|p| p.as_object_mut()) {
            plugins.remove(&key);
        }

        write_json(&installed_path, &file)?;

        set_enabled_plugin(&key, false)?;

        // Optionally remove cache directory
        let cache_dir = base.join("cache").join(&marketplace).join(&name);
        if cache_dir.exists() {
            if let Err(e) = fs::remove_dir_all(&cache_dir) {
                eprintln!(
                    "[plugins] Failed to remove cache dir {}: {e}",
                    cache_dir.display()
                );
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Normalize any GitHub URL variant into (owner, repo) pair.
/// Accepts: "owner/repo", "https://github.com/owner/repo", "https://github.com/owner/repo.git"
fn parse_github_url(input: &str) -> Result<(String, String), String> {
    let s = input.trim().trim_end_matches('/');

    // Strip common prefixes
    let path = s
        .strip_prefix("https://github.com/")
        .or_else(|| s.strip_prefix("http://github.com/"))
        .or_else(|| s.strip_prefix("github.com/"))
        .unwrap_or(s);

    // Strip .git suffix
    let path = path.strip_suffix(".git").unwrap_or(path);

    // Should be "owner/repo" now
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() != 2 {
        return Err(format!(
            "Could not parse GitHub repo from '{}'. Expected format: owner/repo or https://github.com/owner/repo",
            input
        ));
    }

    let owner = parts[0].to_string();
    let repo = parts[1].to_string();

    if owner.contains('.') || repo.contains("..") {
        return Err("Invalid characters in owner/repo".to_string());
    }

    Ok((owner, repo))
}

/// Add a new marketplace source (git clone)
#[tauri::command]
pub async fn add_marketplace(url: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let (owner, repo) = parse_github_url(&url)?;
        let name = format!("{}-{}", owner, repo);
        let owner_repo = format!("{}/{}", owner, repo);

        validate_plugin_name(&name, "marketplace name")?;

        let base = super::plugins_dir();
        let target_dir = base.join("marketplaces").join(&name);

        if target_dir.exists() {
            return Err(format!("Marketplace '{}' already exists", name));
        }

        let git_url = format!("https://github.com/{}.git", owner_repo);
        validate_git_url(&git_url)?;

        // Git clone
        fs::create_dir_all(&target_dir)
            .map_err(|e| format!("Failed to create directory: {e}"))?;

        let output = Command::new("git")
            .args(["clone", "--depth", "1", &git_url, "."])
            .current_dir(&target_dir)
            .output()
            .map_err(|e| format!("Failed to run git clone: {e}"))?;

        if !output.status.success() {
            if let Err(e) = fs::remove_dir_all(&target_dir) {
                eprintln!(
                    "[plugins] Failed to clean up {}: {e}",
                    target_dir.display()
                );
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Git clone failed: {}", stderr.trim()));
        }

        // Update known_marketplaces.json
        let sources_path = base.join("known_marketplaces.json");
        let mut file: serde_json::Value = if sources_path.exists() {
            read_json(&sources_path).unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        let now = chrono_now();
        file[&name] = serde_json::json!({
            "source": { "source": "github", "repo": owner_repo },
            "installLocation": target_dir.to_string_lossy(),
            "lastUpdated": now
        });

        write_json(&sources_path, &file)?;

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Remove a marketplace source
#[tauri::command]
pub async fn remove_marketplace(name: String) -> Result<(), String> {
    validate_plugin_name(&name, "marketplace name")?;
    tokio::task::spawn_blocking(move || {
        let base = super::plugins_dir();

        // Remove from known_marketplaces.json
        let sources_path = base.join("known_marketplaces.json");
        if sources_path.exists() {
            let mut file: serde_json::Value = read_json(&sources_path)?;

            if let Some(obj) = file.as_object_mut() {
                obj.remove(&name);
            }

            write_json(&sources_path, &file)?;
        }

        // Remove the cloned repo
        let repo_dir = base.join("marketplaces").join(&name);
        if repo_dir.exists() {
            fs::remove_dir_all(&repo_dir)
                .map_err(|e| format!("Failed to remove marketplace directory: {e}"))?;
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Update all marketplace sources (git pull)
#[tauri::command]
pub async fn update_marketplaces() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        let base = super::plugins_dir();
        let marketplaces_dir = base.join("marketplaces");

        if !marketplaces_dir.is_dir() {
            return Ok(());
        }

        let entries = fs::read_dir(&marketplaces_dir)
            .map_err(|e| format!("Failed to read marketplaces dir: {e}"))?;

        let mut errors = Vec::new();

        for entry in entries.flatten() {
            if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                continue;
            }

            let mkt_dir = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            // Check if it's a git repo
            if !mkt_dir.join(".git").exists() {
                continue;
            }

            let output = Command::new("git")
                .args(["pull", "--ff-only"])
                .current_dir(&mkt_dir)
                .output();

            match output {
                Ok(o) if !o.status.success() => {
                    let stderr = String::from_utf8_lossy(&o.stderr);
                    errors.push(format!("{}: {}", name, stderr.trim()));
                }
                Err(e) => {
                    errors.push(format!("{}: {}", name, e));
                }
                _ => {}
            }
        }

        // Update lastUpdated in known_marketplaces.json
        let sources_path = base.join("known_marketplaces.json");
        if sources_path.exists() {
            if let Ok(mut file) = read_json::<serde_json::Value>(&sources_path) {
                let now = chrono_now();
                if let Some(obj) = file.as_object_mut() {
                    for (_, entry) in obj.iter_mut() {
                        if let Some(e) = entry.as_object_mut() {
                            e.insert(
                                "lastUpdated".to_string(),
                                serde_json::Value::String(now.clone()),
                            );
                        }
                    }
                }
                if let Err(e) = write_json(&sources_path, &file) {
                    eprintln!("[plugins] Failed to save marketplace metadata: {e}");
                }
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Some marketplaces failed to update: {}",
                errors.join("; ")
            ))
        }
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
