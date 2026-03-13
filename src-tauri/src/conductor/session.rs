use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::sync::Mutex;

use super::types::SessionStatus;

/// State for a single agent's CLI session.
pub struct AgentSession {
    pub child: Child,
    pub stdin: Arc<Mutex<ChildStdin>>,
    pub status: SessionStatus,
    /// Unique generation counter — incremented on each insert.
    pub generation: u64,
}

/// Central session registry. Managed by Tauri as app state via `app.manage()`.
///
/// Uses `Arc<Mutex<...>>` so it can be Clone'd into `tokio::spawn` tasks
/// (Tauri's `State<'_>` has a lifetime that can't cross spawn boundaries).
#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, AgentSession>>>,
    gen_counter: Arc<AtomicU64>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            gen_counter: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Insert a new session, killing any existing one for this agent.
    /// Returns the generation number assigned to this session.
    pub async fn insert(&self, agent_id: String, mut session: AgentSession) -> u64 {
        let generation = self.gen_counter.fetch_add(1, Ordering::Relaxed) + 1;
        session.generation = generation;

        // Extract old child under lock, then release lock before kill/wait
        let old_child = {
            let mut map = self.sessions.lock().await;
            let old = map.remove(&agent_id);
            map.insert(agent_id.clone(), session);
            old.map(|s| {
                drop(s.stdin);
                s.child
            })
        };

        // Kill old process outside lock (BUG-002 fix: no await under mutex)
        if let Some(mut child) = old_child {
            if let Err(e) = child.kill().await {
                eprintln!("[conductor] Failed to kill old process for {agent_id}: {e}");
            }
            if let Err(e) = child.wait().await {
                eprintln!("[conductor] Failed to wait for old process of {agent_id}: {e}");
            }
        }

        generation
    }

    /// Get a cloned Arc handle to session's stdin for writing.
    /// The caller locks the inner Mutex independently of the session map.
    pub async fn get_stdin(&self, agent_id: &str) -> Option<Arc<Mutex<ChildStdin>>> {
        let map = self.sessions.lock().await;
        map.get(agent_id).map(|s| Arc::clone(&s.stdin))
    }

    /// Remove and kill a session, but ONLY if the generation matches.
    /// This prevents a finishing old session from killing a newly-started one (BUG-001 fix).
    pub async fn cleanup(&self, agent_id: &str, generation: u64) {
        // Extract child under lock only if generation matches
        let old_child = {
            let mut map = self.sessions.lock().await;
            match map.get(agent_id) {
                Some(s) if s.generation == generation => {
                    let s = map.remove(agent_id).unwrap();
                    drop(s.stdin);
                    Some(s.child)
                }
                _ => None, // Different generation or missing — don't touch
            }
        };

        // Kill outside lock
        if let Some(mut child) = old_child {
            if let Err(e) = child.kill().await {
                eprintln!("[conductor] Failed to kill process for {agent_id}: {e}");
            }
            if let Err(e) = child.wait().await {
                eprintln!("[conductor] Failed to wait for process of {agent_id}: {e}");
            }
        }
    }

    /// Remove and kill a session unconditionally (user-initiated stop).
    pub async fn kill(&self, agent_id: &str) {
        let old_child = {
            let mut map = self.sessions.lock().await;
            map.remove(agent_id).map(|s| {
                drop(s.stdin);
                s.child
            })
        };

        if let Some(mut child) = old_child {
            if let Err(e) = child.kill().await {
                eprintln!("[conductor] Failed to kill process for {agent_id}: {e}");
            }
            if let Err(e) = child.wait().await {
                eprintln!("[conductor] Failed to wait for process of {agent_id}: {e}");
            }
        }
    }

    /// Check if a session exists and its process is still alive.
    pub async fn is_alive(&self, agent_id: &str) -> bool {
        let mut map = self.sessions.lock().await;
        if let Some(session) = map.get_mut(agent_id) {
            match session.child.try_wait() {
                Ok(Some(_)) => {
                    // Process exited — clean up
                    map.remove(agent_id);
                    false
                }
                Ok(None) => true, // Still running
                Err(e) => {
                    eprintln!("[conductor] try_wait failed for agent {agent_id}: {e}");
                    false
                }
            }
        } else {
            false
        }
    }

    /// Kill all sessions synchronously (called on app exit).
    /// Uses `try_lock` + `start_kill` to avoid async runtime dependency.
    pub fn kill_all_sync(&self) {
        let children: Vec<(String, Child)> = {
            let Ok(mut map) = self.sessions.try_lock() else {
                eprintln!("[conductor] Could not lock sessions for cleanup");
                return;
            };
            map.drain()
                .map(|(id, s)| {
                    drop(s.stdin);
                    (id, s.child)
                })
                .collect()
        };

        for (agent_id, mut child) in children {
            if let Err(e) = child.start_kill() {
                eprintln!("[conductor] Failed to kill process for {agent_id}: {e}");
            }
        }
    }

    /// Try to get the exit code of the child process without killing it.
    pub async fn try_exit_code(&self, agent_id: &str) -> Option<i32> {
        let mut map = self.sessions.lock().await;
        if let Some(session) = map.get_mut(agent_id) {
            match session.child.try_wait() {
                Ok(Some(status)) => status.code(),
                _ => None,
            }
        } else {
            None
        }
    }

    /// Update session status.
    pub async fn set_status(&self, agent_id: &str, status: SessionStatus) {
        let mut map = self.sessions.lock().await;
        if let Some(session) = map.get_mut(agent_id) {
            session.status = status;
        }
    }

    /// Read session status (None if session doesn't exist).
    pub async fn get_status(&self, agent_id: &str) -> Option<SessionStatus> {
        let map = self.sessions.lock().await;
        map.get(agent_id).map(|s| s.status.clone())
    }
}
