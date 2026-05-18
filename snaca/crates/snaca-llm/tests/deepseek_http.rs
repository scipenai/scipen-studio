//! HTTP-level integration tests for `DeepSeekClient` using `wiremock`.
//!
//! Verifies request shape and response parsing end-to-end, without hitting
//! a real DeepSeek endpoint. Each test stands up its own mock server.

use serde_json::json;
use snaca_core::{ContentBlock, Message, ToolUseId};
use snaca_llm::{
    DeepSeekClient, LlmClient, LlmError, MessageRequest, StopReason, ToolSchema,
};
use snaca_llm::deepseek::DeepSeekConfig;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn config(server: &MockServer) -> DeepSeekConfig {
    DeepSeekConfig::new("test-api-key").with_base_url(server.uri())
}

fn ok_response(message: serde_json::Value) -> serde_json::Value {
    json!({
        "id": "chatcmpl-test",
        "model": "deepseek-chat",
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": "stop"
        }],
        "usage": {
            "prompt_tokens": 12,
            "completion_tokens": 4,
            "total_tokens": 16
        }
    })
}

#[tokio::test]
async fn round_trips_text_request() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header("authorization", "Bearer test-api-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_response(
            json!({"role": "assistant", "content": "hello back"}),
        )))
        .expect(1)
        .mount(&server)
        .await;

    let client = DeepSeekClient::new(config(&server)).unwrap();
    let resp = client
        .create_message(
            MessageRequest::new("deepseek-chat")
                .with_system("You are SNACA")
                .with_messages(vec![Message::user_text("hi")]),
        )
        .await
        .unwrap();

    assert_eq!(resp.stop_reason, StopReason::EndTurn);
    assert_eq!(resp.usage.input_tokens, 12);
    assert_eq!(resp.usage.output_tokens, 4);
    match &resp.message.content[0] {
        ContentBlock::Text { text } => assert_eq!(text, "hello back"),
        other => panic!("expected text, got {other:?}"),
    }
}

#[tokio::test]
async fn round_trips_tool_call_response() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "chatcmpl-tc",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_001",
                        "type": "function",
                        "function": {
                            "name": "Read",
                            "arguments": "{\"path\":\"README.md\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 30, "completion_tokens": 8, "total_tokens": 38}
        })))
        .mount(&server)
        .await;

    let client = DeepSeekClient::new(config(&server)).unwrap();
    let resp = client
        .create_message(
            MessageRequest::new("deepseek-chat")
                .with_messages(vec![Message::user_text("read it")])
                .with_tools(vec![ToolSchema {
                    name: "Read".into(),
                    description: "read file".into(),
                    input_schema: json!({"type": "object"}),
                }]),
        )
        .await
        .unwrap();

    assert_eq!(resp.stop_reason, StopReason::ToolUse);
    match &resp.message.content[0] {
        ContentBlock::ToolUse { id, name, input } => {
            assert_eq!(id.as_str(), "call_001");
            assert_eq!(name, "Read");
            assert_eq!(input, &json!({"path": "README.md"}));
        }
        other => panic!("expected tool_use, got {other:?}"),
    }
}

#[tokio::test]
async fn assistant_history_with_tool_calls_round_trips_through_wire() {
    // Verify that an assistant message containing a previous tool call,
    // followed by a tool result, serializes into the OpenAI shape DeepSeek expects.
    let server = MockServer::start().await;
    // body_partial_json verifies the model is forwarded; counting messages is
    // tested indirectly via the conversion unit tests.
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_partial_json(json!({"model": "deepseek-chat"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_response(
            json!({"role": "assistant", "content": "done"}),
        )))
        .expect(1)
        .mount(&server)
        .await;

    let history = vec![
        Message::user_text("read README"),
        Message::new(
            snaca_core::Role::Assistant,
            vec![ContentBlock::tool_use(
                "call_1",
                "Read",
                json!({"path": "README.md"}),
            )],
        ),
        Message::new(
            snaca_core::Role::Tool,
            vec![ContentBlock::tool_result(
                ToolUseId::new("call_1"),
                vec![ContentBlock::text("# Hello\nworld")],
            )],
        ),
        Message::user_text("now summarise"),
    ];

    let client = DeepSeekClient::new(config(&server)).unwrap();
    let resp = client
        .create_message(MessageRequest::new("deepseek-chat").with_messages(history))
        .await
        .unwrap();
    assert_eq!(resp.stop_reason, StopReason::EndTurn);
}

#[tokio::test]
async fn rate_limit_maps_to_rate_limited_with_retry_after() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("Retry-After", "7")
                .set_body_json(json!({
                    "error": {
                        "message": "rate limit exceeded",
                        "type": "rate_limit_exceeded",
                        "code": "rate_limit"
                    }
                })),
        )
        .mount(&server)
        .await;
    let client = DeepSeekClient::new(config(&server)).unwrap();
    let err = client
        .create_message(
            MessageRequest::new("deepseek-chat")
                .with_messages(vec![Message::user_text("hi")]),
        )
        .await
        .unwrap_err();
    match err {
        LlmError::RateLimited { retry_after } => {
            assert_eq!(retry_after, Some(std::time::Duration::from_secs(7)));
        }
        other => panic!("expected RateLimited, got {other:?}"),
    }
}

#[tokio::test]
async fn server_5xx_maps_to_server_transient() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(500).set_body_string("internal server error"))
        .mount(&server)
        .await;
    let client = DeepSeekClient::new(config(&server)).unwrap();
    let err = client
        .create_message(
            MessageRequest::new("deepseek-chat")
                .with_messages(vec![Message::user_text("hi")]),
        )
        .await
        .unwrap_err();
    match err {
        LlmError::ServerTransient { status } => assert_eq!(status, 500),
        other => panic!("expected ServerTransient, got {other:?}"),
    }
}

#[tokio::test]
async fn empty_api_key_rejected_at_construction() {
    match DeepSeekClient::new(DeepSeekConfig::new("")) {
        Err(LlmError::InvalidConfig(_)) => {}
        Err(other) => panic!("expected InvalidConfig, got {other:?}"),
        Ok(_) => panic!("expected construction to fail with empty api key"),
    }
}
