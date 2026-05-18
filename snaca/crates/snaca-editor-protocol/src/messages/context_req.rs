//! `context.request` (SNACA → host **request**) and `context.respond`.
//!
//! Note: `context.request` is the **only** SNACA-originated request type
//! that carries a JSON-RPC id. Host MUST reply with `context.respond`
//! using the same `request_id`.

use crate::types::range::Range;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextRequestParams {
    pub request_id: String,
    pub turn_id: String,
    #[serde(flatten)]
    pub req: ContextRequestPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ContextRequestPayload {
    FlushUnsaved {
        params: FlushUnsavedParams,
    },
    FileContent {
        params: FileContentParams,
    },
    CodebaseSearch {
        params: CodebaseSearchParams,
    },
    SymbolDef {
        params: SymbolDefParams,
    },
    Diagnostics {
        params: DiagnosticsParams,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct FlushUnsavedParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileContentParams {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodebaseSearchParams {
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_k: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<CodebaseSearchScope>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodebaseSearchScope {
    CurrentFile,
    Project,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SymbolDefParams {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct DiagnosticsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

// --------- host → SNACA: respond ---------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextRespondParams {
    pub request_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<ContextPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ContextPayload {
    FlushUnsaved { flushed_files: Vec<String> },
    FileContent {
        path: String,
        content: String,
        sha256: String,
    },
    CodebaseSearch { results: Vec<CodebaseSearchResult> },
    SymbolDef { matches: Vec<SymbolMatch> },
    Diagnostics { items: Vec<DiagnosticEntry> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodebaseSearchResult {
    pub path: String,
    pub range: Range,
    pub snippet: String,
    pub score: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SymbolMatch {
    pub path: String,
    pub range: Range,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiagnosticEntry {
    pub path: String,
    pub severity: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<Range>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextRespondResult {
    pub ok: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn flush_unsaved_request_tagged() {
        let p = ContextRequestParams {
            request_id: "ctx-1".into(),
            turn_id: "tu-1".into(),
            req: ContextRequestPayload::FlushUnsaved {
                params: FlushUnsavedParams { paths: None },
            },
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["kind"], "flush_unsaved");
    }

    #[test]
    fn codebase_search_payload_roundtrips() {
        let raw = json!({
            "kind": "codebase_search",
            "params": { "query": "introduction", "top_k": 5 }
        });
        let p: ContextRequestPayload = serde_json::from_value(raw).unwrap();
        match p {
            ContextRequestPayload::CodebaseSearch { params } => {
                assert_eq!(params.query, "introduction");
                assert_eq!(params.top_k, Some(5));
            }
            _ => panic!("wrong variant"),
        }
    }
}
