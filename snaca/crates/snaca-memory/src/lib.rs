//! `snaca-memory` — long-term memory (M3).
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
//! - [`IndexedMemoryStore`] — `MemoryStore` + vector index, used by the
//!   engine for cosine retrieval at turn start
//! - [`Embedder`]      — embedding trait; production impl is
//!   [`FastEmbedEmbedder`] under the `fastembed` feature
//! - [`import_one`] / [`import_bundle`] — IM-attachment ingestion
//!   (MIME sniff → chunk → embed → store), single file or bundled ZIP

pub mod chunk;
pub mod classify;
pub mod embed;
#[cfg(feature = "fastembed")]
pub mod fastembed_backend;
pub mod import;
#[cfg(feature = "bundle")]
pub mod import_zip;
pub mod indexed;
#[cfg(feature = "pdf")]
pub mod pdf_extract;
pub mod scope;
pub mod store;

pub use chunk::{chunk_markdown, chunk_recursive, ChunkConfig};
pub use classify::{
    ConstantClassifier, ImportClassifier, ImportClassifierKind, LlmImportClassifier,
    SharedClassifier,
};
pub use import::{import_one, ImportConfig, ImportReport, ImportSource, SourceKind};
#[cfg(feature = "bundle")]
pub use import_zip::{import_bundle, MAX_MEMBER_BYTES};
pub use embed::{cosine, EmbedError, EmbedResult, Embedder, HashEmbedder};
#[cfg(feature = "fastembed")]
pub use fastembed_backend::{FastEmbedConfig, FastEmbedEmbedder};
pub use indexed::{IndexedMemoryStore, SearchHit};
pub use scope::MemoryScope;
pub use store::{sanitize_name, MemoryEntry, MemoryError, MemoryResult, MemoryStore};
