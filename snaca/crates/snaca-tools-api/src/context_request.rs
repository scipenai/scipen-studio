//! Reverse-RPC trait tools call to fetch host-resident data.
//!
//! Abstract surface lives here; the concrete impl in `snaca-editor`
//! wraps `OutboundWriter` + correlator. Tools see opaque JSON values —
//! the wire schema is the host's business.

use async_trait::async_trait;
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ContextRequestError {
    /// Host returned `ok: false`. The string is the host's verbatim
    /// reason; pass it through to the LLM so the model can react.
    #[error("host rejected request: {0}")]
    HostRejected(String),

    /// Host did not respond within the per-call deadline (5 s default,
    /// matching the host-side `Agent_ContextZoteroRequest` parking).
    #[error("timed out waiting for context.respond")]
    Timeout,

    /// Channel unavailable (no host attached, dispatcher shut down).
    #[error("context channel unavailable: {0}")]
    ChannelClosed(String),

    /// Host responded with an unparseable payload shape (protocol bug).
    #[error("invalid response payload: {0}")]
    InvalidPayload(String),
}

/// `Debug` is a super-bound so `ToolContext` can stay `#[derive(Debug)]`.
#[async_trait]
pub trait ContextRequester: Send + Sync + std::fmt::Debug {
    /// `limit` clamps to 1..=50 at the host; `None` defaults to 10.
    async fn request_zotero_search(
        &self,
        query: &str,
        limit: Option<u32>,
    ) -> Result<Value, ContextRequestError>;

    /// Returns `{ found: false }` on miss — not an error.
    async fn request_zotero_lookup(&self, key: &str) -> Result<Value, ContextRequestError>;

    /// Empty `annotations: []` is a valid response.
    async fn request_zotero_annotations(
        &self,
        item_key: &str,
    ) -> Result<Value, ContextRequestError>;

    /// Full text of an item's PDF. `{ text, truncated, tier }`; `tier:"none"`
    /// when the item has no PDF attachment.
    async fn request_zotero_read(&self, key: &str) -> Result<Value, ContextRequestError>;
}
