//! `MemoryRead` / `MemoryWrite` — agent-facing tools for the file-tree
//! memory system. Both resolve the per-project memory dir from the tool
//! context's `workspace_root`: the workspace is `<project>/workspace/`,
//! its sibling `<project>/memory/` is the [`MemoryStore`] root.
//!
//! ## Why two tools, not one
//!
//! The model usually wants to *list* what memory exists before *reading*
//! a specific entry. We collapse list+read into a single `MemoryRead`
//! tool with two arms:
//! - omit `name` → return the index (same content as `MEMORY.md`)
//! - provide `name` → return that entry's body
//!
//! This keeps the schema compact (one tool, one input shape) and means
//! a turn never needs more than two memory calls (one to list, one to
//! read the selected entry).
//!
//! ## Approval
//!
//! Both tools are project-internal scaffolding — no approval. Memory
//! lives entirely under the project's `data_root` so the path-traversal
//! guard inside `MemoryStore::sanitize_name` is what blocks abuse, not
//! the approval gate.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_memory::{MemoryError, MemoryScope, MemoryStore};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use std::path::Path;
use std::str::FromStr;

/// Convention: tools derive the memory dir as a sibling of the workspace
/// root. The engine builds `ToolContext` from `WorkspaceLayout`, which
/// always sets `workspace_root = <project>/workspace/`.
fn memory_store_for(ctx: &ToolContext) -> MemoryStore {
    let memory_dir = ctx
        .workspace_root()
        .parent()
        .map(|p| p.join("memory"))
        .unwrap_or_else(|| Path::new("memory").to_path_buf());
    MemoryStore::new(memory_dir)
}

fn parse_scope(raw: &str) -> Result<MemoryScope, ToolError> {
    MemoryScope::from_str(raw).map_err(ToolError::InvalidInput)
}

fn map_memory_err(e: MemoryError) -> ToolError {
    match e {
        MemoryError::InvalidName { .. } => ToolError::InvalidInput(e.to_string()),
        MemoryError::NotFound { .. } => ToolError::NotFound(e.to_string()),
        MemoryError::Io(io) => ToolError::Io(io),
        // The memory tool surface doesn't perform Office extraction —
        // this variant only fires from `import_one`. Surface as Execution
        // so the rare CLI/MCP path that bubbles through here gets a
        // structured error rather than a panic.
        MemoryError::ExternalExtractorRequired { .. } => ToolError::Execution(e.to_string()),
    }
}

// ---- MemoryRead ------------------------------------------------------

#[derive(Debug, Deserialize)]
struct MemoryReadInput {
    /// Omit to read the project's MEMORY.md index.
    #[serde(default)]
    scope: Option<String>,
    /// Omit (with scope) to list names under that scope; provide both
    /// to read a single entry.
    #[serde(default)]
    name: Option<String>,
}

pub struct MemoryReadTool;

#[async_trait]
impl Tool for MemoryReadTool {
    fn name(&self) -> &str {
        "MemoryRead"
    }

    fn description(&self) -> &str {
        "Read project memory. Three modes:\n\
         - omit `scope` and `name` → return the MEMORY.md index of every entry\n\
         - provide only `scope` (one of user/project/reference/feedback) → list entry names under that scope\n\
         - provide both `scope` and `name` → return the entry's full Markdown body"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["user", "project", "reference", "feedback"],
                    "description": "Which scope to read from. Omit to read the index."
                },
                "name": {
                    "type": "string",
                    "description": "Entry name (no .md). Requires `scope`. Omit with `scope` to list names."
                }
            }
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::default()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let parsed: MemoryReadInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        let store = memory_store_for(ctx);

        match (parsed.scope.as_deref(), parsed.name.as_deref()) {
            (None, None) => {
                let idx = store.index_text().await.map_err(map_memory_err)?;
                if idx.trim().is_empty() {
                    Ok(ToolOutput::text(
                        "(memory index is empty — no entries recorded yet)",
                    ))
                } else {
                    Ok(ToolOutput::text(idx))
                }
            }
            (Some(scope), None) => {
                let scope = parse_scope(scope)?;
                let names = store.list(scope).await.map_err(map_memory_err)?;
                if names.is_empty() {
                    Ok(ToolOutput::text(format!(
                        "(no entries under `{scope}`)"
                    )))
                } else {
                    let mut out = format!("{} entries under `{scope}`:\n", names.len());
                    for n in names {
                        out.push_str(&format!("  - {n}\n"));
                    }
                    Ok(ToolOutput::text(out))
                }
            }
            (Some(scope), Some(name)) => {
                let scope = parse_scope(scope)?;
                let entry = store.read(scope, name).await.map_err(map_memory_err)?;
                Ok(ToolOutput::text(entry.content))
            }
            (None, Some(_)) => Err(ToolError::InvalidInput(
                "`name` requires a `scope`; pick one of user/project/reference/feedback".into(),
            )),
        }
    }
}

// ---- MemoryWrite -----------------------------------------------------

#[derive(Debug, Deserialize)]
struct MemoryWriteInput {
    scope: String,
    name: String,
    content: String,
}

pub struct MemoryWriteTool;

#[async_trait]
impl Tool for MemoryWriteTool {
    fn name(&self) -> &str {
        "MemoryWrite"
    }

    fn description(&self) -> &str {
        "Write or overwrite a memory entry. Choose `scope` thoughtfully:\n\
         - user      → facts about the human(s)\n\
         - project   → facts/decisions/conventions about this project\n\
         - reference → pointers to external systems (URLs, dashboards, repos)\n\
         - feedback  → corrections from the user that should never repeat\n\
         `name` will be lowercased and stripped of `.md` if present. Each call \
         replaces the entry's body verbatim — submit the full new text."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["user", "project", "reference", "feedback"]
                },
                "name": {
                    "type": "string",
                    "description": "Entry name. Lowercased; [a-z0-9_-]+, max 64 chars."
                },
                "content": {
                    "type": "string",
                    "description": "Full Markdown body. Replaces any prior content."
                }
            },
            "required": ["scope", "name", "content"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::writes_filesystem()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        // No approval — writes land in `<project>/memory/` only and
        // can't escape via name (sanitised).
        ApprovalRequirement::Never
    }

    fn is_read_only(&self) -> bool {
        false
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let parsed: MemoryWriteInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        let scope = parse_scope(&parsed.scope)?;
        let store = memory_store_for(ctx);
        let entry = store
            .write(scope, &parsed.name, &parsed.content)
            .await
            .map_err(map_memory_err)?;
        Ok(ToolOutput::text(format!(
            "wrote `{}/{}` ({} bytes)",
            entry.scope.as_str(),
            entry.name,
            entry.content.len()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, SessionId, TenantId};

    /// Build a `ToolContext` whose workspace_root has a sibling
    /// `memory/` dir, matching the real layout the engine creates.
    fn ctx_for(tmp: &Path) -> ToolContext {
        let workspace = tmp.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            workspace,
        )
    }

    #[tokio::test]
    async fn write_then_read_round_trips_through_tools() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path());

        MemoryWriteTool
            .execute(
                json!({"scope": "user", "name": "prefs", "content": "terse output"}),
                &ctx,
            )
            .await
            .unwrap();

        let body = MemoryReadTool
            .execute(
                json!({"scope": "user", "name": "prefs"}),
                &ctx,
            )
            .await
            .unwrap()
            .render_text();
        assert_eq!(body, "terse output");
    }

    #[tokio::test]
    async fn read_with_no_args_returns_index() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path());
        MemoryWriteTool
            .execute(
                json!({"scope": "project", "name": "convention", "content": "use kebab-case"}),
                &ctx,
            )
            .await
            .unwrap();

        let idx = MemoryReadTool
            .execute(json!({}), &ctx)
            .await
            .unwrap()
            .render_text();
        assert!(idx.contains("# Memory"));
        assert!(idx.contains("project/convention"));
    }

    #[tokio::test]
    async fn read_with_only_scope_lists_entries() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path());
        for n in ["alpha", "beta"] {
            MemoryWriteTool
                .execute(
                    json!({"scope": "reference", "name": n, "content": "x"}),
                    &ctx,
                )
                .await
                .unwrap();
        }
        let listing = MemoryReadTool
            .execute(json!({"scope": "reference"}), &ctx)
            .await
            .unwrap()
            .render_text();
        assert!(listing.contains("alpha"));
        assert!(listing.contains("beta"));
        assert!(listing.contains("2 entries"));
    }

    #[tokio::test]
    async fn read_missing_entry_surfaces_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path());
        let err = MemoryReadTool
            .execute(
                json!({"scope": "user", "name": "ghost"}),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::NotFound(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn write_rejects_invalid_name_via_sanitiser() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path());
        let err = MemoryWriteTool
            .execute(
                json!({"scope": "user", "name": "../escape", "content": "x"}),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn read_rejects_unknown_scope() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path());
        let err = MemoryReadTool
            .execute(
                json!({"scope": "secret", "name": "x"}),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn write_persists_under_project_memory_sibling_dir() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path());
        MemoryWriteTool
            .execute(
                json!({"scope": "feedback", "name": "tone", "content": "no emojis"}),
                &ctx,
            )
            .await
            .unwrap();
        let on_disk = dir.path().join("memory/feedback/tone.md");
        assert!(on_disk.exists(), "expected file at {}", on_disk.display());
    }
}
