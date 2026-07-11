//! Zotero context tools — `zotero_search`, `zotero_lookup`,
//! `zotero_annotations`, `zotero_read`. No filesystem access: each calls the
//! editor host via the generic reverse-RPC [`snaca_tools_api::HostContext`] on
//! `ToolContext` (method strings + opaque JSON — snaca stays unaware of Zotero).
//! Kept as distinct tools (not one with a `mode` arg) so each carries its own
//! input schema and the LLM's tool-selection signal stays clean.
//!
//! These lived in snaca-tools before 0.3.0; upstream never shipped them, so
//! they now live in the editor and register via `base_tool_registry_builder()`.

use crate::context_requester::{ZOTERO_ANNOTATIONS, ZOTERO_LOOKUP, ZOTERO_READ, ZOTERO_SEARCH};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_tools_api::{
    ApprovalRequirement, HostContext, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput,
    ToolResult,
};
use std::sync::Arc;

// ============================================================
// Common helpers
// ============================================================

fn require_host(ctx: &ToolContext) -> Result<&Arc<dyn HostContext>, ToolError> {
    ctx.host_context().ok_or_else(|| {
        ToolError::Execution(
            "Zotero tools require an editor host with reverse-RPC enabled; \
             this deployment doesn't expose one"
                .into(),
        )
    })
}

async fn call_host(ctx: &ToolContext, method: &str, params: Value) -> ToolResult {
    let host = require_host(ctx)?;
    let payload = host
        .call(method, params)
        .await
        .map_err(|e| ToolError::Execution(e.to_string()))?;
    let text = serde_json::to_string(&payload).map_err(|e| ToolError::Execution(e.to_string()))?;
    Ok(ToolOutput::text(text))
}

// ============================================================
// ZoteroSearch
// ============================================================

#[derive(Deserialize)]
struct ZoteroSearchInput {
    query: String,
    #[serde(default)]
    limit: Option<u32>,
}

pub struct ZoteroSearchTool;

#[async_trait]
impl Tool for ZoteroSearchTool {
    fn name(&self) -> &str {
        "zotero_search"
    }

    fn description(&self) -> &str {
        "Search the user's Zotero library by free-text query or BBT citation key. \
         Returns the top candidates ranked by relevance: citation key, title, \
         authors, year, item key. Use this to find papers before drafting \
         citations or to disambiguate which `\\cite{...}` key matches a topic."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query. Matches against citation keys, titles, authors, and years.",
                    "minLength": 1
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum results to return. Default 10, max 50.",
                    "minimum": 1,
                    "maximum": 50
                }
            },
            "required": ["query"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::default()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input: ZoteroSearchInput =
            serde_json::from_value(input).map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        call_host(
            ctx,
            ZOTERO_SEARCH,
            json!({ "query": input.query, "limit": input.limit }),
        )
        .await
    }
}

// ============================================================
// ZoteroLookup
// ============================================================

#[derive(Deserialize)]
struct ZoteroLookupInput {
    key: String,
}

pub struct ZoteroLookupTool;

#[async_trait]
impl Tool for ZoteroLookupTool {
    fn name(&self) -> &str {
        "zotero_lookup"
    }

    fn description(&self) -> &str {
        "Resolve one Zotero item by its BBT citation key (e.g. `smith2024deep`) \
         or 8-character Zotero itemKey. Returns full metadata plus CSL JSON \
         when Better BibTeX is installed. Use this when you already know the \
         key and need the formatted bibliography entry or extra fields."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": "Citation key (smith2024deep) or itemKey (8FXYZ123).",
                    "minLength": 1
                }
            },
            "required": ["key"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::default()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input: ZoteroLookupInput =
            serde_json::from_value(input).map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        call_host(ctx, ZOTERO_LOOKUP, json!({ "key": input.key })).await
    }
}

// ============================================================
// ZoteroAnnotations
// ============================================================

#[derive(Deserialize)]
struct ZoteroAnnotationsInput {
    item_key: String,
}

pub struct ZoteroAnnotationsTool;

#[async_trait]
impl Tool for ZoteroAnnotationsTool {
    fn name(&self) -> &str {
        "zotero_annotations"
    }

    fn description(&self) -> &str {
        "Fetch the user's annotations (highlights, notes) on one Zotero item's \
         PDF attachment. Useful when synthesising a review: the user's own \
         annotations are usually the strongest signal for what to cite. \
         Returns empty array when no annotations exist."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "item_key": {
                    "type": "string",
                    "description": "Zotero itemKey of the parent item (attachment or paper).",
                    "minLength": 1
                }
            },
            "required": ["item_key"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::default()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input: ZoteroAnnotationsInput =
            serde_json::from_value(input).map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        call_host(ctx, ZOTERO_ANNOTATIONS, json!({ "item_key": input.item_key })).await
    }
}

// ============================================================
// ZoteroRead
// ============================================================

#[derive(Deserialize)]
struct ZoteroReadInput {
    key: String,
}

pub struct ZoteroReadTool;

#[async_trait]
impl Tool for ZoteroReadTool {
    fn name(&self) -> &str {
        "zotero_read"
    }

    fn description(&self) -> &str {
        "Read the full text of a Zotero item's PDF attachment, by BBT citation \
         key or 8-char itemKey. Returns plain text extracted locally (formulas \
         and tables may be garbled or reordered — don't quote them verbatim). \
         `tier:\"none\"` means the item has no PDF; `quality:\"poor\"` flags a \
         likely-unreliable extraction (scanned or formula-heavy) — lean on \
         metadata and suggest structured parsing instead of trusting the text. \
         Use when metadata isn't enough and you need the actual paper content."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": "Citation key (smith2024deep) or itemKey (8FXYZ123).",
                    "minLength": 1
                }
            },
            "required": ["key"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::default()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input: ZoteroReadInput =
            serde_json::from_value(input).map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        call_host(ctx, ZOTERO_READ, json!({ "key": input.key })).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, SessionId, TenantId};
    use snaca_tools_api::HostContextError;
    use std::path::PathBuf;

    /// Test double — records the last (method, params) and returns a canned
    /// value keyed by method.
    #[derive(Debug, Default)]
    struct FakeHost {
        last_method: tokio::sync::Mutex<Option<String>>,
        last_params: tokio::sync::Mutex<Option<Value>>,
    }

    #[async_trait]
    impl HostContext for FakeHost {
        async fn call(&self, method: &str, params: Value) -> Result<Value, HostContextError> {
            *self.last_method.lock().await = Some(method.into());
            *self.last_params.lock().await = Some(params);
            Ok(match method {
                ZOTERO_SEARCH => json!({ "results": [{ "item_key": "K1", "score": 1.0 }] }),
                ZOTERO_LOOKUP => json!({ "found": true, "item": { "item_key": "K1" } }),
                ZOTERO_ANNOTATIONS => json!({ "annotations": [] }),
                ZOTERO_READ => json!({ "text": "body", "truncated": false, "tier": "local" }),
                other => panic!("unexpected method {other}"),
            })
        }
    }

    fn ctx_with(fake: Arc<FakeHost>) -> ToolContext {
        ToolContext::new(
            TenantId::new("tenant-a"),
            ProjectId::new_random(),
            SessionId::new(),
            PathBuf::from("/tmp/scipen-test"),
        )
        .with_host_context(fake)
    }

    #[tokio::test]
    async fn search_forwards_query_and_limit() {
        let fake = Arc::new(FakeHost::default());
        let ctx = ctx_with(fake.clone());
        let out = ZoteroSearchTool
            .execute(json!({ "query": "attention", "limit": 5 }), &ctx)
            .await
            .unwrap();
        assert_eq!(fake.last_method.lock().await.as_deref(), Some(ZOTERO_SEARCH));
        let params = fake.last_params.lock().await.clone().unwrap();
        assert_eq!(params["query"], "attention");
        assert_eq!(params["limit"], 5);
        let text = match out {
            ToolOutput::Text(t) => t,
            other => panic!("expected text output, got {other:?}"),
        };
        assert!(text.contains("\"item_key\":\"K1\""));
    }

    #[tokio::test]
    async fn lookup_forwards_key() {
        let fake = Arc::new(FakeHost::default());
        let ctx = ctx_with(fake.clone());
        let _ = ZoteroLookupTool
            .execute(json!({ "key": "smith2024" }), &ctx)
            .await
            .unwrap();
        let params = fake.last_params.lock().await.clone().unwrap();
        assert_eq!(params["key"], "smith2024");
    }

    #[tokio::test]
    async fn annotations_forwards_item_key() {
        let fake = Arc::new(FakeHost::default());
        let ctx = ctx_with(fake.clone());
        let _ = ZoteroAnnotationsTool
            .execute(json!({ "item_key": "PARENT" }), &ctx)
            .await
            .unwrap();
        let params = fake.last_params.lock().await.clone().unwrap();
        assert_eq!(params["item_key"], "PARENT");
    }

    #[tokio::test]
    async fn read_forwards_key() {
        let fake = Arc::new(FakeHost::default());
        let ctx = ctx_with(fake.clone());
        let out = ZoteroReadTool
            .execute(json!({ "key": "smith2024" }), &ctx)
            .await
            .unwrap();
        let params = fake.last_params.lock().await.clone().unwrap();
        assert_eq!(params["key"], "smith2024");
        let text = match out {
            ToolOutput::Text(t) => t,
            other => panic!("expected text output, got {other:?}"),
        };
        assert!(text.contains("\"tier\":\"local\""));
    }

    #[tokio::test]
    async fn missing_host_surfaces_clear_error() {
        let ctx = ToolContext::new(
            TenantId::new("t"),
            ProjectId::new_random(),
            SessionId::new(),
            PathBuf::from("/tmp/scipen-test"),
        );
        let err = ZoteroSearchTool
            .execute(json!({ "query": "x" }), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("reverse-RPC"));
    }

    #[tokio::test]
    async fn invalid_input_returns_invalid_input_error() {
        let fake = Arc::new(FakeHost::default());
        let ctx = ctx_with(fake);
        let err = ZoteroSearchTool
            .execute(json!({ "limit": 5 }), &ctx) // missing required `query`
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }
}
