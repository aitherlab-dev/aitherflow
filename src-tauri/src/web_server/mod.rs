pub mod auth;
pub mod handlers;
pub mod ws;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use include_dir::{include_dir, Dir};
use tokio::sync::broadcast;

use crate::conductor::session::SessionManager;
use crate::conductor::types::CliEvent;

/// Frontend files embedded at compile time from ../dist/
static EMBEDDED_DIST: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../dist");

/// Shared state available to all Axum handlers.
#[derive(Clone)]
pub struct WebState {
    pub sessions: SessionManager,
    pub event_tx: broadcast::Sender<CliEvent>,
    pub auth_token: String,
    pub rate_limiter: auth::RateLimiter,
    pub session_store: auth::SessionStore,
    pub remote_access: bool,
}

/// Start the embedded web server. Returns `Err` only if binding fails.
/// Otherwise runs until the task is aborted.
pub async fn run(state: WebState, port: u16, remote_access: bool) -> Result<(), String> {
    // Periodically clean up expired auth codes and sessions (every 10 min)
    state.session_store.spawn_cleanup_task();

    let state = Arc::new(state);

    let api = Router::new()
        // ── Conductor ──
        .route("/api/start_session", post(handlers::start_session))
        .route("/api/send_message", post(handlers::send_message))
        .route("/api/respond_to_tool", post(handlers::respond_to_tool))
        .route("/api/stop_session", post(handlers::stop_session))
        .route("/api/has_active_session", post(handlers::has_active_session))
        // ── Chats ──
        .route("/api/list_chats", post(handlers::list_chats))
        .route("/api/create_chat", post(handlers::create_chat))
        .route("/api/load_chat", post(handlers::load_chat))
        .route("/api/save_chat_messages", post(handlers::save_chat_messages))
        .route("/api/update_chat_session", post(handlers::update_chat_session))
        .route("/api/delete_chat", post(handlers::delete_chat))
        .route("/api/rename_chat", post(handlers::rename_chat))
        .route("/api/toggle_chat_pin", post(handlers::toggle_chat_pin))
        // ── Agents ──
        .route("/api/load_agents", post(handlers::load_agents))
        .route("/api/save_agents", post(handlers::save_agents))
        // ── Projects ──
        .route("/api/load_projects", post(handlers::load_projects))
        .route("/api/save_projects", post(handlers::save_projects))
        // ── Settings ──
        .route("/api/load_settings", post(handlers::load_settings))
        .route("/api/save_settings", post(handlers::save_settings))
        // ── Skills ──
        .route("/api/load_skills", post(handlers::load_skills))
        .route("/api/load_skill_favorites", post(handlers::load_skill_favorites))
        .route("/api/save_skill_favorites", post(handlers::save_skill_favorites))
        // ── Plugins ──
        .route("/api/load_plugins", post(handlers::load_plugins))
        .route("/api/install_plugin", post(handlers::install_plugin))
        .route("/api/uninstall_plugin", post(handlers::uninstall_plugin))
        .route("/api/add_marketplace", post(handlers::add_marketplace))
        .route("/api/remove_marketplace", post(handlers::remove_marketplace))
        .route("/api/update_marketplaces", post(handlers::update_marketplaces))
        // ── Translations ──
        .route("/api/load_translations", post(handlers::load_translations))
        .route("/api/translate_content", post(handlers::translate_content))
        .route("/api/clear_translations", post(handlers::clear_translations))
        // ── Hooks ──
        .route("/api/load_hooks", post(handlers::load_hooks))
        .route("/api/save_hooks", post(handlers::save_hooks))
        // test_hook_command intentionally excluded — executes arbitrary shell commands
        // ── Web Config ──
        .route("/api/load_web_config", post(handlers::load_web_config))
        .route("/api/save_web_config", post(handlers::save_web_config))
        .route("/api/generate_web_token", post(handlers::generate_web_token))
        // ── Memory ──
        .route("/api/memory_stats", post(handlers::memory_stats))
        .route("/api/memory_index_project", post(handlers::memory_index_project))
        // ── Attachments ──
        .route("/api/process_file", post(handlers::process_file))
        .route("/api/read_clipboard_text", post(handlers::read_clipboard_text))
        .route("/api/read_clipboard_image", post(handlers::read_clipboard_image))
        .route("/api/cleanup_temp_file", post(handlers::cleanup_temp_file))
        // ── Files ──
        .route("/api/read_file", post(handlers::read_file))
        .route("/api/file_snapshot", post(handlers::file_snapshot))
        .route("/api/get_home_path", post(handlers::get_home_path))
        .route("/api/list_directory", post(handlers::list_directory))
        // ── File serving (for convertFileSrc) ──
        .route("/api/file", get(handlers::serve_file))
        // ── Auth ──
        .route("/api/create_auth_code", post(handlers::create_auth_code))
        // ── WebSocket ──
        .route("/ws", get(ws::ws_handler))
        // ── Middleware ──
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024)) // 50MB for image uploads
        // No CORS layer — frontend is served from same origin.
        // Cross-origin requests are blocked by default.
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .with_state(state.clone());

    // Auth code exchange — no auth required (the code IS the auth)
    let auth_route = Router::new()
        .route("/auth", get(handlers::exchange_auth_code))
        .with_state(state.clone());

    // SPA fallback: serve embedded frontend files
    let app = api.merge(auth_route).fallback(serve_embedded);

    let bind_ip: [u8; 4] = if remote_access { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
    let addr = SocketAddr::from((bind_ip, port));
    eprintln!("[web_server] Listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind port {port}: {e}"))?;

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .map_err(|e| format!("Web server error: {e}"))
}

/// Serve static files from the embedded dist/ directory.
/// Falls back to index.html for SPA client-side routing.
async fn serve_embedded(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    // Try exact file match first
    if let Some(file) = EMBEDDED_DIST.get_file(path) {
        let ext = path.rsplit('.').next().unwrap_or("");
        let mime = handlers::mime_from_ext(ext);
        return ([(header::CONTENT_TYPE, mime)], file.contents()).into_response();
    }

    // SPA fallback: serve index.html for all other routes
    if let Some(index) = EMBEDDED_DIST.get_file("index.html") {
        return ([(header::CONTENT_TYPE, "text/html")], index.contents()).into_response();
    }

    StatusCode::NOT_FOUND.into_response()
}
