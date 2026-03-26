//! Knowledge MCP server — RAG tool definitions and execution.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;

use crate::mcp_transport::{self, McpServerInfo, McpState, McpToolHandler};
use super::{commands, embedder, index, rag_settings, store, validate_uuid};

// ── State ──

static MCP_INFO: Mutex<Option<McpServerInfo>> = Mutex::new(None);

struct KnowledgeMcpState {
    auth_token: String,
    sessions: RwLock<HashMap<String, tokio::sync::mpsc::Sender<String>>>,
}

impl McpState for KnowledgeMcpState {
    fn sessions(&self) -> &RwLock<HashMap<String, tokio::sync::mpsc::Sender<String>>> {
        &self.sessions
    }
    fn auth_token(&self) -> &str {
        &self.auth_token
    }
}

struct KnowledgeToolHandler;

#[axum::async_trait]
impl McpToolHandler for KnowledgeToolHandler {
    fn server_name(&self) -> &str { "aitherflow-knowledge" }
    fn tool_definitions(&self) -> Value { tool_definitions() }
    async fn execute_tool(&self, name: &str, args: &Value) -> Result<String, String> {
        execute_tool(name, args).await
    }
}

// ── Public API ──

pub fn get_port() -> Option<u16> {
    mcp_transport::get_port(&MCP_INFO)
}

pub fn get_token() -> Option<String> {
    mcp_transport::get_token(&MCP_INFO)
}

pub async fn start_server() -> Result<u16, String> {
    let auth_token = uuid::Uuid::new_v4().to_string();
    let state = Arc::new(KnowledgeMcpState {
        auth_token,
        sessions: RwLock::new(HashMap::new()),
    });
    let handler = Arc::new(KnowledgeToolHandler);
    mcp_transport::start_sse_server("knowledge-mcp", &MCP_INFO, state, handler).await
}

pub fn stop_server_sync() {
    mcp_transport::stop_server_sync("knowledge-mcp", &MCP_INFO);
}

// ── Tool execution ──

async fn execute_tool(name: &str, args: &Value) -> Result<String, String> {
    match name {
        "search_knowledge_base" => tool_search(args).await,
        "list_knowledge_bases" => tool_list_bases().await,
        "get_document_info" => tool_get_documents(args).await,
        "reindex_document" => tool_reindex_document(args).await,
        _ => Err(format!("Unknown tool: {name}")),
    }
}

async fn tool_search(args: &Value) -> Result<String, String> {
    let query = args["query"]
        .as_str()
        .ok_or("Missing 'query' parameter")?;
    let default_limit = rag_settings::load().search_results_limit as u64;
    let limit = (args["limit"].as_u64().unwrap_or(default_limit) as usize).clamp(1, 100);

    let q = query.to_string();
    let embeddings = tokio::task::spawn_blocking(move || embedder::embed_texts(&[q]))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    let query_vec = embeddings
        .into_iter()
        .next()
        .ok_or("Failed to embed query")?;

    let base_ids: Vec<String> = if let Some(id) = args["base_id"].as_str() {
        validate_uuid(id, "base_id")?;
        vec![id.to_string()]
    } else {
        let bases = tokio::task::spawn_blocking(store::list_bases)
            .await
            .map_err(|e| format!("Task join error: {e}"))??;
        bases.into_iter().map(|b| b.id).collect()
    };

    let mut all_results = Vec::new();
    for base_id in &base_ids {
        let raw = index::search(base_id, &query_vec, limit).await?;
        if !raw.is_empty() {
            let enriched = commands::enrich_results(base_id, raw).await?;
            all_results.extend(enriched);
        }
    }

    all_results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    all_results.truncate(limit);

    if all_results.is_empty() {
        return Ok("No results found.".into());
    }

    let mut output = String::new();
    for r in &all_results {
        output.push_str(&format!(
            "--- From: {} (score: {:.0}%) ---\n{}\n\n",
            r.document_name,
            r.score * 100.0,
            r.chunk_text
        ));
    }

    Ok(output.trim().to_string())
}

async fn tool_list_bases() -> Result<String, String> {
    let bases = tokio::task::spawn_blocking(store::list_bases)
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    if bases.is_empty() {
        return Ok("No knowledge bases found.".into());
    }

    let mut output = String::new();
    for b in &bases {
        output.push_str(&format!(
            "- {} (id: {}, {} documents)\n",
            b.name, b.id, b.document_count
        ));
    }

    Ok(output.trim().to_string())
}

async fn tool_get_documents(args: &Value) -> Result<String, String> {
    let base_id = args["base_id"]
        .as_str()
        .ok_or("Missing 'base_id' parameter")?;
    validate_uuid(base_id, "base_id")?;
    let base_id = base_id.to_string();

    let docs = tokio::task::spawn_blocking(move || store::list_documents(&base_id))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;

    if docs.is_empty() {
        return Ok("No documents in this knowledge base.".into());
    }

    let mut output = String::new();
    for d in &docs {
        output.push_str(&format!(
            "- {} (id: {}, {} chunks, {} bytes)\n",
            d.filename, d.id, d.chunk_count, d.size_bytes
        ));
    }

    Ok(output.trim().to_string())
}

async fn tool_reindex_document(args: &Value) -> Result<String, String> {
    let base_id = args["base_id"]
        .as_str()
        .ok_or("Missing 'base_id' parameter")?;
    validate_uuid(base_id, "base_id")?;
    let document_id = args["document_id"]
        .as_str()
        .ok_or("Missing 'document_id' parameter")?;
    validate_uuid(document_id, "document_id")?;
    let chunk_size = (args["chunk_size"].as_u64().unwrap_or(512) as usize).clamp(64, 4096);
    let chunk_overlap = args["chunk_overlap"].as_u64().unwrap_or(64) as usize;
    if chunk_overlap >= chunk_size {
        return Err(format!(
            "chunk_overlap ({chunk_overlap}) must be less than chunk_size ({chunk_size})"
        ));
    }

    let bid = base_id.to_string();
    let did = document_id.to_string();
    let doc = tokio::task::spawn_blocking(move || {
        let docs = store::list_documents(&bid)?;
        docs.into_iter()
            .find(|d| d.id == did)
            .ok_or_else(|| format!("Document '{did}' not found"))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    if doc.path.starts_with("http://") || doc.path.starts_with("https://") {
        return Err(format!(
            "Reindex not supported for web/YouTube sources: {}. Remove and re-add the document instead.",
            doc.filename
        ));
    }

    let new_chunk_count = commands::reindex_single_document(
        base_id,
        &doc,
        Some(chunk_size),
        Some(chunk_overlap),
    )
    .await?;

    Ok(format!(
        "Document '{}' reindexed: {} chunks (size={}, overlap={})",
        doc.filename, new_chunk_count, chunk_size, chunk_overlap
    ))
}

// ── Tool definitions ──

fn tool_definitions() -> Value {
    json!([
        {
            "name": "search_knowledge_base",
            "description": "Search knowledge bases for relevant information. Returns text chunks from indexed documents ranked by semantic similarity. Use this to find answers in uploaded documents, web pages, or YouTube transcripts.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query — formulate in the same language as the documents for best results" },
                    "base_id": { "type": "string", "description": "Optional: search only this knowledge base. If omitted, searches all bases." },
                    "limit": { "type": "number", "description": "Maximum number of results (default: 10)" }
                },
                "required": ["query"]
            }
        },
        {
            "name": "list_knowledge_bases",
            "description": "List all available knowledge bases with their document counts.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_document_info",
            "description": "Get the list of documents in a knowledge base (name, chunks, size).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "base_id": { "type": "string", "description": "Knowledge base ID" }
                },
                "required": ["base_id"]
            }
        },
        {
            "name": "reindex_document",
            "description": "Re-index a single document with different chunk parameters. Use when search results are too short/long or missing context.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "base_id": { "type": "string", "description": "Knowledge base ID" },
                    "document_id": { "type": "string", "description": "Document ID to reindex" },
                    "chunk_size": { "type": "number", "description": "Token count per chunk (default: 512)" },
                    "chunk_overlap": { "type": "number", "description": "Overlap between chunks (default: 64)" }
                },
                "required": ["base_id", "document_id"]
            }
        }
    ])
}
