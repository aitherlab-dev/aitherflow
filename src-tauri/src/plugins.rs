use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::config;
use crate::file_ops::atomic_write;

// ── Output types (sent to frontend) ──

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub name: String,
    pub marketplace: String,
    pub version: String,
    pub scope: String,
    pub install_path: String,
    pub installed_at: String,
    pub description: String,
    pub skill_count: usize,
    pub enabled: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePlugin {
    pub name: String,
    pub description: String,
    pub author: String,
    pub version: String,
    pub category: String,
    pub marketplace: String,
    pub is_installed: bool,
    pub install_count: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSource {
    pub name: String,
    pub source_type: String,
    pub url: String,
    pub install_location: String,
    pub last_updated: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginsData {
    pub installed: Vec<InstalledPlugin>,
    pub available: Vec<AvailablePlugin>,
    pub sources: Vec<MarketplaceSource>,
}

// ── JSON structures on disk (CLI-managed files) ──

#[derive(Deserialize, Debug)]
pub(crate) struct InstalledPluginsFile {
    #[serde(default)]
    pub plugins: HashMap<String, Vec<InstalledEntry>>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledEntry {
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub install_path: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub installed_at: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct KnownMarketplacesFile(HashMap<String, MarketplaceEntry>);

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct MarketplaceEntry {
    source: MarketplaceSourceDef,
    #[serde(default)]
    install_location: String,
    #[serde(default)]
    last_updated: String,
}

#[derive(Deserialize, Debug)]
struct MarketplaceSourceDef {
    source: String,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Deserialize, Debug)]
struct MarketplaceManifest {
    #[serde(default)]
    plugins: Vec<MarketplacePluginEntry>,
}

#[derive(Deserialize, Debug)]
struct MarketplacePluginEntry {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    author: Option<AuthorField>,
    #[serde(default)]
    source: Option<PluginSourceField>,
}

#[derive(Deserialize, Debug)]
#[serde(untagged)]
enum PluginSourceField {
    /// Local path like "./plugins/feature-dev"
    Path(String),
    /// Remote source like { "source": "url", "url": "https://..." }
    Remote {
        #[allow(dead_code)]
        url: Option<String>,
    },
}

impl PluginSourceField {
    fn as_local_path(&self) -> Option<&str> {
        match self {
            PluginSourceField::Path(s) => Some(s),
            PluginSourceField::Remote { .. } => None,
        }
    }

    fn as_remote_url(&self) -> Option<&str> {
        match self {
            PluginSourceField::Remote { url } => url.as_deref(),
            PluginSourceField::Path(_) => None,
        }
    }
}

#[derive(Deserialize, Debug)]
#[serde(untagged)]
enum AuthorField {
    Struct { name: String },
    Plain(String),
}

impl AuthorField {
    fn name(&self) -> &str {
        match self {
            AuthorField::Struct { name } => name,
            AuthorField::Plain(s) => s,
        }
    }
}

#[derive(Deserialize, Debug)]
struct PluginJson {
    #[serde(default)]
    #[allow(dead_code)]
    name: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize, Debug)]
struct InstallCountsFile {
    #[serde(default)]
    counts: Vec<InstallCountEntry>,
}

#[derive(Deserialize, Debug)]
struct InstallCountEntry {
    #[serde(default)]
    plugin: String,
    #[serde(default)]
    unique_installs: u64,
}

// ── Helpers ──

fn plugins_dir() -> PathBuf {
    config::claude_home().join("plugins")
}

/// Count skills and commands inside a plugin's install path
fn count_skills(install_path: &Path) -> usize {
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
fn read_plugin_description(install_path: &Path) -> String {
    let plugin_json = install_path.join(".claude-plugin/plugin.json");
    if let Ok(content) = fs::read_to_string(&plugin_json) {
        if let Ok(pj) = serde_json::from_str::<PluginJson>(&content) {
            return pj.description;
        }
    }
    String::new()
}

/// Load install counts from cache
fn load_install_counts() -> HashMap<String, u64> {
    let path = plugins_dir().join("install-counts-cache.json");
    let data = match fs::read_to_string(&path) {
        Ok(d) => d,
        Err(_) => return HashMap::new(),
    };
    let file: InstallCountsFile = match serde_json::from_str(&data) {
        Ok(f) => f,
        Err(_) => return HashMap::new(),
    };
    file.counts
        .into_iter()
        .map(|e| (e.plugin, e.unique_installs))
        .collect()
}

// ── Tauri commands ──

/// Load all plugin data: installed, available from marketplaces, sources
#[tauri::command]
pub async fn load_plugins() -> Result<PluginsData, String> {
    tokio::task::spawn_blocking(|| {
        let base = plugins_dir();

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

                    let marketplace_name = entry
                        .file_name()
                        .to_string_lossy()
                        .to_string();

                    let manifest_path =
                        mkt_dir.join(".claude-plugin/marketplace.json");
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
                        let plugin_id =
                            format!("{}@{}", plugin.name, marketplace_name);
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

/// Resolve the actual directory of a plugin inside a marketplace using the `source` field
fn resolve_plugin_source(base: &Path, marketplace: &str, plugin_name: &str) -> Option<PathBuf> {
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
fn get_plugin_remote_url(base: &Path, marketplace: &str, plugin_name: &str) -> Option<String> {
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

/// Install a plugin from a marketplace
#[tauri::command]
pub async fn install_plugin(name: String, marketplace: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let base = plugins_dir();

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
        let git_sha = get_git_sha(
            &base.join("marketplaces").join(&marketplace),
        );

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
            copy_dir_all(&marketplace_plugin_dir, &cache_dir)?;
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
    tokio::task::spawn_blocking(move || {
        let base = plugins_dir();
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
                eprintln!("[plugins] Failed to remove cache dir {}: {e}", cache_dir.display());
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
    tokio::task::spawn_blocking(move || {
        let base = plugins_dir();
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
                eprintln!("[plugins] Failed to clean up {}: {e}", target_dir.display());
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
    tokio::task::spawn_blocking(move || {
        let base = plugins_dir();

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
        let base = plugins_dir();
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

// ── Internal helpers ──

/// Get the current git SHA of a repo
fn get_git_sha(repo_path: &Path) -> String {
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

// copy_dir_all: use the canonical implementation from file_ops
use crate::file_ops::copy_dir_recursive as copy_dir_all;

/// Generate an ISO 8601 timestamp.
fn chrono_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
