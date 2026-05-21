//! Concrete `ContextRequester` impl that bridges tool calls to the host
//! via the JSON-RPC `context.request` reverse-RPC.
//!
//! The Tool trait sees a `Arc<dyn ContextRequester>` (declared in
//! `snaca-tools-api`); this module supplies the binary-side implementation
//! that knows how to talk to the host. Engine wiring is in
//! `handler.rs` — every turn attaches one of these to the engine's
//! `ToolContext`, scoped to the current `turn_id` so host-side
//! per-turn telemetry stays accurate.

use crate::outbound::{ContextCallError, OutboundWriter};
use async_trait::async_trait;
use serde_json::{json, Value};
use snaca_editor_protocol::messages::context_req::{
    ContextPayload, ContextRequestPayload, ZoteroAnnotationsParams, ZoteroLookupParams,
    ZoteroSearchParams,
};
use snaca_tools_api::{ContextRequestError, ContextRequester};
use std::sync::Arc;

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

    async fn call(&self, payload: ContextRequestPayload) -> Result<ContextPayload, ContextRequestError> {
        self.outbound
            .call_context(self.turn_id.clone(), payload)
            .await
            .map_err(map_error)
    }
}

#[async_trait]
impl ContextRequester for EditorContextRequester {
    async fn request_zotero_search(
        &self,
        query: &str,
        limit: Option<u32>,
    ) -> Result<Value, ContextRequestError> {
        let payload = ContextRequestPayload::ZoteroSearch {
            params: ZoteroSearchParams {
                query: query.to_string(),
                limit,
            },
        };
        match self.call(payload).await? {
            ContextPayload::ZoteroSearch { results } => {
                serde_json::to_value(json!({ "results": results })).map_err(invalid_payload)
            }
            other => Err(wrong_kind("zotero_search", &other)),
        }
    }

    async fn request_zotero_lookup(&self, key: &str) -> Result<Value, ContextRequestError> {
        let payload = ContextRequestPayload::ZoteroLookup {
            params: ZoteroLookupParams {
                key: key.to_string(),
            },
        };
        match self.call(payload).await? {
            ContextPayload::ZoteroLookup { found, item } => {
                serde_json::to_value(json!({ "found": found, "item": item })).map_err(invalid_payload)
            }
            other => Err(wrong_kind("zotero_lookup", &other)),
        }
    }

    async fn request_zotero_annotations(
        &self,
        item_key: &str,
    ) -> Result<Value, ContextRequestError> {
        let payload = ContextRequestPayload::ZoteroAnnotations {
            params: ZoteroAnnotationsParams {
                item_key: item_key.to_string(),
            },
        };
        match self.call(payload).await? {
            ContextPayload::ZoteroAnnotations { annotations } => {
                serde_json::to_value(json!({ "annotations": annotations })).map_err(invalid_payload)
            }
            other => Err(wrong_kind("zotero_annotations", &other)),
        }
    }
}

fn map_error(err: ContextCallError) -> ContextRequestError {
    match err {
        ContextCallError::Timeout(_) => ContextRequestError::Timeout,
        ContextCallError::HostError(msg) => ContextRequestError::HostRejected(msg),
        ContextCallError::Io(io_err) => ContextRequestError::ChannelClosed(io_err.to_string()),
        ContextCallError::Closed => {
            ContextRequestError::ChannelClosed("correlator dropped".into())
        }
    }
}

fn invalid_payload(err: serde_json::Error) -> ContextRequestError {
    ContextRequestError::InvalidPayload(err.to_string())
}

fn wrong_kind(expected: &str, got: &ContextPayload) -> ContextRequestError {
    let got_kind = match got {
        ContextPayload::FlushUnsaved { .. } => "flush_unsaved",
        ContextPayload::FileContent { .. } => "file_content",
        ContextPayload::ZoteroSearch { .. } => "zotero_search",
        ContextPayload::ZoteroLookup { .. } => "zotero_lookup",
        ContextPayload::ZoteroAnnotations { .. } => "zotero_annotations",
    };
    ContextRequestError::InvalidPayload(format!("expected {expected}, host sent {got_kind}"))
}
