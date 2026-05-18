//! `snaca-workspace` — multi-tenant filesystem layout + path traversal guard.
//!
//! ## Layout
//!
//! ```text
//! <data_root>/
//!   <tenant_id>/
//!     _tenant.json
//!     settings.json                (tenant scope)
//!     skills/*.md
//!     projects/
//!       <project_id>/
//!         workspace/                 ← cwd for filesystem tools
//!         memory/{user,project,reference,feedback}/*.md
//!         memory/MEMORY.md
//!         memory/.index/             (M3)
//!         settings.json              (project scope)
//!         skills/*.md
//! ```
//!
//! ## Path safety
//!
//! [`resolve_within`] is the *only* sanctioned way to convert a user-supplied
//! path into an absolute filesystem path. It pure-string-normalizes (no
//! filesystem touches) and rejects anything that escapes the root. Tools must
//! never `Path::join` a user input directly.

pub mod layout;
pub mod path_guard;
pub mod sandbox;

pub use layout::WorkspaceLayout;
pub use path_guard::{resolve_within, WorkspaceError};
