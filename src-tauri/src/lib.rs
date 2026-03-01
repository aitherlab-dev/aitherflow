mod conductor;
mod config;
mod platform;
mod projects;
mod workspace;

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
            workspace::ensure_default_workspace,
            projects::load_projects,
            projects::save_projects,
        ])
        .setup(|_app| {
            let config_dir = config::config_dir();
            let data_dir = config::data_dir();
            eprintln!("[aitherflow] config: {}", config_dir.display());
            eprintln!("[aitherflow] data:   {}", data_dir.display());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
