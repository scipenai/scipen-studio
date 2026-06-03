//! Engine integration test: written memory entries surface in the LLM
//! request's `system` field on the next turn.
//!
//! We drive the engine with `MockLlmClient` (which records every
//! request in order) and `MemoryWriteTool`; first turn writes a memory
//! entry, second turn checks the request body.

use serde_json::json;
use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_engine::{Engine, EngineConfig, TurnRequest};
use snaca_llm::MessageRequest;
use snaca_state::Database;
use snaca_tools::{MemoryWriteTool, ReadTool};
use snaca_tools_api::ToolRegistryBuilder;
use snaca_workspace::WorkspaceLayout;
use std::sync::Arc;

mod common;
use common::{assistant_text, assistant_tool_call, MockLlmClient};

struct Fixture {
    engine: Engine,
    llm: Arc<MockLlmClient>,
    _tmp: tempfile::TempDir,
}

async fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    // Real MemoryWriteTool; ReadTool also registered just to keep the
    // schema realistic but isn't called in this test.
    let tools = ToolRegistryBuilder::default()
        .add(MemoryWriteTool)
        .add(ReadTool)
        .build();
    let llm = Arc::new(MockLlmClient::new());
    let cfg = EngineConfig::default_for("mock-model");
    let engine = Engine::new(llm.clone(), tools, db, workspace, cfg);
    Fixture {
        engine,
        llm,
        _tmp: tmp,
    }
}

fn turn_request(text: &str) -> TurnRequest {
    TurnRequest {
        tenant_id: TenantId::new("tenant_a"),
        project_id: ProjectId::from_raw("proj_x"),
        thread_id: ThreadId::new("thr-mem-1"),
        user_text: text.into(),
        message_id: None,
        ephemeral_system: None,
    }
}

/// Pull every observed `MessageRequest` off the mock. Provided as a
/// helper because it owns the mutex's lock.
fn observed(llm: &MockLlmClient) -> Vec<MessageRequest> {
    llm.observed_requests()
}

#[tokio::test]
async fn fresh_project_has_no_memory_preamble_in_system_prompt() {
    let fix = fixture().await;
    fix.llm.enqueue(assistant_text("hi"));

    fix.engine.handle_turn(turn_request("hello")).await.unwrap();

    let req = &observed(fix.llm.as_ref())[0];
    let sys = req.flat_system().unwrap_or_default();
    assert!(
        !sys.contains("## Project Memory"),
        "fresh project should have no memory preamble; got: {sys}"
    );
}

#[tokio::test]
async fn written_memory_appears_in_next_turn_system_prompt() {
    let fix = fixture().await;

    // Turn 1: model invokes MemoryWrite, then a terminal text response.
    fix.llm.enqueue(assistant_tool_call(vec![(
        "tu1",
        "MemoryWrite",
        json!({
            "scope": "user",
            "name": "tone-preference",
            "content": "user prefers terse bullet-point answers"
        }),
    )]));
    fix.llm.enqueue(assistant_text("noted"));

    fix.engine
        .handle_turn(turn_request("remember: I like terse answers"))
        .await
        .unwrap();

    // Turn 2: any user message — we just need to inspect what the
    // engine's system prompt looks like *now* that memory exists.
    fix.llm.enqueue(assistant_text("ok"));
    fix.engine
        .handle_turn(turn_request("any follow-up"))
        .await
        .unwrap();

    let reqs = observed(fix.llm.as_ref());
    // Turn 1 had two LLM calls (tool_use + terminal); turn 2 had one.
    let turn2_first = &reqs[2];
    let sys = turn2_first.flat_system().unwrap_or_default();
    assert!(
        sys.contains("## Project Memory"),
        "expected memory preamble in turn-2 system prompt; got: {sys}"
    );
    assert!(
        sys.contains("user/tone-preference"),
        "memory index should list the new entry; got: {sys}"
    );
    // The base prompt is still in front — splice, don't replace.
    assert!(
        sys.contains("SNACA"),
        "base system prompt should still be present; got: {sys}"
    );
}

#[tokio::test]
async fn ephemeral_system_is_appended_to_system_prompt() {
    let fix = fixture().await;
    fix.llm.enqueue(assistant_text("ok"));

    let req = TurnRequest {
        tenant_id: TenantId::new("tenant_a"),
        project_id: ProjectId::from_raw("proj_x"),
        thread_id: ThreadId::new("thr-eph-1"),
        user_text: "what file am I in?".into(),
        message_id: None,
        ephemeral_system: Some("<context>\n  <active_file path=\"intro.tex\"/>\n</context>".into()),
    };
    fix.engine.handle_turn(req).await.unwrap();

    let sys = observed(fix.llm.as_ref())[0]
        .flat_system()
        .unwrap_or_default();
    assert!(
        sys.contains("intro.tex"),
        "ephemeral context should ride the system prompt; got: {sys}"
    );
    // Spliced onto the base, not replacing it.
    assert!(sys.contains("SNACA"), "base prompt must remain; got: {sys}");
}

#[tokio::test]
async fn empty_ephemeral_system_leaves_prompt_unchanged() {
    let fix = fixture().await;
    fix.llm.enqueue(assistant_text("ok"));
    // None ephemeral → system prompt is exactly the composed base.
    fix.engine.handle_turn(turn_request("hi")).await.unwrap();

    let sys = observed(fix.llm.as_ref())[0]
        .flat_system()
        .unwrap_or_default();
    assert!(
        !sys.contains("<context>"),
        "no context block expected; got: {sys}"
    );
}
