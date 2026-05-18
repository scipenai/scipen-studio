//! Plugin-supplied tools end up in the engine's per-turn ToolRegistry.
//!
//! Spawns `snaca-cli mock-plugin --advertise-tool echo` via the real
//! `PluginRegistry`, late-binds it into a `LayeredToolFactory`, and asserts
//! that `factory.build(tenant, project)` exposes the tool under the
//! qualified `plugin__<plugin_name>__<tool>` name. The tool's `execute()`
//! then makes a real `tool.invoke` round-trip back to the mock subprocess.

use snaca_core::{ProjectId, SessionId, TenantId};
use snaca_engine::RuntimeToolFactory;
use snaca_mcp::McpManager;
use snaca_server::{LayeredToolFactory, PluginRegistry, PluginSpawner};
use snaca_skills::{SkillProvider, SkillRegistry};
use snaca_tools_api::context::ToolContext;
use snaca_tools_api::ToolRegistry;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

fn snaca_cli_binary() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let cargo = escargot::CargoBuild::new()
            .bin("snaca-cli")
            .package("snaca-cli")
            .current_target()
            .run()
            .expect("build snaca-cli");
        cargo.path().to_path_buf()
    })
    .clone()
}

/// `SkillProvider` that always returns no skills. Lets us exercise the
/// factory without depending on the workspace skill loader.
struct NoSkills;

#[async_trait::async_trait]
impl SkillProvider for NoSkills {
    async fn skills_for(
        &self,
        _tenant: &TenantId,
        _project: &ProjectId,
    ) -> SkillRegistry {
        SkillRegistry::empty()
    }
}

fn dummy_spawner(engine: Arc<snaca_engine::Engine>, db: snaca_state::Database) -> PluginSpawner {
    PluginSpawner {
        engine,
        db,
        tenant_id: TenantId::new("test"),
        typing_interval: Duration::from_millis(500),
    }
}

#[tokio::test]
async fn factory_includes_advertised_plugin_tool_and_invoke_round_trips() {
    let _ = tracing_subscriber::fmt::try_init();

    // 1. Build a minimal PluginRegistry with one plugin that advertises an
    //    `echo` tool.
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("state.sqlite");
    let db = snaca_state::Database::open(&db_path).await.unwrap();
    // Engine arc is required by PluginSpawner. We never actually drive a
    // turn through this engine — the test manually wires the factory and
    // calls `tool.execute(...)` directly.
    let llm: Arc<dyn snaca_llm::LlmClient> = Arc::new(NoopLlm);
    let workspace = snaca_workspace::WorkspaceLayout::new(tmp.path().to_path_buf()).unwrap();
    let engine_cfg = snaca_engine::EngineConfig::default_for("constant");
    let engine = Arc::new(snaca_engine::Engine::new(
        llm,
        ToolRegistry::empty(),
        db.clone(),
        workspace,
        engine_cfg,
    ));

    let spawner = dummy_spawner(engine, db);
    let plugins = PluginRegistry::new(spawner);

    let cli = snaca_cli_binary();
    let plugin_name = "test-tools";
    let plugin_config = snaca_channel_host::PluginConfig::builder(plugin_name, cli.to_string_lossy())
        .arg("mock-plugin")
        .arg("--advertise-tool")
        .arg("echo")
        .build();
    plugins.insert(plugin_config).await.unwrap();

    // 2. Build the factory and late-bind the registry.
    let mcp = Arc::new(McpManager::default());
    let skills: Arc<dyn SkillProvider> = Arc::new(NoSkills);
    let factory = LayeredToolFactory::new(ToolRegistry::empty(), mcp, skills);
    factory.set_plugins(plugins.clone());

    // 3. Wait for tool.advertise to land — the mock fires it right after
    //    initialize completes, but it's racy with the test poll.
    let tenant = TenantId::new("t");
    let project = ProjectId::from_raw("p");
    let qualified = format!("plugin__{plugin_name}__echo");
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut registry: Option<ToolRegistry> = None;
    while Instant::now() < deadline {
        let r = factory.build(&tenant, &project).await;
        if r.get(&qualified).is_some() {
            registry = Some(r);
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let registry = registry.expect("plugin tool not found in registry within 3s");
    let tool = registry.get(&qualified).unwrap();
    assert_eq!(tool.name(), qualified);
    assert!(tool.is_read_only());

    // 4. Invoke through the trait; this issues `tool.invoke` to the mock
    //    subprocess, which echoes back the JSON-stringified arguments.
    let ctx = ToolContext::new(
        tenant.clone(),
        project.clone(),
        SessionId::new(),
        tmp.path().to_path_buf(),
    );
    let output = tool
        .execute(serde_json::json!({"echo": "hello"}), &ctx)
        .await
        .unwrap();
    let text = output.render_text();
    assert!(
        text.contains("\"echo\":\"hello\""),
        "got: {text}"
    );

    // 5. Cleanup: drop registry refs and shut down the registry.
    drop(registry);
    drop(factory);
    plugins.shutdown_all().await;
}

/// LLM stub; never called in this test.
struct NoopLlm;

#[async_trait::async_trait]
impl snaca_llm::LlmClient for NoopLlm {
    fn provider_name(&self) -> &'static str {
        "noop"
    }
    fn model(&self) -> &str {
        "noop"
    }
    fn capabilities(&self) -> snaca_llm::ProviderCaps {
        snaca_llm::ProviderCaps::default()
    }
    async fn create_message(
        &self,
        _req: snaca_llm::MessageRequest,
    ) -> snaca_llm::LlmResult<snaca_llm::MessageResponse> {
        unreachable!("NoopLlm should not be invoked in this test")
    }
}
