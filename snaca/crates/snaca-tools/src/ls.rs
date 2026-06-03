//! `LS` — list directory contents.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use snaca_workspace::resolve_within;
use std::path::Path;

const MAX_ENTRIES: usize = 500;

#[derive(Debug, Deserialize)]
struct LsInput {
    /// Path relative to the workspace root. Use "" or "." for the root.
    #[serde(default)]
    path: Option<String>,
}

pub struct LsTool;

#[async_trait]
impl Tool for LsTool {
    fn name(&self) -> &str {
        "LS"
    }

    fn description(&self) -> &str {
        "List directory entries in the project workspace. Directories are \
         suffixed with `/`; files are followed by their byte size."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path relative to workspace root. Default workspace root."
                }
            }
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::read_only_filesystem()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input: LsInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        let target = match input.path.as_deref().unwrap_or("") {
            "" | "." => ctx.workspace_root().to_path_buf(),
            other => resolve_within(ctx.workspace_root(), Path::new(other))
                .map_err(|e| ToolError::PathOutsideWorkspace(e.to_string()))?,
        };

        let metadata = match tokio::fs::metadata(&target).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(ToolError::NotFound(input.path.unwrap_or_default()));
            }
            Err(e) => return Err(ToolError::Io(e)),
        };
        if !metadata.is_dir() {
            return Err(ToolError::InvalidInput(format!(
                "{} is not a directory",
                target.display()
            )));
        }

        let mut entries: Vec<String> = Vec::new();
        let mut iter = tokio::fs::read_dir(&target).await?;
        while let Some(entry) = iter.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            let ft = entry.file_type().await?;
            if ft.is_dir() {
                entries.push(format!("{}/", name));
            } else if ft.is_file() {
                let size = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
                entries.push(format!("{}\t({} bytes)", name, size));
            } else {
                entries.push(format!("{}@", name));
            }
            if entries.len() >= MAX_ENTRIES {
                entries.push(format!(
                    "<truncated at {} entries; use Glob to enumerate>",
                    MAX_ENTRIES
                ));
                break;
            }
        }
        entries.sort();
        if entries.is_empty() {
            return Ok(ToolOutput::text("<empty directory>".to_string()));
        }
        Ok(ToolOutput::text(entries.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, SessionId, TenantId};

    fn ctx(root: &Path) -> ToolContext {
        ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            root.to_path_buf(),
        )
    }

    #[tokio::test]
    async fn lists_files_and_dirs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("README.md"), "hello").unwrap();

        let out = LsTool
            .execute(json!({}), &ctx(dir.path()))
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("src/"));
        assert!(out.contains("README.md\t(5 bytes)"));
    }

    #[tokio::test]
    async fn empty_directory_marker() {
        let dir = tempfile::tempdir().unwrap();
        let out = LsTool
            .execute(json!({}), &ctx(dir.path()))
            .await
            .unwrap()
            .render_text();
        assert_eq!(out, "<empty directory>");
    }

    #[tokio::test]
    async fn rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let err = LsTool
            .execute(json!({"path": "../"}), &ctx(dir.path()))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::PathOutsideWorkspace(_)));
    }

    #[tokio::test]
    async fn rejects_file_target() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        let err = LsTool
            .execute(json!({"path": "a.txt"}), &ctx(dir.path()))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }
}
