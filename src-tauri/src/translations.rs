use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use crate::config;
use crate::file_ops::atomic_write;

/// Cached translations stored on disk
#[derive(Default, Serialize, Deserialize, Clone)]
pub struct TranslationCache {
    pub language: String,
    pub entries: HashMap<String, String>,
}

/// A single item to translate (sent from frontend)
#[derive(Deserialize)]
pub struct TranslationItem {
    pub key: String,
    pub text: String,
}

/// Path to translations cache file
fn cache_path() -> PathBuf {
    config::config_dir().join("translations.json")
}

/// Load the translation cache from disk
fn load_cache() -> TranslationCache {
    let path = cache_path();
    if !path.exists() {
        return TranslationCache::default();
    }
    match fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(e) => {
            eprintln!("[translations] Failed to read cache: {e}");
            TranslationCache::default()
        }
    }
}

/// Save the translation cache to disk
fn save_cache(cache: &TranslationCache) -> Result<(), String> {
    let data = serde_json::to_string_pretty(cache)
        .map_err(|e| format!("Failed to serialize translations: {e}"))?;
    atomic_write(&cache_path(), data.as_bytes())
}

/// Language code to full name for the translation prompt
fn language_name(code: &str) -> &str {
    match code {
        "ru" => "Russian",
        "zh" => "Chinese (Simplified)",
        "ja" => "Japanese",
        "es" => "Spanish",
        "fr" => "French",
        _ => code,
    }
}

const BATCH_SIZE: usize = 40;
const SEPARATOR: &str = "---ITEM---";

/// Call Claude CLI (Haiku) to translate a batch of texts
fn translate_batch(texts: &[&str], lang_name: &str) -> Result<Vec<String>, String> {
    let joined = texts.join(&format!("\n{SEPARATOR}\n"));

    let prompt = format!(
        "Translate each of the following short descriptions to {lang_name}.\n\
         Return ONLY the translations, one per item, separated by {SEPARATOR} on its own line.\n\
         Do not add numbering, commentary, or extra formatting.\n\
         Preserve any technical terms (API names, tool names) as-is.\n\n\
         {SEPARATOR}\n{joined}\n{SEPARATOR}"
    );

    let output = std::process::Command::new("claude")
        .arg("-p")
        .arg(&prompt)
        .arg("--model")
        .arg("haiku")
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "Claude CLI not found. Make sure 'claude' is in your PATH.".to_string()
            } else {
                format!("Failed to run claude CLI: {e}")
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Claude CLI failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<String> = stdout
        .split(SEPARATOR)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    Ok(parts)
}

/// Load translations from disk cache.
#[tauri::command]
pub async fn load_translations() -> Result<TranslationCache, String> {
    tokio::task::spawn_blocking(load_cache)
        .await
        .map_err(|e| format!("Task join error: {e}"))
}

/// Translate content descriptions.
/// If `force` is true, re-translates everything (Translate All).
/// If `force` is false, only translates items missing from cache (Update).
#[tauri::command]
pub async fn translate_content(
    language: String,
    items: Vec<TranslationItem>,
    force: bool,
) -> Result<TranslationCache, String> {
    tokio::task::spawn_blocking(move || {
        let mut cache = load_cache();

        // If language changed or force mode, reset cache
        if cache.language != language || force {
            cache.entries.clear();
            cache.language = language.clone();
        }

        // Filter items: skip empty texts and already-translated keys
        let to_translate: Vec<&TranslationItem> = items
            .iter()
            .filter(|item| !item.text.is_empty() && !cache.entries.contains_key(&item.key))
            .collect();

        if to_translate.is_empty() {
            save_cache(&cache)?;
            return Ok(cache);
        }

        let lang_name = language_name(&language);

        // Process in batches
        for chunk in to_translate.chunks(BATCH_SIZE) {
            let texts: Vec<&str> = chunk.iter().map(|item| item.text.as_str()).collect();

            match translate_batch(&texts, lang_name) {
                Ok(translations) => {
                    // Match translations to keys (as many as we got back)
                    let count = translations.len().min(chunk.len());
                    for i in 0..count {
                        cache
                            .entries
                            .insert(chunk[i].key.clone(), translations[i].clone());
                    }
                    if translations.len() != chunk.len() {
                        eprintln!(
                            "[translations] Warning: expected {} translations, got {}",
                            chunk.len(),
                            translations.len()
                        );
                    }
                }
                Err(e) => {
                    eprintln!("[translations] Batch translation failed: {e}");
                    // Save what we have so far and return error
                    if let Err(e2) = save_cache(&cache) {
                        eprintln!("[translations] Failed to save partial cache: {e2}");
                    }
                    return Err(e);
                }
            }
        }

        save_cache(&cache)?;
        Ok(cache)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Clear all cached translations.
#[tauri::command]
pub async fn clear_translations() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        let path = cache_path();
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove translations cache: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
