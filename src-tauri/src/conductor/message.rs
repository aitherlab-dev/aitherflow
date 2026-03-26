//! Message builders — construct NDJSON payloads for CLI stdin.

use super::types::AttachmentPayload;
use crate::attachments;

/// Build NDJSON message for stdin.
///
/// Images go before text as content blocks.
/// Format: `{"type":"user","message":{"role":"user","content":[...]}}`
pub fn build_stdin_message(prompt: &str, images: &[AttachmentPayload]) -> Result<String, String> {
    let mut content: Vec<serde_json::Value> = Vec::new();

    // Add image blocks first
    for img in images {
        if img.file_type != "image" {
            continue;
        }
        if let Some((media_type, data)) = attachments::parse_data_uri(&img.content) {
            content.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": data
                }
            }));
        }
    }

    // CLI in -p mode adds cache_control to text blocks, so a text block is always
    // required. If the user sent only images, use a default prompt.
    let has_images = content.iter().any(|b| b.get("type").and_then(|t| t.as_str()) == Some("image"));
    let text = prompt.trim();
    let text = if text.is_empty() {
        if has_images {
            "What's in this image?"
        } else {
            return Err("Cannot send empty message".to_string());
        }
    } else {
        text
    };
    content.push(serde_json::json!({
        "type": "text",
        "text": text
    }));

    let msg = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": content
        }
    });
    serde_json::to_string(&msg).map_err(|e| format!("Failed to serialize message: {e}"))
}

/// Build NDJSON control_response for stdin (reply to a control_request).
///
/// If `response` contains a `"behavior"` key, it's a success response.
/// If `response` contains an `"error"` key, it's an error/deny response.
pub fn build_control_response(
    request_id: &str,
    response: &serde_json::Value,
) -> Result<String, String> {
    let msg = if response.get("error").is_some() {
        serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": request_id,
                "error": response["error"]
            }
        })
    } else {
        serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": response
            }
        })
    };
    serde_json::to_string(&msg).map_err(|e| format!("Failed to serialize control_response: {e}"))
}
