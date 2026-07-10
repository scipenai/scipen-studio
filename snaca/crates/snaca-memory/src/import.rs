//! Bulk import pipeline — `(bytes, filename) → MemoryEntry`.
//!
//! ## Scope
//!
//! Plain text, markdown, source code, and PDF are extracted in-process
//! and written as a **single** memory entry. DOCX / XLSX / PPTX are
//! recognised by extension but never parsed here — they require the
//! out-of-process `office-extract` skill and surface
//! `MemoryError::ExternalExtractorRequired` so the caller can route
//! them to that skill before re-feeding the extracted text.
//!
//! ## Flow
//!
//! 1. Sniff the format from the filename extension (cheap, deterministic).
//!    Anything we don't recognise gets treated as plain text.
//! 2. Decode bytes as UTF-8. Lossy decode for malformed input — better
//!    a partial import than a hard failure that strands an entire file.
//! 3. Drop the result whole into one `<scope>/<slug>.md` entry. If the
//!    body exceeds `cfg.max_entry_bytes`, return `EntryTooLarge` and
//!    let the operator decide how to split — we don't auto-chunk
//!    because the new memory model is "one self-contained note per
//!    file, the LLM consolidates by hand".

use crate::scope::MemoryScope;
use crate::store::{sanitize_name, MemoryError, MemoryResult, MemoryStore};
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
            | "cpp" | "hpp" | "cc" | "cs" | "swift" | "kt" | "scala" | "sh" | "bash" | "zsh"
            | "fish" | "lua" | "php" | "pl" | "r" | "sql" | "yaml" | "yml" | "toml" | "json"
            | "xml" | "html" | "css" | "scss" => SourceKind::Code,
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

/// Knobs for one import session. Defaults aim at "drop a markdown /
/// PDF / source file into the `reference` scope as one entry".
#[derive(Debug, Clone)]
pub struct ImportConfig {
    /// Scope every imported file lands in. The plan calls out
    /// `reference` as the natural home for imported documents; `User`
    /// and `Feedback` are explicitly rejected — those scopes are owned
    /// by the conversation itself and bulk imports must never plant
    /// entries there.
    pub default_scope: MemoryScope,
    /// Hard cap on the body of one imported entry, in bytes. Sources
    /// larger than this return `MemoryError::EntryTooLarge`. The
    /// default 64 KiB matches the frozen-snapshot char limit with
    /// headroom to spare; operators importing whole books should
    /// raise this knowingly.
    pub max_entry_bytes: usize,
}

impl Default for ImportConfig {
    fn default() -> Self {
        Self {
            default_scope: MemoryScope::Reference,
            max_entry_bytes: 64 * 1024,
        }
    }
}

/// Result summary of one source's import.
#[derive(Debug, Clone)]
pub struct ImportReport {
    pub filename: String,
    pub kind: SourceKind,
    /// The single entry stored — `(scope, slug)`. Empty when the
    /// source decoded to whitespace-only content.
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
pub(crate) fn base_slug(filename: &str) -> String {
    let basename = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);
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
    if trimmed.len() > 64 {
        trimmed[..64].trim_end_matches('-').to_string()
    } else {
        trimmed
    }
}

/// Import one source. Writes the file's text content as a single
/// memory entry under `cfg.default_scope`, named after the file's
/// basename. Office formats short-circuit with
/// `ExternalExtractorRequired`; empty files return an empty report.
///
/// `cfg.default_scope` must be `Project` or `Reference` —
/// `User`/`Feedback` are rejected with `MemoryError::ImportScopeBlocked`.
pub async fn import_one(
    store: &MemoryStore,
    source: ImportSource,
    cfg: &ImportConfig,
) -> MemoryResult<ImportReport> {
    if !matches!(
        cfg.default_scope,
        MemoryScope::Project | MemoryScope::Reference
    ) {
        return Err(MemoryError::ImportScopeBlocked {
            scope: cfg.default_scope,
        });
    }
    let kind = source
        .kind
        .unwrap_or_else(|| SourceKind::from_filename(&source.filename));
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
    if text.len() > cfg.max_entry_bytes {
        return Err(MemoryError::EntryTooLarge {
            filename: source.filename,
            bytes: text.len(),
            limit: cfg.max_entry_bytes,
        });
    }

    let name = base_slug(&source.filename);
    sanitize_name(&name).map_err(|e| match e {
        MemoryError::InvalidName { name, reason } => MemoryError::InvalidName {
            name: format!("derived from {:?}: {name}", source.filename),
            reason,
        },
        other => other,
    })?;
    let entry = store.write_force(cfg.default_scope, &name, &text).await?;
    Ok(ImportReport {
        filename: source.filename,
        kind,
        entries: vec![(entry.scope, entry.name)],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_fixture() -> (tempfile::TempDir, MemoryStore) {
        let tmp = tempfile::tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().join("memory"));
        (tmp, store)
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
        assert_eq!(SourceKind::from_filename("main.rs"), SourceKind::Code);
        assert_eq!(
            SourceKind::from_filename("plain.txt"),
            SourceKind::PlainText
        );
        assert_eq!(SourceKind::from_filename("spec.docx"), SourceKind::Docx);
        assert_eq!(SourceKind::from_filename("budget.xlsx"), SourceKind::Xlsx);
        assert_eq!(SourceKind::from_filename("deck.pptx"), SourceKind::Pptx);
    }

    #[test]
    fn base_slug_normalises_filenames() {
        assert_eq!(base_slug("My Document.md"), "my-document");
        assert_eq!(base_slug("/abs/path/to/Plan_v2.md"), "plan_v2");
        assert_eq!(base_slug("../weird/!!!.md"), "import");
        assert_eq!(base_slug(""), "import");
    }

    #[tokio::test]
    async fn import_short_text_writes_one_entry() {
        let (_t, store) = store_fixture();
        let report = import_one(
            &store,
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
    async fn import_empty_file_is_a_noop() {
        let (_t, store) = store_fixture();
        let report = import_one(&store, src("empty.txt", ""), &ImportConfig::default())
            .await
            .unwrap();
        assert!(report.entries.is_empty());
    }

    #[tokio::test]
    async fn import_handles_lossy_utf8() {
        let (_t, store) = store_fixture();
        let bytes = vec![b'h', b'i', 0xff, b'!'];
        let report = import_one(
            &store,
            ImportSource {
                bytes,
                filename: "broken.txt".into(),
                kind: None,
            },
            &ImportConfig::default(),
        )
        .await
        .unwrap();
        assert_eq!(report.entries.len(), 1);
    }

    #[tokio::test]
    async fn office_formats_surface_external_extractor_required() {
        let (_t, store) = store_fixture();
        for (filename, kind_str) in &[
            ("spec.docx", "docx"),
            ("budget.xlsx", "xlsx"),
            ("deck.pptx", "pptx"),
        ] {
            let result = import_one(
                &store,
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
    async fn entries_above_max_size_return_entry_too_large() {
        let (_t, store) = store_fixture();
        let body = "x".repeat(8 * 1024);
        let result = import_one(
            &store,
            src("big.md", &body),
            &ImportConfig {
                default_scope: MemoryScope::Reference,
                max_entry_bytes: 1024,
            },
        )
        .await;
        match result {
            Err(MemoryError::EntryTooLarge { bytes, limit, .. }) => {
                assert_eq!(bytes, 8 * 1024);
                assert_eq!(limit, 1024);
            }
            other => panic!("expected EntryTooLarge; got {other:?}"),
        }
    }

    #[tokio::test]
    async fn user_and_feedback_scopes_are_blocked_for_imports() {
        let (_t, store) = store_fixture();
        for scope in [MemoryScope::User, MemoryScope::Feedback] {
            let result = import_one(
                &store,
                src("attempt.txt", "anything"),
                &ImportConfig {
                    default_scope: scope,
                    max_entry_bytes: 64 * 1024,
                },
            )
            .await;
            assert!(matches!(
                result,
                Err(MemoryError::ImportScopeBlocked { .. })
            ));
        }
    }

    #[tokio::test]
    async fn explicit_kind_overrides_extension() {
        let (_t, store) = store_fixture();
        let report = import_one(
            &store,
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
        assert_eq!(report.entries.len(), 1);
    }
}
