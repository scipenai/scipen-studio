//! `MemoryExtractor` — proposes memory entries from a turn's transcript.
//!
//! The plan calls for a "background worker" that mines `user/feedback`
//! entries from completed conversations. We model it as a trait so the
//! engine can stay agnostic about how proposals are produced — tests
//! plug in a deterministic stub, production uses an LLM-backed
//! implementation, and the wiring stays the same.
//!
//! ## Lifecycle
//!
//! [`Engine::handle_turn_full`] fires the extractor after every
//! successful terminal turn (tool-only failures and crashed turns are
//! skipped — they're not stable-enough states to mine). The extractor
//! receives the full message slice for the turn and returns a Vec of
//! [`MemoryProposal`]. Each proposal is written to the project memory
//! store on the same task; failures are logged, never propagated.
//!
//! ## Why not just call the LLM inline
//!
//! Two reasons: (1) the engine should remain testable without
//! depending on a real provider — a real LLM client adds setup
//! complexity that's irrelevant to most engine tests; (2) we eventually
//! want background extraction to run on a separate task or scheduler,
//! and a trait gives us a stable seam to swap implementations.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use snaca_core::{ContentBlock, Message, MessageId, ProjectId, Role, TenantId};
use snaca_llm::{LlmClient, MessageRequest};
use snaca_memory::{MemoryScope, MemoryStore};
use snaca_workspace::WorkspaceLayout;
use std::sync::Arc;
use tracing::{debug, warn};

/// One proposal from the extractor. The engine's post-turn hook
/// validates the name (via `MemoryStore::sanitize_name`) and, if
/// valid, writes the entry through `MemoryStore`. `scope` is
/// constrained to `User` or `Feedback` — the only two categories the
/// plan calls out for automatic mining.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryProposal {
    pub scope: MemoryScope,
    pub name: String,
    pub content: String,
}

#[async_trait]
pub trait MemoryExtractor: Send + Sync {
    /// Inspect the turn and return entries to persist. Empty `Vec` =
    /// nothing useful to save (the common case). Implementations should
    /// be idempotent — the engine may call this on overlapping turns
    /// during retries.
    async fn extract(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
        turn_messages: &[Message],
    ) -> Vec<MemoryProposal>;
}

/// Convenience: an extractor that always returns the same canned
/// proposals. Used by tests to verify the engine's post-turn write path
/// without bringing the LLM into the picture.
pub struct ConstantExtractor {
    proposals: Vec<MemoryProposal>,
}

impl ConstantExtractor {
    pub fn new(proposals: Vec<MemoryProposal>) -> Self {
        Self { proposals }
    }
}

#[async_trait]
impl MemoryExtractor for ConstantExtractor {
    async fn extract(
        &self,
        _tenant: &TenantId,
        _project: &ProjectId,
        _turn_messages: &[Message],
    ) -> Vec<MemoryProposal> {
        self.proposals.clone()
    }
}

/// `MemoryExtractor::extract` returns `Vec<MemoryProposal>` directly,
/// so this type alias just keeps the engine's call sites compact.
pub type SharedExtractor = Arc<dyn MemoryExtractor>;

// =====================================================================
// LlmMemoryExtractor — production extractor backed by the engine's LLM.
// =====================================================================

const EXTRACTOR_SYSTEM_PROMPT: &str =
    "You analyse a single conversation turn and propose memory entries to save \
     for future conversations between this user and the assistant.\n\n\
     Output a JSON array, exactly one shape:\n\
     [{\"scope\":\"user|feedback\",\"name\":\"short-slug\",\"content\":\"one sentence\"}]\n\n\
     Rules:\n\
     - ONLY propose if the user EXPLICITLY stated a preference, correction, \
       rule, or fact about themselves to remember.\n\
     - Use scope `feedback` for behaviour corrections (\"stop using emojis\", \
       \"don't apologise\") AND for confirmations of a non-obvious approach \
       (\"yes that was the right call\"). For corrections, include the *why* \
       when the user gave one — it lets future turns judge edge cases.\n\
     - Use scope `user` for personal facts / preferences (\"I work in finance\", \
       \"prefer terse answers\").\n\
     - `name` must match `[a-z0-9_-]+`, max 64 chars, 2-5 words ideally.\n\
     - `content` is one sentence in third person (\"user prefers X\").\n\
     - Convert relative dates to absolute ones (\"Thursday\" → the calendar \
       date) so the memory stays interpretable after time passes.\n\
     - If nothing qualifies, return exactly `[]`.\n\
     - Output ONLY the JSON array, no prose, no markdown fence.\n\n\
     Do NOT propose memories for ANY of the following — they belong in code, \
     git, or the project's own docs, not in long-term memory:\n\
     - Transient task discussion: \"read this file\", \"summarise X\", \
       \"fix that bug\", in-progress work, or the current conversation's state.\n\
     - Code patterns, conventions, architecture, file paths, or project \
       structure — derivable by reading the current repo.\n\
     - Git history, recent changes, or who-changed-what — `git log` / \
       `git blame` are authoritative; a memory snapshot of activity would \
       rot within days.\n\
     - Debugging solutions or fix recipes — the fix lives in the code; the \
       commit message has the rationale. A memory restating \"we fixed X by \
       doing Y\" misleads once the code evolves.\n\
     - Anything already documented in `CLAUDE.md` or the project's own \
       README / docs — those files are loaded into context separately.\n\
     - Anything the user only mentioned in passing without endorsing as a \
       rule (one example does not establish a preference).\n\
     - PII: emails, phone numbers, API keys, access tokens. A downstream \
       filter rejects these too, but propose them and you've already leaked.\n\n\
     These exclusions hold even when the user explicitly asks you to save. \
     If the user says \"save this PR list\" or \"remember this activity log\", \
     return `[]` — the right move is to ask what was *surprising* or \
     *non-obvious* about it, which is the part worth keeping. The current \
     extractor cannot ask, so it returns nothing.";

/// LLM-backed extractor. Builds a small structured-output prompt from
/// the turn's transcript, calls the LLM once, parses the JSON reply
/// into [`MemoryProposal`]s. Robust to bad output: parse failures or
/// schema violations are logged and produce an empty result rather
/// than blowing up.
///
/// Names are validated against `MemoryStore::sanitize_name` so a
/// hallucinated slug never lands on disk; mismatched scopes are
/// silently dropped (the engine's post-turn hook already filters to
/// `User`/`Feedback`, but rejecting up-front gives clearer logs).
pub struct LlmMemoryExtractor {
    llm: Arc<dyn LlmClient>,
    /// Model to use for the extraction call. Often the same as the
    /// engine's main model, but operators may want to point this at a
    /// cheaper / faster one.
    model: String,
    /// Hard cap on returned proposals — defends against runaway LLM
    /// outputs and stops one turn from flooding the memory tree.
    max_proposals: usize,
    /// Optional workspace handle. When attached, the extractor scans
    /// the project's memory tree before each call and pre-injects the
    /// existing entry names into the prompt so the LLM doesn't propose
    /// duplicates. None falls back to the bare-prompt behaviour.
    workspace: Option<WorkspaceLayout>,
}

impl LlmMemoryExtractor {
    pub fn new(llm: Arc<dyn LlmClient>, model: impl Into<String>) -> Self {
        Self {
            llm,
            model: model.into(),
            max_proposals: 5,
            workspace: None,
        }
    }

    pub fn with_max_proposals(mut self, max: usize) -> Self {
        self.max_proposals = max;
        self
    }

    /// Attach a workspace handle so the extractor can scan existing
    /// memory entries and pre-inject them into the prompt. Without
    /// this the LLM tends to re-propose the same `terse-output` /
    /// `no-emojis` memories on every turn, padding the index over
    /// time.
    pub fn with_workspace(mut self, workspace: WorkspaceLayout) -> Self {
        self.workspace = Some(workspace);
        self
    }

    /// Render a short "existing memories" manifest for the prompt.
    /// Names only — no content — to keep the token cost flat as a
    /// project accumulates entries. Returns empty string when no
    /// workspace is attached or the project's memory tree is empty.
    async fn render_existing_manifest(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
    ) -> String {
        let Some(workspace) = self.workspace.as_ref() else {
            return String::new();
        };
        let store = MemoryStore::new(workspace.memory_dir(tenant, project));
        let entries = match store.list_all().await {
            Ok(e) => e,
            Err(e) => {
                debug!(
                    error = %e,
                    "extractor: list_all failed; proceeding without manifest"
                );
                return String::new();
            }
        };
        if entries.is_empty() {
            return String::new();
        }
        let mut by_scope: std::collections::BTreeMap<MemoryScope, Vec<String>> =
            std::collections::BTreeMap::new();
        for (scope, name) in entries {
            by_scope.entry(scope).or_default().push(name);
        }
        let mut out = String::from(
            "Existing memories in this project (do NOT propose names that \
             collide with these; a different angle on the same topic should \
             use a different name):\n",
        );
        for (scope, names) in &by_scope {
            out.push_str(&format!("\n[{}] ({} entries)\n", scope.as_str(), names.len()));
            for name in names {
                out.push_str(&format!("  - {name}\n"));
            }
        }
        out.push('\n');
        out
    }

    fn render_transcript(messages: &[Message]) -> String {
        let mut out = String::new();
        for m in messages {
            let label = match m.role {
                Role::User => "USER",
                Role::Assistant => "ASSISTANT",
                Role::Tool => "TOOL",
                Role::System => "SYSTEM",
            };
            for block in &m.content {
                // Tool-use / tool-result blocks aren't useful to the
                // extractor — they're internal scaffolding, not the
                // user-visible exchange that drives memory. Drop them
                // by only matching the text variant.
                #[allow(clippy::single_match)]
                match block {
                    ContentBlock::Text { text } => {
                        out.push_str(label);
                        out.push_str(": ");
                        out.push_str(text);
                        out.push('\n');
                    }
                    _ => {}
                }
            }
        }
        out
    }

    fn parse_proposals(raw: &str) -> Vec<MemoryProposal> {
        // The model occasionally wraps JSON in a fenced block despite
        // instructions to skip it. Strip a single leading/trailing
        // ```json fence pair if present.
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

        match serde_json::from_str::<Vec<MemoryProposal>>(stripped) {
            Ok(v) => v,
            Err(e) => {
                warn!(
                    error = %e,
                    raw_len = raw.len(),
                    "memory extractor: LLM did not return valid JSON; ignoring"
                );
                Vec::new()
            }
        }
    }
}

#[async_trait]
impl MemoryExtractor for LlmMemoryExtractor {
    async fn extract(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
        turn_messages: &[Message],
    ) -> Vec<MemoryProposal> {
        let transcript = Self::render_transcript(turn_messages);
        if transcript.trim().is_empty() {
            return Vec::new();
        }
        // Pre-inject what's already saved so the model doesn't re-propose
        // duplicates. Empty when no workspace is wired or the tree is
        // empty — first turn on a fresh project skips this entirely.
        let manifest = self.render_existing_manifest(tenant, project).await;
        let user_msg = Message {
            id: MessageId::new(),
            role: Role::User,
            content: vec![ContentBlock::text(format!(
                "{manifest}Conversation transcript:\n\n{transcript}"
            ))],
            created_at: chrono::Utc::now(),
        };
        let req = MessageRequest::new(&self.model)
            .with_system(EXTRACTOR_SYSTEM_PROMPT)
            .with_messages(vec![user_msg])
            .with_tools(Vec::new())
            .with_max_tokens(512);
        let resp = match self.llm.create_message(req).await {
            Ok(r) => r,
            Err(e) => {
                warn!(error = %e, "memory extractor LLM call failed");
                return Vec::new();
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
        let mut out = Self::parse_proposals(&text);

        // Validate names + scopes locally. Drop the bad entries with a
        // warning; the rest pass through.
        out.retain(|p| match snaca_memory::sanitize_name(&p.name) {
            Ok(canonical) if canonical == p.name => {
                if matches!(p.scope, MemoryScope::User | MemoryScope::Feedback) {
                    true
                } else {
                    debug!(
                        scope = %p.scope,
                        name = p.name.as_str(),
                        "extractor proposal rejected: scope outside user/feedback"
                    );
                    false
                }
            }
            Ok(_) => {
                debug!(name = p.name.as_str(), "extractor proposal name not canonical; rejecting");
                false
            }
            Err(e) => {
                debug!(name = p.name.as_str(), error = %e, "extractor proposal name invalid; rejecting");
                false
            }
        });

        if out.len() > self.max_proposals {
            debug!(
                kept = self.max_proposals,
                dropped = out.len() - self.max_proposals,
                "extractor truncated to max_proposals"
            );
            out.truncate(self.max_proposals);
        }
        out
    }
}

// =====================================================================
// SensitiveFilter — regex-based PII guard.
// =====================================================================

/// Pattern that, when present, should keep a memory proposal out of
/// the store. Matches are deliberately loose — false positives are far
/// less costly than persisting a leaked secret.
struct SensitivePattern {
    name: &'static str,
    re: regex::Regex,
}

/// Block proposals whose `content` contains email addresses, phone
/// numbers, or common API key shapes. The defaults are intentionally
/// conservative — operators with looser tolerance can construct an
/// empty filter or layer custom patterns.
pub struct SensitiveFilter {
    patterns: Vec<SensitivePattern>,
}

impl SensitiveFilter {
    /// Build the default filter: emails, phone numbers, AWS / OpenAI /
    /// generic key prefixes. Compiled once; cheap to clone.
    pub fn default_set() -> Self {
        let raw: &[(&'static str, &str)] = &[
            // Email — lower bar, just look for `something@something.tld`.
            ("email", r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"),
            // Phone — 10+ digit runs, optional separators. Loose; will
            // match dates / orders too. Acceptable false-positive cost.
            ("phone", r"\b\d{3}[-. ]?\d{3,4}[-. ]?\d{3,4}\b"),
            // OpenAI keys + Anthropic keys + AWS access key ids.
            ("api_key_openai", r"\bsk-[A-Za-z0-9_-]{20,}"),
            ("api_key_anthropic", r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
            ("api_key_aws", r"\bAKIA[0-9A-Z]{16}\b"),
            // Bearer tokens (loose) — long base64-like alphanumeric runs
            // following common header words.
            ("bearer_token", r"(?i)\bbearer\s+[A-Za-z0-9._-]{20,}"),
        ];
        let patterns = raw
            .iter()
            .map(|(name, re)| SensitivePattern {
                name,
                re: regex::Regex::new(re)
                    .unwrap_or_else(|e| panic!("internal: bad PII regex {name}: {e}")),
            })
            .collect();
        Self { patterns }
    }

    /// Empty filter — accepts every proposal. Useful for tests where
    /// we don't want PII rejection in the way, and for operators who
    /// are filtering elsewhere in the pipeline.
    pub fn empty() -> Self {
        Self { patterns: Vec::new() }
    }

    /// True if `text` contains any pattern this filter rejects. The
    /// matched pattern's name is returned for logging.
    pub fn first_match<'a>(&'a self, text: &str) -> Option<&'a str> {
        for p in &self.patterns {
            if p.re.is_match(text) {
                return Some(p.name);
            }
        }
        None
    }
}

impl Default for SensitiveFilter {
    fn default() -> Self {
        Self::default_set()
    }
}

// =====================================================================
// FilteredMemoryExtractor — decorator that drops unsafe proposals.
// =====================================================================

/// Wraps any [`MemoryExtractor`] and runs each proposal's `content`
/// through a [`SensitiveFilter`] before letting it through. Decorator
/// pattern keeps the LLM extractor naive about policy and lets
/// operators stack filters (multiple wraps, or different filter sets
/// per environment).
pub struct FilteredMemoryExtractor {
    inner: SharedExtractor,
    filter: Arc<SensitiveFilter>,
}

impl FilteredMemoryExtractor {
    pub fn new(inner: SharedExtractor, filter: SensitiveFilter) -> Self {
        Self {
            inner,
            filter: Arc::new(filter),
        }
    }
}

#[async_trait]
impl MemoryExtractor for FilteredMemoryExtractor {
    async fn extract(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
        turn_messages: &[Message],
    ) -> Vec<MemoryProposal> {
        let proposals = self.inner.extract(tenant, project, turn_messages).await;
        let filter = self.filter.clone();
        proposals
            .into_iter()
            .filter(|p| match filter.first_match(&p.content) {
                None => true,
                Some(matched) => {
                    warn!(
                        scope = %p.scope,
                        name = p.name.as_str(),
                        pattern = matched,
                        "memory proposal rejected: PII pattern in content"
                    );
                    false
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ContentBlock, MessageId, Role};
    use chrono::Utc;

    fn user_msg(text: &str) -> Message {
        Message {
            id: MessageId::new(),
            role: Role::User,
            content: vec![ContentBlock::text(text)],
            created_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn constant_extractor_returns_canned_proposals() {
        let canned = vec![MemoryProposal {
            scope: MemoryScope::Feedback,
            name: "no-emojis".into(),
            content: "user said: stop using emojis".into(),
        }];
        let e = ConstantExtractor::new(canned.clone());
        let out = e
            .extract(
                &TenantId::new("t"),
                &ProjectId::from_raw("p"),
                &[user_msg("stop using emojis")],
            )
            .await;
        assert_eq!(out, canned);
    }

    #[tokio::test]
    async fn empty_canned_returns_empty() {
        let e = ConstantExtractor::new(Vec::new());
        let out = e
            .extract(
                &TenantId::new("t"),
                &ProjectId::from_raw("p"),
                &[user_msg("hello")],
            )
            .await;
        assert!(out.is_empty());
    }

    #[test]
    fn parse_proposals_accepts_plain_json_array() {
        let raw = r#"[
            {"scope": "feedback", "name": "no-emojis", "content": "user said: stop using emojis"}
        ]"#;
        let out = LlmMemoryExtractor::parse_proposals(raw);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].scope, MemoryScope::Feedback);
        assert_eq!(out[0].name, "no-emojis");
    }

    #[test]
    fn parse_proposals_strips_markdown_fence() {
        let raw = "```json\n[{\"scope\":\"user\",\"name\":\"x\",\"content\":\"y\"}]\n```";
        let out = LlmMemoryExtractor::parse_proposals(raw);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].scope, MemoryScope::User);
    }

    #[test]
    fn parse_proposals_swallows_garbage() {
        let raw = "I'm sorry, I can't comply with that request.";
        let out = LlmMemoryExtractor::parse_proposals(raw);
        assert!(out.is_empty(), "garbage should yield empty Vec, got: {out:?}");
    }

    #[test]
    fn render_transcript_drops_tool_blocks() {
        use chrono::Utc;
        let messages = vec![
            Message {
                id: MessageId::new(),
                role: Role::User,
                content: vec![ContentBlock::text("stop using emojis")],
                created_at: Utc::now(),
            },
            Message {
                id: MessageId::new(),
                role: Role::Assistant,
                content: vec![ContentBlock::tool_use(
                    "tu1",
                    "Read",
                    serde_json::json!({"path": "x"}),
                )],
                created_at: Utc::now(),
            },
            Message {
                id: MessageId::new(),
                role: Role::Assistant,
                content: vec![ContentBlock::text("noted")],
                created_at: Utc::now(),
            },
        ];
        let out = LlmMemoryExtractor::render_transcript(&messages);
        assert!(out.contains("USER: stop using emojis"));
        assert!(out.contains("ASSISTANT: noted"));
        // Tool-use block has no Text variant — dropped from transcript.
        assert!(!out.contains("Read"));
    }

    #[test]
    fn sensitive_filter_blocks_email() {
        let f = SensitiveFilter::default_set();
        assert!(f.first_match("contact me at alice@example.com").is_some());
    }

    #[test]
    fn sensitive_filter_blocks_openai_key() {
        let f = SensitiveFilter::default_set();
        assert!(f
            .first_match("sk-1234567890abcdefghijklmnop")
            .is_some());
    }

    #[test]
    fn sensitive_filter_blocks_aws_key() {
        let f = SensitiveFilter::default_set();
        assert!(f.first_match("key=AKIAIOSFODNN7EXAMPLE").is_some());
    }

    #[test]
    fn sensitive_filter_lets_clean_content_through() {
        let f = SensitiveFilter::default_set();
        assert!(f.first_match("user prefers terse responses").is_none());
        assert!(f
            .first_match("project uses kebab-case file names")
            .is_none());
    }

    #[test]
    fn empty_filter_accepts_anything() {
        let f = SensitiveFilter::empty();
        assert!(f.first_match("alice@example.com").is_none());
    }

    #[tokio::test]
    async fn filtered_extractor_drops_proposals_with_pii() {
        let canned = vec![
            MemoryProposal {
                scope: MemoryScope::User,
                name: "contact".into(),
                content: "user's email is alice@example.com".into(),
            },
            MemoryProposal {
                scope: MemoryScope::User,
                name: "tone".into(),
                content: "user prefers terse answers".into(),
            },
        ];
        let inner = Arc::new(ConstantExtractor::new(canned));
        let filtered = FilteredMemoryExtractor::new(inner, SensitiveFilter::default_set());
        let out = filtered
            .extract(
                &TenantId::new("t"),
                &ProjectId::from_raw("p"),
                &[user_msg("anything")],
            )
            .await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "tone");
    }

    #[tokio::test]
    async fn filtered_extractor_with_empty_filter_is_passthrough() {
        let canned = vec![MemoryProposal {
            scope: MemoryScope::User,
            name: "contact".into(),
            content: "user's email is alice@example.com".into(),
        }];
        let inner = Arc::new(ConstantExtractor::new(canned));
        let filtered = FilteredMemoryExtractor::new(inner, SensitiveFilter::empty());
        let out = filtered
            .extract(
                &TenantId::new("t"),
                &ProjectId::from_raw("p"),
                &[user_msg("anything")],
            )
            .await;
        assert_eq!(out.len(), 1);
    }
}
