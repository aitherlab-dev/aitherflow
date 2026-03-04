mod agents;
mod attachments;
mod chats;
mod conductor;
mod config;
mod devtools;
mod file_ops;
mod file_watcher;
mod files;
mod memory;
mod platform;
mod plugins;
mod projects;
mod settings;
mod skills;
mod translations;
mod voice;
mod web_server;

use conductor::session::SessionManager;

/// Manages the lifecycle of the embedded web server (start/stop at runtime).
mod web_server_manager {
    use std::sync::Arc;
    use tokio::sync::Mutex;
    use tokio::task::JoinHandle;

    use crate::conductor::session::SessionManager;
    use crate::web_server;

    #[derive(Clone)]
    pub struct WebServerManager {
        handle: Arc<Mutex<Option<JoinHandle<()>>>>,
        sessions: SessionManager,
        session_store: web_server::auth::SessionStore,
    }

    impl WebServerManager {
        pub fn new(
            sessions: SessionManager,
            session_store: web_server::auth::SessionStore,
        ) -> Self {
            Self {
                handle: Arc::new(Mutex::new(None)),
                sessions,
                session_store,
            }
        }

        pub async fn start(&self) -> Result<(), String> {
            let mut guard = self.handle.lock().await;
            if guard.is_some() {
                return Err("Web server is already running".into());
            }

            let mut cfg = crate::web_config::load();
            if cfg.token.is_empty() {
                cfg.token = crate::web_config::generate_token();
                crate::web_config::save(&cfg);
            }

            let (event_tx, _) = tokio::sync::broadcast::channel(512);

            let state = web_server::WebState {
                sessions: self.sessions.clone(),
                event_tx,
                auth_token: cfg.token.clone(),
                rate_limiter: web_server::auth::RateLimiter::new(),
                session_store: self.session_store.clone(),
            };

            let port = cfg.port;
            let remote = cfg.remote_access;

            let h = tokio::spawn(async move {
                if let Err(e) = web_server::run(state, port, remote).await {
                    eprintln!("[web_server] {e}");
                }
            });

            eprintln!(
                "[aitherflow] Web server started on port {}, token: {}…",
                cfg.port,
                &cfg.token[..8.min(cfg.token.len())]
            );

            *guard = Some(h);
            Ok(())
        }

        pub async fn stop(&self) {
            let mut guard = self.handle.lock().await;
            if let Some(h) = guard.take() {
                h.abort();
                eprintln!("[aitherflow] Web server stopped");
            }
        }

        pub async fn is_running(&self) -> bool {
            let guard = self.handle.lock().await;
            match &*guard {
                Some(h) => !h.is_finished(),
                None => false,
            }
        }
    }

    #[tauri::command]
    pub async fn start_web_server(
        mgr: tauri::State<'_, WebServerManager>,
    ) -> Result<(), String> {
        mgr.start().await
    }

    #[tauri::command]
    pub async fn stop_web_server(
        mgr: tauri::State<'_, WebServerManager>,
    ) -> Result<(), String> {
        mgr.stop().await;
        Ok(())
    }

    #[tauri::command]
    pub async fn web_server_status(
        mgr: tauri::State<'_, WebServerManager>,
    ) -> Result<bool, String> {
        Ok(mgr.is_running().await)
    }
}

/// Web server config: ~/.config/aither-flow/web-server.json
pub mod web_config {
    use serde::{Deserialize, Serialize};
    use std::fs;

    #[derive(Serialize, Deserialize, Clone)]
    pub struct WebServerConfig {
        #[serde(default)]
        pub enabled: bool,
        #[serde(default = "default_port")]
        pub port: u16,
        #[serde(default)]
        pub token: String,
        /// Allow remote access (bind 0.0.0.0 instead of 127.0.0.1)
        #[serde(default)]
        pub remote_access: bool,
    }

    fn default_port() -> u16 {
        3080
    }

    impl Default for WebServerConfig {
        fn default() -> Self {
            Self {
                enabled: false,
                port: default_port(),
                token: String::new(),
                remote_access: false,
            }
        }
    }

    fn config_path() -> std::path::PathBuf {
        crate::config::config_dir().join("web-server.json")
    }

    pub fn load() -> WebServerConfig {
        let path = config_path();
        if !path.exists() {
            return WebServerConfig::default();
        }
        fs::read_to_string(&path)
            .ok()
            .and_then(|data| serde_json::from_str(&data).ok())
            .unwrap_or_default()
    }

    pub fn save(cfg: &WebServerConfig) {
        let path = config_path();
        if let Ok(data) = serde_json::to_string_pretty(cfg) {
            let _ = crate::file_ops::atomic_write(&path, data.as_bytes());
        }
    }

    pub fn generate_token() -> String {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let bytes: Vec<u8> = (0..32).map(|_| rng.gen()).collect();
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[tauri::command]
    pub async fn load_web_config() -> Result<WebServerConfig, String> {
        Ok(load())
    }

    #[tauri::command]
    pub async fn save_web_config(config: WebServerConfig) -> Result<(), String> {
        save(&config);
        Ok(())
    }

    #[tauri::command]
    pub async fn generate_web_token() -> Result<String, String> {
        Ok(generate_token())
    }

    #[tauri::command]
    pub async fn create_auth_code(
        store: tauri::State<'_, crate::web_server::auth::SessionStore>,
    ) -> Result<serde_json::Value, String> {
        let code = store.create_code().await;
        Ok(serde_json::json!({ "code": code }))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Shared session manager for both Tauri and Axum
    let sessions = SessionManager::new();

    let session_store = web_server::auth::SessionStore::new();

    let web_mgr = web_server_manager::WebServerManager::new(
        sessions.clone(),
        session_store.clone(),
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(sessions.clone())
        .manage(session_store.clone())
        .manage(web_mgr.clone())
        .manage(file_watcher::WatcherState::new())
        .manage(voice::VoiceState::new())
        .invoke_handler(tauri::generate_handler![
            conductor::start_session,
            conductor::send_message,
            conductor::stop_session,
            conductor::has_active_session,
            config::get_workspace_path,
            chats::list_chats,
            chats::create_chat,
            chats::load_chat,
            chats::save_chat_messages,
            chats::update_chat_session,
            chats::delete_chat,
            chats::rename_chat,
            chats::toggle_chat_pin,
            projects::load_projects,
            projects::save_projects,
            agents::load_agents,
            agents::save_agents,
            settings::load_settings,
            settings::save_settings,
            attachments::process_file,
            attachments::read_clipboard_image,
            attachments::read_clipboard_text,
            attachments::cleanup_temp_file,
            files::get_home_path,
            files::list_directory,
            files::list_mounts,
            file_ops::read_file,
            file_ops::write_file,
            file_ops::delete_file,
            file_ops::file_snapshot,
            file_ops::trash_entry,
            file_ops::create_directory,
            file_ops::create_file,
            file_ops::copy_entry,
            file_watcher::watch_directories,
            file_watcher::unwatch_directories,
            skills::load_skills,
            skills::load_skill_favorites,
            skills::save_skill_favorites,
            devtools::self_build,
            devtools::self_dev,
            devtools::stop_dev,
            plugins::load_plugins,
            plugins::install_plugin,
            plugins::uninstall_plugin,
            plugins::add_marketplace,
            plugins::remove_marketplace,
            plugins::update_marketplaces,
            translations::load_translations,
            translations::translate_content,
            translations::clear_translations,
            memory::memory_search,
            memory::memory_list_sessions,
            memory::memory_get_session,
            memory::memory_stats,
            memory::memory_index_project,
            web_config::load_web_config,
            web_config::save_web_config,
            web_config::generate_web_token,
            web_config::create_auth_code,
            web_server_manager::start_web_server,
            web_server_manager::stop_web_server,
            web_server_manager::web_server_status,
            voice::voice_start,
            voice::voice_stop,
            voice::voice_transcribe,
        ])
        .setup(move |_app| {
            let cfg_dir = config::config_dir();
            let data_dir = config::data_dir();
            let workspace = config::workspace_dir();
            eprintln!("[aitherflow] config:    {}", cfg_dir.display());
            eprintln!("[aitherflow] data:      {}", data_dir.display());
            eprintln!("[aitherflow] workspace: {}", workspace.display());

            // Create default workspace with CLAUDE.md on first launch
            if !workspace.exists() {
                if let Err(e) = std::fs::create_dir_all(&workspace) {
                    eprintln!("[aitherflow] Failed to create workspace: {e}");
                } else {
                    let claude_md = workspace.join("CLAUDE.md");
                    let content = "# Workspace\n\n\
                        You are running inside Aither Flow, a custom GUI for Claude Code CLI.\n\
                        The user may ask you to test things, search the web, automate tasks, etc.\n";
                    if let Err(e) = std::fs::write(&claude_md, content) {
                        eprintln!("[aitherflow] Failed to write CLAUDE.md: {e}");
                    }
                }
            }

            // Initialize session memory database
            memory::init();

            // Clean up old temp files from clipboard pastes
            attachments::cleanup_old_temp(3600);

            // Ensure projects.json exists with Workspace as default
            projects::ensure_projects_file();

            // Ensure agents.json exists with default Workspace agent
            // Also migrates old chats without agent_id
            agents::ensure_agents_file();

            // Start web server if enabled
            if web_config::load().enabled {
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = web_mgr.start().await {
                        eprintln!("[aitherflow] Failed to start web server: {e}");
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
