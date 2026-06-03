//! Per-chunk classification for the bulk import pipeline.
//!
//! Without a classifier, every imported chunk lands in
//! `ImportConfig::default_scope` (typically `Reference`). With one,
//! each chunk gets its scope chosen by the classifier — opens the
//! door to "this section of the doc is project conventions, that
//! one is just reference material" routing.
//!
//! ## Allowed scopes
//!
//! Only `Project` and `Reference` are valid classifier outputs.
//! `User` and `Feedback` are personal/behavioural categories that
//! should *only* be created by the conversation extractor or
//! manually — letting bulk import write into them would let a
//! malicious upload plant fake user preferences.

use crate::scope::MemoryScope;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use snaca_core::{ContentBlock, Message, MessageId, Role};
use snaca_llm::{LlmClient, MessageRequest};
use std::sync::Arc;
use tracing::{debug, warn};

/// Trait surface kept narrow on purpose — implementations get the
/// chunk text and return one scope. No async streaming, no per-call
/// state. Keeps test stubs trivial and lets the engine wire any
/// implementation through `Arc<dyn ImportClassifier>`.
#[async_trait]
pub trait ImportClassifier: Send + Sync {
    async fn classify(&self, chunk: &str) -> MemoryScope;
}

pub type SharedClassifier = Arc<dyn ImportClassifier>;

/// Always returns the same scope. Used by tests and as a no-op
/// fallback when an LLM classifier fails over.
pub struct ConstantClassifier {
    scope: MemoryScope,
}

impl ConstantClassifier {
    pub fn new(scope: MemoryScope) -> Self {
        Self { scope }
    }
}

#[async_trait]
impl ImportClassifier for ConstantClassifier {
    async fn classify(&self, _chunk: &str) -> MemoryScope {
        self.scope
    }
}

// =====================================================================
// LlmImportClassifier — production classifier.
// =====================================================================

const CLASSIFY_SYSTEM_PROMPT: &str =
    "You classify excerpts from a user-uploaded document into one of \
     two memory scopes:\n\n\
     - `project`  → conventions, decisions, architecture, internal docs\n\
     - `reference` → external pointers, third-party docs, knowledge base\n\n\
     Output exactly one word: `project` or `reference`. No prose, \
     no markdown, no JSON. If unsure, default to `reference`.";

/// LLM-backed classifier. Issues one tiny `create_message` call per
/// chunk. Robust to noisy output: anything that isn't `project` or
/// `reference` falls back to the configured default.
pub struct LlmImportClassifier {
    llm: Arc<dyn LlmClient>,
    model: String,
    /// Fallback when the LLM call fails or returns an unrecognised
    /// answer. Defaults to `Reference`.
    fallback: MemoryScope,
}

impl LlmImportClassifier {
    pub fn new(llm: Arc<dyn LlmClient>, model: impl Into<String>) -> Self {
        Self {
            llm,
            model: model.into(),
            fallback: MemoryScope::Reference,
        }
    }

    /// Override the fallback scope (still must be `Project` or
    /// `Reference` — `User` / `Feedback` are rejected).
    pub fn with_fallback(mut self, scope: MemoryScope) -> Self {
        if matches!(scope, MemoryScope::Project | MemoryScope::Reference) {
            self.fallback = scope;
        } else {
            warn!(
                attempted = %scope,
                "ignoring invalid classifier fallback; only project/reference accepted"
            );
        }
        self
    }

    fn parse(raw: &str) -> Option<MemoryScope> {
        // Strip prose, markdown fences, surrounding punctuation.
        let trimmed = raw
            .trim()
            .trim_matches(|c: char| {
                c.is_whitespace() || matches!(c, '`' | '"' | '\'' | '.' | ',' | ':' | ';')
            })
            .to_ascii_lowercase();
        // The model occasionally returns `**project**` or `Scope: project` etc.
        for token in trimmed.split_whitespace() {
            let cleaned = token.trim_matches(|c: char| {
                !c.is_ascii_alphabetic()
            });
            match cleaned {
                "project" => return Some(MemoryScope::Project),
                "reference" => return Some(MemoryScope::Reference),
                _ => {}
            }
        }
        None
    }
}

/// Excerpt cap before sending to the classifier. Long excerpts cost
/// tokens without changing the answer — 600 bytes (≈150 tokens) is
/// plenty to read the gist of a chunk.
const CLASSIFY_EXCERPT_BYTES: usize = 600;

fn clip(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut cut = max_bytes;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let head = &s[..cut];
    let trim_to = head.rfind(char::is_whitespace).unwrap_or(cut);
    format!("{}…", &head[..trim_to].trim_end())
}

#[async_trait]
impl ImportClassifier for LlmImportClassifier {
    async fn classify(&self, chunk: &str) -> MemoryScope {
        if chunk.trim().is_empty() {
            return self.fallback;
        }
        let excerpt = clip(chunk, CLASSIFY_EXCERPT_BYTES);
        let user = Message {
            id: MessageId::new(),
            role: Role::User,
            content: vec![ContentBlock::text(format!("Excerpt:\n\n{excerpt}"))],
            created_at: chrono::Utc::now(),
        };
        let req = MessageRequest::new(&self.model)
            .with_system(CLASSIFY_SYSTEM_PROMPT)
            .with_messages(vec![user])
            .with_tools(Vec::new())
            // Cap output tightly — we want a single word, anything
            // longer is hallucination.
            .with_max_tokens(8);
        let resp = match self.llm.create_message(req).await {
            Ok(r) => r,
            Err(e) => {
                warn!(error = %e, "import classifier LLM call failed; using fallback");
                return self.fallback;
            }
        };
        let text = resp
            .message
            .content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" ");
        match Self::parse(&text) {
            Some(s) => s,
            None => {
                debug!(
                    raw = %text.trim(),
                    "classifier returned unrecognised scope; using fallback"
                );
                self.fallback
            }
        }
    }
}

// Wire schema for serialising a classifier choice (e.g. into config).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportClassifierKind {
    None,
    Constant(MemoryScope),
    Llm,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn constant_classifier_returns_canned_scope() {
        let c = ConstantClassifier::new(MemoryScope::Project);
        assert_eq!(c.classify("anything").await, MemoryScope::Project);
    }

    #[test]
    fn parse_accepts_clean_words() {
        assert_eq!(LlmImportClassifier::parse("project"), Some(MemoryScope::Project));
        assert_eq!(LlmImportClassifier::parse("reference"), Some(MemoryScope::Reference));
    }

    #[test]
    fn parse_strips_markdown_and_punctuation() {
        assert_eq!(
            LlmImportClassifier::parse("**project**"),
            Some(MemoryScope::Project)
        );
        assert_eq!(
            LlmImportClassifier::parse("`reference`."),
            Some(MemoryScope::Reference)
        );
        assert_eq!(
            LlmImportClassifier::parse("Scope: project"),
            Some(MemoryScope::Project)
        );
    }

    #[test]
    fn parse_ignores_user_and_feedback_outputs() {
        // The LLM occasionally tries to use the conversation-only
        // scopes; we MUST NOT let those land via import.
        assert_eq!(LlmImportClassifier::parse("user"), None);
        assert_eq!(LlmImportClassifier::parse("feedback"), None);
    }

    #[test]
    fn parse_returns_none_for_garbage() {
        assert_eq!(LlmImportClassifier::parse("I don't know"), None);
        assert_eq!(LlmImportClassifier::parse(""), None);
    }
}
