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
use snaca_engine::{
    Engine, EngineConfig, NoopApprovalGate, NoopQuestionGate, TurnEventListener, TurnRequest,
};
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
    queue: Mutex<Vec<Vec<LlmResult<StreamEvent>>>>,
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
        q.push(events.into_iter().map(Ok).collect());
    }

    fn enqueue_results(&self, events: Vec<LlmResult<StreamEvent>>) {
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
        Ok(Box::pin(stream::iter(events)))
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
    }
    ephemeral_system: None,
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

#[derive(Default)]
struct RetryRecordingListener {
    events: Mutex<Vec<StreamEvent>>,
    retries: Mutex<Vec<String>>,
}

#[async_trait]
impl TurnEventListener for RetryRecordingListener {
    async fn on_event(&self, event: &StreamEvent) {
        self.events.lock().unwrap().push(event.clone());
    }

    async fn on_stream_retry(&self, attempt: u8, error: &LlmError) {
        self.retries
            .lock()
            .unwrap()
            .push(format!("{attempt}:{error}"));
    }
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

#[tokio::test]
async fn interrupted_stream_retries_same_request_and_discards_partial_response() {
    let llm = Arc::new(StreamingMockLlm::new());
    llm.enqueue_results(vec![
        Ok(StreamEvent::MessageStart {
            message_id: "broken".into(),
            model: None,
        }),
        Ok(StreamEvent::ContentBlockStart {
            index: 0,
            block: ContentBlockStart::Text,
        }),
        Ok(StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::Text {
                text: "partial ".into(),
            },
        }),
        Err(LlmError::StreamInterrupted(
            "error reading a body from connection -> Connection reset by peer".into(),
        )),
    ]);
    llm.enqueue(text_stream("recovered"));

    let (engine, db, _tmp) = fixture(llm.clone()).await;
    let listener = Arc::new(RetryRecordingListener::default());
    let outcome = engine
        .handle_turn_full(
            turn_request("c_stream_retry"),
            Arc::new(NoopApprovalGate),
            listener.clone(),
            Arc::new(NoopQuestionGate),
        )
        .await
        .unwrap();

    assert_eq!(outcome.assistant_text, "recovered");
    assert_eq!(llm.stream_call_count(), 2);
    assert_eq!(listener.retries.lock().unwrap().len(), 1);

    let msgs = db
        .recent_messages(&ThreadId::new("c_stream_retry"), 10)
        .await
        .unwrap();
    let assistant_msgs: Vec<_> = msgs
        .iter()
        .filter(|m| matches!(m.role, Role::Assistant))
        .collect();
    assert_eq!(assistant_msgs.len(), 1);
    match &assistant_msgs[0].content[0] {
        ContentBlock::Text { text } => assert_eq!(text, "recovered"),
        other => panic!("got {other:?}"),
    }
}

/// Mock that simulates DeepSeek's behaviour on long-Chinese tool args:
/// `create_message_stream` returns a stream that finalises with
/// malformed JSON (the SSE-concat bug); `create_message` returns a
/// clean response (the non-streaming endpoint sidesteps the bug).
struct StreamMalformedThenNonStreamSucceeds {
    /// Stream behaviour: first call emits malformed JSON tool args;
    /// subsequent calls emit a clean terminal text so the engine can
    /// reach a normal end-of-turn on the next iteration.
    stream_calls: std::sync::atomic::AtomicUsize,
    /// Non-stream behaviour: each pop returns the next pre-recorded
    /// response. The first one is the "retry" — a valid tool_use.
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
        // Only the first stream call emits the malformed args. Later
        // iterations get a clean terminal — otherwise iteration 2
        // would loop on the same bug forever.
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
    // Build the response the non-streaming endpoint would have
    // returned: a clean tool_use block with valid JSON args. The
    // engine should run that tool just like the streaming success path.
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

    // After the tool runs we need a terminal response. The engine
    // calls create_message_stream again for the second iteration —
    // it'll fail "non-stream queue exhausted" path, but we expect
    // stream to be hit. To keep the test focused, give the second
    // iteration a working stream too. Simplest: cap max_iterations
    // at 1 so the engine returns after one tool round-trip. But
    // there's no max_iterations=1 shortcut. Instead: drop a fresh
    // mock chain in front.
    //
    // To avoid coupling to iteration count, we just inspect the
    // mock's counters and accept whatever error the second
    // iteration's stream produces — the assertion we care about is
    // that the non-streaming retry was issued exactly once.
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
        "streaming path is attempted for both iterations; iter 1 retries non-streaming, iter 2 produces the terminal"
    );

    assert_eq!(outcome.assistant_text, "done");

    // Verify the recovered tool actually executed: there should be a
    // tool_result message with "recovered" in the payload.
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

/// Mock that simulates the case the new MalformedToolArgs recovery
/// targets: DeepSeek emits invalid JSON in *both* streaming AND
/// non-streaming responses for the same long-Chinese tool call. Then,
/// on the second iteration (after the engine persists a User feedback
/// message), the model finally gets it right and returns clean text.
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
        // LlmError::MalformedToolArgs with the original message, so
        // returning `MalformedResponse` here exercises exactly the path
        // that fires when DeepSeek's non-streaming endpoint *also*
        // returns broken JSON (the column 783 case in the log).
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
        // Iteration 1 hits the malformed-args bug. Iteration 2 (after
        // the engine's feedback message lands in history) emits clean
        // terminal text — proves the recovery actually unblocked the
        // turn rather than masking the error.
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
        llm.stream_calls.load(std::sync::atomic::Ordering::Relaxed),
        2,
        "iter 1 fails malformed, iter 2 produces terminal text"
    );
    assert_eq!(
        llm.non_stream_calls
            .load(std::sync::atomic::Ordering::Relaxed),
        1,
        "non-streaming retry runs exactly once (and also fails)"
    );

    // The recovery contract is that a User-role feedback message
    // describing the parse error must be persisted between iter 1 and
    // iter 2. Without it the model has no signal about what went wrong
    // and the loop would either repeat or silently swallow the error.
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
        llm.stream_calls.load(std::sync::atomic::Ordering::Relaxed),
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

/// Collects every `ContentDelta::Text` the engine forwards to the
/// listener — i.e. exactly what an IM channel would render to the user.
#[derive(Default)]
struct TextRecordingListener {
    text: Mutex<String>,
}

#[async_trait]
impl TurnEventListener for TextRecordingListener {
    async fn on_event(&self, event: &StreamEvent) {
        if let StreamEvent::ContentBlockDelta {
            delta: ContentDelta::Text { text },
            ..
        } = event
        {
            self.text.lock().unwrap().push_str(text);
        }
    }
}

/// The model echoes our injected `<memory-context>` fence back in its
/// streamed text, split across chunk boundaries. The scrubber must
/// strip it from BOTH the user-facing stream (listener) and the
/// next-turn transcript (the persisted assistant message), without
/// dropping the legitimate text on either side of the fence.
#[tokio::test]
async fn streamed_memory_context_fence_is_scrubbed_from_listener_and_transcript() {
    let llm = Arc::new(StreamingMockLlm::new());
    // One text block whose deltas, concatenated, are:
    //   "before <memory-context>poison</memory-context> after"
    // The fence open straddles two chunks (`<memo` / `ry-context>`).
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
                text: "before <memo".into(),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::Text {
                text: "ry-context>poison</memory-context> after".into(),
            },
        },
        StreamEvent::ContentBlockStop { index: 0 },
        StreamEvent::MessageDelta {
            stop_reason: Some(StopReason::EndTurn),
            usage: None,
        },
        StreamEvent::MessageStop,
    ]);

    let (engine, db, _tmp) = fixture(llm).await;
    let listener = Arc::new(TextRecordingListener::default());
    let outcome = engine
        .handle_turn_full(
            turn_request("c_scrub"),
            Arc::new(NoopApprovalGate),
            listener.clone(),
            Arc::new(NoopQuestionGate),
        )
        .await
        .unwrap();

    // User-facing stream: fence content gone, surrounding text intact.
    let streamed = listener.text.lock().unwrap().clone();
    assert!(
        !streamed.contains("poison"),
        "listener saw fence body: {streamed:?}"
    );
    assert!(
        !streamed.contains("memory-context"),
        "listener saw fence tag: {streamed:?}"
    );
    assert!(
        streamed.contains("before "),
        "listener lost pre-fence text: {streamed:?}"
    );
    assert!(
        streamed.contains("after"),
        "listener lost post-fence text: {streamed:?}"
    );

    // Accumulated assistant text (what the next turn / extractor reads).
    assert!(!outcome.assistant_text.contains("poison"));
    assert!(!outcome.assistant_text.contains("memory-context"));
    assert!(outcome.assistant_text.contains("before "));
    assert!(outcome.assistant_text.contains("after"));

    // Persisted transcript must match — this is the surface the
    // post-turn extractor mines, so a leak here would re-ingest our
    // own injected context.
    let msgs = db
        .recent_messages(&ThreadId::new("c_scrub"), 10)
        .await
        .unwrap();
    let assistant = msgs
        .iter()
        .find(|m| matches!(m.role, Role::Assistant))
        .expect("assistant message persisted");
    match &assistant.content[0] {
        ContentBlock::Text { text } => {
            assert!(
                !text.contains("poison"),
                "transcript leaked fence body: {text:?}"
            );
            assert!(!text.contains("memory-context"));
        }
        other => panic!("got {other:?}"),
    }
}

/// An ordinary, fence-free streamed response must pass through the
/// scrubber byte-for-byte — no held-back tail, no dropped text.
#[tokio::test]
async fn streamed_plain_text_is_unchanged_by_scrubber() {
    let llm = Arc::new(StreamingMockLlm::new());
    llm.enqueue(text_stream("just a normal answer with a < less-than sign"));

    let (engine, _db, _tmp) = fixture(llm).await;
    let listener = Arc::new(TextRecordingListener::default());
    let outcome = engine
        .handle_turn_full(
            turn_request("c_plain"),
            Arc::new(NoopApprovalGate),
            listener.clone(),
            Arc::new(NoopQuestionGate),
        )
        .await
        .unwrap();

    assert_eq!(
        outcome.assistant_text,
        "just a normal answer with a < less-than sign"
    );
    assert_eq!(
        listener.text.lock().unwrap().clone(),
        "just a normal answer with a < less-than sign"
    );
}
