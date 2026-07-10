//! Workspace helpers for SDK users.

use crate::{ensure_absolute, Result};
pub use snaca_agent_api::{WorkspaceProvider, WorkspaceProviderError, WorkspaceRequest};
use snaca_workspace::{LocalWorkspaceProvider, WorkspaceLayout};
use std::path::PathBuf;

pub fn local(data_root: impl Into<PathBuf>) -> Result<LocalWorkspaceProvider> {
    let root = ensure_absolute(data_root.into())?;
    Ok(LocalWorkspaceProvider::new(WorkspaceLayout::new(root)?))
}

pub fn single_project(root: impl Into<PathBuf>) -> Result<LocalWorkspaceProvider> {
    let root = ensure_absolute(root.into())?;
    Ok(LocalWorkspaceProvider::new(
        WorkspaceLayout::single_project(root)?,
    ))
}
