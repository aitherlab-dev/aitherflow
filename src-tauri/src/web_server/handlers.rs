//! REST handlers that wrap existing Tauri commands.
//!
//! Each handler deserializes JSON from the request body, calls the
//! corresponding module function, and returns JSON.
//!
//! For commands that need SessionManager — we pull it from WebState.
//! For commands that are free-standing (chats, settings, …) — call directly.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use super::WebState;
use crate::conductor::process;
use crate::conductor::types::{CliEvent, SendMessageOptions, StartSessionOptions, DEFAULT_AGENT_ID};

// ── Helpers ────────────────────────────────────────────────────────

/// Validate that a filesystem path is within allowed directories.
/// Returns 403 Forbidden if the path is outside allowed areas.
#[allow(clippy::result_large_err)]
fn check_path(path: &str) -> Result<(), Response> {
    crate::files::validate_path_safe(std::path::Path::new(path))
        .map_err(|e| (StatusCode::FORBIDDEN, e).into_response())
}

/// Convert Result<T, String> to an Axum response.
fn ok_json<T: serde::Serialize>(result: Result<T, String>) -> Response {
    match result {
        Ok(val) => Json(val).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

fn ok_empty(result: Result<(), String>) -> Response {
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── Conductor ──────────────────────────────────────────────────────

/// Tauri invoke sends `{ "options": { ... } }` for these commands.
#[derive(Deserialize)]
pub struct StartSessionWrapper {
    options: StartSessionOptions,
}

pub async fn start_session(
    State(state): State<Arc<WebState>>,
    Json(wrapper): Json<StartSessionWrapper>,
) -> Response {
    let options = wrapper.options;
    let agent_id = options
        .agent_id
        .clone()
        .unwrap_or_else(|| DEFAULT_AGENT_ID.to_string());
    let prompt = options.prompt.clone();
    let project_path = options
        .project_path
        .clone()
        .or_else(|| Some(crate::config::workspace_dir().to_string_lossy().into_owned()));
    let model = options.model.clone();
    let effort = options.effort.clone();
    let resume_session_id = options.resume_session_id.clone();
    let permission_mode = options.permission_mode.clone();
    let chrome = options.chrome;
    let image_attachments = options.attachments.clone();

    let sessions = state.sessions.clone();
    let event_tx = state.event_tx.clone();
    let agent_id_clone = agent_id.clone();

    tokio::spawn(async move {
        if let Err(e) = process::run_cli_session(
            process::EventSink::Broadcast(event_tx.clone()),
            sessions,
            agent_id_clone.clone(),
            prompt,
            project_path,
            model,
            effort,
            resume_session_id,
            permission_mode,
            chrome,
            image_attachments,
        )
        .await
        {
            eprintln!("[web] Session error: {e}");
            let _ = event_tx.send(CliEvent::Error {
                agent_id: agent_id_clone,
                message: e,
            });
        }
    });

    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
pub struct SendMessageWrapper {
    options: SendMessageOptions,
}

pub async fn send_message(
    State(state): State<Arc<WebState>>,
    Json(wrapper): Json<SendMessageWrapper>,
) -> Response {
    let options = wrapper.options;
    let agent_id = options
        .agent_id
        .unwrap_or_else(|| DEFAULT_AGENT_ID.to_string());

    let Some(mut stdin) = state.sessions.take_stdin(&agent_id).await else {
        return (StatusCode::BAD_REQUEST, "No active session for this agent").into_response();
    };

    let ndjson = match process::build_stdin_message(&options.prompt, &options.attachments) {
        Ok(n) => n,
        Err(e) => {
            state.sessions.return_stdin(&agent_id, stdin).await;
            return (StatusCode::BAD_REQUEST, e).into_response();
        }
    };

    let result = async {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(ndjson.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok::<(), std::io::Error>(())
    }
    .await;

    state.sessions.return_stdin(&agent_id, stdin).await;

    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to send: {e}")).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdParam {
    agent_id: Option<String>,
}

pub async fn stop_session(
    State(state): State<Arc<WebState>>,
    Json(params): Json<AgentIdParam>,
) -> Response {
    let agent_id = params.agent_id.unwrap_or_else(|| DEFAULT_AGENT_ID.to_string());
    state.sessions.kill(&agent_id).await;
    StatusCode::NO_CONTENT.into_response()
}

pub async fn has_active_session(
    State(state): State<Arc<WebState>>,
    Json(params): Json<AgentIdParam>,
) -> Response {
    let agent_id = params.agent_id.unwrap_or_else(|| DEFAULT_AGENT_ID.to_string());
    let alive = state.sessions.is_alive(&agent_id).await;
    Json(alive).into_response()
}

// ── Chats ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ProjectPathParam {
    #[serde(rename = "projectPath")]
    project_path: String,
}

pub async fn list_chats(Json(params): Json<ProjectPathParam>) -> Response {
    ok_json(crate::chats::list_chats(params.project_path).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChatParam {
    project_path: String,
    agent_id: String,
    title: String,
}

pub async fn create_chat(Json(p): Json<CreateChatParam>) -> Response {
    ok_json(crate::chats::create_chat(p.project_path, p.agent_id, p.title).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatIdParam {
    chat_id: String,
}

pub async fn load_chat(Json(p): Json<ChatIdParam>) -> Response {
    ok_json(crate::chats::load_chat(p.chat_id).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMessagesParam {
    chat_id: String,
    messages: Vec<crate::chats::ChatMessageStored>,
}

pub async fn save_chat_messages(Json(p): Json<SaveMessagesParam>) -> Response {
    ok_empty(crate::chats::save_chat_messages(p.chat_id, p.messages).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionParam {
    chat_id: String,
    session_id: String,
}

pub async fn update_chat_session(Json(p): Json<UpdateSessionParam>) -> Response {
    ok_empty(crate::chats::update_chat_session(p.chat_id, p.session_id).await)
}

pub async fn delete_chat(Json(p): Json<ChatIdParam>) -> Response {
    ok_empty(crate::chats::delete_chat(p.chat_id).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameChatParam {
    chat_id: String,
    custom_title: String,
}

pub async fn rename_chat(Json(p): Json<RenameChatParam>) -> Response {
    ok_empty(crate::chats::rename_chat(p.chat_id, p.custom_title).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TogglePinParam {
    chat_id: String,
    pinned: bool,
}

pub async fn toggle_chat_pin(Json(p): Json<TogglePinParam>) -> Response {
    ok_empty(crate::chats::toggle_chat_pin(p.chat_id, p.pinned).await)
}

// ── Agents ─────────────────────────────────────────────────────────

pub async fn load_agents() -> Response {
    ok_json(crate::agents::load_agents().await)
}

pub async fn save_agents(Json(body): Json<serde_json::Value>) -> Response {
    let agents = body.get("agents").cloned().unwrap_or(serde_json::json!([]));
    let active = body.get("activeAgentId").and_then(|v| v.as_str()).map(|s| s.to_string());
    let agents: Vec<crate::agents::AgentEntry> = match serde_json::from_value(agents) {
        Ok(a) => a,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("Invalid agents: {e}")).into_response(),
    };
    ok_empty(crate::agents::save_agents(agents, active).await)
}

// ── Projects ───────────────────────────────────────────────────────

pub async fn load_projects() -> Response {
    ok_json(crate::projects::load_projects().await)
}

pub async fn save_projects(Json(body): Json<serde_json::Value>) -> Response {
    let projects = body.get("projects").cloned().unwrap_or(serde_json::json!([]));
    let last = body.get("lastOpenedProject").and_then(|v| v.as_str()).map(|s| s.to_string());
    let last_chat = body.get("lastOpenedChatId").and_then(|v| v.as_str()).map(|s| s.to_string());
    let cards_val = body.get("welcomeCards").cloned().unwrap_or(serde_json::json!([]));
    let projects: Vec<crate::projects::ProjectBookmark> = match serde_json::from_value(projects) {
        Ok(p) => p,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("Invalid projects: {e}")).into_response(),
    };
    let welcome_cards: Vec<crate::projects::WelcomeCard> = serde_json::from_value(cards_val).unwrap_or_default();
    ok_empty(crate::projects::save_projects(projects, last, last_chat, welcome_cards).await)
}

// ── Settings ───────────────────────────────────────────────────────

pub async fn load_settings() -> Response {
    ok_json(crate::settings::load_settings().await)
}

pub async fn save_settings(Json(body): Json<serde_json::Value>) -> Response {
    let settings: crate::settings::AppSettings = match body.get("settings") {
        Some(s) => match serde_json::from_value(s.clone()) {
            Ok(v) => v,
            Err(e) => return (StatusCode::BAD_REQUEST, format!("Invalid settings: {e}")).into_response(),
        },
        None => match serde_json::from_value(body) {
            Ok(v) => v,
            Err(e) => return (StatusCode::BAD_REQUEST, format!("Invalid settings: {e}")).into_response(),
        },
    };
    ok_empty(crate::settings::save_settings(settings).await)
}

// ── Skills ─────────────────────────────────────────────────────────

pub async fn load_skills(Json(body): Json<serde_json::Value>) -> Response {
    let project_path = body.get("projectPath").and_then(|v| v.as_str()).unwrap_or("").to_string();
    ok_json(crate::skills::load_skills(project_path).await)
}

pub async fn load_skill_favorites() -> Response {
    ok_json(crate::skills::load_skill_favorites().await)
}

#[derive(Deserialize)]
pub struct SaveFavoritesParam {
    ids: Vec<String>,
}

pub async fn save_skill_favorites(Json(p): Json<SaveFavoritesParam>) -> Response {
    ok_empty(crate::skills::save_skill_favorites(p.ids).await)
}

// ── Plugins ────────────────────────────────────────────────────────

pub async fn load_plugins() -> Response {
    ok_json(crate::plugins::load_plugins().await)
}

#[derive(Deserialize)]
pub struct PluginParam {
    name: String,
    marketplace: String,
}

pub async fn install_plugin(Json(p): Json<PluginParam>) -> Response {
    ok_empty(crate::plugins::install_plugin(p.name, p.marketplace).await)
}

pub async fn uninstall_plugin(Json(p): Json<PluginParam>) -> Response {
    ok_empty(crate::plugins::uninstall_plugin(p.name, p.marketplace).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMarketplaceParam {
    name: String,
    source_type: String,
    url: String,
}

pub async fn add_marketplace(Json(p): Json<AddMarketplaceParam>) -> Response {
    ok_empty(crate::plugins::add_marketplace(p.name, p.source_type, p.url).await)
}

#[derive(Deserialize)]
pub struct RemoveMarketplaceParam {
    name: String,
}

pub async fn remove_marketplace(Json(p): Json<RemoveMarketplaceParam>) -> Response {
    ok_empty(crate::plugins::remove_marketplace(p.name).await)
}

pub async fn update_marketplaces() -> Response {
    ok_empty(crate::plugins::update_marketplaces().await)
}

// ── Translations ───────────────────────────────────────────────────

pub async fn load_translations() -> Response {
    ok_json(crate::translations::load_translations().await)
}

#[derive(Deserialize)]
pub struct TranslateParam {
    language: String,
    items: Vec<crate::translations::TranslationItem>,
}

pub async fn translate_content(Json(p): Json<TranslateParam>) -> Response {
    ok_json(crate::translations::translate_content(p.language, p.items, false).await)
}

pub async fn clear_translations() -> Response {
    ok_empty(crate::translations::clear_translations().await)
}

// ── Web Config ──────────────────────────────────────────────────────

pub async fn load_web_config() -> Response {
    ok_json(crate::web_config::load_web_config().await)
}

pub async fn save_web_config(Json(body): Json<serde_json::Value>) -> Response {
    let config: crate::web_config::WebServerConfig = match body.get("config") {
        Some(c) => match serde_json::from_value(c.clone()) {
            Ok(v) => v,
            Err(e) => return (StatusCode::BAD_REQUEST, format!("Invalid config: {e}")).into_response(),
        },
        None => match serde_json::from_value(body) {
            Ok(v) => v,
            Err(e) => return (StatusCode::BAD_REQUEST, format!("Invalid config: {e}")).into_response(),
        },
    };
    ok_empty(crate::web_config::save_web_config(config).await)
}

pub async fn generate_web_token() -> Response {
    ok_json(crate::web_config::generate_web_token().await)
}

/// Generate a one-time auth code (called from the app, requires auth).
pub async fn create_auth_code(State(state): State<Arc<WebState>>) -> Response {
    let code = state.session_store.create_code().await;
    Json(serde_json::json!({ "code": code })).into_response()
}

/// Exchange a one-time auth code for a session cookie (no auth required).
pub async fn exchange_auth_code(
    State(state): State<Arc<WebState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    use axum::http::header;

    let Some(code) = params.get("code") else {
        return (StatusCode::BAD_REQUEST, "Missing ?code= parameter").into_response();
    };

    let Some(session_token) = state.session_store.exchange_code(code).await else {
        return (StatusCode::UNAUTHORIZED, "Invalid or expired code").into_response();
    };

    // Set HttpOnly, Secure, SameSite=Strict cookie
    let cookie = format!(
        "af_session={session_token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800"
    );

    // Redirect to app root
    (
        StatusCode::FOUND,
        [
            (header::SET_COOKIE, cookie),
            (header::LOCATION, "/".to_string()),
        ],
    )
        .into_response()
}

// ── Hooks ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct HooksLoadParam {
    scope: String,
    #[serde(rename = "projectPath")]
    project_path: Option<String>,
}

pub async fn load_hooks(Json(p): Json<HooksLoadParam>) -> Response {
    ok_json(crate::hooks::load_hooks(p.scope, p.project_path).await)
}

#[derive(Deserialize)]
pub struct HooksSaveParam {
    scope: String,
    #[serde(rename = "projectPath")]
    project_path: Option<String>,
    hooks: serde_json::Value,
}

pub async fn save_hooks(Json(p): Json<HooksSaveParam>) -> Response {
    ok_empty(crate::hooks::save_hooks(p.scope, p.project_path, p.hooks).await)
}

#[derive(Deserialize)]
pub struct HookTestParam {
    command: String,
    cwd: Option<String>,
}

pub async fn test_hook_command(Json(p): Json<HookTestParam>) -> Response {
    ok_json(crate::hooks::test_hook_command(p.command, p.cwd).await)
}

// ── Memory ─────────────────────────────────────────────────────────

pub async fn memory_stats(Json(p): Json<ProjectPathParam>) -> Response {
    ok_json(crate::memory::memory_stats(p.project_path).await)
}

pub async fn memory_index_project(Json(p): Json<ProjectPathParam>) -> Response {
    ok_json(crate::memory::memory_index_project(p.project_path).await)
}

// ── Attachments ────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PathParam {
    path: String,
}

pub async fn process_file(Json(p): Json<PathParam>) -> Response {
    if let Err(r) = check_path(&p.path) { return r; }
    ok_json(crate::attachments::process_file(p.path).await)
}

pub async fn read_clipboard_text() -> Response {
    ok_json(crate::attachments::read_clipboard_text().await)
}

pub async fn read_clipboard_image() -> Response {
    ok_json(crate::attachments::read_clipboard_image().await)
}

pub async fn cleanup_temp_file(Json(p): Json<PathParam>) -> Response {
    if let Err(r) = check_path(&p.path) { return r; }
    ok_empty(crate::attachments::cleanup_temp_file(p.path).await)
}

// ── Files ──────────────────────────────────────────────────────────

pub async fn read_file(Json(p): Json<PathParam>) -> Response {
    if let Err(r) = check_path(&p.path) { return r; }
    ok_json(crate::file_ops::read_file(p.path).await)
}

pub async fn file_snapshot(Json(p): Json<PathParam>) -> Response {
    if let Err(r) = check_path(&p.path) { return r; }
    ok_json(crate::file_ops::file_snapshot(p.path).await)
}

pub async fn get_home_path() -> Response {
    ok_json(crate::files::get_home_path().await)
}

#[derive(Deserialize)]
pub struct ListDirParam {
    path: String,
}

pub async fn list_directory(Json(p): Json<ListDirParam>) -> Response {
    if let Err(r) = check_path(&p.path) { return r; }
    ok_json(crate::files::list_directory(p.path).await)
}

// ── File serving (replacement for convertFileSrc) ──────────────────

#[derive(Deserialize)]
pub struct FileQuery {
    path: String,
    #[allow(dead_code)]
    token: Option<String>, // Already checked by auth middleware
}

pub async fn serve_file(Query(q): Query<FileQuery>) -> Response {
    use axum::body::Body;
    use axum::http::header;

    if let Err(r) = check_path(&q.path) { return r; }

    let path = std::path::Path::new(&q.path);

    match tokio::fs::read(path).await {
        Ok(data) => {
            let mime = mime_from_ext(path.extension().and_then(|e| e.to_str()).unwrap_or(""));
            ([(header::CONTENT_TYPE, mime)], Body::from(data)).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Read error: {e}")).into_response(),
    }
}

pub fn mime_from_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "js" => "application/javascript",
        "css" => "text/css",
        "html" => "text/html",
        "json" => "application/json",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}
