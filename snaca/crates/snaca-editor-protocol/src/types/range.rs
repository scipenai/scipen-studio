//! Character-level positions and ranges within a file.
//!
//! Lines and columns are **0-based**. End position is **exclusive**, like
//! LSP and Monaco. Column counts UTF-16 code units to match Monaco's
//! native unit (host responsibility on the wire; this crate just carries
//! the numbers).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Position {
    pub line: u32,
    pub column: u32,
}

impl Position {
    pub const fn new(line: u32, column: u32) -> Self {
        Self { line, column }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

impl Range {
    pub const fn new(start: Position, end: Position) -> Self {
        Self { start, end }
    }

    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }

    /// Two ranges overlap when neither ends before the other begins.
    pub fn overlaps(&self, other: &Range) -> bool {
        !(self.end <= other.start || other.end <= self.start)
    }
}

impl PartialOrd for Position {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Position {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.line.cmp(&other.line).then(self.column.cmp(&other.column))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_orders_by_line_then_column() {
        assert!(Position::new(1, 5) < Position::new(2, 0));
        assert!(Position::new(1, 5) < Position::new(1, 6));
        assert!(Position::new(2, 0) > Position::new(1, 99));
    }

    #[test]
    fn empty_range() {
        let r = Range::new(Position::new(0, 0), Position::new(0, 0));
        assert!(r.is_empty());
    }

    #[test]
    fn overlap_detection() {
        let a = Range::new(Position::new(0, 0), Position::new(2, 0));
        let b = Range::new(Position::new(1, 0), Position::new(3, 0));
        let c = Range::new(Position::new(2, 0), Position::new(3, 0));
        assert!(a.overlaps(&b));
        assert!(!a.overlaps(&c)); // adjacent, not overlapping
    }

    #[test]
    fn serialize_compact() {
        let r = Range::new(Position::new(42, 13), Position::new(42, 30));
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"line\":42"));
        assert!(s.contains("\"column\":30"));
    }
}
