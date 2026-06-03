//! Token usage accounting.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Anthropic prompt-cache write count. `None` for providers without cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u64>,
    /// Anthropic prompt-cache hit count. `None` for providers without cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u64>,
}

impl Usage {
    pub fn total(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }

    /// Sum two usage records (e.g. multi-turn aggregation).
    pub fn add(&mut self, other: &Usage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        match (
            self.cache_creation_input_tokens,
            other.cache_creation_input_tokens,
        ) {
            (Some(a), Some(b)) => self.cache_creation_input_tokens = Some(a + b),
            (None, Some(b)) => self.cache_creation_input_tokens = Some(b),
            _ => {}
        }
        match (
            self.cache_read_input_tokens,
            other.cache_read_input_tokens,
        ) {
            (Some(a), Some(b)) => self.cache_read_input_tokens = Some(a + b),
            (None, Some(b)) => self.cache_read_input_tokens = Some(b),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn total_sums_input_and_output() {
        let u = Usage {
            input_tokens: 10,
            output_tokens: 5,
            ..Default::default()
        };
        assert_eq!(u.total(), 15);
    }

    #[test]
    fn add_accumulates_cache_tokens() {
        let mut a = Usage {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: Some(3),
            cache_read_input_tokens: None,
        };
        let b = Usage {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: Some(30),
            cache_read_input_tokens: Some(40),
        };
        a.add(&b);
        assert_eq!(a.input_tokens, 11);
        assert_eq!(a.output_tokens, 22);
        assert_eq!(a.cache_creation_input_tokens, Some(33));
        assert_eq!(a.cache_read_input_tokens, Some(40));
    }
}
