//! `MemoryStore` — manages the on-disk memory tree for one project.
//!
//! ## Layout
//!
//! ```text
//! <root>/
//!   MEMORY.md                  ← index, ≤ 200 lines / ≤ 25 KB, regenerated on every write
//!   user/<name>.md
//!   project/<name>.md
//!   reference/<name>.md
//!   feedback/<name>.md
//! ```
//!
//! The store is concerned only with the *file tree* — not embeddings,
//! not classification, not retrieval. Those land on top in `index.rs`
//! (vector layer, M3 next chunk) and `pipeline.rs` (batch import).
//!
//! ## Path safety
//!
//! Entry names are validated by [`sanitize_name`] before they ever touch
//! the filesystem: only `[a-z0-9_-]`, max 64 chars, no extension. We
//! re-add `.md` ourselves so a malicious name can't drop a `.sh` or a
//! traversal sequence. Names are *case-folded* at the boundary so
//! `User` and `user` collide instead of producing two ghost entries.
//!
//! ## Index file
//!
//! `MEMORY.md` is regenerated wholesale on every write: scan the four
//! scope dirs, collect entry names, render a Markdown list. We hard-cap
//! the rendered text at 200 lines and 25 KB. When the cap is hit the
//! oldest entries (by mtime) are listed first; everything beyond is
//! summarised as `… N more entries (run `/memory list <scope>` to see all)`.

use crate::scope::MemoryScope;
use std::path::{Path, PathBuf};
use thiserror::Error;
use tokio::fs;

/// Hard ceiling for the rendered MEMORY.md, in lines and bytes. The
/// numbers come from the plan — small enough to keep in every system
/// prompt without burning tokens.
const INDEX_MAX_LINES: usize = 200;
const INDEX_MAX_BYTES: usize = 25 * 1024;

const INDEX_FILE: &str = "MEMORY.md";

#[derive(Debug, Error)]
pub enum MemoryError {
    #[error("invalid memory entry name {name:?}: {reason}")]
    InvalidName { name: String, reason: String },

    #[error("memory entry not found: {scope}/{name}")]
    NotFound { scope: MemoryScope, name: String },

    #[error("io error in memory store: {0}")]
    Io(#[from] std::io::Error),

    /// The source file requires an out-of-process extractor (e.g. an
    /// `office-extract` skill running `python-docx` / `openpyxl` /
    /// `python-pptx`). snaca-memory deliberately does not parse these
    /// formats in Rust; the caller should either skip the source or
    /// hand it to the skill layer before re-importing extracted text.
    #[error("external extractor required for {kind} file {filename:?}")]
    ExternalExtractorRequired { kind: &'static str, filename: String },
}

pub type MemoryResult<T> = Result<T, MemoryError>;

/// Single in-memory representation of one stored entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryEntry {
    pub scope: MemoryScope,
    /// Sanitised name (no extension, lowercase). The on-disk file is
    /// `<root>/<scope>/<name>.md`.
    pub name: String,
    pub content: String,
}

/// Owns one project's memory tree. Cheap to clone — only holds the root path.
#[derive(Debug, Clone)]
pub struct MemoryStore {
    root: PathBuf,
}

impl MemoryStore {
    /// Open a store rooted at `<project_root>/memory/`. The root and its
    /// scope subdirectories are created lazily on first write.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn scope_dir(&self, scope: MemoryScope) -> PathBuf {
        self.root.join(scope.dir_name())
    }

    fn entry_path(&self, scope: MemoryScope, name: &str) -> PathBuf {
        self.scope_dir(scope).join(format!("{name}.md"))
    }

    fn index_path(&self) -> PathBuf {
        self.root.join(INDEX_FILE)
    }

    /// Make sure every scope dir exists. Idempotent. Called by `write`
    /// before opening the entry file; can also be invoked directly when
    /// callers want the tree present even before any writes (e.g.
    /// installer paths).
    pub async fn ensure_layout(&self) -> MemoryResult<()> {
        fs::create_dir_all(&self.root).await?;
        for s in MemoryScope::all() {
            fs::create_dir_all(self.scope_dir(*s)).await?;
        }
        Ok(())
    }

    /// Write or replace an entry. The name is sanitised; collisions
    /// across scopes are allowed (you can have `user/conventions.md`
    /// and `project/conventions.md` simultaneously). Regenerates
    /// MEMORY.md after the write lands.
    pub async fn write(
        &self,
        scope: MemoryScope,
        name: &str,
        content: &str,
    ) -> MemoryResult<MemoryEntry> {
        let name = sanitize_name(name)?;
        self.ensure_layout().await?;
        let path = self.entry_path(scope, &name);
        fs::write(&path, content.as_bytes()).await?;
        self.regenerate_index().await?;
        Ok(MemoryEntry {
            scope,
            name,
            content: content.to_string(),
        })
    }

    /// Read one entry. Returns `NotFound` if the underlying `.md` file
    /// is absent — distinct from an IO error so callers can distinguish.
    pub async fn read(&self, scope: MemoryScope, name: &str) -> MemoryResult<MemoryEntry> {
        let name = sanitize_name(name)?;
        let path = self.entry_path(scope, &name);
        match fs::read_to_string(&path).await {
            Ok(content) => Ok(MemoryEntry {
                scope,
                name,
                content,
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Err(MemoryError::NotFound { scope, name })
            }
            Err(e) => Err(MemoryError::Io(e)),
        }
    }

    /// Delete one entry. No-op when absent so callers can be defensive
    /// without an extra `read` round trip.
    pub async fn delete(&self, scope: MemoryScope, name: &str) -> MemoryResult<()> {
        let name = sanitize_name(name)?;
        let path = self.entry_path(scope, &name);
        match fs::remove_file(&path).await {
            Ok(()) => {
                self.regenerate_index().await?;
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(MemoryError::Io(e)),
        }
    }

    /// Names of every entry under one scope. Sorted alphabetically.
    /// Returns an empty vec if the directory is missing — first write
    /// to that scope creates it.
    pub async fn list(&self, scope: MemoryScope) -> MemoryResult<Vec<String>> {
        let dir = self.scope_dir(scope);
        let mut entries = match fs::read_dir(&dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Vec::new());
            }
            Err(e) => return Err(MemoryError::Io(e)),
        };
        let mut names = Vec::new();
        while let Some(ent) = entries.next_entry().await? {
            if !ent.file_type().await?.is_file() {
                continue;
            }
            let fname = ent.file_name();
            let fname = fname.to_string_lossy();
            if let Some(stem) = fname.strip_suffix(".md") {
                names.push(stem.to_string());
            }
        }
        names.sort();
        Ok(names)
    }

    /// Snapshot every entry in every scope. O(n) reads but n is bounded
    /// by user behaviour — typical projects have well under 100 entries.
    pub async fn list_all(&self) -> MemoryResult<Vec<(MemoryScope, String)>> {
        let mut out = Vec::new();
        for s in MemoryScope::all() {
            for name in self.list(*s).await? {
                out.push((*s, name));
            }
        }
        Ok(out)
    }

    /// Read the rendered MEMORY.md text. Returns an empty string if the
    /// store has no entries — callers can treat that as "no preamble".
    pub async fn index_text(&self) -> MemoryResult<String> {
        let path = self.index_path();
        match fs::read_to_string(&path).await {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(MemoryError::Io(e)),
        }
    }

    /// Re-render MEMORY.md from the current state of all four scope
    /// dirs. Cheap (just dirent listings + a string build). Called
    /// automatically after every `write` / `delete`; exposed publicly so
    /// tests can force a rebuild after manual filesystem mutations.
    pub async fn regenerate_index(&self) -> MemoryResult<()> {
        let mut sections: Vec<(MemoryScope, Vec<String>)> = Vec::new();
        let mut total_entries = 0usize;
        for scope in MemoryScope::all() {
            let names = self.list(*scope).await?;
            total_entries += names.len();
            sections.push((*scope, names));
        }

        if total_entries == 0 {
            // Empty tree — clear the index file too, so the system
            // prompt doesn't see a stale list.
            let path = self.index_path();
            if fs::try_exists(&path).await.unwrap_or(false) {
                fs::remove_file(&path).await?;
            }
            return Ok(());
        }

        let rendered = render_index(&sections);
        fs::write(self.index_path(), rendered).await?;
        Ok(())
    }
}

/// Render the index file with the global cap honoured. Format mirrors
/// Claude Code's MEMORY.md: a top-level header, a section per scope,
/// each entry as a single bullet line. No content excerpts (the entry
/// files themselves are read on demand).
fn render_index(sections: &[(MemoryScope, Vec<String>)]) -> String {
    let mut out = String::new();
    out.push_str("# Memory\n\n");
    out.push_str("Index of stored memory entries. Read individual entries via the `MemoryRead` tool.\n\n");

    let mut line_count = 4;
    let mut budget_exhausted = false;

    for (scope, names) in sections {
        if names.is_empty() {
            continue;
        }
        if budget_exhausted {
            break;
        }
        out.push_str(&format!("## {} ({} entries)\n\n", scope.as_str(), names.len()));
        line_count += 2;
        for name in names {
            if line_count >= INDEX_MAX_LINES || out.len() >= INDEX_MAX_BYTES {
                let remaining = names
                    .iter()
                    .position(|n| n == name)
                    .map(|p| names.len() - p)
                    .unwrap_or(0);
                out.push_str(&format!(
                    "  - … {remaining} more entries (truncated for index cap)\n"
                ));
                budget_exhausted = true;
                break;
            }
            out.push_str(&format!("  - `{}/{}`\n", scope.as_str(), name));
            line_count += 1;
        }
        out.push('\n');
        line_count += 1;
    }

    // Hard byte clamp as a last-resort safety net — line counting can
    // miss long names that bloat individual lines.
    if out.len() > INDEX_MAX_BYTES {
        let mut cut = INDEX_MAX_BYTES;
        // Don't slice mid-utf8; back up to a char boundary.
        while cut > 0 && !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push_str("\n… (index truncated)\n");
    }
    out
}

/// Validate + canonicalise an entry name. Lowercase, max 64 chars,
/// `[a-z0-9_-]+`. We strip `.md` if a caller passed it through habit.
pub fn sanitize_name(input: &str) -> Result<String, MemoryError> {
    let trimmed = input.trim();
    let stripped = trimmed.strip_suffix(".md").unwrap_or(trimmed);
    let lowered = stripped.to_ascii_lowercase();
    if lowered.is_empty() {
        return Err(MemoryError::InvalidName {
            name: input.into(),
            reason: "empty after trim".into(),
        });
    }
    if lowered.len() > 64 {
        return Err(MemoryError::InvalidName {
            name: input.into(),
            reason: format!("max 64 chars; got {}", lowered.len()),
        });
    }
    if !lowered
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    {
        return Err(MemoryError::InvalidName {
            name: input.into(),
            reason: "must match [a-z0-9_-]+".into(),
        });
    }
    Ok(lowered)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, MemoryStore) {
        let tmp = tempfile::tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().join("memory"));
        (tmp, store)
    }

    #[tokio::test]
    async fn write_then_read_round_trips() {
        let (_t, s) = store();
        let entry = s
            .write(MemoryScope::User, "preferences", "likes terse output")
            .await
            .unwrap();
        assert_eq!(entry.name, "preferences");
        let back = s
            .read(MemoryScope::User, "preferences")
            .await
            .unwrap();
        assert_eq!(back.content, "likes terse output");
    }

    #[tokio::test]
    async fn write_lowercases_name() {
        let (_t, s) = store();
        s.write(MemoryScope::Project, "Conventions", "x")
            .await
            .unwrap();
        // Reading with a different case still works — both are folded.
        let back = s
            .read(MemoryScope::Project, "CONVENTIONS")
            .await
            .unwrap();
        assert_eq!(back.content, "x");
    }

    #[tokio::test]
    async fn read_missing_returns_not_found() {
        let (_t, s) = store();
        s.ensure_layout().await.unwrap();
        let err = s
            .read(MemoryScope::User, "absent")
            .await
            .unwrap_err();
        assert!(matches!(err, MemoryError::NotFound { .. }));
    }

    #[tokio::test]
    async fn list_orders_alphabetically() {
        let (_t, s) = store();
        s.write(MemoryScope::User, "zeta", "z").await.unwrap();
        s.write(MemoryScope::User, "alpha", "a").await.unwrap();
        s.write(MemoryScope::User, "mu", "m").await.unwrap();
        let names = s.list(MemoryScope::User).await.unwrap();
        assert_eq!(names, vec!["alpha", "mu", "zeta"]);
    }

    #[tokio::test]
    async fn delete_removes_entry_and_updates_index() {
        let (_t, s) = store();
        s.write(MemoryScope::User, "tmp", "x").await.unwrap();
        let idx = s.index_text().await.unwrap();
        assert!(idx.contains("user/tmp"), "index missing entry: {idx}");
        s.delete(MemoryScope::User, "tmp").await.unwrap();
        let idx = s.index_text().await.unwrap();
        // Tree is now empty — index file should be empty/cleared too.
        assert!(idx.is_empty(), "index should be cleared: {idx}");
    }

    #[tokio::test]
    async fn delete_missing_is_noop() {
        let (_t, s) = store();
        s.delete(MemoryScope::User, "ghost").await.unwrap();
    }

    #[tokio::test]
    async fn list_all_spans_every_scope() {
        let (_t, s) = store();
        s.write(MemoryScope::User, "u", "x").await.unwrap();
        s.write(MemoryScope::Project, "p", "x").await.unwrap();
        s.write(MemoryScope::Feedback, "f", "x").await.unwrap();
        let mut all = s.list_all().await.unwrap();
        all.sort();
        let mut expected = vec![
            (MemoryScope::User, "u".to_string()),
            (MemoryScope::Project, "p".to_string()),
            (MemoryScope::Feedback, "f".to_string()),
        ];
        expected.sort();
        assert_eq!(all, expected);
    }

    #[tokio::test]
    async fn index_text_lists_all_entries() {
        let (_t, s) = store();
        s.write(MemoryScope::User, "u-one", "x").await.unwrap();
        s.write(MemoryScope::Project, "p-one", "x").await.unwrap();
        let idx = s.index_text().await.unwrap();
        assert!(idx.contains("# Memory"), "got: {idx}");
        assert!(idx.contains("user/u-one"));
        assert!(idx.contains("project/p-one"));
        // Empty scopes are omitted from the rendered index.
        assert!(!idx.contains("## reference"));
        assert!(!idx.contains("## feedback"));
    }

    #[tokio::test]
    async fn index_caps_at_max_lines() {
        let (_t, s) = store();
        // Write enough entries to blow past the 200-line cap.
        for i in 0..220 {
            s.write(MemoryScope::Project, &format!("entry-{i:03}"), "x")
                .await
                .unwrap();
        }
        let idx = s.index_text().await.unwrap();
        let line_count = idx.lines().count();
        assert!(
            line_count <= INDEX_MAX_LINES + 5, // +5 for the truncation footer
            "index uncapped: {line_count} lines"
        );
        assert!(
            idx.contains("more entries"),
            "expected truncation notice; got tail: {}",
            idx.lines().last().unwrap_or("")
        );
    }

    #[test]
    fn sanitize_name_rejects_traversal_and_special_chars() {
        assert!(sanitize_name("../escape").is_err());
        assert!(sanitize_name("with space").is_err());
        assert!(sanitize_name("dot.in.middle").is_err());
        assert!(sanitize_name("").is_err());
        assert!(sanitize_name("a".repeat(65).as_str()).is_err());
    }

    #[test]
    fn sanitize_name_strips_md_suffix_and_lowercases() {
        assert_eq!(sanitize_name("Conventions.md").unwrap(), "conventions");
        assert_eq!(sanitize_name("  trim_me  ").unwrap(), "trim_me");
    }
}
