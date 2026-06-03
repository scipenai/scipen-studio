//! Path-traversal guard.
//!
//! [`resolve_within`] takes a `root` (an absolute project/workspace
//! directory) and a user-supplied `input` (relative or absolute) and returns
//! a normalized absolute path that is guaranteed to live under `root`. It
//! does not touch the filesystem — symlink-based escapes are out of scope
//! at this layer; landlock (M2) enforces them at runtime.

use std::path::{Component, Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("path escapes workspace root: {input}")]
    PathOutsideRoot { input: String },

    #[error("absolute path outside workspace root: {input}")]
    AbsoluteNotInRoot { input: String },

    #[error("workspace root must be absolute: {0}")]
    RootNotAbsolute(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub fn resolve_within(root: &Path, input: &Path) -> Result<PathBuf, WorkspaceError> {
    if !root.is_absolute() {
        return Err(WorkspaceError::RootNotAbsolute(
            root.display().to_string(),
        ));
    }

    let root_normalized = lexically_normalize(root);

    let candidate = if input.is_absolute() {
        let normalized = lexically_normalize(input);
        if !normalized.starts_with(&root_normalized) {
            return Err(WorkspaceError::AbsoluteNotInRoot {
                input: input.display().to_string(),
            });
        }
        normalized
    } else {
        let joined = root_normalized.join(input);
        lexically_normalize(&joined)
    };

    if !candidate.starts_with(&root_normalized) {
        return Err(WorkspaceError::PathOutsideRoot {
            input: input.display().to_string(),
        });
    }
    Ok(candidate)
}

/// Lexical normalization: collapse `.`, resolve `..`, but never touch the
/// filesystem. Mirrors Go's `filepath.Clean`. `..` that would escape past
/// the root is silently capped at the root — the caller still does an
/// explicit `starts_with` check after.
fn lexically_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Prefix(_) | Component::RootDir => out.push(c),
            Component::CurDir => {}
            Component::ParentDir => {
                let popped = out.pop();
                if !popped {
                    // Path goes above its anchor — preserve a literal `..`
                    // so the subsequent `starts_with` test fails cleanly.
                    out.push("..");
                }
            }
            Component::Normal(name) => out.push(name),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        PathBuf::from("/data/tenant_a/projects/proj_x/workspace")
    }

    #[test]
    fn relative_path_resolves_within_root() {
        let p = resolve_within(&root(), Path::new("src/main.rs")).unwrap();
        assert_eq!(p, root().join("src/main.rs"));
    }

    #[test]
    fn dot_segments_are_collapsed() {
        let p = resolve_within(&root(), Path::new("./src/./lib.rs")).unwrap();
        assert_eq!(p, root().join("src/lib.rs"));
    }

    #[test]
    fn parent_within_root_is_ok() {
        let p = resolve_within(&root(), Path::new("a/b/../c.rs")).unwrap();
        assert_eq!(p, root().join("a/c.rs"));
    }

    #[test]
    fn parent_escaping_root_rejected() {
        let err = resolve_within(&root(), Path::new("../../../etc/passwd")).unwrap_err();
        assert!(matches!(err, WorkspaceError::PathOutsideRoot { .. }));
    }

    #[test]
    fn absolute_path_inside_root_ok() {
        let p = resolve_within(
            &root(),
            Path::new("/data/tenant_a/projects/proj_x/workspace/x.rs"),
        )
        .unwrap();
        assert_eq!(p, root().join("x.rs"));
    }

    #[test]
    fn absolute_path_outside_root_rejected() {
        let err = resolve_within(&root(), Path::new("/etc/passwd")).unwrap_err();
        assert!(matches!(err, WorkspaceError::AbsoluteNotInRoot { .. }));
    }

    #[test]
    fn empty_path_resolves_to_root() {
        let p = resolve_within(&root(), Path::new("")).unwrap();
        assert_eq!(p, root());
    }

    #[test]
    fn relative_root_is_rejected() {
        let err = resolve_within(Path::new("relative/dir"), Path::new("a.rs")).unwrap_err();
        assert!(matches!(err, WorkspaceError::RootNotAbsolute(_)));
    }
}
