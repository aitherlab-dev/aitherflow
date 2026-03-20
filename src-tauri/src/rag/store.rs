use serde::{Deserialize, Serialize};
use std::fs;

use crate::file_ops::{read_json, write_json};

use super::config as rag_config;

/// Metadata about a single document added to a knowledge base.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMeta {
    pub id: String,
    pub filename: String,
    pub path: String,
    pub size_bytes: u64,
    pub chunk_count: usize,
    pub added_at: u64,
}

/// Metadata about a knowledge base.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BaseMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: u64,
    pub documents: Vec<DocumentMeta>,
}

/// Lightweight info returned by list_bases (no documents list).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BaseInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: u64,
    pub document_count: usize,
}

impl BaseMeta {
    pub fn to_info(&self) -> BaseInfo {
        BaseInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            created_at: self.created_at,
            document_count: self.documents.len(),
        }
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Validate base_id: no path separators, no traversal, not empty.
fn validate_base_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("base_id cannot be empty".into());
    }
    if id.contains('/')
        || id.contains('\\')
        || id == ".."
        || id == "."
        || id.contains('\0')
    {
        return Err(format!("Invalid base_id: '{id}'"));
    }
    Ok(())
}

/// List all knowledge bases.
pub fn list_bases() -> Result<Vec<BaseInfo>, String> {
    let dir = rag_config::rag_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read rag dir: {e}"))?;

    let mut bases = Vec::new();
    for entry in entries.flatten() {
        let ft = entry.file_type()
            .map_err(|e| format!("Failed to get file type: {e}"))?;
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let dir_name = name.to_string_lossy();
        // Skip the models cache directory
        if dir_name == "models" {
            continue;
        }
        let meta_path = rag_config::base_meta_path(&dir_name);
        if let Ok(meta) = read_json::<BaseMeta>(&meta_path) {
            bases.push(meta.to_info());
        }
    }

    bases.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(bases)
}

/// Create a new knowledge base.
pub fn create_base(name: &str, description: &str) -> Result<BaseMeta, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let base_dir = rag_config::base_dir(&id);

    fs::create_dir_all(&base_dir)
        .map_err(|e| format!("Failed to create base dir: {e}"))?;
    fs::create_dir_all(rag_config::base_lance_dir(&id))
        .map_err(|e| format!("Failed to create lance dir: {e}"))?;

    let meta = BaseMeta {
        id: id.clone(),
        name: name.to_string(),
        description: description.to_string(),
        created_at: now_millis(),
        documents: Vec::new(),
    };

    write_json(&rag_config::base_meta_path(&id), &meta)?;
    Ok(meta)
}

/// Get metadata for a single knowledge base.
pub fn get_base(base_id: &str) -> Result<BaseMeta, String> {
    validate_base_id(base_id)?;
    let meta_path = rag_config::base_meta_path(base_id);
    read_json(&meta_path).map_err(|_| format!("Knowledge base '{base_id}' not found"))
}

/// Delete a knowledge base and all its data.
pub fn delete_base(base_id: &str) -> Result<(), String> {
    validate_base_id(base_id)?;
    let dir = rag_config::base_dir(base_id);
    fs::remove_dir_all(&dir)
        .map_err(|e| format!("Knowledge base '{base_id}' not found or cannot delete: {e}"))
}

/// Add a document record to the base metadata. Returns the document ID.
pub fn add_document_meta(
    base_id: &str,
    filename: &str,
    path: &str,
    size_bytes: u64,
    chunk_count: usize,
) -> Result<String, String> {
    validate_base_id(base_id)?;
    let mut meta = get_base(base_id)?;
    let doc_id = uuid::Uuid::new_v4().to_string();

    meta.documents.push(DocumentMeta {
        id: doc_id.clone(),
        filename: filename.to_string(),
        path: path.to_string(),
        size_bytes,
        chunk_count,
        added_at: now_millis(),
    });

    write_json(&rag_config::base_meta_path(base_id), &meta)?;
    Ok(doc_id)
}

/// Remove a document record from the base metadata.
pub fn remove_document_meta(base_id: &str, document_id: &str) -> Result<(), String> {
    validate_base_id(base_id)?;
    let mut meta = get_base(base_id)?;
    let before = meta.documents.len();
    meta.documents.retain(|d| d.id != document_id);
    if meta.documents.len() == before {
        return Err(format!("Document '{document_id}' not found in base '{base_id}'"));
    }
    write_json(&rag_config::base_meta_path(base_id), &meta)
}

/// List documents in a knowledge base.
pub fn list_documents(base_id: &str) -> Result<Vec<DocumentMeta>, String> {
    let meta = get_base(base_id)?;
    Ok(meta.documents)
}
