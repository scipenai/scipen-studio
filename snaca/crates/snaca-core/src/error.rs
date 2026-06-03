//! Top-level error type.
//!
//! Most upper-layer crates have their own scoped error types (e.g.
//! `snaca-llm::LlmError`) and convert into [`Error`] only at coarse
//! boundaries. This top-level enum is intentionally generic — add variants
//! sparingly.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("permission denied: {0}")]
    PermissionDenied(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error(transparent)]
    Other(#[from] Box<dyn std::error::Error + Send + Sync>),
}

pub type Result<T> = std::result::Result<T, Error>;
