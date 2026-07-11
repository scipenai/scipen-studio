//! `snaca-editor-protocol` — Editor-mode wire protocol.
//!
//! The canonical Rust mirror of
//! [`docs/editor-protocol.md`](../../../docs/editor-protocol.md). Defines the
//! types, codec, dispatcher, and method-name constants used by
//! `snaca-editor` (the SNACA editor-mode sidecar binary) and any host
//! (today: SciPen Studio Electron main process).
//!
//! This crate is **runtime-free for the protocol surface**: types are pure
//! serde, the dispatcher is generic over an async [`MessageHandler`] trait,
//! and the codec uses byte slices. The binary downstream wires this onto
//! tokio stdio.
//!
//! ## Layout
//!
//! - [`jsonrpc`] — JSON-RPC 2.0 envelope (request / response / notification)
//! - [`codec`] — newline-delimited framing helpers (encode / decode)
//! - [`error`] — `ProtocolError` and `ErrorCode` (codes -32xxx)
//! - [`id`] — type-wrapped UUIDs (`SessionId`, `TurnId`, …)
//! - [`types`] — shared payload types ([`Range`], [`ChatContext`],
//!   [`LineHunk`], capabilities, config)
//! - [`messages`] — typed `Params` / `Result` for each method
//! - [`routing`] — [`Method`] enum + [`MessageHandler`] trait + `Dispatcher`
//!
//! ## Versioning
//!
//! [`PROTOCOL_VERSION`] is the wire version this crate ships. Same-major
//! differences are allowed (capabilities negotiation handles the gap);
//! different majors are a hard refusal.

pub mod codec;
pub mod error;
pub mod id;
pub mod jsonrpc;
pub mod messages;
pub mod routing;
pub mod types;

pub use error::{ErrorCode, ProtocolError};
pub use id::{ProposalId, RequestId as ContextRequestId, SessionId, ThreadId, ToolCallId, TurnId};
pub use jsonrpc::{
    JsonRpcError, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse,
    JsonRpcRequestId,
};
pub use routing::{Dispatcher, MessageHandler, Method};

/// Editor-protocol wire version implemented by this crate.
pub const PROTOCOL_VERSION: &str = "1.0";
