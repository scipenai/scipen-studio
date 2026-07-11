//! Concrete `HostContext` impl that bridges tool reverse-RPC calls to the
//! editor host via the JSON-RPC `context.request` channel.
//!
//! snaca 0.3.0 exposes a domain-agnostic [`snaca_tools_api::HostContext`]:
//! tools call `host_context().call(method, params)` with an opaque method
//! string and JSON payload. This module maps those generic calls onto the
//! editor's typed `context.request` wire protocol (the transport, correlator,
//! and per-turn `turn_id` scoping all stay exactly as before). Tools agree on
//! method names like `"zotero.search"` with us; snaca itself stays unaware.
//!
//! Engine wiring is in `session_manager.rs` — every turn attaches one of these
//! to the engine's `ToolContext`, scoped to the current `turn_id` so host-side
//! per-turn telemetry stays accurate.

use crate::outbound::{ContextCallError, OutboundWriter};
use async_trait::async_trait;
use serde_json::{json, Value};
use snaca_editor_protocol::messages::context_req::{
    ContextPayload, ContextRequestPayload, ZoteroAnnotationsParams, ZoteroLookupParams,
    ZoteroReadParams, ZoteroSearchParams,
};
use snaca_tools_api::{HostContext, HostContextError};
use std::sync::Arc;

/// Method names the editor's tools and this bridge agree on. Opaque to snaca.
pub const ZOTERO_SEARCH: &str = "zotero.search";
pub const ZOTERO_LOOKUP: &str = "zotero.lookup";
pub const ZOTERO_ANNOTATIONS: &str = "zotero.annotations";
pub const ZOTERO_READ: &str = "zotero.read";

pub struct EditorContextRequester {
    outbound: Arc<OutboundWriter>,
    turn_id: String,
}

// Manual Debug so we don't need to derive on OutboundWriter (which
// holds non-Debug `Stdout`). Only print the per-turn id; everything
// else is structural noise.
impl std::fmt::Debug for EditorContextRequester {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EditorContextRequester")
            .field("turn_id", &self.turn_id)
            .finish_non_exhaustive()
    }
}

impl EditorContextRequester {
    pub fn new(outbound: Arc<OutboundWriter>, turn_id: impl Into<String>) -> Self {
        Self {
            outbound,
            turn_id: turn_id.into(),
        }
    }

    async fn send(&self, payload: ContextRequestPayload) -> Result<ContextPayload, HostContextError> {
        self.outbound
            .call_context(self.turn_id.clone(), payload)
            .await
            .map_err(map_error)
    }
}

#[async_trait]
impl HostContext for EditorContextRequester {
    async fn call(&self, method: &str, params: Value) -> Result<Value, HostContextError> {
        match method {
            ZOTERO_SEARCH => {
                let query = str_field(&params, "query")?;
                let limit = params.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
                let payload = ContextRequestPayload::ZoteroSearch {
                    params: ZoteroSearchParams { query, limit },
                };
                match self.send(payload).await? {
                    ContextPayload::ZoteroSearch { results } => {
                        Ok(json!({ "results": results }))
                    }
                    other => Err(wrong_kind("zotero_search", &other)),
                }
            }
            ZOTERO_LOOKUP => {
                let key = str_field(&params, "key")?;
                let payload = ContextRequestPayload::ZoteroLookup {
                    params: ZoteroLookupParams { key },
                };
                match self.send(payload).await? {
                    ContextPayload::ZoteroLookup { found, item } => {
                        Ok(json!({ "found": found, "item": item }))
                    }
                    other => Err(wrong_kind("zotero_lookup", &other)),
                }
            }
            ZOTERO_ANNOTATIONS => {
                let item_key = str_field(&params, "item_key")?;
                let payload = ContextRequestPayload::ZoteroAnnotations {
                    params: ZoteroAnnotationsParams { item_key },
                };
                match self.send(payload).await? {
                    ContextPayload::ZoteroAnnotations { annotations } => {
                        Ok(json!({ "annotations": annotations }))
                    }
                    other => Err(wrong_kind("zotero_annotations", &other)),
                }
            }
            ZOTERO_READ => {
                let key = str_field(&params, "key")?;
                let payload = ContextRequestPayload::ZoteroRead {
                    params: ZoteroReadParams { key },
                };
                match self.send(payload).await? {
                    ContextPayload::ZoteroRead { text, truncated, tier } => {
                        Ok(json!({ "text": text, "truncated": truncated, "tier": tier }))
                    }
                    other => Err(wrong_kind("zotero_read", &other)),
                }
            }
            unknown => Err(HostContextError::Unavailable(format!(
                "editor host does not implement reverse-RPC method `{unknown}`"
            ))),
        }
    }
}

/// Extract a required string field from the opaque tool params.
fn str_field(params: &Value, name: &str) -> Result<String, HostContextError> {
    params
        .get(name)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| {
            HostContextError::InvalidPayload(format!("missing/invalid string field `{name}`"))
        })
}

fn map_error(err: ContextCallError) -> HostContextError {
    match err {
        ContextCallError::Timeout(_) => HostContextError::Timeout,
        ContextCallError::HostError(msg) => HostContextError::HostRejected(msg),
        ContextCallError::Io(io_err) => HostContextError::Unavailable(io_err.to_string()),
        ContextCallError::Closed => HostContextError::Unavailable("correlator dropped".into()),
    }
}

fn wrong_kind(expected: &str, got: &ContextPayload) -> HostContextError {
    let got_kind = match got {
        ContextPayload::FlushUnsaved { .. } => "flush_unsaved",
        ContextPayload::FileContent { .. } => "file_content",
        ContextPayload::ZoteroSearch { .. } => "zotero_search",
        ContextPayload::ZoteroLookup { .. } => "zotero_lookup",
        ContextPayload::ZoteroAnnotations { .. } => "zotero_annotations",
        ContextPayload::ZoteroRead { .. } => "zotero_read",
        ContextPayload::AskUserQuestion { .. } => "ask_user_question",
    };
    HostContextError::InvalidPayload(format!("expected {expected}, host sent {got_kind}"))
}
