//! `snaca-channel-host` — IM plugin subprocess manager.
//!
//! M1 components (this crate as of M1):
//! - [`PluginConfig`]   — configuration for a plugin (command/args/env/cwd).
//! - [`PluginHandle`]   — running plugin: spawn, call methods, take inbound stream, shutdown.
//! - [`InboundEvent`]   — typed plugin → host events after auth + parameter parsing.
//! - [`ChannelError`]   — error type.
//!
//! M2 components (planned, not in this file yet):
//! - `PluginRegistry`   — load multiple plugins from server config.
//! - `ChannelRouter`    — dispatch inbound events to engine sessions by tenant/chat.
//! - `ApprovalRegistry` — `callback_token -> Future<ApprovalDecision>`.
//! - Restart-on-exit policy.

pub mod approval;
pub mod config;
pub mod error;
pub mod inbound;
pub mod supervisor;

pub use approval::ApprovalRegistry;
pub use config::{PluginConfig, PluginConfigBuilder};
pub use error::{ChannelError, ChannelResult};
pub use inbound::InboundEvent;
pub use supervisor::PluginHandle;
