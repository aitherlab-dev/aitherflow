use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Default agent ID for single-agent mode (Stage 2).
/// Multi-agent (Stage 7) will generate unique IDs.
pub const DEFAULT_AGENT_ID: &str = "default";

/// Events emitted from conductor to frontend via Tauri global events.
/// Tagged union — frontend receives `{ type: "streamChunk", agent_id: "...", text: "..." }`.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type")]
pub enum CliEvent {
    /// CLI session initialized — contains session ID
    #[serde(rename = "sessionId")]
    SessionId {
        agent_id: String,
        session_id: String,
    },

    /// Partial streaming text (accumulated across deltas)
    #[serde(rename = "streamChunk")]
    StreamChunk { agent_id: String, text: String },

    /// Final complete message text after a turn
    #[serde(rename = "messageComplete")]
    MessageComplete { agent_id: String, text: String },

    /// Model information from system event
    #[serde(rename = "modelInfo")]
    ModelInfo { agent_id: String, model: String },

    /// Slash commands available in this CLI session
    #[serde(rename = "slashCommands")]
    SlashCommands {
        agent_id: String,
        commands: Vec<String>,
    },

    /// Token usage and cost from result event (cumulative over session)
    #[serde(rename = "usageInfo")]
    UsageInfo {
        agent_id: String,
        input_tokens: u64,
        output_tokens: u64,
        cache_creation_input_tokens: u64,
        cache_read_input_tokens: u64,
        cost_usd: f64,
        /// Context window size from modelUsage (0 = not available)
        context_window: u64,
    },

    /// Context window usage from assistant event (per-turn = actual context size)
    #[serde(rename = "contextInfo")]
    ContextInfo {
        agent_id: String,
        /// input + cache_creation + cache_read = how much context is used
        context_used: u64,
        output_tokens: u64,
    },

    /// Tool invocation (from assistant message)
    #[serde(rename = "toolUse")]
    ToolUse {
        agent_id: String,
        tool_use_id: String,
        tool_name: String,
        tool_input: Value,
    },

    /// Tool result (from user/tool_result message)
    #[serde(rename = "toolResult")]
    ToolResult {
        agent_id: String,
        tool_use_id: String,
        output_preview: String,
        is_error: bool,
    },

    /// CLI requests permission or user input (control_request protocol)
    #[serde(rename = "controlRequest")]
    ControlRequest {
        agent_id: String,
        request_id: String,
        tool_name: String,
        tool_use_id: String,
        input: Value,
        description: Option<String>,
    },

    /// One CLI turn completed — process still alive, awaiting input
    #[serde(rename = "turnComplete")]
    TurnComplete { agent_id: String },

    /// CLI process exited (naturally or killed)
    #[serde(rename = "processExited")]
    ProcessExited {
        agent_id: String,
        exit_code: Option<i32>,
    },

    /// Error: CLI stderr, parse failure, or spawn failure
    #[serde(rename = "error")]
    Error { agent_id: String, message: String },
}

/// Status of an agent session.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub enum SessionStatus {
    /// Process running, waiting for CLI response
    Thinking,
    /// Process has exited
    Exited,
}

/// Attachment payload from frontend
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPayload {
    #[allow(dead_code)]
    pub name: String,
    /// data URI: data:image/png;base64,...
    pub content: String,
    pub file_type: String,
}

/// Options for starting a new CLI session.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionOptions {
    pub agent_id: Option<String>,
    pub prompt: String,
    pub project_path: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub resume_session_id: Option<String>,
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub chrome: bool,
    #[serde(default)]
    pub attachments: Vec<AttachmentPayload>,
}

/// Options for sending a follow-up message to an existing session.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageOptions {
    pub agent_id: Option<String>,
    pub prompt: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentPayload>,
}
