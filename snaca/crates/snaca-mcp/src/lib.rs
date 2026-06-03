//! `snaca-mcp` — Model Context Protocol client + tool adapter.
//!
//! Wraps the `rmcp` SDK and exposes each MCP-server's tools to the engine
//! through SNACA's `Tool` trait. Tool names are namespaced
//! `mcp__<server>__<tool>` so multiple servers can coexist in the same
//! `ToolRegistry`.
//!
//! M2 scope: stdio child-process transport only. M3 adds SSE / Streamable
//! HTTP. Multi-tenant subprocess isolation (one process per
//! `(tenant, project, server)`) is also M3 — M2 spawns one process per
//! configured server, shared across tenants.
//!
//! Layout:
//! - [`config`]  — `McpServerConfig` + `mcp__server__tool` namespacing helpers
//! - [`error`]   — `McpError` / `McpResult`
//! - [`client`]  — `McpClient` — one rmcp connection
//! - [`tool`]    — `McpTool` — adapts an rmcp tool to the SNACA `Tool` trait
//! - [`manager`] — `McpManager` — fans out across multiple servers

pub mod client;
pub mod config;
pub mod error;
pub mod manager;
pub mod pool;
pub mod tool;

pub use client::McpClient;
pub use config::{
    find_duplicate_server_name, qualified_tool_name, split_qualified_name, validate_server_name,
    McpServerConfig, McpTransport,
};
pub use error::{McpError, McpResult};
pub use manager::McpManager;
pub use pool::McpPool;
pub use tool::McpTool;
