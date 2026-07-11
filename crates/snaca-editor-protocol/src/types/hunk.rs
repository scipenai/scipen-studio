//! A single character-level edit hunk.
//!
//! Multiple hunks in a proposal must be non-overlapping and sorted by
//! `range.start` ascending. Host applies them in **reverse** order to
//! avoid index drift.

use super::range::Range;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LineHunk {
    /// Unique within the proposal (`h0`, `h1`, …).
    pub hunk_id: String,
    /// Range to replace, relative to the file at `base_hash` time.
    pub range: Range,
    /// Equal to `file.slice(range)` at `base_hash` time.
    pub old_text: String,
    /// Replacement text. May be an empty / partial prefix during streaming.
    pub new_text: String,
}

impl LineHunk {
    pub fn new(
        hunk_id: impl Into<String>,
        range: Range,
        old_text: impl Into<String>,
        new_text: impl Into<String>,
    ) -> Self {
        Self {
            hunk_id: hunk_id.into(),
            range,
            old_text: old_text.into(),
            new_text: new_text.into(),
        }
    }

    /// Append text to `new_text` (used during streaming).
    pub fn extend_new_text(&mut self, append: &str) {
        self.new_text.push_str(append);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::range::Position;

    #[test]
    fn extend_appends() {
        let mut h = LineHunk::new(
            "h0",
            Range::new(Position::new(0, 0), Position::new(0, 5)),
            "hello",
            "Hi",
        );
        h.extend_new_text(", world");
        assert_eq!(h.new_text, "Hi, world");
    }

    #[test]
    fn roundtrips_with_serde() {
        let h = LineHunk::new(
            "h0",
            Range::new(Position::new(3, 0), Position::new(7, 0)),
            "old",
            "new",
        );
        let s = serde_json::to_string(&h).unwrap();
        let back: LineHunk = serde_json::from_str(&s).unwrap();
        assert_eq!(h, back);
    }
}
