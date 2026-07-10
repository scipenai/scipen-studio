//! Lightweight SDK-side agent configuration.
//!
//! This deliberately does not mirror `snaca-server`'s deployment config. SDK
//! embedders usually configure agents from code, and server-only concepts such
//! as IM plugins, admin HTTP, outbox workers, and schedulers do not belong in
//! the embeddable agent surface.

use crate::EngineConfig;
use snaca_core::{ProjectId, TenantId, ThreadId};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentToolPreset {
    Empty,
    ReadOnly,
    Coding,
    Web,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentWorkspaceConfig {
    /// Use the SDK default data root (`$TMPDIR/snaca-sdk-data`) unless the
    /// builder is also configured explicitly.
    DefaultDataRoot,
    /// Use SNACA's multi-tenant data-root layout under this path.
    DataRoot(PathBuf),
    /// Use this directory directly as the tool workspace and keep SNACA
    /// metadata under `<root>/.snaca/`.
    SingleProject(PathBuf),
}

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub tool_preset: AgentToolPreset,
    pub workspace: AgentWorkspaceConfig,
    pub engine: Option<EngineConfig>,
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    pub thread_id: ThreadId,
}

impl AgentConfig {
    pub fn minimal() -> Self {
        Self {
            tool_preset: AgentToolPreset::Empty,
            ..Self::default()
        }
    }

    pub fn read_only() -> Self {
        Self {
            tool_preset: AgentToolPreset::ReadOnly,
            ..Self::default()
        }
    }

    pub fn coding() -> Self {
        Self {
            tool_preset: AgentToolPreset::Coding,
            ..Self::default()
        }
    }

    pub fn web() -> Self {
        Self {
            tool_preset: AgentToolPreset::Web,
            ..Self::default()
        }
    }

    pub fn tool_preset(mut self, preset: AgentToolPreset) -> Self {
        self.tool_preset = preset;
        self
    }

    pub fn data_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.workspace = AgentWorkspaceConfig::DataRoot(root.into());
        self
    }

    pub fn single_project_workspace(mut self, root: impl Into<PathBuf>) -> Self {
        self.workspace = AgentWorkspaceConfig::SingleProject(root.into());
        self
    }

    pub fn engine_config(mut self, config: EngineConfig) -> Self {
        self.engine = Some(config);
        self
    }

    pub fn tenant_id(mut self, tenant_id: TenantId) -> Self {
        self.tenant_id = tenant_id;
        self
    }

    pub fn project_id(mut self, project_id: ProjectId) -> Self {
        self.project_id = project_id;
        self
    }

    pub fn thread_id(mut self, thread_id: ThreadId) -> Self {
        self.thread_id = thread_id;
        self
    }
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            tool_preset: AgentToolPreset::Empty,
            workspace: AgentWorkspaceConfig::DefaultDataRoot,
            engine: None,
            tenant_id: TenantId::new("default"),
            project_id: ProjectId::from_raw("default"),
            thread_id: ThreadId::new("default"),
        }
    }
}
