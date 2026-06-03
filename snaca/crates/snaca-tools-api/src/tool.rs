//! Core `Tool` trait and capability/approval shapes.

use crate::context::ToolContext;
use crate::error::ToolResult;
use async_trait::async_trait;
use serde_json::Value;

/// Declarative description of what a tool can touch — used to compute the
/// default approval requirement and to render UI hints (e.g. "this tool will
/// run shell commands").
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolCapabilities {
    pub reads_filesystem: bool,
    pub writes_filesystem: bool,
    pub executes_commands: bool,
    pub network_access: bool,
}

impl ToolCapabilities {
    pub const fn read_only_filesystem() -> Self {
        Self {
            reads_filesystem: true,
            writes_filesystem: false,
            executes_commands: false,
            network_access: false,
        }
    }

    pub const fn writes_filesystem() -> Self {
        Self {
            reads_filesystem: true,
            writes_filesystem: true,
            executes_commands: false,
            network_access: false,
        }
    }

    pub const fn shell() -> Self {
        Self {
            reads_filesystem: true,
            writes_filesystem: true,
            executes_commands: true,
            network_access: true,
        }
    }
}

/// When the engine should prompt the user before running this tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalRequirement {
    /// Never requires approval (e.g. read-only tools).
    Never,
    /// Always requires approval, no caching.
    Always,
    /// Requires approval the first time, then honors a project-level allow
    /// decision until the user revokes it.
    UnlessRemembered,
}

#[async_trait]
pub trait Tool: Send + Sync {
    /// Tool identifier used by the LLM (e.g. `"Read"`, `"mcp__fs__read_file"`).
    fn name(&self) -> &str;

    /// One-line description shown to the LLM in tool listings.
    fn description(&self) -> &str;

    /// JSON Schema for the `input` argument. Engine forwards this to the
    /// LLM provider verbatim. Cache-friendly — keep the value stable.
    fn input_schema(&self) -> Value;

    fn capabilities(&self) -> ToolCapabilities;

    fn approval_requirement(&self) -> ApprovalRequirement;

    /// Convenience — true iff capabilities indicate no side effects.
    fn is_read_only(&self) -> bool {
        let c = self.capabilities();
        !c.writes_filesystem && !c.executes_commands
    }

    /// Run the tool. The engine never invokes this without first checking
    /// approval; tools must still defensively validate inputs (path
    /// traversal, allowed flags, etc.).
    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult;
}
