//! Error types for the channel host.

use snaca_channel_protocol::codec::CodecError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ChannelError {
    #[error("plugin io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("protocol error: {0}")]
    Protocol(#[from] CodecError),

    #[error("plugin returned error {code}: {message}")]
    Plugin { code: i32, message: String },

    #[error("plugin handshake failed: {0}")]
    Handshake(String),

    #[error("plugin process disconnected")]
    Disconnected,

    #[error("operation timed out")]
    Timeout,

    #[error("plugin send queue closed")]
    SendClosed,

    #[error("plugin auth token mismatch")]
    AuthFailed,

    #[error("invalid params for method {method}: {reason}")]
    InvalidParams { method: String, reason: String },

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("{0}")]
    Other(String),
}

pub type ChannelResult<T> = Result<T, ChannelError>;
