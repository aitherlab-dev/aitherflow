use serde_json::Value;

use super::types::CliEvent;

/// Parse a single NDJSON line from CLI stdout into zero or more CliEvent values.
///
/// `completed_text` accumulates text across multiple assistant turns.
/// `delta_text` accumulates streaming deltas within a single turn.
/// Both are reset on "result" events.
pub fn parse_line(
    line: &str,
    agent_id: &str,
    completed_text: &mut String,
    delta_text: &mut String,
) -> Result<Vec<CliEvent>, String> {
    let parsed: Value =
        serde_json::from_str(line).map_err(|e| format!("Invalid JSON: {e}"))?;

    let event_type = parsed
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let mut events = Vec::new();
    let aid = agent_id.to_string();

    match event_type {
        "system" => {
            if let Some(sid) = parsed.get("session_id").and_then(|v| v.as_str()) {
                events.push(CliEvent::SessionId {
                    agent_id: aid.clone(),
                    session_id: sid.to_string(),
                });
            }
            if let Some(m) = parsed.get("model").and_then(|v| v.as_str()) {
                events.push(CliEvent::ModelInfo {
                    agent_id: aid,
                    model: m.to_string(),
                });
            }
        }

        "stream_event" => {
            // Streaming text via --include-partial-messages
            if let Some(chunk) = parsed
                .get("event")
                .filter(|inner| {
                    inner.get("type").and_then(|t| t.as_str())
                        == Some("content_block_delta")
                })
                .and_then(|inner| inner.get("delta"))
                .filter(|d| {
                    d.get("type").and_then(|t| t.as_str()) == Some("text_delta")
                })
                .and_then(|d| d.get("text"))
                .and_then(|v| v.as_str())
            {
                delta_text.push_str(chunk);
                let full = combine_text(completed_text, delta_text);
                events.push(CliEvent::StreamChunk {
                    agent_id: aid,
                    text: full,
                });
            }
        }

        "assistant" => {
            // Full assistant message — extract text blocks
            let text = extract_text_from_content(&parsed);
            if !text.is_empty() {
                let had_deltas = !delta_text.is_empty();
                delta_text.clear();

                // If no streaming deltas came, send the text as a chunk
                if !had_deltas {
                    let full = combine_text(completed_text, &text);
                    events.push(CliEvent::StreamChunk {
                        agent_id: aid.clone(),
                        text: full,
                    });
                }
            }

            // Extract tool_use events
            if let Some(arr) = parsed
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                for item in arr {
                    if item.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                        events.push(CliEvent::ToolUse {
                            agent_id: aid.clone(),
                            tool_use_id: item
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            tool_name: item
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown")
                                .to_string(),
                            tool_input: item
                                .get("input")
                                .cloned()
                                .unwrap_or(Value::Null),
                        });
                    }
                }
            }
        }

        "user" => {
            // User event = previous assistant turn done.
            // Commit delta to completed text.
            if !delta_text.is_empty() {
                if !completed_text.is_empty() {
                    completed_text.push_str("\n\n");
                }
                completed_text.push_str(delta_text);
                delta_text.clear();
            }

            // Parse tool_result events
            if let Some(arr) = parsed
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                for item in arr {
                    if item.get("type").and_then(|t| t.as_str()) == Some("tool_result")
                    {
                        let content_text = extract_tool_result_text(item);
                        let preview: String = content_text.chars().take(500).collect();
                        events.push(CliEvent::ToolResult {
                            agent_id: aid.clone(),
                            tool_use_id: item
                                .get("tool_use_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            output_preview: preview,
                            is_error: item
                                .get("is_error")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false),
                        });
                    }
                }
            }
        }

        "result" => {
            let is_error = parsed
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            // Build final text
            let accumulated = combine_text(completed_text, delta_text);
            let final_text = if accumulated.is_empty() {
                parsed
                    .get("result")
                    .and_then(|r| r.as_str())
                    .unwrap_or("")
                    .to_string()
            } else {
                accumulated
            };

            if is_error {
                events.push(CliEvent::Error {
                    agent_id: aid.clone(),
                    message: parsed
                        .get("result")
                        .and_then(|r| r.as_str())
                        .unwrap_or("Unknown CLI error")
                        .to_string(),
                });
            } else if !final_text.is_empty() {
                events.push(CliEvent::MessageComplete {
                    agent_id: aid.clone(),
                    text: final_text,
                });
            }

            // Usage info
            let input_tokens = parsed
                .pointer("/usage/input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let output_tokens = parsed
                .pointer("/usage/output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cost_usd = parsed
                .get("total_cost_usd")
                .and_then(|v| v.as_f64())
                .or_else(|| parsed.get("cost_usd").and_then(|v| v.as_f64()))
                .unwrap_or(0.0);

            if input_tokens > 0 || output_tokens > 0 {
                events.push(CliEvent::UsageInfo {
                    agent_id: aid.clone(),
                    input_tokens,
                    output_tokens,
                    cost_usd,
                });
            }

            // Reset accumulators
            completed_text.clear();
            delta_text.clear();

            // Turn complete
            events.push(CliEvent::TurnComplete { agent_id: aid });
        }

        other => {
            eprintln!("[conductor] Unknown event type: {other}");
        }
    }

    Ok(events)
}

/// Combine completed text and current delta into one string.
fn combine_text(completed: &str, current: &str) -> String {
    if completed.is_empty() {
        current.to_string()
    } else if current.is_empty() {
        completed.to_string()
    } else {
        let mut s = String::with_capacity(completed.len() + 2 + current.len());
        s.push_str(completed);
        s.push_str("\n\n");
        s.push_str(current);
        s
    }
}

/// Extract all text blocks from `parsed["message"]["content"]`.
fn extract_text_from_content(parsed: &Value) -> String {
    parsed
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                        item.get("text").and_then(|t| t.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<&str>>()
                .join("")
        })
        .unwrap_or_default()
}

/// Extract text from tool_result content (can be string or array of blocks).
fn extract_tool_result_text(item: &Value) -> String {
    match item.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<&str>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_system_event() {
        let line = r#"{"type":"system","session_id":"sess_abc","model":"claude-sonnet-4-20250514"}"#;
        let mut completed = String::new();
        let mut delta = String::new();
        let events = parse_line(line, "agent1", &mut completed, &mut delta).unwrap();

        assert_eq!(events.len(), 2);
        match &events[0] {
            CliEvent::SessionId {
                agent_id,
                session_id,
            } => {
                assert_eq!(agent_id, "agent1");
                assert_eq!(session_id, "sess_abc");
            }
            other => panic!("Expected SessionId, got {other:?}"),
        }
        match &events[1] {
            CliEvent::ModelInfo { agent_id, model } => {
                assert_eq!(agent_id, "agent1");
                assert_eq!(model, "claude-sonnet-4-20250514");
            }
            other => panic!("Expected ModelInfo, got {other:?}"),
        }
    }

    #[test]
    fn parse_stream_event_text_delta() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}}"#;
        let mut completed = String::new();
        let mut delta = String::new();
        let events = parse_line(line, "default", &mut completed, &mut delta).unwrap();

        assert_eq!(events.len(), 1);
        match &events[0] {
            CliEvent::StreamChunk { text, .. } => assert_eq!(text, "Hello "),
            other => panic!("Expected StreamChunk, got {other:?}"),
        }
        assert_eq!(delta, "Hello ");

        // Second delta accumulates
        let line2 = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"world!"}}}"#;
        let events2 = parse_line(line2, "default", &mut completed, &mut delta).unwrap();
        match &events2[0] {
            CliEvent::StreamChunk { text, .. } => assert_eq!(text, "Hello world!"),
            other => panic!("Expected StreamChunk, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_event() {
        let line = r#"{"type":"result","is_error":false,"result":"Done","session_id":"sess_abc","usage":{"input_tokens":100,"output_tokens":50},"total_cost_usd":0.015}"#;
        let mut completed = String::new();
        let mut delta = "Hello world!".to_string();
        let events = parse_line(line, "default", &mut completed, &mut delta).unwrap();

        // Should produce: MessageComplete, UsageInfo, TurnComplete
        assert_eq!(events.len(), 3);
        match &events[0] {
            CliEvent::MessageComplete { text, .. } => assert_eq!(text, "Hello world!"),
            other => panic!("Expected MessageComplete, got {other:?}"),
        }
        match &events[1] {
            CliEvent::UsageInfo {
                input_tokens,
                output_tokens,
                cost_usd,
                ..
            } => {
                assert_eq!(*input_tokens, 100);
                assert_eq!(*output_tokens, 50);
                assert!((cost_usd - 0.015).abs() < f64::EPSILON);
            }
            other => panic!("Expected UsageInfo, got {other:?}"),
        }
        match &events[2] {
            CliEvent::TurnComplete { .. } => {}
            other => panic!("Expected TurnComplete, got {other:?}"),
        }

        // Accumulators should be reset
        assert!(completed.is_empty());
        assert!(delta.is_empty());
    }

    #[test]
    fn parse_result_error() {
        let line =
            r#"{"type":"result","is_error":true,"result":"Auth expired","usage":{}}"#;
        let mut completed = String::new();
        let mut delta = String::new();
        let events = parse_line(line, "default", &mut completed, &mut delta).unwrap();

        assert!(events.len() >= 2); // Error + TurnComplete
        match &events[0] {
            CliEvent::Error { message, .. } => assert_eq!(message, "Auth expired"),
            other => panic!("Expected Error, got {other:?}"),
        }
    }

    #[test]
    fn parse_invalid_json() {
        let mut completed = String::new();
        let mut delta = String::new();
        let result = parse_line("not json", "default", &mut completed, &mut delta);
        assert!(result.is_err());
    }

    #[test]
    fn parse_assistant_with_tool_use() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Let me check."},{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"/tmp/test.rs"}}]}}"#;
        let mut completed = String::new();
        let mut delta = String::new();
        let events = parse_line(line, "default", &mut completed, &mut delta).unwrap();

        // StreamChunk (text) + ToolUse
        assert_eq!(events.len(), 2);
        match &events[0] {
            CliEvent::StreamChunk { text, .. } => assert_eq!(text, "Let me check."),
            other => panic!("Expected StreamChunk, got {other:?}"),
        }
        match &events[1] {
            CliEvent::ToolUse {
                tool_name,
                tool_use_id,
                ..
            } => {
                assert_eq!(tool_name, "Read");
                assert_eq!(tool_use_id, "tu_1");
            }
            other => panic!("Expected ToolUse, got {other:?}"),
        }
    }

    #[test]
    fn parse_user_tool_result() {
        let line = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"file contents here","is_error":false}]}}"#;
        let mut completed = String::new();
        let mut delta = String::new();
        let events = parse_line(line, "default", &mut completed, &mut delta).unwrap();

        assert_eq!(events.len(), 1);
        match &events[0] {
            CliEvent::ToolResult {
                tool_use_id,
                output_preview,
                is_error,
                ..
            } => {
                assert_eq!(tool_use_id, "tu_1");
                assert_eq!(output_preview, "file contents here");
                assert!(!is_error);
            }
            other => panic!("Expected ToolResult, got {other:?}"),
        }
    }
}
