use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Event payload sent to the frontend
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangeEvent {
    /// The directory that changed (parent path)
    pub path: String,
}

/// Holds the current watcher (one at a time — watching the active project/browser dir)
pub struct WatcherState {
    inner: Mutex<Option<WatcherHandle>>,
}

struct WatcherHandle {
    _debouncer: notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
    _watched_paths: Vec<PathBuf>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

/// Start watching a list of directory paths. Replaces any previous watcher.
#[tauri::command]
pub async fn watch_directories(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let app_clone = app.clone();

    // Build the watcher on a blocking thread (notify setup may touch fs)
    let handle = tokio::task::spawn_blocking(move || {
        let app_for_cb = app_clone;
        let mut debouncer = new_debouncer(
            Duration::from_millis(500),
            move |result: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
                let events = match result {
                    Ok(evts) => evts,
                    Err(e) => {
                        eprintln!("[watcher] error: {e}");
                        return;
                    }
                };

                // Collect unique parent directories that changed
                let mut changed: Vec<String> = Vec::new();
                for evt in &events {
                    if evt.kind != DebouncedEventKind::Any {
                        continue;
                    }
                    let parent = evt
                        .path
                        .parent()
                        .unwrap_or(&evt.path)
                        .to_string_lossy()
                        .into_owned();
                    if !changed.contains(&parent) {
                        changed.push(parent);
                    }
                }

                for path in changed {
                    let _ = app_for_cb.emit("fs-change", FsChangeEvent { path });
                }
            },
        )
        .map_err(|e| format!("Failed to create watcher: {e}"))?;

        let mut watched_paths = Vec::new();
        for p in &paths {
            let path = PathBuf::from(p);
            if path.is_dir() {
                debouncer
                    .watcher()
                    .watch(&path, notify::RecursiveMode::Recursive)
                    .map_err(|e| format!("Failed to watch {p}: {e}"))?;
                watched_paths.push(path);
            }
        }

        Ok::<WatcherHandle, String>(WatcherHandle {
            _debouncer: debouncer,
            _watched_paths: watched_paths,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    // Replace previous watcher (old one drops and stops automatically)
    let mut guard = state.inner.lock().map_err(|e| format!("Lock error: {e}"))?;
    *guard = Some(handle);

    Ok(())
}

/// Stop watching all directories.
#[tauri::command]
pub async fn unwatch_directories(app: AppHandle) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let mut guard = state.inner.lock().map_err(|e| format!("Lock error: {e}"))?;
    *guard = None;
    Ok(())
}
