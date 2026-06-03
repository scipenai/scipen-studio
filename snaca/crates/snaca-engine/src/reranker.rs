//! `Reranker` — re-orders cosine-recall candidates using a more
//! discerning judge before they hit the system prompt.
//!
//! ## Why a second pass
//!
//! Cosine similarity over a small embedding model captures lexical
//! overlap fine but doesn't always pick the *most relevant* memory.
//! Pulling top-20 cheap candidates and asking the LLM to pick the best
//! 5 is a well-known retrieval pattern: it's a single extra LLM call
//! per turn and it lets us trade compute for precision.
//!
//! ## Surface
//!
//! - [`Reranker`] — async trait; takes a query + candidates + cap,
//!   returns a (possibly truncated) re-ordered subset.
//! - [`IdentityReranker`] — passthrough that just truncates. Used
//!   when no reranker is configured / by tests that need a stable
//!   ordering.
//! - [`LlmReranker`] — production implementation. Issues one
//!   `create_message` call with a structured-output prompt.
//!
//! ## Failure modes
//!
//! Bad LLM output (non-JSON, malformed indices, empty response) all
//! gracefully degrade to "return the input top-k truncated". The
//! engine never fails a turn because rerank had a bad day.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use snaca_core::{ContentBlock, Message, MessageId, Role};
use snaca_llm::{LlmClient, MessageRequest};
use snaca_memory::MemoryScope;
use std::sync::Arc;
use tracing::{debug, warn};

/// One candidate handed to the reranker. The full body is included so
/// the LLM has enough context to judge relevance — excerpting at this
/// stage would defeat the point of a second pass.
#[derive(Debug, Clone, PartialEq)]
pub struct RerankCandidate {
    pub scope: MemoryScope,
    pub name: String,
    pub content: String,
    /// The cosine score from the first-pass search. Carried through
    /// for diagnostics + as a tiebreaker when the reranker omits its
    /// own score signal.
    pub initial_score: f32,
}

#[async_trait]
pub trait Reranker: Send + Sync {
    /// Return at most `top_k` candidates in descending order of
    /// relevance. Implementations may return fewer if they judge no
    /// candidate worth surfacing. Returning more than `top_k` is the
    /// caller's truncation responsibility.
    async fn rerank(
        &self,
        query: &str,
        candidates: Vec<RerankCandidate>,
        top_k: usize,
    ) -> Vec<RerankCandidate>;
}

/// `Arc<dyn Reranker>` shorthand mirroring the extractor's alias.
pub type SharedReranker = Arc<dyn Reranker>;

// =====================================================================
// IdentityReranker — pass-through, just truncates.
// =====================================================================

/// Trivial reranker — keeps the input order, truncates to `top_k`.
/// Default fallback when no real reranker is configured. The engine
/// could equivalently just truncate inline; having the no-op as an
/// explicit type lets call sites stay uniform (always go through the
/// reranker path) and gives tests a stable comparison point.
pub struct IdentityReranker;

#[async_trait]
impl Reranker for IdentityReranker {
    async fn rerank(
        &self,
        _query: &str,
        mut candidates: Vec<RerankCandidate>,
        top_k: usize,
    ) -> Vec<RerankCandidate> {
        candidates.truncate(top_k);
        candidates
    }
}

// =====================================================================
// LlmReranker — production reranker.
// =====================================================================

const RERANK_SYSTEM_PROMPT: &str =
    "You rate how relevant each memory excerpt is to the user's query. \
     Return a JSON array of integer ids in DESCENDING order of relevance, \
     e.g. `[3, 1, 5]`. Include ONLY ids that are genuinely relevant; if \
     none qualify, return `[]`. Never invent ids that don't appear below. \
     Output ONLY the JSON array, no prose, no markdown fence.";

/// Per-candidate excerpt cap when building the rerank prompt. Keeps the
/// extra LLM call bounded — five 600-byte excerpts plus framing fits in
/// well under 1k tokens.
const RERANK_EXCERPT_BYTES: usize = 600;

/// Production reranker. Sends one structured-output prompt to the LLM
/// and parses the returned id list. Robust to bad output — any parse
/// failure or out-of-range index falls back to the cosine ordering.
pub struct LlmReranker {
    llm: Arc<dyn LlmClient>,
    model: String,
}

impl LlmReranker {
    pub fn new(llm: Arc<dyn LlmClient>, model: impl Into<String>) -> Self {
        Self {
            llm,
            model: model.into(),
        }
    }

    /// Render the candidates as a numbered list the LLM can rate.
    /// Excerpts are clamped to keep the prompt small.
    fn render_candidates(candidates: &[RerankCandidate]) -> String {
        let mut out = String::new();
        for (i, c) in candidates.iter().enumerate() {
            let excerpt = clip(&c.content, RERANK_EXCERPT_BYTES);
            out.push_str(&format!(
                "[{id}] {scope}/{name}: {excerpt}\n",
                id = i + 1,
                scope = c.scope.as_str(),
                name = c.name,
                excerpt = excerpt.replace('\n', " ").trim()
            ));
        }
        out
    }

    /// Tolerant JSON parser: strips a `\`\`\`json` fence pair if the
    /// model added one, returns an empty Vec on failure.
    fn parse_id_list(raw: &str) -> Vec<usize> {
        let trimmed = raw.trim();
        let stripped = trimmed
            .strip_prefix("```json")
            .or_else(|| trimmed.strip_prefix("```"))
            .map(|s| s.trim_start())
            .unwrap_or(trimmed);
        let stripped = stripped
            .strip_suffix("```")
            .map(|s| s.trim_end())
            .unwrap_or(stripped);
        match serde_json::from_str::<Vec<RawId>>(stripped) {
            Ok(v) => v.into_iter().map(usize::from).collect(),
            Err(e) => {
                warn!(error = %e, "rerank: LLM did not return JSON id array; falling back");
                Vec::new()
            }
        }
    }
}

/// Wire format: an integer id, but accept both number and string forms
/// since some smaller models sometimes return `"3"` instead of `3`.
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum RawId {
    Number(usize),
    String(String),
}

impl From<RawId> for usize {
    fn from(r: RawId) -> Self {
        match r {
            RawId::Number(n) => n,
            RawId::String(s) => s.trim().parse::<usize>().unwrap_or(0),
        }
    }
}

#[async_trait]
impl Reranker for LlmReranker {
    async fn rerank(
        &self,
        query: &str,
        candidates: Vec<RerankCandidate>,
        top_k: usize,
    ) -> Vec<RerankCandidate> {
        if candidates.is_empty() || top_k == 0 {
            return Vec::new();
        }
        // Truncate to top_k right away if the cosine layer already
        // gave us few enough — no point firing an LLM call.
        if candidates.len() <= top_k {
            return candidates;
        }
        let rendered = Self::render_candidates(&candidates);
        let user = Message {
            id: MessageId::new(),
            role: Role::User,
            content: vec![ContentBlock::text(format!(
                "Query: {query}\n\nExcerpts:\n{rendered}"
            ))],
            created_at: chrono::Utc::now(),
        };
        let req = MessageRequest::new(&self.model)
            .with_system(RERANK_SYSTEM_PROMPT)
            .with_messages(vec![user])
            .with_tools(Vec::new())
            .with_max_tokens(256);
        let resp = match self.llm.create_message(req).await {
            Ok(r) => r,
            Err(e) => {
                warn!(error = %e, "rerank LLM call failed; falling back to cosine order");
                return truncate(candidates, top_k);
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
            .join("\n");
        let ids = Self::parse_id_list(&text);
        if ids.is_empty() {
            // Don't treat empty as "no relevant memories" — that
            // conflicts with the cosine layer's prior judgement that
            // *something* was relevant. Surface a fallback truncation.
            debug!("rerank returned empty id list; falling back to cosine order");
            return truncate(candidates, top_k);
        }

        let mut out: Vec<RerankCandidate> = Vec::with_capacity(top_k.min(ids.len()));
        let mut seen = std::collections::HashSet::new();
        for raw_id in ids {
            // Convert from 1-based ids in the prompt back to 0-based
            // index. Skip out-of-range and duplicates silently.
            if raw_id == 0 || raw_id > candidates.len() {
                debug!(raw_id, "rerank: out-of-range id; skipping");
                continue;
            }
            let idx = raw_id - 1;
            if !seen.insert(idx) {
                continue;
            }
            out.push(candidates[idx].clone());
            if out.len() >= top_k {
                break;
            }
        }
        if out.is_empty() {
            return truncate(candidates, top_k);
        }
        out
    }
}

fn truncate(mut v: Vec<RerankCandidate>, top_k: usize) -> Vec<RerankCandidate> {
    v.truncate(top_k);
    v
}

/// UTF-8-safe byte-budget clip. Backs up to a char boundary, then to
/// the previous whitespace where possible so we don't end mid-word.
fn clip(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut cut = max_bytes;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let head = &s[..cut];
    let trim_to = head
        .rfind(char::is_whitespace)
        .unwrap_or(cut);
    let prefix = head[..trim_to].trim_end();
    format!("{prefix}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(name: &str, content: &str, score: f32) -> RerankCandidate {
        RerankCandidate {
            scope: MemoryScope::Project,
            name: name.into(),
            content: content.into(),
            initial_score: score,
        }
    }

    #[tokio::test]
    async fn identity_reranker_truncates_to_top_k() {
        let cands = vec![
            cand("a", "alpha", 0.9),
            cand("b", "beta", 0.8),
            cand("c", "gamma", 0.7),
        ];
        let r = IdentityReranker;
        let out = r.rerank("anything", cands.clone(), 2).await;
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "a");
        assert_eq!(out[1].name, "b");
    }

    #[tokio::test]
    async fn identity_passthrough_when_under_top_k() {
        let cands = vec![cand("a", "alpha", 0.9)];
        let r = IdentityReranker;
        let out = r.rerank("anything", cands, 5).await;
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn parse_id_list_accepts_number_array() {
        let ids = LlmReranker::parse_id_list("[3, 1, 5]");
        assert_eq!(ids, vec![3, 1, 5]);
    }

    #[test]
    fn parse_id_list_accepts_fenced_array() {
        let ids = LlmReranker::parse_id_list("```json\n[2, 4]\n```");
        assert_eq!(ids, vec![2, 4]);
    }

    #[test]
    fn parse_id_list_accepts_string_ids() {
        // Some smaller models occasionally string-stringify integers.
        let ids = LlmReranker::parse_id_list(r#"["2","4"]"#);
        assert_eq!(ids, vec![2, 4]);
    }

    #[test]
    fn parse_id_list_swallows_garbage() {
        let ids = LlmReranker::parse_id_list("Sorry, I can't.");
        assert!(ids.is_empty());
    }

    #[test]
    fn render_candidates_uses_one_based_ids_and_clips_long_content() {
        let cands = vec![
            cand("short", "concise", 0.9),
            cand(
                "long",
                &"x".repeat(RERANK_EXCERPT_BYTES + 100),
                0.8,
            ),
        ];
        let r = LlmReranker::render_candidates(&cands);
        assert!(r.contains("[1] project/short:"), "got: {r}");
        assert!(r.contains("[2] project/long:"), "got: {r}");
        assert!(r.contains("…"), "long entry should be clipped: {r}");
    }
}
