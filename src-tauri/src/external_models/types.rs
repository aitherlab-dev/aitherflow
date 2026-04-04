use serde::{Deserialize, Serialize};

/// Role in a chat message
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

/// Content part for multimodal messages (text + images)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrlData },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrlData {
    pub url: String,
}

/// Message content: either plain text or multimodal parts
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

/// A single chat message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: MessageContent,
}

/// Request to the chat completions endpoint
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
}

/// A single choice in the response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatChoice {
    pub index: u32,
    pub message: ChoiceMessage,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChoiceMessage {
    pub role: String,
    pub content: Option<String>,
}

/// Token usage info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// Response from the chat completions endpoint
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    pub id: String,
    pub model: String,
    pub choices: Vec<ChatChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

/// Model info from the /models endpoint
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub context_length: Option<u64>,
}

/// Response from the /models endpoint (OpenAI-compatible)
#[derive(Debug, Clone, Deserialize)]
pub struct ModelsResponse {
    pub data: Vec<ModelInfo>,
}

/// Response from Ollama /api/tags endpoint
#[derive(Debug, Clone, Deserialize)]
pub struct OllamaTagsResponse {
    #[serde(default)]
    pub models: Vec<OllamaModel>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OllamaModel {
    pub name: String,
}

/// Per-provider configuration — dynamic, user-defined providers
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    /// "openai_compatible" or "ollama"
    pub provider_type: String,
    pub base_url: String,
    #[serde(default)]
    pub default_model: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub requires_api_key: bool,
}

impl ProviderConfig {
    /// Whether this is an Ollama-type provider
    pub fn is_ollama(&self) -> bool {
        self.provider_type == "ollama"
    }

    /// Effective base URL for API calls (append /v1 for Ollama if needed)
    pub fn effective_base_url(&self) -> String {
        if self.is_ollama() && !self.base_url.contains("/v1") {
            format!("{}/v1", self.base_url.trim_end_matches('/'))
        } else {
            self.base_url.trim_end_matches('/').to_string()
        }
    }

    /// Ollama server root (without /v1) for /api/tags
    pub fn ollama_server_url(&self) -> String {
        let url = self.base_url.trim_end_matches('/');
        url.trim_end_matches("/v1").to_string()
    }
}

/// Top-level config file structure
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExternalModelsConfig {
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    #[serde(default)]
    pub vision_profile: Option<crate::external_models::vision::VisionProfile>,
}

/// Error response from API
#[derive(Debug, Deserialize)]
pub struct ApiErrorResponse {
    pub error: Option<ApiErrorDetail>,
}

#[derive(Debug, Deserialize)]
pub struct ApiErrorDetail {
    pub message: String,
}
