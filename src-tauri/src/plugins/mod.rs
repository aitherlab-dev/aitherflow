mod marketplace;
pub mod types;
pub mod commands;

use std::path::PathBuf;

use crate::config;

fn plugins_dir() -> PathBuf {
    config::claude_home().join("plugins")
}
