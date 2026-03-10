use std::fs;
use std::path::PathBuf;
use std::process::Command;

use crate::file_ops::atomic_write;

use super::marketplace::*;
use super::types::*;

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

/// Load all plugin data: installed, available from marketplaces, sources
#[tauri::command]
pub async fn load_plugins() -> Result<PluginsData, String> {
    tokio::task::spawn_blocking(|| {
        let base = super::plugins_dir();

        // ── Installed plugins ──
        let installed_path = base.join("installed_plugins.json");
        let installed: Vec<InstalledPlugin> = if installed_path.exists() {
            let data = fs::read_to_string(&installed_path)
                .map_err(|e| format!("Failed to read installed_plugins.json: {e}"))?;
            let file: InstalledPluginsFile = serde_json::from_str(&data)
                .map_err(|e| format!("Failed to parse installed_plugins.json: {e}"))?;

            let mut result = Vec::new();
            for (key, entries) in &file.plugins {
                // key format: "plugin-name@marketplace"
                let (plugin_name, marketplace) = match key.split_once('@') {
                    Some((p, m)) => (p.to_string(), m.to_string()),
                    None => (key.clone(), String::new()),
                };

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

                    let manifest_data = match fs::read_to_string(&manifest_path) {
                        Ok(d) => d,
                        Err(e) => {
                            eprintln!(
                                "[aitherflow] Failed to read {}: {e}",
                                manifest_path.display()
                            );
                            continue;
                        }
                    };

                    let manifest: MarketplaceManifest =
                        match serde_json::from_str(&manifest_data) {
                            Ok(m) => m,
                            Err(e) => {
                                eprintln!(
                                    "[aitherflow] Failed to parse {}: {e}",
                                    manifest_path.display()
                                );
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
            let data = fs::read_to_string(&sources_path)
                .map_err(|e| format!("Failed to read known_marketplaces.json: {e}"))?;
            let file: KnownMarketplacesFile = serde_json::from_str(&data)
                .map_err(|e| format!("Failed to parse known_marketplaces.json: {e}"))?;

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
            let data = fs::read_to_string(&manifest_path).unwrap_or_default();
            let manifest: MarketplaceManifest =
                serde_json::from_str(&data).unwrap_or(MarketplaceManifest { plugins: vec![] });
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

        // Update installed_plugins.json
        let installed_path = base.join("installed_plugins.json");
        let mut file: serde_json::Value = if installed_path.exists() {
            let data = fs::read_to_string(&installed_path)
                .map_err(|e| format!("Failed to read installed_plugins.json: {e}"))?;
            serde_json::from_str(&data)
                .map_err(|e| format!("Failed to parse installed_plugins.json: {e}"))?
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

        let json_str = serde_json::to_string_pretty(&file)
            .map_err(|e| format!("Failed to serialize: {e}"))?;
        atomic_write(&installed_path, json_str.as_bytes())?;

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
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

        let data = fs::read_to_string(&installed_path)
            .map_err(|e| format!("Failed to read installed_plugins.json: {e}"))?;
        let mut file: serde_json::Value = serde_json::from_str(&data)
            .map_err(|e| format!("Failed to parse installed_plugins.json: {e}"))?;

        if let Some(plugins) = file.get_mut("plugins").and_then(|p| p.as_object_mut()) {
            plugins.remove(&key);
        }

        let json_str = serde_json::to_string_pretty(&file)
            .map_err(|e| format!("Failed to serialize: {e}"))?;
        atomic_write(&installed_path, json_str.as_bytes())?;

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

/// Add a new marketplace source (git clone)
#[tauri::command]
pub async fn add_marketplace(
    name: String,
    source_type: String,
    url: String,
) -> Result<(), String> {
    validate_plugin_name(&name, "marketplace name")?;
    tokio::task::spawn_blocking(move || {
        let base = super::plugins_dir();
        let target_dir = base.join("marketplaces").join(&name);

        if target_dir.exists() {
            return Err(format!("Marketplace '{}' already exists", name));
        }

        // Determine git URL
        let git_url = match source_type.as_str() {
            "github" => format!("https://github.com/{}.git", url),
            "git" => url.clone(),
            _ => return Err(format!("Unknown source type: {}", source_type)),
        };

        // Git clone
        fs::create_dir_all(&target_dir)
            .map_err(|e| format!("Failed to create directory: {e}"))?;

        let output = Command::new("git")
            .args(["clone", "--depth", "1", &git_url, "."])
            .current_dir(&target_dir)
            .output()
            .map_err(|e| format!("Failed to run git clone: {e}"))?;

        if !output.status.success() {
            // Clean up on failure
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
            let data = fs::read_to_string(&sources_path).unwrap_or_default();
            serde_json::from_str(&data).unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        let source_obj = match source_type.as_str() {
            "github" => serde_json::json!({ "source": "github", "repo": url }),
            _ => serde_json::json!({ "source": "git", "url": url }),
        };

        let now = chrono_now();
        file[&name] = serde_json::json!({
            "source": source_obj,
            "installLocation": target_dir.to_string_lossy(),
            "lastUpdated": now
        });

        let json_str = serde_json::to_string_pretty(&file)
            .map_err(|e| format!("Failed to serialize: {e}"))?;
        atomic_write(&sources_path, json_str.as_bytes())?;

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
            let data = fs::read_to_string(&sources_path)
                .map_err(|e| format!("Failed to read: {e}"))?;
            let mut file: serde_json::Value = serde_json::from_str(&data)
                .map_err(|e| format!("Failed to parse: {e}"))?;

            if let Some(obj) = file.as_object_mut() {
                obj.remove(&name);
            }

            let json_str = serde_json::to_string_pretty(&file)
                .map_err(|e| format!("Failed to serialize: {e}"))?;
            atomic_write(&sources_path, json_str.as_bytes())?;
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
            if let Ok(data) = fs::read_to_string(&sources_path) {
                if let Ok(mut file) = serde_json::from_str::<serde_json::Value>(&data) {
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
                    if let Ok(json_str) = serde_json::to_string_pretty(&file) {
                        if let Err(e) = atomic_write(&sources_path, json_str.as_bytes()) {
                            eprintln!("[plugins] Failed to save marketplace metadata: {e}");
                        }
                    }
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
