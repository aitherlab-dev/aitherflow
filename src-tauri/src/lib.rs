mod agents;
mod attachments;
mod chats;
mod conductor;
mod config;
mod file_ops;
mod files;
mod platform;
mod projects;
mod settings;

use conductor::session::SessionManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionManager::new())
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
            projects::load_projects,
            projects::save_projects,
            agents::load_agents,
            agents::save_agents,
            settings::load_settings,
            settings::save_settings,
            attachments::process_file,
            attachments::read_clipboard_image,
            attachments::cleanup_temp_file,
            files::get_home_path,
            files::list_directory,
            files::list_mounts,
            file_ops::read_file,
            file_ops::write_file,
            file_ops::delete_file,
            file_ops::file_snapshot,
        ])
        .setup(|_app| {
            let config_dir = config::config_dir();
            let data_dir = config::data_dir();
            let workspace = config::workspace_dir();
            eprintln!("[aitherflow] config:    {}", config_dir.display());
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

            // Clean up old temp files from clipboard pastes
            attachments::cleanup_old_temp(3600);

            // Ensure projects.json exists with Workspace as default
            projects::ensure_projects_file();

            // Ensure agents.json exists with default Workspace agent
            // Also migrates old chats without agent_id
            agents::ensure_agents_file();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
