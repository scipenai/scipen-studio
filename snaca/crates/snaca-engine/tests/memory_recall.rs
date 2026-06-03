//! Engine integration test: when the engine has an `Embedder` attached,
//! a query that semantically matches a stored memory entry produces a
//! `## Relevant Memories` section in the system prompt seen by the LLM.
//!
//! Uses `HashEmbedder` so the test is hermetic — no ONNX downloads, no
//! external services. The hash embedder is token-bag-based, so two
//! strings that share words score above the recall floor.

use serde_json::json;
use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_engine::{Engine, EngineConfig, TurnRequest};
use snaca_llm::MessageRequest;
use snaca_memory::HashEmbedder;
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

async fn fixture(with_embedder: bool) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = ToolRegistryBuilder::default()
        .add(MemoryWriteTool)
        .add(ReadTool)
        .build();
    let llm = Arc::new(MockLlmClient::new());
    let cfg = EngineConfig::default_for("mock-model");
    let mut engine = Engine::new(llm.clone(), tools, db, workspace, cfg);
    if with_embedder {
        engine = engine.with_embedder(Arc::new(HashEmbedder::new(128)));
    }
    Fixture {
        engine,
        llm,
        _tmp: tmp,
    }
}

fn turn_request(text: &str) -> TurnRequest {
    TurnRequest {
        tenant_id: TenantId::new("tenant_a"),
        project_id: ProjectId::from_raw("proj_recall"),
        thread_id: ThreadId::new("thr-recall"),
        user_text: text.into(),
        message_id: None,
        ephemeral_system: None,
    }
}

fn observed(llm: &MockLlmClient) -> Vec<MessageRequest> {
    llm.observed_requests()
}

#[tokio::test]
async fn relevant_memory_excerpt_appears_in_next_turn_system_prompt() {
    let fix = fixture(true).await;

    // Turn 1: model writes a memory entry that talks about a specific
    // topic. The hash embedder will index it on write.
    fix.llm.enqueue(assistant_tool_call(vec![(
        "tu1",
        "MemoryWrite",
        json!({
            "scope": "project",
            "name": "rust-style",
            "content": "the project follows kebab-case for file names and snake_case for items"
        }),
    )]));
    fix.llm.enqueue(assistant_text("recorded"));

    fix.engine
        .handle_turn(turn_request("note that we use kebab-case file names"))
        .await
        .unwrap();

    // Turn 2: ask a question whose tokens overlap with the memory body.
    // The recall block should surface the rust-style entry.
    fix.llm.enqueue(assistant_text("ack"));
    fix.engine
        .handle_turn(turn_request(
            "what's our convention for kebab-case file names",
        ))
        .await
        .unwrap();

    let reqs = observed(fix.llm.as_ref());
    // Three calls so far: turn-1 tool_use, turn-1 terminal, turn-2 terminal.
    let turn2 = &reqs[2];
    let sys = turn2.flat_system().unwrap_or_default();
    assert!(
        sys.contains("## Relevant Memories"),
        "expected recall section; got: {sys}"
    );
    assert!(
        sys.contains("project/rust-style"),
        "expected matching entry name; got: {sys}"
    );
    // The base system prompt must still come first.
    assert!(
        sys.contains("SNACA"),
        "base system prompt should still be present"
    );
}

#[tokio::test]
async fn no_embedder_means_no_recall_section() {
    let fix = fixture(false).await;

    // Same setup as above, no embedder attached.
    fix.llm.enqueue(assistant_tool_call(vec![(
        "tu1",
        "MemoryWrite",
        json!({
            "scope": "project",
            "name": "rust-style",
            "content": "kebab-case file names"
        }),
    )]));
    fix.llm.enqueue(assistant_text("ok"));
    fix.engine
        .handle_turn(turn_request("write a memory"))
        .await
        .unwrap();

    fix.llm.enqueue(assistant_text("ack"));
    fix.engine
        .handle_turn(turn_request("kebab-case question"))
        .await
        .unwrap();

    let reqs = observed(fix.llm.as_ref());
    let turn2 = &reqs[2];
    let sys = turn2.flat_system().unwrap_or_default();
    // The MEMORY.md index can still be there (it's not gated on embedder),
    // but the auto-retrieval section must not.
    assert!(
        !sys.contains("## Relevant Memories"),
        "no embedder should mean no recall block; got: {sys}"
    );
}

#[tokio::test]
async fn low_confidence_extractor_entry_is_filtered_from_recall() {
    // Plant a memory entry with extractor frontmatter declaring a very
    // low confidence. Even when cosine matches the query, confidence
    // multiplication should drag the adjusted score below
    // `recall_confidence_floor` and drop the hit before the prompt.
    let fix = fixture(true).await;

    let workspace_dir = fix._tmp.path();
    let memory_root = workspace_dir
        .join("tenant_a")
        .join("projects")
        .join("proj_recall")
        .join("memory");
    tokio::fs::create_dir_all(&memory_root).await.unwrap();
    let store = snaca_memory::MemoryStore::new(&memory_root);

    let low_conf_body = "---\nsource: extractor\nconfidence: 0.05\n---\nthe project follows kebab-case for file names";
    store
        .write(snaca_memory::MemoryScope::Feedback, "low-conf", low_conf_body)
        .await
        .unwrap();

    fix.llm.enqueue(assistant_text("ack"));
    fix.engine
        .handle_turn(turn_request(
            "what's our convention for kebab-case file names",
        ))
        .await
        .unwrap();

    let reqs = observed(fix.llm.as_ref());
    let sys = reqs[0].flat_system().unwrap_or_default();
    // The MEMORY.md index can still list the entry; what must NOT
    // happen is the entry being auto-spliced in via recall.
    let recall_section = sys.split("## Relevant Memories").nth(1).unwrap_or("");
    assert!(
        !recall_section.contains("feedback/low-conf"),
        "low-confidence extractor entry should not appear in recall block; got: {recall_section}"
    );
}

#[tokio::test]
async fn unrelated_query_falls_below_recall_threshold() {
    let fix = fixture(true).await;

    fix.llm.enqueue(assistant_tool_call(vec![(
        "tu1",
        "MemoryWrite",
        json!({
            "scope": "project",
            "name": "rust-style",
            "content": "kebab-case file names and snake_case items"
        }),
    )]));
    fix.llm.enqueue(assistant_text("ok"));
    fix.engine
        .handle_turn(turn_request("write a memory"))
        .await
        .unwrap();

    // A question whose tokens don't overlap with the entry body. Hash
    // embedder will produce orthogonal vectors → near-zero score → must
    // fall below `RECALL_MIN_SCORE`.
    fix.llm.enqueue(assistant_text("ack"));
    fix.engine
        .handle_turn(turn_request("what is the weather today"))
        .await
        .unwrap();

    let reqs = observed(fix.llm.as_ref());
    let sys = reqs[2].flat_system().unwrap_or_default();
    assert!(
        !sys.contains("## Relevant Memories"),
        "unrelated query should not surface recall; got: {sys}"
    );
}
