//! `Glob` — find files in the workspace by glob pattern.
//!
//! Returns matching paths sorted by modification time (newest first), so
//! the LLM sees recently-changed files first when searching a fresh repo.
//! Treats `/` as a literal separator (no cross-segment `*` wildcards).

use async_trait::async_trait;
use globset::{GlobBuilder, GlobMatcher};
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use snaca_workspace::resolve_within;
use std::path::Path;
use std::time::SystemTime;
use walkdir::WalkDir;

const MAX_RESULTS: usize = 1000;
const MAX_DEPTH: usize = 32;

#[derive(Debug, Deserialize)]
struct GlobInput {
    pattern: String,
    /// Optional sub-path (relative to workspace) to restrict the search.
    #[serde(default)]
    path: Option<String>,
}

pub struct GlobTool;

#[async_trait]
impl Tool for GlobTool {
    fn name(&self) -> &str {
        "Glob"
    }

    fn description(&self) -> &str {
        "List files matching a glob pattern (e.g. '**/*.rs', 'src/**/*.toml'). \
         Returns paths relative to the project workspace, sorted by modification \
         time (newest first). `/` is a literal separator."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern (e.g. '**/*.rs')."
                },
                "path": {
                    "type": "string",
                    "description": "Optional sub-path to restrict search. Defaults to project workspace root."
                }
            },
            "required": ["pattern"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::read_only_filesystem()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input: GlobInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;

        let matcher: GlobMatcher = GlobBuilder::new(&input.pattern)
            .literal_separator(true)
            .build()
            .map_err(|e| ToolError::InvalidInput(format!("invalid glob: {e}")))?
            .compile_matcher();

        let search_root = match input.path.as_deref() {
            Some(sub) => resolve_within(ctx.workspace_root(), Path::new(sub))
                .map_err(|e| ToolError::PathOutsideWorkspace(e.to_string()))?,
            None => ctx.workspace_root().to_path_buf(),
        };

        let mut hits: Vec<(SystemTime, std::path::PathBuf)> = Vec::new();
        for entry in WalkDir::new(&search_root)
            .max_depth(MAX_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let rel_to_root = match entry.path().strip_prefix(&search_root) {
                Ok(p) => p,
                Err(_) => continue,
            };
            if !matcher.is_match(rel_to_root) {
                continue;
            }
            let mtime = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            hits.push((mtime, entry.path().to_path_buf()));
            if hits.len() >= MAX_RESULTS {
                break;
            }
        }
        // Newest first. `sort_by_key` with `std::cmp::Reverse` lets
        // clippy verify the comparator is total without the manual
        // `b.cmp(&a)` flip.
        hits.sort_by_key(|h| std::cmp::Reverse(h.0));

        let lines: Vec<String> = hits
            .iter()
            .map(|(_, p)| {
                p.strip_prefix(ctx.workspace_root())
                    .unwrap_or(p)
                    .display()
                    .to_string()
            })
            .collect();

        if lines.is_empty() {
            return Ok(ToolOutput::text("<no matches>".to_string()));
        }
        Ok(ToolOutput::text(lines.join("\n")))
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
    async fn matches_recursive_pattern() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/main.rs"), "").unwrap();
        std::fs::write(dir.path().join("README.md"), "").unwrap();
        std::fs::write(dir.path().join("src/lib.rs"), "").unwrap();

        let out = GlobTool
            .execute(json!({"pattern": "**/*.rs"}), &ctx(dir.path()))
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("src/main.rs") || out.contains("src\\main.rs"));
        assert!(out.contains("src/lib.rs") || out.contains("src\\lib.rs"));
        assert!(!out.contains("README.md"));
    }

    #[tokio::test]
    async fn no_matches_returns_marker() {
        let dir = tempfile::tempdir().unwrap();
        let out = GlobTool
            .execute(json!({"pattern": "*.zzz"}), &ctx(dir.path()))
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("<no matches>"));
    }

    #[tokio::test]
    async fn invalid_glob_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let err = GlobTool
            .execute(json!({"pattern": "[unterminated"}), &ctx(dir.path()))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn path_outside_workspace_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let err = GlobTool
            .execute(
                json!({"pattern": "*", "path": "../"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::PathOutsideWorkspace(_)));
    }
}
