//! Canonical ↔ OpenAI wire conversion.
//!
//! Two directions:
//! - **Outbound (request)**: `MessageRequest` → `ChatRequest`. System prompt
//!   becomes a `role: "system"` message. `Role::Tool` messages are split:
//!   each `ToolResult` block becomes its own `role: "tool"` wire message.
//!   `Thinking` blocks become a `reasoning_content` field on the
//!   assistant message; standard OpenAI ignores it, reasoning gateways
//!   (DeepSeek thinking, Qwen-QwQ) REQUIRE the replay or they reject
//!   the next turn.
//! - **Inbound (response)**: `ChatResponse` → `MessageResponse`. Multiple
//!   `tool_calls` become multiple `ContentBlock::ToolUse` blocks; the order
//!   is preserved.

use crate::error::{LlmError, LlmResult};
use crate::openai::wire::{
    ChatRequest, ChatResponse, StreamOptions, WireMessage, WireTool, WireToolCall,
    WireToolCallFunction, WireToolDefinition,
};
use crate::request::{MessageRequest, ToolSchema};
use crate::response::{MessageResponse, StopReason};
use snaca_core::{ContentBlock, Message, MessageId, Role, ToolUseId};
use std::time::SystemTime;

pub fn build_chat_request(req: &MessageRequest, stream: bool) -> LlmResult<ChatRequest> {
    let mut messages = Vec::with_capacity(req.messages.len() + 1);

    // Top-level system prompt → first system wire message.
    if let Some(system) = &req.system {
        if !system.is_empty() {
            messages.push(WireMessage {
                role: "system".into(),
                content: Some(system.clone()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
            });
        }
    }

    for msg in &req.messages {
        push_message(msg, &mut messages)?;
    }

    let tools = req.tools.iter().map(tool_schema_to_wire).collect();

    Ok(ChatRequest {
        model: req.model.clone(),
        messages,
        tools,
        max_tokens: req.max_tokens,
        temperature: req.temperature,
        stop: if req.stop_sequences.is_empty() {
            None
        } else {
            Some(req.stop_sequences.clone())
        },
        stream,
        stream_options: if stream {
            Some(StreamOptions { include_usage: true })
        } else {
            None
        },
    })
}

fn push_message(msg: &Message, out: &mut Vec<WireMessage>) -> LlmResult<()> {
    match msg.role {
        Role::System => {
            let text = ContentBlock::collect_text(&msg.content);
            out.push(WireMessage {
                role: "system".into(),
                content: Some(text),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
            });
        }
        Role::User => {
            let text = ContentBlock::collect_text(&msg.content);
            out.push(WireMessage {
                role: "user".into(),
                content: Some(text),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
            });
        }
        Role::Assistant => {
            let mut text = String::new();
            let mut reasoning = String::new();
            let mut tool_calls: Vec<WireToolCall> = Vec::new();
            for block in &msg.content {
                match block {
                    ContentBlock::Text { text: t } => {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(t);
                    }
                    // Reasoning gateways (DeepSeek thinking, Qwen-QwQ, ...)
                    // require the prior trace to be replayed. Standard OpenAI
                    // ignores the field, so emitting it is safe in both cases.
                    ContentBlock::Thinking { text: t, .. } => {
                        if !reasoning.is_empty() {
                            reasoning.push('\n');
                        }
                        reasoning.push_str(t);
                    }
                    ContentBlock::ToolUse { id, name, input } => {
                        tool_calls.push(WireToolCall {
                            id: id.as_str().to_string(),
                            call_type: "function".into(),
                            function: WireToolCallFunction {
                                name: name.clone(),
                                arguments: serde_json::to_string(input)?,
                            },
                        });
                    }
                    _ => {}
                }
            }
            out.push(WireMessage {
                role: "assistant".into(),
                content: if text.is_empty() { None } else { Some(text) },
                reasoning_content: if reasoning.is_empty() {
                    None
                } else {
                    Some(reasoning)
                },
                tool_calls: if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls)
                },
                tool_call_id: None,
                name: None,
            });
        }
        Role::Tool => {
            for block in &msg.content {
                if let ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error: _,
                } = block
                {
                    let text = ContentBlock::collect_text(content);
                    out.push(WireMessage {
                        role: "tool".into(),
                        content: Some(text),
                        reasoning_content: None,
                        tool_calls: None,
                        tool_call_id: Some(tool_use_id.as_str().to_string()),
                        name: None,
                    });
                }
            }
        }
    }
    Ok(())
}

fn tool_schema_to_wire(s: &ToolSchema) -> WireTool {
    WireTool {
        tool_type: "function".into(),
        function: WireToolDefinition {
            name: s.name.clone(),
            description: s.description.clone(),
            parameters: s.input_schema.clone(),
        },
    }
}

pub fn parse_chat_response(resp: ChatResponse) -> LlmResult<MessageResponse> {
    let choice = resp
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| LlmError::MalformedResponse("no choices in response".into()))?;

    let mut content: Vec<ContentBlock> = Vec::new();

    // Surface reasoning content (when the upstream supports it — many
    // OpenAI-compat reasoning gateways re-use the DeepSeek-R1 field name).
    if let Some(reasoning) = choice
        .message
        .reasoning_content
        .as_deref()
        .filter(|s| !s.is_empty())
    {
        content.push(ContentBlock::Thinking {
            text: reasoning.to_string(),
            signature: None,
        });
    }

    if let Some(text) = choice.message.content.as_deref().filter(|s| !s.is_empty()) {
        content.push(ContentBlock::text(text));
    }

    if let Some(tool_calls) = choice.message.tool_calls {
        for tc in tool_calls {
            let input: serde_json::Value =
                if tc.function.arguments.is_empty() {
                    serde_json::Value::Object(Default::default())
                } else {
                    serde_json::from_str(&tc.function.arguments).map_err(|e| {
                        LlmError::MalformedResponse(format!(
                            "tool_call.arguments is not valid JSON: {e}"
                        ))
                    })?
                };
            content.push(ContentBlock::ToolUse {
                id: ToolUseId::new(tc.id),
                name: tc.function.name,
                input,
            });
        }
    }

    let stop_reason = match choice.finish_reason.as_deref() {
        Some("stop") => StopReason::EndTurn,
        Some("length") => StopReason::MaxTokens,
        Some("tool_calls") | Some("function_call") => StopReason::ToolUse,
        Some("stop_sequence") => StopReason::StopSequence,
        Some(other) => StopReason::Other(other.to_string()),
        // No finish_reason: pick something safe — if there's a tool call, it's
        // ToolUse, otherwise EndTurn.
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

    let usage = resp.usage.map(Into::into).unwrap_or_default();

    Ok(MessageResponse {
        id: resp.id,
        message: Message {
            id: MessageId::new(),
            role: Role::Assistant,
            content,
            created_at: chrono::DateTime::<chrono::Utc>::from(SystemTime::now()),
        },
        usage,
        stop_reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use snaca_core::{ContentBlock, Message, Role};

    fn user(text: &str) -> Message {
        Message::user_text(text)
    }

    fn assistant_text(text: &str) -> Message {
        Message::assistant_text(text)
    }

    fn assistant_tool_call(id: &str, name: &str, args: serde_json::Value) -> Message {
        Message::new(
            Role::Assistant,
            vec![ContentBlock::tool_use(id, name, args)],
        )
    }

    fn tool_result(id: &str, text: &str) -> Message {
        Message::new(
            Role::Tool,
            vec![ContentBlock::tool_result(
                ToolUseId::new(id),
                vec![ContentBlock::text(text)],
            )],
        )
    }

    fn tool_schema(name: &str) -> ToolSchema {
        ToolSchema {
            name: name.to_string(),
            description: format!("description of {name}"),
            input_schema: json!({"type": "object"}),
        }
    }

    #[test]
    fn system_prompt_becomes_first_message() {
        let req = MessageRequest::new("gpt-4o-mini")
            .with_system("You are SNACA")
            .with_messages(vec![user("hi")]);
        let wire = build_chat_request(&req, false).unwrap();
        assert_eq!(wire.messages.len(), 2);
        assert_eq!(wire.messages[0].role, "system");
        assert_eq!(wire.messages[0].content.as_deref(), Some("You are SNACA"));
        assert_eq!(wire.messages[1].role, "user");
    }

    #[test]
    fn assistant_text_only_serializes_content() {
        let req = MessageRequest::new("gpt-4o-mini")
            .with_messages(vec![assistant_text("ok")]);
        let wire = build_chat_request(&req, false).unwrap();
        assert_eq!(wire.messages[0].content.as_deref(), Some("ok"));
        assert!(wire.messages[0].tool_calls.is_none());
    }

    #[test]
    fn assistant_tool_call_serializes_tool_calls() {
        let req = MessageRequest::new("gpt-4o-mini").with_messages(vec![assistant_tool_call(
            "call_1",
            "Read",
            json!({"path": "x"}),
        )]);
        let wire = build_chat_request(&req, false).unwrap();
        let tcs = wire.messages[0].tool_calls.as_ref().unwrap();
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0].id, "call_1");
        assert_eq!(tcs[0].function.name, "Read");
        assert_eq!(tcs[0].function.arguments, "{\"path\":\"x\"}");
        // Content should be omitted when empty.
        assert!(wire.messages[0].content.is_none());
    }

    #[test]
    fn tool_result_split_into_role_tool_messages() {
        let req = MessageRequest::new("gpt-4o-mini")
            .with_messages(vec![tool_result("call_1", "file contents")]);
        let wire = build_chat_request(&req, false).unwrap();
        assert_eq!(wire.messages.len(), 1);
        assert_eq!(wire.messages[0].role, "tool");
        assert_eq!(wire.messages[0].tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(wire.messages[0].content.as_deref(), Some("file contents"));
    }

    #[test]
    fn thinking_blocks_replayed_as_reasoning_content() {
        // Reasoning gateways (DeepSeek thinking, Qwen-QwQ) reject the
        // next turn unless the prior reasoning trace is replayed.
        // Standard OpenAI ignores the extra field.
        let assistant_with_thinking = Message::new(
            Role::Assistant,
            vec![
                ContentBlock::thinking("think think"),
                ContentBlock::text("answer"),
            ],
        );
        let req = MessageRequest::new("gpt-4o-mini")
            .with_messages(vec![assistant_with_thinking]);
        let wire = build_chat_request(&req, false).unwrap();
        assert_eq!(wire.messages[0].content.as_deref(), Some("answer"));
        assert_eq!(
            wire.messages[0].reasoning_content.as_deref(),
            Some("think think")
        );
    }

    #[test]
    fn tools_serialize_as_function_type() {
        let req = MessageRequest::new("gpt-4o-mini").with_tools(vec![tool_schema("Read")]);
        let wire = build_chat_request(&req, false).unwrap();
        assert_eq!(wire.tools.len(), 1);
        assert_eq!(wire.tools[0].tool_type, "function");
        assert_eq!(wire.tools[0].function.name, "Read");
    }

    fn make_chat_response(json: serde_json::Value) -> ChatResponse {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn parse_text_response() {
        let resp = make_chat_response(json!({
            "id": "chatcmpl-1",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "hello"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}
        }));
        let parsed = parse_chat_response(resp).unwrap();
        assert_eq!(parsed.stop_reason, StopReason::EndTurn);
        assert_eq!(parsed.usage.input_tokens, 5);
        assert_eq!(parsed.usage.output_tokens, 1);
        match &parsed.message.content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "hello"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn parse_tool_call_response() {
        let resp = make_chat_response(json!({
            "id": "chatcmpl-2",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "Read",
                            "arguments": "{\"path\":\"x\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }));
        let parsed = parse_chat_response(resp).unwrap();
        assert_eq!(parsed.stop_reason, StopReason::ToolUse);
        assert_eq!(parsed.message.content.len(), 1);
        match &parsed.message.content[0] {
            ContentBlock::ToolUse { id, name, input } => {
                assert_eq!(id.as_str(), "call_1");
                assert_eq!(name, "Read");
                assert_eq!(input, &json!({"path": "x"}));
            }
            other => panic!("expected tool use, got {other:?}"),
        }
    }

    #[test]
    fn parse_response_handles_missing_finish_reason() {
        // Falls back to EndTurn when there are no tool calls and no reason.
        let resp = make_chat_response(json!({
            "id": "x",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}}]
        }));
        let parsed = parse_chat_response(resp).unwrap();
        assert_eq!(parsed.stop_reason, StopReason::EndTurn);
    }

    #[test]
    fn parse_response_falls_back_to_tool_use_on_missing_reason_with_tool_calls() {
        let resp = make_chat_response(json!({
            "id": "x",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "c1",
                        "type": "function",
                        "function": {"name": "X", "arguments": "{}"}
                    }]
                }
            }]
        }));
        let parsed = parse_chat_response(resp).unwrap();
        assert_eq!(parsed.stop_reason, StopReason::ToolUse);
    }

    #[test]
    fn parse_invalid_tool_arguments_errors() {
        let resp = make_chat_response(json!({
            "id": "x",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "c",
                        "type": "function",
                        "function": {"name": "X", "arguments": "not json {{"}
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }));
        let err = parse_chat_response(resp).unwrap_err();
        assert!(matches!(err, LlmError::MalformedResponse(_)));
    }

    #[test]
    fn empty_choices_errors() {
        let resp = make_chat_response(json!({"id": "x", "choices": []}));
        let err = parse_chat_response(resp).unwrap_err();
        assert!(matches!(err, LlmError::MalformedResponse(_)));
    }

    /// Many OpenAI-compatible reasoning gateways (DeepSeek-R1 via OpenAI
    /// path, Qwen-QwQ, GLM-4-Flash-Thinking, …) re-use the
    /// `reasoning_content` field name. Verify we surface it as a Thinking
    /// block on inbound; vanilla `gpt-4o` responses don't include it and
    /// degrade to the prior `parse_text_response` shape.
    #[test]
    fn parse_response_with_reasoning_content() {
        let resp = make_chat_response(json!({
            "id": "chatcmpl-r",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "answer",
                    "reasoning_content": "let me think"
                },
                "finish_reason": "stop"
            }]
        }));
        let parsed = parse_chat_response(resp).unwrap();
        assert_eq!(parsed.message.content.len(), 2);
        assert!(matches!(
            &parsed.message.content[0],
            ContentBlock::Thinking { text, .. } if text == "let me think"
        ));
        assert!(matches!(
            &parsed.message.content[1],
            ContentBlock::Text { text } if text == "answer"
        ));
    }
}
