//! MCP runtime glue for the editor sidecar.
//!
//! Bridges the wire-shape `SnacaConfig.mcp_servers` (from the editor
//! protocol) into a live `snaca_mcp::McpManager` and exposes the
//! resulting tools to the engine through a `RuntimeToolFactory`.
//!
//! Mirrors `snaca-server::tool_factory::LayeredToolFactory` but stripped
//! down: the editor sidecar surfaces base tools + MCP tools only. Skills
//! and plugins are server-only today.

use async_trait::async_trait;
use snaca_core::{ProjectId, TenantId};
use snaca_editor_protocol::types::config::{
    McpServerConfig as WireMcpServerConfig, McpTransport as WireMcpTransport,
};
use snaca_engine::RuntimeToolFactory;
use snaca_mcp::config::McpServerConfig as RuntimeMcpServerConfig;
use snaca_mcp::McpManager;
use snaca_mcp::McpTransport as RuntimeMcpTransport;
use snaca_skills::SkillProvider;
use snaca_tools::SkillTool;
use snaca_tools_api::{ToolRegistry, ToolRegistryBuilder};
use std::collections::HashMap;
use std::sync::Arc;

/// Translate the protocol-level MCP config (flat fields + single-variant
/// transport enum) into the runtime form used by `snaca-mcp`
/// (wrapped Http variant carrying url/auth/headers). The protocol shape
/// is intentionally minimal — fields not in the wire (`cwd`,
/// `call_timeout_secs`, `custom_headers`, `auth_token`) stay at their
/// defaults; they can be lifted into the wire later without breaking
/// existing configs.
pub fn convert_protocol_to_mcp_config(p: &WireMcpServerConfig) -> RuntimeMcpServerConfig {
    let transport = match p.transport {
        WireMcpTransport::Stdio => RuntimeMcpTransport::Stdio,
        WireMcpTransport::Http => RuntimeMcpTransport::Http {
            url: p.url.clone().unwrap_or_default(),
            auth_token: None,
            custom_headers: HashMap::new(),
        },
    };
    // protocol uses BTreeMap for stable wire order; runtime uses HashMap
    let env: HashMap<String, String> = p.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    RuntimeMcpServerConfig {
        name: p.name.clone(),
        transport,
        command: p.command.clone().unwrap_or_default(),
        args: p.args.clone(),
        env,
        cwd: None,
        init_timeout_secs: p.init_timeout_secs,
        call_timeout_secs: None,
    }
}

/// `RuntimeToolFactory` for the editor sidecar.
///
/// `base` is captured at session.open and reused every turn — base
/// tools are stateless. `mcp` and `skills` are shared (`Arc<...>`)
/// because the trait method is `&self`; both own their own per-call
/// caching (MCP via connection pool + reaper; skills via LayoutSkill
/// Provider's TTL cache).
pub struct EditorToolFactory {
    pub base: ToolRegistry,
    pub mcp: Arc<McpManager>,
    pub skills: Arc<dyn SkillProvider>,
}

#[async_trait]
impl RuntimeToolFactory for EditorToolFactory {
    async fn build(&self, tenant: &TenantId, project: &ProjectId) -> ToolRegistry {
        let mut builder = ToolRegistryBuilder::default();
        // Base tools first — always available.
        for name in self.base.names().map(String::from).collect::<Vec<_>>() {
            if let Some(t) = self.base.get(&name) {
                builder = builder.add_arc(t);
            }
        }
        // MCP tools — `tools_for` swallows per-server failures so a
        // misconfigured MCP server can't take the whole turn down.
        for tool in self.mcp.tools_for(tenant, project).await {
            builder = builder.add_arc(tool);
        }
        // Skills — adapted to a single `SkillTool` so the LLM can
        // dispatch by name (tenant + project rank already resolved
        // inside the provider). Skip when no skills loaded so the
        // tool surface stays minimal.
        let skills_registry = self.skills.skills_for(tenant, project).await;
        if !skills_registry.is_empty() {
            builder = builder.add(SkillTool::new(skills_registry));
        }
        builder.build()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn converts_stdio_with_env() {
        let mut env = BTreeMap::new();
        env.insert("HOME".into(), "/tmp".into());
        let wire = WireMcpServerConfig {
            name: "fs".into(),
            transport: WireMcpTransport::Stdio,
            command: Some("npx".into()),
            args: vec!["-y".into(), "filesystem".into()],
            env,
            url: None,
            init_timeout_secs: Some(15),
        };
        let runtime = convert_protocol_to_mcp_config(&wire);
        assert_eq!(runtime.name, "fs");
        assert_eq!(runtime.command, "npx");
        assert_eq!(runtime.args, vec!["-y", "filesystem"]);
        assert_eq!(runtime.env.get("HOME"), Some(&"/tmp".to_string()));
        assert_eq!(runtime.init_timeout_secs, Some(15));
        assert!(matches!(runtime.transport, RuntimeMcpTransport::Stdio));
    }

    #[test]
    fn converts_http_unwrapping_url() {
        let wire = WireMcpServerConfig {
            name: "remote".into(),
            transport: WireMcpTransport::Http,
            command: None,
            args: vec![],
            env: BTreeMap::new(),
            url: Some("https://example.com/mcp".into()),
            init_timeout_secs: None,
        };
        let runtime = convert_protocol_to_mcp_config(&wire);
        match runtime.transport {
            RuntimeMcpTransport::Http { url, auth_token, custom_headers } => {
                assert_eq!(url, "https://example.com/mcp");
                assert!(auth_token.is_none());
                assert!(custom_headers.is_empty());
            }
            _ => panic!("expected Http transport"),
        }
    }

    #[tokio::test]
    async fn factory_returns_base_when_no_mcp() {
        // Empty McpManager + empty skills provider means no extra
        // layers — factory passes the base registry through verbatim.
        let base = snaca_tools::base_tool_registry();
        let base_names: Vec<String> = base.names().map(String::from).collect();
        let factory = EditorToolFactory {
            base,
            mcp: Arc::new(McpManager::from_configs(&[])),
            skills: Arc::new(snaca_skills::StaticSkillProvider::empty()),
        };
        let tenant = TenantId::new("local");
        let project = ProjectId::from_raw("test");
        let registry = factory.build(&tenant, &project).await;
        let got: Vec<String> = registry.names().map(String::from).collect();
        let mut expected = base_names.clone();
        expected.sort();
        let mut got_sorted = got.clone();
        got_sorted.sort();
        assert_eq!(got_sorted, expected);
    }
}
