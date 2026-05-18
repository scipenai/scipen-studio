//! `WorkspaceLayout` — multi-tenant filesystem layout helper.
//!
//! Resolves the canonical path for each tenant/project resource (workspace
//! cwd, memory tree, settings files, skills folders). All path computations
//! go through here so the layout is changed in exactly one place.

use crate::path_guard::WorkspaceError;
use snaca_core::{ProjectId, TenantId};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct WorkspaceLayout {
    data_root: PathBuf,
}

impl WorkspaceLayout {
    /// Construct a layout rooted at the given data directory. The path must
    /// be absolute — relative roots make path-traversal guards meaningless.
    pub fn new(data_root: impl Into<PathBuf>) -> Result<Self, WorkspaceError> {
        let data_root = data_root.into();
        if !data_root.is_absolute() {
            return Err(WorkspaceError::RootNotAbsolute(
                data_root.display().to_string(),
            ));
        }
        Ok(Self { data_root })
    }

    pub fn data_root(&self) -> &Path {
        &self.data_root
    }

    pub fn tenant_root(&self, tenant: &TenantId) -> PathBuf {
        self.data_root.join(tenant.as_str())
    }

    pub fn tenant_settings(&self, tenant: &TenantId) -> PathBuf {
        self.tenant_root(tenant).join("settings.json")
    }

    pub fn tenant_skills_dir(&self, tenant: &TenantId) -> PathBuf {
        self.tenant_root(tenant).join("skills")
    }

    pub fn project_root(&self, tenant: &TenantId, project: &ProjectId) -> PathBuf {
        self.tenant_root(tenant)
            .join("projects")
            .join(project.as_str())
    }

    /// Filesystem cwd for tools (Read/Write/Bash etc.).
    pub fn workspace_dir(&self, tenant: &TenantId, project: &ProjectId) -> PathBuf {
        self.project_root(tenant, project).join("workspace")
    }

    pub fn memory_dir(&self, tenant: &TenantId, project: &ProjectId) -> PathBuf {
        self.project_root(tenant, project).join("memory")
    }

    pub fn project_settings(&self, tenant: &TenantId, project: &ProjectId) -> PathBuf {
        self.project_root(tenant, project).join("settings.json")
    }

    pub fn project_skills_dir(&self, tenant: &TenantId, project: &ProjectId) -> PathBuf {
        self.project_root(tenant, project).join("skills")
    }

    /// Create the project directory tree if absent. Idempotent.
    pub fn ensure_project(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
    ) -> Result<(), WorkspaceError> {
        std::fs::create_dir_all(self.workspace_dir(tenant, project))?;
        let memory = self.memory_dir(tenant, project);
        for sub in ["user", "project", "reference", "feedback"] {
            std::fs::create_dir_all(memory.join(sub))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, TenantId};

    fn layout() -> WorkspaceLayout {
        WorkspaceLayout::new("/tmp/snaca-test-layout").unwrap()
    }

    #[test]
    fn rejects_relative_data_root() {
        let err = WorkspaceLayout::new("relative/data").unwrap_err();
        assert!(matches!(err, WorkspaceError::RootNotAbsolute(_)));
    }

    #[test]
    fn project_paths_are_consistent() {
        let l = layout();
        let t = TenantId::new("tenant_a");
        let p = ProjectId::from_raw("proj_x");
        assert_eq!(
            l.project_root(&t, &p),
            PathBuf::from("/tmp/snaca-test-layout/tenant_a/projects/proj_x")
        );
        assert_eq!(
            l.workspace_dir(&t, &p),
            PathBuf::from("/tmp/snaca-test-layout/tenant_a/projects/proj_x/workspace")
        );
        assert_eq!(
            l.memory_dir(&t, &p),
            PathBuf::from("/tmp/snaca-test-layout/tenant_a/projects/proj_x/memory")
        );
    }

    #[test]
    fn ensure_project_creates_subtree() {
        let dir = tempdir();
        let l = WorkspaceLayout::new(&dir).unwrap();
        let t = TenantId::new("tenant_z");
        let p = ProjectId::from_raw("proj_q");
        l.ensure_project(&t, &p).unwrap();

        assert!(l.workspace_dir(&t, &p).is_dir());
        for sub in ["user", "project", "reference", "feedback"] {
            assert!(l.memory_dir(&t, &p).join(sub).is_dir());
        }

        // Idempotent.
        l.ensure_project(&t, &p).unwrap();

        std::fs::remove_dir_all(&dir).ok();
    }

    fn tempdir() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "snaca-test-{}",
            uuid_for_test()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn uuid_for_test() -> String {
        // Avoid pulling uuid into dev-deps for one usage — use ns precision.
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{n}")
    }
}
