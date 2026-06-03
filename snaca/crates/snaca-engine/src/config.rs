//! Engine configuration knobs.

#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// Default LLM model name. Overridden per-request only if explicitly set.
    pub model: String,

    /// System prompt prepended to every turn.
    pub system_prompt: String,

    /// Maximum number of LLM round trips before [`crate::EngineError::MaxIterationsExceeded`].
    /// Each round trip is one LLM call + (optionally) one batch of tool executions.
    pub max_iterations: usize,

    /// Cap on response tokens (forwarded to provider). `None` = use provider default.
    pub max_tokens: Option<u32>,

    /// How many recent messages to load from the DB when building the
    /// initial prompt. The user message just appended is included.
    pub history_limit: u32,

    /// Compact the thread once a single turn's *input* token count
    /// exceeds this threshold. `None` disables auto-compaction (the
    /// engine still respects `history_limit` truncation). Set this well
    /// below the model's context window — leave headroom for the
    /// system prompt, tool schemas, and the next user turn. Default
    /// `None` keeps M1 behaviour; the server wires a real value (~12k)
    /// in production configs.
    pub compact_after_input_tokens: Option<u32>,

    /// When auto-compaction fires, keep this many of the most recent
    /// messages live (post-summary) so the model still sees verbatim
    /// context for the most recent turn. Below 2 the loop becomes
    /// fragile (model loses the user message it just answered). Default 6.
    pub compact_keep_recent: usize,

    /// When compacting, keep this many of the *oldest* messages
    /// verbatim. Protects the initial system framing + first user
    /// goal + first assistant plan + first tool result — losing those
    /// to a summary tends to strip task definition from long
    /// conversations. Set to 0 to fall back to "pure tail protection"
    /// (legacy behaviour). Default 4.
    pub protect_first_n: usize,

    /// On a `LlmError::ContextOverflow` the engine compacts then
    /// retries the same turn. This caps how many times in one turn
    /// that retry-with-compaction can run. Each retry halves the
    /// effective `compact_keep_recent` (`6 → 3 → 2`) so progressively
    /// more history gets folded into the summary. Default 3.
    pub compact_max_retries: u8,

    /// Hard cap on the summariser's output tokens. The summary is fed
    /// back as a synthetic preamble on every subsequent turn until the
    /// thread compacts again, so a fat summary just trades old-message
    /// tokens for preamble tokens. Too low (≤512) and the summariser
    /// truncates mid-sentence, immediately re-triggering compaction on
    /// the next turn. Default 2048 — comfortable room for a 300–400
    /// word paragraph plus a few short bullet lists, well under the
    /// next turn's compaction threshold for typical configs.
    pub compact_summary_max_tokens: u32,

    /// Whether the engine awaits `maybe_compact_thread` synchronously
    /// before returning from a turn. Default `false` — compaction is
    /// spawned as a fire-and-forget background task (same pattern as
    /// memory extraction) so the user-visible turn returns 1–3 s
    /// earlier. Set to `true` only in tests that need to assert on the
    /// post-compaction state immediately after `handle_turn` returns
    /// without polling.
    pub compact_blocking: bool,

    /// LoopGuard threshold — abort the turn once the model issues the
    /// same `(tool, input)` pair this many times. `None` disables the
    /// guard. Default 5 — high enough to absorb the occasional
    /// legitimate retry (re-Read after a failed Edit; same Grep across
    /// iterations once the model gets new context), low enough that
    /// wedged loops still die well before `max_iterations`. A previous
    /// default of 3 tripped on benign Read-before-Edit retries when the
    /// model used offset/limit Read first and had to retry with a full Read.
    pub loop_guard_max_repeats: Option<usize>,

    /// Hard byte cap on the loaded history's serialised content
    /// before the LLM call. When the loaded history exceeds this,
    /// `load_history` drops the oldest messages until it fits. This
    /// is the last-resort safety net — `compact_after_input_tokens`
    /// is the preferred path, but only fires *after* a successful
    /// turn, so a single huge import (PDF / DOCX with ~MB of
    /// extracted text) can blow the context window before
    /// compaction ever runs. Default 1.5 MiB ≈ 350-400k tokens for
    /// English / mixed CJK.
    pub history_max_bytes: usize,

    /// Wall-clock cap on one turn. `None` = no global timeout
    /// (default — long-running tools and extended-thinking models can
    /// legitimately take many minutes). Set to e.g. `Some(300)` on
    /// untrusted multi-tenant deployments to bound damage from a
    /// runaway turn. When tripped, the engine cancels the per-turn
    /// `CancellationToken` and returns `EngineError::TurnTimeout`.
    pub turn_timeout_secs: Option<u64>,

    /// Max number of read-only tool calls that may execute in
    /// parallel within one batch from a single assistant message.
    /// Write tools always run serially; read-only tools (Read /
    /// Grep / Glob / LS / MemoryRead / TaskOutput) run concurrently
    /// up to this cap. Set to 1 to disable concurrency (everything
    /// goes sequential — useful for debugging tool ordering /
    /// audit-log assumptions). Default 5.
    pub concurrent_tool_limit: usize,

    /// Byte threshold at which old read-only tool_results are
    /// collapsed in the loaded history. A result whose total text
    /// content is ≥ this many bytes gets replaced with a one-line
    /// marker (`<Read foo.rs: 12345 bytes>`) for any message older
    /// than the kept tail. Set to 0 to disable. Default 1024 — large
    /// enough that small file reads stay verbatim, small enough that
    /// a single big Grep doesn't dominate the context. Only applies
    /// to built-in read-only tools (Read / Grep / Glob / LS /
    /// MemoryRead / TaskOutput); writes and MCP/skill tools always
    /// stay verbatim so the model can audit side effects.
    pub collapse_tool_results_threshold: usize,

    /// Pre-execute read-only no-approval tool calls as soon as their
    /// input is fully streamed, in parallel with the rest of the
    /// LLM response. Cached results are consumed by the normal
    /// tool-execution pass after the stream ends, so the user-facing
    /// turn saves the latency of running those tools sequentially
    /// after MessageStop. Default `true`. Set to `false` to fall
    /// back to the original sequential model (useful for debugging
    /// tool-ordering issues or providers whose stream framing
    /// confuses the eager dispatch).
    pub stream_tool_execution: bool,

    /// Number of times one turn may transparently re-issue a request
    /// with a higher output-token cap after `stop_reason == MaxTokens`.
    /// Each attempt doubles the previous cap (subject to
    /// `max_output_token_ceiling`). Escalation only fires when the
    /// truncated response contained no tool_use blocks — a truncated
    /// tool_use would lose its side effect if re-issued, so we let the
    /// normal tool-error path handle it. Default 2 (4096 → 8192 →
    /// 16384). Set to 0 to disable.
    pub max_output_token_escalation_attempts: u32,

    /// Hard ceiling on the post-escalation output cap. Even with
    /// `max_output_token_escalation_attempts` set high, the cap never
    /// exceeds this value. Pick the largest output cap the configured
    /// model actually accepts — Anthropic Sonnet 4.x supports 64k via
    /// extended-output beta, DeepSeek and OpenAI cap lower. Default
    /// 32768 is safe across most providers.
    pub max_output_token_ceiling: u32,

    /// Recall-time confidence floor. After multiplying the cosine
    /// score by the entry's frontmatter `confidence` (defaulting to
    /// 1.0 when absent), hits whose adjusted score falls below this
    /// value are dropped from the `## Relevant Memories` block.
    /// Legacy entries without frontmatter are never subject to this
    /// extra floor. Default 0.30.
    pub recall_confidence_floor: f32,

    /// Fallback confidence applied to extractor proposals that omit
    /// the `confidence` field — conservative so a non-compliant
    /// extractor doesn't get auto-promoted to "trusted". Default 0.6.
    pub extractor_default_confidence: f32,
}

impl EngineConfig {
    pub fn default_for(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            system_prompt: default_system_prompt(),
            max_iterations: 10,
            max_tokens: Some(4096),
            history_limit: 50,
            compact_after_input_tokens: None,
            compact_keep_recent: 6,
            protect_first_n: 4,
            compact_max_retries: 3,
            compact_summary_max_tokens: 2048,
            compact_blocking: false,
            loop_guard_max_repeats: Some(5),
            history_max_bytes: 1_500_000,
            turn_timeout_secs: None,
            concurrent_tool_limit: 5,
            collapse_tool_results_threshold: 1024,
            stream_tool_execution: true,
            max_output_token_escalation_attempts: 2,
            max_output_token_ceiling: 32_768,
            recall_confidence_floor: 0.30,
            extractor_default_confidence: 0.6,
        }
    }
}

fn default_system_prompt() -> String {
    "You are SNACA — a helpful assistant operating inside an IM channel, \
     with a sandboxed project workspace. Tools available: Read / Grep / \
     Glob / LS to inspect files, Write / Edit / MultiEdit to modify them \
     (path-restricted to the workspace), Bash to run shell commands \
     (allowlist by default; relaxed mode if the operator has exported \
     SNACA_BASH_RELAXED=1), MemoryRead / MemoryWrite for your durable \
     project memory, SendFile to deliver workspace files back to the user, \
     and Skill to invoke installed skills. Mutating tools may surface an \
     approval card to the user — that's expected, not a refusal. Pick \
     whichever tools fit the task; don't tell the user you're read-only. \
     Be concise and accurate."
        .to_string()
}
