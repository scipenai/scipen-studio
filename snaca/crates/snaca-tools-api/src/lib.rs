//! `snaca-tools-api` — Tool trait + ToolRegistry + approval contract.
//!
//! Kept dependency-light so `snaca-mcp` and `snaca-skills` can depend on it
//! without pulling in heavyweight tool implementations from `snaca-tools`.
//!
//! ## Usage shape
//!
//! ```ignore
//! use snaca_tools_api::*;
//!
//! struct EchoTool;
//!
//! #[async_trait::async_trait]
//! impl Tool for EchoTool {
//!     fn name(&self) -> &str { "echo" }
//!     fn description(&self) -> &str { "Echo input back" }
//!     fn input_schema(&self) -> serde_json::Value {
//!         serde_json::json!({"type": "object", "properties": {"text": {"type": "string"}}})
//!     }
//!     fn capabilities(&self) -> ToolCapabilities { ToolCapabilities::default() }
//!     fn approval_requirement(&self) -> ApprovalRequirement { ApprovalRequirement::Never }
//!     async fn execute(&self, input: serde_json::Value, _ctx: &ToolContext)
//!         -> Result<ToolOutput, ToolError>
//!     {
//!         let text = input.get("text").and_then(|v| v.as_str()).unwrap_or("");
//!         Ok(ToolOutput::text(text))
//!     }
//! }
//! ```

pub mod context;
pub mod context_request;
pub mod error;
pub mod output;
pub mod registry;
pub mod tool;

pub use context::{OutboundFile, ReadRecord, ReadTracker, ToolContext};
pub use context_request::{ContextRequestError, ContextRequester};
pub use error::{ToolError, ToolResult};
pub use output::ToolOutput;
pub use registry::{ToolRegistry, ToolRegistryBuilder, ToolSchema};
pub use tool::{ApprovalRequirement, Tool, ToolCapabilities};
