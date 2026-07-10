//! Engine integration test: written memory entries surface in the LLM
//! request's `system` field on the next turn.
//!
//! We drive the engine with `MockLlmClient` (which records every
//! request in order) and `MemoryWriteTool`; first turn writes a memory
//! entry, second turn checks the request body.

use async_trait::async_trait;
use serde_json::json;
use snaca_agent_api::{
    MemoryEntryData, MemoryIndexRequest, MemoryListRequest, MemoryProvider, MemoryProviderError,
    MemoryReadRequest, MemoryWriteRequest,
};
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

struct StaticMemoryProvider;

#[async_trait]
impl MemoryProvider for StaticMemoryProvider {
    async fn index(&self, _request: MemoryIndexRequest) -> Result<String, MemoryProviderError> {
        Ok("# Custom Index\n- user/provider-pref".into())
    }

    async fn list(&self, _request: MemoryListRequest) -> Result<Vec<String>, MemoryProviderError> {
        Ok(vec!["provider-pref".into()])
    }

    async fn write(
        &self,
        request: MemoryWriteRequest,
    ) -> Result<MemoryEntryData, MemoryProviderError> {
        Ok(MemoryEntryData {
            scope: request.scope,
            name: request.name,
            content: request.content,
        })
    }

    async fn read(
        &self,
        request: MemoryReadRequest,
    ) -> Result<MemoryEntryData, MemoryProviderError> {
        Ok(MemoryEntryData {
            scope: request.scope,
            name: request.name,
            content: "provider body".into(),
        })
    }
}

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
    }
    ephemeral_system: None,
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
async fn frozen_snapshot_keeps_in_session_writes_out_of_prompt() {
    // The frozen-snapshot model: a `MemoryWrite` mid-thread lands on
    // disk but the in-prompt copy stays byte-stable for the lifetime
    // of the thread session. The model only sees the new entry on
    // the next thread (or after `invalidate_memory_snapshot`).
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

    // Turn 2 on the same thread: we expect the snapshot to be empty
    // (no preamble), since the snapshot was frozen before the write.
    fix.llm.enqueue(assistant_text("ok"));
    fix.engine
        .handle_turn(turn_request("any follow-up"))
        .await
        .unwrap();

    let reqs = observed(fix.llm.as_ref());
    let turn2_first = &reqs[2];
    let sys = turn2_first.flat_system().unwrap_or_default();
    assert!(
        !sys.contains("## Project Memory"),
        "frozen snapshot should not have surfaced the in-session write yet; got: {sys}"
    );

    // After invalidating the cache (the future `on_session_switch`
    // hook will fire this; we call it by hand here to simulate a
    // fresh session), the next turn picks up the new entry.
    fix.engine
        .invalidate_memory_snapshot(&snaca_core::ThreadId::new("thr-mem-1"));
    fix.llm.enqueue(assistant_text("ok"));
    fix.engine
        .handle_turn(turn_request("after reset"))
        .await
        .unwrap();
    let reqs = observed(fix.llm.as_ref());
    let turn3 = &reqs[3];
    let sys = turn3.flat_system().unwrap_or_default();
    assert!(
        sys.contains("## Project Memory"),
        "post-invalidation snapshot should include the entry; got: {sys}"
    );
    assert!(
        sys.contains("user/tone-preference"),
        "snapshot should list the new entry; got: {sys}"
    );
    assert!(
        sys.contains("SNACA"),
        "base system prompt should still be present; got: {sys}"
    );
}

#[tokio::test]
async fn injected_memory_provider_feeds_system_prompt_index() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = ToolRegistryBuilder::default().add(MemoryWriteTool).build();
    let llm = Arc::new(MockLlmClient::new());
    let cfg = EngineConfig::default_for("mock-model");
    let engine = Engine::new(llm.clone(), tools, db, workspace, cfg)
        .with_memory_provider(Arc::new(StaticMemoryProvider));

    llm.enqueue(assistant_text("ok"));
    engine
        .handle_turn(TurnRequest {
            tenant_id: TenantId::new("tenant_a"),
            project_id: ProjectId::from_raw("proj_provider"),
            thread_id: ThreadId::new("thr-provider"),
            user_text: "provider query".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();

    let sys = observed(llm.as_ref())[0].flat_system().unwrap_or_default();
    assert!(sys.contains("## Project Memory"));
    assert!(sys.contains("user/provider-pref"));
    // Vector recall is gone; provider's `index` is the only memory hook
    // into the system prompt now. No `## Relevant Memories` section.
    assert!(!sys.contains("## Relevant Memories"));
}
