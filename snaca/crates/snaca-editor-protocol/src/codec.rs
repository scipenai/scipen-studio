//! NDJSON framing for the editor protocol.
//!
//! Encode: serialize value + append `\n`.
//! Decode: caller reads up to `\n`, passes the line bytes here.
//!
//! Frame size limit defaults to 8 MiB; raise for large `edit.propose`
//! payloads on huge files if needed.

use crate::jsonrpc::JsonRpcMessage;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CodecError {
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("frame is empty")]
    EmptyFrame,
    #[error("payload {0} bytes exceeds {1} byte limit")]
    PayloadTooLarge(usize, usize),
}

/// Default upper bound on a single NDJSON frame. Editor payloads with
/// large `new_text` slabs (e.g. full-file rewrites) can legitimately get
/// large; 8 MiB covers any practical LaTeX/Typst file.
pub const DEFAULT_MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Encode any serializable value as a single NDJSON line (one `\n`
/// terminator, no embedded newlines because JSON encoders escape them).
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, CodecError> {
    let mut buf = serde_json::to_vec(value)?;
    buf.push(b'\n');
    Ok(buf)
}

/// Decode a single line (without its trailing `\n`) as a [`JsonRpcMessage`].
///
/// Whitespace-only lines are treated as keepalives and rejected with
/// [`CodecError::EmptyFrame`] so callers can `continue`.
pub fn decode(line: &[u8]) -> Result<JsonRpcMessage, CodecError> {
    decode_with_limit(line, DEFAULT_MAX_FRAME_BYTES)
}

pub fn decode_with_limit(line: &[u8], limit: usize) -> Result<JsonRpcMessage, CodecError> {
    let trimmed = trim_ascii_whitespace(line);
    if trimmed.is_empty() {
        return Err(CodecError::EmptyFrame);
    }
    if trimmed.len() > limit {
        return Err(CodecError::PayloadTooLarge(trimmed.len(), limit));
    }
    Ok(serde_json::from_slice(trimmed)?)
}

fn trim_ascii_whitespace(s: &[u8]) -> &[u8] {
    let mut start = 0;
    let mut end = s.len();
    while start < end && s[start].is_ascii_whitespace() {
        start += 1;
    }
    while end > start && s[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    &s[start..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsonrpc::{JsonRpcRequest, JsonRpcRequestId};
    use serde_json::json;

    #[test]
    fn encode_appends_single_newline() {
        let req = JsonRpcRequest::new(JsonRpcRequestId::Number(1), "x", Some(json!({"a": 1})));
        let bytes = encode(&req).unwrap();
        assert_eq!(*bytes.last().unwrap(), b'\n');
        assert_eq!(bytes.iter().filter(|b| **b == b'\n').count(), 1);
    }

    #[test]
    fn decode_handles_request() {
        let line = br#"{"jsonrpc":"2.0","id":1,"method":"health.ping"}"#;
        let msg = decode(line).unwrap();
        assert!(matches!(msg, JsonRpcMessage::Request(_)));
    }

    #[test]
    fn decode_handles_trailing_whitespace() {
        let line = b"  {\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"x\"}  ";
        let msg = decode(line).unwrap();
        assert!(matches!(msg, JsonRpcMessage::Request(_)));
    }

    #[test]
    fn empty_frame_errors() {
        assert!(matches!(decode(b""), Err(CodecError::EmptyFrame)));
        assert!(matches!(decode(b"   "), Err(CodecError::EmptyFrame)));
    }

    #[test]
    fn oversized_frame_rejected() {
        let big = vec![b'x'; 100];
        assert!(matches!(
            decode_with_limit(&big, 10),
            Err(CodecError::PayloadTooLarge(_, 10))
        ));
    }
}
