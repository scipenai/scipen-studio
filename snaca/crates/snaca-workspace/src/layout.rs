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
    mode: WorkspaceLayoutMode,
    /// scipen-studio fork: when set, `workspace_dir()` returns this
    /// regardless of (tenant, project) or mode, so an editor host can
    /// point file tools at the user's real project directory while
    /// keeping SNACA metadata (memory/skills/db) under `data_root`.
    explicit_workspace: Option<PathBuf>,
}

#[derive(Debug, Clone)]
enum WorkspaceLayoutMode {
    MultiTenant { data_root: PathBuf },
    SingleProject { workspace_root: PathBuf },
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
        Ok(Self {
            mode: WorkspaceLayoutMode::MultiTenant { data_root },
            explicit_workspace: None,
        })
    }

    /// Construct a single-project layout rooted directly at an existing
    /// repository/workspace directory. Tool cwd resolves to `workspace_root`;
    /// SNACA-owned metadata lives under `workspace_root/.snaca/`.
    pub fn single_project(workspace_root: impl Into<PathBuf>) -> Result<Self, WorkspaceError> {
        let workspace_root = workspace_root.into();
        if !workspace_root.is_absolute() {
            return Err(WorkspaceError::RootNotAbsolute(
                workspace_root.display().to_string(),
            ));
        }
        Ok(Self {
            mode: WorkspaceLayoutMode::SingleProject { workspace_root },
            explicit_workspace: None,
        })

    }

    /// scipen-studio fork: pin the tool cwd to an explicit absolute
    /// directory (the user's real project), overriding the derived
    /// `workspace_dir`. Metadata paths (memory/skills/settings) still
    /// resolve under the layout's `data_root`.
    pub fn with_explicit_workspace(
        mut self,
        workspace_dir: impl Into<PathBuf>,
    ) -> Result<Self, WorkspaceError> {
        let dir = workspace_dir.into();
        if !dir.is_absolute() {
            return Err(WorkspaceError::RootNotAbsolute(dir.display().to_string()));
        }
        self.explicit_workspace = Some(dir);
        Ok(self)
    }

    pub fn data_root(&self) -> &Path {
        match &self.mode {
            WorkspaceLayoutMode::MultiTenant { data_root } => data_root,
            WorkspaceLayoutMode::SingleProject { workspace_root } => workspace_root,
        }
    }

    pub fn tenant_root(&self, tenant: &TenantId) -> PathBuf {
        match &self.mode {
            WorkspaceLayoutMode::MultiTenant { data_root } => data_root.join(tenant.as_str()),
            WorkspaceLayoutMode::SingleProject { workspace_root } => {
                workspace_root.join(".snaca").join("tenant")
            }
        }
    }

    pub fn tenant_settings(&self, tenant: &TenantId) -> PathBuf {
        self.tenant_root(tenant).join("settings.json")
    }

    pub fn tenant_skills_dir(&self, tenant: &TenantId) -> PathBuf {
        self.tenant_root(tenant).join("skills")
    }

    pub fn project_root(&self, tenant: &TenantId, project: &ProjectId) -> PathBuf {
        match &self.mode {
            WorkspaceLayoutMode::MultiTenant { .. } => self
                .tenant_root(tenant)
                .join("projects")
                .join(project.as_str()),
            WorkspaceLayoutMode::SingleProject { workspace_root } => workspace_root.join(".snaca"),
        }
    }

    /// Filesystem cwd for tools (Read/Write/Bash etc.).
    pub fn workspace_dir(&self, tenant: &TenantId, project: &ProjectId) -> PathBuf {
        if let Some(dir) = &self.explicit_workspace {
            return dir.clone();
        }
        match &self.mode {
            WorkspaceLayoutMode::MultiTenant { .. } => {
                self.project_root(tenant, project).join("workspace")
            }
            WorkspaceLayoutMode::SingleProject { workspace_root } => workspace_root.clone(),
        }
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

    #[test]
    fn single_project_uses_root_as_workspace_and_snaca_for_metadata() {
        let dir = tempdir();
        let l = WorkspaceLayout::single_project(&dir).unwrap();
        let t = TenantId::new("tenant");
        let p = ProjectId::from_raw("project");
        l.ensure_project(&t, &p).unwrap();

        assert_eq!(l.workspace_dir(&t, &p), dir);
        assert!(l.memory_dir(&t, &p).starts_with(dir.join(".snaca")));
        assert!(l.memory_dir(&t, &p).join("user").is_dir());

        std::fs::remove_dir_all(&dir).ok();
    }

    fn tempdir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("snaca-test-{}", uuid_for_test()));
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
