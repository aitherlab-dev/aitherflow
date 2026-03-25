use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub models_path: PathBuf,
    pub output_path: PathBuf,
    pub default_model: String,
    pub default_width: u32,
    pub default_height: u32,
    pub default_steps: u32,
}

impl Default for Config {
    fn default() -> Self {
        let data_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join("aither-flow");

        Self {
            models_path: data_dir.join("models"),
            output_path: data_dir.join("images"),
            default_model: "FLUX.2-klein-4B".into(),
            default_width: 1024,
            default_height: 1024,
            default_steps: 20,
        }
    }
}

impl Config {
    pub fn config_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join("aither-flow")
            .join("image-gen")
            .join("settings.json")
    }

    pub fn load() -> Self {
        let path = Self::config_path();

        if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => match serde_json::from_str::<Config>(&content) {
                    Ok(config) => {
                        info!("Config loaded from {}", path.display());
                        return config;
                    }
                    Err(e) => {
                        warn!("Failed to parse config: {e}, using defaults");
                    }
                },
                Err(e) => {
                    warn!("Failed to read config: {e}, using defaults");
                }
            }
        } else {
            info!("No config found at {}, using defaults", path.display());
        }

        let config = Config::default();
        config.save();
        config
    }

    pub fn save(&self) {
        let path = Self::config_path();

        if let Some(parent) = path.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                warn!("Failed to create config dir: {e}");
                return;
            }
        }

        match serde_json::to_string_pretty(self) {
            Ok(json) => {
                if let Err(e) = fs::write(&path, json) {
                    warn!("Failed to write config: {e}");
                }
            }
            Err(e) => {
                warn!("Failed to serialize config: {e}");
            }
        }
    }

    pub fn ensure_dirs(&self) {
        if let Err(e) = fs::create_dir_all(&self.models_path) {
            warn!("Failed to create models dir: {e}");
        }
        if let Err(e) = fs::create_dir_all(&self.output_path) {
            warn!("Failed to create output dir: {e}");
        }
    }
}
