use std::collections::HashMap;
use std::sync::Arc;

use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::sync::Mutex;

use super::types::SessionStatus;

/// State for a single agent's CLI session.
pub struct AgentSession {
    pub child: Child,
    pub stdin: Option<ChildStdin>,
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
            drop(old.stdin.take());
            if let Err(e) = old.child.kill().await {
                eprintln!("[conductor] Failed to kill old process for {agent_id}: {e}");
            }
            let _ = old.child.wait().await;
        }
        map.insert(agent_id, session);
    }

    /// Take stdin from session (for writing). Returns None if unavailable.
    pub async fn take_stdin(&self, agent_id: &str) -> Option<ChildStdin> {
        let mut map = self.sessions.lock().await;
        map.get_mut(agent_id)?.stdin.take()
    }

    /// Return stdin to session after writing.
    pub async fn return_stdin(&self, agent_id: &str, stdin: ChildStdin) {
        let mut map = self.sessions.lock().await;
        if let Some(session) = map.get_mut(agent_id) {
            session.stdin = Some(stdin);
        }
    }

    /// Remove and kill a session.
    pub async fn kill(&self, agent_id: &str) {
        let mut map = self.sessions.lock().await;
        if let Some(mut session) = map.remove(agent_id) {
            drop(session.stdin.take());
            if let Err(e) = session.child.kill().await {
                eprintln!("[conductor] Failed to kill process for {agent_id}: {e}");
            }
            let _ = session.child.wait().await;
        }
    }

    /// Check if a session exists and its process is still alive.
    pub async fn is_alive(&self, agent_id: &str) -> bool {
        let mut map = self.sessions.lock().await;
        if let Some(session) = map.get_mut(agent_id) {
            // stdin gone = process finishing
            if session.stdin.is_none() {
                return false;
            }
            // Check if process actually exited
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

    /// Update session status.
    pub async fn set_status(&self, agent_id: &str, status: SessionStatus) {
        let mut map = self.sessions.lock().await;
        if let Some(session) = map.get_mut(agent_id) {
            session.status = status;
        }
    }

    /// Kill ALL sessions (for graceful shutdown on app exit).
    pub async fn kill_all(&self) {
        let mut map = self.sessions.lock().await;
        let ids: Vec<String> = map.keys().cloned().collect();
        for id in ids {
            if let Some(mut session) = map.remove(&id) {
                drop(session.stdin.take());
                if let Err(e) = session.child.kill().await {
                    eprintln!("[conductor] Failed to kill process for {id}: {e}");
                }
                let _ = session.child.wait().await;
            }
        }
    }
}
