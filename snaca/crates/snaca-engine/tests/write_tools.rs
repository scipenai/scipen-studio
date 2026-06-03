//! End-to-end check that Write/Edit/MultiEdit run through the engine and
//! actually mutate files in the project workspace.
//!
//! Pre-seed a workspace with one file, script the mock LLM through a
//! Write → Edit → MultiEdit chain, and confirm each on-disk state.

use serde_json::json;
use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_engine::{Engine, EngineConfig, TurnRequest};
use snaca_skills::SkillRegistry;
use snaca_state::Database;
use snaca_tools::default_m2_registry;
use snaca_workspace::WorkspaceLayout;
use std::sync::Arc;

mod common;
use common::{assistant_text, assistant_tool_call, MockLlmClient};

#[tokio::test]
async fn write_tool_creates_new_file_in_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = default_m2_registry(SkillRegistry::empty());

    let llm = Arc::new(MockLlmClient::new());
    llm.enqueue(assistant_tool_call(vec![(
        "call_1",
        "Write",
        json!({"path": "src/lib.rs", "content": "pub fn answer() -> u32 { 42 }\n"}),
    )]));
    llm.enqueue(assistant_text("done"));

    let tenant = TenantId::new("t");
    let project = ProjectId::from_raw("p");
    let engine = Engine::new(
        llm,
        tools,
        db.clone(),
        layout.clone(),
        EngineConfig::default_for("mock-model"),
    );
    let outcome = engine
        .handle_turn(TurnRequest {
            tenant_id: tenant.clone(),
            project_id: project.clone(),
            thread_id: ThreadId::new("chat_w"),
            user_text: "create src/lib.rs".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();
    assert_eq!(outcome.iterations, 2);

    let on_disk =
        std::fs::read_to_string(layout.workspace_dir(&tenant, &project).join("src/lib.rs"))
            .unwrap();
    assert_eq!(on_disk, "pub fn answer() -> u32 { 42 }\n");
}

#[tokio::test]
async fn edit_tool_updates_existing_file() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = default_m2_registry(SkillRegistry::empty());

    // Seed the workspace with a file the LLM will edit.
    let tenant = TenantId::new("t");
    let project = ProjectId::from_raw("p");
    layout.ensure_project(&tenant, &project).unwrap();
    let target = layout.workspace_dir(&tenant, &project).join("a.rs");
    std::fs::write(&target, "fn main() {}\n").unwrap();

    // Edit now requires a prior Read in the same turn (read_tracker
    // gate). Mirror the real model's pattern: Read → see result → Edit.
    let llm = Arc::new(MockLlmClient::new());
    llm.enqueue(assistant_tool_call(vec![(
        "call_r",
        "Read",
        json!({"path": "a.rs"}),
    )]));
    llm.enqueue(assistant_tool_call(vec![(
        "call_1",
        "Edit",
        json!({"path": "a.rs", "old_string": "main", "new_string": "entry"}),
    )]));
    llm.enqueue(assistant_text("renamed"));

    let engine = Engine::new(
        llm,
        tools,
        db.clone(),
        layout,
        EngineConfig::default_for("mock-model"),
    );
    let outcome = engine
        .handle_turn(TurnRequest {
            tenant_id: tenant,
            project_id: project,
            thread_id: ThreadId::new("chat_e"),
            user_text: "rename main".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();
    assert_eq!(outcome.iterations, 3);

    let on_disk = std::fs::read_to_string(&target).unwrap();
    assert_eq!(on_disk, "fn entry() {}\n");
}

#[tokio::test]
async fn multi_edit_chain_is_atomic_via_engine() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = default_m2_registry(SkillRegistry::empty());

    let tenant = TenantId::new("t");
    let project = ProjectId::from_raw("p");
    layout.ensure_project(&tenant, &project).unwrap();
    let target = layout.workspace_dir(&tenant, &project).join("a.txt");
    std::fs::write(&target, "alpha beta gamma").unwrap();

    let llm = Arc::new(MockLlmClient::new());
    // Prior Read is now required by the read_tracker gate.
    llm.enqueue(assistant_tool_call(vec![(
        "call_r",
        "Read",
        json!({"path": "a.txt"}),
    )]));
    // First MultiEdit deliberately fails on the second op (pattern not found).
    llm.enqueue(assistant_tool_call(vec![(
        "call_1",
        "MultiEdit",
        json!({
            "path": "a.txt",
            "edits": [
                {"old_string": "alpha", "new_string": "ALPHA"},
                {"old_string": "MISSING", "new_string": "x"}
            ]
        }),
    )]));
    // Model recovers and retries with a valid second op. The failed
    // MultiEdit left the file untouched, so the tracker entry from
    // the Read above is still valid — no second Read needed.
    llm.enqueue(assistant_tool_call(vec![(
        "call_2",
        "MultiEdit",
        json!({
            "path": "a.txt",
            "edits": [
                {"old_string": "alpha", "new_string": "ALPHA"},
                {"old_string": "gamma", "new_string": "GAMMA"}
            ]
        }),
    )]));
    llm.enqueue(assistant_text("ok"));

    let engine = Engine::new(
        llm,
        tools,
        db.clone(),
        layout,
        EngineConfig::default_for("mock-model"),
    );
    let outcome = engine
        .handle_turn(TurnRequest {
            tenant_id: tenant,
            project_id: project,
            thread_id: ThreadId::new("chat_me"),
            user_text: "multi-edit".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();
    assert_eq!(outcome.iterations, 4);

    // Final state: both edits applied; the failed first MultiEdit left the
    // file untouched, so the eventual result is from the retried second call.
    let on_disk = std::fs::read_to_string(&target).unwrap();
    assert_eq!(on_disk, "ALPHA beta GAMMA");
}

#[tokio::test]
async fn read_tracker_carries_across_turns_on_same_thread() {
    // Regression for the wedged-loop bug: a user pinging the bot
    // mid-task used to reset the read_tracker and force a re-Read
    // before any Edit. The tracker is now thread-scoped — Edit in
    // turn 2 succeeds with no Read, because turn 1's Read is recorded.
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = default_m2_registry(SkillRegistry::empty());

    let tenant = TenantId::new("t");
    let project = ProjectId::from_raw("p");
    layout.ensure_project(&tenant, &project).unwrap();
    let target = layout.workspace_dir(&tenant, &project).join("notes.md");
    std::fs::write(&target, "hello world\n").unwrap();

    let llm = Arc::new(MockLlmClient::new());
    // Turn 1: Read, then terminate.
    llm.enqueue(assistant_tool_call(vec![(
        "call_r",
        "Read",
        json!({"path": "notes.md"}),
    )]));
    llm.enqueue(assistant_text("read"));
    // Turn 2: Edit without re-Reading. Per-turn tracker would error.
    llm.enqueue(assistant_tool_call(vec![(
        "call_e",
        "Edit",
        json!({"path": "notes.md", "old_string": "hello", "new_string": "hi"}),
    )]));
    llm.enqueue(assistant_text("done"));

    let engine = Engine::new(
        llm,
        tools,
        db.clone(),
        layout,
        EngineConfig::default_for("mock-model"),
    );
    let thread = ThreadId::new("chat_persist");

    engine
        .handle_turn(TurnRequest {
            tenant_id: tenant.clone(),
            project_id: project.clone(),
            thread_id: thread.clone(),
            user_text: "look at notes".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();

    engine
        .handle_turn(TurnRequest {
            tenant_id: tenant.clone(),
            project_id: project.clone(),
            thread_id: thread.clone(),
            user_text: "you怎么样了".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();

    let on_disk = std::fs::read_to_string(&target).unwrap();
    assert_eq!(on_disk, "hi world\n");
}

#[tokio::test]
async fn read_tracker_independent_across_threads() {
    // Sibling regression: tracker is per-thread, so a Read on thread A
    // does NOT satisfy the gate on thread B. Edit on B without its own
    // Read must still fail (file untouched).
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = default_m2_registry(SkillRegistry::empty());

    let tenant = TenantId::new("t");
    let project = ProjectId::from_raw("p");
    layout.ensure_project(&tenant, &project).unwrap();
    let target = layout.workspace_dir(&tenant, &project).join("notes.md");
    std::fs::write(&target, "hello world\n").unwrap();

    let llm = Arc::new(MockLlmClient::new());
    llm.enqueue(assistant_tool_call(vec![(
        "call_r",
        "Read",
        json!({"path": "notes.md"}),
    )]));
    llm.enqueue(assistant_text("read on A"));
    llm.enqueue(assistant_tool_call(vec![(
        "call_e",
        "Edit",
        json!({"path": "notes.md", "old_string": "hello", "new_string": "hi"}),
    )]));
    llm.enqueue(assistant_text("oops"));

    let engine = Engine::new(
        llm,
        tools,
        db.clone(),
        layout,
        EngineConfig::default_for("mock-model"),
    );

    engine
        .handle_turn(TurnRequest {
            tenant_id: tenant.clone(),
            project_id: project.clone(),
            thread_id: ThreadId::new("chat_A"),
            user_text: "look".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();

    engine
        .handle_turn(TurnRequest {
            tenant_id: tenant,
            project_id: project,
            thread_id: ThreadId::new("chat_B"),
            user_text: "edit".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();

    let on_disk = std::fs::read_to_string(&target).unwrap();
    assert_eq!(
        on_disk, "hello world\n",
        "thread B must NOT have edited the file — it never Read it"
    );
}
