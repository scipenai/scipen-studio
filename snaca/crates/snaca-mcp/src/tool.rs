//! `McpTool` — bridge from rmcp tool schemas to SNACA's `Tool` trait.
//!
//! One `McpTool` = one (server, tool) pair. The qualified tool name
//! presented to the LLM is `mcp__<server>__<tool>`.
//!
//! Result conversion: rmcp returns a `CallToolResult` whose `content` is a
//! list of typed blocks (text / image / embedded resource). We collapse
//! them into a single text payload (text concatenated, non-text blocks
//! summarised) because SNACA's `ToolOutput::Text` can't natively model
//! mixed content. M3 will likely upgrade this to surface images directly.

use crate::client::McpClient;
use crate::config::{qualified_tool_name, split_qualified_name};
use crate::error::McpError;
use async_trait::async_trait;
use rmcp::model::{Content, RawContent, Tool as RmcpTool};
use serde_json::Value;
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use std::sync::Arc;
use tracing::warn;

pub struct McpTool {
    qualified_name: String,
    description: String,
    input_schema: Value,
    server: String,
    /// Original (unqualified) tool name as advertised by the MCP server.
    remote_name: String,
    client: Arc<McpClient>,
}

impl McpTool {
    /// Construct one bridged tool. Returns `None` when the upstream's
    /// advertised name collapses to an empty slug under the segment
    /// sanitiser (e.g. all-separator names) — those would round-trip as
    /// invalid qualified names and the LLM couldn't address the tool
    /// anyway. Callers (`McpPool::tools_for`) `filter_map` over the
    /// result so one pathological tool doesn't sink the whole server.
    pub fn new(client: Arc<McpClient>, tool: RmcpTool) -> Option<Self> {
        let server = client.name().to_string();
        let remote_name = tool.name.to_string();
        let qualified_name = qualified_tool_name(&server, &remote_name);
        // The sanitiser strips upstream's text down to `[a-zA-Z0-9_]`;
        // if nothing survived, the qualified split would yield an empty
        // tool segment. Drop rather than silently surface an invalid name.
        if split_qualified_name(&qualified_name)
            .map(|(_, t)| t.is_empty())
            .unwrap_or(true)
        {
            warn!(
                server = %server,
                upstream_name = %remote_name,
                "dropping MCP tool: upstream name normalises to an empty slug"
            );
            return None;
        }
        let description = tool
            .description
            .as_ref()
            .map(|s| s.to_string())
            .unwrap_or_default();
        let schema_owned: serde_json::Map<String, Value> = (*tool.input_schema).clone();
        let input_schema = Value::Object(schema_owned);
        Some(Self {
            qualified_name,
            description,
            input_schema,
            server,
            remote_name,
            client,
        })
    }

    pub fn qualified_name(&self) -> &str {
        &self.qualified_name
    }

    pub fn server(&self) -> &str {
        &self.server
    }

    pub fn remote_name(&self) -> &str {
        &self.remote_name
    }
}

#[async_trait]
impl Tool for McpTool {
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
        // Conservative default: assume the tool may touch the network
        // and execute side effects. Users opt into looser policies via
        // tenant settings (planned for M3).
        ToolCapabilities {
            reads_filesystem: true,
            writes_filesystem: false,
            executes_commands: true,
            network_access: true,
        }
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        // Until we wire per-server policy, every MCP tool requires approval
        // by default. Engine still executes if the channel can't gate.
        ApprovalRequirement::UnlessRemembered
    }

    fn is_read_only(&self) -> bool {
        // Without per-tool metadata we can't safely claim read-only.
        false
    }

    async fn execute(&self, input: Value, _ctx: &ToolContext) -> ToolResult {
        let raw = self
            .client
            .call_tool(&self.remote_name, input)
            .await
            .map_err(map_call_error)?;

        if raw.is_error.unwrap_or(false) {
            return Err(ToolError::Execution(render_content(&raw.content)));
        }

        if raw.content.is_empty() {
            // Some servers only set `structured_content`; surface that as JSON.
            if let Some(structured) = raw.structured_content {
                return Ok(ToolOutput::json(structured));
            }
            return Ok(ToolOutput::text("<no content>".to_string()));
        }
        Ok(ToolOutput::text(render_content(&raw.content)))
    }
}

fn map_call_error(err: McpError) -> ToolError {
    match err {
        McpError::ToolCall { reason, .. } => ToolError::Execution(reason),
        // Surface timeouts as a recoverable execution error rather than
        // an opaque `Other`. The model sees a short, actionable message
        // ("timed out after Ns") and can decide whether to retry or
        // switch approaches. The whole turn isn't aborted — the MCP
        // server is just one tool among many.
        McpError::Timeout {
            tool, timeout_secs, ..
        } => ToolError::Execution(format!(
            "mcp tool `{tool}` timed out after {timeout_secs}s"
        )),
        McpError::Serde(e) => ToolError::InvalidInput(e.to_string()),
        other => ToolError::Other(other.to_string()),
    }
}

/// Collapse a list of MCP content blocks into a single string the LLM can
/// consume. Non-text blocks become a one-line marker so the model knows
/// data is present but isn't shown raw.
fn render_content(content: &[Content]) -> String {
    let mut out = String::new();
    for block in content {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        match &block.raw {
            RawContent::Text(t) => out.push_str(&t.text),
            RawContent::Image(_) => out.push_str("<image content omitted>"),
            RawContent::Resource(_) => out.push_str("<embedded resource>"),
            RawContent::Audio(_) => out.push_str("<audio content omitted>"),
            RawContent::ResourceLink(link) => {
                out.push_str(&format!("<resource link: {}>", link.uri));
            }
        }
    }
    out
}
