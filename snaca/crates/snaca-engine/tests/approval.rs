//! Engine approval-flow integration tests.
//!
//! Each test scripts the LLM to call a tool with non-trivial
//! `ApprovalRequirement`, runs the turn through `handle_turn_with_gate`,
//! and asserts:
//! - the tool ran (or didn't) as expected,
//! - the gate was consulted (or skipped) per remembered-decision rules,
//! - persisted decisions land in the DB only when the user said
//!   `AllowAlways`.

use async_trait::async_trait;
use serde_json::{json, Value};
use snaca_core::{ProjectId, Role, TenantId, ThreadId};
use snaca_engine::{
    ApprovalDecision, ApprovalError, ApprovalGate, ApprovalRequest, CountingGate,
    DenyAllApprovalGate, Engine, EngineConfig, NoopApprovalGate, TurnRequest,
};
use snaca_state::{Database, PersistedDecision};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolOutput, ToolRegistry,
    ToolRegistryBuilder, ToolResult,
};
use snaca_workspace::WorkspaceLayout;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

mod common;
use common::{assistant_text, assistant_tool_call, MockLlmClient};

/// Tool with a configurable `ApprovalRequirement` that records every call.
/// Returns a deterministic text so tests can assert it ran.
struct MarkerTool {
    requirement: ApprovalRequirement,
    invocations: Arc<AtomicUsize>,
}

impl MarkerTool {
    fn new(requirement: ApprovalRequirement) -> (Self, Arc<AtomicUsize>) {
        let counter = Arc::new(AtomicUsize::new(0));
        (
            MarkerTool {
                requirement,
                invocations: counter.clone(),
            },
            counter,
        )
    }
}

#[async_trait]
impl Tool for MarkerTool {
    fn name(&self) -> &str {
        "Marker"
    }
    fn description(&self) -> &str {
        "Records that it was called."
    }
    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }
    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::writes_filesystem()
    }
    fn approval_requirement(&self) -> ApprovalRequirement {
        self.requirement
    }
    async fn execute(&self, _input: Value, _ctx: &ToolContext) -> ToolResult {
        self.invocations.fetch_add(1, Ordering::Relaxed);
        Ok(ToolOutput::text("ran"))
    }
}

fn registry_with(tool: MarkerTool) -> ToolRegistry {
    ToolRegistryBuilder::default().add(tool).build()
}

async fn fixture(
    tool: MarkerTool,
) -> (Engine, Database, Arc<MockLlmClient>, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let llm = Arc::new(MockLlmClient::new());
    let engine = Engine::new(
        llm.clone(),
        registry_with(tool),
        db.clone(),
        layout,
        EngineConfig::default_for("mock-model"),
    );
    (engine, db, llm, tmp)
}

fn turn_request() -> TurnRequest {
    TurnRequest {
        tenant_id: TenantId::new("t"),
        project_id: ProjectId::from_raw("p"),
        thread_id: ThreadId::new("chat_appr"),
        user_text: "do it".into(),
        message_id: None,    }
}

#[tokio::test]
async fn never_required_skips_gate_entirely() {
    let (tool, calls) = MarkerTool::new(ApprovalRequirement::Never);
    let (engine, _db, llm, _tmp) = fixture(tool).await;

    llm.enqueue(assistant_tool_call(vec![("c1", "Marker", json!({}))]));
    llm.enqueue(assistant_text("ok"));

    let gate = Arc::new(CountingGate::new(ApprovalDecision::Deny));
    engine
        .handle_turn_with_gate(turn_request(), gate.clone())
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    // Gate must not be consulted — Never short-circuits the check.
    assert_eq!(gate.calls(), 0);
}

#[tokio::test]
async fn deny_keeps_tool_unrun_and_returns_tool_error() {
    let (tool, calls) = MarkerTool::new(ApprovalRequirement::Always);
    let (engine, db, llm, _tmp) = fixture(tool).await;

    llm.enqueue(assistant_tool_call(vec![("c1", "Marker", json!({}))]));
    llm.enqueue(assistant_text("recovered"));

    engine
        .handle_turn_with_gate(turn_request(), Arc::new(DenyAllApprovalGate))
        .await
        .unwrap();
    assert_eq!(
        calls.load(Ordering::Relaxed),
        0,
        "tool must not run when gate denies"
    );

    let msgs = db
        .recent_messages(&ThreadId::new("chat_appr"), 10)
        .await
        .unwrap();
    let tool_msg = msgs.iter().find(|m| matches!(m.role, Role::Tool)).unwrap();
    let (_id, text, is_error) =
        common::first_tool_result(&tool_msg.content).expect("tool result block");
    assert!(is_error);
    assert!(text.contains("denied"), "got: {text}");
}

#[tokio::test]
async fn allow_always_persists_decision_and_skips_gate_next_time() {
    let (tool, calls) = MarkerTool::new(ApprovalRequirement::UnlessRemembered);
    let (engine, db, llm, _tmp) = fixture(tool).await;

    // Two turns, two tool calls.
    llm.enqueue(assistant_tool_call(vec![("c1", "Marker", json!({}))]));
    llm.enqueue(assistant_text("first done"));
    llm.enqueue(assistant_tool_call(vec![("c2", "Marker", json!({}))]));
    llm.enqueue(assistant_text("second done"));

    let gate = Arc::new(CountingGate::new(ApprovalDecision::AllowAlways));
    engine
        .handle_turn_with_gate(turn_request(), gate.clone())
        .await
        .unwrap();
    engine
        .handle_turn_with_gate(turn_request(), gate.clone())
        .await
        .unwrap();

    assert_eq!(calls.load(Ordering::Relaxed), 2, "tool ran both times");
    assert_eq!(
        gate.calls(),
        1,
        "gate consulted only on first turn; second turn used the remembered decision"
    );

    // M5 persists by per-input signature, not by tool name alone.
    // The tool call's input was `{}` — compute the matching signature
    // so the lookup hits exactly.
    let sig = snaca_engine::engine::input_signature(&json!({}));
    let stored = db
        .find_decision(&TenantId::new("t"), &ProjectId::from_raw("p"), "Marker", &sig)
        .await
        .unwrap()
        .expect("decision persisted");
    assert_eq!(stored.decision, PersistedDecision::Allow);
    assert_eq!(stored.input_signature, sig);
}

#[tokio::test]
async fn allow_once_does_not_persist() {
    let (tool, calls) = MarkerTool::new(ApprovalRequirement::UnlessRemembered);
    let (engine, db, llm, _tmp) = fixture(tool).await;

    llm.enqueue(assistant_tool_call(vec![("c1", "Marker", json!({}))]));
    llm.enqueue(assistant_text("first"));
    llm.enqueue(assistant_tool_call(vec![("c2", "Marker", json!({}))]));
    llm.enqueue(assistant_text("second"));

    let gate = Arc::new(CountingGate::new(ApprovalDecision::AllowOnce));
    engine
        .handle_turn_with_gate(turn_request(), gate.clone())
        .await
        .unwrap();
    engine
        .handle_turn_with_gate(turn_request(), gate.clone())
        .await
        .unwrap();

    assert_eq!(calls.load(Ordering::Relaxed), 2);
    assert_eq!(
        gate.calls(),
        2,
        "AllowOnce must not be remembered; gate consulted both turns"
    );
    let sig = snaca_engine::engine::input_signature(&json!({}));
    assert!(db
        .find_decision(&TenantId::new("t"), &ProjectId::from_raw("p"), "Marker", &sig)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn remembered_deny_short_circuits_to_tool_error() {
    let (tool, calls) = MarkerTool::new(ApprovalRequirement::UnlessRemembered);
    let (engine, db, llm, _tmp) = fixture(tool).await;

    // Catch-all DENY: an operator-style rule that vetoes every
    // input. Engine's lookup falls back to the empty-signature row
    // when no exact match exists, so this short-circuits the gate
    // regardless of what the model sends.
    db.remember_decision(
        &TenantId::new("t"),
        &ProjectId::from_raw("p"),
        "Marker",
        "",
        PersistedDecision::Deny,
    )
    .await
    .unwrap();

    llm.enqueue(assistant_tool_call(vec![("c1", "Marker", json!({}))]));
    llm.enqueue(assistant_text("recovered"));

    let gate = Arc::new(CountingGate::new(ApprovalDecision::AllowAlways));
    engine
        .handle_turn_with_gate(turn_request(), gate.clone())
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    assert_eq!(gate.calls(), 0, "remembered deny must not consult the gate");

    let msgs = db
        .recent_messages(&ThreadId::new("chat_appr"), 10)
        .await
        .unwrap();
    let tool_msg = msgs.iter().find(|m| matches!(m.role, Role::Tool)).unwrap();
    let (_id, _text, is_error) =
        common::first_tool_result(&tool_msg.content).expect("tool result block");
    assert!(is_error);
}

/// M5: `AllowAlways` is keyed by `(tool, input_signature)`, not just
/// tool name. Approving `Marker {"cmd": "ls"}` does *not* auto-approve
/// `Marker {"cmd": "rm -rf"}` on the next turn — the gate must be
/// consulted again. This is the safety property the per-input
/// signature exists to enforce.
#[tokio::test]
async fn allow_always_for_one_input_does_not_carry_to_another() {
    let (tool, calls) = MarkerTool::new(ApprovalRequirement::UnlessRemembered);
    let (engine, _db, llm, _tmp) = fixture(tool).await;

    // Turn 1: input A → AllowAlways. Persisted with signature(A).
    llm.enqueue(assistant_tool_call(vec![(
        "c1",
        "Marker",
        json!({"cmd": "ls"}),
    )]));
    llm.enqueue(assistant_text("ls done"));
    // Turn 2: input B (different) → gate must still be consulted.
    llm.enqueue(assistant_tool_call(vec![(
        "c2",
        "Marker",
        json!({"cmd": "rm -rf /"}),
    )]));
    llm.enqueue(assistant_text("blocked or not, model recovers"));
    // Turn 3: input A again → remembered → no gate call.
    llm.enqueue(assistant_tool_call(vec![(
        "c3",
        "Marker",
        json!({"cmd": "ls"}),
    )]));
    llm.enqueue(assistant_text("ls done 2"));

    let gate = Arc::new(CountingGate::new(ApprovalDecision::AllowAlways));
    engine
        .handle_turn_with_gate(turn_request(), gate.clone())
        .await
        .unwrap();
    engine
        .handle_turn_with_gate(turn_request(), gate.clone())
        .await
        .unwrap();
    engine
        .handle_turn_with_gate(turn_request(), gate.clone())
        .await
        .unwrap();

    assert_eq!(calls.load(Ordering::Relaxed), 3, "all 3 tool calls ran");
    // Gate consulted on turn 1 (input A: new) + turn 2 (input B: new).
    // Turn 3 reuses input A → remembered, no gate call.
    assert_eq!(
        gate.calls(),
        2,
        "gate must be consulted again for each new input signature"
    );
}

#[tokio::test]
async fn handle_turn_default_uses_noop_gate() {
    let (tool, calls) = MarkerTool::new(ApprovalRequirement::UnlessRemembered);
    let (engine, _db, llm, _tmp) = fixture(tool).await;
    llm.enqueue(assistant_tool_call(vec![("c1", "Marker", json!({}))]));
    llm.enqueue(assistant_text("ok"));
    engine.handle_turn(turn_request()).await.unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

/// Custom gate that always errors out with `ApprovalError::Cancelled` —
/// asserts the engine fails the whole turn rather than swallowing the
/// failure as a tool error.
struct AlwaysCancelGate;
#[async_trait]
impl ApprovalGate for AlwaysCancelGate {
    async fn request(&self, _request: ApprovalRequest) -> Result<ApprovalDecision, ApprovalError> {
        Err(ApprovalError::Cancelled)
    }
}

#[tokio::test]
async fn gate_failure_surfaces_as_tool_error_and_continues() {
    // New contract: gate IO failures (timeout, cancel, plugin
    // disconnected, ...) no longer abort the turn. They turn into a
    // `tool_error` block so providers like DeepSeek don't reject the
    // history with "tool_calls without tool messages". The engine
    // keeps running; the LLM sees the failure context and either
    // re-plans or terminates.
    let (tool, calls) = MarkerTool::new(ApprovalRequirement::Always);
    let (engine, _db, llm, _tmp) = fixture(tool).await;
    llm.enqueue(assistant_tool_call(vec![("c1", "Marker", json!({}))]));
    llm.enqueue(assistant_text("re-planned after gate failure"));

    let outcome = engine
        .handle_turn_with_gate(turn_request(), Arc::new(AlwaysCancelGate))
        .await
        .expect("turn must complete with gate failure → tool_error fallback");
    assert_eq!(outcome.assistant_text, "re-planned after gate failure");
    // Tool body was never invoked — the gate failure short-circuited it.
    assert_eq!(calls.load(Ordering::Relaxed), 0);

    // Sanity: NoopApprovalGate exists and is exported.
    let _ = Arc::new(NoopApprovalGate);
}
