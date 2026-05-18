//! `LoopGuard` — anti-infinite-tool-loop heuristic.
//!
//! The agent loop is structurally bounded by `EngineConfig::max_iterations`,
//! but in practice that bound triggers far too late: a wedged model can
//! burn through all 10 iterations (each one spending tokens) repeating the
//! same tool call with the same arguments. The classic shape is:
//!
//! ```text
//! iter 1: Read("foo.rs") → assistant: "let me look again"
//! iter 2: Read("foo.rs") → assistant: "let me look again"
//! …
//! ```
//!
//! `LoopGuard` keeps a per-turn `HashMap<(tool_name, input_hash), count>`
//! and trips as soon as a single (tool, input) pair has been issued
//! `limit` times. The engine surfaces this as `EngineError::LoopGuardTripped`
//! and the dispatcher renders it as a friendly user error.
//!
//! Hashing strategy: blake3 over the canonical JSON serialisation of the
//! input. Map iteration order is non-deterministic, so JSON objects with
//! the same keys but different insertion order would produce different
//! hashes — that's fine for this heuristic. We're catching the case where
//! the model emits the *same byte stream* repeatedly; minor formatting
//! variation just means the guard takes one more iteration to trip.

use std::collections::HashMap;

const DEFAULT_LIMIT: usize = 3;

#[derive(Debug, Clone, Copy)]
pub struct LoopGuardConfig {
    pub limit: usize,
}

impl Default for LoopGuardConfig {
    fn default() -> Self {
        Self {
            limit: DEFAULT_LIMIT,
        }
    }
}

/// Per-turn tally. `record` returns the new count for that (tool, input)
/// after incrementing; the engine compares against `cfg.limit`.
pub struct LoopGuard {
    counts: HashMap<(String, [u8; 32]), usize>,
    cfg: LoopGuardConfig,
}

impl LoopGuard {
    pub fn new(cfg: LoopGuardConfig) -> Self {
        Self {
            counts: HashMap::new(),
            cfg,
        }
    }

    /// Returns `Err((tool, count))` when this call pushes the count past
    /// `limit`. The caller — `engine.rs` — converts that into
    /// `EngineError::LoopGuardTripped` and aborts the turn. Returns
    /// `Ok(count)` when the call is still within budget.
    pub fn record(
        &mut self,
        tool: &str,
        input: &serde_json::Value,
    ) -> Result<usize, (String, usize)> {
        let serialized = serde_json::to_vec(input).unwrap_or_default();
        let hash = *blake3::hash(&serialized).as_bytes();
        let entry = self.counts.entry((tool.to_string(), hash)).or_insert(0);
        *entry += 1;
        let count = *entry;
        if count >= self.cfg.limit {
            Err((tool.to_string(), count))
        } else {
            Ok(count)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn within_limit_returns_ok_with_count() {
        let mut g = LoopGuard::new(LoopGuardConfig { limit: 3 });
        assert_eq!(g.record("Read", &json!({"path": "x"})).unwrap(), 1);
        assert_eq!(g.record("Read", &json!({"path": "x"})).unwrap(), 2);
    }

    #[test]
    fn third_identical_call_trips() {
        let mut g = LoopGuard::new(LoopGuardConfig { limit: 3 });
        g.record("Read", &json!({"path": "x"})).unwrap();
        g.record("Read", &json!({"path": "x"})).unwrap();
        let err = g.record("Read", &json!({"path": "x"})).unwrap_err();
        assert_eq!(err.0, "Read");
        assert_eq!(err.1, 3);
    }

    #[test]
    fn different_inputs_do_not_count_together() {
        let mut g = LoopGuard::new(LoopGuardConfig { limit: 3 });
        g.record("Read", &json!({"path": "a"})).unwrap();
        g.record("Read", &json!({"path": "b"})).unwrap();
        g.record("Read", &json!({"path": "c"})).unwrap();
        // Three reads, but each on a different file — no trip.
        let n = g.record("Read", &json!({"path": "d"})).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn different_tools_do_not_count_together() {
        let mut g = LoopGuard::new(LoopGuardConfig { limit: 3 });
        g.record("Read", &json!({"x": 1})).unwrap();
        g.record("Grep", &json!({"x": 1})).unwrap();
        // Same payload, different tool names — independent tallies.
        let n = g.record("Glob", &json!({"x": 1})).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn limit_one_trips_immediately() {
        let mut g = LoopGuard::new(LoopGuardConfig { limit: 1 });
        let err = g.record("Read", &json!({"path": "x"})).unwrap_err();
        assert_eq!(err.1, 1);
    }
}
