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

    /// Size of the loaded history window, counted in *conversational*
    /// (`User` + `Assistant`) messages. The window is sized by a
    /// whole-prefix cut on this count, so a flurry of huge `Role::Tool`
    /// results (file extraction, Bash dumps) does NOT consume the budget
    /// and evict the user's earlier goals/files the way a flat
    /// last-N-rows window would. The just-appended user message is
    /// included.
    pub conversation_history_limit: u32,

    /// Compact the thread once a single turn's *input* token count
    /// exceeds this threshold. `None` disables auto-compaction (the
    /// engine still respects `conversation_history_limit` truncation). Set this well
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

    /// Per-turn cap on transparent recovery from
    /// `LlmError::MalformedToolArgs` — the model emitting a tool_use
    /// block whose `arguments` field isn't valid JSON (most often an
    /// unescaped `"` inside a long Chinese MultiEdit / Write payload).
    /// The provider-level non-streaming retry inside
    /// `call_llm_and_prerun` only fixes SSE-concat bugs; when the
    /// model itself emits broken JSON, both streaming and non-streaming
    /// land on the same malformed string. On each strike the engine
    /// persists a synthetic User message describing the parse error
    /// (offset, tool name, escaping rules) and re-runs the turn so the
    /// model gets a chance to self-correct. Set to 0 to disable
    /// (matches pre-recovery behaviour: surface the error immediately).
    /// Default 2 — one retry usually suffices when the feedback names
    /// the offending column; a second is buffer for models that don't
    /// converge on the first try.
    pub malformed_tool_args_max_retries: u8,

    /// Per-turn cap on transparent recovery from
    /// `LlmError::ContentFiltered` — the provider's content-moderation
    /// layer rejecting the request (e.g. DeepSeek "Content Exists Risk").
    /// The flagged content is almost always a *persisted* history message
    /// (a WebSearch/WebFetch tool_result carrying politically sensitive
    /// external text), so replaying the thread re-triggers the filter on
    /// every turn and bricks the thread. On each strike the engine
    /// binary-searches the current window to localize the poison
    /// message(s), marks them redacted (`load_history` then substitutes a
    /// neutral placeholder), and re-runs the turn. Bounds how many
    /// localize-and-redact rounds run before the engine gives up and
    /// surfaces a graceful degraded message. Set to 0 to disable (surface
    /// the error immediately). Default 4 — a round can redact one poison
    /// message, and a thread rarely holds more than a couple.
    pub content_filter_max_retries: u8,

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
    /// wedged loops still die well before `max_iterations`. The
    /// previous default of 3 tripped on benign Read-before-Edit
    /// retries when the model used offset/limit Read first and had to
    /// retry with a full Read.
    pub loop_guard_max_repeats: Option<usize>,

    /// If enabled, a repeated identical tool failure inside one turn
    /// triggers a synthetic User feedback message before the model gets
    /// another chance to continue. This gives the model an explicit
    /// diagnostic nudge ("do not repeat this exact call; inspect the
    /// error and change approach") before the harder loop guard aborts
    /// the turn. Default true.
    pub repeated_tool_failure_feedback: bool,

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

    /// Hard per-tool-result byte ceiling applied at capture time,
    /// *before* the result is persisted. A single tool output (a Bash
    /// command dumping a whole spreadsheet, an error whose message
    /// embeds a multi-MB stdout tail) that exceeds this is truncated to
    /// a head + tail preview with a `[... N bytes truncated ...]` note,
    /// keeping the `tool_use_id` intact. Without this, one oversized
    /// result both blows the model context on load *and* blows the
    /// compaction-summary request (which renders result bodies), leaving
    /// the thread permanently wedged — `history_max_bytes` /
    /// `collapse_*` can't recover it because it sits in the protected
    /// recent tail. Default 200 KiB (~50k tokens) — generous for a
    /// legitimate large read, small enough that no single result can
    /// dominate the window. Set to 0 to disable.
    pub max_tool_result_bytes: usize,

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

    /// Number of times one LLM request may be transparently re-issued
    /// after the provider stream is interrupted mid-response
    /// (`Connection reset by peer`, broken body, idle read timeout,
    /// etc.). This retry happens at the engine layer because any
    /// deltas from the failed stream must be discarded before the new
    /// stream starts. Set to 0 to surface stream interruptions
    /// immediately. Default 2.
    pub stream_interrupted_max_retries: u8,

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

    /// When true, every `MemoryWrite` tool call is staged into
    /// `<project>/memory/pending/` instead of writing to the
    /// memory tree directly. An operator approves with
    /// `snaca-cli memory approve <id>` (or `reject <id>`). Mirrors
    /// hermes's `write_approval` switch — useful for IM/gateway
    /// deployments where a background turn could otherwise plant
    /// entries in `user/` profile space the human owner had no
    /// chance to veto. Default `false`.
    pub memory_write_approval: bool,
}

/// Absolute ceiling on the raw candidate-row pool pulled from the DB
/// before the conversational window is applied. The pool is normally
/// `conversation_history_limit * 4`, but a large (mis)configured limit
/// would otherwise fetch unboundedly many rows on every turn, compaction
/// preview, and memory extraction. Clamp keeps those queries bounded.
pub const MAX_POOL_ROWS: u32 = 2_000;

impl EngineConfig {
    /// Size of the raw candidate-row pool to pull from the DB before
    /// trimming to the conversational window: four times
    /// `conversation_history_limit`, clamped to [`MAX_POOL_ROWS`]. Used by
    /// history load, compaction preview, and memory extraction so they
    /// stay in lockstep.
    pub fn pool_limit(&self) -> u32 {
        self.conversation_history_limit
            .saturating_mul(4)
            .min(MAX_POOL_ROWS)
    }

    pub fn default_for(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            system_prompt: default_system_prompt(),
            max_iterations: 10,
            max_tokens: Some(4096),
            conversation_history_limit: 30,
            compact_after_input_tokens: None,
            compact_keep_recent: 6,
            protect_first_n: 4,
            compact_max_retries: 3,
            malformed_tool_args_max_retries: 2,
            content_filter_max_retries: 4,
            compact_summary_max_tokens: 2048,
            compact_blocking: false,
            loop_guard_max_repeats: Some(5),
            repeated_tool_failure_feedback: true,
            history_max_bytes: 1_500_000,
            turn_timeout_secs: None,
            concurrent_tool_limit: 5,
            collapse_tool_results_threshold: 1024,
            max_tool_result_bytes: 200 * 1024,
            stream_tool_execution: true,
            stream_interrupted_max_retries: 2,
            max_output_token_escalation_attempts: 2,
            max_output_token_ceiling: 32_768,
            memory_write_approval: false,
        }
    }
}

fn default_system_prompt() -> String {
    "You are SNACA — a helpful assistant operating inside an IM channel, \
     with a sandboxed project workspace. Tools available: Read / Grep / \
     Glob / LS to inspect files, Write / Edit / MultiEdit to modify them \
     (path-restricted to the workspace), Bash to run shell commands \
     (relaxed by default — pipes, redirects, and arbitrary commands all \
     work; the operator can opt back into a strict allowlist with \
     SNACA_BASH_RELAXED=0), MemoryRead / MemoryWrite for your durable \
     project memory, SendFile to deliver workspace files back to the user, \
     and Skill to invoke installed skills. Mutating tools may surface an \
     approval card to the user — that's expected, not a refusal. Pick \
     whichever tools fit the task; don't tell the user you're read-only. \
     Uploaded files are staged into your workspace and listed in an \
     <attachments> block on the user's turn. If the user refers to a file \
     that is not staged there and not already in your project memory, ask \
     them to send it rather than assuming or guessing its contents. \
     Be concise and accurate."
        .to_string()
}
