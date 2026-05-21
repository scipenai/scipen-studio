//! Capability negotiation payloads exchanged in `init`.
//!
//! See spec §8.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnacaCapabilities {
    pub protocol_version: String,
    pub engine_version: String,
    #[serde(default)]
    pub streaming_text: bool,
    #[serde(default)]
    pub streaming_thinking: bool,
    /// `true` ⇒ supports `edit.propose_delta` streaming for `new_text`.
    #[serde(default)]
    pub streaming_edit: bool,
    #[serde(default)]
    pub inline_edit: bool,
    #[serde(default)]
    pub composer: bool,
    #[serde(default)]
    pub context_request: Vec<ContextRequestKind>,
    #[serde(default)]
    pub tools_builtin: Vec<String>,
    #[serde(default)]
    pub approval_modes: Vec<ApprovalModeKind>,
    #[serde(default)]
    pub memory_embedders: Vec<MemoryEmbedderKind>,
    #[serde(default)]
    pub framing: Vec<FramingKind>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostCapabilities {
    pub ui_surfaces: Vec<UiSurface>,
    pub context_kinds: Vec<ContextKind>,
    pub edit_apply_strategy: EditApplyStrategy,
    pub approval_ui: ApprovalUi,
    #[serde(default)]
    pub framing: Vec<FramingKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiSurface {
    Chat,
    InlineEdit,
    Composer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextKind {
    ActiveFile,
    Selection,
    Cursor,
    VisibleRange,
    OpenTabs,
    RecentEdits,
    Diagnostics,
    ProjectMeta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextRequestKind {
    FlushUnsaved,
    FileContent,
    /// Renderer-served full-text search over the user's Zotero library.
    ZoteroSearch,
    /// Renderer-served citation key / itemKey lookup with CSL metadata.
    ZoteroLookup,
    /// Renderer-served fetch of annotations attached to a Zotero item.
    ZoteroAnnotations,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditApplyStrategy {
    /// Host applies hunks; SNACA never writes to disk in editor mode.
    HostApplies,
    /// SNACA writes; host only renders Diff Review.
    SnacaApplies,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalUi {
    LocalCard,
    Passthrough,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalModeKind {
    Interactive,
    AutoAllow,
    AutoDeny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryEmbedderKind {
    None,
    Hash,
    Fastembed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FramingKind {
    Ndjson,
    ContentLength,
}

impl SnacaCapabilities {
    pub fn minimal_editor(engine_version: impl Into<String>) -> Self {
        Self {
            protocol_version: crate::PROTOCOL_VERSION.to_string(),
            engine_version: engine_version.into(),
            streaming_text: true,
            streaming_thinking: true,
            streaming_edit: true,
            inline_edit: true,
            composer: true,
            context_request: vec![
                ContextRequestKind::FlushUnsaved,
                ContextRequestKind::FileContent,
            ],
            tools_builtin: vec![],
            approval_modes: vec![
                ApprovalModeKind::Interactive,
                ApprovalModeKind::AutoAllow,
                ApprovalModeKind::AutoDeny,
            ],
            memory_embedders: vec![MemoryEmbedderKind::None, MemoryEmbedderKind::Hash],
            framing: vec![FramingKind::Ndjson],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snaca_caps_roundtrip() {
        let c = SnacaCapabilities::minimal_editor("0.2.0");
        let s = serde_json::to_string(&c).unwrap();
        let back: SnacaCapabilities = serde_json::from_str(&s).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn ui_surface_snake_case() {
        let s = serde_json::to_string(&UiSurface::InlineEdit).unwrap();
        assert_eq!(s, "\"inline_edit\"");
    }

    #[test]
    fn edit_apply_strategy_snake_case() {
        let s = serde_json::to_string(&EditApplyStrategy::HostApplies).unwrap();
        assert_eq!(s, "\"host_applies\"");
    }
}
