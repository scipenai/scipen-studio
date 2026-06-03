//! LLM provider error type.

use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LlmError {
    #[error("transport error: {0}")]
    Transport(#[from] reqwest::Error),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    /// HTTP status with the response body so the caller can inspect details
    /// (rate-limit headers, error payload, etc.).
    ///
    /// Reserved for non-2xx responses that the classifier couldn't map to
    /// one of the structured variants below. New code should prefer
    /// `RateLimited` / `ServerTransient` / `AuthExpired` / `ContextOverflow`
    /// — `HttpStatus` is the fallback when the status is genuinely unknown
    /// (e.g. a 4xx other than 401/403/429).
    #[error("provider returned http {status}: {body}")]
    HttpStatus { status: u16, body: String },

    /// 429 / quota exhausted. `retry_after` is populated from a
    /// `Retry-After` header (seconds or HTTP-date) when present. The
    /// retry wrapper prefers this over the configured backoff curve.
    #[error("rate limited (retry_after={retry_after:?})")]
    RateLimited { retry_after: Option<Duration> },

    /// The request exceeded the model's context window. Distinct from
    /// `HttpStatus` because the engine's recovery path is special
    /// (compact history, then retry) and should never trigger a generic
    /// HTTP retry.
    #[error("context window exceeded")]
    ContextOverflow,

    /// Server-side transient (5xx, 529 overloaded). Retryable.
    #[error("server transient error: http {status}")]
    ServerTransient { status: u16 },

    /// 401/403 — API key invalid or revoked. Not retryable; the
    /// operator must rotate credentials before the next attempt
    /// succeeds.
    #[error("authentication failed: http {status}")]
    AuthExpired { status: u16 },

    /// SSE/streaming body was interrupted mid-flight. We capture the
    /// full error chain as a string at the failure site (see
    /// `transport::wrap_byte_stream`) so the original cause is logged
    /// even after the reqwest::Error has been dropped.
    #[error("stream interrupted: {0}")]
    StreamInterrupted(String),

    #[error("provider returned malformed response: {0}")]
    MalformedResponse(String),

    /// A streamed tool_use block's concatenated `partial_json`
    /// fragments did not parse as valid JSON. Distinct from
    /// `MalformedResponse` so the engine can detect this specific
    /// failure and retry the request once in non-streaming mode —
    /// DeepSeek with long Chinese tool args can emit broken SSE deltas
    /// while its non-streaming endpoint returns the same arguments as a
    /// single complete string field, sidestepping the concat bug.
    #[error("provider returned malformed response: {message}")]
    MalformedToolArgs {
        tool: String,
        args_len: usize,
        message: String,
    },

    /// Provider-side error envelope (we surface code + message verbatim).
    /// Reserved for envelopes the classifier didn't recognise — known
    /// codes are mapped to the structured variants above.
    #[error("provider error {code}: {message}")]
    Provider { code: String, message: String },

    #[error("operation timed out")]
    Timeout,

    #[error("invalid configuration: {0}")]
    InvalidConfig(String),

    #[error("unsupported feature for {provider}: {feature}")]
    Unsupported {
        provider: &'static str,
        feature: String,
    },

    #[error("{0}")]
    Other(String),
}

impl LlmError {
    /// Whether the retry wrapper should attempt this error again after
    /// a backoff. Conservative by design: only errors that are known to
    /// be transient or rate-driven retry; everything else (including
    /// `HttpStatus` and `Provider` envelopes the classifier didn't
    /// recognise) is surfaced to the caller unchanged.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            LlmError::RateLimited { .. }
                | LlmError::ServerTransient { .. }
                | LlmError::Transport(_)
                | LlmError::Timeout
                | LlmError::StreamInterrupted(_)
        )
    }

    /// Provider-suggested backoff for rate-limited errors. The retry
    /// wrapper prefers this over the jittered exponential curve when
    /// present.
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            LlmError::RateLimited { retry_after } => *retry_after,
            _ => None,
        }
    }
}

pub type LlmResult<T> = Result<T, LlmError>;
