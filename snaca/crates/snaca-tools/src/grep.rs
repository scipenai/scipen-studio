//! `Grep` — search file contents for a regex.
//!
//! Three output modes:
//! - `files_with_matches` (default): one matching path per line.
//! - `content`: each matching line as `<path>:<line_num>:<text>`.
//! - `count`:   `<path>:<count>` per file with at least one match.
//!
//! Optional `glob` filter restricts which files are searched (e.g. `*.rs`).
//! Files larger than `MAX_FILE_BYTES` are skipped to keep latency bounded.
//!
//! ## Pagination
//!
//! `head_limit` caps the number of items in the rendered output;
//! `offset` skips that many items before rendering. The unit depends
//! on `output_mode` — lines in `content`, files in the others. The
//! defaults match Claude Code's BashTool / RipgrepBackend behaviour:
//! 250 for `content`, 100 for the file-level modes. When the renderer
//! truncates, a trailing `<truncated: showed N of M; use offset=N>`
//! line tells the model how to paginate. Without it the model has to
//! guess that there's more (and often retries with a broader pattern
//! instead of paginating).

use async_trait::async_trait;
use globset::{GlobBuilder, GlobMatcher};
use regex::RegexBuilder;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use snaca_workspace::resolve_within;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Hard ceiling on the number of files scanned per call — bounds the
/// in-memory hit list regardless of pagination. Pagination operates
/// on whatever fits under this cap.
const MAX_FILE_HITS: usize = 1000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_DEPTH: usize = 32;

/// Default `head_limit` when `output_mode = content`. 250 matches
/// Claude Code's Grep default — small enough that the model rarely
/// blows its context on a single broad search, large enough that a
/// well-scoped search returns everything in one call.
const DEFAULT_CONTENT_LIMIT: usize = 250;
/// Default `head_limit` for the file-counting modes. Smaller than
/// content because each item already represents a whole file.
const DEFAULT_FILE_LIMIT: usize = 100;

#[derive(Debug, Deserialize)]
struct GrepInput {
    pattern: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    glob: Option<String>,
    #[serde(default)]
    case_insensitive: bool,
    #[serde(default)]
    output_mode: Option<OutputMode>,
    /// Maximum items in the rendered output. Counts lines when
    /// `output_mode = content`, files for the other modes. Default
    /// 250 for content, 100 for files. Set explicitly to `0` to mean
    /// "no limit" (still bounded by the in-memory file ceiling).
    #[serde(default)]
    head_limit: Option<usize>,
    /// Skip this many items before rendering. Default 0. Combine with
    /// `head_limit` to page through large result sets. The unit is
    /// the same as `head_limit`.
    #[serde(default)]
    offset: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum OutputMode {
    #[default]
    FilesWithMatches,
    Content,
    Count,
}

pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &str {
        "Grep"
    }

    fn description(&self) -> &str {
        "Search file contents in the project workspace for a regex (Rust regex \
         syntax). Returns matching files by default; set `output_mode` to \
         `content` for per-line matches or `count` for per-file counts. \
         Optional `glob` restricts which files are searched."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regex pattern (Rust regex syntax)."
                },
                "path": {
                    "type": "string",
                    "description": "Optional sub-path. Defaults to workspace root."
                },
                "glob": {
                    "type": "string",
                    "description": "Optional glob filter, e.g. '*.rs'."
                },
                "case_insensitive": {
                    "type": "boolean",
                    "description": "Match case-insensitively. Default false."
                },
                "output_mode": {
                    "type": "string",
                    "enum": ["files_with_matches", "content", "count"],
                    "description": "Output format. Default 'files_with_matches'."
                },
                "head_limit": {
                    "type": "integer",
                    "description": "Max items to return: lines for content mode, files otherwise. Default 250 (content) / 100 (files). Set 0 for no limit.",
                    "minimum": 0
                },
                "offset": {
                    "type": "integer",
                    "description": "Items to skip before returning. Default 0. Combine with head_limit to paginate.",
                    "minimum": 0
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
        let input: GrepInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;

        let regex = RegexBuilder::new(&input.pattern)
            .case_insensitive(input.case_insensitive)
            .build()
            .map_err(|e| ToolError::InvalidInput(format!("invalid regex: {e}")))?;

        let glob_matcher: Option<GlobMatcher> = match input.glob.as_deref() {
            Some(g) => Some(
                GlobBuilder::new(g)
                    .literal_separator(true)
                    .build()
                    .map_err(|e| ToolError::InvalidInput(format!("invalid glob: {e}")))?
                    .compile_matcher(),
            ),
            None => None,
        };

        let search_root = match input.path.as_deref() {
            Some(sub) => resolve_within(ctx.workspace_root(), Path::new(sub))
                .map_err(|e| ToolError::PathOutsideWorkspace(e.to_string()))?,
            None => ctx.workspace_root().to_path_buf(),
        };

        let output_mode = input.output_mode.unwrap_or_default();
        let workspace_root = ctx.workspace_root();

        // Collect synchronously — walkdir is sync; for M1 this is fine.
        // Move to spawn_blocking if it becomes a bottleneck.
        let mut hits: Vec<FileHit> = Vec::new();
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
            if let Some(m) = &glob_matcher {
                if !m.is_match(rel_to_root) {
                    continue;
                }
            }
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if metadata.len() > MAX_FILE_BYTES {
                continue;
            }
            let content = match std::fs::read_to_string(entry.path()) {
                Ok(s) => s,
                Err(_) => continue, // binary or unreadable, skip silently
            };
            let mut matches: Vec<(usize, String)> = Vec::new();
            for (i, line) in content.lines().enumerate() {
                if regex.is_match(line) {
                    matches.push((i + 1, line.to_string()));
                }
            }
            if matches.is_empty() {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(workspace_root)
                .unwrap_or(entry.path())
                .to_path_buf();
            hits.push(FileHit { path: rel, matches });
            if hits.len() >= MAX_FILE_HITS {
                break;
            }
        }

        hits.sort_by(|a, b| a.path.cmp(&b.path));

        // Resolve pagination bounds. `head_limit = Some(0)` means "no
        // limit" (still capped by `MAX_FILE_HITS` upstream). `None`
        // picks the mode-appropriate default.
        let default_limit = match output_mode {
            OutputMode::Content => DEFAULT_CONTENT_LIMIT,
            OutputMode::FilesWithMatches | OutputMode::Count => DEFAULT_FILE_LIMIT,
        };
        let head_limit = match input.head_limit {
            Some(0) => usize::MAX,
            Some(n) => n,
            None => default_limit,
        };
        let offset = input.offset.unwrap_or(0);

        let (rendered, total, shown) = match output_mode {
            OutputMode::FilesWithMatches => {
                let total = hits.len();
                let lines: Vec<String> = hits
                    .iter()
                    .skip(offset)
                    .take(head_limit)
                    .map(|h| h.path.display().to_string())
                    .collect();
                let shown = lines.len();
                (lines.join("\n"), total, shown)
            }
            OutputMode::Count => {
                let total = hits.len();
                let lines: Vec<String> = hits
                    .iter()
                    .skip(offset)
                    .take(head_limit)
                    .map(|h| format!("{}:{}", h.path.display(), h.matches.len()))
                    .collect();
                let shown = lines.len();
                (lines.join("\n"), total, shown)
            }
            OutputMode::Content => {
                // Content mode unit is *lines*, not files. Walk the
                // sorted hits and flatten before slicing so pagination
                // works across file boundaries — the model paging at
                // offset=250 expects line 251, not "the next file after
                // 250 files were already shown".
                let mut total = 0usize;
                for h in &hits {
                    total += h.matches.len();
                }
                let mut lines: Vec<String> = Vec::new();
                let mut skipped = 0usize;
                'outer: for h in &hits {
                    for (n, l) in &h.matches {
                        if skipped < offset {
                            skipped += 1;
                            continue;
                        }
                        if lines.len() >= head_limit {
                            break 'outer;
                        }
                        lines.push(format!("{}:{}:{}", h.path.display(), n, l));
                    }
                }
                let shown = lines.len();
                (lines.join("\n"), total, shown)
            }
        };

        if total == 0 {
            return Ok(ToolOutput::text("<no matches>".to_string()));
        }

        // Surface truncation explicitly: the model only sees what's in
        // the rendered string, so silent truncation leaves it guessing.
        // Two flavours: "exceeded head_limit" (more after this page) and
        // "hit MAX_FILE_HITS" (crawl ceiling — broader scope wouldn't help).
        let mut out = rendered;
        let consumed = offset + shown;
        if consumed < total {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&format!(
                "<truncated: showed {shown} of {total}; use offset={consumed} to continue>"
            ));
        }
        if hits.len() >= MAX_FILE_HITS {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&format!(
                "<crawl hit {MAX_FILE_HITS}-file ceiling; narrow the path or glob to see more files>"
            ));
        }
        Ok(ToolOutput::text(out))
    }
}

struct FileHit {
    path: PathBuf,
    matches: Vec<(usize, String)>,
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

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(
            dir.path().join("src/lib.rs"),
            "pub fn greet() {\n    // TODO: unimplemented\n}\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("src/main.rs"),
            "fn main() {\n    println!(\"hi\");\n}\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("README.md"), "TODO: docs\n").unwrap();
        dir
    }

    #[tokio::test]
    async fn files_with_matches_default() {
        let dir = fixture();
        let out = GrepTool
            .execute(json!({"pattern": "TODO"}), &ctx(dir.path()))
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("README.md"));
        assert!(out.contains("lib.rs"));
        assert!(!out.contains("main.rs"));
    }

    #[tokio::test]
    async fn content_mode_emits_line_numbers() {
        let dir = fixture();
        let out = GrepTool
            .execute(
                json!({"pattern": "TODO", "output_mode": "content"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("README.md:1:TODO: docs"));
        assert!(out.contains("lib.rs:2:    // TODO: unimplemented"));
    }

    #[tokio::test]
    async fn count_mode_emits_per_file_count() {
        let dir = fixture();
        let out = GrepTool
            .execute(
                json!({"pattern": "fn ", "output_mode": "count", "glob": "**/*.rs"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap()
            .render_text();
        // src/main.rs has `fn main` (1 hit); src/lib.rs has `pub fn greet` (1 hit).
        assert!(out.contains(":1"));
        assert!(!out.contains("README.md"));
    }

    #[tokio::test]
    async fn case_insensitive_works() {
        let dir = fixture();
        let out = GrepTool
            .execute(
                json!({"pattern": "todo", "case_insensitive": true}),
                &ctx(dir.path()),
            )
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("README.md"));
    }

    #[tokio::test]
    async fn no_matches_marker() {
        let dir = fixture();
        let out = GrepTool
            .execute(json!({"pattern": "xyzzy_no_such_term"}), &ctx(dir.path()))
            .await
            .unwrap()
            .render_text();
        assert_eq!(out, "<no matches>");
    }

    /// Pagination in `content` mode walks line-by-line across files.
    /// Asking for offset=1 + limit=1 against a 3-line corpus should
    /// hand back the *second* matching line plus a truncation footer
    /// pointing at the third.
    #[tokio::test]
    async fn content_mode_paginates_across_files() {
        let dir = tempfile::tempdir().unwrap();
        // Three matching lines across two files; sort order puts a.txt before b.txt.
        std::fs::write(dir.path().join("a.txt"), "needle one\nfiller\nneedle two\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "needle three\n").unwrap();

        // offset=1, head_limit=1 -> only the middle match.
        let out = GrepTool
            .execute(
                json!({
                    "pattern": "needle",
                    "output_mode": "content",
                    "offset": 1,
                    "head_limit": 1,
                }),
                &ctx(dir.path()),
            )
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("a.txt:3:needle two"), "got: {out}");
        assert!(
            !out.contains("needle one") && !out.contains("needle three"),
            "should not include unpaginated matches; got: {out}"
        );
        // Truncation footer with next offset.
        assert!(
            out.contains("<truncated: showed 1 of 3; use offset=2"),
            "should advertise next offset; got: {out}"
        );
    }

    /// `files_with_matches` paginates by file, not by match line.
    #[tokio::test]
    async fn files_mode_head_limit_caps_file_count() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            std::fs::write(dir.path().join(format!("f{i}.txt")), "needle\n").unwrap();
        }

        let out = GrepTool
            .execute(
                json!({"pattern": "needle", "head_limit": 2}),
                &ctx(dir.path()),
            )
            .await
            .unwrap()
            .render_text();
        let lines: Vec<&str> = out.lines().filter(|l| !l.starts_with('<')).collect();
        assert_eq!(lines.len(), 2, "head_limit=2 should yield 2 files; got: {out}");
        assert!(out.contains("<truncated: showed 2 of 5"), "got: {out}");
    }

    /// `head_limit=0` is the escape hatch — return everything (still
    /// bounded by the crawl ceiling).
    #[tokio::test]
    async fn head_limit_zero_means_no_limit() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..3 {
            std::fs::write(dir.path().join(format!("f{i}.txt")), "needle\n").unwrap();
        }
        let out = GrepTool
            .execute(
                json!({"pattern": "needle", "head_limit": 0}),
                &ctx(dir.path()),
            )
            .await
            .unwrap()
            .render_text();
        assert!(!out.contains("<truncated"), "should not truncate; got: {out}");
        assert!(out.matches("f").count() >= 3, "all 3 files; got: {out}");
    }

    #[tokio::test]
    async fn invalid_regex_rejected() {
        let dir = fixture();
        let err = GrepTool
            .execute(json!({"pattern": "[unterminated"}), &ctx(dir.path()))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }
}
