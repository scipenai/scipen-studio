//! `snaca-agent-api::MemoryProvider` adapter for the file-tree memory store.
//!
//! This is the only built-in implementation. It maps the
//! `MemoryProvider` trait directly onto a project's `MemoryStore`
//! under `<workspace>/<tenant>/projects/<project>/memory/`. The vector
//! recall layer that previously sat on top has been removed; recall
//! is no longer part of the trait.

use crate::{MemoryError, MemoryScope, MemoryStore};
use async_trait::async_trait;
use snaca_agent_api::{
    MemoryEntryData, MemoryIndexRequest, MemoryListRequest, MemoryProvider, MemoryProviderError,
    MemoryReadRequest, MemoryWriteRequest,
};
use snaca_core::{ProjectId, TenantId};
use snaca_workspace::WorkspaceLayout;

#[derive(Clone)]
pub struct FileTreeMemoryProvider {
    workspace: WorkspaceLayout,
}

impl FileTreeMemoryProvider {
    pub fn new(workspace: WorkspaceLayout) -> Self {
        Self { workspace }
    }

    fn store(&self, tenant: &TenantId, project: &ProjectId) -> MemoryStore {
        MemoryStore::new(self.workspace.memory_dir(tenant, project))
    }
}

#[async_trait]
impl MemoryProvider for FileTreeMemoryProvider {
    async fn index(&self, request: MemoryIndexRequest) -> Result<String, MemoryProviderError> {
        self.workspace
            .ensure_project(&request.tenant_id, &request.project_id)
            .map_err(map_workspace_error)?;
        let store = self.store(&request.tenant_id, &request.project_id);
        crate::render_snapshot(&store, &crate::RenderConfig::default())
            .await
            .map(|snap| snap.text)
            .map_err(MemoryProviderError::Io)
    }

    async fn list(&self, request: MemoryListRequest) -> Result<Vec<String>, MemoryProviderError> {
        let scope = parse_scope(&request.scope)?;
        self.workspace
            .ensure_project(&request.tenant_id, &request.project_id)
            .map_err(map_workspace_error)?;
        self.store(&request.tenant_id, &request.project_id)
            .list(scope)
            .await
            .map_err(map_memory_error)
    }

    async fn write(
        &self,
        request: MemoryWriteRequest,
    ) -> Result<MemoryEntryData, MemoryProviderError> {
        let scope = parse_scope(&request.scope)?;
        self.workspace
            .ensure_project(&request.tenant_id, &request.project_id)
            .map_err(map_workspace_error)?;
        let entry = self
            .store(&request.tenant_id, &request.project_id)
            .write(scope, &request.name, &request.content)
            .await
            .map_err(map_memory_error)?;
        Ok(entry.into())
    }

    async fn read(
        &self,
        request: MemoryReadRequest,
    ) -> Result<MemoryEntryData, MemoryProviderError> {
        let scope = parse_scope(&request.scope)?;
        self.workspace
            .ensure_project(&request.tenant_id, &request.project_id)
            .map_err(map_workspace_error)?;
        let entry = self
            .store(&request.tenant_id, &request.project_id)
            .read(scope, &request.name)
            .await
            .map_err(map_memory_error)?;
        Ok(entry.into())
    }
}

impl From<crate::MemoryEntry> for MemoryEntryData {
    fn from(entry: crate::MemoryEntry) -> Self {
        Self {
            scope: entry.scope.as_str().to_string(),
            name: entry.name,
            content: entry.content,
        }
    }
}

fn parse_scope(scope: &str) -> Result<MemoryScope, MemoryProviderError> {
    MemoryScope::from_dir_name(scope)
        .ok_or_else(|| MemoryProviderError::InvalidScope(scope.to_string()))
}

fn map_memory_error(error: MemoryError) -> MemoryProviderError {
    match error {
        MemoryError::InvalidName { name, reason } => {
            MemoryProviderError::Other(format!("invalid memory entry name {name:?}: {reason}"))
        }
        MemoryError::NotFound { scope, name } => MemoryProviderError::NotFound {
            scope: scope.as_str().to_string(),
            name,
        },
        MemoryError::Io(e) => MemoryProviderError::Io(e),
        MemoryError::ExternalExtractorRequired { kind, filename } => MemoryProviderError::Other(
            format!("external extractor required for {kind} file {filename:?}"),
        ),
        MemoryError::EntryTooLarge {
            filename,
            bytes,
            limit,
        } => MemoryProviderError::Other(format!(
            "memory entry too large for {filename:?}: {bytes} bytes (limit {limit})"
        )),
        MemoryError::ImportScopeBlocked { scope } => MemoryProviderError::Other(format!(
            "memory scope {scope} is not allowed as an import target"
        )),
        MemoryError::ThreatBlocked { kind, description } => MemoryProviderError::Other(format!(
            "memory write blocked by threat scanner: {kind} ({description})"
        )),
        MemoryError::ExternalDrift { path, backup_path } => MemoryProviderError::Other(format!(
            "memory entry {path:?} was modified externally; backed up to {backup_path:?} — re-read and retry"
        )),
    }
}

fn map_workspace_error(error: snaca_workspace::WorkspaceError) -> MemoryProviderError {
    match error {
        snaca_workspace::WorkspaceError::Io(e) => MemoryProviderError::Io(e),
        other => MemoryProviderError::Other(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_agent_api::{
        MemoryIndexRequest, MemoryListRequest, MemoryProvider, MemoryReadRequest,
        MemoryWriteRequest,
    };

    #[tokio::test]
    async fn file_tree_memory_provider_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let provider = FileTreeMemoryProvider::new(WorkspaceLayout::new(dir.path()).unwrap());
        let tenant_id = TenantId::new("tenant");
        let project_id = ProjectId::from_raw("project");

        let written = provider
            .write(MemoryWriteRequest {
                tenant_id: tenant_id.clone(),
                project_id: project_id.clone(),
                scope: "project".into(),
                name: "Conventions".into(),
                content: "Use Rust 2021.".into(),
            })
            .await
            .unwrap();
        assert_eq!(written.scope, "project");
        assert_eq!(written.name, "conventions");

        let read = provider
            .read(MemoryReadRequest {
                tenant_id: tenant_id.clone(),
                project_id: project_id.clone(),
                scope: "project".into(),
                name: "conventions".into(),
            })
            .await
            .unwrap();
        assert_eq!(read.content, "Use Rust 2021.");

        let listed = provider
            .list(MemoryListRequest {
                tenant_id: tenant_id.clone(),
                project_id: project_id.clone(),
                scope: "project".into(),
            })
            .await
            .unwrap();
        assert_eq!(listed, vec!["conventions"]);

        let index = provider
            .index(MemoryIndexRequest {
                tenant_id,
                project_id,
            })
            .await
            .unwrap();
        assert!(index.contains("project/conventions"));
        assert!(
            index.contains("Use Rust 2021."),
            "provider index should render the frozen snapshot body, got: {index}"
        );
    }
}
