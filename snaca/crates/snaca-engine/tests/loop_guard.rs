//! End-to-end tests for `LoopGuard`. Drives the full `Engine::handle_turn`
//! with a scripted mock LLM that intentionally repeats the same tool call
//! over and over. Verifies the guard trips at the configured limit instead
//! of running until `max_iterations`.

use serde_json::{json, Value};
use snaca_core::{ContentBlock, Message, MessageId, ProjectId, Role, TenantId, ThreadId, Usage};
use snaca_engine::{Engine, EngineConfig, EngineError, TurnRequest};
use snaca_llm::{MessageResponse, StopReason};
use snaca_state::Database;
use snaca_tools_api::ToolRegistryBuilder;
use snaca_workspace::WorkspaceLayout;
use std::sync::Arc;

mod common;
use async_trait::async_trait;
use common::{EchoTool, MockLlmClient};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};

fn assistant_tool_call_with_input(id: &str, name: &str, input: Value) -> MessageResponse {
    MessageResponse {
        id: "mock".into(),
        message: Message {
            id: MessageId::new(),
            role: Role::Assistant,
            content: vec![ContentBlock::tool_use(id, name, input)],
            created_at: chrono::Utc::now(),
        },
        usage: Usage {
            input_tokens: 1,
            output_tokens: 1,
            ..Default::default()
        },
        stop_reason: StopReason::ToolUse,
    }
}

struct Fixture {
    engine: Engine,
    llm: Arc<MockLlmClient>,
    _tmp: tempfile::TempDir,
}

struct FailingTool;

#[async_trait]
impl Tool for FailingTool {
    fn name(&self) -> &str {
        "Failing"
    }

    fn description(&self) -> &str {
        "Always fails with the provided text."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::default()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    async fn execute(&self, input: Value, _ctx: &ToolContext) -> ToolResult {
        let text = input
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("missing");
        Err(ToolError::Execution(format!("script failed: {text}")))
    }
}

struct FlakyTool {
    seen: std::sync::atomic::AtomicUsize,
}

impl FlakyTool {
    fn new() -> Self {
        Self {
            seen: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl Tool for FlakyTool {
    fn name(&self) -> &str {
        "Flaky"
    }

    fn description(&self) -> &str {
        "Fails once, then succeeds."
    }

    fn input_schema(&self) -> Value {
        json!({"type": "object", "properties": {"text": {"type": "string"}}})
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::default()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    async fn execute(&self, _input: Value, _ctx: &ToolContext) -> ToolResult {
        let n = self.seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if n == 0 {
            Err(ToolError::Execution("temporary failure".into()))
        } else {
            Ok(ToolOutput::text("recovered"))
        }
    }
}

async fn fixture(loop_guard_limit: Option<usize>) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = ToolRegistryBuilder::default().add(EchoTool).build();
    let llm = Arc::new(MockLlmClient::new());
    let mut cfg = EngineConfig::default_for("mock-model");
    cfg.loop_guard_max_repeats = loop_guard_limit;
    cfg.max_iterations = 100; // make sure max_iterations isn't what trips
    let engine = Engine::new(llm.clone(), tools, db, workspace, cfg);
    Fixture {
        engine,
        llm,
        _tmp: tmp,
    }
}

async fn fixture_with_tools(
    loop_guard_limit: Option<usize>,
    tools: snaca_tools_api::ToolRegistry,
) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let llm = Arc::new(MockLlmClient::new());
    let mut cfg = EngineConfig::default_for("mock-model");
    cfg.loop_guard_max_repeats = loop_guard_limit;
    cfg.max_iterations = 100;
    let engine = Engine::new(llm.clone(), tools, db, workspace, cfg);
    Fixture {
        engine,
        llm,
        _tmp: tmp,
    }
}

fn turn_request() -> TurnRequest {
    TurnRequest {
        tenant_id: TenantId::new("tenant_a"),
        project_id: ProjectId::from_raw("proj_x"),
        thread_id: ThreadId::new("thr-loop-1"),
        user_text: "go".into(),
        message_id: None,
    }
    ephemeral_system: None,
}

#[tokio::test]
async fn identical_tool_calls_trip_loop_guard_at_threshold() {
    let fix = fixture(Some(3)).await;
    // Queue four identical Echo calls. The guard should trip on the
    // third (limit=3); the fourth never fires.
    for _ in 0..4 {
        fix.llm.enqueue(assistant_tool_call_with_input(
            "tu1",
            "Echo",
            json!({"text": "stuck"}),
        ));
    }

    let err = fix
        .engine
        .handle_turn(turn_request())
        .await
        .expect_err("loop guard should trip");
    match err {
        EngineError::LoopGuardTripped { tool, count } => {
            assert_eq!(tool, "Echo");
            assert_eq!(count, 3);
        }
        other => panic!("expected LoopGuardTripped, got {other:?}"),
    }
}

#[tokio::test]
async fn varying_inputs_do_not_trip_loop_guard() {
    let fix = fixture(Some(3)).await;
    // Three Echo calls with *different* arguments — no trip — followed
    // by a terminal text response.
    for i in 0..3 {
        fix.llm.enqueue(assistant_tool_call_with_input(
            &format!("tu_{i}"),
            "Echo",
            json!({"text": format!("value-{i}")}),
        ));
    }
    fix.llm.enqueue(common::assistant_text("done"));

    let outcome = fix.engine.handle_turn(turn_request()).await.unwrap();
    assert_eq!(outcome.assistant_text, "done");
    assert_eq!(outcome.iterations, 4);
}

#[tokio::test]
async fn loop_guard_disabled_via_none_config() {
    let fix = fixture(None).await;
    // 5 identical calls, then a terminal — no guard, completes normally.
    for _ in 0..5 {
        fix.llm.enqueue(assistant_tool_call_with_input(
            "tu1",
            "Echo",
            json!({"text": "same"}),
        ));
    }
    fix.llm.enqueue(common::assistant_text("done"));

    let outcome = fix.engine.handle_turn(turn_request()).await.unwrap();
    assert_eq!(outcome.iterations, 6);
}

#[tokio::test]
async fn repeated_tool_failure_injects_diagnostic_feedback_and_continues() {
    let tools = ToolRegistryBuilder::default().add(FailingTool).build();
    let fix = fixture_with_tools(Some(3), tools).await;

    for i in 0..2 {
        fix.llm.enqueue(assistant_tool_call_with_input(
            &format!("tu_fail_{i}"),
            "Failing",
            json!({"text": "same"}),
        ));
    }
    fix.llm.enqueue(common::assistant_text("changed approach"));

    let outcome = fix.engine.handle_turn(turn_request()).await.unwrap();
    assert_eq!(outcome.assistant_text, "changed approach");
    assert_eq!(outcome.iterations, 3);

    let observed = fix.llm.observed_requests();
    let third = observed.last().expect("third LLM request");
    let feedback = third
        .messages
        .iter()
        .rev()
        .find(|m| m.role == Role::User)
        .map(|m| ContentBlock::collect_text(&m.content))
        .unwrap_or_default();
    assert!(feedback.contains("identical tool call failed 2 times"));
    assert!(feedback.contains("Tool: `Failing`"));
    assert!(feedback.contains("\"text\":\"same\""));
    assert!(feedback.contains("script failed: same"));
    assert!(feedback.contains("Do not run this exact same `Failing` call again"));
    assert!(feedback.contains("change the approach"));
}

#[tokio::test]
async fn different_failed_inputs_do_not_inject_repeated_failure_feedback() {
    let tools = ToolRegistryBuilder::default().add(FailingTool).build();
    let fix = fixture_with_tools(Some(3), tools).await;

    fix.llm.enqueue(assistant_tool_call_with_input(
        "tu_fail_a",
        "Failing",
        json!({"text": "a"}),
    ));
    fix.llm.enqueue(assistant_tool_call_with_input(
        "tu_fail_b",
        "Failing",
        json!({"text": "b"}),
    ));
    fix.llm.enqueue(common::assistant_text("done"));

    let outcome = fix.engine.handle_turn(turn_request()).await.unwrap();
    assert_eq!(outcome.assistant_text, "done");

    let observed = fix.llm.observed_requests();
    let third = observed.last().expect("third LLM request");
    let combined_user_text = third
        .messages
        .iter()
        .filter(|m| m.role == Role::User)
        .map(|m| ContentBlock::collect_text(&m.content))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!combined_user_text.contains("identical tool call failed"));
}

#[tokio::test]
async fn reordered_object_keys_still_count_as_repeated_failure() {
    let tools = ToolRegistryBuilder::default().add(FailingTool).build();
    let fix = fixture_with_tools(Some(3), tools).await;

    fix.llm.enqueue(assistant_tool_call_with_input(
        "tu_fail_a",
        "Failing",
        json!({"text": "same", "extra": 1}),
    ));
    fix.llm.enqueue(assistant_tool_call_with_input(
        "tu_fail_b",
        "Failing",
        json!({"extra": 1, "text": "same"}),
    ));
    fix.llm.enqueue(common::assistant_text("done"));

    let outcome = fix.engine.handle_turn(turn_request()).await.unwrap();
    assert_eq!(outcome.assistant_text, "done");

    let observed = fix.llm.observed_requests();
    let third = observed.last().expect("third LLM request");
    let combined_user_text = third
        .messages
        .iter()
        .filter(|m| m.role == Role::User)
        .map(|m| ContentBlock::collect_text(&m.content))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(combined_user_text.contains("identical tool call failed 2 times"));
}

#[tokio::test]
async fn failure_then_success_does_not_inject_repeated_failure_feedback() {
    let tools = ToolRegistryBuilder::default().add(FlakyTool::new()).build();
    let fix = fixture_with_tools(Some(3), tools).await;

    for i in 0..2 {
        fix.llm.enqueue(assistant_tool_call_with_input(
            &format!("tu_flaky_{i}"),
            "Flaky",
            json!({"text": "same"}),
        ));
    }
    fix.llm.enqueue(common::assistant_text("done"));

    let outcome = fix.engine.handle_turn(turn_request()).await.unwrap();
    assert_eq!(outcome.assistant_text, "done");

    let observed = fix.llm.observed_requests();
    let third = observed.last().expect("third LLM request");
    let combined_user_text = third
        .messages
        .iter()
        .filter(|m| m.role == Role::User)
        .map(|m| ContentBlock::collect_text(&m.content))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!combined_user_text.contains("identical tool call failed"));
}

#[tokio::test]
async fn loop_guard_trip_seeds_next_turn_system_prompt_with_hint() {
    // Two-turn run. Turn 1 trips the guard on `Echo` with input
    // `{"text":"stuck"}`. Turn 2 sends a benign reply; we assert that
    // *the request issued during turn 2* carries a system segment
    // mentioning the tool name + count, so the model sees the hint.
    let fix = fixture(Some(2)).await;

    // Turn 1: queue two identical calls. Guard limit is 2 → trips on
    // the second.
    for _ in 0..2 {
        fix.llm.enqueue(assistant_tool_call_with_input(
            "tu_loop",
            "Echo",
            json!({"text": "stuck"}),
        ));
    }
    let err = fix
        .engine
        .handle_turn(turn_request())
        .await
        .expect_err("turn 1 should trip");
    assert!(matches!(err, EngineError::LoopGuardTripped { .. }));

    // Turn 2: same thread. Queue a single terminal reply.
    fix.llm.enqueue(common::assistant_text("ok"));
    let mut req2 = turn_request();
    req2.user_text = "你又怎么了？".into();
    let outcome = fix.engine.handle_turn(req2).await.unwrap();
    assert_eq!(outcome.assistant_text, "ok");

    // Now inspect the last request observed by the mock — the system
    // segments must include the loop-guard hint.
    let observed = fix.llm.observed_requests();
    let last = observed.last().expect("turn 2 issued a request");
    let mut found_hint = false;
    for seg in &last.system_segments {
        if seg.text.contains("Previous turn aborted: loop guard")
            && seg.text.contains("Echo")
            && seg.text.contains("stuck")
        {
            found_hint = true;
            break;
        }
    }
    assert!(
        found_hint,
        "turn 2 system prompt must carry the loop_guard hint; got segments: {:?}",
        last.system_segments
            .iter()
            .map(|s| &s.text)
            .collect::<Vec<_>>()
    );

    // And the hint is one-shot: a third turn must not carry it again.
    fix.llm.enqueue(common::assistant_text("done"));
    let mut req3 = turn_request();
    req3.user_text = "继续".into();
    fix.engine.handle_turn(req3).await.unwrap();
    let observed = fix.llm.observed_requests();
    let third = observed.last().unwrap();
    for seg in &third.system_segments {
        assert!(
            !seg.text.contains("Previous turn aborted: loop guard"),
            "turn 3 must not re-inject the hint; segment: {}",
            seg.text
        );
    }
}
