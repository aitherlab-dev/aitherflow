mod agents;
mod attachments;
mod chats;
mod claude_md;
mod conductor;
mod config;
mod devtools;
mod file_ops;
mod file_watcher;
mod files;
mod hooks;
mod mcp;
mod memory;
mod plugins;
mod projects;
mod secrets;
mod settings;
mod skills;
mod telegram;
mod translations;
mod voice;

use conductor::session::SessionManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sessions = SessionManager::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(sessions.clone())
        .manage(file_watcher::WatcherState::new())
        .manage(voice::VoiceState::new())
        .invoke_handler(tauri::generate_handler![
            conductor::start_session,
            conductor::send_message,
            conductor::respond_to_tool,
            conductor::stop_session,
            conductor::has_active_session,
            conductor::get_session_usage,
            conductor::get_cli_stats,
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
            file_ops::rename_entry,
            file_watcher::watch_directories,
            file_watcher::unwatch_directories,
            skills::load_skills,
            skills::load_skill_favorites,
            skills::save_skill_favorites,
            skills::delete_skill,
            skills::move_skill,
            devtools::self_build,
            devtools::self_dev,
            devtools::stop_dev,
            plugins::commands::load_plugins,
            plugins::commands::install_plugin,
            plugins::commands::uninstall_plugin,
            plugins::commands::add_marketplace,
            plugins::commands::remove_marketplace,
            plugins::commands::update_marketplaces,
            translations::load_translations,
            translations::translate_content,
            translations::clear_translations,
            memory::memory_search,
            memory::memory_list_sessions,
            memory::memory_get_session,
            memory::memory_stats,
            memory::memory_index_project,
            voice::recording::voice_start,
            voice::recording::voice_stop,
            voice::groq::voice_transcribe,
            voice::streaming::voice_check_anthropic_auth,
            voice::streaming::voice_start_stream,
            voice::streaming::voice_stop_stream,
            telegram::commands::load_telegram_config,
            telegram::commands::save_telegram_config,
            telegram::commands::get_telegram_status,
            telegram::commands::start_telegram_bot,
            telegram::commands::stop_telegram_bot,
            telegram::commands::poll_telegram_messages,
            telegram::commands::send_to_telegram,
            telegram::commands::notify_telegram,
            telegram::commands::telegram_send_menu,
            telegram::commands::telegram_send_agents,
            telegram::commands::telegram_send_projects,
            telegram::commands::telegram_send_status,
            telegram::commands::telegram_send_history,
            telegram::commands::telegram_send_skills,
            telegram::commands::telegram_stream_edit,
            telegram::commands::telegram_stream_reset,
            hooks::load_hooks,
            hooks::save_hooks,
            hooks::test_hook_command,
            mcp::list_mcp_servers,
            mcp::add_global_mcp_server,
            mcp::remove_global_mcp_server,
            mcp::save_project_mcp_servers,
            mcp::test_mcp_server,
            mcp::reset_mcp_project_choices,
            claude_md::list_claude_md_files,
            claude_md::read_claude_md,
            claude_md::save_claude_md,
        ])
        .setup(move |_app| {
            // Keep `sessions` alive until setup completes (State already holds a clone via .manage())
            let _sessions = sessions;
            tauri::async_runtime::spawn(async move {
                let tg_enabled = tokio::task::spawn_blocking(|| {
                    let cfg_dir = config::config_dir();
                    let data_dir = config::data_dir();
                    let workspace = config::workspace_dir();
                    eprintln!("[aitherflow] config:    {}", cfg_dir.display());
                    eprintln!("[aitherflow] data:      {}", data_dir.display());
                    eprintln!("[aitherflow] workspace: {}", workspace.display());

                    if !workspace.exists() {
                        if let Err(e) = std::fs::create_dir_all(&workspace) {
                            eprintln!("[aitherflow] Failed to create workspace: {e}");
                        } else {
                            let claude_md = workspace.join("CLAUDE.md");
                            let content = "# Workspace\n\n\
                                You are running inside Aither Flow, a custom GUI for Claude Code CLI.\n\
                                The user may ask you to test things, search the web, automate tasks, etc.\n";
                            if let Err(e) = file_ops::atomic_write(&claude_md, content.as_bytes()) {
                                eprintln!("[aitherflow] Failed to write CLAUDE.md: {e}");
                            }
                        }
                    }

                    if let Err(e) = memory::init() {
                        eprintln!("[aitherflow] memory::init failed: {e}");
                    }
                    attachments::cleanup_old_temp(3600);
                    projects::ensure_projects_file();
                    agents::ensure_agents_file();

                    telegram::is_enabled()
                }).await.unwrap_or_else(|e| {
                    eprintln!("[aitherflow] Setup task panicked: {e}");
                    false
                });

                if tg_enabled {
                    match telegram::commands::start_telegram_bot().await {
                        Ok(st) => eprintln!("[aitherflow] Telegram bot started: @{}", st.bot_username.unwrap_or_default()),
                        Err(e) => eprintln!("[aitherflow] Telegram bot auto-start failed: {e}"),
                    }
                }

            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("[aitherflow] Fatal: failed to run application: {e}");
            std::process::exit(1);
        });
}
