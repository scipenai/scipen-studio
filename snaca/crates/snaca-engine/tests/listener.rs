//! Verifies that a `TurnEventListener` attached via `handle_turn_full`
//! observes every `StreamEvent` produced inside the turn — independently
//! of whether the LLM is streaming natively or driven through the trait's
//! synthesize fallback.

use async_trait::async_trait;
use futures::stream;
use serde_json::json;
use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_engine::{Engine, EngineConfig, NoopApprovalGate, RecordingListener, TurnRequest};
use snaca_llm::{
    ContentBlockStart, ContentDelta, LlmClient, LlmError, LlmResult, MessageRequest,
    MessageResponse, ProviderCaps, StopReason, StreamEvent,
};
use snaca_state::Database;
use snaca_tools_api::{ToolRegistry, ToolRegistryBuilder};
use snaca_workspace::WorkspaceLayout;
use std::sync::{Arc, Mutex};

mod common;
use common::{assistant_text, EchoTool, MockLlmClient};

fn registry() -> ToolRegistry {
    ToolRegistryBuilder::default().add(EchoTool).build()
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

#[tokio::test]
async fn listener_observes_full_event_sequence_via_synthesize_fallback() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let llm = Arc::new(MockLlmClient::new());

    // Non-streaming mock — engine's create_message_stream falls back to
    // synthesize_events. Listener must see the full event sequence.
    llm.enqueue(assistant_text("Hello, world"));

    let engine = Engine::new(
        llm,
        registry(),
        db,
        layout,
        EngineConfig::default_for("mock-model"),
    );
    let recorder = Arc::new(RecordingListener::new());
    engine
        .handle_turn_full(
            turn_request("c1"),
            Arc::new(NoopApprovalGate),
            recorder.clone(),
        )
        .await
        .unwrap();

    let events = recorder.snapshot();
    // Synthesize emits: MessageStart + ContentBlockStart + ContentBlockDelta
    // + ContentBlockStop + MessageDelta + MessageStop = 6 events.
    assert_eq!(events.len(), 6, "got {events:#?}");
    assert!(matches!(events[0], StreamEvent::MessageStart { .. }));
    assert!(matches!(
        events[1],
        StreamEvent::ContentBlockStart {
            block: ContentBlockStart::Text,
            ..
        }
    ));
    match &events[2] {
        StreamEvent::ContentBlockDelta {
            delta: ContentDelta::Text { text },
            ..
        } => assert_eq!(text, "Hello, world"),
        other => panic!("got {other:?}"),
    }
    assert!(matches!(events.last(), Some(StreamEvent::MessageStop)));
}

/// Records every `create_message_stream` invocation but lets us script
/// the events. Used to check that `handle_turn_full` forwards every
/// streamed delta, including ones that span multiple chunks.
struct ScriptedStreamLlm {
    queue: Mutex<Vec<Vec<StreamEvent>>>,
}

#[async_trait]
impl LlmClient for ScriptedStreamLlm {
    fn provider_name(&self) -> &'static str {
        "scripted-stream"
    }
    fn model(&self) -> &str {
        "scripted-stream"
    }
    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            streaming: true,
            ..Default::default()
        }
    }
    async fn create_message(&self, _req: MessageRequest) -> LlmResult<MessageResponse> {
        Err(LlmError::Other("scripted stream only".into()))
    }
    async fn create_message_stream(
        &self,
        _req: MessageRequest,
    ) -> LlmResult<futures::stream::BoxStream<'static, LlmResult<StreamEvent>>> {
        let evs = {
            let mut q = self.queue.lock().unwrap();
            if q.is_empty() {
                return Err(LlmError::Other("queue empty".into()));
            }
            q.remove(0)
        };
        Ok(Box::pin(stream::iter(
            evs.into_iter().map(Ok::<_, LlmError>),
        )))
    }
}

#[tokio::test]
async fn listener_records_native_stream_deltas_in_order() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();

    let scripted = Arc::new(ScriptedStreamLlm {
        queue: Mutex::new(vec![vec![
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
        ]]),
    });
    let engine = Engine::new(
        scripted,
        registry(),
        db,
        layout,
        EngineConfig::default_for("scripted-stream"),
    );
    let recorder = Arc::new(RecordingListener::new());
    let outcome = engine
        .handle_turn_full(
            turn_request("c2"),
            Arc::new(NoopApprovalGate),
            recorder.clone(),
        )
        .await
        .unwrap();

    assert_eq!(outcome.assistant_text, "Hello, world");
    let events = recorder.snapshot();
    let text_deltas: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::ContentBlockDelta {
                delta: ContentDelta::Text { text },
                ..
            } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text_deltas, vec!["Hello, ", "world"]);
    // Also got a final MessageStop in the recorded sequence.
    assert!(matches!(events.last(), Some(StreamEvent::MessageStop)));
    let _ = json!({}); // silence unused import on miri/clippy
}
