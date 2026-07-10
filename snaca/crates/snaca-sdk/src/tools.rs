//! Built-in tool registry presets.

pub use snaca_tools::*;
use snaca_tools_api::ToolRegistry;

/// No tools. Useful for chat-only agents or tests.
pub fn empty() -> ToolRegistry {
    ToolRegistry::empty()
}

/// Read-only starter set. This intentionally excludes `Bash` even though the
/// historical M1 registry included it with a read-only allowlist; SDK callers
/// should opt into command execution explicitly.
pub fn read_only() -> ToolRegistry {
    snaca_tools::read_only_registry()
}

/// Full in-tree coding tool set. Includes filesystem writes, Bash, memory,
/// task, web, file-send, and interactive-question tools.
pub fn coding() -> ToolRegistry {
    snaca_tools::coding_registry()
}

/// Network-only starter set. Includes `WebFetch` and/or `WebSearch` depending
/// on enabled `snaca-tools` features.
pub fn web() -> ToolRegistry {
    snaca_tools::web_registry()
}
