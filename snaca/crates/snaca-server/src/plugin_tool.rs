//! `PluginTool` — adapter that exposes a plugin-advertised tool to the
//! engine's `ToolRegistry`. Mirrors `snaca-mcp::McpTool` but proxies through
//! a `PluginHandle` over JSON-RPC instead of an MCP client.
//!
//! Naming: the engine sees `plugin__<plugin_name>__<tool_name>`. The
//! reverse `tool.invoke` call uses the plugin-side `<tool_name>` only;
//! [`PluginTool::execute`] strips the prefix.
//!
//! Lifecycle: instances are constructed per-turn by [`LayeredToolFactory`]
//! from the snapshot returned by `PluginHandle::advertised_tools()`. When a
//! plugin restarts, the next turn rebuilds the factory and any stale tools
//! drop out automatically.

use async_trait::async_trait;
use snaca_channel_host::PluginHandle;
use snaca_channel_protocol::methods::ToolAdvertiseParams;
use snaca_tools_api::{
    error::{ToolError, ToolResult},
    output::ToolOutput,
    tool::{ApprovalRequirement, Tool, ToolCapabilities},
    context::ToolContext,
};
use serde_json::Value;
use std::sync::Arc;

pub struct PluginTool {
    qualified_name: String,
    /// Plugin-side name — what we pass back over `tool.invoke`.
    remote_name: String,
    description: String,
    input_schema: Value,
    is_read_only: bool,
    handle: PluginHandle,
}

impl PluginTool {
    /// Build the qualified name a tool from `plugin_name` + `tool_name`
    /// receives in the engine.
    pub fn qualified_name(plugin_name: &str, tool_name: &str) -> String {
        format!("plugin__{plugin_name}__{tool_name}")
    }

    pub fn from_advertised(
        handle: PluginHandle,
        params: ToolAdvertiseParams,
    ) -> Arc<dyn Tool> {
        let qualified_name = Self::qualified_name(handle.name(), &params.name);
        Arc::new(PluginTool {
            qualified_name,
            remote_name: params.name,
            description: params.description,
            input_schema: params.input_schema,
            is_read_only: params.is_read_only,
            handle,
        })
    }
}

#[async_trait]
impl Tool for PluginTool {
    fn name(&self) -> &str {
        &self.qualified_name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn input_schema(&self) -> Value {
        self.input_schema.clone()
    }

    fn capabilities(&self) -> ToolCapabilities {
        // We can't statically know what a plugin tool will touch. Conservative
        // default: assume network + commands so users see the right approval
        // prompt. Read-only tools surface that explicitly via the manifest
        // and get downgraded to read-only caps below.
        if self.is_read_only {
            ToolCapabilities::default()
        } else {
            ToolCapabilities {
                reads_filesystem: true,
                writes_filesystem: false,
                executes_commands: true,
                network_access: true,
            }
        }
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        if self.is_read_only {
            ApprovalRequirement::Never
        } else {
            // Mirror MCP precedent — first call asks, subsequent reuse
            // remembered decision until the user revokes.
            ApprovalRequirement::UnlessRemembered
        }
    }

    fn is_read_only(&self) -> bool {
        self.is_read_only
    }

    async fn execute(&self, input: Value, _ctx: &ToolContext) -> ToolResult {
        let result = self
            .handle
            .invoke_tool(self.remote_name.clone(), input)
            .await
            .map_err(|e| ToolError::Execution(format!("plugin invoke failed: {e}")))?;
        if result.is_error {
            return Err(ToolError::Execution(result.content));
        }
        Ok(ToolOutput::text(result.content))
    }
}
