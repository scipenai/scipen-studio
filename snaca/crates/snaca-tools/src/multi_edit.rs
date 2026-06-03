//! `MultiEdit` — apply a sequence of edits to one file, atomically.
//!
//! All edits run against an in-memory string; the file is only written
//! when every edit succeeds. If edit #N fails, edits #1..N-1 are
//! discarded — the file on disk is unchanged. This avoids the half-edited
//! state Edit can leave when the model issues a chain of changes that
//! depend on each other.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use snaca_workspace::resolve_within;
use std::path::Path;

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct MultiEditInput {
    path: String,
    edits: Vec<EditOp>,
}

#[derive(Debug, Deserialize)]
struct EditOp {
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

pub struct MultiEditTool;

#[async_trait]
impl Tool for MultiEditTool {
    fn name(&self) -> &str {
        "MultiEdit"
    }

    fn description(&self) -> &str {
        "Apply a sequence of Edit operations to one file in order. Each \
         edit follows the same rules as the Edit tool (unique match unless \
         replace_all is true). The file is written only if every edit \
         succeeds — atomic with respect to disk state."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path relative to the project workspace root."
                },
                "edits": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "old_string": {"type": "string"},
                            "new_string": {"type": "string"},
                            "replace_all": {"type": "boolean", "default": false}
                        },
                        "required": ["old_string", "new_string"]
                    }
                }
            },
            "required": ["path", "edits"]
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
        let input: MultiEditInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;

        if input.edits.is_empty() {
            return Err(ToolError::InvalidInput("edits must not be empty".into()));
        }

        let resolved = resolve_within(ctx.workspace_root(), Path::new(&input.path))
            .map_err(|e| ToolError::PathOutsideWorkspace(e.to_string()))?;

        let metadata = match tokio::fs::metadata(&resolved).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(ToolError::NotFound(input.path.clone()));
            }
            Err(e) => return Err(ToolError::Io(e)),
        };
        if !metadata.is_file() {
            return Err(ToolError::InvalidInput(format!(
                "{} is not a regular file",
                input.path
            )));
        }
        if metadata.len() > MAX_FILE_BYTES {
            return Err(ToolError::Execution(format!(
                "{} is {} bytes; refusing to edit (ceiling {})",
                input.path,
                metadata.len(),
                MAX_FILE_BYTES
            )));
        }

        // Same Read-before-Edit gate as Edit. See edit.rs for rationale.
        if ctx.read_tracker_active() {
            match ctx.last_read(&resolved) {
                None => {
                    return Err(ToolError::InvalidInput(format!(
                        "{} must be Read before editing — call Read first",
                        input.path
                    )));
                }
                Some(prev) => {
                    if prev.partial {
                        return Err(ToolError::InvalidInput(format!(
                            "{} was Read with offset/limit (only part of the file \
                             is in context). MultiEdit refuses partial reads — an \
                             old_string may match text outside the window, which \
                             would silently corrupt the unread portion. Re-Read \
                             without offset/limit, then retry.",
                            input.path
                        )));
                    }
                    let current_mtime = metadata.modified().ok();
                    if Some(prev.mtime) != current_mtime || prev.size != metadata.len() {
                        return Err(ToolError::Execution(format!(
                            "{} changed on disk since it was last Read — Read again before editing",
                            input.path
                        )));
                    }
                }
            }
        }

        let bytes = tokio::fs::read(&resolved).await?;
        let mut content = String::from_utf8(bytes).map_err(|_| {
            ToolError::Execution(format!(
                "{} is not valid UTF-8; refusing to edit",
                input.path
            ))
        })?;

        let mut total_replaced = 0usize;
        for (idx, edit) in input.edits.iter().enumerate() {
            let edit_no = idx + 1;
            if edit.old_string.is_empty() {
                return Err(ToolError::InvalidInput(format!(
                    "edit #{edit_no}: old_string must not be empty"
                )));
            }
            if edit.old_string == edit.new_string {
                return Err(ToolError::InvalidInput(format!(
                    "edit #{edit_no}: old_string == new_string would be a no-op"
                )));
            }
            let count = content.matches(&edit.old_string).count();
            if count == 0 {
                return Err(ToolError::NotFound(format!(
                    "edit #{edit_no}: pattern not found in current state of {}",
                    input.path
                )));
            }
            if count > 1 && !edit.replace_all {
                return Err(ToolError::InvalidInput(format!(
                    "edit #{edit_no}: matches {count} times; refine the match or pass replace_all: true"
                )));
            }
            content = if edit.replace_all {
                content.replace(&edit.old_string, &edit.new_string)
            } else {
                content.replacen(&edit.old_string, &edit.new_string, 1)
            };
            total_replaced += if edit.replace_all { count } else { 1 };
        }

        tokio::fs::write(&resolved, content.as_bytes()).await?;

        if let Ok(meta) = tokio::fs::metadata(&resolved).await {
            if let Ok(mtime) = meta.modified() {
                ctx.record_read(&resolved, mtime, meta.len());
            }
        }

        Ok(ToolOutput::text(format!(
            "applied {} edits ({} total replacements) to {}",
            input.edits.len(),
            total_replaced,
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
    async fn applies_sequential_edits() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha beta gamma").unwrap();
        let out = MultiEditTool
            .execute(
                json!({
                    "path": "a.txt",
                    "edits": [
                        {"old_string": "alpha", "new_string": "ALPHA"},
                        {"old_string": "gamma", "new_string": "GAMMA"}
                    ]
                }),
                &ctx(dir.path()),
            )
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("2 edits"));
        let on_disk = std::fs::read_to_string(dir.path().join("a.txt")).unwrap();
        assert_eq!(on_disk, "ALPHA beta GAMMA");
    }

    #[tokio::test]
    async fn rolls_back_on_failed_edit() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha beta").unwrap();
        let err = MultiEditTool
            .execute(
                json!({
                    "path": "a.txt",
                    "edits": [
                        {"old_string": "alpha", "new_string": "ALPHA"},
                        {"old_string": "missing", "new_string": "x"}
                    ]
                }),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::NotFound(_)));
        // File untouched — atomic semantics.
        let on_disk = std::fs::read_to_string(dir.path().join("a.txt")).unwrap();
        assert_eq!(on_disk, "alpha beta");
    }

    #[tokio::test]
    async fn later_edit_can_match_earlier_replacement() {
        // Edit #2 matches text introduced by edit #1.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "name = foo").unwrap();
        MultiEditTool
            .execute(
                json!({
                    "path": "a.txt",
                    "edits": [
                        {"old_string": "name = foo", "new_string": "name = bar"},
                        {"old_string": "name = bar", "new_string": "id = bar"}
                    ]
                }),
                &ctx(dir.path()),
            )
            .await
            .unwrap();
        let on_disk = std::fs::read_to_string(dir.path().join("a.txt")).unwrap();
        assert_eq!(on_disk, "id = bar");
    }

    #[tokio::test]
    async fn empty_edits_rejected() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        let err = MultiEditTool
            .execute(
                json!({"path": "a.txt", "edits": []}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn ambiguous_edit_rejected_without_replace_all() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x x").unwrap();
        let err = MultiEditTool
            .execute(
                json!({
                    "path": "a.txt",
                    "edits": [{"old_string": "x", "new_string": "y"}]
                }),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn missing_file_yields_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let err = MultiEditTool
            .execute(
                json!({
                    "path": "nope.txt",
                    "edits": [{"old_string": "a", "new_string": "b"}]
                }),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::NotFound(_)));
    }

    fn ctx_tracked(root: &Path) -> ToolContext {
        let tracker: snaca_tools_api::ReadTracker =
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
        ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            root.to_path_buf(),
        )
        .with_read_tracker(tracker)
    }

    #[tokio::test]
    async fn tracker_rejects_without_prior_read() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha beta").unwrap();
        let err = MultiEditTool
            .execute(
                json!({
                    "path": "a.txt",
                    "edits": [{"old_string": "alpha", "new_string": "ALPHA"}]
                }),
                &ctx_tracked(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&err, ToolError::InvalidInput(msg) if msg.contains("Read")),
            "got: {err:?}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "alpha beta"
        );
    }

    #[tokio::test]
    async fn tracker_allows_after_read() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha beta gamma").unwrap();
        let c = ctx_tracked(dir.path());

        crate::read::ReadTool
            .execute(json!({"path": "a.txt"}), &c)
            .await
            .unwrap();

        MultiEditTool
            .execute(
                json!({
                    "path": "a.txt",
                    "edits": [
                        {"old_string": "alpha", "new_string": "ALPHA"},
                        {"old_string": "gamma", "new_string": "GAMMA"}
                    ]
                }),
                &c,
            )
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "ALPHA beta GAMMA"
        );
    }

    #[tokio::test]
    async fn tracker_rejects_after_partial_read() {
        let dir = tempfile::tempdir().unwrap();
        let body: String = (1..=50).map(|i| format!("line {i}\n")).collect();
        std::fs::write(dir.path().join("a.txt"), &body).unwrap();
        let c = ctx_tracked(dir.path());

        crate::read::ReadTool
            .execute(json!({"path": "a.txt", "limit": 5}), &c)
            .await
            .unwrap();

        let err = MultiEditTool
            .execute(
                json!({
                    "path": "a.txt",
                    "edits": [{"old_string": "line 1", "new_string": "LINE 1"}]
                }),
                &c,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&err, ToolError::InvalidInput(msg) if msg.contains("partial")),
            "got: {err:?}"
        );
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), body);
    }

    #[tokio::test]
    async fn tracker_rejects_after_external_modification() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha beta").unwrap();
        let c = ctx_tracked(dir.path());

        crate::read::ReadTool
            .execute(json!({"path": "a.txt"}), &c)
            .await
            .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        std::fs::write(dir.path().join("a.txt"), "delta epsilon").unwrap();

        let err = MultiEditTool
            .execute(
                json!({
                    "path": "a.txt",
                    "edits": [{"old_string": "delta", "new_string": "DELTA"}]
                }),
                &c,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&err, ToolError::Execution(msg) if msg.contains("changed")),
            "got: {err:?}"
        );
    }
}
