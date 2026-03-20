pub mod chunker;
pub mod commands;
pub mod config;
pub mod embedder;
pub mod mcp_server;
pub mod index;
pub mod parser;
pub mod rag_settings;
pub mod store;
pub mod web;
pub mod youtube;

/// Validate that a string is a valid UUID v4 format.
pub fn validate_uuid(s: &str, label: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(s)
        .map_err(|_| format!("Invalid {label}: '{s}' is not a valid UUID"))?;
    Ok(())
}
