//! `snaca-memory` — long-term memory.
//!
//! ## Layout
//!
//! Each project gets its own memory tree at
//! `<data_root>/<tenant>/projects/<project>/memory/`:
//!
//! - `MEMORY.md`              — index file regenerated on every write
//! - `user/<name>.md`         — facts about the user
//! - `project/<name>.md`      — facts about the project
//! - `reference/<name>.md`    — pointers to external systems
//! - `feedback/<name>.md`     — corrections that should never repeat
//!
//! ## Building blocks
//!
//! - [`MemoryScope`]   — the four well-known buckets
//! - [`MemoryStore`]   — file-tree CRUD + index renderer
//! - [`import_one`] / [`import_bundle`] — bulk ingestion of text /
//!   markdown / source files / PDFs as a single memory entry per
//!   source. DOCX / XLSX / PPTX are routed to the out-of-process
//!   `office-extract` skill via a typed
//!   [`MemoryError::ExternalExtractorRequired`] error.
//!
//! Vector embedding, cosine recall, and reranker live elsewhere — they
//! were removed when the engine adopted the frozen-snapshot memory
//! model. The file tree is the single source of truth.

pub mod approval;
pub mod import;
#[cfg(feature = "bundle")]
pub mod import_zip;
#[cfg(feature = "pdf")]
pub mod pdf_extract;
pub mod provider;
pub mod scope;
pub mod snapshot;
pub mod store;
pub mod threat;

pub use approval::{
    approve as approve_pending, list_pending, reject as reject_pending, stage as stage_pending,
    Pending,
};
pub use import::{import_one, ImportConfig, ImportReport, ImportSource, SourceKind};
#[cfg(feature = "bundle")]
pub use import_zip::{import_bundle, MAX_MEMBER_BYTES};
pub use provider::FileTreeMemoryProvider;
pub use scope::MemoryScope;
pub use snapshot::{render as render_snapshot, RenderConfig, Snapshot};
pub use store::{
    parse_frontmatter, render_with_frontmatter, sanitize_name, MemoryEntry, MemoryError,
    MemoryMeta, MemoryResult, MemoryStore,
};
pub use threat::{scan as threat_scan, ThreatHit};
