//! Error codes used in `JsonRpcError.code`.
//!
//! Constants mirror the wire spec in
//! [`docs/im-plugin-protocol.md`](../../docs/im-plugin-protocol.md). Use the
//! [`ErrorCode`] helper to convert between symbol and number cleanly.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "i32", from = "i32")]
pub enum ErrorCode {
    /// -32700: invalid JSON.
    ParseError,
    /// -32600: not a valid JSON-RPC 2.0 message.
    InvalidRequest,
    /// -32601: method not implemented (or capability not advertised).
    MethodNotFound,
    /// -32602: required field missing or wrong type.
    InvalidParams,
    /// -32603: plugin or host crashed.
    InternalError,
    /// -32000: missing or invalid `SNACA_PLUGIN_TOKEN`.
    AuthFailed,
    /// -32001: IM platform rejected the call due to rate limit.
    RateLimited,
    /// -32002: underlying IM platform error; details in `data`.
    PlatformError,
    /// -32003: method called before `initialize` completed.
    NotInitialized,
    /// Anything else from the wire — preserved verbatim.
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
            ErrorCode::AuthFailed => -32000,
            ErrorCode::RateLimited => -32001,
            ErrorCode::PlatformError => -32002,
            ErrorCode::NotInitialized => -32003,
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
            ErrorCode::AuthFailed => "auth_failed",
            ErrorCode::RateLimited => "rate_limited",
            ErrorCode::PlatformError => "platform_error",
            ErrorCode::NotInitialized => "not_initialized",
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
            -32000 => ErrorCode::AuthFailed,
            -32001 => ErrorCode::RateLimited,
            -32002 => ErrorCode::PlatformError,
            -32003 => ErrorCode::NotInitialized,
            other => ErrorCode::Other(other),
        }
    }
}

impl From<ErrorCode> for i32 {
    fn from(code: ErrorCode) -> Self {
        code.as_i32()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_codes_roundtrip() {
        for code in [
            ErrorCode::ParseError,
            ErrorCode::MethodNotFound,
            ErrorCode::AuthFailed,
            ErrorCode::PlatformError,
        ] {
            assert_eq!(ErrorCode::from(code.as_i32()), code);
        }
    }

    #[test]
    fn unknown_code_becomes_other() {
        let c = ErrorCode::from(-12345);
        assert_eq!(c, ErrorCode::Other(-12345));
        assert_eq!(c.as_i32(), -12345);
    }
}
