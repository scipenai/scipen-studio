//! `snaca-server` — main process wiring + HTTP surface.
//!
//! Public surface for tests / embedding:
//! - [`Config`] — schema for `snaca.toml`
//! - [`Runtime`] — wires DB + LLM + tools + engine + plugins, exposes
//!   `/healthz`, owns dispatcher tasks. Tests build a `Runtime` directly
//!   with a mock LLM.

pub mod admin;
pub mod commands;
pub mod config;
pub mod dispatch;
pub mod gate;
pub mod outbox;
pub mod plugin_registry;
pub mod plugin_tool;
pub mod question_gate;
pub mod runtime;
pub mod scheduler;
pub mod text_question;
pub mod tool_factory;
pub mod typing;

pub use config::{Config, LoggingSection};
pub use gate::{build_approval_gate, log_approval_mode_at_startup, ChannelApprovalGate};
pub use plugin_registry::{PluginRegistry, PluginSpawner, PluginStatus};
pub use question_gate::{
    build_question_gate, log_question_mode_at_startup, ChannelQuestionGate, UnsupportedQuestionGate,
};
pub use runtime::{HttpHandle, Runtime};
pub use tool_factory::LayeredToolFactory;
pub use typing::ChannelTypingListener;
