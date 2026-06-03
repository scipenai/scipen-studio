//! Engine + streaming LLM client.
//!
//! Verifies that when the LLM speaks SSE-style deltas instead of
//! returning a final `MessageResponse`, the engine still produces the
//! same `TurnOutcome` (because it accumulates events through
//! `StreamAccumulator` internally). This is the seam where future typing
//! indicators / IM `update_message` integrations will hook in.

use async_trait::async_trait;
use futures::stream::{self, BoxStream};
use serde_json::json;
use snaca_core::{ContentBlock, ProjectId, Role, TenantId, ThreadId};
use snaca_engine::{Engine, EngineConfig, TurnRequest};
use snaca_llm::{
    ContentBlockStart, ContentDelta, LlmClient, LlmError, LlmResult, MessageRequest,
    MessageResponse, ProviderCaps, StopReason, StreamEvent,
};
use snaca_state::Database;
use snaca_tools_api::{ToolRegistry, ToolRegistryBuilder};
use snaca_workspace::WorkspaceLayout;
use std::sync::{Arc, Mutex};

mod common;
use common::EchoTool;

/// Scripted "streaming" LLM. For each `create_message_stream` call,
/// dequeues the next pre-recorded event sequence and emits it as a
/// stream. Asserts the engine consumes streaming output, not just the
/// non-streaming fallback.
struct StreamingMockLlm {
    queue: Mutex<Vec<Vec<StreamEvent>>>,
    /// Counter to make sure the streaming path was actually exercised.
    stream_calls: std::sync::atomic::AtomicUsize,
}

impl StreamingMockLlm {
    fn new() -> Self {
        Self {
            queue: Mutex::new(Vec::new()),
            stream_calls: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn enqueue(&self, events: Vec<StreamEvent>) {
        let mut q = self.queue.lock().unwrap();
        q.push(events);
    }

    fn stream_call_count(&self) -> usize {
        self.stream_calls.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[async_trait]
impl LlmClient for StreamingMockLlm {
    fn provider_name(&self) -> &'static str {
        "stream-mock"
    }
    fn model(&self) -> &str {
        "stream-mock"
    }
    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            streaming: true,
            ..Default::default()
        }
    }

    async fn create_message(&self, _req: MessageRequest) -> LlmResult<MessageResponse> {
        Err(LlmError::Other(
            "streaming mock should be driven via create_message_stream".into(),
        ))
    }

    async fn create_message_stream(
        &self,
        _req: MessageRequest,
    ) -> LlmResult<BoxStream<'static, LlmResult<StreamEvent>>> {
        self.stream_calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let events = {
            let mut q = self.queue.lock().unwrap();
            if q.is_empty() {
                return Err(LlmError::Other("stream queue empty".into()));
            }
            q.remove(0)
        };
        Ok(Box::pin(stream::iter(
            events.into_iter().map(Ok::<_, LlmError>),
        )))
    }
}

fn registry_with_echo() -> ToolRegistry {
    ToolRegistryBuilder::default().add(EchoTool).build()
}

async fn fixture(llm: Arc<dyn LlmClient>) -> (Engine, Database, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let engine = Engine::new(
        llm,
        registry_with_echo(),
        db.clone(),
        layout,
        EngineConfig::default_for("stream-mock"),
    );
    (engine, db, tmp)
}

fn turn_request(thread_id: &str) -> TurnRequest {
    TurnRequest {
        tenant_id: TenantId::new("t"),
        project_id: ProjectId::from_raw("p"),
        thread_id: ThreadId::new(thread_id),
        user_text: "stream please".into(),
        message_id: None,
        ephemeral_system: None,
    }
}

/// Fluent helper — build the canonical event sequence the SSE parsers
/// would emit for a one-block text response.
fn text_stream(text: &str) -> Vec<StreamEvent> {
    vec![
        StreamEvent::MessageStart {
            message_id: "m".into(),
            model: None,
        },
        StreamEvent::ContentBlockStart {
            index: 0,
            block: ContentBlockStart::Text,
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::Text {
                text: text.to_string(),
            },
        },
        StreamEvent::ContentBlockStop { index: 0 },
        StreamEvent::MessageDelta {
            stop_reason: Some(StopReason::EndTurn),
            usage: None,
        },
        StreamEvent::MessageStop,
    ]
}

fn tool_call_stream(call_id: &str, tool: &str, input_json: &str) -> Vec<StreamEvent> {
    vec![
        StreamEvent::MessageStart {
            message_id: "m".into(),
            model: None,
        },
        StreamEvent::ContentBlockStart {
            index: 0,
            block: ContentBlockStart::ToolUse {
                id: call_id.into(),
                name: tool.into(),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::ToolInputJson {
                partial_json: input_json.into(),
            },
        },
        StreamEvent::ContentBlockStop { index: 0 },
        StreamEvent::MessageDelta {
            stop_reason: Some(StopReason::ToolUse),
            usage: None,
        },
        StreamEvent::MessageStop,
    ]
}

#[tokio::test]
async fn streaming_text_only_produces_same_outcome_as_non_stream() {
    let llm = Arc::new(StreamingMockLlm::new());
    llm.enqueue(text_stream("Hello, world"));

    let (engine, db, _tmp) = fixture(llm.clone()).await;
    let outcome = engine.handle_turn(turn_request("c1")).await.unwrap();
    assert_eq!(outcome.iterations, 1);
    assert_eq!(outcome.assistant_text, "Hello, world");
    // create_message_stream really was called — not the non-streaming fallback.
    assert_eq!(llm.stream_call_count(), 1);

    let msgs = db.recent_messages(&ThreadId::new("c1"), 10).await.unwrap();
    let assistant = msgs
        .iter()
        .rev()
        .find(|m| matches!(m.role, Role::Assistant))
        .unwrap();
    match &assistant.content[0] {
        ContentBlock::Text { text } => assert_eq!(text, "Hello, world"),
        other => panic!("got {other:?}"),
    }
}

#[tokio::test]
async fn streaming_tool_call_round_trips_through_engine() {
    let llm = Arc::new(StreamingMockLlm::new());
    // Round 1: model streams a single tool call (Echo).
    llm.enqueue(tool_call_stream(
        "call_1",
        "Echo",
        &json!({"text": "stream-call"}).to_string(),
    ));
    // Round 2: streamed terminal text.
    llm.enqueue(text_stream("done"));

    let (engine, db, _tmp) = fixture(llm.clone()).await;
    let outcome = engine.handle_turn(turn_request("c2")).await.unwrap();
    assert_eq!(outcome.iterations, 2);
    assert_eq!(outcome.assistant_text, "done");
    assert_eq!(llm.stream_call_count(), 2);

    // The Tool message persisted should carry Echo's "echo: stream-call" output.
    let msgs = db.recent_messages(&ThreadId::new("c2"), 10).await.unwrap();
    let tool_msg = msgs
        .iter()
        .find(|m| matches!(m.role, Role::Tool))
        .expect("tool message");
    let result_text = tool_msg
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::ToolResult { content, .. } => content.iter().find_map(|c| match c {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            }),
            _ => None,
        })
        .unwrap();
    assert!(
        result_text.contains("stream-call"),
        "tool result missing payload: {result_text}"
    );
}

#[tokio::test]
async fn split_text_deltas_concatenate_into_one_block() {
    let llm = Arc::new(StreamingMockLlm::new());
    llm.enqueue(vec![
        StreamEvent::MessageStart {
            message_id: "m".into(),
            model: None,
        },
        StreamEvent::ContentBlockStart {
            index: 0,
            block: ContentBlockStart::Text,
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::Text {
                text: "Hello, ".into(),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::Text {
                text: "world".into(),
            },
        },
        StreamEvent::ContentBlockStop { index: 0 },
        StreamEvent::MessageDelta {
            stop_reason: Some(StopReason::EndTurn),
            usage: None,
        },
        StreamEvent::MessageStop,
    ]);
    let (engine, _db, _tmp) = fixture(llm.clone()).await;
    let outcome = engine.handle_turn(turn_request("c3")).await.unwrap();
    assert_eq!(outcome.assistant_text, "Hello, world");
}

/// Mock simulating DeepSeek on long-Chinese tool args:
/// `create_message_stream` finalises with malformed JSON (the SSE-concat
/// bug); `create_message` returns a clean response (non-streaming
/// endpoint sidesteps it).
struct StreamMalformedThenNonStreamSucceeds {
    stream_calls: std::sync::atomic::AtomicUsize,
    non_stream_queue: Mutex<std::collections::VecDeque<MessageResponse>>,
    non_stream_calls: std::sync::atomic::AtomicUsize,
}

impl StreamMalformedThenNonStreamSucceeds {
    fn new(non_stream_responses: Vec<MessageResponse>) -> Self {
        Self {
            stream_calls: std::sync::atomic::AtomicUsize::new(0),
            non_stream_queue: Mutex::new(non_stream_responses.into()),
            non_stream_calls: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl LlmClient for StreamMalformedThenNonStreamSucceeds {
    fn provider_name(&self) -> &'static str {
        "stream-broken-mock"
    }
    fn model(&self) -> &str {
        "stream-broken-mock"
    }
    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            streaming: true,
            ..Default::default()
        }
    }

    async fn create_message(&self, _req: MessageRequest) -> LlmResult<MessageResponse> {
        self.non_stream_calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.non_stream_queue
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| LlmError::Other("non-stream queue exhausted".into()))
    }

    async fn create_message_stream(
        &self,
        _req: MessageRequest,
    ) -> LlmResult<BoxStream<'static, LlmResult<StreamEvent>>> {
        let n = self
            .stream_calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        // Only the first stream call emits malformed args; later
        // iterations get a clean terminal so iteration 2 doesn't loop
        // on the same bug forever.
        let events = if n == 0 {
            vec![
                StreamEvent::MessageStart {
                    message_id: "m".into(),
                    model: None,
                },
                StreamEvent::ContentBlockStart {
                    index: 0,
                    block: ContentBlockStart::ToolUse {
                        id: "tu".into(),
                        name: "Echo".into(),
                    },
                },
                StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::ToolInputJson {
                        partial_json: r#"{"text": "broken json without closing quote }"#.into(),
                    },
                },
                StreamEvent::ContentBlockStop { index: 0 },
                StreamEvent::MessageDelta {
                    stop_reason: Some(StopReason::ToolUse),
                    usage: None,
                },
                StreamEvent::MessageStop,
            ]
        } else {
            text_stream("done")
        };
        Ok(Box::pin(stream::iter(events.into_iter().map(Ok))))
    }
}

#[tokio::test]
async fn malformed_streamed_tool_args_falls_back_to_non_streaming() {
    use snaca_core::{Message, MessageId, Usage};
    // The response the non-streaming endpoint would return: a clean
    // tool_use with valid JSON args. The engine should run it just like
    // the streaming success path.
    let clean_resp = MessageResponse {
        id: "mock-non-stream".into(),
        message: Message {
            id: MessageId::new(),
            role: Role::Assistant,
            content: vec![ContentBlock::tool_use(
                "tu_clean",
                "Echo",
                json!({"text": "recovered"}),
            )],
            created_at: chrono::Utc::now(),
        },
        usage: Usage {
            input_tokens: 1,
            output_tokens: 1,
            ..Default::default()
        },
        stop_reason: StopReason::ToolUse,
    };
    let llm = Arc::new(StreamMalformedThenNonStreamSucceeds::new(vec![clean_resp]));

    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let engine = Engine::new(
        llm.clone(),
        registry_with_echo(),
        db.clone(),
        layout,
        EngineConfig::default_for("stream-broken-mock"),
    );

    let outcome = engine
        .handle_turn(TurnRequest {
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("p"),
            thread_id: ThreadId::new("c_retry"),
            user_text: "go".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .expect("turn should succeed via non-streaming retry");

    assert_eq!(
        llm.non_stream_calls
            .load(std::sync::atomic::Ordering::Relaxed),
        1,
        "engine must issue exactly one non-streaming retry for the malformed stream"
    );
    assert_eq!(
        llm.stream_calls
            .load(std::sync::atomic::Ordering::Relaxed),
        2,
        "iter 1 retries non-streaming, iter 2 produces the terminal"
    );

    assert_eq!(outcome.assistant_text, "done");

    // The recovered tool must have actually executed.
    let msgs = db
        .recent_messages(&ThreadId::new("c_retry"), 20)
        .await
        .unwrap();
    let tool_msg = msgs
        .iter()
        .find(|m| matches!(m.role, Role::Tool))
        .expect("tool message must be persisted");
    let txt = tool_msg
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::ToolResult { content, .. } => content.iter().find_map(|c| match c {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            }),
            _ => None,
        })
        .unwrap_or_default();
    assert!(txt.contains("recovered"), "tool result missing: {txt}");
}

/// Mock where DeepSeek emits invalid JSON in *both* streaming AND
/// non-streaming for the same call; then iteration 2 (after the engine
/// persists a User feedback message) finally returns clean text.
struct BothPathsMalformedThenRecovers {
    stream_calls: std::sync::atomic::AtomicUsize,
    non_stream_calls: std::sync::atomic::AtomicUsize,
}

impl BothPathsMalformedThenRecovers {
    fn new() -> Self {
        Self {
            stream_calls: std::sync::atomic::AtomicUsize::new(0),
            non_stream_calls: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl LlmClient for BothPathsMalformedThenRecovers {
    fn provider_name(&self) -> &'static str {
        "both-broken-mock"
    }
    fn model(&self) -> &str {
        "both-broken-mock"
    }
    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            streaming: true,
            ..Default::default()
        }
    }

    async fn create_message(&self, _req: MessageRequest) -> LlmResult<MessageResponse> {
        // The engine wraps any non-streaming-retry failure back into
        // MalformedToolArgs, so returning MalformedResponse here exercises
        // the path where DeepSeek's non-streaming endpoint *also* returns
        // broken JSON.
        self.non_stream_calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Err(LlmError::MalformedResponse(
            "tool_call.arguments is not valid JSON: expected `,` or `}` at line 1 column 783"
                .into(),
        ))
    }

    async fn create_message_stream(
        &self,
        _req: MessageRequest,
    ) -> LlmResult<BoxStream<'static, LlmResult<StreamEvent>>> {
        let n = self
            .stream_calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let events = if n == 0 {
            vec![
                StreamEvent::MessageStart {
                    message_id: "m".into(),
                    model: None,
                },
                StreamEvent::ContentBlockStart {
                    index: 0,
                    block: ContentBlockStart::ToolUse {
                        id: "tu_bad".into(),
                        name: "Echo".into(),
                    },
                },
                StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::ToolInputJson {
                        partial_json: r#"{"text": "broken json without closing quote }"#.into(),
                    },
                },
                StreamEvent::ContentBlockStop { index: 0 },
                StreamEvent::MessageDelta {
                    stop_reason: Some(StopReason::ToolUse),
                    usage: None,
                },
                StreamEvent::MessageStop,
            ]
        } else {
            text_stream("recovered")
        };
        Ok(Box::pin(stream::iter(events.into_iter().map(Ok))))
    }
}

#[tokio::test]
async fn malformed_args_recovers_via_user_feedback_then_continues() {
    let llm = Arc::new(BothPathsMalformedThenRecovers::new());
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let engine = Engine::new(
        llm.clone(),
        registry_with_echo(),
        db.clone(),
        layout,
        EngineConfig::default_for("both-broken-mock"),
    );

    let outcome = engine
        .handle_turn(TurnRequest {
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("p"),
            thread_id: ThreadId::new("c_malformed_recovery"),
            user_text: "go".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .expect("turn should recover via feedback-and-retry");

    assert_eq!(outcome.assistant_text, "recovered");
    assert_eq!(
        llm.stream_calls
            .load(std::sync::atomic::Ordering::Relaxed),
        2,
        "iter 1 fails malformed, iter 2 produces terminal text"
    );
    assert_eq!(
        llm.non_stream_calls
            .load(std::sync::atomic::Ordering::Relaxed),
        1,
        "non-streaming retry runs exactly once (and also fails)"
    );

    // A User-role feedback message describing the parse error must be
    // persisted between iter 1 and iter 2.
    let msgs = db
        .recent_messages(&ThreadId::new("c_malformed_recovery"), 20)
        .await
        .unwrap();
    let feedback_msg = msgs
        .iter()
        .filter(|m| matches!(m.role, Role::User))
        .find_map(|m| {
            m.content.iter().find_map(|b| match b {
                ContentBlock::Text { text } if text.contains("Echo") && text.contains("JSON") => {
                    Some(text.clone())
                }
                _ => None,
            })
        })
        .expect("synthetic feedback message must be persisted to history");
    assert!(
        feedback_msg.contains("escaped as `\\\"`"),
        "feedback must name the escaping rule, got: {feedback_msg}"
    );
}

#[tokio::test]
async fn malformed_args_recovery_disabled_surfaces_error() {
    let llm = Arc::new(BothPathsMalformedThenRecovers::new());
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let mut cfg = EngineConfig::default_for("both-broken-mock");
    cfg.malformed_tool_args_max_retries = 0;
    let engine = Engine::new(llm.clone(), registry_with_echo(), db, layout, cfg);

    let err = engine
        .handle_turn(TurnRequest {
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("p"),
            thread_id: ThreadId::new("c_no_recovery"),
            user_text: "go".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .expect_err("recovery disabled — error must surface to caller");

    let s = format!("{err}");
    assert!(
        s.contains("Echo") && s.contains("invalid JSON"),
        "expected MalformedToolArgs surface, got: {s}"
    );
    // No second iteration should have run.
    assert_eq!(
        llm.stream_calls
            .load(std::sync::atomic::Ordering::Relaxed),
        1,
    );
}

#[tokio::test]
async fn mid_stream_error_aborts_turn() {
    let llm = Arc::new(StreamingMockLlm::new());
    llm.enqueue(vec![
        StreamEvent::MessageStart {
            message_id: "m".into(),
            model: None,
        },
        StreamEvent::ContentBlockStart {
            index: 0,
            block: ContentBlockStart::Text,
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::Text {
                text: "partial".into(),
            },
        },
        StreamEvent::Error {
            message: "rate limited".into(),
        },
    ]);

    let (engine, _db, _tmp) = fixture(llm).await;
    let err = engine.handle_turn(turn_request("c4")).await.unwrap_err();
    // Engine surfaces it as an LLM error.
    let s = format!("{err}");
    assert!(s.contains("rate limited"), "got: {s}");
}
