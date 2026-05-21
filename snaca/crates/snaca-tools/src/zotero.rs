//! Zotero context tools — `zotero_search`, `zotero_lookup`,
//! `zotero_annotations`.
//!
//! These don't touch the filesystem. Instead they call the host through
//! the reverse-RPC `ContextRequester` channel attached to the
//! `ToolContext`. The host (`scipen-studio`) serves the request from
//! its renderer-side `ZoteroBibIndex` + Local API cache.
//!
//! Tool naming follows the existing convention (`Read`, `Grep`, ...):
//! PascalCase identifier mirrors what shows up in LLM tool lists. We
//! deliberately keep these three as separate tools (rather than one
//! "Zotero" tool with a `mode` argument) because each has a distinct
//! input schema and the LLM's tool-selection signal benefits from the
//! clean separation.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_tools_api::{
    ApprovalRequirement, ContextRequester, Tool, ToolCapabilities, ToolContext, ToolError,
    ToolOutput, ToolResult,
};

// ============================================================
// Common helpers
// ============================================================

fn require_requester(
    ctx: &ToolContext,
) -> Result<&std::sync::Arc<dyn ContextRequester>, ToolError> {
    ctx.context_requester().ok_or_else(|| {
        ToolError::Execution(
            "Zotero tools require an editor host with reverse-RPC enabled; \
             this deployment doesn't expose one"
                .into(),
        )
    })
}

fn json_output(value: Value) -> ToolResult {
    let text = serde_json::to_string(&value).map_err(|e| ToolError::Execution(e.to_string()))?;
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
        let input: ZoteroSearchInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        let requester = require_requester(ctx)?;
        let payload = requester
            .request_zotero_search(&input.query, input.limit)
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        json_output(payload)
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
        let input: ZoteroLookupInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        let requester = require_requester(ctx)?;
        let payload = requester
            .request_zotero_lookup(&input.key)
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        json_output(payload)
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
        let input: ZoteroAnnotationsInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        let requester = require_requester(ctx)?;
        let payload = requester
            .request_zotero_annotations(&input.item_key)
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        json_output(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, SessionId, TenantId};
    use std::path::PathBuf;
    use std::sync::Arc;

    /// Test double — captures the last call and returns a canned value.
    #[derive(Debug, Default)]
    struct FakeRequester {
        last_query: tokio::sync::Mutex<Option<String>>,
        last_limit: tokio::sync::Mutex<Option<u32>>,
        last_key: tokio::sync::Mutex<Option<String>>,
        last_item_key: tokio::sync::Mutex<Option<String>>,
    }

    #[async_trait::async_trait]
    impl ContextRequester for FakeRequester {
        async fn request_zotero_search(
            &self,
            query: &str,
            limit: Option<u32>,
        ) -> Result<Value, snaca_tools_api::ContextRequestError> {
            *self.last_query.lock().await = Some(query.into());
            *self.last_limit.lock().await = limit;
            Ok(json!({ "results": [{ "item_key": "K1", "score": 1.0 }] }))
        }
        async fn request_zotero_lookup(
            &self,
            key: &str,
        ) -> Result<Value, snaca_tools_api::ContextRequestError> {
            *self.last_key.lock().await = Some(key.into());
            Ok(json!({ "found": true, "item": { "item_key": "K1" } }))
        }
        async fn request_zotero_annotations(
            &self,
            item_key: &str,
        ) -> Result<Value, snaca_tools_api::ContextRequestError> {
            *self.last_item_key.lock().await = Some(item_key.into());
            Ok(json!({ "annotations": [] }))
        }
    }

    fn ctx_with(fake: Arc<FakeRequester>) -> ToolContext {
        ToolContext::new(
            TenantId::new("tenant-a"),
            ProjectId::new_random(),
            SessionId::new(),
            PathBuf::from("/tmp/scipen-test"),
        )
        .with_context_requester(fake)
    }

    #[tokio::test]
    async fn search_forwards_query_and_limit() {
        let fake = Arc::new(FakeRequester::default());
        let ctx = ctx_with(fake.clone());
        let out = ZoteroSearchTool
            .execute(json!({ "query": "attention", "limit": 5 }), &ctx)
            .await
            .unwrap();
        assert_eq!(fake.last_query.lock().await.as_deref(), Some("attention"));
        assert_eq!(*fake.last_limit.lock().await, Some(5));
        let text = match out {
            ToolOutput::Text(t) => t,
            other => panic!("expected text output, got {other:?}"),
        };
        assert!(text.contains("\"item_key\":\"K1\""));
    }

    #[tokio::test]
    async fn lookup_forwards_key() {
        let fake = Arc::new(FakeRequester::default());
        let ctx = ctx_with(fake.clone());
        let _ = ZoteroLookupTool
            .execute(json!({ "key": "smith2024" }), &ctx)
            .await
            .unwrap();
        assert_eq!(fake.last_key.lock().await.as_deref(), Some("smith2024"));
    }

    #[tokio::test]
    async fn annotations_forwards_item_key() {
        let fake = Arc::new(FakeRequester::default());
        let ctx = ctx_with(fake.clone());
        let _ = ZoteroAnnotationsTool
            .execute(json!({ "item_key": "PARENT" }), &ctx)
            .await
            .unwrap();
        assert_eq!(
            fake.last_item_key.lock().await.as_deref(),
            Some("PARENT")
        );
    }

    #[tokio::test]
    async fn missing_requester_surfaces_clear_error() {
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
        let fake = Arc::new(FakeRequester::default());
        let ctx = ctx_with(fake);
        let err = ZoteroSearchTool
            .execute(json!({ "limit": 5 }), &ctx) // missing required `query`
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }
}
