//! Shared HTTP streaming diagnostics for provider clients.
//!
//! "transport error: error decoding response body" is reqwest's flattened
//! Display for any I/O failure while pulling chunks off a response body
//! (H2 RST, chunked decode, TLS read, server-side abort after a 200). The
//! raw `reqwest::Error` only renders its own kind — the underlying cause
//! lives in its `source()` chain. Providers route both DeepSeek and
//! Anthropic streams through here so the cause is captured before it's
//! collapsed into `LlmError::Transport`, and so the log distinguishes
//! "server closed before sending anything" from "stream broke mid-body".

use crate::error::{LlmError, LlmResult};
use bytes::Bytes;
use futures::stream::{Stream, StreamExt};
use tracing::{debug, warn};

/// Emit a one-line debug log of the response headers that matter when a
/// streaming body fails to decode. Cheap; no-op unless debug logging is on.
pub fn log_response_headers(provider: &'static str, resp: &reqwest::Response) {
    let h = resp.headers();
    debug!(
        provider,
        status = resp.status().as_u16(),
        content_type = h
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
        content_encoding = h
            .get(reqwest::header::CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
        transfer_encoding = h
            .get(reqwest::header::TRANSFER_ENCODING)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
        request_id = h
            .get("x-request-id")
            .or_else(|| h.get("openai-request-id"))
            .or_else(|| h.get("anthropic-request-id"))
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
        "streaming response headers"
    );
}

/// Format a `reqwest::Error`'s full `source()` chain on one line. Without
/// this, callers see only the outermost "error decoding response body"
/// without the H2/TLS/IO cause underneath.
fn format_error_chain(err: &(dyn std::error::Error + 'static)) -> String {
    let mut out = err.to_string();
    let mut src = err.source();
    while let Some(e) = src {
        out.push_str(" -> ");
        out.push_str(&e.to_string());
        src = e.source();
    }
    out
}

/// Wrap reqwest's `Stream<Item = reqwest::Result<Bytes>>` so each chunk
/// failure is logged with the full error chain and the number of bytes
/// already received. A failure at `bytes_received == 0` is the smoking
/// gun for "server accepted the request, returned 200, then aborted
/// without writing any SSE data" — typically a model-side rejection that
/// didn't surface as an HTTP error envelope.
pub fn wrap_byte_stream<S>(
    provider: &'static str,
    inner: S,
) -> impl Stream<Item = LlmResult<Bytes>> + Send + 'static
where
    S: Stream<Item = reqwest::Result<Bytes>> + Send + 'static,
{
    let mut bytes_received: u64 = 0;
    inner.map(move |res| match res {
        Ok(chunk) => {
            bytes_received += chunk.len() as u64;
            Ok(chunk)
        }
        Err(e) => {
            let chain = format_error_chain(&e);
            warn!(
                provider,
                bytes_received,
                error_chain = %chain,
                "streaming response body chunk failed"
            );
            // SSE/streaming aborts get a dedicated variant so the retry
            // wrapper can decide independently of "regular" transport
            // failures (failed connect, DNS, etc., which `Transport`
            // also covers). Capture the full source chain in the
            // message — once we drop the reqwest::Error the cause is
            // gone forever.
            Err(LlmError::StreamInterrupted(chain))
        }
    })
}
