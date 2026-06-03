//! `snaca-tools` — built-in tools.
//!
//! M1: Read / Grep / Glob / LS (and Bash with read-only allowlist).
//! M2: Write / Edit / MultiEdit / TodoWrite + landlock sandbox.
//! M3: MemoryRead / MemoryWrite.
//!
//! All filesystem-touching tools resolve paths through
//! `snaca_workspace::resolve_within` and reject anything that escapes the
//! per-project workspace root. There is no exception path.

pub mod bash;
pub mod edit;
pub mod glob;
pub mod grep;
pub mod http_client;
pub mod ls;
pub mod memory;
pub mod multi_edit;
pub mod read;
pub mod send_file;
pub mod skill_tool;
pub mod task_output;
pub mod task_registry;
pub mod task_stop;
pub mod todo_write;
pub mod web_fetch;
pub mod web_search;
pub mod write;
pub mod zotero;

pub use bash::BashTool;
pub use edit::EditTool;
pub use glob::GlobTool;
pub use grep::GrepTool;
pub use ls::LsTool;
pub use memory::{MemoryReadTool, MemoryWriteTool};
pub use multi_edit::MultiEditTool;
pub use read::ReadTool;
pub use send_file::SendFileTool;
pub use skill_tool::SkillTool;
pub use task_output::TaskOutputTool;
pub use task_registry::{TaskId, TaskRegistry, TaskSnapshot, TaskStatus};
pub use task_stop::TaskStopTool;
pub use todo_write::{TodoItem, TodoStatus, TodoWriteTool};
pub use web_fetch::WebFetchTool;
pub use web_search::WebSearchTool;
pub use write::WriteTool;
pub use zotero::{ZoteroAnnotationsTool, ZoteroLookupTool, ZoteroReadTool, ZoteroSearchTool};

use snaca_skills::SkillRegistry;
use snaca_tools_api::{ToolRegistry, ToolRegistryBuilder};

/// Default M1 tool registry — the five read-only tools, ready to plug into
/// the engine.
pub fn default_m1_registry() -> ToolRegistry {
    ToolRegistryBuilder::default()
        .add(ReadTool)
        .add(GrepTool)
        .add(GlobTool)
        .add(LsTool)
        .add(BashTool)
        .build()
}

/// M2 registry — M1 read-only tools + Write/Edit/MultiEdit + `Skill` (if
/// any skills are registered). MCP-server tools are layered on top by the
/// server runtime; this fn is the in-tree default and doesn't know about
/// MCP.
pub fn default_m2_registry(skills: SkillRegistry) -> ToolRegistry {
    let mut b = base_tool_registry_builder();
    if !skills.is_empty() {
        b = b.add(SkillTool::new(skills));
    }
    b.build()
}

/// Tenant-agnostic base — built-in M1+M2 file/shell tools, no `Skill`,
/// no MCP. The engine layers a per-(tenant, project) `SkillTool` on top
/// at turn time so different tenants can have disjoint skill sets without
/// the engine holding a static `SkillRegistry`.
pub fn base_tool_registry() -> ToolRegistry {
    base_tool_registry_builder().build()
}

fn base_tool_registry_builder() -> ToolRegistryBuilder {
    ToolRegistryBuilder::default()
        .add(ReadTool)
        .add(GrepTool)
        .add(GlobTool)
        .add(LsTool)
        .add(BashTool)
        .add(WriteTool)
        .add(EditTool)
        .add(MultiEditTool)
        .add(TodoWriteTool)
        .add(MemoryReadTool)
        .add(MemoryWriteTool)
        .add(SendFileTool)
        // Background-task companion tools. They no-op cleanly when no
        // TaskRegistry is attached to the engine, so adding them to
        // the base set is safe in every deployment shape.
        .add(TaskOutputTool)
        .add(TaskStopTool)
        // Zotero context tools (M1). They surface a clear "host without
        // reverse-RPC" error in deployments that don't expose one, so
        // adding them to the base set is safe even outside scipen-studio.
        .add(ZoteroSearchTool)
        .add(ZoteroLookupTool)
        .add(ZoteroAnnotationsTool)
        .add(ZoteroReadTool)
        // Web tools. WebSearch needs TAVILY_API_KEY (else `execute` returns a
        // clear error, tool stays registered); WebFetch needs no key.
        .add(WebSearchTool::default())
        .add(WebFetchTool::new())
}
