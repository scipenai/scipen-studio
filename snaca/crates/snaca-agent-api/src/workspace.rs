//! Workspace contracts for embeddable agent runtimes.

use async_trait::async_trait;
use snaca_core::{ProjectId, TenantId};
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct WorkspaceRequest {
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
}

#[derive(Debug, Error)]
pub enum WorkspaceProviderError {
    #[error("workspace root must be absolute: {0}")]
    RootNotAbsolute(String),

    #[error("workspace io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("workspace provider failed: {0}")]
    Other(String),
}

#[async_trait]
pub trait WorkspaceProvider: Send + Sync {
    async fn ensure_project(&self, request: WorkspaceRequest)
        -> Result<(), WorkspaceProviderError>;

    async fn workspace_root(
        &self,
        request: WorkspaceRequest,
    ) -> Result<PathBuf, WorkspaceProviderError>;
}
