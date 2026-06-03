//! Engine integration test: when an extractor is wired in, proposals
//! land in the project's memory store after the turn completes.
//!
//! Uses `ConstantExtractor` so we don't need an LLM: the canned
//! proposals come back regardless of what the conversation actually
//! contained. The interesting bit is that the engine's post-turn hook
//! (1) actually fires, (2) writes through the store, and (3) does so
//! without blocking the user-visible turn.

use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_engine::{ConstantExtractor, Engine, EngineConfig, MemoryProposal, TurnRequest};
use snaca_memory::{MemoryScope, MemoryStore};
use snaca_state::Database;
use snaca_tools_api::ToolRegistryBuilder;
use snaca_workspace::WorkspaceLayout;
use std::sync::Arc;
use std::time::Duration;

mod common;
use common::{assistant_text, MockLlmClient};

struct Fixture {
    engine: Engine,
    layout: WorkspaceLayout,
    llm: Arc<MockLlmClient>,
    _tmp: tempfile::TempDir,
}

async fn fixture(extractor: Arc<ConstantExtractor>) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = ToolRegistryBuilder::default().build();
    let llm = Arc::new(MockLlmClient::new());
    let cfg = EngineConfig::default_for("mock-model");
    let engine = Engine::new(llm.clone(), tools, db, workspace.clone(), cfg)
        .with_memory_extractor(extractor);
    Fixture {
        engine,
        layout: workspace,
        llm,
        _tmp: tmp,
    }
}

fn turn_request(text: &str) -> TurnRequest {
    TurnRequest {
        tenant_id: TenantId::new("tenant_a"),
        project_id: ProjectId::from_raw("proj_extract"),
        thread_id: ThreadId::new("thr-extract-1"),
        user_text: text.into(),
        message_id: None,
        ephemeral_system: None,
    }
}

/// The extraction task is `tokio::spawn`'d, so we need to wait briefly
/// for it to land. Polls a closure rather than sleeping a fixed
/// duration so the test stays fast on quick runs.
async fn wait_until<F>(deadline: Duration, mut check: F) -> bool
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
async fn extractor_writes_proposals_after_terminal_turn() {
    let canned = vec![
        MemoryProposal {
            scope: MemoryScope::Feedback,
            name: "no-emojis".into(),
            content: "user said: stop using emojis".into(),
            confidence: Some(0.85),
        },
        MemoryProposal {
            scope: MemoryScope::User,
            name: "tone".into(),
            content: "user prefers terse responses".into(),
            confidence: Some(0.7),
        },
    ];
    let extractor = Arc::new(ConstantExtractor::new(canned));
    let fix = fixture(extractor).await;

    fix.llm.enqueue(assistant_text("ok"));
    fix.engine
        .handle_turn(turn_request("stop using emojis and be terse"))
        .await
        .unwrap();

    let store = MemoryStore::new(fix.layout.memory_dir(
        &TenantId::new("tenant_a"),
        &ProjectId::from_raw("proj_extract"),
    ));

    let landed = wait_until(Duration::from_secs(2), || {
        // Both proposals must land.
        let names_feedback = match futures::executor::block_on(store.list(MemoryScope::Feedback)) {
            Ok(n) => n,
            Err(_) => return false,
        };
        let names_user = match futures::executor::block_on(store.list(MemoryScope::User)) {
            Ok(n) => n,
            Err(_) => return false,
        };
        names_feedback.iter().any(|n| n == "no-emojis") && names_user.iter().any(|n| n == "tone")
    })
    .await;

    assert!(landed, "extractor proposals should be persisted within 2s");

    let (meta, body) = store
        .read_with_meta(MemoryScope::Feedback, "no-emojis")
        .await
        .unwrap();
    assert_eq!(body, "user said: stop using emojis");
    assert_eq!(meta.source.as_deref(), Some("extractor"));
    assert_eq!(meta.confidence, Some(0.85));
    assert!(meta.created_at.is_some());
}

#[tokio::test]
async fn empty_extractor_writes_nothing() {
    let extractor = Arc::new(ConstantExtractor::new(Vec::new()));
    let fix = fixture(extractor).await;
    fix.llm.enqueue(assistant_text("ok"));
    fix.engine.handle_turn(turn_request("hi")).await.unwrap();

    // Give the (empty) background task time to settle.
    tokio::time::sleep(Duration::from_millis(100)).await;

    let store = MemoryStore::new(fix.layout.memory_dir(
        &TenantId::new("tenant_a"),
        &ProjectId::from_raw("proj_extract"),
    ));
    let all = store.list_all().await.unwrap();
    assert!(
        all.is_empty(),
        "no proposals should mean no entries: {all:?}"
    );
}

#[tokio::test]
async fn proposals_in_disallowed_scopes_are_rejected() {
    // Project / Reference scopes are operator-curated; the extractor
    // can propose them but the engine drops them.
    let canned = vec![
        MemoryProposal {
            scope: MemoryScope::Project,
            name: "smuggled".into(),
            content: "should not land".into(),
            confidence: Some(0.5),
        },
        MemoryProposal {
            scope: MemoryScope::Reference,
            name: "external-tool".into(),
            content: "should not land".into(),
            confidence: Some(0.5),
        },
        MemoryProposal {
            scope: MemoryScope::User,
            name: "allowed".into(),
            content: "this one is fine".into(),
            confidence: Some(0.7),
        },
    ];
    let extractor = Arc::new(ConstantExtractor::new(canned));
    let fix = fixture(extractor).await;
    fix.llm.enqueue(assistant_text("ok"));
    fix.engine
        .handle_turn(turn_request("anything"))
        .await
        .unwrap();

    let store = MemoryStore::new(fix.layout.memory_dir(
        &TenantId::new("tenant_a"),
        &ProjectId::from_raw("proj_extract"),
    ));
    let landed = wait_until(
        Duration::from_secs(2),
        || match futures::executor::block_on(store.list(MemoryScope::User)) {
            Ok(n) => n.iter().any(|x| x == "allowed"),
            Err(_) => false,
        },
    )
    .await;
    assert!(landed, "the User-scope proposal must land");

    let proj = store.list(MemoryScope::Project).await.unwrap();
    let refs = store.list(MemoryScope::Reference).await.unwrap();
    assert!(
        proj.is_empty(),
        "Project scope must reject extractor writes: {proj:?}"
    );
    assert!(
        refs.is_empty(),
        "Reference scope must reject extractor writes: {refs:?}"
    );
}
