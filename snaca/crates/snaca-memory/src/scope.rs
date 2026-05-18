//! `MemoryScope` — the four well-known buckets a memory entry can live in.
//!
//! Mirrors the categories Claude Code uses so manually-managed memory
//! files port over without translation. Each scope is a subdirectory
//! under `<project>/memory/`:
//!
//! - `user` — facts about the human(s) using the project
//! - `project` — facts about the project itself, decisions, conventions
//! - `reference` — pointers to external systems / docs the model should
//!   know exist (e.g. "logs are in Loki at …")
//! - `feedback` — corrections from the user that should never repeat
//!
//! The index file `MEMORY.md` lives at `<project>/memory/MEMORY.md` and
//! lists every entry across all four scopes. It's *not* a scope itself.

use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    User,
    Project,
    Reference,
    Feedback,
}

impl MemoryScope {
    /// Every scope, in stable display order. Index renderer relies on
    /// this so MEMORY.md doesn't churn between runs.
    pub fn all() -> &'static [MemoryScope] {
        &[
            MemoryScope::User,
            MemoryScope::Project,
            MemoryScope::Reference,
            MemoryScope::Feedback,
        ]
    }

    pub fn dir_name(self) -> &'static str {
        match self {
            MemoryScope::User => "user",
            MemoryScope::Project => "project",
            MemoryScope::Reference => "reference",
            MemoryScope::Feedback => "feedback",
        }
    }

    pub fn from_dir_name(s: &str) -> Option<Self> {
        match s {
            "user" => Some(MemoryScope::User),
            "project" => Some(MemoryScope::Project),
            "reference" => Some(MemoryScope::Reference),
            "feedback" => Some(MemoryScope::Feedback),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        self.dir_name()
    }
}

impl fmt::Display for MemoryScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.dir_name())
    }
}

impl std::str::FromStr for MemoryScope {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::from_dir_name(s).ok_or_else(|| {
            format!(
                "unknown memory scope `{s}`; valid: user|project|reference|feedback"
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_dir_names() {
        for s in MemoryScope::all() {
            assert_eq!(MemoryScope::from_dir_name(s.dir_name()), Some(*s));
        }
    }

    #[test]
    fn rejects_unknown_dir() {
        assert!(MemoryScope::from_dir_name("hidden").is_none());
        assert!(MemoryScope::from_dir_name("").is_none());
    }
}
