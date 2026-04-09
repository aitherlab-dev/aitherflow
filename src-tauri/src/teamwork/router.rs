/// Text-based message router for team agents.
///
/// Replaces MCP-based communication. GUI parses @mentions from agent stdout
/// and routes messages via write_if_idle() to target agents.
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use chrono::Utc;
use tokio::sync::{Mutex, RwLock};

/// Global router instance — accessible from process.rs without AppHandle.
static ROUTER: OnceLock<Arc<TeamRouter>> = OnceLock::new();

/// Initialize the global router. Called once at app startup.
pub fn init_global_router(router: Arc<TeamRouter>) {
    let _ = ROUTER.set(router);
}

/// Get the global router.
pub fn get_router() -> Option<&'static Arc<TeamRouter>> {
    ROUTER.get()
}

use crate::conductor::message::build_stdin_message;
use crate::conductor::session::AgentWriter;

/// A message waiting to be delivered (target agent was busy).
struct PendingMessage {
    from_name: String,
    text: String,
}

/// Agent entry in the router.
#[allow(dead_code)] // fields used by get_roster (reserved for team management UI)
struct AgentEntry {
    agent_id: String,
    name: String,
    role: String,
    writer: Arc<AgentWriter>,
}

/// Central message router for team agents.
/// Registered as Tauri managed state.
pub struct TeamRouter {
    agents: RwLock<HashMap<String, AgentEntry>>,
    pending: Mutex<HashMap<String, Vec<PendingMessage>>>,
    /// Early readiness messages from agents who started before team lead registered
    early_readiness: Mutex<Vec<String>>,
    /// Project slug for feed logging
    feed_team: RwLock<Option<String>>,
}

impl Default for TeamRouter {
    fn default() -> Self {
        Self::new()
    }
}

impl TeamRouter {
    pub fn new() -> Self {
        Self {
            agents: RwLock::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            early_readiness: Mutex::new(Vec::new()),
            feed_team: RwLock::new(None),
        }
    }

    /// Set the team name for feed logging.
    pub async fn set_feed_team(&self, team: &str) {
        *self.feed_team.write().await = Some(team.to_string());
    }

    /// Register an agent with the router.
    /// If registering a Team Lead, flushes any early readiness messages.
    pub async fn register(
        &self,
        agent_id: &str,
        name: &str,
        role: &str,
        writer: Arc<AgentWriter>,
    ) {
        self.agents.write().await.insert(
            name.to_string(),
            AgentEntry {
                agent_id: agent_id.to_string(),
                name: name.to_string(),
                role: role.to_string(),
                writer,
            },
        );

        // If this is a team lead, flush any early readiness messages
        if role.eq_ignore_ascii_case("Team Lead") {
            let early = {
                let mut early = self.early_readiness.lock().await;
                std::mem::take(&mut *early)
            };
            for agent_name in early {
                // Use route (with feed log) — these were buffered before lead existed
                if let Err(e) = self.route(&agent_name, name, "готов к работе").await {
                    eprintln!("[router] Failed to send buffered readiness from {agent_name}: {e}");
                }
            }
        }
    }

    /// Unregister an agent.
    pub async fn unregister(&self, name: &str) {
        self.agents.write().await.remove(name);
        self.pending.lock().await.remove(name);
    }

    /// Get list of known agent names (for mention parser).
    pub async fn known_names(&self) -> Vec<String> {
        self.agents.read().await.keys().cloned().collect()
    }

    /// Get roster: (agent_id, name, role) for all registered agents.
    #[allow(dead_code)] // reserved for team management UI
    pub async fn get_roster(&self) -> Vec<(String, String, String)> {
        self.agents
            .read()
            .await
            .values()
            .map(|e| (e.agent_id.clone(), e.name.clone(), e.role.clone()))
            .collect()
    }

    /// Route a message from one agent to another.
    /// Retries up to 30 times (every 500ms) if target is busy.
    pub async fn route(&self, from_name: &str, to_name: &str, text: &str) -> Result<bool, String> {
        self.log_to_feed(from_name, to_name, text).await;
        self.deliver(from_name, to_name, text).await
    }

    /// Deliver a message without logging to feed (used by broadcast to avoid duplicate logs).
    async fn deliver(&self, from_name: &str, to_name: &str, text: &str) -> Result<bool, String> {
        let formatted = format!("[{}]: {}", from_name, text);
        let ndjson = build_stdin_message(&formatted, &[])?;

        // Retry loop: wait for target to become idle
        for attempt in 0..30 {
            let agents = self.agents.read().await;
            let target = agents
                .get(to_name)
                .ok_or_else(|| format!("Agent '{}' not found in router", to_name))?;

            match target.writer.write_if_idle(&ndjson).await? {
                true => return Ok(true),
                false => {
                    drop(agents);
                    if attempt < 29 {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    }
                }
            }
        }

        eprintln!("[router] Failed to deliver message to {to_name} after 30 retries, buffering");
        self.pending
            .lock()
            .await
            .entry(to_name.to_string())
            .or_default()
            .push(PendingMessage {
                from_name: from_name.to_string(),
                text: text.to_string(),
            });
        Ok(false)
    }

    /// Broadcast a message to all agents except the sender.
    pub async fn broadcast(&self, from_name: &str, text: &str) -> Result<(), String> {
        let agents = self.agents.read().await;
        let target_names: Vec<String> = agents
            .keys()
            .filter(|name| name.as_str() != from_name)
            .cloned()
            .collect();
        drop(agents);

        // Log once as broadcast
        self.log_to_feed(from_name, "all", text).await;

        // Deliver to each target (without individual feed logs)
        for target_name in target_names {
            if let Err(e) = self.deliver(from_name, &target_name, text).await {
                eprintln!("[router] Failed to broadcast to {target_name}: {e}");
            }
        }

        Ok(())
    }

    /// Flush pending messages for an agent that just became idle.
    /// Called on TurnComplete.
    pub async fn flush_pending(&self, agent_name: &str) -> Result<(), String> {
        let messages = {
            let mut pending = self.pending.lock().await;
            pending.remove(agent_name).unwrap_or_default()
        };

        if messages.is_empty() {
            return Ok(());
        }

        // Combine all pending into one message
        let combined_text: String = messages
            .iter()
            .map(|m| format!("[{}]: {}", m.from_name, m.text))
            .collect::<Vec<_>>()
            .join("\n\n");

        let ndjson = build_stdin_message(&combined_text, &[])?;

        let agents = self.agents.read().await;
        if let Some(target) = agents.get(agent_name) {
            match target.writer.write_if_idle(&ndjson).await {
                Ok(true) => {}
                Ok(false) => {
                    // Still not idle — re-buffer
                    drop(agents);
                    self.pending
                        .lock()
                        .await
                        .entry(agent_name.to_string())
                        .or_default()
                        .extend(messages);
                }
                Err(e) => {
                    eprintln!("[router] Failed to flush pending for {agent_name}: {e}");
                }
            }
        }

        Ok(())
    }

    /// Notify team lead that an agent is ready.
    /// Finds the first agent with "Team Lead" role and sends readiness message.
    pub async fn notify_ready(&self, agent_name: &str) -> Result<(), String> {
        let agents = self.agents.read().await;
        let lead = agents
            .values()
            .find(|e| e.role.eq_ignore_ascii_case("Team Lead"));

        if let Some(lead) = lead {
            let lead_name = lead.name.clone();
            drop(agents);
            self.route(agent_name, &lead_name, "готов к работе")
                .await?;
        } else {
            // Team lead not registered yet — buffer for when they register
            eprintln!("[router] Team lead not registered yet, buffering readiness from {agent_name}");
            self.early_readiness.lock().await.push(agent_name.to_string());
        }

        Ok(())
    }

    /// Log a message to the feed file for GUI display.
    async fn log_to_feed(&self, from: &str, to: &str, text: &str) {
        let team = self.feed_team.read().await;
        let Some(team) = team.as_ref() else {
            return;
        };

        let msg = crate::teamwork::mailbox::TeamMessage {
            id: uuid::Uuid::new_v4().to_string(),
            from: from.to_string(),
            to: to.to_string(),
            text: text.to_string(),
            timestamp: Utc::now().to_rfc3339(),
            read: false,
            broadcast_id: if to == "all" {
                Some(uuid::Uuid::new_v4().to_string())
            } else {
                None
            },
        };

        let team = team.clone();
        // Fire and forget — don't block routing on feed logging
        tokio::task::spawn_blocking(move || {
            if let Err(e) = crate::teamwork::mailbox::append_to_feed_sync(&team, &msg) {
                eprintln!("[router] Failed to log to feed: {e}");
            }
        });
    }

    /// Clear all state (called when team is disbanded).
    pub async fn clear(&self) {
        self.agents.write().await.clear();
        self.pending.lock().await.clear();
        self.early_readiness.lock().await.clear();
        *self.feed_team.write().await = None;
    }
}
