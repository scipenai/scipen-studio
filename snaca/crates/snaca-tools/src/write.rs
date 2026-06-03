//! `Write` — create or overwrite a file in the project workspace.
//!
//! M2 safety:
//! - Path resolved through `snaca_workspace::resolve_within` — escape attempts
//!   are rejected before we touch the filesystem.
//! - Parent directories are auto-created so the LLM doesn't need to issue
//!   a separate `mkdir` step.
//! - 5 MB hard ceiling on a single write so a runaway model can't fill the
//!   disk.
//!
//! M3 will add landlock confinement so even read-only tools can't be
//! tricked into reading data outside the project workspace.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use snaca_workspace::resolve_within;
use std::path::Path;

const MAX_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct WriteInput {
    path: String,
    content: String,
}

pub struct WriteTool;

#[async_trait]
impl Tool for WriteTool {
    fn name(&self) -> &str {
        "Write"
    }

    fn description(&self) -> &str {
        "Create or overwrite a file in the project workspace. The file is \
         written verbatim — no diff, no merge. Use Edit/MultiEdit when you \
         only want to change part of an existing file. Parent directories \
         are created automatically. 5 MB ceiling per call."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path relative to the project workspace root."
                },
                "content": {
                    "type": "string",
                    "description": "Full file content. Replaces any existing file at this path."
                }
            },
            "required": ["path", "content"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::writes_filesystem()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::UnlessRemembered
    }

    fn is_read_only(&self) -> bool {
        false
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input: WriteInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;

        if input.content.len() > MAX_BYTES {
            return Err(ToolError::Execution(format!(
                "{}: content is {} bytes; ceiling is {} bytes",
                input.path,
                input.content.len(),
                MAX_BYTES
            )));
        }

        let resolved = resolve_within(ctx.workspace_root(), Path::new(&input.path))
            .map_err(|e| ToolError::PathOutsideWorkspace(e.to_string()))?;

        if let Some(parent) = resolved.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        tokio::fs::write(&resolved, input.content.as_bytes()).await?;

        let line_count = if input.content.is_empty() {
            0
        } else {
            // Same convention as `wc -l`: count newlines, plus one if the
            // file doesn't end with one.
            let nl = input.content.bytes().filter(|b| *b == b'\n').count();
            if input.content.ends_with('\n') {
                nl
            } else {
                nl + 1
            }
        };

        Ok(ToolOutput::text(format!(
            "wrote {} line{} ({} bytes) to {}",
            line_count,
            if line_count == 1 { "" } else { "s" },
            input.content.len(),
            input.path
        )))
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
    async fn writes_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let out = WriteTool
            .execute(
                json!({"path": "a.txt", "content": "hello\nworld\n"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("2 lines"));
        let on_disk = std::fs::read_to_string(dir.path().join("a.txt")).unwrap();
        assert_eq!(on_disk, "hello\nworld\n");
    }

    #[tokio::test]
    async fn overwrites_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "old").unwrap();
        WriteTool
            .execute(
                json!({"path": "a.txt", "content": "new"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap();
        let on_disk = std::fs::read_to_string(dir.path().join("a.txt")).unwrap();
        assert_eq!(on_disk, "new");
    }

    #[tokio::test]
    async fn auto_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        WriteTool
            .execute(
                json!({"path": "src/sub/lib.rs", "content": "fn main() {}\n"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap();
        assert!(dir.path().join("src/sub/lib.rs").exists());
    }

    #[tokio::test]
    async fn rejects_path_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let err = WriteTool
            .execute(
                json!({"path": "../escape.txt", "content": "x"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::PathOutsideWorkspace(_)));
    }

    #[tokio::test]
    async fn rejects_oversized_content() {
        let dir = tempfile::tempdir().unwrap();
        let big = "x".repeat(MAX_BYTES + 1);
        let err = WriteTool
            .execute(
                json!({"path": "big.txt", "content": big}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::Execution(_)));
    }

    #[tokio::test]
    async fn empty_content_writes_zero_byte_file() {
        let dir = tempfile::tempdir().unwrap();
        WriteTool
            .execute(
                json!({"path": "empty", "content": ""}),
                &ctx(dir.path()),
            )
            .await
            .unwrap();
        let metadata = std::fs::metadata(dir.path().join("empty")).unwrap();
        assert_eq!(metadata.len(), 0);
    }
}
