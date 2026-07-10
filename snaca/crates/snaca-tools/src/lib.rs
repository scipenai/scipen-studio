//! `snaca-tools` — built-in tools.
//!
//! M1: Read / Grep / Glob / LS (and Bash with read-only allowlist).
//! M2: Write / Edit / MultiEdit / TodoWrite + landlock sandbox.
//! M3: MemoryRead / MemoryWrite.
//! Network: WebSearch (Tavily) / WebFetch (HTML→markdown).
//!
//! All filesystem-touching tools resolve paths through
//! `snaca_workspace::resolve_within` and reject anything that escapes the
//! per-project workspace root. There is no exception path.

#[cfg(feature = "interactive")]
pub mod ask_user_question;
#[cfg(feature = "shell")]
pub mod bash;
#[cfg(feature = "fs-write")]
pub mod edit;
#[cfg(any(feature = "fs-read", feature = "fs-write"))]
pub(crate) mod fs_util;
#[cfg(feature = "fs-read")]
pub mod glob;
#[cfg(feature = "fs-read")]
pub mod grep;
#[cfg(any(feature = "web-fetch", feature = "web-search"))]
pub(crate) mod http_client;
#[cfg(feature = "fs-read")]
pub mod ls;
#[cfg(feature = "memory")]
pub mod memory;
#[cfg(feature = "fs-write")]
pub mod multi_edit;
#[cfg(feature = "fs-read")]
pub mod read;
#[cfg(feature = "send-file")]
pub mod send_file;
#[cfg(feature = "session-search")]
pub mod session_search;
#[cfg(feature = "skills")]
pub mod skill_tool;
#[cfg(feature = "tasks")]
pub mod task_output;
#[cfg(feature = "tasks")]
pub mod task_registry;
#[cfg(feature = "tasks")]
pub mod task_stop;
#[cfg(feature = "todo")]
pub mod todo_write;
#[cfg(feature = "web-fetch")]
pub mod web_fetch;
#[cfg(feature = "web-search")]
pub mod web_search;
#[cfg(feature = "fs-write")]
pub mod write;
#[cfg(feature = "zotero")]
pub mod zotero;

#[cfg(feature = "interactive")]
pub use ask_user_question::AskUserQuestionTool;
#[cfg(feature = "shell")]
pub use bash::BashTool;
#[cfg(feature = "fs-write")]
pub use edit::EditTool;
#[cfg(feature = "fs-read")]
pub use glob::GlobTool;
#[cfg(feature = "fs-read")]
pub use grep::GrepTool;
#[cfg(feature = "fs-read")]
pub use ls::LsTool;
#[cfg(feature = "memory")]
pub use memory::{MemoryReadTool, MemoryWriteTool};
#[cfg(feature = "fs-write")]
pub use multi_edit::MultiEditTool;
#[cfg(feature = "fs-read")]
pub use read::ReadTool;
#[cfg(feature = "send-file")]
pub use send_file::SendFileTool;
#[cfg(feature = "session-search")]
pub use session_search::SessionSearchTool;
#[cfg(feature = "skills")]
pub use skill_tool::SkillTool;
#[cfg(feature = "tasks")]
pub use task_output::TaskOutputTool;
#[cfg(feature = "tasks")]
pub use task_registry::{TaskId, TaskRegistry, TaskSnapshot, TaskStatus};
#[cfg(feature = "tasks")]
pub use task_stop::TaskStopTool;
#[cfg(feature = "todo")]
pub use todo_write::{TodoItem, TodoStatus, TodoWriteTool};
#[cfg(feature = "web-fetch")]
pub use web_fetch::WebFetchTool;
#[cfg(feature = "web-search")]
pub use web_search::WebSearchTool;
#[cfg(feature = "fs-write")]
pub use write::WriteTool;
#[cfg(feature = "zotero")]
pub use zotero::{ZoteroAnnotationsTool, ZoteroLookupTool, ZoteroReadTool, ZoteroSearchTool};

#[cfg(feature = "skills")]
use snaca_skills::SkillRegistry;
use snaca_tools_api::{ToolRegistry, ToolRegistryBuilder};

/// Default M1 tool registry. With default features this matches the historical
/// set: filesystem read tools, Bash, and network read tools.
pub fn default_m1_registry() -> ToolRegistry {
    default_m1_registry_builder().build()
}

/// Read-only registry for SDK embeddings. Includes file inspection tools and
/// `WebFetch` when those features are enabled; deliberately excludes Bash.
pub fn read_only_registry() -> ToolRegistry {
    read_only_registry_builder().build()
}

/// File inspection plus write/edit tools. Available tools depend on enabled
/// crate features.
pub fn file_edit_registry() -> ToolRegistry {
    file_edit_registry_builder().build()
}

/// Network registry. Includes `WebSearch` and/or `WebFetch` when enabled.
pub fn web_registry() -> ToolRegistry {
    web_registry_builder().build()
}

/// Full in-tree coding registry for the currently enabled feature set.
pub fn coding_registry() -> ToolRegistry {
    base_tool_registry()
}

/// M2 registry — M1 read-only tools + Write/Edit/MultiEdit + `Skill` (if
/// any skills are registered). MCP-server tools are layered on top by the
/// server runtime; this fn is the in-tree default and doesn't know about
/// MCP.
#[cfg(feature = "skills")]
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
    let b = file_edit_registry_builder();
    let b = add_shell_tools(b);
    let b = add_todo_tools(b);
    let b = add_memory_tools(b);
    let b = add_session_search_tools(b);
    let b = add_send_file_tools(b);
    let b = add_task_tools(b);
    let b = add_zotero_tools(b);
    let b = add_web_tools(b);
    add_interactive_tools(b)
}

/// Zotero context tools (scipen-studio fork). They surface a clear
/// "host without reverse-RPC" tool_error in deployments that don't expose
/// one, so adding them to the base set is safe even outside scipen-studio.
#[cfg(feature = "zotero")]
fn add_zotero_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b.add(ZoteroSearchTool)
        .add(ZoteroLookupTool)
        .add(ZoteroAnnotationsTool)
        .add(ZoteroReadTool)
}

#[cfg(not(feature = "zotero"))]
fn add_zotero_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b
}

fn default_m1_registry_builder() -> ToolRegistryBuilder {
    let b = read_only_registry_builder();
    let b = add_shell_tools(b);
    add_web_tools(b)
}

fn read_only_registry_builder() -> ToolRegistryBuilder {
    #[allow(unused_mut)]
    let mut b = ToolRegistryBuilder::default();
    #[cfg(feature = "fs-read")]
    {
        b = b.add(ReadTool).add(GrepTool).add(GlobTool).add(LsTool);
    }
    #[cfg(feature = "web-fetch")]
    {
        b = b.add(WebFetchTool::new());
    }
    b
}

fn file_edit_registry_builder() -> ToolRegistryBuilder {
    add_write_tools(read_only_registry_builder())
}

fn web_registry_builder() -> ToolRegistryBuilder {
    add_web_tools(ToolRegistryBuilder::default())
}

#[cfg(feature = "fs-write")]
fn add_write_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b.add(WriteTool).add(EditTool).add(MultiEditTool)
}

#[cfg(not(feature = "fs-write"))]
fn add_write_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b
}

#[cfg(feature = "shell")]
fn add_shell_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b.add(BashTool)
}

#[cfg(not(feature = "shell"))]
fn add_shell_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b
}

#[cfg(feature = "todo")]
fn add_todo_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b.add(TodoWriteTool)
}

#[cfg(not(feature = "todo"))]
fn add_todo_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b
}

#[cfg(feature = "memory")]
fn add_memory_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b.add(MemoryReadTool).add(MemoryWriteTool)
}

#[cfg(not(feature = "memory"))]
fn add_memory_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b
}

#[cfg(feature = "session-search")]
fn add_session_search_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b.add(SessionSearchTool)
}

#[cfg(not(feature = "session-search"))]
fn add_session_search_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b
}

#[cfg(feature = "send-file")]
fn add_send_file_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b.add(SendFileTool)
}

#[cfg(not(feature = "send-file"))]
fn add_send_file_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b
}

#[cfg(feature = "tasks")]
fn add_task_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    // Background-task companion tools. They no-op cleanly when no
    // TaskRegistry is attached to the engine, so adding them to
    // the base set is safe in every deployment shape.
    b.add(TaskOutputTool).add(TaskStopTool)
}

#[cfg(not(feature = "tasks"))]
fn add_task_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b
}

fn add_web_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    #[allow(unused_mut)]
    let mut b = b;
    #[cfg(feature = "web-search")]
    {
        // WebSearch needs `TAVILY_API_KEY`; without it the tool is still
        // registered but every `execute` returns a clear error.
        b = b.add(WebSearchTool::from_env());
    }
    #[cfg(feature = "web-fetch")]
    {
        b = b.add(WebFetchTool::new());
    }
    b
}

#[cfg(feature = "interactive")]
fn add_interactive_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    // Interactive question tool. No-op (returns a clean tool_error)
    // when no QuestionGate is attached, so it's safe to include in
    // every deployment shape.
    b.add(AskUserQuestionTool)
}

#[cfg(not(feature = "interactive"))]
fn add_interactive_tools(b: ToolRegistryBuilder) -> ToolRegistryBuilder {
    b
}
