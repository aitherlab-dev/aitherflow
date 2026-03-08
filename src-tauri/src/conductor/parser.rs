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
    combined_buf: &mut String,
) -> Result<Vec<CliEvent>, String> {
    let parsed: Value =
        serde_json::from_str(line).map_err(|e| format!("Invalid JSON: {e}"))?;

    let event_type = parsed
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let mut events = Vec::new();

    match event_type {
        "system" => {
            if let Some(sid) = parsed.get("session_id").and_then(|v| v.as_str()) {
                events.push(CliEvent::SessionId {
                    agent_id: agent_id.to_string(),
                    session_id: sid.to_string(),
                });
            }
            if let Some(m) = parsed.get("model").and_then(|v| v.as_str()) {
                events.push(CliEvent::ModelInfo {
                    agent_id: agent_id.to_string(),
                    model: m.to_string(),
                });
            }
            if let Some(cmds) = parsed.get("slash_commands").and_then(|v| v.as_array()) {
                let commands: Vec<String> = cmds
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
                if !commands.is_empty() {
                    events.push(CliEvent::SlashCommands {
                        agent_id: agent_id.to_string(),
                        commands,
                    });
                }
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
                combine_text_into(combined_buf, completed_text, delta_text);
                events.push(CliEvent::StreamChunk {
                    agent_id: agent_id.to_string(),
                    text: std::mem::take(combined_buf),
                });
            }
        }

        "assistant" => {
            // Full assistant message — extract text blocks
            let text = extract_text_from_content(&parsed);
            let had_deltas = !delta_text.is_empty();

            // Commit current turn's text to completed_text so it persists
            // across turns (intermediate "thinking" blocks).
            let turn_text = if had_deltas {
                std::mem::take(delta_text)
            } else {
                text.clone()
            };

            if !turn_text.is_empty() {
                if !completed_text.is_empty() {
                    // Separator so frontend can split intermediate vs final blocks
                    completed_text.push_str("\n<!-- turn -->\n");
                }
                completed_text.push_str(&turn_text);
            }

            // If no streaming deltas came, send the text as a chunk
            if !had_deltas && !text.is_empty() {
                combine_text_into(combined_buf, completed_text, "");
                events.push(CliEvent::StreamChunk {
                    agent_id: agent_id.to_string(),
                    text: std::mem::take(combined_buf),
                });
            }

            // Extract context usage from assistant.message.usage (per-turn = real context size)
            if let Some(usage) = parsed.pointer("/message/usage") {
                let input = usage
                    .get("input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_creation = usage
                    .get("cache_creation_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_read = usage
                    .get("cache_read_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let output = usage
                    .get("output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let context_used = input + cache_creation + cache_read;
                if context_used > 0 {
                    events.push(CliEvent::ContextInfo {
                        agent_id: agent_id.to_string(),
                        context_used,
                        output_tokens: output,
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
                            agent_id: agent_id.to_string(),
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
            // Delta is already committed in "assistant" handler.
            // Clear any leftover just in case.
            delta_text.clear();

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
                            agent_id: agent_id.to_string(),
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
            combine_text_into(combined_buf, completed_text, delta_text);
            let accumulated = std::mem::take(combined_buf);
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
                    agent_id: agent_id.to_string(),
                    message: parsed
                        .get("result")
                        .and_then(|r| r.as_str())
                        .unwrap_or("Unknown CLI error")
                        .to_string(),
                });
            } else if !final_text.is_empty() {
                events.push(CliEvent::MessageComplete {
                    agent_id: agent_id.to_string(),
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
            let cache_creation_input_tokens = parsed
                .pointer("/usage/cache_creation_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cache_read_input_tokens = parsed
                .pointer("/usage/cache_read_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cost_usd = parsed
                .get("total_cost_usd")
                .and_then(|v| v.as_f64())
                .or_else(|| parsed.get("cost_usd").and_then(|v| v.as_f64()))
                .unwrap_or(0.0);

            // Extract context window from modelUsage (first model entry)
            let context_window = parsed
                .get("modelUsage")
                .and_then(|mu| mu.as_object())
                .and_then(|obj| obj.values().next())
                .and_then(|entry| entry.get("contextWindow"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);

            if input_tokens > 0 || output_tokens > 0 {
                events.push(CliEvent::UsageInfo {
                    agent_id: agent_id.to_string(),
                    input_tokens,
                    output_tokens,
                    cache_creation_input_tokens,
                    cache_read_input_tokens,
                    cost_usd,
                    context_window,
                });
            }

            // Reset accumulators
            completed_text.clear();
            delta_text.clear();

            // Turn complete
            events.push(CliEvent::TurnComplete { agent_id: agent_id.to_string() });
        }

        "control_request" => {
            eprintln!("[conductor] Got control_request: {line}");
            let request_id = parsed
                .get("request_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let request = parsed.get("request").unwrap_or(&Value::Null);
            let tool_name = request
                .get("tool_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tool_use_id = request
                .get("tool_use_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let input = request
                .get("input")
                .cloned()
                .unwrap_or(Value::Null);
            let description = request
                .get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            if !request_id.is_empty() {
                events.push(CliEvent::ControlRequest {
                    agent_id: agent_id.to_string(),
                    request_id,
                    tool_name,
                    tool_use_id,
                    input,
                    description,
                });
            }
        }

        other => {
            eprintln!("[conductor] Unknown event type: {other}");
        }
    }

    Ok(events)
}

/// Combine completed text and current delta into the reusable buffer.
/// Uses `<!-- turn -->` separator so the frontend can distinguish thinking blocks.
fn combine_text_into(buf: &mut String, completed: &str, current: &str) {
    buf.clear();
    if completed.is_empty() {
        buf.push_str(current);
    } else if current.is_empty() {
        buf.push_str(completed);
    } else {
        buf.reserve(completed.len() + 16 + current.len());
        buf.push_str(completed);
        buf.push_str("\n<!-- turn -->\n");
        buf.push_str(current);
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

    /// Convenience wrapper: creates combined_buf automatically
    fn pl(
        line: &str,
        agent_id: &str,
        completed: &mut String,
        delta: &mut String,
    ) -> Result<Vec<CliEvent>, String> {
        let mut buf = String::new();
        parse_line(line, agent_id, completed, delta, &mut buf)
    }

    #[test]
    fn parse_system_event() {
        let line = r#"{"type":"system","session_id":"sess_abc","model":"claude-sonnet-4-20250514"}"#;
        let mut completed = String::new();
        let mut delta = String::new();
        let events = pl(line, "agent1", &mut completed, &mut delta).unwrap();

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
        let events = pl(line, "default", &mut completed, &mut delta).unwrap();

        assert_eq!(events.len(), 1);
        match &events[0] {
            CliEvent::StreamChunk { text, .. } => assert_eq!(text, "Hello "),
            other => panic!("Expected StreamChunk, got {other:?}"),
        }
        assert_eq!(delta, "Hello ");

        // Second delta accumulates
        let line2 = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"world!"}}}"#;
        let events2 = pl(line2, "default", &mut completed, &mut delta).unwrap();
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
        let events = pl(line, "default", &mut completed, &mut delta).unwrap();

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
                cache_creation_input_tokens,
                cache_read_input_tokens,
                cost_usd,
                context_window,
                ..
            } => {
                assert_eq!(*input_tokens, 100);
                assert_eq!(*output_tokens, 50);
                assert_eq!(*cache_creation_input_tokens, 0);
                assert_eq!(*cache_read_input_tokens, 0);
                assert!((cost_usd - 0.015).abs() < f64::EPSILON);
                assert_eq!(*context_window, 0); // not present in this JSON
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
    fn parse_result_with_cache_tokens_and_context_window() {
        let line = r#"{"type":"result","is_error":false,"result":"OK","usage":{"input_tokens":5000,"output_tokens":1200,"cache_creation_input_tokens":20000,"cache_read_input_tokens":40000},"total_cost_usd":0.42,"modelUsage":{"claude-opus-4-20250514":{"contextWindow":200000}}}"#;
        let mut completed = String::new();
        let mut delta = "Done".to_string();
        let events = pl(line, "a1", &mut completed, &mut delta).unwrap();

        let usage = events.iter().find(|e| matches!(e, CliEvent::UsageInfo { .. }));
        assert!(usage.is_some(), "Should have UsageInfo event");
        match usage.unwrap() {
            CliEvent::UsageInfo {
                input_tokens,
                output_tokens,
                cache_creation_input_tokens,
                cache_read_input_tokens,
                context_window,
                ..
            } => {
                assert_eq!(*input_tokens, 5000);
                assert_eq!(*output_tokens, 1200);
                assert_eq!(*cache_creation_input_tokens, 20000);
                assert_eq!(*cache_read_input_tokens, 40000);
                assert_eq!(*context_window, 200000);
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn parse_result_error() {
        let line =
            r#"{"type":"result","is_error":true,"result":"Auth expired","usage":{}}"#;
        let mut completed = String::new();
        let mut delta = String::new();
        let events = pl(line, "default", &mut completed, &mut delta).unwrap();

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
        let result = pl("not json", "default", &mut completed, &mut delta);
        assert!(result.is_err());
    }

    #[test]
    fn parse_assistant_with_tool_use() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Let me check."},{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"/tmp/test.rs"}}]}}"#;
        let mut completed = String::new();
        let mut delta = String::new();
        let events = pl(line, "default", &mut completed, &mut delta).unwrap();

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
        // Text should be committed to completed_text
        assert_eq!(completed, "Let me check.");
    }

    #[test]
    fn thinking_blocks_preserved_across_turns() {
        let mut completed = String::new();
        let mut delta = String::new();

        // Turn 1: streaming deltas → assistant → user
        let d1 = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Looking..."}}}"#;
        pl(d1, "a", &mut completed, &mut delta).unwrap();
        assert_eq!(delta, "Looking...");

        let a1 = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Looking..."},{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}"#;
        pl(a1, "a", &mut completed, &mut delta).unwrap();
        assert_eq!(completed, "Looking...");
        assert!(delta.is_empty());

        let u1 = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#;
        pl(u1, "a", &mut completed, &mut delta).unwrap();

        // Turn 2: new streaming text
        let d2 = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Found it."}}}"#;
        let events = pl(d2, "a", &mut completed, &mut delta).unwrap();

        // StreamChunk should contain both turns separated by turn marker
        match &events[0] {
            CliEvent::StreamChunk { text, .. } => {
                assert!(text.contains("Looking..."), "should contain turn 1 text");
                assert!(text.contains("Found it."), "should contain turn 2 text");
                assert!(
                    text.contains("<!-- turn -->"),
                    "should contain turn separator"
                );
            }
            other => panic!("Expected StreamChunk, got {other:?}"),
        }
    }

    #[test]
    fn parse_user_tool_result() {
        let line = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"file contents here","is_error":false}]}}"#;
        let mut completed = String::new();
        let mut delta = String::new();
        let events = pl(line, "default", &mut completed, &mut delta).unwrap();

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
