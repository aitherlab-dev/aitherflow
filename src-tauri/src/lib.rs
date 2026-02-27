mod config;
mod platform;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
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
