//! ZIP bundle import — walks a `.zip` archive's members and runs the
//! standard [`import_one`](crate::import::import_one) pipeline against
//! each one.
//!
//! ## Format coverage
//!
//! Members are extracted into memory and routed through the same
//! `SourceKind` detection the per-file path uses. PDFs require the
//! `pdf` feature to be on at build time. DOCX / XLSX / PPTX are
//! *never* extracted here — snaca-memory delegates those formats to
//! the `office-extract` skill via an out-of-process script, so the
//! bundle import skips them with a warning regardless of build flags.
//!
//! ## Naming
//!
//! Members keep their relative path inside the archive baked into the
//! entry slug — e.g. `docs/style.md` becomes `<bundle>-docs-style`
//! before further chunk-suffixing. This avoids collisions when two
//! sub-directories of the archive both contain a `README.md`.
//!
//! ## Limits
//!
//! - Hidden entries (`.git/`, `.DS_Store`, etc.) are skipped.
//! - Symlinks inside the archive are ignored — the `zip` crate
//!   doesn't return them as files anyway, but defensive.
//! - Files larger than [`MAX_MEMBER_BYTES`] are skipped with a warning;
//!   bulk import is for documents, not arbitrary binaries.

use crate::import::{import_one, ImportConfig, ImportReport, ImportSource, SourceKind};
use crate::store::MemoryError;
use crate::IndexedMemoryStore;
use std::io::{Cursor, Read};
use tracing::{debug, info, warn};

/// Per-member size cap. 8 MB covers any markdown / text / source file
/// we care about while keeping a malicious zip bomb from accidentally
/// blowing up the engine.
pub const MAX_MEMBER_BYTES: u64 = 8 * 1024 * 1024;

/// Whether the current build can extract `kind`. Used by `import_bundle`
/// to skip ZIP members whose extractor isn't compiled in instead of
/// surfacing the per-file error N times.
///
/// Office formats (docx/xlsx/pptx) are intentionally always `false` —
/// they require the `office-extract` skill running an out-of-process
/// Python extractor, which the bundle path does not invoke.
fn extractor_available(kind: SourceKind) -> bool {
    match kind {
        SourceKind::PlainText | SourceKind::Markdown | SourceKind::Code => true,
        SourceKind::Pdf => cfg!(feature = "pdf"),
        SourceKind::Docx | SourceKind::Xlsx | SourceKind::Pptx => false,
    }
}

/// Build a per-member entry-name prefix from the archive name + the
/// relative path of the member. Joining with `-` so the existing
/// `base_slug` machinery in `import_one` produces a single legal
/// identifier without further encoding.
fn member_filename(archive_filename: &str, member_path: &str) -> String {
    let archive_stem = std::path::Path::new(archive_filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("bundle");
    // Replace path separators with `-` so the slugger turns it into a
    // single dash-segment without dropping path information.
    let member_flat = member_path.replace(['/', '\\'], "-");
    format!("{archive_stem}-{member_flat}")
}

/// Walk every regular-file member of a ZIP archive and import each one
/// through [`import_one`]. Returns a `Vec<ImportReport>` in archive
/// member order. Per-member failures are logged and skipped — the
/// caller gets a partial result rather than an aborted batch.
///
/// `archive_filename` is used only for naming. The bytes themselves
/// are read from the supplied buffer.
pub async fn import_bundle(
    indexer: &IndexedMemoryStore,
    archive_bytes: &[u8],
    archive_filename: &str,
    cfg: &ImportConfig,
) -> Result<Vec<ImportReport>, MemoryError> {
    let cursor = Cursor::new(archive_bytes);
    let mut zip = zip::ZipArchive::new(cursor).map_err(|e| {
        MemoryError::Io(std::io::Error::other(format!(
            "bundle {archive_filename} is not a valid zip: {e}"
        )))
    })?;
    let count = zip.len();
    info!(archive = archive_filename, member_count = count, "starting bundle import");

    let mut reports = Vec::new();
    for i in 0..count {
        let mut entry = match zip.by_index(i) {
            Ok(e) => e,
            Err(e) => {
                warn!(archive = archive_filename, idx = i, error = %e, "skip unreadable member");
                continue;
            }
        };
        if !entry.is_file() {
            continue;
        }
        let member_name_owned = entry.name().to_string();
        // Skip hidden files / dirs anywhere along the path.
        if member_name_owned
            .split('/')
            .any(|seg| seg.starts_with('.'))
        {
            debug!(member = %member_name_owned, "skipping hidden member");
            continue;
        }
        if entry.size() > MAX_MEMBER_BYTES {
            warn!(
                member = %member_name_owned,
                bytes = entry.size(),
                cap = MAX_MEMBER_BYTES,
                "skipping oversized member"
            );
            continue;
        }
        // Sniff format from the inner filename and skip kinds we
        // can't extract on this build.
        let kind = SourceKind::from_filename(&member_name_owned);
        if !extractor_available(kind) {
            warn!(
                member = %member_name_owned,
                kind = ?kind,
                "skipping member: matching extractor feature not enabled"
            );
            continue;
        }

        let mut buf = Vec::with_capacity(entry.size() as usize);
        if let Err(e) = entry.read_to_end(&mut buf) {
            warn!(member = %member_name_owned, error = %e, "skip member: read failed");
            continue;
        }
        // Drop the reader before the next iteration to keep its
        // borrow of `zip` short.
        drop(entry);

        let virtual_filename = member_filename(archive_filename, &member_name_owned);
        let source = ImportSource {
            bytes: buf,
            filename: virtual_filename,
            kind: Some(kind),
        };
        match import_one(indexer, source, cfg).await {
            Ok(report) => reports.push(report),
            Err(e) => {
                warn!(member = %member_name_owned, error = %e, "skip member: import failed");
            }
        }
    }
    Ok(reports)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::HashEmbedder;
    use crate::indexed::IndexedMemoryStore;
    use crate::store::MemoryStore;
    use snaca_core::{ProjectId, TenantId};
    use snaca_state::Database;
    use std::io::Write as _;
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

    /// Build a ZIP in memory with the given (path, content) members.
    fn build_zip(members: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut zw = zip::ZipWriter::new(cursor);
            let opts: zip::write::SimpleFileOptions =
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored);
            for (name, bytes) in members {
                zw.start_file(*name, opts).unwrap();
                zw.write_all(bytes).unwrap();
            }
            zw.finish().unwrap();
        }
        buf
    }

    #[tokio::test]
    async fn bundle_imports_each_text_member() {
        let zip = build_zip(&[
            ("readme.md", b"# Readme\n\nproject overview"),
            ("notes.txt", b"some plain notes"),
            ("docs/spec.md", b"# Spec\n\nimplementation details"),
        ]);
        let (_t, idx) = fixture().await;
        let reports = import_bundle(
            &idx,
            &zip,
            "bundle.zip",
            &ImportConfig::default(),
        )
        .await
        .unwrap();
        assert_eq!(reports.len(), 3, "expected 3 imports; got {reports:?}");
        // Each report's filename uses the archive prefix + flattened path.
        let filenames: Vec<_> = reports.iter().map(|r| r.filename.as_str()).collect();
        assert!(filenames.iter().any(|f| f.contains("readme")));
        assert!(filenames.iter().any(|f| f.contains("notes")));
        assert!(filenames.iter().any(|f| f.contains("docs-spec")));
    }

    #[tokio::test]
    async fn bundle_skips_hidden_members() {
        let zip = build_zip(&[
            ("visible.md", b"visible body"),
            (".hidden.md", b"should be skipped"),
            (".git/HEAD", b"ref: refs/heads/main"),
            ("docs/.draft.md", b"draft content"),
        ]);
        let (_t, idx) = fixture().await;
        let reports = import_bundle(
            &idx,
            &zip,
            "bundle.zip",
            &ImportConfig::default(),
        )
        .await
        .unwrap();
        assert_eq!(reports.len(), 1, "only `visible.md` should land");
        assert!(reports[0].filename.contains("visible"));
    }

    #[tokio::test]
    async fn bundle_skips_oversized_members() {
        let huge = vec![b'x'; (MAX_MEMBER_BYTES as usize) + 1];
        let zip = build_zip(&[
            ("ok.md", b"small body"),
            ("oversized.txt", &huge),
        ]);
        let (_t, idx) = fixture().await;
        let reports = import_bundle(
            &idx,
            &zip,
            "bundle.zip",
            &ImportConfig::default(),
        )
        .await
        .unwrap();
        assert_eq!(reports.len(), 1, "only ok.md should land");
        assert!(reports[0].filename.contains("ok"));
    }

    #[tokio::test]
    async fn bundle_rejects_non_zip_input() {
        let (_t, idx) = fixture().await;
        let err = import_bundle(
            &idx,
            b"not a zip file",
            "bad.zip",
            &ImportConfig::default(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, MemoryError::Io(_)));
    }

    #[cfg(not(feature = "pdf"))]
    #[tokio::test]
    async fn bundle_skips_pdf_when_feature_off() {
        let zip = build_zip(&[
            ("alpha.md", b"# Alpha"),
            ("blob.pdf", b"%PDF-1.5 fake bytes"),
        ]);
        let (_t, idx) = fixture().await;
        let reports = import_bundle(
            &idx,
            &zip,
            "bundle.zip",
            &ImportConfig::default(),
        )
        .await
        .unwrap();
        // Only the markdown member processed — the PDF is silently
        // skipped because no extractor is compiled in.
        assert_eq!(reports.len(), 1);
        assert!(reports[0].filename.contains("alpha"));
    }

    #[test]
    fn member_filename_flattens_path_separators() {
        let n = member_filename("bundle.zip", "docs/sub/file.md");
        assert_eq!(n, "bundle-docs-sub-file.md");
    }

    #[test]
    fn member_filename_handles_no_extension() {
        let n = member_filename("notes-pack.zip", "Makefile");
        assert_eq!(n, "notes-pack-Makefile");
    }
}
