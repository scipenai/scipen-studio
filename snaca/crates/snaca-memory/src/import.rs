//! Bulk import pipeline — `(bytes, filename) → MemoryEntry[]`.
//!
//! ## Scope of this chunk
//!
//! Plain text, markdown, source code, and PDF. DOCX / XLSX / PPTX are
//! recognised by extension for diagnostic routing but *not* parsed
//! here — they require an out-of-process extractor and surface a
//! `MemoryError::ExternalExtractorRequired` so the caller (or the
//! bundle-import skip path) can route them to the `office-extract`
//! skill instead.
//!
//! ## Flow
//!
//! 1. Sniff the format from the filename extension (cheap, deterministic).
//!    Anything we don't recognise gets treated as plain text.
//! 2. Decode bytes as UTF-8. Lossy decode for malformed input — better
//!    a partial import than a hard failure that strands an entire file.
//! 3. Run the heading-aware chunker (markdown) or recursive chunker
//!    (everything else) using the configured chunk window.
//! 4. Write each chunk through `IndexedMemoryStore::write`, which
//!    embeds + persists in one shot. Names are derived from the source
//!    filename plus a numeric suffix so re-imports overwrite cleanly.

use crate::chunk::{chunk_markdown, chunk_recursive, ChunkConfig};
use crate::classify::SharedClassifier;
use crate::indexed::IndexedMemoryStore;
use crate::scope::MemoryScope;
use crate::store::{sanitize_name, MemoryError, MemoryResult};
use std::path::Path;

/// File format the importer knows how to extract. Detection is
/// extension-based — no magic-byte sniff yet, intentionally simple.
///
/// `Pdf` is feature-gated behind `pdf`: a `Pdf` source on a build
/// without the feature returns a `MemoryError::Io` explaining the
/// missing feature so operators know they wired the wrong build.
///
/// `Docx` / `Xlsx` / `Pptx` are *never* extracted by snaca-memory.
/// They're recognised here for diagnostics; `import_one` returns
/// `MemoryError::ExternalExtractorRequired` so the caller can either
/// skip the file (bundle import) or hand it to the `office-extract`
/// skill before re-feeding the extracted text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    PlainText,
    Markdown,
    Code,
    Pdf,
    Docx,
    Xlsx,
    Pptx,
}

impl SourceKind {
    /// Map a file's extension to a known kind. Returns `PlainText`
    /// for unknown extensions — the most permissive default for
    /// a "mine whatever the user uploaded" workflow.
    pub fn from_filename(name: &str) -> Self {
        let lower = name.to_ascii_lowercase();
        let ext = std::path::Path::new(&lower)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        match ext {
            "md" | "markdown" | "mdown" => SourceKind::Markdown,
            "pdf" => SourceKind::Pdf,
            "docx" | "docm" => SourceKind::Docx,
            "xlsx" | "xlsm" => SourceKind::Xlsx,
            "pptx" | "pptm" => SourceKind::Pptx,
            "rs" | "py" | "js" | "ts" | "tsx" | "jsx" | "go" | "java" | "rb" | "c" | "h"
            | "cpp" | "hpp" | "cc" | "cs" | "swift" | "kt" | "scala" | "sh" | "bash"
            | "zsh" | "fish" | "lua" | "php" | "pl" | "r" | "sql" | "yaml" | "yml"
            | "toml" | "json" | "xml" | "html" | "css" | "scss" => SourceKind::Code,
            "txt" | "" => SourceKind::PlainText,
            // Unknown extension → best-effort plain text.
            _ => SourceKind::PlainText,
        }
    }
}

/// Inputs to one import call.
#[derive(Debug, Clone)]
pub struct ImportSource {
    /// The file's bytes. Decoded as UTF-8 with replacement for invalid
    /// sequences so encoding mishaps don't strand the whole file.
    pub bytes: Vec<u8>,
    /// Filename — used for naming entries and detecting the kind.
    /// Strip directory components before passing in; the importer
    /// uses only the basename.
    pub filename: String,
    /// Override automatic kind detection.
    pub kind: Option<SourceKind>,
}

/// Knobs for one import session.
#[derive(Clone)]
pub struct ImportConfig {
    /// Fallback scope when no classifier is attached. The plan calls
    /// out `reference` as the natural home for imported documents.
    pub default_scope: MemoryScope,
    pub chunk: ChunkConfig,
    /// Optional per-chunk classifier. None → every chunk uses
    /// `default_scope`. Some → classifier output is used; if the
    /// classifier returns `User` / `Feedback` (which it shouldn't,
    /// but in case of a misbehaving impl), the chunk is downgraded
    /// to `default_scope` and a warning is logged.
    pub classifier: Option<SharedClassifier>,
}

impl Default for ImportConfig {
    fn default() -> Self {
        Self {
            default_scope: MemoryScope::Reference,
            chunk: ChunkConfig::default(),
            classifier: None,
        }
    }
}

impl ImportConfig {
    pub fn with_classifier(mut self, c: SharedClassifier) -> Self {
        self.classifier = Some(c);
        self
    }
}

impl std::fmt::Debug for ImportConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportConfig")
            .field("default_scope", &self.default_scope)
            .field("chunk", &self.chunk)
            .field("classifier", &self.classifier.as_ref().map(|_| "<dyn>"))
            .finish()
    }
}

/// Result summary of one source's import.
#[derive(Debug, Clone)]
pub struct ImportReport {
    pub filename: String,
    pub kind: SourceKind,
    /// Each entry stored — `<base>-NN` slug + scope. Useful so the
    /// caller can confirm where the data landed.
    pub entries: Vec<(MemoryScope, String)>,
}

/// PDF dispatch. Compiled to a real extractor only with `--features pdf`;
/// otherwise returns a typed error so operators can tell their build
/// is missing the feature instead of silently producing empty entries.
fn extract_pdf(bytes: &[u8], filename: &str) -> MemoryResult<String> {
    #[cfg(feature = "pdf")]
    {
        crate::pdf_extract::extract(bytes).map_err(|e| {
            MemoryError::Io(std::io::Error::other(format!(
                "pdf extraction failed for {filename}: {e}"
            )))
        })
    }
    #[cfg(not(feature = "pdf"))]
    {
        let _ = bytes;
        Err(MemoryError::Io(std::io::Error::other(format!(
            "PDF import requested for {filename} but the `pdf` feature is not enabled"
        ))))
    }
}

/// Decode raw bytes as UTF-8. Lossy fallback ensures we don't blow up
/// on a single malformed file — better to import 99% of a doc than to
/// reject it whole.
fn decode_utf8(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// Strip the directory and extension off a filename, then sanitise
/// against the entry-name rules. Returns `import` as a fallback when
/// nothing legible remains (e.g. an all-symbols filename).
fn base_slug(filename: &str) -> String {
    let basename = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);
    // Replace illegal chars with `-` before sanitising. Without this,
    // `My File.md` would error out at sanitise-time (spaces) instead of
    // becoming `my-file`.
    let pre: String = basename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    // Collapse runs of `-` and trim them off the ends.
    let mut out = String::with_capacity(pre.len());
    let mut last_dash = true;
    for c in pre.chars() {
        if c == '-' {
            if !last_dash {
                out.push(c);
                last_dash = true;
            }
        } else {
            out.push(c);
            last_dash = false;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() || sanitize_name(&trimmed).is_err() {
        return "import".into();
    }
    // Cap at 56 chars so there's room for a `-NN` suffix under the
    // 64-char ceiling.
    if trimmed.len() > 56 {
        trimmed[..56].trim_end_matches('-').to_string()
    } else {
        trimmed
    }
}

/// Import one source. Returns the per-entry summary; failures are
/// surfaced as `Err` (we'd rather the caller know one of N files
/// didn't land than silently log).
pub async fn import_one(
    indexer: &IndexedMemoryStore,
    source: ImportSource,
    cfg: &ImportConfig,
) -> MemoryResult<ImportReport> {
    let kind = source
        .kind
        .unwrap_or_else(|| SourceKind::from_filename(&source.filename));
    // Format-specific extraction. Text/code/markdown work straight off
    // the bytes; PDF and DOCX go through their own extractors gated
    // behind the `pdf` / `docx` features.
    let text = match kind {
        SourceKind::PlainText | SourceKind::Markdown | SourceKind::Code => {
            decode_utf8(&source.bytes)
        }
        SourceKind::Pdf => extract_pdf(&source.bytes, &source.filename)?,
        SourceKind::Docx => {
            return Err(MemoryError::ExternalExtractorRequired {
                kind: "docx",
                filename: source.filename,
            });
        }
        SourceKind::Xlsx => {
            return Err(MemoryError::ExternalExtractorRequired {
                kind: "xlsx",
                filename: source.filename,
            });
        }
        SourceKind::Pptx => {
            return Err(MemoryError::ExternalExtractorRequired {
                kind: "pptx",
                filename: source.filename,
            });
        }
    };
    if text.trim().is_empty() {
        return Ok(ImportReport {
            filename: source.filename,
            kind,
            entries: Vec::new(),
        });
    }
    let chunks = match kind {
        SourceKind::Markdown => chunk_markdown(&text, &cfg.chunk),
        SourceKind::PlainText | SourceKind::Code | SourceKind::Pdf => {
            chunk_recursive(&text, &cfg.chunk)
        }
        // Office formats short-circuit above with
        // ExternalExtractorRequired; this arm is unreachable but kept
        // exhaustive so future additions can't silently fall through.
        SourceKind::Docx | SourceKind::Xlsx | SourceKind::Pptx => {
            unreachable!("Office formats are rejected before chunking")
        }
    };
    if chunks.is_empty() {
        return Ok(ImportReport {
            filename: source.filename,
            kind,
            entries: Vec::new(),
        });
    }

    let base = base_slug(&source.filename);
    let mut entries = Vec::with_capacity(chunks.len());
    for (i, chunk) in chunks.iter().enumerate() {
        // Single-chunk imports get the bare base name; multi-chunk
        // get a `-NN` suffix so they sort and re-import deterministically.
        let name = if chunks.len() == 1 {
            base.clone()
        } else {
            format!("{base}-{i:02}")
        };
        // sanitize_name is also called inside `IndexedMemoryStore::write`,
        // but doing it here surfaces invalid names with a clearer error.
        sanitize_name(&name).map_err(|e| match e {
            MemoryError::InvalidName { name, reason } => MemoryError::InvalidName {
                name: format!("derived from {:?}: {name}", source.filename),
                reason,
            },
            other => other,
        })?;
        // Per-chunk scope: classifier output if attached, otherwise
        // `default_scope`. Bulk-import classifiers can only return
        // `Project` / `Reference`; anything else (including `User` or
        // `Feedback`) is downgraded to the default with a warning.
        let scope = match cfg.classifier.as_ref() {
            None => cfg.default_scope,
            Some(c) => {
                let proposed = c.classify(chunk).await;
                if matches!(proposed, MemoryScope::Project | MemoryScope::Reference) {
                    proposed
                } else {
                    tracing::warn!(
                        proposed = %proposed,
                        default = %cfg.default_scope,
                        "import classifier returned non-document scope; using default"
                    );
                    cfg.default_scope
                }
            }
        };
        let entry = indexer.write(scope, &name, chunk).await?;
        entries.push((entry.scope, entry.name));
    }
    Ok(ImportReport {
        filename: source.filename,
        kind,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::HashEmbedder;
    use crate::indexed::IndexedMemoryStore;
    use crate::store::MemoryStore;
    use snaca_core::{ProjectId, TenantId};
    use snaca_state::Database;
    use std::sync::Arc;

    async fn fixture() -> (tempfile::TempDir, IndexedMemoryStore) {
        let tmp = tempfile::tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().join("memory"));
        let db = Database::open_in_memory().await.unwrap();
        let embedder = Arc::new(HashEmbedder::new(64));
        let idx = IndexedMemoryStore::new(
            store,
            db,
            embedder,
            TenantId::new("t"),
            ProjectId::from_raw("p"),
        );
        (tmp, idx)
    }

    fn src(name: &str, body: &str) -> ImportSource {
        ImportSource {
            bytes: body.as_bytes().to_vec(),
            filename: name.into(),
            kind: None,
        }
    }

    #[test]
    fn from_filename_recognises_known_extensions() {
        assert_eq!(SourceKind::from_filename("README.md"), SourceKind::Markdown);
        assert_eq!(SourceKind::from_filename("notes.markdown"), SourceKind::Markdown);
        assert_eq!(SourceKind::from_filename("main.rs"), SourceKind::Code);
        assert_eq!(SourceKind::from_filename("config.yaml"), SourceKind::Code);
        assert_eq!(SourceKind::from_filename("plain.txt"), SourceKind::PlainText);
        assert_eq!(SourceKind::from_filename("Makefile"), SourceKind::PlainText);
        assert_eq!(SourceKind::from_filename("weird.bin"), SourceKind::PlainText);
        // Office formats: detected for routing, never extracted in-core.
        assert_eq!(SourceKind::from_filename("spec.docx"), SourceKind::Docx);
        assert_eq!(SourceKind::from_filename("budget.xlsx"), SourceKind::Xlsx);
        assert_eq!(SourceKind::from_filename("deck.pptx"), SourceKind::Pptx);
        assert_eq!(SourceKind::from_filename("macros.xlsm"), SourceKind::Xlsx);
        assert_eq!(SourceKind::from_filename("macros.pptm"), SourceKind::Pptx);
    }

    #[test]
    fn base_slug_normalises_filenames() {
        assert_eq!(base_slug("My Document.md"), "my-document");
        assert_eq!(base_slug("/abs/path/to/Plan_v2.md"), "plan_v2");
        assert_eq!(base_slug("../weird/!!!.md"), "import");
        assert_eq!(base_slug(""), "import");
    }

    #[test]
    fn base_slug_caps_long_names() {
        let long = format!("{}.md", "a".repeat(200));
        let slug = base_slug(&long);
        assert!(slug.len() <= 56);
    }

    #[tokio::test]
    async fn import_short_text_writes_one_entry() {
        let (_t, idx) = fixture().await;
        let report = import_one(
            &idx,
            src("notes.txt", "user prefers terse responses"),
            &ImportConfig::default(),
        )
        .await
        .unwrap();
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].0, MemoryScope::Reference);
        assert_eq!(report.entries[0].1, "notes");
    }

    #[tokio::test]
    async fn import_markdown_uses_heading_splitter() {
        let (_t, idx) = fixture().await;
        let body = "# Section A\n\nAlpha\n\n# Section B\n\nBeta\n\n# Section C\n\nGamma";
        let report = import_one(
            &idx,
            src("doc.md", body),
            &ImportConfig {
                default_scope: MemoryScope::Reference,
                chunk: ChunkConfig {
                    target_bytes: 30,
                    overlap_bytes: 0,
                },
                classifier: None,
            },
        )
        .await
        .unwrap();
        // Three headings at this target should produce three entries.
        assert!(
            report.entries.len() >= 2,
            "expected multiple entries; got {report:?}"
        );
        // Names follow `<base>-NN`.
        assert!(report.entries.iter().all(|(_, n)| n.starts_with("doc-")));
    }

    #[tokio::test]
    async fn import_writes_through_index_and_search_works() {
        let (_t, idx) = fixture().await;
        import_one(
            &idx,
            src(
                "rust-style.md",
                "# Conventions\n\nThe project uses kebab-case file names.",
            ),
            &ImportConfig::default(),
        )
        .await
        .unwrap();
        let hits = idx.search("kebab case file naming", 5).await.unwrap();
        assert!(
            !hits.is_empty(),
            "imported entry should be retrievable via search"
        );
    }

    #[tokio::test]
    async fn import_empty_file_is_a_noop() {
        let (_t, idx) = fixture().await;
        let report = import_one(
            &idx,
            src("empty.txt", ""),
            &ImportConfig::default(),
        )
        .await
        .unwrap();
        assert!(report.entries.is_empty());
    }

    #[tokio::test]
    async fn import_handles_lossy_utf8() {
        let (_t, idx) = fixture().await;
        // 0xff is invalid UTF-8 in isolation.
        let bytes = vec![b'h', b'i', 0xff, b'!'];
        let report = import_one(
            &idx,
            ImportSource {
                bytes,
                filename: "broken.txt".into(),
                kind: None,
            },
            &ImportConfig::default(),
        )
        .await
        .unwrap();
        assert_eq!(report.entries.len(), 1, "lossy decode should still produce an entry");
    }

    #[tokio::test]
    async fn office_formats_surface_external_extractor_required() {
        // snaca-memory no longer parses docx/xlsx/pptx — they must be
        // routed to the `office-extract` skill out-of-process. We assert
        // the typed error so the bundle-import skip path and any future
        // CLI surface can distinguish "needs extractor" from "broken file".
        let (_t, idx) = fixture().await;
        for (filename, kind_str) in &[
            ("spec.docx", "docx"),
            ("budget.xlsx", "xlsx"),
            ("deck.pptx", "pptx"),
        ] {
            let result = import_one(
                &idx,
                ImportSource {
                    bytes: vec![0x50, 0x4b, 0x03, 0x04],
                    filename: (*filename).into(),
                    kind: None,
                },
                &ImportConfig::default(),
            )
            .await;
            match result {
                Err(MemoryError::ExternalExtractorRequired { kind, filename: f }) => {
                    assert_eq!(kind, *kind_str);
                    assert_eq!(f, *filename);
                }
                other => panic!("expected ExternalExtractorRequired for {filename}, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn classifier_routes_chunks_per_call() {
        use crate::classify::ConstantClassifier;
        let (_t, idx) = fixture().await;
        let cfg = ImportConfig {
            default_scope: MemoryScope::Reference,
            chunk: ChunkConfig::default(),
            classifier: Some(Arc::new(ConstantClassifier::new(MemoryScope::Project))),
        };
        let report = import_one(
            &idx,
            src("notes.md", "# A\n\nfirst section.\n\n# B\n\nsecond section."),
            &cfg,
        )
        .await
        .unwrap();
        // Every entry written under `project` because the constant
        // classifier overrides the default `reference`.
        assert!(!report.entries.is_empty());
        for (scope, _) in &report.entries {
            assert_eq!(*scope, MemoryScope::Project);
        }
    }

    #[tokio::test]
    async fn classifier_returning_user_scope_falls_back_to_default() {
        // Defensive — a malicious / buggy classifier shouldn't be able
        // to plant entries in the conversation-only scopes.
        use crate::classify::ConstantClassifier;
        let (_t, idx) = fixture().await;
        let cfg = ImportConfig {
            default_scope: MemoryScope::Reference,
            chunk: ChunkConfig::default(),
            classifier: Some(Arc::new(ConstantClassifier::new(MemoryScope::User))),
        };
        let report = import_one(
            &idx,
            src("notes.txt", "innocent body"),
            &cfg,
        )
        .await
        .unwrap();
        assert_eq!(report.entries.len(), 1);
        // Downgraded to the default, never landed under `user`.
        assert_eq!(report.entries[0].0, MemoryScope::Reference);
    }

    #[tokio::test]
    async fn explicit_kind_overrides_extension() {
        let (_t, idx) = fixture().await;
        let report = import_one(
            &idx,
            ImportSource {
                bytes: b"# heading\n\nbody".to_vec(),
                filename: "no-extension".into(),
                kind: Some(SourceKind::Markdown),
            },
            &ImportConfig::default(),
        )
        .await
        .unwrap();
        assert_eq!(report.kind, SourceKind::Markdown);
    }
}
