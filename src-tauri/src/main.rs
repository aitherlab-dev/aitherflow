// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK on Linux under Wayland needs this
    #[cfg(target_os = "linux")]
    {
        if std::env::var("GDK_BACKEND").is_err() {
            // Let GDK pick the best backend (X11 or Wayland)
        }
    }

    aitherflow_lib::run()
}
