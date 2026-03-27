use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::io::AsyncWriteExt;
use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::sync::Mutex;

use super::types::SessionStatus;

/// Guards stdin + status under a single lock so that
/// "check idle → write → set thinking" is atomic.
pub struct AgentWriter {
    inner: Mutex<WriterInner>,
}

struct WriterInner {
    stdin: Option<ChildStdin>,
    status: SessionStatus,
}

impl AgentWriter {
    pub fn new(stdin: ChildStdin) -> Self {
        Self {
            inner: Mutex::new(WriterInner {
                stdin: Some(stdin),
                status: SessionStatus::Thinking,
            }),
        }
    }

    /// Write a message unconditionally (user input, control responses).
    /// Sets status to Thinking after writing.
    pub async fn write_message(&self, ndjson: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        let stdin = inner
            .stdin
            .as_mut()
            .ok_or_else(|| "Session stdin closed".to_string())?;

        stdin
            .write_all(ndjson.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to stdin: {e}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write newline: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stdin: {e}"))?;

        inner.status = SessionStatus::Thinking;
        Ok(())
    }

    /// Write a message only if agent is Idle (for mailbox polling).
    /// Returns Ok(true) if sent, Ok(false) if not idle.
    pub async fn write_if_idle(&self, ndjson: &str) -> Result<bool, String> {
        let mut inner = self.inner.lock().await;
        if inner.status != SessionStatus::Idle {
            return Ok(false);
        }

        let stdin = inner
            .stdin
            .as_mut()
            .ok_or_else(|| "Session stdin closed".to_string())?;

        stdin
            .write_all(ndjson.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to stdin: {e}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write newline: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stdin: {e}"))?;

        inner.status = SessionStatus::Thinking;
        Ok(true)
    }

    pub async fn set_status(&self, status: SessionStatus) {
        self.inner.lock().await.status = status;
    }

    pub async fn get_status(&self) -> SessionStatus {
        self.inner.lock().await.status.clone()
    }

    /// Close stdin pipe (async).
    pub async fn close(&self) {
        self.inner.lock().await.stdin = None;
    }

    /// Best-effort synchronous status check (no async runtime needed).
    pub fn try_get_status(&self) -> Option<SessionStatus> {
        self.inner.try_lock().ok().map(|inner| inner.status.clone())
    }

    /// Best-effort synchronous close (for app exit when async runtime may be shutting down).
    pub fn try_close(&self) {
        if let Ok(mut inner) = self.inner.try_lock() {
            inner.stdin = None;
        }
    }
}

/// State for a single agent's CLI session.
pub struct AgentSession {
    pub child: Child,
    pub writer: Arc<AgentWriter>,
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

        // Extract old session under lock, then release lock before kill/wait
        let old_session = {
            let mut map = self.sessions.lock().await;
            let old = map.remove(&agent_id);
            map.insert(agent_id.clone(), session);
            old
        };

        // Kill old process outside lock (BUG-002 fix: no await under mutex)
        if let Some(old) = old_session {
            old.writer.close().await;
            let mut child = old.child;
            if let Err(e) = child.kill().await {
                eprintln!("[conductor] Failed to kill old process for {agent_id}: {e}");
            }
            if let Err(e) = child.wait().await {
                eprintln!("[conductor] Failed to wait for old process of {agent_id}: {e}");
            }
        }

        generation
    }

    /// Get a cloned Arc handle to the agent's writer.
    pub async fn get_writer(&self, agent_id: &str) -> Option<Arc<AgentWriter>> {
        let map = self.sessions.lock().await;
        map.get(agent_id).map(|s| Arc::clone(&s.writer))
    }

    /// Remove and kill a session, but ONLY if the generation matches.
    /// This prevents a finishing old session from killing a newly-started one (BUG-001 fix).
    pub async fn cleanup(&self, agent_id: &str, generation: u64) {
        // Extract session under lock only if generation matches
        let old_session = {
            let mut map = self.sessions.lock().await;
            match map.get(agent_id) {
                Some(s) if s.generation == generation => map.remove(agent_id),
                _ => None, // Different generation or missing — don't touch
            }
        };

        if let Some(session) = old_session {
            session.writer.close().await;
            let mut child = session.child;
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
        let old_session = {
            let mut map = self.sessions.lock().await;
            map.remove(agent_id)
        };

        if let Some(session) = old_session {
            session.writer.close().await;
            let mut child = session.child;
            if let Err(e) = child.kill().await {
                eprintln!("[conductor] Failed to kill process for {agent_id}: {e}");
            }
            if let Err(e) = child.wait().await {
                eprintln!("[conductor] Failed to wait for process of {agent_id}: {e}");
            }
        }
    }


    /// Check if any session is currently in Thinking state.
    /// Uses `try_lock` — safe to call from sync context.
    pub fn has_active_sessions(&self) -> bool {
        let Ok(map) = self.sessions.try_lock() else {
            return false;
        };
        for session in map.values() {
            if session.writer.try_get_status() == Some(SessionStatus::Thinking) {
                return true;
            }
        }
        false
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
                    s.writer.try_close();
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
}
