use std::collections::HashMap;
use std::path::PathBuf;

use crate::file_ops::atomic_write;

fn secrets_file() -> PathBuf {
    crate::config::config_dir().join("secrets.json")
}

fn read_all() -> HashMap<String, String> {
    let path = secrets_file();
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn write_all(map: &HashMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_string_pretty(map)
        .map_err(|e| format!("Failed to serialize secrets: {e}"))?;
    atomic_write(&secrets_file(), json.as_bytes())
}

pub fn set_secret(key: &str, value: &str) -> Result<bool, String> {
    if value.is_empty() {
        return delete_secret(key).map(|_| true);
    }
    let mut map = read_all();
    map.insert(key.to_string(), value.to_string());
    write_all(&map)?;
    Ok(true)
}

pub fn get_secret(key: &str) -> Option<String> {
    read_all().get(key).cloned()
}

pub fn delete_secret(key: &str) -> Result<(), String> {
    let mut map = read_all();
    if map.remove(key).is_some() {
        write_all(&map)?;
    }
    Ok(())
}
