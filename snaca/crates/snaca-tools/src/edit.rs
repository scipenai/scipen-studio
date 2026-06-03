//! `Edit` — replace a unique substring in a file.
//!
//! By default the match must be unique — this catches the common LLM
//! error of "I'll just replace `foo` with `bar`" when `foo` appears in
//! ten places. Pass `replace_all: true` to substitute every occurrence.

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
struct EditInput {
    path: String,
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

pub struct EditTool;

#[async_trait]
impl Tool for EditTool {
    fn name(&self) -> &str {
        "Edit"
    }

    fn description(&self) -> &str {
        "Replace `old_string` with `new_string` in a file. By default \
         requires the match to be unique; pass `replace_all: true` to \
         substitute every occurrence. The file must already exist; use \
         Write to create new files. UTF-8 only — binary files are rejected."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path relative to the project workspace root."
                },
                "old_string": {
                    "type": "string",
                    "description": "Exact text to replace. Must be unique unless replace_all is true."
                },
                "new_string": {
                    "type": "string",
                    "description": "Replacement text. Must differ from old_string."
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "Replace every occurrence instead of requiring uniqueness.",
                    "default": false
                }
            },
            "required": ["path", "old_string", "new_string"]
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
        let input: EditInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;

        if input.old_string.is_empty() {
            return Err(ToolError::InvalidInput(
                "old_string must not be empty".into(),
            ));
        }
        if input.old_string == input.new_string {
            return Err(ToolError::InvalidInput(
                "old_string == new_string would be a no-op".into(),
            ));
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

        // Enforce "Read before Edit" + detect external modifications.
        // The tracker is opt-in: unit tests that drive Edit directly
        // don't attach one and the check is skipped. In production the
        // engine attaches a fresh tracker per turn so every Edit goes
        // through this gate.
        if ctx.read_tracker_active() {
            match ctx.last_read(&resolved) {
                None => {
                    return Err(ToolError::InvalidInput(format!(
                        "{} must be Read before editing — call Read first so the \
                         current contents are in context",
                        input.path
                    )));
                }
                Some(prev) => {
                    if prev.partial {
                        return Err(ToolError::InvalidInput(format!(
                            "{} was Read with offset/limit (only part of the file \
                             is in context). Edit refuses partial reads — the \
                             old_string may match text outside the window, which \
                             would silently corrupt the unread portion. Re-Read \
                             without offset/limit, then retry.",
                            input.path
                        )));
                    }
                    let current_mtime = metadata.modified().ok();
                    if Some(prev.mtime) != current_mtime || prev.size != metadata.len() {
                        return Err(ToolError::Execution(format!(
                            "{} changed on disk since it was last Read \
                             (mtime/size differ) — Read again before editing",
                            input.path
                        )));
                    }
                }
            }
        }

        let bytes = tokio::fs::read(&resolved).await?;
        let original = String::from_utf8(bytes).map_err(|_| {
            ToolError::Execution(format!(
                "{} is not valid UTF-8; refusing to edit",
                input.path
            ))
        })?;

        let count = original.matches(&input.old_string).count();
        if count == 0 {
            return Err(ToolError::NotFound(format!(
                "pattern not found in {}",
                input.path
            )));
        }
        if count > 1 && !input.replace_all {
            return Err(ToolError::InvalidInput(format!(
                "pattern matches {count} times in {}; refine the match or pass replace_all: true",
                input.path
            )));
        }

        let new_content = if input.replace_all {
            original.replace(&input.old_string, &input.new_string)
        } else {
            original.replacen(&input.old_string, &input.new_string, 1)
        };

        tokio::fs::write(&resolved, new_content.as_bytes()).await?;

        // Update the tracker so a subsequent Edit against the same
        // path in this turn doesn't trip the "changed externally"
        // check on its own write. Best-effort: a failed metadata read
        // here just means the next Edit will be told to re-Read,
        // which is harmless.
        if let Ok(meta) = tokio::fs::metadata(&resolved).await {
            if let Ok(mtime) = meta.modified() {
                ctx.record_read(&resolved, mtime, meta.len());
            }
        }

        let replaced = if input.replace_all { count } else { 1 };
        Ok(ToolOutput::text(format!(
            "replaced {} occurrence{} in {}",
            replaced,
            if replaced == 1 { "" } else { "s" },
            input.path
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, SessionId, TenantId};
    use snaca_tools_api::ReadTracker;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    fn ctx(root: &Path) -> ToolContext {
        ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            root.to_path_buf(),
        )
    }

    /// Context with a Read tracker attached — mirrors production wiring.
    /// Returns both the context and the tracker so tests can pre-populate
    /// it (simulating a Read having happened) or inspect it after.
    fn ctx_tracked(root: &Path) -> (ToolContext, ReadTracker) {
        let tracker: ReadTracker = Arc::new(Mutex::new(HashMap::new()));
        let c = ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            root.to_path_buf(),
        )
        .with_read_tracker(tracker.clone());
        (c, tracker)
    }

    fn write_file(root: &Path, name: &str, content: &str) {
        std::fs::write(root.join(name), content).unwrap();
    }

    #[tokio::test]
    async fn replaces_unique_match() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.rs", "fn main() {}\n");
        let out = EditTool
            .execute(
                json!({"path": "a.rs", "old_string": "main", "new_string": "entry"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("replaced 1 occurrence"));
        let on_disk = std::fs::read_to_string(dir.path().join("a.rs")).unwrap();
        assert_eq!(on_disk, "fn entry() {}\n");
    }

    #[tokio::test]
    async fn rejects_ambiguous_match_without_replace_all() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.txt", "foo foo foo");
        let err = EditTool
            .execute(
                json!({"path": "a.txt", "old_string": "foo", "new_string": "bar"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "foo foo foo");
    }

    #[tokio::test]
    async fn replace_all_substitutes_every_match() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.txt", "foo foo foo");
        let out = EditTool
            .execute(
                json!({
                    "path": "a.txt",
                    "old_string": "foo",
                    "new_string": "bar",
                    "replace_all": true
                }),
                &ctx(dir.path()),
            )
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("3 occurrences"));
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "bar bar bar");
    }

    #[tokio::test]
    async fn missing_pattern_yields_not_found() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.txt", "hello");
        let err = EditTool
            .execute(
                json!({"path": "a.txt", "old_string": "world", "new_string": "x"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::NotFound(_)));
    }

    #[tokio::test]
    async fn missing_file_yields_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let err = EditTool
            .execute(
                json!({"path": "nope.txt", "old_string": "a", "new_string": "b"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::NotFound(_)));
    }

    #[tokio::test]
    async fn empty_old_string_rejected() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.txt", "x");
        let err = EditTool
            .execute(
                json!({"path": "a.txt", "old_string": "", "new_string": "y"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn no_op_replacement_rejected() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.txt", "abc");
        let err = EditTool
            .execute(
                json!({"path": "a.txt", "old_string": "abc", "new_string": "abc"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn binary_file_rejected() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("bin.dat"), [0xff, 0xfe, 0xfd]).unwrap();
        let err = EditTool
            .execute(
                json!({"path": "bin.dat", "old_string": "x", "new_string": "y"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::Execution(_)));
    }

    #[tokio::test]
    async fn rejects_path_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let err = EditTool
            .execute(
                json!({"path": "../etc/passwd", "old_string": "a", "new_string": "b"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::PathOutsideWorkspace(_)));
    }

    #[tokio::test]
    async fn tracker_rejects_edit_without_prior_read() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.rs", "fn main() {}\n");
        let (c, _t) = ctx_tracked(dir.path());
        let err = EditTool
            .execute(
                json!({"path": "a.rs", "old_string": "main", "new_string": "entry"}),
                &c,
            )
            .await
            .unwrap_err();
        // Untracked path: must Read first.
        assert!(
            matches!(&err, ToolError::InvalidInput(msg) if msg.contains("Read")),
            "got: {err:?}"
        );
        // File on disk unchanged.
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.rs")).unwrap(),
            "fn main() {}\n"
        );
    }

    #[tokio::test]
    async fn tracker_allows_edit_after_read() {
        use snaca_workspace::resolve_within;
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.rs", "fn main() {}\n");
        let (c, _t) = ctx_tracked(dir.path());

        // Simulate a Read first via the ReadTool path.
        crate::read::ReadTool
            .execute(json!({"path": "a.rs"}), &c)
            .await
            .unwrap();

        // Sanity: tracker now knows about the resolved path.
        let resolved = resolve_within(dir.path(), Path::new("a.rs")).unwrap();
        assert!(c.last_read(&resolved).is_some());

        EditTool
            .execute(
                json!({"path": "a.rs", "old_string": "main", "new_string": "entry"}),
                &c,
            )
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.rs")).unwrap(),
            "fn entry() {}\n"
        );
    }

    #[tokio::test]
    async fn tracker_rejects_edit_after_external_modification() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.rs", "fn main() {}\n");
        let (c, _t) = ctx_tracked(dir.path());

        crate::read::ReadTool
            .execute(json!({"path": "a.rs"}), &c)
            .await
            .unwrap();

        // External rewrite — different size + different mtime.
        // Sleep a hair so the mtime ticks on filesystems with second
        // resolution; modern ext4 / btrfs honour nanoseconds but CI
        // tmpfs varies.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        std::fs::write(dir.path().join("a.rs"), "fn other() {}\n").unwrap();

        let err = EditTool
            .execute(
                json!({"path": "a.rs", "old_string": "other", "new_string": "edited"}),
                &c,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&err, ToolError::Execution(msg) if msg.contains("changed")),
            "got: {err:?}"
        );
        // External content preserved.
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.rs")).unwrap(),
            "fn other() {}\n"
        );
    }

    #[tokio::test]
    async fn tracker_rejects_edit_after_partial_read() {
        // Read with `limit` strictly smaller than the file's line count
        // → tracker entry flagged partial → Edit must refuse. The
        // model could otherwise edit text it never saw, silently
        // corrupting the unread tail.
        let dir = tempfile::tempdir().unwrap();
        let body: String = (1..=50).map(|i| format!("line {i}\n")).collect();
        std::fs::write(dir.path().join("a.txt"), &body).unwrap();
        let (c, _t) = ctx_tracked(dir.path());

        crate::read::ReadTool
            .execute(json!({"path": "a.txt", "limit": 5}), &c)
            .await
            .unwrap();

        let err = EditTool
            .execute(
                json!({"path": "a.txt", "old_string": "line 1", "new_string": "LINE 1"}),
                &c,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&err, ToolError::InvalidInput(msg) if msg.contains("partial")),
            "got: {err:?}"
        );
        // File unchanged.
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), body);
    }

    #[tokio::test]
    async fn tracker_rejects_edit_after_offset_read() {
        // offset > 1 is also a partial view, even if no limit truncated
        // the tail — the prefix is invisible to the model.
        let dir = tempfile::tempdir().unwrap();
        let body: String = (1..=10).map(|i| format!("line {i}\n")).collect();
        std::fs::write(dir.path().join("a.txt"), &body).unwrap();
        let (c, _t) = ctx_tracked(dir.path());

        crate::read::ReadTool
            .execute(json!({"path": "a.txt", "offset": 5}), &c)
            .await
            .unwrap();

        let err = EditTool
            .execute(
                json!({"path": "a.txt", "old_string": "line 5", "new_string": "LINE 5"}),
                &c,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&err, ToolError::InvalidInput(msg) if msg.contains("partial")),
            "got: {err:?}"
        );
    }

    #[tokio::test]
    async fn tracker_allows_edit_after_full_read_then_repartial_then_full() {
        // Re-Reading without offset/limit must upgrade a previously
        // partial entry back to full-view so the next Edit succeeds.
        let dir = tempfile::tempdir().unwrap();
        let body: String = (1..=20).map(|i| format!("line {i}\n")).collect();
        std::fs::write(dir.path().join("a.txt"), &body).unwrap();
        let (c, _t) = ctx_tracked(dir.path());

        // Partial first.
        crate::read::ReadTool
            .execute(json!({"path": "a.txt", "limit": 3}), &c)
            .await
            .unwrap();
        // Then full — overrides the partial flag.
        crate::read::ReadTool
            .execute(json!({"path": "a.txt"}), &c)
            .await
            .unwrap();

        EditTool
            .execute(
                json!({"path": "a.txt", "old_string": "line 1\n", "new_string": "LINE 1\n"}),
                &c,
            )
            .await
            .unwrap();
        let on_disk = std::fs::read_to_string(dir.path().join("a.txt")).unwrap();
        assert!(on_disk.starts_with("LINE 1\n"));
    }

    #[tokio::test]
    async fn tracker_allows_consecutive_edits_in_same_turn() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.rs", "fn main() { let x = 0; }\n");
        let (c, _t) = ctx_tracked(dir.path());

        crate::read::ReadTool
            .execute(json!({"path": "a.rs"}), &c)
            .await
            .unwrap();

        // First edit succeeds and refreshes the tracker.
        EditTool
            .execute(
                json!({"path": "a.rs", "old_string": "main", "new_string": "entry"}),
                &c,
            )
            .await
            .unwrap();

        // Second edit immediately after must still pass — we just wrote,
        // we own the latest mtime/size in the tracker.
        EditTool
            .execute(
                json!({"path": "a.rs", "old_string": "let x = 0", "new_string": "let y = 1"}),
                &c,
            )
            .await
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.rs")).unwrap(),
            "fn entry() { let y = 1; }\n"
        );
    }
}
