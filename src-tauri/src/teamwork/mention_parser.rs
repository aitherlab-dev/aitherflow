/// Parse @mention directives from agent output text.
///
/// Agents communicate by writing `@agent-name message` in their normal output.
/// The GUI parses these mentions and routes messages to the target agents.

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedMention {
    /// Target agent name ("coder-1") or "all" for broadcast
    pub target: String,
    /// Message text (after the @name, trimmed)
    pub message: String,
}

/// Extract @mentions from agent output text.
///
/// Only matches @names that exist in `known_names` or "@all".
/// Unknown @-words (like @param, @Override) are ignored.
///
/// A mention starts with `@name` and extends to the next mention at
/// line-start or end of text.
pub fn parse_mentions(text: &str, known_names: &[&str]) -> Vec<ParsedMention> {
    let mut mentions = Vec::new();

    // Find all @mention positions with their targets
    let mut match_positions: Vec<(usize, &str)> = Vec::new();

    for (i, _) in text.match_indices('@') {
        // Must be at start of text or NOT preceded by alphanumeric char.
        // This allows @mentions after punctuation/quotes while still
        // filtering out emails (user@example.com).
        if i > 0 {
            let prev = text.as_bytes()[i - 1];
            if prev.is_ascii_alphanumeric() || prev == b'_' {
                continue;
            }
        }

        let after = &text[i + 1..];

        // Check "all" first
        if after.starts_with("all")
            && (after.len() == 3 || after.as_bytes().get(3).is_none_or(|&b| b == b' ' || b == b'\n' || b == b'\r' || b == b'\t'))
        {
            match_positions.push((i, "all"));
            continue;
        }

        // Check known agent names
        for &name in known_names {
            if after.starts_with(name) {
                let end = name.len();
                // Must be followed by whitespace or end of string
                if after.len() == end
                    || after.as_bytes().get(end).is_none_or(|&b| {
                        b == b' ' || b == b'\n' || b == b'\r' || b == b'\t'
                    })
                {
                    match_positions.push((i, name));
                    break;
                }
            }
        }
    }

    if match_positions.is_empty() {
        return mentions;
    }

    // Extract messages between mentions
    for (idx, &(pos, target)) in match_positions.iter().enumerate() {
        let msg_start = pos + 1 + target.len(); // skip '@' + name
        let msg_end = if idx + 1 < match_positions.len() {
            match_positions[idx + 1].0
        } else {
            text.len()
        };

        let message = text[msg_start..msg_end].trim().to_string();
        if !message.is_empty() {
            mentions.push(ParsedMention {
                target: target.to_string(),
                message,
            });
        }
    }

    mentions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_mention() {
        let text = "@coder-1 сделай функцию для парсинга";
        let names = ["coder-1", "reviewer-1"];
        let result = parse_mentions(text, &names);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].target, "coder-1");
        assert_eq!(result[0].message, "сделай функцию для парсинга");
    }

    #[test]
    fn test_broadcast() {
        let text = "@all стоп, нашёл баг";
        let names = ["coder-1"];
        let result = parse_mentions(text, &names);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].target, "all");
        assert_eq!(result[0].message, "стоп, нашёл баг");
    }

    #[test]
    fn test_multiple_mentions() {
        let text = "@coder-1 сделай X\n@coder-2 сделай Y";
        let names = ["coder-1", "coder-2"];
        let result = parse_mentions(text, &names);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].target, "coder-1");
        assert_eq!(result[0].message, "сделай X");
        assert_eq!(result[1].target, "coder-2");
        assert_eq!(result[1].message, "сделай Y");
    }

    #[test]
    fn test_ignores_unknown_at() {
        let text = "Use @param annotation and @Override decorator";
        let names = ["coder-1"];
        let result = parse_mentions(text, &names);
        assert!(result.is_empty());
    }

    #[test]
    fn test_ignores_email() {
        let text = "Send to user@example.com for review";
        let names = ["coder-1"];
        let result = parse_mentions(text, &names);
        assert!(result.is_empty());
    }

    #[test]
    fn test_mention_after_quote() {
        let text = r#"Отправляю "@coder-1 сделай функцию""#;
        let names = ["coder-1"];
        let result = parse_mentions(text, &names);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].target, "coder-1");
    }

    #[test]
    fn test_mention_after_punctuation() {
        let text = "Задача:@coder-1 сделай функцию";
        let names = ["coder-1"];
        let result = parse_mentions(text, &names);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].target, "coder-1");
    }

    #[test]
    fn test_no_mentions() {
        let text = "Просто текст без упоминаний, ответ пользователю";
        let names = ["coder-1", "team-lead"];
        let result = parse_mentions(text, &names);
        assert!(result.is_empty());
    }

    #[test]
    fn test_mention_at_start_with_multiline_message() {
        let text = "@team-lead задача выполнена.\nКоммит abc123.\nВсе тесты проходят.";
        let names = ["team-lead"];
        let result = parse_mentions(text, &names);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].target, "team-lead");
        assert!(result[0].message.contains("задача выполнена"));
        assert!(result[0].message.contains("abc123"));
    }

    #[test]
    fn test_mixed_text_and_mention() {
        let text = "Я проанализировал код и вот результат.\n\n@team-lead готово, проверь коммит";
        let names = ["team-lead"];
        let result = parse_mentions(text, &names);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].target, "team-lead");
    }

    #[test]
    fn test_mention_empty_message_skipped() {
        let text = "@coder-1 @coder-2 сделай Y";
        let names = ["coder-1", "coder-2"];
        let result = parse_mentions(text, &names);
        // coder-1's message is empty (just space before next mention), should be skipped
        // coder-2 gets "сделай Y"
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].target, "coder-2");
        assert_eq!(result[0].message, "сделай Y");
    }

    #[test]
    fn test_all_broadcast_with_known_names() {
        let text = "@all внимание, меняем подход";
        let names = ["coder-1", "coder-2", "reviewer-1"];
        let result = parse_mentions(text, &names);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].target, "all");
    }
}
