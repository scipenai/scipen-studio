//! `snaca-channel-protocol` — IM plugin wire protocol.
//!
//! See [`docs/im-plugin-protocol.md`](../../docs/im-plugin-protocol.md) for
//! the spec; this crate is the canonical Rust mirror. No runtime — only
//! types, codecs, and method-name constants. Both `snaca-channel-host` and
//! Rust-language plugins consume these.
//!
//! ## Layout
//! - [`jsonrpc`] — JSON-RPC 2.0 envelope (request/response/notification).
//! - [`errors`] — error codes used in `JsonRpcError.code`.
//! - [`manifest`] — `PluginManifest` returned from `initialize`.
//! - [`methods`] — typed params/results for each method, plus method-name
//!   constants in `methods::host_to_plugin` and `methods::plugin_to_host`.
//! - [`codec`] — newline-delimited JSON-RPC framing helpers.

pub mod codec;
pub mod errors;
pub mod jsonrpc;
pub mod manifest;
pub mod methods;

pub use errors::ErrorCode;
pub use jsonrpc::{JsonRpcError, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, RequestId};
pub use manifest::{ChannelCapabilities, PluginInfo, PluginManifest};

/// The protocol version this crate implements.
pub const PROTOCOL_VERSION: &str = "1.0";
