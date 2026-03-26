use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// A pool of named mutexes for per-key locking (e.g. per-chat, per-task).
///
/// Automatically evicts stale entries (where the caller no longer holds the Arc).
pub struct NamedMutexPool {
    label: &'static str,
    inner: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl NamedMutexPool {
    pub fn new(label: &'static str) -> Self {
        Self {
            label,
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Get or create a mutex for the given key. Evicts stale entries on each call.
    pub fn lock(&self, key: &str) -> Arc<Mutex<()>> {
        let mut map = self.inner.lock().unwrap_or_else(|e| {
            eprintln!("[{label}] WARNING: mutex pool poisoned, recovering", label = self.label);
            e.into_inner()
        });
        map.retain(|_, arc| Arc::strong_count(arc) > 1);
        map.entry(key.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Remove a single entry by key.
    pub fn remove(&self, key: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(key);
        }
    }

    /// Retain only entries whose keys are in the given set.
    pub fn retain_keys(&self, live_keys: &std::collections::HashSet<String>) {
        if let Ok(mut map) = self.inner.lock() {
            map.retain(|id, _| live_keys.contains(id));
        }
    }

    /// Remove entries matching a key prefix (e.g. on team deletion).
    pub fn remove_by_prefix(&self, prefix: &str) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|key, arc| {
            if key.starts_with(prefix) {
                Arc::strong_count(arc) > 1
            } else {
                true
            }
        });
    }
}
