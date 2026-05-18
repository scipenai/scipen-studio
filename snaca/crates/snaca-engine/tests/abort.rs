//! Abort + turn-timeout end-to-end coverage.
//!
//! Verifies that `Engine::abort_thread` cancels the in-flight turn,
//! that the wall-clock budget surfaces as `TurnTimeout`, and that
//! the inflight map cleans up on every exit path.

use async_trait::async_trait;
use serde_json::{json, Value};
use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_engine::{Engine, EngineConfig, EngineError, TurnRequest};
use snaca_state::Database;
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolOutput, ToolResult,
    ToolRegistryBuilder,
};
use snaca_workspace::WorkspaceLayout;
use std::sync::Arc;
use std::time::Duration;

mod common;
use common::{assistant_text, assistant_tool_call, MockLlmClient};

/// A tool that just sleeps. Used to simulate a long-running tool the
/// engine should be able to cancel mid-flight.
struct SleepyTool;

#[async_trait]
impl Tool for SleepyTool {
    fn name(&self) -> &str {
        "Sleepy"
    }
    fn description(&self) -> &str {
        "sleep test"
    }
    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }
    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::read_only_filesystem()
    }
    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }
    async fn execute(&self, _input: Value, _ctx: &ToolContext) -> ToolResult {
        // Long enough that the abort path is the only way out — if
        // the test ever has to wait the full duration we know cancel
        // didn't propagate.
        tokio::time::sleep(Duration::from_secs(30)).await;
        Ok(ToolOutput::text("done"))
    }
}

fn engine_with_sleepy(timeout: Option<u64>) -> Arc<Engine> {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = futures::executor::block_on(Database::open_in_memory()).unwrap();
    let tools = ToolRegistryBuilder::default().add(SleepyTool).build();

    let llm = Arc::new(MockLlmClient::new());
    llm.enqueue(assistant_tool_call(vec![(
        "call_1",
        "Sleepy",
        json!({}),
    )]));
    llm.enqueue(assistant_text("done"));

    let mut cfg = EngineConfig::default_for("mock-model");
    cfg.turn_timeout_secs = timeout;
    Arc::new(Engine::new(llm, tools, db, layout, cfg))
}

#[tokio::test(flavor = "multi_thread")]
async fn external_abort_short_circuits_turn() {
    let engine = engine_with_sleepy(None);
    let tenant = TenantId::new("t");
    let project = ProjectId::from_raw("p");
    let thread = ThreadId::new("chat_a");

    let engine_for_turn = engine.clone();
    let t = tenant.clone();
    let p = project.clone();
    let th = thread.clone();
    let turn = tokio::spawn(async move {
        engine_for_turn
            .handle_turn(TurnRequest {
                tenant_id: t,
                project_id: p,
                thread_id: th,
                user_text: "go".into(),
                message_id: None,            })
            .await
    });

    // Give the turn a moment to register its inflight token + enter
    // the Sleepy tool. 200ms is generous; Sleepy sleeps 30s so we're
    // nowhere near a race with completion.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        engine.abort_thread(&thread),
        1,
        "abort_thread should find the one inflight turn"
    );

    let result = tokio::time::timeout(Duration::from_secs(2), turn)
        .await
        .expect("turn should return within 2s after abort")
        .expect("turn task join");

    assert!(
        matches!(result, Err(EngineError::Aborted)),
        "got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn wall_clock_timeout_surfaces_turn_timeout() {
    let engine = engine_with_sleepy(Some(1));
    let tenant = TenantId::new("t");
    let project = ProjectId::from_raw("p");
    let thread = ThreadId::new("chat_b");

    let started = std::time::Instant::now();
    let result = engine
        .handle_turn(TurnRequest {
            tenant_id: tenant,
            project_id: project,
            thread_id: thread,
            user_text: "go".into(),
            message_id: None,        })
        .await;
    let elapsed = started.elapsed();

    assert!(
        matches!(result, Err(EngineError::TurnTimeout(1))),
        "got: {result:?}"
    );
    assert!(
        elapsed < Duration::from_secs(3),
        "turn should have aborted ~1s in, took {elapsed:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn abort_unknown_thread_is_zero() {
    let engine = engine_with_sleepy(None);
    let unknown = ThreadId::new("never-existed");
    assert_eq!(engine.abort_thread(&unknown), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn double_abort_is_idempotent() {
    let engine = engine_with_sleepy(None);
    let tenant = TenantId::new("t");
    let project = ProjectId::from_raw("p");
    let thread = ThreadId::new("chat_c");

    let engine_for_turn = engine.clone();
    let t = tenant.clone();
    let p = project.clone();
    let th = thread.clone();
    let turn = tokio::spawn(async move {
        engine_for_turn
            .handle_turn(TurnRequest {
                tenant_id: t,
                project_id: p,
                thread_id: th,
                user_text: "go".into(),
                message_id: None,            })
            .await
    });

    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(engine.abort_thread(&thread), 1);
    // Second abort right after — token still in map (turn hasn't
    // unwound yet) and cancel is idempotent. May report 1 again (the
    // turn is still draining) or 0 once the guard has cleared. We
    // just want "no panic", not a specific count.
    let _ = engine.abort_thread(&thread);

    let _ = tokio::time::timeout(Duration::from_secs(2), turn)
        .await
        .expect("turn returns")
        .expect("turn join");

    // After turn exits, the inflight guard removes the entry —
    // subsequent aborts must report 0.
    assert_eq!(engine.abort_thread(&thread), 0);
}

/// LLM mock that always replies with a `Sleepy` tool_call. Used by
/// the multi-turn concurrent tests: with this in place every turn
/// stays inside the SleepyTool indefinitely (30s sleep), so several
/// turns concurrent on the same engine all sit in the inflight map
/// at once — exactly the state abort_thread / abort_turn need to
/// observe. MockLlmClient's FIFO queue would scramble responses
/// across concurrent callers; this never runs out so order doesn't
/// matter.
struct AlwaysSleepyLlm;

#[async_trait::async_trait]
impl snaca_llm::LlmClient for AlwaysSleepyLlm {
    fn provider_name(&self) -> &'static str {
        "always-sleepy"
    }
    fn model(&self) -> &str {
        "always-sleepy"
    }
    fn capabilities(&self) -> snaca_llm::ProviderCaps {
        snaca_llm::ProviderCaps {
            tool_use: true,
            ..Default::default()
        }
    }
    async fn create_message(
        &self,
        _req: snaca_llm::MessageRequest,
    ) -> snaca_llm::LlmResult<snaca_llm::MessageResponse> {
        use snaca_core::{ContentBlock, Message, MessageId, Role, Usage};
        Ok(snaca_llm::MessageResponse {
            id: "always-sleepy".into(),
            message: Message {
                id: MessageId::new(),
                role: Role::Assistant,
                content: vec![ContentBlock::tool_use(
                    "c-sleepy",
                    "Sleepy",
                    json!({}),
                )],
                created_at: chrono::Utc::now(),
            },
            usage: Usage {
                input_tokens: 1,
                output_tokens: 1,
                ..Default::default()
            },
            stop_reason: snaca_llm::StopReason::ToolUse,
        })
    }
}

fn always_sleepy_engine() -> Arc<Engine> {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = futures::executor::block_on(Database::open_in_memory()).unwrap();
    let tools = ToolRegistryBuilder::default().add(SleepyTool).build();
    let cfg = EngineConfig::default_for("always-sleepy");
    Arc::new(Engine::new(
        Arc::new(AlwaysSleepyLlm),
        tools,
        db,
        layout,
        cfg,
    ))
}

#[tokio::test(flavor = "multi_thread")]
async fn abort_turn_targets_specific_message_id_in_group_chat() {
    // Two concurrent turns on the same thread, simulating two users
    // in a group chat each triggering work simultaneously. Recalling
    // user A's message must abort A's turn and leave B's alone.
    let engine = always_sleepy_engine();
    let tenant = TenantId::new("t");
    let project = ProjectId::from_raw("p");
    let thread = ThreadId::new("group_chat");

    let engine_a = engine.clone();
    let (t_a, p_a, th_a) = (tenant.clone(), project.clone(), thread.clone());
    let turn_a = tokio::spawn(async move {
        engine_a
            .handle_turn(TurnRequest {
                tenant_id: t_a,
                project_id: p_a,
                thread_id: th_a,
                user_text: "A's message".into(),
                message_id: Some("msg-A".into()),
            })
            .await
    });
    let engine_b = engine.clone();
    let (t_b, p_b, th_b) = (tenant.clone(), project.clone(), thread.clone());
    let turn_b = tokio::spawn(async move {
        engine_b
            .handle_turn(TurnRequest {
                tenant_id: t_b,
                project_id: p_b,
                thread_id: th_b,
                user_text: "B's message".into(),
                message_id: Some("msg-B".into()),
            })
            .await
    });

    // Let both turns enter their inflight registration + sleeping
    // tool. 250ms is generous; SleepyTool sleeps 30s.
    tokio::time::sleep(Duration::from_millis(250)).await;

    // Recall A's message — abort_turn should hit exactly that one.
    assert!(engine.abort_turn(&thread, "msg-A"));

    // A returns Aborted; B is still running.
    let a_result = tokio::time::timeout(Duration::from_secs(2), turn_a)
        .await
        .expect("turn A returns")
        .expect("turn A join");
    assert!(matches!(a_result, Err(EngineError::Aborted)), "got A: {a_result:?}");
    assert!(!turn_b.is_finished(), "turn B should still be running");

    // Cleanup: abort B explicitly so the test exits promptly.
    assert!(engine.abort_turn(&thread, "msg-B"));
    let _ = tokio::time::timeout(Duration::from_secs(2), turn_b).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn abort_thread_sweeps_every_inflight_turn() {
    // Admin path: abort_thread should hit every inflight turn on
    // the thread, not just one. Important now that group chats hold
    // multiple per-message turns simultaneously.
    let engine = always_sleepy_engine();
    let tenant = TenantId::new("t");
    let project = ProjectId::from_raw("p");
    let thread = ThreadId::new("group_chat_admin");

    let mut handles = Vec::new();
    for i in 0..3 {
        let engine = engine.clone();
        let (t, p, th) = (tenant.clone(), project.clone(), thread.clone());
        let msg_id = format!("msg-{i}");
        handles.push(tokio::spawn(async move {
            engine
                .handle_turn(TurnRequest {
                    tenant_id: t,
                    project_id: p,
                    thread_id: th,
                    user_text: format!("msg {i}"),
                    message_id: Some(msg_id),
                })
                .await
        }));
    }

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(engine.abort_thread(&thread), 3, "all three should abort");

    for h in handles {
        let r = tokio::time::timeout(Duration::from_secs(2), h)
            .await
            .expect("turn returns")
            .expect("turn join");
        assert!(matches!(r, Err(EngineError::Aborted)), "got: {r:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn abort_turn_returns_false_for_unknown_message_id() {
    let engine = engine_with_sleepy(None);
    let thread = ThreadId::new("chat_z");
    assert!(!engine.abort_turn(&thread, "nope"));
}
