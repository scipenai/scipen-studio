//! `snaca-agent-api::WorkspaceProvider` adapter for local workspaces.

use crate::{WorkspaceError, WorkspaceLayout};
use async_trait::async_trait;
use snaca_agent_api::{WorkspaceProvider, WorkspaceProviderError, WorkspaceRequest};
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct LocalWorkspaceProvider {
    layout: WorkspaceLayout,
}

impl LocalWorkspaceProvider {
    pub fn new(layout: WorkspaceLayout) -> Self {
        Self { layout }
    }

    pub fn single_project(root: impl Into<PathBuf>) -> Result<Self, WorkspaceProviderError> {
        let root = absolutize(root.into())?;
        Ok(Self::new(
            WorkspaceLayout::single_project(root).map_err(map_workspace_error)?,
        ))
    }

    pub fn layout(&self) -> &WorkspaceLayout {
        &self.layout
    }

    pub fn into_layout(self) -> WorkspaceLayout {
        self.layout
    }

    pub fn workspace_root_hint(&self) -> PathBuf {
        self.layout.data_root().to_path_buf()
    }
}

#[async_trait]
impl WorkspaceProvider for LocalWorkspaceProvider {
    async fn ensure_project(
        &self,
        request: WorkspaceRequest,
    ) -> Result<(), WorkspaceProviderError> {
        self.layout
            .ensure_project(&request.tenant_id, &request.project_id)
            .map_err(map_workspace_error)
    }

    async fn workspace_root(
        &self,
        request: WorkspaceRequest,
    ) -> Result<PathBuf, WorkspaceProviderError> {
        self.ensure_project(request.clone()).await?;
        Ok(self
            .layout
            .workspace_dir(&request.tenant_id, &request.project_id))
    }
}

fn absolutize(path: PathBuf) -> Result<PathBuf, WorkspaceProviderError> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn map_workspace_error(error: WorkspaceError) -> WorkspaceProviderError {
    match error {
        WorkspaceError::RootNotAbsolute(path) => WorkspaceProviderError::RootNotAbsolute(path),
        WorkspaceError::Io(e) => WorkspaceProviderError::Io(e),
        WorkspaceError::PathOutsideRoot { input } => {
            WorkspaceProviderError::Other(format!("path escapes workspace root: {input}"))
        }
        WorkspaceError::AbsoluteNotInRoot { input } => {
            WorkspaceProviderError::Other(format!("absolute path outside workspace root: {input}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, TenantId};

    #[tokio::test]
    async fn local_workspace_provider_creates_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        let provider = LocalWorkspaceProvider::new(WorkspaceLayout::new(dir.path()).unwrap());
        let request = WorkspaceRequest {
            tenant_id: TenantId::new("tenant"),
            project_id: ProjectId::from_raw("project"),
        };
        provider.ensure_project(request.clone()).await.unwrap();
        let root = provider.workspace_root(request).await.unwrap();
        assert!(root.is_dir());
        assert!(root.ends_with("workspace"));
    }

    #[tokio::test]
    async fn single_project_provider_returns_requested_root() {
        let dir = tempfile::tempdir().unwrap();
        let provider = LocalWorkspaceProvider::single_project(dir.path()).unwrap();
        let request = WorkspaceRequest {
            tenant_id: TenantId::new("tenant"),
            project_id: ProjectId::from_raw("project"),
        };
        let root = provider.workspace_root(request).await.unwrap();
        assert_eq!(root, dir.path());
        assert!(dir.path().join(".snaca/memory/user").is_dir());
    }
}
