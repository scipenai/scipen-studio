//! `context.request` (SNACA → host **request**) and `context.respond`.
//!
//! Note: `context.request` is the **only** SNACA-originated request type
//! that carries a JSON-RPC id. Host MUST reply with `context.respond`
//! using the same `request_id`.

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
    /// Full-text or BBT-key search over the user's Zotero library.
    /// Host serves it from its renderer-side bib mirror.
    ZoteroSearch {
        params: ZoteroSearchParams,
    },
    /// Resolve one citation key or itemKey to full metadata + CSL.
    ZoteroLookup {
        params: ZoteroLookupParams,
    },
    /// Fetch every annotation attached to a Zotero item (PDF attachment).
    ZoteroAnnotations {
        params: ZoteroAnnotationsParams,
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
pub struct ZoteroSearchParams {
    pub query: String,
    /// Top-N candidates to return. Host clamps to [1, 50]; omit for
    /// the host default (10).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZoteroLookupParams {
    /// BBT citation key (preferred) or 8-char Zotero itemKey. Renderer
    /// tries both forms.
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZoteroAnnotationsParams {
    pub item_key: String,
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
    FlushUnsaved {
        flushed_files: Vec<String>,
    },
    FileContent {
        path: String,
        content: String,
        sha256: String,
    },
    ZoteroSearch {
        results: Vec<ZoteroSearchResult>,
    },
    ZoteroLookup {
        found: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item: Option<ZoteroItem>,
    },
    ZoteroAnnotations {
        annotations: Vec<ZoteroAnnotation>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZoteroSearchResult {
    pub item_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citation_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creators_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    pub score: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZoteroItem {
    pub item_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citation_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creators_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abstract_: Option<String>,
    /// BBT-formatted CSL JSON object; opaque (different BBT versions
    /// emit slightly different shapes — consumers parse as needed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub csl: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZoteroAnnotation {
    pub item_key: String,
    pub parent_item_key: String,
    pub annotation_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_label: Option<String>,
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
    fn zotero_search_request_roundtrips() {
        let raw = json!({
            "request_id": "r1",
            "turn_id": "t1",
            "kind": "zotero_search",
            "params": { "query": "attention", "limit": 5 }
        });
        let p: ContextRequestParams = serde_json::from_value(raw).unwrap();
        match p.req {
            ContextRequestPayload::ZoteroSearch { params } => {
                assert_eq!(params.query, "attention");
                assert_eq!(params.limit, Some(5));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn zotero_lookup_request_roundtrips() {
        let raw = json!({
            "request_id": "r2",
            "turn_id": "t1",
            "kind": "zotero_lookup",
            "params": { "key": "vaswani2017attention" }
        });
        let p: ContextRequestParams = serde_json::from_value(raw).unwrap();
        match p.req {
            ContextRequestPayload::ZoteroLookup { params } => {
                assert_eq!(params.key, "vaswani2017attention");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn zotero_annotations_request_roundtrips() {
        let raw = json!({
            "request_id": "r3",
            "turn_id": "t1",
            "kind": "zotero_annotations",
            "params": { "item_key": "ABCD1234" }
        });
        let p: ContextRequestParams = serde_json::from_value(raw).unwrap();
        match p.req {
            ContextRequestPayload::ZoteroAnnotations { params } => {
                assert_eq!(params.item_key, "ABCD1234");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn zotero_search_payload_roundtrips() {
        let raw = json!({
            "kind": "zotero_search",
            "results": [
                {
                    "item_key": "K1",
                    "citation_key": "smith2024",
                    "title": "Deep Learning",
                    "year": 2024,
                    "score": 99.5
                }
            ]
        });
        let payload: ContextPayload = serde_json::from_value(raw).unwrap();
        match payload {
            ContextPayload::ZoteroSearch { results } => {
                assert_eq!(results.len(), 1);
                assert_eq!(results[0].item_key, "K1");
                assert_eq!(results[0].citation_key.as_deref(), Some("smith2024"));
                assert_eq!(results[0].year, Some(2024));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn zotero_lookup_payload_with_found_false() {
        let raw = json!({ "kind": "zotero_lookup", "found": false });
        let payload: ContextPayload = serde_json::from_value(raw).unwrap();
        match payload {
            ContextPayload::ZoteroLookup { found, item } => {
                assert!(!found);
                assert!(item.is_none());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn zotero_annotations_payload_empty_array() {
        let raw = json!({ "kind": "zotero_annotations", "annotations": [] });
        let payload: ContextPayload = serde_json::from_value(raw).unwrap();
        match payload {
            ContextPayload::ZoteroAnnotations { annotations } => {
                assert!(annotations.is_empty());
            }
            _ => panic!("wrong variant"),
        }
    }
}
