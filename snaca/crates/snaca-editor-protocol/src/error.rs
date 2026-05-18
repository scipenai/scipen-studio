//! Editor-protocol error codes.
//!
//! Mirrors the wire spec in
//! [`docs/editor-protocol.md §14`](../../../docs/editor-protocol.md#14-错误码).
//! Standard JSON-RPC codes (-32700..-32603) plus application codes in the
//! -32000..-32099 reserved range.

use crate::jsonrpc::JsonRpcError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "i32", from = "i32")]
pub enum ErrorCode {
    // --- JSON-RPC standard ---
    /// -32700: invalid JSON.
    ParseError,
    /// -32600: not a valid JSON-RPC 2.0 message.
    InvalidRequest,
    /// -32601: method not implemented.
    MethodNotFound,
    /// -32602: required field missing or wrong type.
    InvalidParams,
    /// -32603: handler crashed.
    InternalError,

    // --- Editor-protocol application errors (-32000..-32099) ---
    /// -32000: `init` not yet completed.
    NotInitialized,
    /// -32001: `session_id` unknown.
    SessionNotFound,
    /// -32002: `thread_id` unknown.
    ThreadNotFound,
    /// -32003: `turn_id` unknown or already terminated.
    TurnNotFound,
    /// -32004: `proposal_id` unknown.
    ProposalNotFound,
    /// -32005: target thread has an in-flight turn.
    InflightTurnBusy,
    /// -32006: capability not negotiated.
    CapabilityNotSupported,
    /// -32007: snaca_config invalid.
    ConfigInvalid,
    /// -32008: workspace_root / metadata_root invalid (e.g. nested, missing).
    WorkspaceInvalid,
    /// -32009: upstream LLM auth refused.
    LlmAuthFailed,
    /// -32010: context overflow even after compaction.
    LlmContextOverflow,
    /// -32011: upstream LLM rate-limited.
    LlmRateLimited,
    /// -32012: file content drifted from `base_hash`.
    BaseHashMismatch,
    /// -32013: turn / tool cancelled.
    Cancelled,
    /// -32014: operation timed out (context.respond, tool exec, …).
    Timeout,
    /// Anything else — preserved verbatim on the wire.
    Other(i32),
}

impl ErrorCode {
    pub const fn as_i32(self) -> i32 {
        match self {
            ErrorCode::ParseError => -32700,
            ErrorCode::InvalidRequest => -32600,
            ErrorCode::MethodNotFound => -32601,
            ErrorCode::InvalidParams => -32602,
            ErrorCode::InternalError => -32603,

            ErrorCode::NotInitialized => -32000,
            ErrorCode::SessionNotFound => -32001,
            ErrorCode::ThreadNotFound => -32002,
            ErrorCode::TurnNotFound => -32003,
            ErrorCode::ProposalNotFound => -32004,
            ErrorCode::InflightTurnBusy => -32005,
            ErrorCode::CapabilityNotSupported => -32006,
            ErrorCode::ConfigInvalid => -32007,
            ErrorCode::WorkspaceInvalid => -32008,
            ErrorCode::LlmAuthFailed => -32009,
            ErrorCode::LlmContextOverflow => -32010,
            ErrorCode::LlmRateLimited => -32011,
            ErrorCode::BaseHashMismatch => -32012,
            ErrorCode::Cancelled => -32013,
            ErrorCode::Timeout => -32014,

            ErrorCode::Other(c) => c,
        }
    }

    pub const fn symbol(self) -> &'static str {
        match self {
            ErrorCode::ParseError => "parse_error",
            ErrorCode::InvalidRequest => "invalid_request",
            ErrorCode::MethodNotFound => "method_not_found",
            ErrorCode::InvalidParams => "invalid_params",
            ErrorCode::InternalError => "internal_error",
            ErrorCode::NotInitialized => "not_initialized",
            ErrorCode::SessionNotFound => "session_not_found",
            ErrorCode::ThreadNotFound => "thread_not_found",
            ErrorCode::TurnNotFound => "turn_not_found",
            ErrorCode::ProposalNotFound => "proposal_not_found",
            ErrorCode::InflightTurnBusy => "inflight_turn_busy",
            ErrorCode::CapabilityNotSupported => "capability_not_supported",
            ErrorCode::ConfigInvalid => "config_invalid",
            ErrorCode::WorkspaceInvalid => "workspace_invalid",
            ErrorCode::LlmAuthFailed => "llm_auth_failed",
            ErrorCode::LlmContextOverflow => "llm_context_overflow",
            ErrorCode::LlmRateLimited => "llm_rate_limited",
            ErrorCode::BaseHashMismatch => "base_hash_mismatch",
            ErrorCode::Cancelled => "cancelled",
            ErrorCode::Timeout => "timeout",
            ErrorCode::Other(_) => "other",
        }
    }
}

impl From<i32> for ErrorCode {
    fn from(code: i32) -> Self {
        match code {
            -32700 => ErrorCode::ParseError,
            -32600 => ErrorCode::InvalidRequest,
            -32601 => ErrorCode::MethodNotFound,
            -32602 => ErrorCode::InvalidParams,
            -32603 => ErrorCode::InternalError,
            -32000 => ErrorCode::NotInitialized,
            -32001 => ErrorCode::SessionNotFound,
            -32002 => ErrorCode::ThreadNotFound,
            -32003 => ErrorCode::TurnNotFound,
            -32004 => ErrorCode::ProposalNotFound,
            -32005 => ErrorCode::InflightTurnBusy,
            -32006 => ErrorCode::CapabilityNotSupported,
            -32007 => ErrorCode::ConfigInvalid,
            -32008 => ErrorCode::WorkspaceInvalid,
            -32009 => ErrorCode::LlmAuthFailed,
            -32010 => ErrorCode::LlmContextOverflow,
            -32011 => ErrorCode::LlmRateLimited,
            -32012 => ErrorCode::BaseHashMismatch,
            -32013 => ErrorCode::Cancelled,
            -32014 => ErrorCode::Timeout,
            other => ErrorCode::Other(other),
        }
    }
}

impl From<ErrorCode> for i32 {
    fn from(code: ErrorCode) -> Self {
        code.as_i32()
    }
}

/// Application-level protocol error. Convertible to [`JsonRpcError`] for
/// response framing.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
    pub data: Option<serde_json::Value>,
}

impl ProtocolError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None }
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }

    /// Convenience constructors for common cases.
    pub fn not_initialized() -> Self {
        Self::new(ErrorCode::NotInitialized, "init not yet completed")
    }
    pub fn method_not_found(method: impl AsRef<str>) -> Self {
        Self::new(
            ErrorCode::MethodNotFound,
            format!("method not found: {}", method.as_ref()),
        )
    }
    pub fn invalid_params(detail: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidParams, detail)
    }
    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(ErrorCode::InternalError, detail)
    }
    pub fn session_not_found(id: impl AsRef<str>) -> Self {
        Self::new(
            ErrorCode::SessionNotFound,
            format!("session not found: {}", id.as_ref()),
        )
    }
    pub fn thread_not_found(id: impl AsRef<str>) -> Self {
        Self::new(
            ErrorCode::ThreadNotFound,
            format!("thread not found: {}", id.as_ref()),
        )
    }
    pub fn inflight_turn_busy() -> Self {
        Self::new(ErrorCode::InflightTurnBusy, "thread has in-flight turn")
    }
}

impl From<ProtocolError> for JsonRpcError {
    fn from(err: ProtocolError) -> Self {
        let mut e = JsonRpcError::new(err.code.as_i32(), err.message);
        if let Some(data) = err.data {
            e = e.with_data(data);
        }
        e
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_codes_roundtrip() {
        for c in [
            ErrorCode::ParseError,
            ErrorCode::InvalidParams,
            ErrorCode::InternalError,
        ] {
            assert_eq!(ErrorCode::from(c.as_i32()), c);
        }
    }

    #[test]
    fn application_codes_roundtrip() {
        for c in [
            ErrorCode::NotInitialized,
            ErrorCode::SessionNotFound,
            ErrorCode::InflightTurnBusy,
            ErrorCode::BaseHashMismatch,
            ErrorCode::Cancelled,
            ErrorCode::Timeout,
        ] {
            assert_eq!(ErrorCode::from(c.as_i32()), c);
        }
    }

    #[test]
    fn unknown_code_preserves_value() {
        let c = ErrorCode::from(-99999);
        assert_eq!(c, ErrorCode::Other(-99999));
        assert_eq!(c.as_i32(), -99999);
    }

    #[test]
    fn protocol_error_converts_to_jsonrpc_error() {
        let e = ProtocolError::inflight_turn_busy();
        let je: JsonRpcError = e.into();
        assert_eq!(je.code, -32005);
        assert!(je.message.contains("in-flight"));
    }
}
