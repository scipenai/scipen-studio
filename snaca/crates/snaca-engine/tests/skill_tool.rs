//! End-to-end check that `SkillTool` is wired through the engine.
//!
//! Builds a registry with a real `Skill`, scripts the mock LLM to call
//! `Skill { name }`, and asserts that the tool result block surfaced back
//! to the model contains the skill's markdown body.

use serde_json::json;
use snaca_core::{ContentBlock, ProjectId, Role, TenantId, ThreadId};
use snaca_engine::{Engine, EngineConfig, TurnRequest};
use snaca_skills::{Skill, SkillRegistry, SkillScope};
use snaca_state::Database;
use snaca_tools::default_m2_registry;
use snaca_workspace::WorkspaceLayout;
use std::sync::Arc;

mod common;
use common::{assistant_text, assistant_tool_call, MockLlmClient};

fn skill(name: &str, body: &str) -> Skill {
    let raw = format!(
        "---\nname: {name}\ndescription: {name} desc\nwhen_to_use: when {name}\n---\n{body}\n"
    );
    Skill::from_str(&raw, SkillScope::Tenant, None).unwrap()
}

#[tokio::test]
async fn skill_tool_returns_body_through_engine() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();

    let registry =
        SkillRegistry::from_skills(vec![skill("reviewer", "Treat every file like prod.")]);
    let tools = default_m2_registry(registry);

    let llm = Arc::new(MockLlmClient::new());
    // Round 1: model picks the `reviewer` skill.
    llm.enqueue(assistant_tool_call(vec![(
        "call_1",
        "Skill",
        json!({"name": "reviewer"}),
    )]));
    // Round 2: terminal text — the model now "knows" the skill body.
    llm.enqueue(assistant_text("got it"));

    let engine = Engine::new(
        llm,
        tools,
        db.clone(),
        layout,
        EngineConfig::default_for("mock-model"),
    );

    let outcome = engine
        .handle_turn(TurnRequest {
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("p"),
            thread_id: ThreadId::new("chat_skill"),
            user_text: "use the reviewer skill".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();
    assert_eq!(outcome.iterations, 2);
    assert_eq!(outcome.assistant_text, "got it");

    let msgs = db
        .recent_messages(&ThreadId::new("chat_skill"), 10)
        .await
        .unwrap();
    let tool_msg = msgs
        .iter()
        .find(|m| matches!(m.role, Role::Tool))
        .expect("tool message persisted");
    let result_text = tool_msg
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
    assert!(
        result_text.contains("Treat every file like prod."),
        "expected skill body in tool result; got: {result_text}"
    );
}

#[tokio::test]
async fn unknown_skill_yields_tool_error_block() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();

    let registry = SkillRegistry::from_skills(vec![skill("known", "hello")]);
    let tools = default_m2_registry(registry);

    let llm = Arc::new(MockLlmClient::new());
    llm.enqueue(assistant_tool_call(vec![(
        "call_1",
        "Skill",
        json!({"name": "missing"}),
    )]));
    llm.enqueue(assistant_text("recovered"));

    let engine = Engine::new(
        llm,
        tools,
        db.clone(),
        layout,
        EngineConfig::default_for("mock-model"),
    );

    let outcome = engine
        .handle_turn(TurnRequest {
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("p"),
            thread_id: ThreadId::new("chat_x"),
            user_text: "use missing".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();
    assert_eq!(outcome.iterations, 2);

    let msgs = db
        .recent_messages(&ThreadId::new("chat_x"), 10)
        .await
        .unwrap();
    let tool_msg = msgs
        .iter()
        .find(|m| matches!(m.role, Role::Tool))
        .expect("tool message");
    let (_, _, is_error) = common::first_tool_result(&tool_msg.content).expect("tool result block");
    assert!(is_error, "missing skill must produce is_error=true block");
}
