//! End-to-end test: a real `LlmMemoryExtractor` driven by `MockLlmClient`
//! produces proposals from a turn's transcript, the engine's post-turn
//! hook wraps them in `FilteredMemoryExtractor` to drop PII, and the
//! survivors land on disk via `MemoryStore`.
//!
//! We share *one* `MockLlmClient` between the engine's main turn and
//! the extractor's call. The mock is FIFO, so we enqueue:
//! 1. assistant-text terminal response (turn body)
//! 2. extraction JSON output (extractor call)
//!
//! The fact that the same mock serves both proves the engine's
//! `with_memory_extractor(LlmMemoryExtractor::new(llm.clone(), ...))`
//! actually fires.

use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_engine::{Engine, EngineConfig, TurnRequest};
use snaca_engine::{FilteredMemoryExtractor, LlmMemoryExtractor, SensitiveFilter};
use snaca_memory::{MemoryScope, MemoryStore};
use snaca_state::Database;
use snaca_tools_api::ToolRegistryBuilder;
use snaca_workspace::WorkspaceLayout;
use std::sync::Arc;
use std::time::Duration;

mod common;
use common::{assistant_text, MockLlmClient};

async fn wait_for<F>(deadline: Duration, mut check: F) -> bool
where
    F: FnMut() -> bool,
{
    let start = std::time::Instant::now();
    while start.elapsed() < deadline {
        if check() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    check()
}

#[tokio::test]
async fn llm_extractor_writes_proposed_memory_to_store() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let llm = Arc::new(MockLlmClient::new());

    // 1) Turn-body response.
    llm.enqueue(assistant_text("understood"));
    // 2) Extractor LLM call — JSON array of proposals.
    llm.enqueue(assistant_text(
        r#"[{"scope":"feedback","name":"no-emojis","content":"user said: stop using emojis"}]"#,
    ));

    let extractor = Arc::new(LlmMemoryExtractor::new(
        llm.clone(),
        "mock-model".to_string(),
    ));
    let engine = Engine::new(
        llm.clone(),
        ToolRegistryBuilder::default().build(),
        db,
        layout.clone(),
        EngineConfig::default_for("mock-model"),
    )
    .with_memory_extractor(extractor);

    let tenant = TenantId::new("t");
    let project = ProjectId::from_raw("p");
    engine
        .handle_turn(TurnRequest {
            tenant_id: tenant.clone(),
            project_id: project.clone(),
            thread_id: ThreadId::new("thr-llm-extract"),
            user_text: "stop using emojis please".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();

    let store = MemoryStore::new(layout.memory_dir(&tenant, &project));
    let landed = wait_for(
        Duration::from_secs(2),
        || match futures::executor::block_on(store.list(MemoryScope::Feedback)) {
            Ok(n) => n.iter().any(|x| x == "no-emojis"),
            Err(_) => false,
        },
    )
    .await;
    assert!(landed, "extractor should have written feedback/no-emojis");

    // The extractor used the same mock as the turn body, so we should
    // see at least 2 LLM calls.
    assert!(
        llm.observed_request_count() >= 2,
        "expected turn + extractor calls; got {}",
        llm.observed_request_count()
    );
}

#[tokio::test]
async fn pii_filter_blocks_extractor_proposals() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let llm = Arc::new(MockLlmClient::new());

    // Turn body.
    llm.enqueue(assistant_text("ack"));
    // Extractor returns one PII-laden + one clean proposal.
    llm.enqueue(assistant_text(
        r#"[
            {"scope":"user","name":"contact","content":"user's email is alice@example.com"},
            {"scope":"user","name":"tone","content":"user prefers terse answers"}
        ]"#,
    ));

    let raw_extractor: Arc<dyn snaca_engine::MemoryExtractor> = Arc::new(LlmMemoryExtractor::new(
        llm.clone(),
        "mock-model".to_string(),
    ));
    let extractor: Arc<dyn snaca_engine::MemoryExtractor> = Arc::new(FilteredMemoryExtractor::new(
        raw_extractor,
        SensitiveFilter::default_set(),
    ));

    let engine = Engine::new(
        llm.clone(),
        ToolRegistryBuilder::default().build(),
        db,
        layout.clone(),
        EngineConfig::default_for("mock-model"),
    )
    .with_memory_extractor(extractor);

    let tenant = TenantId::new("t");
    let project = ProjectId::from_raw("p2");
    engine
        .handle_turn(TurnRequest {
            tenant_id: tenant.clone(),
            project_id: project.clone(),
            thread_id: ThreadId::new("thr-llm-extract-pii"),
            user_text: "anything".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();

    let store = MemoryStore::new(layout.memory_dir(&tenant, &project));
    let landed = wait_for(
        Duration::from_secs(2),
        || match futures::executor::block_on(store.list(MemoryScope::User)) {
            Ok(n) => n.iter().any(|x| x == "tone"),
            Err(_) => false,
        },
    )
    .await;
    assert!(landed, "the clean proposal must land");

    // The PII proposal must not.
    let user_entries = store.list(MemoryScope::User).await.unwrap();
    assert!(
        !user_entries.iter().any(|n| n == "contact"),
        "PII proposal should have been filtered; got entries: {user_entries:?}"
    );
}

#[tokio::test]
async fn extractor_with_garbage_llm_output_is_a_noop() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let llm = Arc::new(MockLlmClient::new());

    llm.enqueue(assistant_text("ack"));
    llm.enqueue(assistant_text("I'm sorry, I can't comply with that."));

    let extractor = Arc::new(LlmMemoryExtractor::new(
        llm.clone(),
        "mock-model".to_string(),
    ));
    let engine = Engine::new(
        llm.clone(),
        ToolRegistryBuilder::default().build(),
        db,
        layout.clone(),
        EngineConfig::default_for("mock-model"),
    )
    .with_memory_extractor(extractor);

    let tenant = TenantId::new("t");
    let project = ProjectId::from_raw("p3");
    engine
        .handle_turn(TurnRequest {
            tenant_id: tenant.clone(),
            project_id: project.clone(),
            thread_id: ThreadId::new("thr-llm-garbage"),
            user_text: "test".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();

    // Allow the background task to settle.
    tokio::time::sleep(Duration::from_millis(150)).await;

    let store = MemoryStore::new(layout.memory_dir(&tenant, &project));
    let all = store.list_all().await.unwrap();
    assert!(
        all.is_empty(),
        "garbage LLM output should produce zero entries; got {all:?}"
    );
}
