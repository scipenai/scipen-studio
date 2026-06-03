//! `snaca-server` — main process wiring + HTTP surface.
//!
//! Public surface for tests / embedding:
//! - [`Config`] — schema for `snaca.toml`
//! - [`Runtime`] — wires DB + LLM + tools + engine + plugins, exposes
//!   `/healthz`, owns dispatcher tasks. Tests build a `Runtime` directly
//!   with a mock LLM.

pub mod commands;
pub mod config;
pub mod dispatch;
pub mod gate;
pub mod outbox;
pub mod plugin_registry;
pub mod plugin_tool;
pub mod runtime;
pub mod scheduler;
pub mod tool_factory;
pub mod typing;

pub use config::Config;
pub use gate::{build_approval_gate, log_approval_mode_at_startup, ChannelApprovalGate};
pub use plugin_registry::{PluginRegistry, PluginSpawner, PluginStatus};
pub use runtime::{HttpHandle, Runtime};
pub use tool_factory::LayeredToolFactory;
pub use typing::ChannelTypingListener;
