//! Canonical ↔ Anthropic Messages API conversion.
//!
//! ## Outbound (request) translation
//! - System prompt → top-level `system` (not a message).
//! - `Role::System` messages in history → concatenated into `system`.
//! - `Role::Tool` messages → become `role:"user"` wire messages whose
//!   content is just `tool_result` blocks (Anthropic convention).
//! - `Role::Assistant` content blocks: `Text` / `Thinking` / `ToolUse` map
//!   1:1 to wire blocks. `Thinking { signature: Some }` round-trips so
//!   the model can read its prior reasoning trace if `extended_thinking`
//!   is enabled.
//! - `Role::User` text → single `text` block.
//!
//! ## Inbound (response) translation
//! - Wire `text` → `ContentBlock::Text`
//! - Wire `thinking` (with signature) and `redacted_thinking` (encrypted)
//!   → `ContentBlock::Thinking` (signature carries the bytes; redacted
//!   thinking is rendered with a fixed marker text).
//! - Wire `tool_use` → `ContentBlock::ToolUse`
//! - `stop_reason` → `StopReason` enum
//! - Cache-aware `usage` propagated to canonical `Usage`.

use crate::anthropic::wire::{
    MessagesRequest, MessagesResponse, SystemBlock, SystemField, WireContentBlock, WireMessage,
    WireTool, EPHEMERAL_CACHE,
};
use crate::error::{LlmError, LlmResult};
use crate::request::{MessageRequest, SystemSegment, ToolSchema};
use crate::response::{MessageResponse, StopReason};
use snaca_core::{ContentBlock, Message, MessageId, Role, ToolUseId};
use std::time::SystemTime;

/// Anthropic requires `max_tokens` — we have no way to "let the provider pick".
/// Pick a sensible default if the engine didn't set one.
const DEFAULT_MAX_TOKENS: u32 = 4096;

/// Backwards-compatible shim — caches enabled by default. Production
/// callers use [`build_messages_request_with_cache`] explicitly so
/// the operator can opt out via `AnthropicConfig.enable_prompt_cache`.
#[cfg(test)]
pub fn build_messages_request(req: &MessageRequest, stream: bool) -> LlmResult<MessagesRequest> {
    build_messages_request_with_cache(req, stream, true)
}

/// Same as `build_messages_request` but with explicit control over
/// prompt-cache breakpoint emission. `enable_cache = true` (the
/// default) attaches an ephemeral cache_control to the last system
/// block and the last tool; `false` emits the legacy single-string
/// `system` and bare `tools` shape — useful when an operator opts
/// out for debugging.
pub fn build_messages_request_with_cache(
    req: &MessageRequest,
    stream: bool,
    enable_cache: bool,
) -> LlmResult<MessagesRequest> {
    let (extra_system, messages) = split_system_and_messages(&req.messages)?;

    let system = build_system_field(req, extra_system, enable_cache);

    let mut tools: Vec<WireTool> = req.tools.iter().map(tool_schema_to_wire).collect();
    if enable_cache {
        if let Some(last) = tools.last_mut() {
            last.cache_control = Some(EPHEMERAL_CACHE);
        }
    }

    Ok(MessagesRequest {
        model: req.model.clone(),
        max_tokens: req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        messages,
        system,
        tools,
        temperature: req.temperature,
        stop_sequences: if req.stop_sequences.is_empty() {
            None
        } else {
            Some(req.stop_sequences.clone())
        },
        stream,
    })
}

/// Build the `system` field of the Anthropic request.
///
/// Two paths:
///
/// 1. **Segmented** (`req.system_segments` non-empty): emit each
///    non-empty segment as its own `SystemBlock`, and place a single
///    `cache_control: ephemeral` breakpoint on the LAST cacheable
///    segment that appears BEFORE the first volatile segment. Marking
///    later segments would cache content that already includes a
///    per-turn-volatile slice, silently defeating the cache.
///
/// 2. **Legacy** (only `req.system` set): concat top-level + history
///    system into a single block, cache_control attached when caching
///    is enabled. Backwards-compatible with the summariser path.
fn build_system_field(
    req: &MessageRequest,
    extra_system: Option<String>,
    enable_cache: bool,
) -> Option<SystemField> {
    if !req.system_segments.is_empty() {
        let mut segs: Vec<SystemSegment> = Vec::new();
        // History-derived system was persisted in the thread, not
        // generated this turn — treat it as stable and slot it before
        // the engine's segments so the volatile suffix still controls
        // where the cache breakpoint lands.
        if let Some(extra) = extra_system {
            segs.push(SystemSegment {
                text: extra,
                cacheable: true,
            });
        }
        segs.extend(req.system_segments.iter().cloned());
        segs.retain(|s| !s.text.trim().is_empty());
        if segs.is_empty() {
            return None;
        }

        if !enable_cache {
            // No cache means segmentation buys nothing; concat back.
            let mut out = String::new();
            for (i, s) in segs.iter().enumerate() {
                if i > 0 {
                    out.push_str("\n\n");
                }
                out.push_str(&s.text);
            }
            return Some(SystemField::Text(out));
        }

        let first_volatile = segs.iter().position(|s| !s.cacheable);
        let breakpoint_idx: Option<usize> = match first_volatile {
            Some(0) => None, // first segment volatile → nothing to cache
            Some(i) => Some(i - 1),
            None => Some(segs.len() - 1),
        };

        let blocks: Vec<SystemBlock> = segs
            .into_iter()
            .enumerate()
            .map(|(i, s)| {
                let mut b = SystemBlock::text(s.text);
                if Some(i) == breakpoint_idx {
                    b = b.with_cache_control(EPHEMERAL_CACHE);
                }
                b
            })
            .collect();
        return Some(SystemField::Blocks(blocks));
    }

    let system_text = match (req.system.as_ref(), extra_system) {
        (Some(top), Some(extra)) => Some(format!("{top}\n\n{extra}")),
        (Some(top), None) => Some(top.clone()),
        (None, Some(extra)) => Some(extra),
        (None, None) => None,
    };
    system_text.map(|t| {
        if enable_cache {
            SystemField::Blocks(vec![SystemBlock::text(t).with_cache_control(EPHEMERAL_CACHE)])
        } else {
            SystemField::Text(t)
        }
    })
}

fn split_system_and_messages(
    messages: &[Message],
) -> LlmResult<(Option<String>, Vec<WireMessage>)> {
    let mut system_parts: Vec<String> = Vec::new();
    let mut wire: Vec<WireMessage> = Vec::new();
    for msg in messages {
        match msg.role {
            Role::System => {
                let text = ContentBlock::collect_text(&msg.content);
                if !text.is_empty() {
                    system_parts.push(text);
                }
            }
            Role::User => {
                let text = ContentBlock::collect_text(&msg.content);
                wire.push(WireMessage {
                    role: "user".into(),
                    content: vec![WireContentBlock::Text { text }],
                });
            }
            Role::Assistant => {
                let mut blocks: Vec<WireContentBlock> = Vec::new();
                for b in &msg.content {
                    match b {
                        ContentBlock::Text { text } => {
                            blocks.push(WireContentBlock::Text { text: text.clone() });
                        }
                        ContentBlock::Thinking { text, signature } => {
                            // Pass-through: signed thinking blocks must be
                            // returned verbatim if the next request is
                            // continuation with extended_thinking enabled.
                            blocks.push(WireContentBlock::Thinking {
                                text: text.clone(),
                                signature: signature.clone(),
                            });
                        }
                        ContentBlock::ToolUse { id, name, input } => {
                            blocks.push(WireContentBlock::ToolUse {
                                id: id.as_str().to_string(),
                                name: name.clone(),
                                input: input.clone(),
                            });
                        }
                        // Assistant should not produce these in canonical form.
                        ContentBlock::ToolResult { .. } | ContentBlock::Image { .. } => {}
                    }
                }
                if blocks.is_empty() {
                    // Skip empty assistant messages — Anthropic would reject.
                    continue;
                }
                wire.push(WireMessage {
                    role: "assistant".into(),
                    content: blocks,
                });
            }
            Role::Tool => {
                let mut blocks: Vec<WireContentBlock> = Vec::new();
                for b in &msg.content {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } = b
                    {
                        blocks.push(WireContentBlock::ToolResult {
                            tool_use_id: tool_use_id.as_str().to_string(),
                            content: content
                                .iter()
                                .filter_map(|c| match c {
                                    ContentBlock::Text { text } => {
                                        Some(WireContentBlock::Text { text: text.clone() })
                                    }
                                    _ => None,
                                })
                                .collect(),
                            is_error: *is_error,
                        });
                    }
                }
                if blocks.is_empty() {
                    continue;
                }
                wire.push(WireMessage {
                    role: "user".into(),
                    content: blocks,
                });
            }
        }
    }
    let system = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("\n\n"))
    };
    Ok((system, wire))
}

fn tool_schema_to_wire(s: &ToolSchema) -> WireTool {
    WireTool {
        name: s.name.clone(),
        description: s.description.clone(),
        input_schema: s.input_schema.clone(),
        cache_control: None,
    }
}

pub fn parse_messages_response(resp: MessagesResponse) -> LlmResult<MessageResponse> {
    let mut content: Vec<ContentBlock> = Vec::with_capacity(resp.content.len());
    for block in resp.content {
        match block {
            WireContentBlock::Text { text } => {
                content.push(ContentBlock::text(text));
            }
            WireContentBlock::Thinking { text, signature } => {
                content.push(ContentBlock::Thinking { text, signature });
            }
            WireContentBlock::RedactedThinking { data } => {
                // Surface a placeholder text but preserve the encrypted blob in
                // `signature` so we can echo it back on the next request.
                content.push(ContentBlock::Thinking {
                    text: "<redacted thinking>".into(),
                    signature: Some(data),
                });
            }
            WireContentBlock::ToolUse { id, name, input } => {
                content.push(ContentBlock::ToolUse {
                    id: ToolUseId::new(id),
                    name,
                    input,
                });
            }
            WireContentBlock::ToolResult { .. } => {
                return Err(LlmError::MalformedResponse(
                    "assistant response contained tool_result block".into(),
                ));
            }
        }
    }

    let stop_reason = match resp.stop_reason.as_deref() {
        Some("end_turn") => StopReason::EndTurn,
        Some("max_tokens") => StopReason::MaxTokens,
        Some("tool_use") => StopReason::ToolUse,
        Some("stop_sequence") => StopReason::StopSequence,
        Some(other) => StopReason::Other(other.to_string()),
        None => {
            if content
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolUse { .. }))
            {
                StopReason::ToolUse
            } else {
                StopReason::EndTurn
            }
        }
    };

    Ok(MessageResponse {
        id: resp.id,
        message: Message {
            id: MessageId::new(),
            role: Role::Assistant,
            content,
            created_at: chrono::DateTime::<chrono::Utc>::from(SystemTime::now()),
        },
        usage: resp.usage.map(Into::into).unwrap_or_default(),
        stop_reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use snaca_core::{ContentBlock, Message, Role, ToolUseId};

    fn user(text: &str) -> Message {
        Message::user_text(text)
    }
    fn assistant(blocks: Vec<ContentBlock>) -> Message {
        Message::new(Role::Assistant, blocks)
    }
    fn tool_msg(id: &str, text: &str) -> Message {
        Message::new(
            Role::Tool,
            vec![ContentBlock::tool_result(
                ToolUseId::new(id),
                vec![ContentBlock::text(text)],
            )],
        )
    }

    fn req(messages: Vec<Message>) -> MessageRequest {
        MessageRequest::new("claude-test").with_messages(messages)
    }

    /// Pull the system text out for assertions regardless of whether
    /// we serialised it as a bare string or a single-block array.
    fn system_text_of(req: &MessagesRequest) -> Option<&str> {
        match &req.system {
            None => None,
            Some(SystemField::Text(t)) => Some(t.as_str()),
            Some(SystemField::Blocks(bs)) => bs.first().map(|b| b.text.as_str()),
        }
    }

    #[test]
    fn system_goes_to_top_level() {
        let r = req(vec![user("hi")]).with_system("You are SNACA");
        let wire = build_messages_request(&r, false).unwrap();
        assert_eq!(system_text_of(&wire), Some("You are SNACA"));
        assert_eq!(wire.messages.len(), 1);
        assert_eq!(wire.messages[0].role, "user");
    }

    #[test]
    fn role_system_in_history_merged_into_system() {
        let r = req(vec![
            Message::system_text("Helpful style"),
            user("hi"),
        ])
        .with_system("Top-level");
        let wire = build_messages_request(&r, false).unwrap();
        // Top-level + history system_text concatenated with blank line.
        assert_eq!(
            system_text_of(&wire),
            Some("Top-level\n\nHelpful style")
        );
    }

    #[test]
    fn cache_control_attached_to_system_and_last_tool_by_default() {
        let r = req(vec![user("hi")])
            .with_system("You are SNACA")
            .with_tools(vec![
                ToolSchema {
                    name: "Read".into(),
                    description: "read".into(),
                    input_schema: json!({"type": "object"}),
                },
                ToolSchema {
                    name: "Write".into(),
                    description: "write".into(),
                    input_schema: json!({"type": "object"}),
                },
            ]);
        let wire = build_messages_request(&r, false).unwrap();

        // System emitted as array-of-blocks with cache_control on the
        // single block — that's how the API expects it.
        match &wire.system {
            Some(SystemField::Blocks(bs)) => {
                assert_eq!(bs.len(), 1);
                assert!(bs[0].cache_control.is_some(), "system block missing cache_control");
            }
            other => panic!("expected blocks form, got {other:?}"),
        }

        // Only the *last* tool gets a breakpoint — the prefix covers
        // the rest. First tool stays bare.
        assert!(wire.tools[0].cache_control.is_none());
        assert!(wire.tools[1].cache_control.is_some());
    }

    #[test]
    fn segmented_system_caches_only_through_last_stable_before_volatile() {
        // [cacheable base, cacheable memory, volatile recall] —
        // breakpoint must land on segment index 1 ("memory"), so the
        // cache prefix covers base+memory but not the volatile recall.
        let r = req(vec![user("hi")]).with_system_segments(vec![
            SystemSegment::cacheable("BASE"),
            SystemSegment::cacheable("MEMORY"),
            SystemSegment::volatile("RECALL"),
        ]);
        let wire = build_messages_request(&r, false).unwrap();
        match &wire.system {
            Some(SystemField::Blocks(bs)) => {
                assert_eq!(bs.len(), 3);
                assert!(bs[0].cache_control.is_none(), "block 0 must not be marked");
                assert!(
                    bs[1].cache_control.is_some(),
                    "block 1 (last stable before volatile) must be the breakpoint"
                );
                assert!(
                    bs[2].cache_control.is_none(),
                    "volatile block must not carry cache_control"
                );
                assert_eq!(bs[0].text, "BASE");
                assert_eq!(bs[1].text, "MEMORY");
                assert_eq!(bs[2].text, "RECALL");
            }
            other => panic!("expected blocks form, got {other:?}"),
        }
    }

    #[test]
    fn segmented_system_all_cacheable_marks_last_block() {
        let r = req(vec![user("hi")]).with_system_segments(vec![
            SystemSegment::cacheable("BASE"),
            SystemSegment::cacheable("MEMORY"),
        ]);
        let wire = build_messages_request(&r, false).unwrap();
        match &wire.system {
            Some(SystemField::Blocks(bs)) => {
                assert_eq!(bs.len(), 2);
                assert!(bs[0].cache_control.is_none());
                assert!(bs[1].cache_control.is_some());
            }
            other => panic!("expected blocks form, got {other:?}"),
        }
    }

    #[test]
    fn segmented_system_drops_empty_segments() {
        let r = req(vec![user("hi")]).with_system_segments(vec![
            SystemSegment::cacheable("BASE"),
            SystemSegment::cacheable(""),
            SystemSegment::volatile("   "),
            SystemSegment::cacheable("MEMORY"),
        ]);
        let wire = build_messages_request(&r, false).unwrap();
        match &wire.system {
            Some(SystemField::Blocks(bs)) => {
                assert_eq!(bs.len(), 2, "empty / whitespace-only segments are dropped");
                assert_eq!(bs[0].text, "BASE");
                assert_eq!(bs[1].text, "MEMORY");
            }
            other => panic!("expected blocks form, got {other:?}"),
        }
    }

    #[test]
    fn segmented_system_first_volatile_emits_no_breakpoint() {
        // Pathological: first segment is volatile. Nothing can be
        // cached without including volatile content, so emit blocks
        // with no cache_control at all.
        let r = req(vec![user("hi")]).with_system_segments(vec![
            SystemSegment::volatile("VOLATILE"),
            SystemSegment::cacheable("LATER"),
        ]);
        let wire = build_messages_request(&r, false).unwrap();
        match &wire.system {
            Some(SystemField::Blocks(bs)) => {
                assert_eq!(bs.len(), 2);
                assert!(bs.iter().all(|b| b.cache_control.is_none()));
            }
            other => panic!("expected blocks form, got {other:?}"),
        }
    }

    #[test]
    fn segmented_system_concats_when_cache_disabled() {
        let r = req(vec![user("hi")]).with_system_segments(vec![
            SystemSegment::cacheable("BASE"),
            SystemSegment::volatile("RECALL"),
        ]);
        let wire = build_messages_request_with_cache(&r, false, false).unwrap();
        match &wire.system {
            Some(SystemField::Text(t)) => assert_eq!(t, "BASE\n\nRECALL"),
            other => panic!("expected Text form when cache disabled, got {other:?}"),
        }
    }

    #[test]
    fn cache_disabled_emits_legacy_shape() {
        let r = req(vec![user("hi")])
            .with_system("You are SNACA")
            .with_tools(vec![ToolSchema {
                name: "Read".into(),
                description: "read".into(),
                input_schema: json!({"type": "object"}),
            }]);
        let wire = build_messages_request_with_cache(&r, false, false).unwrap();
        // System emitted as bare string when cache is off.
        assert!(matches!(wire.system, Some(SystemField::Text(_))));
        assert!(wire.tools[0].cache_control.is_none());
    }

    #[test]
    fn cache_control_serialises_to_ephemeral_in_json() {
        let r = req(vec![user("hi")])
            .with_system("You are SNACA")
            .with_tools(vec![ToolSchema {
                name: "Read".into(),
                description: "read".into(),
                input_schema: json!({"type": "object"}),
            }]);
        let wire = build_messages_request(&r, false).unwrap();
        let json = serde_json::to_value(&wire).unwrap();
        // System block carries cache_control.
        assert_eq!(
            json["system"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
        // Tool carries it too.
        assert_eq!(
            json["tools"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
    }

    #[test]
    fn assistant_blocks_round_trip() {
        let r = req(vec![assistant(vec![
            ContentBlock::thinking("planning"),
            ContentBlock::text("let me check"),
            ContentBlock::tool_use("call_1", "Read", json!({"path": "x"})),
        ])]);
        let wire = build_messages_request(&r, false).unwrap();
        let blocks = &wire.messages[0].content;
        assert_eq!(blocks.len(), 3);
        assert!(matches!(&blocks[0], WireContentBlock::Thinking { text, .. } if text == "planning"));
        assert!(matches!(&blocks[1], WireContentBlock::Text { text } if text == "let me check"));
        assert!(matches!(&blocks[2], WireContentBlock::ToolUse { id, name, .. } if id == "call_1" && name == "Read"));
    }

    #[test]
    fn role_tool_becomes_user_with_tool_result_block() {
        let r = req(vec![tool_msg("call_1", "the file content")]);
        let wire = build_messages_request(&r, false).unwrap();
        assert_eq!(wire.messages.len(), 1);
        assert_eq!(wire.messages[0].role, "user");
        let block = &wire.messages[0].content[0];
        match block {
            WireContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id, "call_1");
                assert_eq!(content.len(), 1);
                assert!(matches!(&content[0], WireContentBlock::Text { text } if text == "the file content"));
                assert!(!is_error);
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn empty_assistant_message_is_dropped() {
        // Anthropic rejects assistant messages with no content blocks; we
        // skip rather than send an empty array.
        let r = req(vec![assistant(vec![]), user("retry")]);
        let wire = build_messages_request(&r, false).unwrap();
        assert_eq!(wire.messages.len(), 1);
        assert_eq!(wire.messages[0].role, "user");
    }

    #[test]
    fn max_tokens_default_filled_in() {
        let r = req(vec![user("hi")]);
        let wire = build_messages_request(&r, false).unwrap();
        assert_eq!(wire.max_tokens, DEFAULT_MAX_TOKENS);
    }

    #[test]
    fn tools_serialize_with_input_schema_field() {
        let r = req(vec![user("hi")]).with_tools(vec![ToolSchema {
            name: "Read".into(),
            description: "read file".into(),
            input_schema: json!({"type": "object"}),
        }]);
        let wire = build_messages_request(&r, false).unwrap();
        assert_eq!(wire.tools.len(), 1);
        assert_eq!(wire.tools[0].name, "Read");
        assert_eq!(wire.tools[0].input_schema, json!({"type": "object"}));
    }

    fn make_response(json: serde_json::Value) -> MessagesResponse {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn parse_text_response() {
        let resp = make_response(json!({
            "id": "msg_01",
            "type": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": "hello"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 2}
        }));
        let parsed = parse_messages_response(resp).unwrap();
        assert_eq!(parsed.stop_reason, StopReason::EndTurn);
        assert_eq!(parsed.usage.input_tokens, 10);
        match &parsed.message.content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "hello"),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn parse_tool_use_response() {
        let resp = make_response(json!({
            "id": "msg_02",
            "content": [
                {"type": "text", "text": "let me read"},
                {"type": "tool_use", "id": "tu_1", "name": "Read", "input": {"path": "README.md"}}
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 5, "output_tokens": 7}
        }));
        let parsed = parse_messages_response(resp).unwrap();
        assert_eq!(parsed.stop_reason, StopReason::ToolUse);
        assert_eq!(parsed.message.content.len(), 2);
        match &parsed.message.content[1] {
            ContentBlock::ToolUse { id, name, input } => {
                assert_eq!(id.as_str(), "tu_1");
                assert_eq!(name, "Read");
                assert_eq!(input, &json!({"path": "README.md"}));
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn parse_thinking_blocks() {
        let resp = make_response(json!({
            "id": "msg_03",
            "content": [
                {"type": "thinking", "thinking": "let me think", "signature": "sig-base64"},
                {"type": "redacted_thinking", "data": "encrypted-blob"},
                {"type": "text", "text": "answer"}
            ],
            "stop_reason": "end_turn"
        }));
        let parsed = parse_messages_response(resp).unwrap();
        assert_eq!(parsed.message.content.len(), 3);
        assert!(matches!(
            &parsed.message.content[0],
            ContentBlock::Thinking { text, signature }
                if text == "let me think" && signature.as_deref() == Some("sig-base64")
        ));
        assert!(matches!(
            &parsed.message.content[1],
            ContentBlock::Thinking { text, signature }
                if text == "<redacted thinking>" && signature.as_deref() == Some("encrypted-blob")
        ));
    }

    #[test]
    fn parse_response_without_stop_reason_inferred_correctly() {
        // No stop_reason + tool_use → infer ToolUse
        let resp = make_response(json!({
            "id": "x",
            "content": [{"type": "tool_use", "id": "t", "name": "X", "input": {}}]
        }));
        let parsed = parse_messages_response(resp).unwrap();
        assert_eq!(parsed.stop_reason, StopReason::ToolUse);

        // No stop_reason + text only → EndTurn
        let resp = make_response(json!({"id": "x", "content": [{"type": "text", "text": "hi"}]}));
        let parsed = parse_messages_response(resp).unwrap();
        assert_eq!(parsed.stop_reason, StopReason::EndTurn);
    }

    #[test]
    fn cache_tokens_propagate() {
        let resp = make_response(json!({
            "id": "x",
            "content": [{"type": "text", "text": "hi"}],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 5,
                "cache_creation_input_tokens": 80,
                "cache_read_input_tokens": 20
            }
        }));
        let parsed = parse_messages_response(resp).unwrap();
        assert_eq!(parsed.usage.cache_creation_input_tokens, Some(80));
        assert_eq!(parsed.usage.cache_read_input_tokens, Some(20));
    }
}
