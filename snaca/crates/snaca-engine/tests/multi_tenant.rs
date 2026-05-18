//! Per-(tenant, project) tool/skill isolation through the engine.
//!
//! Sets up a `LayoutSkillProvider` over a temp workspace, drops different
//! skill files into two tenants' directories, plugs everything into the
//! engine via a custom `RuntimeToolFactory`, then runs two turns scripted
//! to invoke the `Skill` tool. Each turn must see only its own tenant's
//! skill — no cross-pollination.

use async_trait::async_trait;
use serde_json::json;
use snaca_core::{ContentBlock, ProjectId, Role, TenantId, ThreadId};
use snaca_engine::{
    Engine, EngineConfig, RuntimeToolFactory, TurnRequest,
};
use snaca_skills::{LayoutSkillProvider, SkillProvider};
use snaca_state::Database;
use snaca_tools::{base_tool_registry, SkillTool};
use snaca_tools_api::{ToolRegistry, ToolRegistryBuilder};
use snaca_workspace::WorkspaceLayout;
use std::sync::Arc;

mod common;
use common::{assistant_text, assistant_tool_call, MockLlmClient};

fn write_skill(dir: &std::path::Path, file: &str, name: &str, body: &str) {
    std::fs::create_dir_all(dir).unwrap();
    let raw = format!("---\nname: {name}\ndescription: {name} description\n---\n{body}\n");
    std::fs::write(dir.join(file), raw).unwrap();
}

struct TestFactory {
    base: ToolRegistry,
    skills: Arc<dyn SkillProvider>,
}

#[async_trait]
impl RuntimeToolFactory for TestFactory {
    async fn build(&self, tenant: &TenantId, project: &ProjectId) -> ToolRegistry {
        let mut b = ToolRegistryBuilder::default();
        let names: Vec<String> = self.base.names().map(String::from).collect();
        for name in names {
            if let Some(t) = self.base.get(&name) {
                b = b.add_arc(t);
            }
        }
        let s = self.skills.skills_for(tenant, project).await;
        if !s.is_empty() {
            b = b.add(SkillTool::new(s));
        }
        b.build()
    }
}

#[tokio::test]
async fn skill_tool_invocation_returns_tenant_specific_body() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();

    let alpha = TenantId::new("alpha");
    let beta = TenantId::new("beta");
    let project = ProjectId::from_raw("shared");

    // Each tenant writes a skill named `runbook` with different body.
    write_skill(
        &layout.tenant_skills_dir(&alpha),
        "runbook.md",
        "runbook",
        "alpha-runbook lives here",
    );
    write_skill(
        &layout.tenant_skills_dir(&beta),
        "runbook.md",
        "runbook",
        "beta-runbook is different",
    );

    let provider: Arc<dyn SkillProvider> =
        Arc::new(LayoutSkillProvider::without_cache(layout.clone()));
    let base = base_tool_registry();
    let factory = Arc::new(TestFactory {
        base: base.clone(),
        skills: provider,
    });

    let db = Database::open_in_memory().await.unwrap();
    let llm = Arc::new(MockLlmClient::new());

    // alpha turn: skill body must be "alpha-runbook lives here"
    llm.enqueue(assistant_tool_call(vec![(
        "c1",
        "Skill",
        json!({"name": "runbook"}),
    )]));
    llm.enqueue(assistant_text("alpha done"));
    // beta turn: skill body must be "beta-runbook is different"
    llm.enqueue(assistant_tool_call(vec![(
        "c2",
        "Skill",
        json!({"name": "runbook"}),
    )]));
    llm.enqueue(assistant_text("beta done"));

    let engine = Engine::new(
        llm,
        base,
        db.clone(),
        layout,
        EngineConfig::default_for("mock-model"),
    )
    .with_tool_factory(factory);

    engine
        .handle_turn(TurnRequest {
            tenant_id: alpha.clone(),
            project_id: project.clone(),
            thread_id: ThreadId::new("chat_alpha"),
            user_text: "use runbook".into(),
            message_id: None,        })
        .await
        .unwrap();
    engine
        .handle_turn(TurnRequest {
            tenant_id: beta.clone(),
            project_id: project.clone(),
            thread_id: ThreadId::new("chat_beta"),
            user_text: "use runbook".into(),
            message_id: None,        })
        .await
        .unwrap();

    fn tool_result_text(content: &[ContentBlock]) -> Option<String> {
        for b in content {
            if let ContentBlock::ToolResult { content, .. } = b {
                for inner in content {
                    if let ContentBlock::Text { text } = inner {
                        return Some(text.clone());
                    }
                }
            }
        }
        None
    }

    let alpha_msgs = db
        .recent_messages(&ThreadId::new("chat_alpha"), 10)
        .await
        .unwrap();
    let alpha_tool_msg = alpha_msgs
        .iter()
        .find(|m| matches!(m.role, Role::Tool))
        .unwrap();
    let alpha_text = tool_result_text(&alpha_tool_msg.content).unwrap();
    assert!(
        alpha_text.contains("alpha-runbook lives here"),
        "alpha must see its own runbook; got: {alpha_text}"
    );
    assert!(
        !alpha_text.contains("beta-runbook"),
        "alpha must not see beta's runbook"
    );

    let beta_msgs = db
        .recent_messages(&ThreadId::new("chat_beta"), 10)
        .await
        .unwrap();
    let beta_tool_msg = beta_msgs
        .iter()
        .find(|m| matches!(m.role, Role::Tool))
        .unwrap();
    let beta_text = tool_result_text(&beta_tool_msg.content).unwrap();
    assert!(
        beta_text.contains("beta-runbook is different"),
        "beta must see its own runbook; got: {beta_text}"
    );
    assert!(
        !beta_text.contains("alpha-runbook"),
        "beta must not see alpha's runbook"
    );
}

#[tokio::test]
async fn engine_without_factory_uses_static_tools() {
    // Backwards compat sanity: an engine constructed with the old API
    // (no factory) keeps using the static registry passed to `new`.
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let base = base_tool_registry();

    let llm = Arc::new(MockLlmClient::new());
    llm.enqueue(assistant_tool_call(vec![(
        "c1",
        "Skill",
        json!({"name": "anything"}),
    )]));
    llm.enqueue(assistant_text("recovered"));

    let engine = Engine::new(
        llm,
        base,
        db.clone(),
        layout,
        EngineConfig::default_for("mock-model"),
    );

    // No factory + no Skill tool in base ⇒ tool not found ⇒ tool_error
    // block, model recovers, turn completes.
    let outcome = engine
        .handle_turn(TurnRequest {
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("p"),
            thread_id: ThreadId::new("chat_x"),
            user_text: "no skill".into(),
            message_id: None,        })
        .await
        .unwrap();
    assert_eq!(outcome.iterations, 2);
    assert_eq!(outcome.assistant_text, "recovered");
}
