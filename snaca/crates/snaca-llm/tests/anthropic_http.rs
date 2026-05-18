//! Wiremock-driven integration tests for `AnthropicClient`.
//!
//! Verifies request shape, response parsing, header conventions
//! (x-api-key + anthropic-version), and provider-error envelope handling.

use serde_json::json;
use snaca_core::{ContentBlock, Message, ToolUseId};
use snaca_llm::anthropic::AnthropicConfig;
use snaca_llm::{
    AnthropicClient, LlmClient, LlmError, MessageRequest, StopReason, ToolSchema,
};
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn config(server: &MockServer) -> AnthropicConfig {
    AnthropicConfig::new("test-anthropic-key").with_base_url(server.uri())
}

#[tokio::test]
async fn round_trips_text_request() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(header("x-api-key", "test-anthropic-key"))
        .and(header("anthropic-version", "2023-06-01"))
        .and(header("content-type", "application/json"))
        .and(body_partial_json(json!({
            "model": "claude-test",
            "max_tokens": 1024,
            // Production now emits system as an array-of-blocks so it
            // can attach cache_control. The block text and the
            // ephemeral marker are both part of the contract.
            "system": [{
                "type": "text",
                "text": "You are SNACA",
                "cache_control": {"type": "ephemeral"}
            }]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg_xx",
            "type": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": "hi back"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 7, "output_tokens": 2}
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = AnthropicClient::new(config(&server)).unwrap();
    let resp = client
        .create_message(
            MessageRequest::new("claude-test")
                .with_system("You are SNACA")
                .with_messages(vec![Message::user_text("hi")])
                .with_max_tokens(1024),
        )
        .await
        .unwrap();
    assert_eq!(resp.stop_reason, StopReason::EndTurn);
    assert_eq!(resp.usage.input_tokens, 7);
    match &resp.message.content[0] {
        ContentBlock::Text { text } => assert_eq!(text, "hi back"),
        other => panic!("got {other:?}"),
    }
}

#[tokio::test]
async fn round_trips_tool_use_response() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg_tc",
            "type": "message",
            "role": "assistant",
            "content": [
                {"type": "text", "text": "let me read"},
                {"type": "tool_use", "id": "tu_1", "name": "Read", "input": {"path": "x"}}
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 12, "output_tokens": 9}
        })))
        .mount(&server)
        .await;

    let client = AnthropicClient::new(config(&server)).unwrap();
    let resp = client
        .create_message(
            MessageRequest::new("claude-test")
                .with_messages(vec![Message::user_text("read it")])
                .with_tools(vec![ToolSchema {
                    name: "Read".into(),
                    description: "read a file".into(),
                    input_schema: json!({"type": "object"}),
                }]),
        )
        .await
        .unwrap();
    assert_eq!(resp.stop_reason, StopReason::ToolUse);
    assert_eq!(resp.message.content.len(), 2);
    match &resp.message.content[1] {
        ContentBlock::ToolUse { id, name, input } => {
            assert_eq!(id.as_str(), "tu_1");
            assert_eq!(name, "Read");
            assert_eq!(input, &json!({"path": "x"}));
        }
        other => panic!("got {other:?}"),
    }
}

#[tokio::test]
async fn tool_result_history_serialised_as_user_role_with_block() {
    // Verifies that a Role::Tool message in history serializes into a
    // role:"user" wire message whose content is a tool_result block.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(body_partial_json(json!({
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "read it"}]},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "tu_1", "name": "Read", "input": {"path": "x"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "tu_1",
                     "content": [{"type": "text", "text": "hello"}]}
                ]},
                {"role": "user", "content": [{"type": "text", "text": "now summarise"}]}
            ]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg_xyz",
            "type": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": "done"}],
            "stop_reason": "end_turn"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let history = vec![
        Message::user_text("read it"),
        Message::new(
            snaca_core::Role::Assistant,
            vec![ContentBlock::tool_use(
                "tu_1",
                "Read",
                json!({"path": "x"}),
            )],
        ),
        Message::new(
            snaca_core::Role::Tool,
            vec![ContentBlock::tool_result(
                ToolUseId::new("tu_1"),
                vec![ContentBlock::text("hello")],
            )],
        ),
        Message::user_text("now summarise"),
    ];
    let client = AnthropicClient::new(config(&server)).unwrap();
    client
        .create_message(MessageRequest::new("claude-test").with_messages(history))
        .await
        .unwrap();
}

#[tokio::test]
async fn auth_error_maps_to_auth_expired() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({
            "type": "error",
            "error": {"type": "invalid_api_key", "message": "x-api-key not found"}
        })))
        .mount(&server)
        .await;
    let client = AnthropicClient::new(config(&server)).unwrap();
    let err = client
        .create_message(
            MessageRequest::new("claude-test")
                .with_messages(vec![Message::user_text("hi")]),
        )
        .await
        .unwrap_err();
    // 401 maps to AuthExpired regardless of the envelope shape — the
    // classifier prefers the structured variant so the retry wrapper
    // can refuse to retry (rotating the credential is a human action).
    match err {
        LlmError::AuthExpired { status } => assert_eq!(status, 401),
        other => panic!("expected AuthExpired, got {other:?}"),
    }
}

#[tokio::test]
async fn empty_api_key_rejected_at_construction() {
    match AnthropicClient::new(AnthropicConfig::new("")) {
        Err(LlmError::InvalidConfig(_)) => {}
        Err(other) => panic!("expected InvalidConfig, got {other:?}"),
        Ok(_) => panic!("expected construction to fail with empty api key"),
    }
}
