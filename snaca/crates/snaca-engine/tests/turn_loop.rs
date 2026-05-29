//! Turn-loop integration tests for `snaca-engine`.
//!
//! Drive the engine with a scripted [`MockLlmClient`] and an in-memory
//! SQLite database. Each test verifies one branch of the loop's state
//! machine: text-only termination, single tool call, multiple tool calls
//! in one assistant message, unknown-tool error path, max-iteration cap.

use serde_json::json;
use snaca_core::{ContentBlock, ProjectId, Role, TenantId, ThreadId};
use snaca_engine::{Engine, EngineConfig, EngineError, TurnRequest};
use snaca_state::Database;
use snaca_tools_api::ToolRegistryBuilder;
use snaca_workspace::WorkspaceLayout;
use std::sync::Arc;

mod common;
use common::{assistant_text, assistant_tool_call, EchoTool, MockLlmClient};

struct Fixture {
    engine: Engine,
    db: Database,
    llm: Arc<MockLlmClient>,
    _tmp: tempfile::TempDir,
}

async fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = ToolRegistryBuilder::default().add(EchoTool).build();
    let llm = Arc::new(MockLlmClient::new());
    let engine = Engine::new(
        llm.clone(),
        tools,
        db.clone(),
        workspace,
        EngineConfig::default_for("mock-model"),
    );
    Fixture {
        engine,
        db,
        llm,
        _tmp: tmp,
    }
}

fn turn_request() -> TurnRequest {
    TurnRequest {
        tenant_id: TenantId::new("tenant_a"),
        project_id: ProjectId::from_raw("proj_x"),
        thread_id: ThreadId::new("chat_1"),
        user_text: "hello".into(),
        message_id: None,
        ephemeral_system: None,
    }
}

#[tokio::test]
async fn text_only_turn_terminates_in_one_round() {
    let fix = fixture().await;
    fix.llm.enqueue(assistant_text("hi back"));

    let outcome = fix.engine.handle_turn(turn_request()).await.unwrap();
    assert_eq!(outcome.iterations, 1);
    assert_eq!(outcome.assistant_text, "hi back");
    assert_eq!(fix.llm.observed_request_count(), 1);

    // DB has 2 rows: user + assistant.
    let msgs = fix
        .db
        .recent_messages(&ThreadId::new("chat_1"), 10)
        .await
        .unwrap();
    assert_eq!(msgs.len(), 2);
    assert!(matches!(msgs[0].role, Role::User));
    assert!(matches!(msgs[1].role, Role::Assistant));
}

#[tokio::test]
async fn single_tool_call_runs_and_continues() {
    let fix = fixture().await;
    // First response: model asks for an Echo call.
    fix.llm.enqueue(assistant_tool_call(vec![(
        "call_1",
        "Echo",
        json!({"text": "ping"}),
    )]));
    // Second response: terminal text.
    fix.llm.enqueue(assistant_text("done"));

    let outcome = fix.engine.handle_turn(turn_request()).await.unwrap();
    assert_eq!(outcome.iterations, 2);
    assert_eq!(outcome.assistant_text, "done");

    // DB rows: user, assistant(tool_use), tool, assistant(text) = 4
    let msgs = fix
        .db
        .recent_messages(&ThreadId::new("chat_1"), 10)
        .await
        .unwrap();
    assert_eq!(msgs.len(), 4);
    assert!(matches!(msgs[0].role, Role::User));
    assert!(matches!(msgs[1].role, Role::Assistant));
    assert!(matches!(msgs[2].role, Role::Tool));
    assert!(matches!(msgs[3].role, Role::Assistant));

    // Tool message has a tool_result block carrying "echo: ping".
    let (id, text, is_error) =
        common::first_tool_result(&msgs[2].content).expect("tool result block");
    assert_eq!(id.as_str(), "call_1");
    assert_eq!(text, "echo: ping");
    assert!(!is_error);
}

#[tokio::test]
async fn multi_tool_calls_in_one_assistant_message() {
    let fix = fixture().await;
    fix.llm.enqueue(assistant_tool_call(vec![
        ("call_1", "Echo", json!({"text": "a"})),
        ("call_2", "Echo", json!({"text": "b"})),
    ]));
    fix.llm.enqueue(assistant_text("did both"));

    let outcome = fix.engine.handle_turn(turn_request()).await.unwrap();
    assert_eq!(outcome.iterations, 2);

    let msgs = fix
        .db
        .recent_messages(&ThreadId::new("chat_1"), 10)
        .await
        .unwrap();
    let tool_msg = msgs
        .iter()
        .find(|m| matches!(m.role, Role::Tool))
        .expect("tool message");
    let result_count = tool_msg
        .content
        .iter()
        .filter(|b| matches!(b, ContentBlock::ToolResult { .. }))
        .count();
    assert_eq!(result_count, 2);
}

#[tokio::test]
async fn unknown_tool_call_yields_tool_error_block() {
    let fix = fixture().await;
    fix.llm.enqueue(assistant_tool_call(vec![(
        "call_1",
        "NotARealTool",
        json!({}),
    )]));
    fix.llm.enqueue(assistant_text("recovered"));

    let outcome = fix.engine.handle_turn(turn_request()).await.unwrap();
    assert_eq!(outcome.iterations, 2);

    let msgs = fix
        .db
        .recent_messages(&ThreadId::new("chat_1"), 10)
        .await
        .unwrap();
    let (_, _, is_error) = common::first_tool_result(&msgs[2].content).expect("tool result block");
    assert!(
        is_error,
        "unknown tool call must produce is_error=true block"
    );
}

#[tokio::test]
async fn max_iterations_caps_runaway_loops() {
    let fix = fixture().await;
    // Always demand a tool call; never terminate. Use *varying* inputs so
    // LoopGuard doesn't trip first — this test specifically exercises the
    // `max_iterations` ceiling, which is a complementary safeguard for
    // cases where LoopGuard's same-input heuristic doesn't catch the loop
    // (e.g. genuinely-progressing work that just runs too long).
    for i in 0..15 {
        fix.llm.enqueue(assistant_tool_call(vec![(
            "x",
            "Echo",
            json!({"text": format!("loop-{i}")}),
        )]));
    }

    let err = fix.engine.handle_turn(turn_request()).await.unwrap_err();
    match err {
        EngineError::MaxIterationsExceeded(n) => {
            assert_eq!(n, EngineConfig::default_for("mock-model").max_iterations);
        }
        other => panic!("expected MaxIterationsExceeded, got {other:?}"),
    }
}

#[tokio::test]
async fn workspace_directory_is_created_for_project() {
    let fix = fixture().await;
    fix.llm.enqueue(assistant_text("hi"));

    fix.engine.handle_turn(turn_request()).await.unwrap();

    // Workspace + memory subdirs were created.
    let tenant = TenantId::new("tenant_a");
    let project = ProjectId::from_raw("proj_x");
    let layout = WorkspaceLayout::new(fix._tmp.path()).unwrap();
    assert!(layout.workspace_dir(&tenant, &project).is_dir());
    assert!(layout.memory_dir(&tenant, &project).join("user").is_dir());
}

#[tokio::test]
async fn second_turn_reuses_thread() {
    let fix = fixture().await;
    fix.llm.enqueue(assistant_text("first"));
    fix.llm.enqueue(assistant_text("second"));

    let r1 = fix.engine.handle_turn(turn_request()).await.unwrap();
    let r2 = fix
        .engine
        .handle_turn(TurnRequest {
            tenant_id: TenantId::new("tenant_a"),
            project_id: ProjectId::from_raw("proj_x"),
            thread_id: ThreadId::new("chat_1"),
            user_text: "again".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();

    assert_ne!(r1.session_id, r2.session_id);
    let msgs = fix
        .db
        .recent_messages(&ThreadId::new("chat_1"), 10)
        .await
        .unwrap();
    // user, assistant, user, assistant = 4
    assert_eq!(msgs.len(), 4);
}
