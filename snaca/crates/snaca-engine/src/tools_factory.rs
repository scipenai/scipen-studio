//! Per-(tenant, project) tool registry composition.
//!
//! Without this hook the engine would have to hold one static `ToolRegistry`
//! shared across every tenant and project — fine for single-tenant
//! deployments, but it would also leak skill names across tenants and
//! force every project to expose the same MCP servers.
//!
//! `RuntimeToolFactory::build` is called once per turn. The implementation
//! is free to:
//! - return a cached registry per `(tenant, project)`
//! - layer a dynamic `SkillTool` on top of a shared base set
//! - filter MCP-server tools by tenant policy
//!
//! Concrete implementations live in `snaca-server` (which knows about
//! skills + MCP + base tools simultaneously); this crate only defines
//! the trait so it can stay free of those dependencies.

use async_trait::async_trait;
use snaca_core::{ProjectId, TenantId};
use snaca_tools_api::ToolRegistry;

#[async_trait]
pub trait RuntimeToolFactory: Send + Sync {
    /// Compose the tool registry the engine will surface to the LLM for
    /// the upcoming turn. Called once per turn before the first LLM call;
    /// the resulting registry is reused across iterations within the turn.
    async fn build(&self, tenant: &TenantId, project: &ProjectId) -> ToolRegistry;
}
