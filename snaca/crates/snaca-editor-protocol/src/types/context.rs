//! Structured context payloads injected at request time.
//!
//! See spec §9. `ChatContext` is used by `chat.send` / `composer.start`.
//! `InlineEditContext` is the lighter shape for `inline_edit.start`.

use super::range::Range;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ChatContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_file: Option<ActiveFileContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_tabs: Option<Vec<OpenTab>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recent_edits: Option<Vec<RecentEdit>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<Mention>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Vec<DiagnosticItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectMeta>,
    /// Free-form markdown summarising project-level intel the host has cheaply
    /// gathered (documentclass / packages / macros / current section /
    /// content window around the cursor / last compile outcome, …). Rendered
    /// verbatim inside `<project_intel>` so the LLM can read it without
    /// schema upgrades on each new field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_intel: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveFileContext {
    pub path: String,
    pub language: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<CursorPosition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_range: Option<VisibleRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<SelectionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorPosition {
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct VisibleRange {
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelectionInfo {
    pub range: Range,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpenTab {
    pub path: String,
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecentEdit {
    pub path: String,
    pub ts: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Mention {
    File {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        inline_content: Option<String>,
    },
    Folder {
        path: String,
    },
    Symbol {
        path: String,
        name: String,
        range: Range,
    },
    Selection {
        path: String,
        range: Range,
        text: String,
    },
    Url {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiagnosticItem {
    pub path: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<Range>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectMeta {
    #[serde(rename = "type")]
    pub project_type: ProjectType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectType {
    Latex,
    Typst,
    Mixed,
}

/// Lighter context for inline edits (Ctrl+K).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InlineEditContext {
    /// Source lines preceding the selection (recommend ±30 lines).
    pub surrounding_before: String,
    /// Source lines following the selection.
    pub surrounding_after: String,
    pub language: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_type: Option<ProjectType>,
}

/// Inbound attachment payload (text/file/image base64).
///
/// Used by `chat.send.attachments`. Binary bytes are base64-encoded; JSON-RPC
/// has no native binary frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Attachment {
    pub kind: AttachmentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    File,
    Image,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_chat_context_serializes_as_empty_object() {
        let c = ChatContext::default();
        let s = serde_json::to_string(&c).unwrap();
        assert_eq!(s, "{}");
    }

    #[test]
    fn active_file_skips_none_fields() {
        let c = ChatContext {
            active_file: Some(ActiveFileContext {
                path: "/p/a.tex".into(),
                language: "latex".into(),
                cursor: None,
                visible_range: None,
                selection: None,
                dirty: None,
            }),
            ..Default::default()
        };
        let v = serde_json::to_value(&c).unwrap();
        let af = &v["active_file"];
        assert!(af.get("cursor").is_none());
        assert!(af.get("selection").is_none());
        assert_eq!(af["language"], "latex");
    }

    #[test]
    fn mention_tagged_by_kind() {
        let m = Mention::File {
            path: "/p/refs.bib".into(),
            inline_content: Some("...".into()),
        };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains("\"kind\":\"file\""));
        let back: Mention = serde_json::from_str(&s).unwrap();
        assert_eq!(m, back);
    }

    #[test]
    fn project_type_serializes_snake_case() {
        let p = ProjectMeta {
            project_type: ProjectType::Latex,
            main_file: Some("main.tex".into()),
            engine: Some("xelatex".into()),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["type"], "latex");
    }

    #[test]
    fn diagnostic_severity_snake_case() {
        let d = DiagnosticItem {
            path: "/p/main.tex".into(),
            severity: DiagnosticSeverity::Warning,
            message: "Undefined".into(),
            range: None,
        };
        let s = serde_json::to_string(&d).unwrap();
        assert!(s.contains("\"severity\":\"warning\""));
    }

    #[test]
    fn inline_edit_context_minimal() {
        let raw = json!({
            "surrounding_before": "before",
            "surrounding_after": "after",
            "language": "latex"
        });
        let c: InlineEditContext = serde_json::from_value(raw).unwrap();
        assert_eq!(c.project_type, None);
    }
}
