use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::config;
use crate::file_ops::atomic_write;

// ── Types ──

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub command: String,
    pub source: SkillSource,
    pub file_path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SkillSource {
    Global,
    #[serde(rename_all = "camelCase")]
    Project {
        project_path: String,
    },
    #[serde(rename_all = "camelCase")]
    Plugin {
        plugin_name: String,
        marketplace: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginSkillGroup {
    pub plugin_name: String,
    pub marketplace: String,
    pub skills: Vec<SkillEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillsData {
    pub global: Vec<SkillEntry>,
    pub project: Vec<SkillEntry>,
    pub plugins: Vec<PluginSkillGroup>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SkillFavorites {
    pub ids: Vec<String>,
}

// ── Installed plugins manifest (read-only, CLI manages this) ──

#[derive(Deserialize, Debug)]
struct InstalledPluginsFile {
    #[serde(default)]
    plugins: std::collections::HashMap<String, Vec<InstalledPluginEntry>>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct InstalledPluginEntry {
    install_path: String,
}

// ── YAML frontmatter parsing ──

fn parse_frontmatter(content: &str) -> (String, String) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (String::new(), String::new());
    }

    let after_first = &trimmed[3..];
    if let Some(end) = after_first.find("\n---") {
        let yaml_block = &after_first[..end];
        let mut name = String::new();
        let mut description = String::new();

        for line in yaml_block.lines() {
            let line = line.trim();
            if let Some(val) = line.strip_prefix("name:") {
                name = val.trim().trim_matches('"').trim_matches('\'').to_string();
            } else if let Some(val) = line.strip_prefix("description:") {
                description = val.trim().trim_matches('"').trim_matches('\'').to_string();
            }
        }

        (name, description)
    } else {
        (String::new(), String::new())
    }
}

// ── Skill scanning ──

/// Scan a skills directory (e.g. ~/.claude/skills/) for SKILL.md files
fn scan_skills_dir(dir: &Path) -> Vec<(String, String, String, String)> {
    let mut results = Vec::new();

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return results,
    };

    for entry in entries.flatten() {
        let ft = entry.file_type();
        if ft.is_err() || !ft.unwrap().is_dir() {
            continue;
        }

        let skill_dir = entry.path();
        let skill_md = skill_dir.join("SKILL.md");

        if !skill_md.exists() {
            continue;
        }

        let content = match fs::read_to_string(&skill_md) {
            Ok(c) => c,
            Err(e) => {
                eprintln!(
                    "[aitherflow] Failed to read {}: {e}",
                    skill_md.display()
                );
                continue;
            }
        };

        let dir_name = entry
            .file_name()
            .to_string_lossy()
            .to_string();

        let (name, description) = parse_frontmatter(&content);
        let display_name = if name.is_empty() {
            dir_name.clone()
        } else {
            name
        };

        results.push((
            dir_name,
            display_name,
            description,
            skill_md.to_string_lossy().to_string(),
        ));
    }

    results.sort_by(|a, b| a.0.cmp(&b.0));
    results
}

/// Scan a plugin's commands/ directory for .md files
fn scan_commands_dir(dir: &Path) -> Vec<(String, String, String, String)> {
    let mut results = Vec::new();

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return results,
    };

    for entry in entries.flatten() {
        let path = entry.path();

        // Commands can be either commands/name.md or commands/name/COMMAND.md
        let (cmd_name, md_path) = if path.is_file()
            && path.extension().and_then(|e| e.to_str()) == Some("md")
        {
            let name = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            (name, path.clone())
        } else if path.is_dir() {
            let command_md = path.join("COMMAND.md");
            if command_md.exists() {
                let name = entry.file_name().to_string_lossy().to_string();
                (name, command_md)
            } else {
                continue;
            }
        } else {
            continue;
        };

        let content = match fs::read_to_string(&md_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let (name, description) = parse_frontmatter(&content);
        let display_name = if name.is_empty() {
            cmd_name.clone()
        } else {
            name
        };

        results.push((
            cmd_name,
            display_name,
            description,
            md_path.to_string_lossy().to_string(),
        ));
    }

    results.sort_by(|a, b| a.0.cmp(&b.0));
    results
}

/// Read installed_plugins.json and collect skills from each plugin
fn scan_plugin_skills() -> Vec<PluginSkillGroup> {
    let plugins_file = config::claude_home().join("plugins/installed_plugins.json");
    let data = match fs::read_to_string(&plugins_file) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };

    let manifest: InstalledPluginsFile = match serde_json::from_str(&data) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[aitherflow] Failed to parse installed_plugins.json: {e}");
            return Vec::new();
        }
    };

    let mut groups: Vec<PluginSkillGroup> = Vec::new();

    for (key, entries) in &manifest.plugins {
        // key format: "pluginName@marketplace"
        let (plugin_name, marketplace) = match key.split_once('@') {
            Some((p, m)) => (p.to_string(), m.to_string()),
            None => (key.clone(), String::new()),
        };

        // Use the first (most recent) entry
        let install_path = match entries.first() {
            Some(e) => PathBuf::from(&e.install_path),
            None => continue,
        };

        if !install_path.exists() {
            continue;
        }

        let mut skills: Vec<SkillEntry> = Vec::new();

        // Check for SKILL.md at plugin root (single-skill plugins)
        let root_skill = install_path.join("SKILL.md");
        if root_skill.exists() {
            if let Ok(content) = fs::read_to_string(&root_skill) {
                let (name, description) = parse_frontmatter(&content);
                let display_name = if name.is_empty() {
                    plugin_name.clone()
                } else {
                    name
                };
                skills.push(SkillEntry {
                    id: plugin_name.clone(),
                    name: display_name,
                    description,
                    command: format!("/{}", plugin_name),
                    source: SkillSource::Plugin {
                        plugin_name: plugin_name.clone(),
                        marketplace: marketplace.clone(),
                    },
                    file_path: root_skill.to_string_lossy().to_string(),
                });
            }
        }

        // Scan skills/ directory
        let skills_dir = install_path.join("skills");
        for (dir_name, name, description, file_path) in scan_skills_dir(&skills_dir) {
            let id = format!("{}:{}", plugin_name, dir_name);
            let command = format!("/{}:{}", plugin_name, dir_name);
            skills.push(SkillEntry {
                id,
                name,
                description,
                command,
                source: SkillSource::Plugin {
                    plugin_name: plugin_name.clone(),
                    marketplace: marketplace.clone(),
                },
                file_path,
            });
        }

        // Scan commands/ directory
        let commands_dir = install_path.join("commands");
        for (cmd_name, name, description, file_path) in scan_commands_dir(&commands_dir) {
            // Commands use plugin_name:cmd_name format, but if plugin has a single
            // command with the same name as plugin, just use plugin name
            let (id, command) = if cmd_name == plugin_name {
                (plugin_name.clone(), format!("/{}", plugin_name))
            } else {
                (
                    format!("{}:{}", plugin_name, cmd_name),
                    format!("/{}:{}", plugin_name, cmd_name),
                )
            };
            skills.push(SkillEntry {
                id,
                name,
                description,
                command,
                source: SkillSource::Plugin {
                    plugin_name: plugin_name.clone(),
                    marketplace: marketplace.clone(),
                },
                file_path,
            });
        }

        if !skills.is_empty() {
            skills.sort_by(|a, b| a.id.cmp(&b.id));
            groups.push(PluginSkillGroup {
                plugin_name,
                marketplace,
                skills,
            });
        }
    }

    groups.sort_by(|a, b| a.plugin_name.cmp(&b.plugin_name));
    groups
}

// ── Favorites persistence ──

fn favorites_path() -> PathBuf {
    config::config_dir().join("skill-favorites.json")
}

// ── Tauri commands ──

/// Load all skills from disk: global, project, and plugin
#[tauri::command]
pub async fn load_skills(project_path: String) -> Result<SkillsData, String> {
    tokio::task::spawn_blocking(move || {
        // Global skills: ~/.claude/skills/
        let global_dir = config::claude_home().join("skills");
        let global: Vec<SkillEntry> = scan_skills_dir(&global_dir)
            .into_iter()
            .map(|(dir_name, name, description, file_path)| SkillEntry {
                id: dir_name.clone(),
                name,
                description,
                command: format!("/{}", dir_name),
                source: SkillSource::Global,
                file_path,
            })
            .collect();

        // Project skills: <project>/.claude/skills/
        let project_skills_dir = PathBuf::from(&project_path)
            .join(".claude")
            .join("skills");
        let project: Vec<SkillEntry> = scan_skills_dir(&project_skills_dir)
            .into_iter()
            .map(|(dir_name, name, description, file_path)| {
                let id = format!("project:{}", dir_name);
                SkillEntry {
                    id,
                    name,
                    description,
                    command: format!("/{}", dir_name),
                    source: SkillSource::Project {
                        project_path: project_path.clone(),
                    },
                    file_path,
                }
            })
            .collect();

        // Plugin skills
        let plugins = scan_plugin_skills();

        Ok(SkillsData {
            global,
            project,
            plugins,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Load skill favorites
#[tauri::command]
pub async fn load_skill_favorites() -> Result<SkillFavorites, String> {
    tokio::task::spawn_blocking(|| {
        let path = favorites_path();
        if !path.exists() {
            return Ok(SkillFavorites::default());
        }
        let data = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read skill-favorites.json: {e}"))?;
        serde_json::from_str(&data)
            .map_err(|e| format!("Failed to parse skill-favorites.json: {e}"))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Delete a user skill (global or project) by removing its directory
#[tauri::command]
pub async fn delete_skill(file_path: String) -> Result<(), String> {
    use crate::files::validate_path_safe;

    tokio::task::spawn_blocking(move || {
        let skill_file = PathBuf::from(&file_path);
        validate_path_safe(&skill_file)?;

        // SKILL.md must exist
        if !skill_file.exists() || skill_file.file_name().and_then(|n| n.to_str()) != Some("SKILL.md")
        {
            return Err(format!("Invalid skill path: {}", file_path));
        }

        // Only allow deleting from ~/.claude/skills/ or <project>/.claude/skills/
        let parent = skill_file
            .parent()
            .ok_or_else(|| "Cannot determine skill directory".to_string())?;
        let grandparent = parent
            .parent()
            .ok_or_else(|| "Cannot determine skills root".to_string())?;
        if grandparent.file_name().and_then(|n| n.to_str()) != Some("skills") {
            return Err("Can only delete skills from a skills/ directory".to_string());
        }

        fs::remove_dir_all(parent)
            .map_err(|e| format!("Failed to delete skill directory: {e}"))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Save skill favorites
#[tauri::command]
pub async fn save_skill_favorites(ids: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let favs = SkillFavorites { ids };
        let data = serde_json::to_string_pretty(&favs)
            .map_err(|e| format!("Failed to serialize favorites: {e}"))?;
        atomic_write(&favorites_path(), data.as_bytes())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
