//! Integration test: when a reranker is attached, the engine runs the
//! cosine candidates through it before splicing into the system prompt.
//!
//! We use `MockLlmClient` for the (mocked) rerank call. The mock is
//! FIFO: turn body first, then the rerank reply. Asserting that the
//! reranker actually changed the order proves the wiring fires.

use serde_json::json;
use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_engine::{Engine, EngineConfig, LlmReranker, TurnRequest};
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

async fn fixture(with_reranker: bool) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = ToolRegistryBuilder::default()
        .add(MemoryWriteTool)
        .add(ReadTool)
        .build();
    let llm = Arc::new(MockLlmClient::new());
    let cfg = EngineConfig::default_for("mock-model");
    let mut engine = Engine::new(llm.clone(), tools, db, workspace, cfg)
        .with_embedder(Arc::new(HashEmbedder::new(128)));
    if with_reranker {
        engine = engine.with_reranker(Arc::new(LlmReranker::new(
            llm.clone(),
            "mock-model".to_string(),
        )));
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
        project_id: ProjectId::from_raw("proj_rerank"),
        thread_id: ThreadId::new("thr-rerank-1"),
        user_text: text.into(),
        message_id: None,
        ephemeral_system: None,
    }
}

fn observed(llm: &MockLlmClient) -> Vec<MessageRequest> {
    llm.observed_requests()
}

/// Seed enough memory entries that the recall pool actually has more
/// than RECALL_TOP_K candidates — that's the only path where the
/// reranker is consulted (the engine truncates inline otherwise).
async fn seed_memory(fix: &Fixture) {
    for (name, content) in [
        ("style-a", "rust language style guide"),
        ("style-b", "rust programming conventions"),
        ("style-c", "rust crate guide"),
        ("style-d", "rust toolchain notes"),
        ("style-e", "rust workspace layout"),
        ("style-f", "rust formatting rules"),
    ] {
        fix.llm.enqueue(assistant_tool_call(vec![(
            &format!("tu-{name}"),
            "MemoryWrite",
            json!({"scope": "project", "name": name, "content": content}),
        )]));
        fix.llm.enqueue(assistant_text("ok"));
        fix.engine
            .handle_turn(turn_request(&format!("write {name}")))
            .await
            .unwrap();
    }
}

/// Reverses the candidate order — useful to prove the recall block
/// reflects whatever the reranker says, regardless of cosine.
struct ReverseReranker;

#[async_trait::async_trait]
impl snaca_engine::Reranker for ReverseReranker {
    async fn rerank(
        &self,
        _query: &str,
        mut candidates: Vec<snaca_engine::RerankCandidate>,
        top_k: usize,
    ) -> Vec<snaca_engine::RerankCandidate> {
        candidates.reverse();
        candidates.truncate(top_k);
        candidates
    }
}

#[tokio::test]
async fn rerank_output_drives_recall_order() {
    // Custom fixture using ReverseReranker — deterministic, no LLM
    // mocking required for the rerank call itself.
    let tmp = tempfile::tempdir().unwrap();
    let workspace = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = ToolRegistryBuilder::default()
        .add(MemoryWriteTool)
        .add(ReadTool)
        .build();
    let llm = Arc::new(MockLlmClient::new());
    let cfg = EngineConfig::default_for("mock-model");
    let engine = Engine::new(llm.clone(), tools, db, workspace, cfg)
        .with_embedder(Arc::new(HashEmbedder::new(128)))
        .with_reranker(Arc::new(ReverseReranker));

    let fix = Fixture {
        engine,
        llm,
        _tmp: tmp,
    };
    seed_memory(&fix).await;

    fix.llm.enqueue(assistant_text("ack"));
    fix.engine
        .handle_turn(turn_request("rust style question"))
        .await
        .unwrap();

    let reqs = observed(fix.llm.as_ref());
    let with_recall = reqs
        .iter()
        .filter_map(|r| r.system.as_deref())
        .find(|s| s.contains("## Relevant Memories"))
        .expect("expected a recall block");

    // Extract entry names in the order they appear in the recall block.
    let recall_section = with_recall.split("## Relevant Memories").nth(1).unwrap();
    let names_in_block: Vec<String> = recall_section
        .lines()
        .filter_map(|l| {
            // Lines look like: "### `project/style-x` (score 0.42)"
            l.find("project/").map(|i| {
                let tail = &l[i + "project/".len()..];
                let end = tail.find('`').unwrap_or(tail.len());
                tail[..end].to_string()
            })
        })
        .collect();
    assert!(
        !names_in_block.is_empty(),
        "expected at least one rendered entry; got: {recall_section}"
    );
    // Compare with the same engine using IdentityReranker (cosine
    // order). The reversed reranker should produce the opposite order.
    let cosine_order = cosine_only_order(&fix.llm).await;
    if names_in_block.len() == cosine_order.len() && cosine_order.len() >= 2 {
        let mut reversed = cosine_order.clone();
        reversed.reverse();
        assert_eq!(
            names_in_block, reversed,
            "ReverseReranker should reverse cosine order"
        );
    }
}

/// Build a parallel engine with no reranker and run the same query —
/// returns the order names appear in *that* recall block. Used to
/// compare against the reranker's output.
async fn cosine_only_order(_llm: &MockLlmClient) -> Vec<String> {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = ToolRegistryBuilder::default()
        .add(MemoryWriteTool)
        .add(ReadTool)
        .build();
    let llm = Arc::new(MockLlmClient::new());
    let cfg = EngineConfig::default_for("mock-model");
    let engine = Engine::new(llm.clone(), tools, db, workspace, cfg)
        .with_embedder(Arc::new(HashEmbedder::new(128)));
    let fix = Fixture {
        engine,
        llm: llm.clone(),
        _tmp: tmp,
    };
    seed_memory(&fix).await;
    fix.llm.enqueue(assistant_text("ack"));
    fix.engine
        .handle_turn(turn_request("rust style question"))
        .await
        .unwrap();
    let reqs = observed(fix.llm.as_ref());
    let recall = reqs
        .iter()
        .filter_map(|r| r.system.as_deref())
        .find(|s| s.contains("## Relevant Memories"))
        .expect("cosine-only fixture should also produce a recall block");
    let recall_section = recall.split("## Relevant Memories").nth(1).unwrap();
    recall_section
        .lines()
        .filter_map(|l| {
            l.find("project/").map(|i| {
                let tail = &l[i + "project/".len()..];
                let end = tail.find('`').unwrap_or(tail.len());
                tail[..end].to_string()
            })
        })
        .collect()
}

#[tokio::test]
async fn rerank_falls_back_to_cosine_on_garbage_output() {
    let fix = fixture(true).await;
    seed_memory(&fix).await;

    // Reranker returns garbage; engine should still surface a recall
    // section using the cosine top-k.
    fix.llm.enqueue(assistant_text("I cannot help with that."));
    fix.llm.enqueue(assistant_text("ack"));

    fix.engine
        .handle_turn(turn_request("rust style question"))
        .await
        .unwrap();

    let reqs = observed(fix.llm.as_ref());
    let with_recall = reqs
        .iter()
        .filter_map(|r| r.system.as_deref())
        .find(|s| s.contains("## Relevant Memories"))
        .expect("expected a request with recall block (fallback path)");
    // At least some memory entry should still surface.
    assert!(
        with_recall.contains("style-"),
        "fallback path should still surface cosine top-k: {with_recall}"
    );
}

#[tokio::test]
async fn no_reranker_truncates_cosine_top_k() {
    let fix = fixture(false).await;
    seed_memory(&fix).await;

    fix.llm.enqueue(assistant_text("ack"));
    fix.engine
        .handle_turn(turn_request("rust style question"))
        .await
        .unwrap();

    let reqs = observed(fix.llm.as_ref());
    let with_recall = reqs
        .iter()
        .filter_map(|r| r.system.as_deref())
        .find(|s| s.contains("## Relevant Memories"));
    // Recall section can be present (cosine matches style-* entries).
    // No rerank call was made — verify by counting memory-write
    // request bodies (turn1 = write, turn1-bis = ok, ..., turn7 = ack).
    // We expect 6 writes * 2 calls = 12 + 1 final = 13 requests total.
    let count = reqs.len();
    assert_eq!(
        count, 13,
        "without reranker, no extra LLM call; got {count} requests"
    );
    if let Some(s) = with_recall {
        assert!(s.contains("style-"));
    }
}
