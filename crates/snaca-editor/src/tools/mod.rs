//! Editor-owned tools layered on top of snaca's standard registry.
//!
//! snaca 0.3.0 ships `base_tool_registry_builder()` so downstreams can take the
//! standard tool set and `.add()` their own without editing snaca. We use it to
//! append the Zotero context tools (which used to live in snaca-tools before
//! 0.3.0, but were always fork-only).

pub mod zotero;

use snaca_tools_api::ToolRegistry;
use zotero::{ZoteroAnnotationsTool, ZoteroLookupTool, ZoteroReadTool, ZoteroSearchTool};

/// The standard snaca tool set plus the editor's Zotero tools. Replaces the
/// direct `snaca_tools::base_tool_registry()` call the fork used when the
/// Zotero tools were bundled inside snaca-tools.
pub fn editor_base_registry() -> ToolRegistry {
    snaca_tools::base_tool_registry_builder()
        .add(ZoteroSearchTool)
        .add(ZoteroLookupTool)
        .add(ZoteroAnnotationsTool)
        .add(ZoteroReadTool)
        .build()
}
