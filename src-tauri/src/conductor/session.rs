use std::collections::HashMap;
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
}

/// Central session registry. Managed by Tauri as app state via `app.manage()`.
///
/// Uses `Arc<Mutex<...>>` so it can be Clone'd into `tokio::spawn` tasks
/// (Tauri's `State<'_>` has a lifetime that can't cross spawn boundaries).
#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, AgentSession>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Insert a new session, killing any existing one for this agent.
    pub async fn insert(&self, agent_id: String, session: AgentSession) {
        let mut map = self.sessions.lock().await;
        if let Some(mut old) = map.remove(&agent_id) {
            drop(old.stdin);
            if let Err(e) = old.child.kill().await {
                eprintln!("[conductor] Failed to kill old process for {agent_id}: {e}");
            }
            if let Err(e) = old.child.wait().await {
                eprintln!("[conductor] Failed to wait for old process of {agent_id}: {e}");
            }
        }
        map.insert(agent_id, session);
    }

    /// Get a cloned Arc handle to session's stdin for writing.
    /// The caller locks the inner Mutex independently of the session map.
    pub async fn get_stdin(&self, agent_id: &str) -> Option<Arc<Mutex<ChildStdin>>> {
        let map = self.sessions.lock().await;
        map.get(agent_id).map(|s| Arc::clone(&s.stdin))
    }

    /// Remove and kill a session.
    pub async fn kill(&self, agent_id: &str) {
        let mut map = self.sessions.lock().await;
        if let Some(mut session) = map.remove(agent_id) {
            drop(session.stdin);
            if let Err(e) = session.child.kill().await {
                eprintln!("[conductor] Failed to kill process for {agent_id}: {e}");
            }
            if let Err(e) = session.child.wait().await {
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
                Err(_) => false,
            }
        } else {
            false
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

    /// Kill ALL sessions (for graceful shutdown on app exit).
    #[allow(dead_code)]
    pub async fn kill_all(&self) {
        let mut map = self.sessions.lock().await;
        let ids: Vec<String> = map.keys().cloned().collect();
        for id in ids {
            if let Some(mut session) = map.remove(&id) {
                drop(session.stdin);
                if let Err(e) = session.child.kill().await {
                    eprintln!("[conductor] Failed to kill process for {id}: {e}");
                }
                if let Err(e) = session.child.wait().await {
                    eprintln!("[conductor] Failed to wait for process of {id}: {e}");
                }
            }
        }
    }
}
