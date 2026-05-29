//! Engine + real `snaca-tools` integration.
//!
//! Confirms that the turn loop wires correctly to actual tool
//! implementations from `snaca-tools` (not just the in-test `EchoTool`).
//! The LLM is still mocked — we only validate the engine ↔ tools side of
//! the contract here. End-to-end with a real provider is exercised by
//! running `snaca-server` against DeepSeek (added in the next milestone).

use serde_json::json;
use snaca_core::{ContentBlock, ProjectId, TenantId, ThreadId};
use snaca_engine::{Engine, EngineConfig, TurnRequest};
use snaca_state::Database;
use snaca_tools::default_m1_registry;
use snaca_workspace::WorkspaceLayout;
use std::sync::Arc;

mod common;
use common::{assistant_text, assistant_tool_call, MockLlmClient};

#[tokio::test]
async fn engine_runs_real_read_tool_against_workspace() {
    // Workspace lives under tmp/<tenant>/projects/<project>/workspace/.
    // Pre-seed a README in the project workspace so Read can find it.
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let tenant = TenantId::new("tenant_a");
    let project = ProjectId::from_raw("proj_x");
    layout.ensure_project(&tenant, &project).unwrap();
    std::fs::write(
        layout.workspace_dir(&tenant, &project).join("README.md"),
        "# SNACA\n\nIs Not A Coding Agent.\n",
    )
    .unwrap();

    let db = Database::open_in_memory().await.unwrap();
    let registry = default_m1_registry();
    let llm = Arc::new(MockLlmClient::new());

    // Round 1: LLM asks to Read README.md.
    llm.enqueue(assistant_tool_call(vec![(
        "call_1",
        "Read",
        json!({"path": "README.md"}),
    )]));
    // Round 2: terminal text.
    llm.enqueue(assistant_text("README has 2 lines"));

    let engine = Engine::new(
        llm.clone(),
        registry,
        db.clone(),
        layout,
        EngineConfig::default_for("mock-model"),
    );

    let outcome = engine
        .handle_turn(TurnRequest {
            tenant_id: tenant.clone(),
            project_id: project.clone(),
            thread_id: ThreadId::new("chat_real"),
            user_text: "summarise README".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();
    assert_eq!(outcome.iterations, 2);

    // Verify the Tool message in the DB carries the file content.
    let msgs = db
        .recent_messages(&ThreadId::new("chat_real"), 10)
        .await
        .unwrap();
    let tool_msg = msgs
        .iter()
        .find(|m| matches!(m.role, snaca_core::Role::Tool))
        .expect("tool message recorded");
    let tool_text = tool_msg
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::ToolResult { content, .. } => content.iter().find_map(|c| match c {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            }),
            _ => None,
        })
        .expect("tool result text");
    // Read renders `cat -n` style output.
    assert!(tool_text.contains("# SNACA"), "got: {tool_text}");
    assert!(
        tool_text.contains("Is Not A Coding Agent"),
        "got: {tool_text}"
    );
}

#[tokio::test]
async fn engine_surfaces_path_traversal_as_tool_error() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let registry = default_m1_registry();
    let llm = Arc::new(MockLlmClient::new());

    // Round 1: model tries to escape the workspace.
    llm.enqueue(assistant_tool_call(vec![(
        "call_1",
        "Read",
        json!({"path": "../../../etc/passwd"}),
    )]));
    // Round 2: model recovers.
    llm.enqueue(assistant_text("can't read that"));

    let engine = Engine::new(
        llm,
        registry,
        db.clone(),
        layout,
        EngineConfig::default_for("mock-model"),
    );
    let outcome = engine
        .handle_turn(TurnRequest {
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("p"),
            thread_id: ThreadId::new("chat_safety"),
            user_text: "show me passwd".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();
    assert_eq!(outcome.iterations, 2);

    let msgs = db
        .recent_messages(&ThreadId::new("chat_safety"), 10)
        .await
        .unwrap();
    let tool_msg = msgs
        .iter()
        .find(|m| matches!(m.role, snaca_core::Role::Tool))
        .expect("tool message");
    let (_id, _text, is_error) =
        common::first_tool_result(&tool_msg.content).expect("tool result block");
    assert!(is_error, "path-traversal must surface as tool error block");
}
