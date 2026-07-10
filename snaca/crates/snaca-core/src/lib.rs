//! `snaca-core` — foundational types for SNACA.
//!
//! This crate has zero internal dependencies. Everything else builds on top.
//! Anything that touches more than one upper-layer crate should live here.
//!
//! Layout:
//! - [`ids`]          — typed ID newtypes and project-ID derivation
//! - [`content`]      — provider-agnostic [`ContentBlock`] (text/thinking/tool/image)
//! - [`message`]      — [`Role`] + [`Message`] (the canonical conversation unit)
//! - [`tool_schema`]  — JSON-Schema-shaped tool description shared with LLM + tools
//! - [`usage`]        — token usage accounting
//! - [`error`]        — top-level error type and `Result` alias

pub mod content;
pub mod error;
pub mod ids;
pub mod message;
pub mod tool_schema;
pub mod usage;

pub use content::{ContentBlock, ImageSource};
pub use error::{Error, Result};
pub use ids::{short_uuid, MessageId, ProjectId, SessionId, TenantId, ThreadId, ToolUseId};
pub use message::{Message, Role};
pub use tool_schema::ToolSchema;
pub use usage::Usage;
