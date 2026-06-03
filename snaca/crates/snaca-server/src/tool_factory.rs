//! Server-side `RuntimeToolFactory`.
//!
//! Composes the per-turn tool registry from four sources:
//! - **base**: tenant-agnostic built-in tools (Read/Write/Edit/...).
//!   Cloned per turn — `ToolRegistry` is `Arc`-backed so this is cheap.
//! - **MCP**: tools surfaced by the connected MCP servers, scoped per
//!   `(tenant, project)`. The first turn for a tenant/project pays
//!   subprocess startup; subsequent turns reuse the cached connection.
//! - **Skills**: `SkillTool` constructed from the registry returned by
//!   `SkillProvider::skills_for(tenant, project)`.
//! - **Plugin tools**: tools advertised by IM channel plugins via
//!   `tool.advertise`. Currently scoped *globally* per (host, plugin) —
//!   an OpenClaw channel plugin's tools apply to every tenant the host
//!   serves, mirroring MCP's "subprocess per server" model.

use crate::plugin_registry::PluginRegistry;
use crate::plugin_tool::PluginTool;
use async_trait::async_trait;
use snaca_core::{ProjectId, TenantId};
use snaca_engine::RuntimeToolFactory;
use snaca_mcp::McpManager;
use snaca_skills::SkillProvider;
use snaca_tools::SkillTool;
use snaca_tools_api::{ToolRegistry, ToolRegistryBuilder};
use std::sync::Arc;

pub struct LayeredToolFactory {
    base: ToolRegistry,
    mcp: Arc<McpManager>,
    skills: Arc<dyn SkillProvider>,
    /// Plugin registry is wired *after* construction because of a setup-
    /// time cycle: PluginRegistry's spawner closes over the engine, which
    /// owns this factory. Until set, plugin tools are simply absent from
    /// the per-turn registry — the engine still works with built-ins, MCP
    /// and skills.
    plugins: tokio::sync::OnceCell<Arc<PluginRegistry>>,
}

impl LayeredToolFactory {
    pub fn new(
        base: ToolRegistry,
        mcp: Arc<McpManager>,
        skills: Arc<dyn SkillProvider>,
    ) -> Self {
        Self {
            base,
            mcp,
            skills,
            plugins: tokio::sync::OnceCell::new(),
        }
    }

    /// Late-bind the plugin registry. Idempotent on identical pointers; a
    /// second call with a different registry is a no-op (logged) rather
    /// than a panic — production calls this exactly once during `Runtime::build`.
    pub fn set_plugins(&self, plugins: Arc<PluginRegistry>) {
        if self.plugins.set(plugins).is_err() {
            tracing::warn!("LayeredToolFactory::set_plugins called twice; keeping first registration");
        }
    }
}

#[async_trait]
impl RuntimeToolFactory for LayeredToolFactory {
    async fn build(&self, tenant: &TenantId, project: &ProjectId) -> ToolRegistry {
        let mut b = ToolRegistryBuilder::default();
        // Base tools — same for every (tenant, project).
        let names: Vec<String> = self.base.names().map(String::from).collect();
        for name in names {
            if let Some(t) = self.base.get(&name) {
                b = b.add_arc(t);
            }
        }
        // MCP tools — scoped per (tenant, project). Each tenant gets its
        // own subprocess for every configured MCP server.
        for tool in self.mcp.tools_for(tenant, project).await {
            b = b.add_arc(tool);
        }
        // Skills — scoped per (tenant, project) via the provider.
        let skills = self.skills.skills_for(tenant, project).await;
        if !skills.is_empty() {
            b = b.add(SkillTool::new(skills));
        }
        // Plugin-advertised tools — snapshot every running plugin's
        // advertised set and wrap as `PluginTool`. Plugins that have not
        // advertised any tools contribute nothing. Stale tools from
        // crashed plugins disappear automatically: PluginRegistry only
        // returns live handles, and re-advertise on restart fills the
        // table back in. The registry is `OnceCell`-bound after engine
        // construction; until it's set we just skip this layer.
        if let Some(plugins) = self.plugins.get() {
            for handle in plugins.handles().await {
                for params in handle.advertised_tools().await {
                    b = b.add_arc(PluginTool::from_advertised(handle.clone(), params));
                }
            }
        }
        b.build()
    }
}
