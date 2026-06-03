//! Engine — turn loop implementation.
//!
//! ## Loop shape (M1)
//!
//! ```text
//! 1. ensure thread row exists in DB
//! 2. ensure project workspace exists
//! 3. append user Message(role=User) to DB
//! 4. iter = 0
//! 5. loop:
//!      a. iter += 1; if iter > max_iterations: error
//!      b. load recent history; build LLM request (system + history + tools)
//!      c. resp = llm.create_message(request)
//!      d. append resp.message (role=Assistant) to DB
//!      e. if resp.stop_reason terminal: collect text, return TurnOutcome
//!      f. for each ToolUse block:
//!           - record_tool_start(id, name, input)
//!           - tool.execute(input, ctx)  -> ToolOutput | ToolError
//!           - record_tool_completion(id, output, is_error)
//!           - build ContentBlock::ToolResult or ContentBlock::tool_error
//!      g. append Message(role=Tool, content=tool_results) to DB
//! ```

use crate::approval::{ApprovalDecision, ApprovalGate, ApprovalRequest, NoopApprovalGate};
use crate::config::EngineConfig;
use crate::error::{EngineError, EngineResult};
use crate::listener::{NoopListener, TurnEventListener};
use crate::loop_guard::{LoopGuard, LoopGuardConfig};
use crate::tools_factory::RuntimeToolFactory;
use chrono::Utc;
use futures::StreamExt;
use serde_json::{json, Value};
use snaca_core::{
    ContentBlock, Message, MessageId, ProjectId, Role, SessionId, TenantId, ThreadId, ToolUseId,
    Usage,
};
use snaca_llm::{
    ContentBlockStart, ContentDelta, LlmClient, LlmError, MessageRequest, MessageResponse,
    StopReason, StreamAccumulator, StreamEvent, SystemSegment, ToolSchema,
};
use snaca_state::{Database, NewMessage, NewThread, PersistedDecision};
use snaca_tools_api::{
    ApprovalRequirement, ContextRequester, OutboundFile, Tool, ToolContext, ToolError, ToolOutput,
    ToolRegistry, ToolResult,
};
use snaca_workspace::WorkspaceLayout;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

#[derive(Debug, Clone)]
pub struct TurnRequest {
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    pub thread_id: ThreadId,
    pub user_text: String,
    /// IM-side message id that triggered this turn. The engine uses
    /// it as the inner key of the inflight map so a `MessageRecalled`
    /// event can target the exact turn rather than aborting whatever
    /// is currently running on the thread. `None` lets the engine
    /// generate a UUID — external recall can't reach UUID-keyed
    /// turns, only admin's thread-level abort.
    pub message_id: Option<String>,
    /// Per-turn ephemeral system context, appended to the freshly
    /// composed `system_prompt` for this turn only. Never persisted to
    /// thread history and never surfaced in the user-visible message
    /// log — it is recomputed and discarded every turn. Front-ends use
    /// it to inject volatile ambient state (the editor's active file /
    /// selection, an IM channel's current roster, …); `None` keeps the
    /// turn identical to having no extra context.
    pub ephemeral_system: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TurnOutcome {
    pub session_id: SessionId,
    /// Plain-text portion of the final assistant message (concatenated text
    /// blocks). Empty if the model returned tool calls only or was silent.
    pub assistant_text: String,
    /// LLM round trips actually performed (including the terminal one).
    pub iterations: usize,
    /// Aggregated `Usage` across all round trips in the turn.
    pub usage: Usage,
    /// Files queued by tools (e.g. `SendFile`) during the turn for
    /// delivery back through the IM channel. Empty when no tool
    /// queued anything; the dispatcher walks this list and calls
    /// `plugin.file_upload` per entry.
    pub outbound_files: Vec<OutboundFile>,
}

#[derive(Clone)]
pub struct Engine {
    llm: Arc<dyn LlmClient>,
    tools: ToolRegistry,
    /// Optional per-(tenant, project) factory. When set, takes precedence
    /// over `tools` and is consulted at the start of every turn so the
    /// LLM sees a registry tailored to the request's tenant + project.
    tool_factory: Option<Arc<dyn RuntimeToolFactory>>,
    state: Database,
    workspace: WorkspaceLayout,
    config: EngineConfig,
    /// Optional embedder. When attached, the engine runs vector recall
    /// against the project's memory store at turn start and splices the
    /// top-k matches into the system prompt under a `## Relevant
    /// Memories` heading. None disables retrieval; the rest of the turn
    /// loop is unchanged.
    embedder: Option<Arc<dyn snaca_memory::Embedder>>,
    /// Optional memory extractor. When attached, the engine fires it
    /// on a background task after every successful turn; proposals are
    /// written through the project's `MemoryStore`. None disables
    /// extraction.
    extractor: Option<crate::memory_extractor::SharedExtractor>,
    /// Optional retrieval reranker. When attached, the engine pulls
    /// `RECALL_POOL_SIZE` cosine candidates and asks the reranker to
    /// pick the top `RECALL_TOP_K`. None falls back to a simple
    /// truncation of the cosine top-k — same behaviour as M3 chunk 2.
    reranker: Option<crate::reranker::SharedReranker>,
    /// Optional sink notified whenever the background memory_extractor
    /// successfully writes a memory entry. The editor crate wires this
    /// to the JSON-RPC `memory.updated` notification so MemoryViewer
    /// refreshes live. None disables broadcasting; the write still
    /// happens.
    memory_sink: Option<crate::memory_sink::SharedMemorySink>,
    /// Optional background-task registry. When attached, Bash's
    /// `run_in_background = true` path can spawn long-lived tasks
    /// whose status is polled via the TaskOutput tool. Held as an
    /// opaque Arc so the engine doesn't need to know the concrete
    /// type (it lives in `snaca-tools`).
    task_registry: Option<Arc<dyn std::any::Any + Send + Sync>>,
    /// Per-turn factory for reverse-RPC channels back to the editor host.
    /// The wiring layer (snaca-editor) supplies a closure that takes
    /// the current `turn_id` and returns an `Arc<dyn ContextRequester>`
    /// scoped to that turn. None → host-context tools (zotero_*)
    /// surface a clear "unavailable" error.
    ///
    /// Why per-turn rather than static: the requester captures
    /// `turn_id` for host-side telemetry; a static instance would
    /// either drop that signal or require interior mutability.
    context_requester_factory: Option<ContextRequesterFactory>,
    /// Per-(thread, message) cancellation tokens for in-flight turns.
    /// The engine registers a token when `handle_turn_full` enters
    /// and removes it on exit (via `InflightGuard`); external
    /// callers fire it via `abort_turn` (message-precise) or
    /// `abort_thread` (sweep all turns on the thread).
    ///
    /// The inner String is the IM-side message id that triggered the
    /// turn — kept as a String rather than `MessageId` newtype so
    /// the key matches the wire value plugins emit through
    /// `MessageRecalledParams.message_id` (no parse step). Empty
    /// IM ids get a UUID fallback during turn entry; the value
    /// stored here is always non-empty.
    inflight: Arc<Mutex<HashMap<(ThreadId, String), CancellationToken>>>,
    /// Per-thread ring of memories already surfaced through the recall
    /// block in earlier turns. Retrieval filters these out before
    /// picking the top-K so a long IM conversation doesn't re-splice
    /// the same entries every turn — by then the model has already
    /// seen them in prior context and re-listing just burns tokens.
    /// Bounded at `SURFACED_RING_CAP` per thread; old entries roll out
    /// and become eligible for resurfacing. In-memory only — process
    /// restart resets dedup state, which is acceptable since recall
    /// itself is also stateless across restarts.
    surfaced_memories: SurfacedMemoryMap,
}

/// Closure that builds a per-turn reverse-RPC channel back to the
/// editor host. Engine calls this once at the start of every turn that
/// has tools attached; the returned requester is dropped when the turn
/// ends. Stored as `Arc<dyn Fn>` so the engine can clone the factory
/// across spawned tasks without `H: Clone`.
pub type ContextRequesterFactory = Arc<dyn Fn(String) -> Arc<dyn ContextRequester> + Send + Sync>;

/// One entry on the surfaced-memories dedup ring — the `(scope, name)`
/// pair that uniquely identifies a memory file in a project.
type SurfacedKey = (snaca_memory::MemoryScope, String);
/// Per-thread ring buffer of `SurfacedKey`s. Backed by `VecDeque` so
/// eviction at the front is O(1) when we roll past `SURFACED_RING_CAP`.
type SurfacedRing = VecDeque<SurfacedKey>;
/// Shared map of `ThreadId -> SurfacedRing`. Wrapped in
/// `Arc<Mutex<…>>` because both turn entry and retrieval read from /
/// write to it across awaits.
type SurfacedMemoryMap = Arc<Mutex<HashMap<ThreadId, SurfacedRing>>>;

/// RAII guard that removes a turn's cancellation token from the
/// inflight map on drop, even if the turn panics or returns early.
/// Held only on the stack within `handle_turn_full`; never escapes.
struct InflightGuard {
    map: Arc<Mutex<HashMap<(ThreadId, String), CancellationToken>>>,
    key: (ThreadId, String),
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        if let Ok(mut m) = self.map.lock() {
            m.remove(&self.key);
        }
    }
}

impl Engine {
    pub fn new(
        llm: Arc<dyn LlmClient>,
        tools: ToolRegistry,
        state: Database,
        workspace: WorkspaceLayout,
        config: EngineConfig,
    ) -> Self {
        Self {
            llm,
            tools,
            tool_factory: None,
            state,
            workspace,
            config,
            embedder: None,
            extractor: None,
            reranker: None,
            memory_sink: None,
            task_registry: None,
            context_requester_factory: None,
            inflight: Arc::new(Mutex::new(HashMap::new())),
            surfaced_memories: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Abort every in-flight turn on `thread_id`. Returns the number
    /// of turns that were cancelled. Admin path (HTTP
    /// `POST /admin/threads/:id/abort`) uses this — the caller wants
    /// "stop whatever is happening on this thread" without naming
    /// individual messages. Idempotent: a second call after all
    /// guards have removed their entries returns 0.
    pub fn abort_thread(&self, thread_id: &ThreadId) -> usize {
        let Ok(map) = self.inflight.lock() else {
            return 0;
        };
        let mut count = 0;
        for ((tid, _), token) in map.iter() {
            if tid == thread_id {
                token.cancel();
                count += 1;
            }
        }
        count
    }

    /// Abort the in-flight turn keyed by `(thread_id, message_id)`.
    /// Returns true if a matching turn was found and cancelled,
    /// false otherwise. Used by the IM recall path — recalling a
    /// specific user message aborts only the turn that message
    /// triggered, leaving other turns on the same thread (a later
    /// message from the same user, a different user's message in a
    /// group chat) intact.
    pub fn abort_turn(&self, thread_id: &ThreadId, message_id: &str) -> bool {
        let Ok(map) = self.inflight.lock() else {
            return false;
        };
        if let Some(token) = map.get(&(thread_id.clone(), message_id.to_string())) {
            token.cancel();
            true
        } else {
            false
        }
    }

    /// Attach a background-task registry. Required for `Bash`'s
    /// `run_in_background` mode and the companion TaskOutput /
    /// TaskStop tools; without it those tools refuse with a clear
    /// error message. The engine doesn't depend on the concrete type
    /// — pass `Arc<snaca_tools::TaskRegistry>` cast to `Arc<dyn Any +
    /// Send + Sync>` from the wiring layer.
    pub fn with_task_registry(mut self, registry: Arc<dyn std::any::Any + Send + Sync>) -> Self {
        self.task_registry = Some(registry);
        self
    }

    /// Attach a per-turn factory for reverse-RPC channels. The wiring
    /// layer supplies a closure that takes the current `turn_id` and
    /// returns an `Arc<dyn ContextRequester>`. Engine calls it once at
    /// turn entry and drops the result when the turn ends.
    pub fn with_context_requester_factory(mut self, factory: ContextRequesterFactory) -> Self {
        self.context_requester_factory = Some(factory);
        self
    }

    /// Attach a runtime tool factory. The engine will call
    /// `factory.build(tenant, project)` once at the start of every turn
    /// and use the returned registry instead of the static one passed to
    /// `Engine::new`.
    pub fn with_tool_factory(mut self, factory: Arc<dyn RuntimeToolFactory>) -> Self {
        self.tool_factory = Some(factory);
        self
    }

    /// Attach an embedder. With one in place, every turn embeds the
    /// user's text and looks up the top-k closest memory entries; their
    /// excerpts get spliced into the system prompt before the LLM call.
    /// Without one (the default), only the static `MEMORY.md` index is
    /// injected — the same as M3's first chunk.
    pub fn with_embedder(mut self, embedder: Arc<dyn snaca_memory::Embedder>) -> Self {
        self.embedder = Some(embedder);
        self
    }

    /// Import an attachment's bytes into the project. Two side effects:
    ///
    /// 1. **Workspace drop**: bytes land at
    ///    `<workspace>/<basename(filename)>` so the `Read` / `Glob` /
    ///    `Bash` tools can open the file by name. This matches user
    ///    expectations — "I uploaded `spec.pdf`, you should be able to
    ///    read spec.pdf".
    /// 2. **Memory import**: bytes also go through the standard bulk-
    ///    import pipeline (extract → chunk → embed → store). Useful
    ///    when the file is large enough that a future turn would
    ///    benefit from vector recall over its content.
    ///
    /// Filename is sanitised to its basename — directory components
    /// are stripped before either side-effect runs, defending against
    /// a malicious / buggy plugin sending `../escape.txt`.
    ///
    /// Falls back to `HashEmbedder` when no production embedder is
    /// configured — imports always produce embeddings, but they only
    /// surface in retrieval if the engine has its own embedder
    /// configured (so vector spaces match). With matching embedders,
    /// imported attachments become retrievable on the next turn.
    pub async fn import_attachment(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
        bytes: Vec<u8>,
        filename: String,
    ) -> Result<snaca_memory::ImportReport, snaca_memory::MemoryError> {
        // Workspace dir must exist before the memory tree under it.
        // `WorkspaceError` doesn't auto-convert into `MemoryError`;
        // map to its IO arm with the path/reason flattened in.
        self.workspace
            .ensure_project(tenant, project)
            .map_err(|e| {
                snaca_memory::MemoryError::Io(std::io::Error::other(format!(
                    "ensure_project failed: {e}"
                )))
            })?;

        // Side effect 1: workspace drop. Strip any path components
        // from the filename — only the basename lands in the
        // workspace dir. Empty / dot-only names get a fallback so we
        // don't try to write `<workspace>/`.
        let basename = std::path::Path::new(&filename)
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty() && *s != "." && *s != "..")
            .unwrap_or("attachment.bin");
        let workspace_dir = self.workspace.workspace_dir(tenant, project);
        let target = workspace_dir.join(basename);
        if let Err(e) = tokio::fs::write(&target, &bytes).await {
            warn!(
                error = %e,
                path = %target.display(),
                "attachment workspace drop failed; continuing with memory import only"
            );
        } else {
            debug!(
                path = %target.display(),
                bytes = bytes.len(),
                "attachment dropped into workspace"
            );
        }

        let memory_dir = self.workspace.memory_dir(tenant, project);
        let store = snaca_memory::MemoryStore::new(memory_dir);
        let embedder: std::sync::Arc<dyn snaca_memory::Embedder> = match self.embedder.clone() {
            Some(e) => e,
            None => std::sync::Arc::new(snaca_memory::HashEmbedder::default()),
        };
        let indexed = snaca_memory::IndexedMemoryStore::new(
            store,
            self.state.clone(),
            embedder,
            tenant.clone(),
            project.clone(),
        );
        snaca_memory::import_one(
            &indexed,
            snaca_memory::ImportSource {
                bytes,
                filename,
                kind: None,
            },
            &snaca_memory::ImportConfig::default(),
        )
        .await
    }

    /// Attach a memory extractor. With one in place, every successful
    /// terminal turn fires `extractor.extract(...)` on a background
    /// task; proposals are written through the project's
    /// `MemoryStore`. None disables extraction.
    pub fn with_memory_extractor(
        mut self,
        extractor: crate::memory_extractor::SharedExtractor,
    ) -> Self {
        self.extractor = Some(extractor);
        self
    }

    /// Attach a retrieval reranker. With one in place, the engine
    /// pulls `RECALL_POOL_SIZE` cosine candidates and asks the
    /// reranker to pick the top `RECALL_TOP_K`. Without one, the
    /// engine truncates the cosine top-k itself.
    pub fn with_reranker(mut self, reranker: crate::reranker::SharedReranker) -> Self {
        self.reranker = Some(reranker);
        self
    }

    /// Attach a memory-event sink. Called best-effort after every
    /// successful extractor write so the host can refresh its view
    /// without polling.
    pub fn with_memory_sink(mut self, sink: crate::memory_sink::SharedMemorySink) -> Self {
        self.memory_sink = Some(sink);
        self
    }

    async fn runtime_tools(&self, tenant: &TenantId, project: &ProjectId) -> ToolRegistry {
        match &self.tool_factory {
            Some(f) => f.build(tenant, project).await,
            None => self.tools.clone(),
        }
    }

    /// Run a single turn with the default `NoopApprovalGate` — every tool
    /// call is approved automatically. Useful for tests and for
    /// deployments that have already gated tool selection upstream.
    pub async fn handle_turn(&self, req: TurnRequest) -> EngineResult<TurnOutcome> {
        self.handle_turn_with_gate(req, Arc::new(NoopApprovalGate))
            .await
    }

    /// Run a single turn, consulting `gate` before executing any tool whose
    /// `ApprovalRequirement` is `Always` or `UnlessRemembered` (and no
    /// remembered decision is on file).
    ///
    /// Decisions:
    /// - `Allow` → tool runs, decision not persisted (subsequent calls re-ask).
    /// - `AllowAlways` → tool runs, `(tenant, project, tool)` row written so
    ///   future invocations of the same tool skip the gate.
    /// - `Deny` → tool returns a `ToolResult { is_error: true }` with
    ///   "permission denied" so the LLM can adapt without crashing the turn.
    pub async fn handle_turn_with_gate(
        &self,
        req: TurnRequest,
        gate: Arc<dyn ApprovalGate>,
    ) -> EngineResult<TurnOutcome> {
        self.handle_turn_full(req, gate, Arc::new(NoopListener))
            .await
    }

    /// Run a single turn with both an approval gate and a per-event
    /// listener. The listener observes every [`snaca_llm::StreamEvent`]
    /// produced by the LLM round trips inside this turn — used by IM
    /// channels to render typing indicators / `update_message` deltas
    /// while the turn is still in flight.
    pub async fn handle_turn_full(
        &self,
        req: TurnRequest,
        gate: Arc<dyn ApprovalGate>,
        listener: Arc<dyn TurnEventListener>,
    ) -> EngineResult<TurnOutcome> {
        let TurnRequest {
            tenant_id,
            project_id,
            thread_id,
            user_text,
            message_id,
            ephemeral_system,
        } = req;

        // IM message id is the inner inflight key — recall path looks
        // up turns by `(thread_id, message_id)` so a specific message
        // can be aborted without disturbing siblings. Plugins that
        // don't emit a message id (mock, simple test plugins) get a
        // UUID fallback; admin's thread-level abort still reaches
        // these, message-precise recall does not.
        let turn_message_id = message_id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        // Per-turn cancellation token + inflight registration. The
        // token fires when an admin issues `engine.abort_thread`, an
        // IM recall event arrives, or the wall-clock budget below
        // expires. `InflightGuard` removes the entry on drop —
        // including the panic / early-return paths — so the map
        // never leaks rows for already-finished turns.
        let cancel_token = CancellationToken::new();
        let inflight_key = (thread_id.clone(), turn_message_id.clone());
        {
            let mut map = self.inflight.lock().expect("inflight mutex poisoned");
            // Same-key re-entry: overwrite. The previous turn (if
            // any) keeps its own clone of the token but loses the
            // external abort handle — fine in practice, the
            // duplicate key would only come from a plugin replaying
            // the same message id, which dedup should already drop
            // upstream.
            map.insert(inflight_key.clone(), cancel_token.clone());
        }
        let _inflight_guard = InflightGuard {
            map: self.inflight.clone(),
            key: inflight_key,
        };

        // 1. ensure thread row.
        self.ensure_thread(&thread_id, &tenant_id, &project_id)
            .await?;

        // 2. ensure workspace dir + tool context.
        self.workspace.ensure_project(&tenant_id, &project_id)?;
        let workspace_root = self.workspace.workspace_dir(&tenant_id, &project_id);
        let session_id = SessionId::new();
        let outbound_slot: Arc<Mutex<Vec<OutboundFile>>> = Arc::new(Mutex::new(Vec::new()));
        // Fresh per-turn Read tracker. Edit / MultiEdit consult this
        // to enforce "Read before Edit" and to detect external
        // modifications between Read and Edit within the same turn.
        // Resetting per turn is deliberate — across turns the file
        // may have changed and the model isn't holding the old view
        // in context anymore.
        let read_tracker: snaca_tools_api::ReadTracker =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let mut tool_ctx = ToolContext::new(
            tenant_id.clone(),
            project_id.clone(),
            session_id,
            workspace_root,
        )
        .with_outbound_files(outbound_slot.clone())
        .with_read_tracker(read_tracker)
        .with_cancellation_token(cancel_token.clone());
        // Bash run_in_background + TaskOutput / TaskStop share a
        // process-wide registry attached to the engine. When not
        // attached the companion tools surface a clear "no registry"
        // error instead of silently degrading.
        if let Some(reg) = self.task_registry.clone() {
            tool_ctx = tool_ctx.with_task_registry(reg);
        }
        // Per-turn reverse-RPC channel. Zotero context tools refuse
        // gracefully when no factory is attached, so deployments
        // without a paired editor host stay functional for everything
        // else.
        if let Some(factory) = self.context_requester_factory.clone() {
            let requester = factory(turn_message_id.clone());
            tool_ctx = tool_ctx.with_context_requester(requester);
        }

        // Wrap the rest of the turn in `tokio::select!` so external
        // abort + wall-clock timeout can short-circuit. The work
        // future owns everything it needs; the cancel + timeout arms
        // run alongside. `biased` makes the work future win on a tie
        // — important so a completed turn doesn't get masked by a
        // late-arriving cancel that fired during epilogue.
        let timeout_secs = self.config.turn_timeout_secs;
        let timeout_fired = Arc::new(AtomicBool::new(false));
        let timeout_fut = {
            let token = cancel_token.clone();
            let flag = timeout_fired.clone();
            async move {
                match timeout_secs {
                    Some(secs) => {
                        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
                        flag.store(true, Ordering::SeqCst);
                        token.cancel();
                    }
                    None => std::future::pending::<()>().await,
                }
            }
        };

        let work = async move {
            // 3. persist user message. Keep a clone of the raw text
            // so the system-prompt builder can use it as the
            // retrieval query *before* the next iteration starts.
            let turn_query = user_text.clone();
            self.state
                .append_message(&NewMessage {
                    thread_id: thread_id.clone(),
                    session_id,
                    role: Role::User,
                    content: vec![ContentBlock::text(user_text)],
                    turn_id: None,
                })
                .await?;

            // 4–5. agent loop.
            // The tool registry is composed once per turn (per tenant + project).
            // Calling the factory per iteration would be redundant and lose the
            // schema cache between rounds.
            let runtime_tools = self.runtime_tools(&tenant_id, &project_id).await;
            let tool_schemas = registry_schemas(&runtime_tools);
            // Build the per-turn system prompt by splicing in MEMORY.md if
            // any project memory has been recorded, plus optional vector
            // recall against the user's text. Reading once per turn is
            // fine — memory rarely changes mid-turn, and a stale read in the
            // middle of an iteration would only mean the model misses an
            // entry that was added a couple of seconds ago.
            let base_system_segments = self
                .system_prompt_for(&tenant_id, &project_id, &thread_id, &turn_query)
                .await;
            // Splice the front-end's per-turn ephemeral context onto the
            // tail as a *volatile* segment. It's recomputed every turn, so
            // it must never enter the cacheable prefix — appended after the
            // recall block, it leaves the cache breakpoint on the stable
            // base+memory prefix while still reaching the model this turn.
            let system_segments = match ephemeral_system {
                Some(extra) if !extra.is_empty() => {
                    let mut segs = base_system_segments;
                    segs.push(SystemSegment::volatile(extra));
                    segs
                }
                _ => base_system_segments,
            };
            let mut iterations = 0usize;
            let mut total_usage = Usage::default();
            let mut loop_guard = self
                .config
                .loop_guard_max_repeats
                .map(|limit| LoopGuard::new(LoopGuardConfig { limit }));

            // Per-turn output-cap escalation state. When the model returns
            // `stop_reason == MaxTokens` with no tool_use, the same turn
            // may retry up to `max_output_token_escalation_attempts` times
            // with a doubled cap. Tracked outside the loop so escalations
            // don't reset on tool-use iterations.
            let mut max_tokens_override: Option<u32> = None;
            let mut escalation_attempts: u32 = 0;
            // Bounded shrink-retry for provider `prompt_too_long` /
            // `ContextOverflow` errors. Each attempt halves the effective
            // tail length (`compact_keep_recent → /2 → /2 → …`, floored at
            // 2) so progressively more history gets folded into the
            // summary. Capped by `compact_max_retries`; if even the
            // tightest tail can't fit the model's window, surfacing the
            // error is the right move (something else is wrong).
            let mut prompt_too_long_attempts: u8 = 0;
            let max_compact_retries = self.config.compact_max_retries;

            loop {
                if iterations >= self.config.max_iterations {
                    return Err(EngineError::MaxIterationsExceeded(
                        self.config.max_iterations,
                    ));
                }
                iterations += 1;

                let history = self.load_history(&thread_id).await?;
                debug!(
                    iteration = iterations,
                    history_len = history.len(),
                    "calling LLM"
                );

                let request_max_tokens = max_tokens_override.or(self.config.max_tokens);
                let llm_outcome = self
                    .call_llm_and_prerun(
                        &system_segments,
                        history,
                        tool_schemas.clone(),
                        &runtime_tools,
                        &tool_ctx,
                        listener.as_ref(),
                        request_max_tokens,
                    )
                    .await;
                let (resp, prerun_cache) = match llm_outcome {
                    Ok(v) => v,
                    Err(EngineError::Llm(e))
                        if prompt_too_long_attempts < max_compact_retries
                            && is_context_length_error(&e) =>
                    {
                        // Withheld-error pattern from the reference: don't
                        // propagate to the IM channel on prompt-too-long
                        // until shrink-retry is exhausted. Each attempt
                        // halves the effective tail so the LLM call lands
                        // on a progressively shorter prompt.
                        //
                        // `last_input_tokens` is diagnostic-only; pass 0 —
                        // we don't have the count from a failed request,
                        // and inferring it from history bytes would only
                        // bias one telemetry field.
                        prompt_too_long_attempts += 1;
                        // 6 → 3 → 2 → 2 …  (floor at 2; below that the
                        // model loses the user message it's answering).
                        let shrunk = (self.config.compact_keep_recent
                            >> prompt_too_long_attempts.min(6))
                        .max(2);
                        warn!(
                            thread_id = thread_id.as_str(),
                            attempt = prompt_too_long_attempts,
                            max = max_compact_retries,
                            shrunk_keep_recent = shrunk,
                            error = %e,
                            "provider rejected prompt as too long; running synchronous \
                             compaction with tighter tail and retrying turn"
                        );
                        self.maybe_compact_thread(&thread_id, 0, Some(shrunk))
                            .await?;
                        continue;
                    }
                    Err(e) => return Err(e),
                };
                total_usage.add(&resp.usage);
                // Per-iteration cache visibility. `cache_creation_input_tokens`
                // = cost of writing this turn's prefix to cache;
                // `cache_read_input_tokens` = bill avoided by reading from it.
                if resp.usage.cache_creation_input_tokens.is_some()
                    || resp.usage.cache_read_input_tokens.is_some()
                {
                    debug!(
                        iter = iterations,
                        cache_creation = resp.usage.cache_creation_input_tokens.unwrap_or(0),
                        cache_read = resp.usage.cache_read_input_tokens.unwrap_or(0),
                        fresh_input = resp.usage.input_tokens,
                        thread_id = thread_id.as_str(),
                        "llm cache usage"
                    );
                }

                // Skip persisting an empty assistant response. A turn with no
                // text/thinking/tool_use blocks would poison every later turn —
                // DeepSeek/OpenAI reject an assistant message with neither
                // `content` nor `tool_calls`. End the turn cleanly instead.
                if resp.message.content.is_empty() {
                    warn!(
                        thread_id = thread_id.as_str(),
                        iterations,
                        "LLM returned no content blocks; ending turn without persisting empty assistant message"
                    );
                    let outbound_files = drain_outbound(&outbound_slot);
                    return Ok(TurnOutcome {
                        session_id,
                        assistant_text: String::new(),
                        iterations,
                        usage: total_usage,
                        outbound_files,
                    });
                }

                // Persist assistant message.
                let assistant_msg = self
                    .state
                    .append_message(&NewMessage {
                        thread_id: thread_id.clone(),
                        session_id,
                        role: Role::Assistant,
                        content: resp.message.content.clone(),
                        turn_id: None,
                    })
                    .await?;

                // Max-output-tokens escalation. Anthropic / DeepSeek / OpenAI
                // all treat `MaxTokens` as terminal; without this branch a
                // long-reasoning turn would surface to the user mid-sentence.
                // We only escalate when the truncated response carried no
                // tool_use blocks — re-issuing a turn whose tool_use already
                // landed in history would double-execute side effects. The
                // truncated assistant message stays in history so the next
                // call continues from where the model left off (Anthropic /
                // DeepSeek both accept a trailing assistant message and
                // resume generation).
                let escalation_limit = self.config.max_output_token_escalation_attempts;
                let has_tool_use = resp
                    .message
                    .content
                    .iter()
                    .any(|b| matches!(b, ContentBlock::ToolUse { .. }));
                if matches!(resp.stop_reason, StopReason::MaxTokens)
                    && !has_tool_use
                    && escalation_attempts < escalation_limit
                {
                    let prev_cap =
                        request_max_tokens.unwrap_or(self.config.max_tokens.unwrap_or(4096));
                    let bumped = prev_cap
                        .saturating_mul(2)
                        .min(self.config.max_output_token_ceiling);
                    if bumped > prev_cap {
                        escalation_attempts += 1;
                        max_tokens_override = Some(bumped);
                        warn!(
                        attempt = escalation_attempts,
                        limit = escalation_limit,
                        prev_max = prev_cap,
                        new_max = bumped,
                        thread_id = thread_id.as_str(),
                        "max_tokens hit with no tool_use; escalating output cap and continuing turn"
                    );
                        continue;
                    }
                }

                if resp.stop_reason.is_terminal() {
                    let text = ContentBlock::collect_text(&resp.message.content);
                    let cache_creation = total_usage.cache_creation_input_tokens.unwrap_or(0);
                    let cache_read = total_usage.cache_read_input_tokens.unwrap_or(0);
                    // Hit rate among input-side billing: how much of this
                    // turn's input bytes were served from cache vs. paid
                    // fresh. Stays 0 when no cache info is returned.
                    let cache_denom = total_usage.input_tokens + cache_read + cache_creation;
                    let cache_hit_rate = if cache_denom > 0 {
                        cache_read as f64 / cache_denom as f64
                    } else {
                        0.0
                    };
                    info!(
                        iterations,
                        input_tokens = total_usage.input_tokens,
                        output_tokens = total_usage.output_tokens,
                        cache_creation_tokens = cache_creation,
                        cache_read_tokens = cache_read,
                        cache_hit_rate = format!("{:.2}", cache_hit_rate),
                        stop_reason = ?resp.stop_reason,
                        "turn complete"
                    );
                    // Best-effort compaction trigger. We use the *terminal* round's
                    // input tokens (most recent prompt size) rather than the
                    // accumulated `total_usage.input_tokens`, since cumulative
                    // counts grow with iteration count even on a short thread.
                    // Failures are logged and swallowed so a bad summarization
                    // call never breaks the user-facing turn.
                    //
                    // Default path: fire-and-forget on a background task — the
                    // same pattern memory extraction uses (see
                    // `spawn_memory_extraction` below). The user-visible turn
                    // returns immediately; the summary lands a couple of
                    // seconds later and applies to the *next* turn. Setting
                    // `compact_blocking = true` reverts to the original
                    // in-line await for tests that need to assert on the
                    // post-compaction state synchronously.
                    if let Some(threshold) = self.config.compact_after_input_tokens {
                        if resp.usage.input_tokens >= threshold as u64 {
                            let last_tokens = resp.usage.input_tokens as u32;
                            if self.config.compact_blocking {
                                if let Err(e) = self
                                    .maybe_compact_thread(&thread_id, last_tokens, None)
                                    .await
                                {
                                    warn!(
                                        thread_id = thread_id.as_str(),
                                        error = %e,
                                        "auto-compaction failed; thread will retry on next turn"
                                    );
                                }
                            } else {
                                let engine = self.clone();
                                let thread = thread_id.clone();
                                tokio::spawn(async move {
                                    if let Err(e) = engine
                                        .maybe_compact_thread(&thread, last_tokens, None)
                                        .await
                                    {
                                        warn!(
                                            thread_id = thread.as_str(),
                                            error = %e,
                                            "auto-compaction failed; thread will retry on next turn"
                                        );
                                    }
                                });
                            }
                        }
                    }
                    // Memory extraction — best-effort, fire-and-forget on a
                    // background task so a slow extractor doesn't add
                    // latency to the user-visible turn. Skipped when no
                    // extractor is configured (the default).
                    self.spawn_memory_extraction(
                        tenant_id.clone(),
                        project_id.clone(),
                        thread_id.clone(),
                    );
                    let outbound_files = drain_outbound(&outbound_slot);
                    return Ok(TurnOutcome {
                        session_id,
                        assistant_text: text,
                        iterations,
                        usage: total_usage,
                        outbound_files,
                    });
                }

                // Tool calls — execute each, then append a tool message with the results.
                let tool_results = self
                    .run_tool_calls(
                        &resp.message.content,
                        &assistant_msg.id,
                        &tool_ctx,
                        gate.as_ref(),
                        &runtime_tools,
                        loop_guard.as_mut(),
                        prerun_cache,
                    )
                    .await?;

                if tool_results.is_empty() {
                    // Model said "tool_use" but emitted no tool blocks — defensive
                    // exit; treat as terminal so we don't loop forever.
                    warn!("stop_reason=ToolUse but no ToolUse blocks; treating as terminal");
                    let text = ContentBlock::collect_text(&resp.message.content);
                    let outbound_files = drain_outbound(&outbound_slot);
                    return Ok(TurnOutcome {
                        session_id,
                        assistant_text: text,
                        iterations,
                        usage: total_usage,
                        outbound_files,
                    });
                }

                self.state
                    .append_message(&NewMessage {
                        thread_id: thread_id.clone(),
                        session_id,
                        role: Role::Tool,
                        content: tool_results,
                        turn_id: None,
                    })
                    .await?;
            }
        };

        // The cancel arm wins on tie thanks to `biased`. Inside, we
        // tell apart the two abort flavours via `timeout_fired`: if
        // the timeout future set it, surface `TurnTimeout`; otherwise
        // the cancel came from an external `abort_thread` call
        // (admin HTTP or IM recall).
        tokio::select! {
            biased;
            res = work => res,
            _ = cancel_token.cancelled() => {
                if timeout_fired.load(Ordering::SeqCst) {
                    Err(EngineError::TurnTimeout(timeout_secs.unwrap_or(0)))
                } else {
                    Err(EngineError::Aborted)
                }
            }
            _ = timeout_fut => {
                // Reached only when `timeout_fut` fires *and* the cancel
                // arm hasn't run yet. The timeout future already
                // cancels the token, so this arm is a backup return
                // path; in practice the `cancelled()` arm wins.
                Err(EngineError::TurnTimeout(timeout_secs.unwrap_or(0)))
            }
        }
    }

    async fn ensure_thread(
        &self,
        thread_id: &ThreadId,
        tenant_id: &TenantId,
        project_id: &ProjectId,
    ) -> EngineResult<()> {
        if self.state.find_thread(thread_id).await?.is_some() {
            return Ok(());
        }
        // Concurrent group-chat case: two messages on the same
        // thread arriving simultaneously each see `find_thread =
        // None`, each try to insert, and one races into a UNIQUE
        // violation. The losing race is harmless — the row now
        // exists, which is what we wanted. Re-check after a failed
        // insert; if the row materialised, treat it as success.
        // Anything else (DB lost, schema mismatch) propagates.
        let insert_res = self
            .state
            .insert_thread(&NewThread {
                id: thread_id.clone(),
                tenant_id: tenant_id.clone(),
                project_id: project_id.clone(),
                // IM-side threads aren't user-titled; left blank.
                title: String::new(),
            })
            .await;
        match insert_res {
            Ok(_) => Ok(()),
            Err(e) => {
                if self.state.find_thread(thread_id).await?.is_some() {
                    debug!(
                        thread_id = thread_id.as_str(),
                        "ensure_thread: lost the insert race; row now exists, continuing"
                    );
                    Ok(())
                } else {
                    Err(EngineError::from(e))
                }
            }
        }
    }

    async fn load_history(&self, thread_id: &ThreadId) -> EngineResult<Vec<Message>> {
        // If a compaction is on file, splice the summary in as a synthetic
        // user message and only fetch live messages newer than the summary
        // cutoff. Otherwise fall back to plain `recent_messages`.
        if let Some(comp) = self.state.get_thread_summary(thread_id).await? {
            // Preserved head: messages older than the first compressed
            // message. When `summary_from_message_id` is `None`
            // (legacy rows backfilled by the M6 migration), the head
            // is empty and the preamble sits at the front, matching
            // pre-M6 behaviour.
            let head: Vec<Message> = if let Some(from_id) = comp.summary_from_message_id {
                let head_rows = self
                    .state
                    .messages_before(
                        thread_id,
                        &from_id,
                        // protect_first_n is small (default 4); a
                        // tight cap keeps the query cheap even on
                        // very long threads.
                        self.config.protect_first_n.max(1) as u32,
                    )
                    .await?;
                head_rows
                    .into_iter()
                    .map(|r| Message {
                        id: r.id,
                        role: r.role,
                        content: r.content,
                        created_at: r.created_at,
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let live = self
                .state
                .messages_after(
                    thread_id,
                    &comp.summary_until_message_id,
                    self.config.history_limit,
                )
                .await?;
            let mut out = Vec::with_capacity(head.len() + live.len() + 1);
            out.extend(head);
            // Synthetic preamble. User-role keeps things dead simple — every
            // provider accepts a leading user turn, and the [SNACA SUMMARY]
            // prefix lets the model recognise it as compacted context rather
            // than a real instruction.
            out.push(Message {
                id: MessageId::new(),
                role: Role::User,
                content: vec![ContentBlock::text(format!(
                    "[SNACA SUMMARY of earlier conversation — \
                     {} messages compacted]\n\n{}",
                    comp.msg_count_before, comp.summary
                ))],
                created_at: comp.compacted_at,
            });
            let live_msgs: Vec<Message> = live
                .into_iter()
                .map(|r| Message {
                    id: r.id,
                    role: r.role,
                    content: r.content,
                    created_at: r.created_at,
                })
                .collect();
            // Apply the byte cap to the live tail too — the summary
            // preamble already shrinks the history by definition, but
            // a single oversized post-compaction message (e.g. a
            // tool_result carrying a freshly extracted PDF body) can
            // still blow the window.
            let bounded = enforce_history_byte_cap(live_msgs, self.config.history_max_bytes);
            let repaired = repair_orphan_tool_uses(bounded);
            // Collapse old read-only tool_results so the model
            // doesn't re-pay token budget for stale Read/Grep
            // output on every turn after compaction. The kept tail
            // matches `compact_keep_recent` so the model still
            // sees its most recent tool work verbatim.
            let collapsed = collapse_old_tool_results(
                repaired,
                self.config.compact_keep_recent,
                self.config.collapse_tool_results_threshold,
            );
            out.extend(collapsed);
            return Ok(out);
        }
        let rows = self
            .state
            .recent_messages(thread_id, self.config.history_limit)
            .await?;
        let messages: Vec<Message> = rows
            .into_iter()
            .map(|r| Message {
                id: r.id,
                role: r.role,
                content: r.content,
                created_at: r.created_at,
            })
            .collect();
        let bounded = enforce_history_byte_cap(messages, self.config.history_max_bytes);
        let repaired = repair_orphan_tool_uses(bounded);
        Ok(collapse_old_tool_results(
            repaired,
            self.config.compact_keep_recent,
            self.config.collapse_tool_results_threshold,
        ))
    }

    /// Fire the configured `MemoryExtractor` on a background task. The
    /// task pulls the just-completed turn's messages from the DB,
    /// passes them to the extractor, and persists each proposal
    /// through the project's `MemoryStore`. No-op when no extractor is
    /// attached. Errors are logged, never propagated.
    fn spawn_memory_extraction(&self, tenant: TenantId, project: ProjectId, thread: ThreadId) {
        let Some(extractor) = self.extractor.clone() else {
            return;
        };
        let state = self.state.clone();
        let workspace = self.workspace.clone();
        let sink = self.memory_sink.clone();
        // Pull *all* recent messages from the thread the worker can
        // see — same window the engine uses for retrieval, so the
        // extractor sees the same context the LLM did.
        let history_limit = self.config.history_limit;
        let default_confidence = self.config.extractor_default_confidence;
        tokio::spawn(async move {
            let rows = match state.recent_messages(&thread, history_limit).await {
                Ok(r) => r,
                Err(e) => {
                    warn!(error = %e, "extractor: history fetch failed");
                    return;
                }
            };
            let messages: Vec<Message> = rows
                .into_iter()
                .map(|r| Message {
                    id: r.id,
                    role: r.role,
                    content: r.content,
                    created_at: r.created_at,
                })
                .collect();
            let proposals = extractor.extract(&tenant, &project, &messages).await;
            if proposals.is_empty() {
                return;
            }
            let store = snaca_memory::MemoryStore::new(workspace.memory_dir(&tenant, &project));
            for proposal in proposals {
                // Reject scopes outside the auto-extracted set.
                // Project / Reference are operator-curated only.
                if !matches!(
                    proposal.scope,
                    snaca_memory::MemoryScope::User | snaca_memory::MemoryScope::Feedback
                ) {
                    warn!(
                        scope = %proposal.scope,
                        "extractor proposed disallowed scope; skipping"
                    );
                    continue;
                }
                // Wrap the proposal body in YAML frontmatter so recall
                // can downweight by `confidence` and the index can audit
                // `source`. Missing confidence falls back to the engine's
                // configured default rather than full trust.
                let confidence = proposal.confidence.unwrap_or(default_confidence);
                let meta = snaca_memory::MemoryMeta {
                    source: Some("extractor".into()),
                    confidence: Some(confidence),
                    created_at: Some(chrono::Utc::now().to_rfc3339()),
                };
                let wrapped = snaca_memory::render_with_frontmatter(&meta, &proposal.content);
                match store
                    .write(proposal.scope, &proposal.name, &wrapped)
                    .await
                {
                    Ok(entry) => {
                        debug!(
                            scope = %entry.scope,
                            name = entry.name.as_str(),
                            confidence,
                            "extractor wrote memory entry"
                        );
                        // The extractor writes through `MemoryStore::write`
                        // which both creates and overwrites without
                        // distinguishing. We can't tell created vs updated
                        // cheaply here, so default to `Updated` — the host
                        // refreshes the list on either and a stale "new"
                        // badge is worse than a stale "modified" one.
                        if let Some(s) = &sink {
                            s.on_memory_changed(
                                entry.scope,
                                entry.name.as_str(),
                                crate::memory_sink::MemoryAction::Updated,
                            );
                        }
                    }
                    Err(e) => warn!(
                        scope = %proposal.scope,
                        name = proposal.name.as_str(),
                        error = %e,
                        "extractor write failed"
                    ),
                }
            }
        });
    }

    /// Compose the system prompt actually sent to the LLM for one turn:
    /// base prompt + optional `## Project Memory` index + optional
    /// `## Relevant Memories` recall. Both memory sections are
    /// best-effort — IO or embedder failures fall back to the base
    /// prompt rather than aborting the turn, since memory is auxiliary
    /// context, not a hard requirement.
    ///
    /// Returns the prompt as ordered [`SystemSegment`]s so the provider
    /// layer can apply prompt-cache breakpoints precisely: the base +
    /// MEMORY.md prefix is `cacheable`, the per-turn recall block is
    /// not. DeepSeek/OpenAI flatten back to a single string.
    async fn system_prompt_for(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
        thread: &ThreadId,
        user_query: &str,
    ) -> Vec<SystemSegment> {
        let memory_dir = self.workspace.memory_dir(tenant, project);
        let store = snaca_memory::MemoryStore::new(memory_dir);

        let idx = match store.index_text().await {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "memory index read failed; turning without memory preamble");
                String::new()
            }
        };

        let recall_block = if !user_query.trim().is_empty() {
            self.retrieval_block(tenant, project, thread, &store, user_query)
                .await
        } else {
            String::new()
        };

        compose_system_segments(&self.config.system_prompt, &idx, &recall_block)
    }

    /// Run vector recall against the project memory and render the
    /// `## Relevant Memories` block. Returns an empty string when no
    /// embedder is wired, the embedding fails, or no entry hits the
    /// minimum-score threshold. Each hit gets its name + a short
    /// excerpt of its content; the whole block is hard-capped at
    /// `RECALL_MAX_BYTES` so a runaway memory tree can't bloat every
    /// system prompt.
    async fn retrieval_block(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
        thread: &ThreadId,
        store: &snaca_memory::MemoryStore,
        query: &str,
    ) -> String {
        let Some(embedder) = self.embedder.clone() else {
            return String::new();
        };
        let idx = snaca_memory::IndexedMemoryStore::new(
            store.clone(),
            self.state.clone(),
            embedder,
            tenant.clone(),
            project.clone(),
        );
        // `MemoryWriteTool` writes directly through the file tree
        // without touching the vector table (it doesn't carry a
        // Database / Embedder handle by design). Catch the index up
        // before searching — cheap when everything's already in sync.
        if let Err(e) = idx.ensure_indexed().await {
            warn!(error = %e, "ensure_indexed failed before recall; some entries may be missing");
        }
        // Pull a wider candidate pool when a reranker is attached;
        // otherwise stop at the final cap (saves an entire DB read).
        // Dedup against `surfaced_memories` thins the candidate set
        // further down — request the pool size even without a
        // reranker so dedup has room to drop entries without
        // emptying the recall block.
        let pool_size = if self.reranker.is_some() || self.surfaced_has_entries(thread) {
            RECALL_POOL_SIZE
        } else {
            RECALL_TOP_K
        };
        let hits = match idx.search(query, pool_size).await {
            Ok(h) => h,
            Err(e) => {
                warn!(error = %e, "memory vector recall failed; skipping retrieval block");
                return String::new();
            }
        };
        if hits.is_empty() {
            return String::new();
        }
        // Apply the floor *before* rerank so we never ask the LLM to
        // judge entries that even cosine thought were unrelated.
        let mut filtered: Vec<_> = hits
            .into_iter()
            .filter(|h| h.score >= RECALL_MIN_SCORE)
            .collect();
        if filtered.is_empty() {
            return String::new();
        }
        // Drop entries already surfaced through earlier turns on this
        // thread — the model has seen them in recent context and a
        // second copy just bloats the prompt. Falls back to the
        // unfiltered set when dedup would empty the recall (better
        // some repetition than zero hits).
        let before_dedup = filtered.len();
        let deduped: Vec<_> = {
            let surfaced = self.surfaced_snapshot(thread);
            filtered
                .iter()
                .filter(|h| !surfaced.contains(&(h.scope, h.name.clone())))
                .cloned()
                .collect()
        };
        if !deduped.is_empty() {
            filtered = deduped;
            if filtered.len() != before_dedup {
                debug!(
                    thread_id = thread.as_str(),
                    kept = filtered.len(),
                    skipped = before_dedup - filtered.len(),
                    "filtered already-surfaced memories from recall pool"
                );
            }
        }

        // Rerank optional. Body lookup happens here so the reranker
        // sees full content, not just names. Frontmatter parsing folds
        // in two checks: the body shown to the model is post-frontmatter
        // (no YAML leakage), and when an entry sets `confidence`
        // explicitly we multiply cosine by it and drop hits below
        // `recall_confidence_floor`. Legacy entries (no frontmatter) are
        // not subject to this extra floor — `RECALL_MIN_SCORE` upstream
        // is their only gate, preserving prior behaviour.
        let floor = self.config.recall_confidence_floor;
        let candidates: Vec<crate::reranker::RerankCandidate> = {
            let mut out = Vec::with_capacity(filtered.len());
            for h in filtered.drain(..) {
                let (meta, body) = match store.read_with_meta(h.scope, &h.name).await {
                    Ok(v) => v,
                    Err(e) => {
                        warn!(scope = %h.scope, name = %h.name, error = %e, "memory body read failed during recall");
                        continue;
                    }
                };
                let (adjusted, confidence_applied) = match meta.confidence {
                    Some(c) => (h.score * c, Some(c)),
                    None => (h.score, None),
                };
                if confidence_applied.is_some() && adjusted < floor {
                    debug!(
                        scope = %h.scope,
                        name = %h.name,
                        cosine = h.score,
                        confidence = confidence_applied.unwrap_or(1.0),
                        adjusted,
                        floor,
                        "recall: dropping low-confidence-adjusted hit"
                    );
                    continue;
                }
                out.push(crate::reranker::RerankCandidate {
                    scope: h.scope,
                    name: h.name,
                    content: body,
                    initial_score: adjusted,
                });
            }
            out
        };
        if candidates.is_empty() {
            return String::new();
        }
        let ranked: Vec<crate::reranker::RerankCandidate> = match &self.reranker {
            Some(r) => r.rerank(query, candidates, RECALL_TOP_K).await,
            None => {
                // Sort by adjusted score; multiplying by confidence may
                // have flipped the cosine ordering. `partial_cmp` can't
                // fail on the floats here, but fall back defensively.
                let mut v = candidates;
                v.sort_by(|a, b| {
                    b.initial_score
                        .partial_cmp(&a.initial_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                v.truncate(RECALL_TOP_K);
                v
            }
        };
        if ranked.is_empty() {
            return String::new();
        }

        let mut out = String::new();
        let mut included = 0usize;
        let mut surfaced_this_call: Vec<SurfacedKey> = Vec::new();
        for candidate in ranked {
            let body_excerpt = excerpt(&candidate.content, RECALL_EXCERPT_BYTES);
            let next = format!(
                "### `{}/{}` (score {:.2})\n{}\n\n",
                candidate.scope.as_str(),
                candidate.name,
                candidate.initial_score,
                body_excerpt
            );
            if out.len() + next.len() > RECALL_MAX_BYTES {
                break;
            }
            out.push_str(&next);
            surfaced_this_call.push((candidate.scope, candidate.name.clone()));
            included += 1;
        }
        if included == 0 {
            return String::new();
        }
        // Record what we actually spliced in. Future turns on this
        // thread filter their candidate pool against this ring, so a
        // long conversation doesn't repeatedly re-spend its recall
        // budget on the same entries.
        self.record_surfaced(thread, &surfaced_this_call);
        out
    }

    /// Snapshot of memories already shown in earlier recall blocks for
    /// this thread. Returned as `HashSet` so callers can check
    /// membership in `O(1)` while filtering. Empty when the thread has
    /// no prior recall (the common case for new conversations).
    fn surfaced_snapshot(&self, thread: &ThreadId) -> std::collections::HashSet<SurfacedKey> {
        let Ok(guard) = self.surfaced_memories.lock() else {
            return Default::default();
        };
        match guard.get(thread) {
            Some(ring) => ring.iter().cloned().collect(),
            None => Default::default(),
        }
    }

    /// Whether the dedup ring has any entry for this thread. Cheaper
    /// than `surfaced_snapshot` when we just need a boolean (sizing
    /// the candidate pool). Returns false when the lock is poisoned
    /// since the conservative move is "no dedup state".
    fn surfaced_has_entries(&self, thread: &ThreadId) -> bool {
        let Ok(guard) = self.surfaced_memories.lock() else {
            return false;
        };
        guard.get(thread).is_some_and(|r| !r.is_empty())
    }

    /// Push the entries we just surfaced into the per-thread ring.
    /// Ring capped at `SURFACED_RING_CAP` — old entries fall off the
    /// front and become eligible to resurface, which is the right
    /// trade-off: if the model needed an entry 30 turns ago, surfacing
    /// it again is fine.
    fn record_surfaced(&self, thread: &ThreadId, entries: &[SurfacedKey]) {
        if entries.is_empty() {
            return;
        }
        let Ok(mut guard) = self.surfaced_memories.lock() else {
            return;
        };
        let ring = guard.entry(thread.clone()).or_default();
        for entry in entries {
            // Avoid duplicate consecutive entries: if the same memory
            // came up twice in a row (rare but possible), don't
            // double-count it against the ring capacity.
            if !ring.iter().any(|e| e == entry) {
                ring.push_back(entry.clone());
                while ring.len() > SURFACED_RING_CAP {
                    ring.pop_front();
                }
            }
        }
    }

    /// Run an LLM-driven summarization over the *middle* segment of
    /// `thread`. With first-N protection enabled (`protect_first_n >
    /// 0`), the oldest N messages and the most recent
    /// `compact_keep_recent` messages stay verbatim; the band in
    /// between is folded into a single summary string and persisted
    /// via [`Database::set_thread_summary`].
    ///
    /// `keep_recent_override` lets callers (notably the
    /// context-overflow retry path) ask for a tighter tail than the
    /// configured default. The override is clamped to `>= 2` so the
    /// model never loses the user message it's currently responding to.
    ///
    /// `last_input_tokens` is recorded for diagnostics only.
    ///
    /// No-op when the protected band leaves fewer than 2 messages to
    /// compress — there's nothing to summarise.
    async fn maybe_compact_thread(
        &self,
        thread_id: &ThreadId,
        last_input_tokens: u32,
        keep_recent_override: Option<usize>,
    ) -> EngineResult<()> {
        let protect_last = keep_recent_override
            .unwrap_or(self.config.compact_keep_recent)
            .max(2);
        let protect_first = self.config.protect_first_n;
        // Pull the entire thread's messages — `history_limit * 4` keeps a
        // safe ceiling even when load_history is summary-spliced. We need
        // the raw row order from oldest to newest to pick the cutoffs.
        let mut all = self
            .state
            .recent_messages(thread_id, self.config.history_limit.saturating_mul(4))
            .await?;
        // Need at least `protect_first + protect_last + 2` rows for a
        // non-trivial middle band. Below that, compaction would either
        // touch a protected segment or fold a single message — neither
        // is worth the LLM call.
        if all.len() < protect_first + protect_last + 2 {
            debug!(
                thread_id = thread_id.as_str(),
                len = all.len(),
                protect_first,
                protect_last,
                "skipping compaction — middle band too small to be worth summarising"
            );
            return Ok(());
        }
        let compress_start = protect_first;
        let compress_end = all.len() - protect_last;
        // Boundary message ids — recorded in thread_compactions so
        // load_history can splice preserved_head ++ preamble ++ live_tail.
        let from_id = all[compress_start].id;
        let cutoff = all[compress_end - 1].clone();
        // Drop the messages we're about to compress out of `all`; what
        // remains (`all[..compress_start]` plus the original tail) is
        // unused after this point.
        let body_rows: Vec<_> = all.drain(compress_start..compress_end).collect();
        // Convert to Message and run the same collapse the live
        // history goes through. Treats the body as "all old" (keep
        // tail = 0) since the kept tail was already sliced off
        // above — the summariser doesn't need to see verbatim
        // results for anything in this set.
        let body_msgs: Vec<Message> = body_rows
            .iter()
            .map(|r| Message {
                id: r.id,
                role: r.role,
                content: r.content.clone(),
                created_at: r.created_at,
            })
            .collect();
        let body_collapsed =
            collapse_old_tool_results(body_msgs, 0, self.config.collapse_tool_results_threshold);
        let body_text = render_for_summary(&body_collapsed);
        let body_count = body_rows.len();

        // Build a single-shot summarization request. We deliberately
        // re-use the engine's LLM client and the same model — using a
        // smaller / cheaper model would require a second LlmClient
        // wired through config, which we'll do later.
        let mut req = MessageRequest::new(&self.config.model)
            .with_system(
                "You are a context summariser. Compress the provided \
                 conversation to a tight paragraph (under 250 words) \
                 capturing: open questions, user goals, decisions made, \
                 and any concrete facts the assistant must remember. \
                 Drop pleasantries. No bullet lists; one paragraph.",
            )
            .with_messages(vec![Message {
                id: MessageId::new(),
                role: Role::User,
                content: vec![ContentBlock::text(body_text)],
                created_at: Utc::now(),
            }])
            .with_tools(Vec::new());
        // Cap the output. 512 was too tight in practice — summaries
        // truncated mid-sentence, and the next turn re-triggered
        // compaction on a thread that still hadn't escaped the
        // threshold. Use the configured cap (default 2048); ~300–400
        // words of paragraph + a few short lists is a comfortable
        // budget that's still well under any sane next-turn threshold.
        req = req.with_max_tokens(self.config.compact_summary_max_tokens);

        let resp = self.llm.create_message(req).await?;
        let summary = ContentBlock::collect_text(&resp.message.content);
        if summary.trim().is_empty() {
            warn!(
                thread_id = thread_id.as_str(),
                "summariser returned empty text; skipping compaction"
            );
            return Ok(());
        }

        let saved = self
            .state
            .set_thread_summary(
                thread_id,
                &summary,
                &cutoff.id,
                // When protect_first_n is 0 the "from" id is the very
                // first message — render that as the legacy
                // `summary_from_message_id = NULL` so load_history
                // takes the legacy "preamble at the head" path.
                if protect_first == 0 {
                    None
                } else {
                    Some(&from_id)
                },
                body_count as u32,
                last_input_tokens,
            )
            .await?;
        info!(
            thread_id = thread_id.as_str(),
            compacted = saved.msg_count_before,
            summary_len = summary.len(),
            "thread auto-compacted"
        );
        Ok(())
    }

    /// Drive the LLM streaming round trip and (when
    /// `EngineConfig::stream_tool_execution = true`) eagerly dispatch
    /// read-only no-approval tool calls as their inputs finish
    /// streaming. The returned [`PrerunCache`] maps `tool_use_id` to
    /// the already-computed result; the post-stream tool pass consumes
    /// it instead of re-running the tool. Empty cache when streaming
    /// pre-execution is off or no tool was eligible.
    ///
    /// Eligibility rules:
    /// - tool registered in `tools`
    /// - `tool.is_read_only()` true
    /// - `tool.approval_requirement() == Never` (we can't synchronously
    ///   approve during a stream — the user hasn't seen the request yet)
    /// - `partial_json` parses as a valid JSON value (a truncated tool
    ///   input from `stop_reason=max_tokens` would otherwise produce a
    ///   tool error that the normal pass already handles)
    #[allow(clippy::too_many_arguments)]
    async fn call_llm_and_prerun(
        &self,
        system_segments: &[SystemSegment],
        history: Vec<Message>,
        tool_schemas: Vec<ToolSchema>,
        tools: &ToolRegistry,
        tool_ctx: &ToolContext,
        listener: &dyn TurnEventListener,
        max_tokens_override: Option<u32>,
    ) -> EngineResult<(MessageResponse, PrerunCache)> {
        let mut req = MessageRequest::new(&self.config.model)
            .with_system_segments(system_segments.to_vec())
            .with_messages(history)
            .with_tools(tool_schemas);
        if let Some(max) = max_tokens_override {
            req = req.with_max_tokens(max);
        }
        let mut stream = self.llm.create_message_stream(req).await?;
        let mut acc = StreamAccumulator::new();
        // Mirror enough state to recover the (id, name, args) of each
        // tool_use block independently of `acc`. We don't reach into
        // `acc`'s private state — keeping a parallel BTreeMap is much
        // simpler than expanding the accumulator's API surface.
        let mut partials: std::collections::BTreeMap<u32, StreamToolUse> =
            std::collections::BTreeMap::new();
        let mut handles: Vec<tokio::task::JoinHandle<(ToolUseId, ToolResult)>> = Vec::new();
        // Write-barrier: once we see a tool_use that isn't safe for
        // eager dispatch (a write, an approval-gated call, or an
        // unknown tool), every later tool_use in the same assistant
        // message must run sequentially in the post-stream pass — its
        // result may depend on side effects of the barrier tool. The
        // assistant message order is the model's intent; eager
        // dispatch only crosses that order for prefix reads that have
        // no write ancestor in this turn.
        let mut barrier_hit = false;

        while let Some(ev) = stream.next().await {
            let ev = ev?;
            listener.on_event(&ev).await;

            if self.config.stream_tool_execution {
                match &ev {
                    StreamEvent::ContentBlockStart {
                        index,
                        block: ContentBlockStart::ToolUse { id, name },
                    } => {
                        partials.insert(
                            *index,
                            StreamToolUse {
                                id: id.clone(),
                                name: name.clone(),
                                args: String::new(),
                            },
                        );
                    }
                    StreamEvent::ContentBlockDelta {
                        index,
                        delta: ContentDelta::ToolInputJson { partial_json },
                    } => {
                        if let Some(p) = partials.get_mut(index) {
                            p.args.push_str(partial_json);
                        }
                    }
                    StreamEvent::ContentBlockStop { index } => {
                        if let Some(p) = partials.remove(index) {
                            // Even if the barrier is up, walk the
                            // eligibility check so we get the same
                            // log signal — but suppress spawning.
                            let tool_name = p.name.clone();
                            let eligible = is_streamable_tool(&tool_name, tools);
                            if barrier_hit {
                                debug!(
                                    tool = %tool_name,
                                    "skipping prerun: write barrier already hit this turn"
                                );
                            } else if !eligible {
                                debug!(
                                    tool = %tool_name,
                                    "tool not eligible for prerun; setting write barrier for the rest of this turn"
                                );
                                barrier_hit = true;
                            } else if let Some(h) = self.maybe_spawn_prerun(p, tools, tool_ctx) {
                                handles.push(h);
                            }
                        }
                    }
                    _ => {}
                }
            }

            acc.ingest(ev);
        }

        // Drain pre-spawned tasks. By the time the model finishes
        // streaming, most short reads have already completed in
        // parallel — joining is near-instant. Long reads still cost
        // their wall-clock here, but they'd have cost the same time
        // after the stream anyway; we just shifted it earlier.
        let mut cache = PrerunCache::new();
        for h in handles {
            match h.await {
                Ok((id, result)) => {
                    cache.insert(id, result);
                }
                // A panicked prerun task drops its slot — the normal
                // tool pass will re-execute. We do not surface the
                // panic; it's already logged by the runtime.
                Err(e) => warn!(error = %e, "streamed tool prerun task panicked"),
            }
        }

        let resp = acc.finalize()?;
        debug!(
            prerun_count = cache.len(),
            "stream finished; consumed prerun cache for tool execution pass"
        );
        Ok((resp, cache))
    }

    /// Decide whether the just-completed tool_use block is eligible
    /// for eager dispatch and spawn it on a tokio task. None when
    /// not eligible — the normal pass picks it up.
    fn maybe_spawn_prerun(
        &self,
        partial: StreamToolUse,
        tools: &ToolRegistry,
        ctx: &ToolContext,
    ) -> Option<tokio::task::JoinHandle<(ToolUseId, ToolResult)>> {
        let tool = tools.get(&partial.name)?;
        if !tool.is_read_only() {
            return None;
        }
        if !matches!(tool.approval_requirement(), ApprovalRequirement::Never) {
            return None;
        }
        // Empty args is a no-arg call (e.g. `{}`); blank string is
        // also accepted as such. Otherwise the args must parse cleanly
        // — half-streamed JSON from a max_tokens cutoff would error,
        // and we'd rather have the normal pass surface a tool_error
        // than commit to a malformed input.
        let input: Value = if partial.args.trim().is_empty() {
            Value::Object(Default::default())
        } else {
            match serde_json::from_str(&partial.args) {
                Ok(v) => v,
                Err(e) => {
                    debug!(
                        tool = %partial.name,
                        error = %e,
                        "skipping prerun: tool input not yet valid JSON"
                    );
                    return None;
                }
            }
        };
        let id = ToolUseId::new(partial.id);
        let id_for_task = id.clone();
        let ctx_owned = ctx.clone();
        let name = partial.name.clone();
        debug!(tool = %name, id = id.as_str(), "spawning eager prerun");
        Some(tokio::spawn(async move {
            let result = tool.execute(input, &ctx_owned).await;
            (id_for_task, result)
        }))
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_tool_calls(
        &self,
        assistant_content: &[ContentBlock],
        assistant_msg_id: &MessageId,
        tool_ctx: &ToolContext,
        gate: &dyn ApprovalGate,
        tools: &ToolRegistry,
        loop_guard: Option<&mut LoopGuard>,
        mut prerun_cache: PrerunCache,
    ) -> EngineResult<Vec<ContentBlock>> {
        // 1. Collect every ToolUse block in original order. We keep
        // the position so the result list can be re-ordered to match
        // tool_use → tool_result (Anthropic / DeepSeek both require
        // matching order in the next request).
        //
        // Each pending entry owns its strings + input so the parallel
        // futures below can move it into themselves without lifetime
        // gymnastics. `prebuilt` is `Some` when the streaming pass
        // already pre-ran this tool — `execute_one` consumes the
        // cached result instead of calling `Tool::execute` again.
        struct Pending {
            position: usize,
            id: ToolUseId,
            name: String,
            input: Value,
            is_read_only: bool,
            prebuilt: Option<ToolResult>,
        }
        let mut pending: Vec<Pending> = Vec::new();
        for block in assistant_content.iter() {
            if let ContentBlock::ToolUse { id, name, input } = block {
                let is_read_only = tools.get(name).map(|t| t.is_read_only()).unwrap_or(false);
                let prebuilt = prerun_cache.remove(id);
                pending.push(Pending {
                    position: pending.len(),
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                    is_read_only,
                    prebuilt,
                });
            }
        }

        // 2. LoopGuard fires *before* anything runs. Trip is fatal
        // to the turn — escalating it as a tool_error would just
        // feed the loop "yes please retry". The guard sees the model's
        // proposed tool_use regardless of whether streaming already
        // pre-ran it — the wasted work is harmless, but we want a
        // tight repeat-loop to terminate the turn either way.
        if let Some(g) = loop_guard {
            for p in &pending {
                if let Err((tool, count)) = g.record(&p.name, &p.input) {
                    warn!(tool = %tool, count, "loop guard tripped — aborting turn");
                    return Err(EngineError::LoopGuardTripped { tool, count });
                }
            }
        }

        // 3. Slice into segments. A run of contiguous read-only
        // tools is one segment that runs in parallel; every
        // non-read-only tool is its own single-element segment that
        // runs serially. Unknown tools default to non-read-only — if
        // the registry doesn't recognise the name, run it alone so a
        // genuine write (a stale ToolUse to a removed tool) doesn't
        // get reordered around a concurrent neighbour.
        let mut segments: Vec<Vec<usize>> = Vec::new();
        let mut current: Vec<usize> = Vec::new();
        for (idx, p) in pending.iter().enumerate() {
            if p.is_read_only {
                current.push(idx);
            } else {
                if !current.is_empty() {
                    segments.push(std::mem::take(&mut current));
                }
                segments.push(vec![idx]);
            }
        }
        if !current.is_empty() {
            segments.push(current);
        }

        // 4. Execute. Single-element segments stay sequential
        // (existing behaviour); multi-element read-only segments
        // fan out via buffer_unordered up to the configured limit.
        // Each segment yanks the `prebuilt` slot out of its pending
        // entries before fanning out — `Vec::take` can't be shared
        // across parallel futures, so we move ownership up-front and
        // hand each future its own `Option`.
        let limit = self.config.concurrent_tool_limit.max(1);
        let mut results: Vec<(usize, ContentBlock)> = Vec::with_capacity(pending.len());
        for seg in segments {
            // Take ownership of each segment's pending entries before
            // building futures so the parallel path doesn't need to
            // borrow the outer Vec.
            let mut seg_entries: Vec<Pending> = seg
                .iter()
                .map(|&i| Pending {
                    position: pending[i].position,
                    id: pending[i].id.clone(),
                    name: pending[i].name.clone(),
                    input: pending[i].input.clone(),
                    is_read_only: pending[i].is_read_only,
                    prebuilt: pending[i].prebuilt.take(),
                })
                .collect();

            if seg_entries.len() == 1 {
                let p = seg_entries.remove(0);
                let block = self
                    .run_one_to_block(
                        &p.id,
                        &p.name,
                        p.input,
                        assistant_msg_id,
                        tool_ctx,
                        gate,
                        tools,
                        p.prebuilt,
                    )
                    .await;
                results.push((p.position, block));
            } else {
                let futs = seg_entries.into_iter().map(|p| {
                    let position = p.position;
                    async move {
                        let block = self
                            .run_one_to_block(
                                &p.id,
                                &p.name,
                                p.input,
                                assistant_msg_id,
                                tool_ctx,
                                gate,
                                tools,
                                p.prebuilt,
                            )
                            .await;
                        (position, block)
                    }
                });
                let collected: Vec<(usize, ContentBlock)> = futures::stream::iter(futs)
                    .buffer_unordered(limit)
                    .collect()
                    .await;
                results.extend(collected);
            }
        }

        // 5. Restore original tool_use order; buffer_unordered may
        // have completed them out of order.
        results.sort_by_key(|(pos, _)| *pos);
        Ok(results.into_iter().map(|(_, b)| b).collect())
    }

    // 9 args is over clippy's 7 default. Each is independently
    // meaningful (no natural grouping); rolling them into a struct
    // would make the call site less readable.
    #[allow(clippy::too_many_arguments)]
    async fn run_one_to_block(
        &self,
        id: &ToolUseId,
        name: &str,
        input: Value,
        assistant_msg_id: &MessageId,
        tool_ctx: &ToolContext,
        gate: &dyn ApprovalGate,
        tools: &ToolRegistry,
        prebuilt: Option<ToolResult>,
    ) -> ContentBlock {
        // Every `tool_use` block in the assistant message MUST get a
        // corresponding `tool_result` (or `tool_error`) block,
        // otherwise providers like DeepSeek reject the next history
        // submission. So we catch every failure mode here and
        // synthesise a tool_error block instead of bubbling out.
        let outcome = self
            .execute_one(
                id,
                name,
                input,
                assistant_msg_id,
                tool_ctx,
                gate,
                tools,
                prebuilt,
            )
            .await;
        match outcome {
            Ok(Ok(out)) => {
                // Block-list outputs (Read on .pdf / image /
                // notebook) pass through straight as ToolResult
                // content. Text / Json collapse to a single text
                // block via render_text — the historical shape.
                let content = match out {
                    snaca_tools_api::ToolOutput::Blocks(bs) => bs,
                    other => vec![ContentBlock::text(other.render_text())],
                };
                ContentBlock::tool_result(id.clone(), content)
            }
            Ok(Err(e)) => {
                warn!(tool = %name, error = %e, "tool execution returned error");
                ContentBlock::tool_error(id.clone(), e.to_string())
            }
            Err(engine_err) => {
                warn!(
                    tool = %name,
                    error = %engine_err,
                    "engine-level error during tool dispatch; surfacing as tool_error"
                );
                ContentBlock::tool_error(id.clone(), format!("tool dispatch failed: {engine_err}"))
            }
        }
    }

    /// Decide whether `tool` may run for this `(tenant, project)` and
    /// `input`. Returns `Ok(None)` when the call is allowed; `Ok(Some(err))`
    /// when the gate denies (the engine surfaces `err` to the LLM as a
    /// tool_error block); `Err(EngineError::Approval)` when the gate itself
    /// failed (timeout, channel closed) — the whole turn fails fast.
    async fn gate_check(
        &self,
        tool: &dyn Tool,
        input: &Value,
        ctx: &ToolContext,
        gate: &dyn ApprovalGate,
    ) -> EngineResult<Option<ToolError>> {
        let requirement = tool.approval_requirement();
        if matches!(requirement, ApprovalRequirement::Never) {
            return Ok(None);
        }
        // Compute the per-input signature once up front — passed to
        // both the lookup (so AllowAlways for `Bash ls` doesn't
        // auto-approve `Bash rm -rf`) and the persist path on
        // AllowAlways. `find_decision` falls back to the empty-string
        // catch-all internally, so operator-installed "always allow
        // this tool" rules still match.
        let signature = input_signature(input);
        if matches!(requirement, ApprovalRequirement::UnlessRemembered) {
            if let Some(stored) = self
                .state
                .find_decision(ctx.tenant_id(), ctx.project_id(), tool.name(), &signature)
                .await?
            {
                debug!(
                    tool = tool.name(),
                    signature = stored.input_signature.as_str(),
                    decision = ?stored.decision,
                    "honoring remembered approval decision"
                );
                return Ok(match stored.decision {
                    PersistedDecision::Allow => None,
                    PersistedDecision::Deny => Some(ToolError::PermissionDenied(format!(
                        "{}: project policy denies this tool call",
                        tool.name()
                    ))),
                });
            }
        }

        // Either `Always` or `UnlessRemembered` with no remembered decision —
        // ask the gate.
        let request = ApprovalRequest {
            tenant_id: ctx.tenant_id().clone(),
            project_id: ctx.project_id().clone(),
            tool_name: tool.name().to_string(),
            tool_input: input.clone(),
            reason: tool.description().to_string(),
        };
        let decision = gate.request(request).await?;
        debug!(tool = tool.name(), decision = ?decision, "approval gate replied");

        match decision {
            ApprovalDecision::AllowOnce => Ok(None),
            ApprovalDecision::AllowAlways => {
                // Persist with the exact input signature, NOT the
                // catch-all. "Allow this Bash command always" is the
                // intuitive read of the IM card; "Allow every future
                // Bash call regardless of arguments" is a rule the
                // user would install deliberately via `/approve …`,
                // not pick up by accident from the gate path.
                if let Err(e) = self
                    .state
                    .remember_decision(
                        ctx.tenant_id(),
                        ctx.project_id(),
                        tool.name(),
                        &signature,
                        PersistedDecision::Allow,
                    )
                    .await
                {
                    warn!(tool = tool.name(), error = %e, "failed to persist approval decision");
                }
                Ok(None)
            }
            ApprovalDecision::Deny => Ok(Some(ToolError::PermissionDenied(format!(
                "{}: user denied this tool call",
                tool.name()
            )))),
        }
    }

    // 9 args is over clippy's 7 default. Each is independently
    // meaningful (no natural grouping); rolling them into a struct
    // would make the call site less readable.
    #[allow(clippy::too_many_arguments)]
    async fn execute_one(
        &self,
        id: &ToolUseId,
        name: &str,
        input: Value,
        assistant_msg_id: &MessageId,
        ctx: &ToolContext,
        gate: &dyn ApprovalGate,
        tools: &ToolRegistry,
        prebuilt: Option<ToolResult>,
    ) -> EngineResult<Result<ToolOutput, ToolError>> {
        let tool = match tools.get(name) {
            Some(t) => t,
            None => {
                // Unknown-tool failures are tool-level: surface as tool_error
                // so the model can pick a different tool.
                return Ok(Err(ToolError::NotFound(format!(
                    "tool '{name}' not registered"
                ))));
            }
        };

        // Approval check first: gate IO failures abort the turn, denials
        // become tool errors, allow falls through to execution. We
        // run gate_check even when `prebuilt` is `Some` so a stale
        // pre-run result can still be vetoed by a remembered Deny
        // rule — the eager dispatch only fires for `Never` tools,
        // but the rule landscape may have changed between iterations.
        if let Some(deny) = self.gate_check(tool.as_ref(), &input, ctx, gate).await? {
            return Ok(Err(deny));
        }

        // Best-effort audit; failures here become Other so the model still
        // sees a coherent tool result.
        if let Err(e) = self
            .state
            .record_tool_start(id, assistant_msg_id, name, &input)
            .await
        {
            warn!(tool=%name, error=%e, "failed to audit tool start");
        }

        let result = if let Some(cached) = prebuilt {
            debug!(tool = %name, id = id.as_str(), "consuming streamed tool prerun result");
            cached
        } else {
            tool.execute(input, ctx).await
        };

        let (audit_value, is_error) = match &result {
            Ok(out) => (
                match out {
                    ToolOutput::Text(t) => json!({"text": t}),
                    ToolOutput::Json(v) => v.clone(),
                    // Audit summary for block outputs: shape only, not
                    // bytes. Image base64 payloads can be hundreds of
                    // kilobytes and there's no value in persisting
                    // them in the tool_calls table.
                    ToolOutput::Blocks(bs) => {
                        let summary: Vec<serde_json::Value> = bs
                            .iter()
                            .map(|b| match b {
                                ContentBlock::Text { text } => {
                                    json!({"type": "text", "len": text.len()})
                                }
                                ContentBlock::Image { source } => {
                                    let media = match source {
                                        snaca_core::ImageSource::Url { .. } => "url",
                                        snaca_core::ImageSource::Base64 { media_type, .. } => {
                                            media_type.as_str()
                                        }
                                    };
                                    json!({"type": "image", "media": media})
                                }
                                _ => json!({"type": "other"}),
                            })
                            .collect();
                        json!({"blocks": summary})
                    }
                },
                false,
            ),
            Err(e) => (json!({"error": e.to_string()}), true),
        };
        if let Err(e) = self
            .state
            .record_tool_completion(id, &audit_value, is_error)
            .await
        {
            warn!(tool=%name, error=%e, "failed to audit tool completion");
        }
        Ok(result)
    }
}

/// Drain the outbound-file queue collected during a turn. Returns
/// an empty vec when no tool queued anything (the common case) or
/// when the lock is poisoned — losing a queue on a poisoned lock is
/// preferable to panicking the turn.
fn drain_outbound(slot: &Arc<Mutex<Vec<OutboundFile>>>) -> Vec<OutboundFile> {
    match slot.lock() {
        Ok(mut guard) => std::mem::take(&mut *guard),
        Err(_) => Vec::new(),
    }
}

/// Snapshot the schemas from a registry into the wire-friendly form the
/// LLM client expects. Pulled out as a free function so callers can
/// produce schemas off any registry, including the per-turn ones built
/// by the `RuntimeToolFactory`.
fn registry_schemas(tools: &ToolRegistry) -> Vec<ToolSchema> {
    tools
        .schemas()
        .iter()
        .map(|s| ToolSchema {
            name: s.name.clone(),
            description: s.description.clone(),
            input_schema: s.input_schema.clone(),
        })
        .collect()
}

/// Top-k cap for vector recall. Five matches tracks Claude Code's
/// default and keeps the prompt addition under a couple of hundred
/// tokens for typical entry sizes.
const RECALL_TOP_K: usize = 5;
/// Candidate pool size when a reranker is attached. Cosine pulls
/// `RECALL_POOL_SIZE`, the reranker filters down to `RECALL_TOP_K`.
/// Twenty is the plan default — enough headroom to recover the right
/// match when cosine ranks it 6th-10th, small enough that the LLM
/// rerank prompt stays under ~1k tokens.
const RECALL_POOL_SIZE: usize = 20;
/// Minimum cosine similarity to include in the recall block. Below this
/// the hit is more likely to confuse than to help — the LLM will treat
/// off-topic excerpts as authoritative if we splice them in.
const RECALL_MIN_SCORE: f32 = 0.10;
/// Hard ceiling on the rendered recall block in bytes. Stops the system
/// prompt from ballooning when a project has a few very long memories.
const RECALL_MAX_BYTES: usize = 4 * 1024;
/// Per-entry excerpt length. Longer entries are truncated mid-sentence
/// with an ellipsis — the model can MemoryRead the full body if needed.
const RECALL_EXCERPT_BYTES: usize = 400;
/// How many recently-surfaced memory entries to keep in the per-thread
/// dedup ring. At `RECALL_TOP_K = 5` this is ~4 turns of recall before
/// an entry rolls off and can resurface — long enough that consecutive
/// turns on related topics don't re-show the same hits, short enough
/// that resuming a topic dropped 10+ turns ago still re-surfaces. The
/// ring lives in memory only; process restart resets it.
const SURFACED_RING_CAP: usize = 20;

/// Build the per-turn system prompt as ordered, cache-aware segments.
///
/// - **Segment 1 (cacheable)** — base prompt + MEMORY.md index. Stable
///   within a thread, so Anthropic's prompt cache holds the prefix.
///   MEMORY.md changing invalidates it exactly once.
/// - **Segment 2 (volatile)** — the `## Relevant Memories` block. Keyed
///   by the user's query (changes every turn), so it's excluded from
///   any cache breakpoint to avoid silently invalidating the prefix.
///
/// Empty sections collapse the segment list.
fn compose_system_segments(base: &str, index: &str, recall: &str) -> Vec<SystemSegment> {
    let mut stable = String::from(base);
    if !index.trim().is_empty() {
        stable.push_str(
            "\n\n---\n\n## Project Memory\n\n\
             The following memory entries are stored for this project. Use the \
             `MemoryRead` tool with `scope` and `name` to read any entry's full \
             content. Do not assume content beyond what's in the index below.\n\n",
        );
        stable.push_str(index.trim());
    }
    let mut segs: Vec<SystemSegment> = vec![SystemSegment::cacheable(stable)];
    if !recall.trim().is_empty() {
        let mut volatile = String::from(
            "\n\n---\n\n## Relevant Memories (auto-retrieved)\n\n\
             The following excerpts were pulled from memory by similarity to the \
             user's request. Treat them as hints — the full content is one \
             `MemoryRead` call away.\n\n",
        );
        volatile.push_str(recall.trim());
        segs.push(SystemSegment::volatile(volatile));
    }
    segs
}

#[cfg(test)]
mod system_prompt_tests {
    use super::*;

    #[test]
    fn segments_split_stable_prefix_from_volatile_recall() {
        // base + memory go in one cacheable segment, recall lives in
        // its own volatile segment. If anyone collapses these the
        // prompt cache silently breaks.
        let segs = compose_system_segments("BASE", "user/foo — bar", "hit one");
        assert_eq!(segs.len(), 2, "expected stable + volatile, got {segs:?}");
        assert!(segs[0].cacheable, "first segment must be cacheable");
        assert!(segs[0].text.contains("BASE"));
        assert!(segs[0].text.contains("## Project Memory"));
        assert!(segs[0].text.contains("user/foo — bar"));
        assert!(!segs[0].text.contains("Relevant Memories"));
        assert!(!segs[1].cacheable, "second segment must be volatile");
        assert!(segs[1].text.contains("## Relevant Memories"));
        assert!(segs[1].text.contains("hit one"));
    }

    #[test]
    fn segments_collapse_when_no_recall() {
        let segs = compose_system_segments("BASE", "user/foo", "");
        assert_eq!(segs.len(), 1, "no recall => single segment");
        assert!(segs[0].cacheable);
        assert!(segs[0].text.contains("BASE"));
        assert!(segs[0].text.contains("user/foo"));
    }

    #[test]
    fn segments_collapse_when_no_memory_and_no_recall() {
        let segs = compose_system_segments("BASE", "", "");
        assert_eq!(segs.len(), 1);
        assert!(segs[0].cacheable);
        assert!(!segs[0].text.contains("## Project Memory"));
    }
}

/// Truncate `s` to roughly `max_bytes`, ending on a word boundary when
/// possible. Adds a `…` marker when truncated. UTF-8-safe: backs up to
/// the nearest char boundary instead of slicing mid-codepoint.
fn excerpt(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut cut = max_bytes;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    // Prefer trimming back to the previous whitespace so we don't end
    // mid-word.
    let head = &s[..cut];
    let trim_to = head.rfind(char::is_whitespace).unwrap_or(cut);
    let prefix = head[..trim_to].trim_end();
    format!("{prefix} …")
}

/// Drop the oldest messages until the serialised content size of the
/// remainder is under `max_bytes`. Last-resort safety net so a giant
/// import (PDF/DOCX text dump in a tool_result, a long compaction
/// summary, …) can't push the LLM call past the provider's context
/// window. `EngineConfig::compact_after_input_tokens` is the preferred
/// path; this exists for the gap between "context filled" and "next
/// turn fires compaction".
///
/// Pure helper — no I/O, no async, easy to unit-test.
/// Result map populated by streaming tool pre-execution. Keys are the
/// `tool_use_id` of each pre-run tool call; values are the raw
/// `Tool::execute` outputs (or errors). The post-stream tool pass
/// drains this map — entries present are used verbatim, the rest go
/// through the normal sequential / parallel path.
pub type PrerunCache = HashMap<ToolUseId, ToolResult>;

/// Partial state for one in-flight tool_use block during streaming.
/// Owns its strings so the engine doesn't need to hold the stream
/// open while reasoning about whether to dispatch.
struct StreamToolUse {
    id: String,
    name: String,
    args: String,
}

/// Whether `name` resolves in the registry to a tool that is safe to
/// pre-run during streaming: registered, read-only, approval-free.
/// Shared between the eligibility check (decides whether to spawn) and
/// the write-barrier decision (decides whether the rest of this turn's
/// tool calls must wait for the post-stream pass) so they always agree.
fn is_streamable_tool(name: &str, tools: &ToolRegistry) -> bool {
    let Some(tool) = tools.get(name) else {
        return false;
    };
    tool.is_read_only() && matches!(tool.approval_requirement(), ApprovalRequirement::Never)
}

/// Stable short fingerprint of a tool input. Used to key remembered
/// approval decisions so "Allow always" only applies to the exact
/// input the user approved (not every future call to the same tool).
///
/// The hash is over a *canonical* JSON serialisation — keys sorted at
/// every object level — so two equivalent inputs that happened to be
/// serialised in different key orders by the provider still resolve
/// to the same signature. 16 hex chars = 64 bits ≈ negligible
/// collision risk inside a single project's tool-call history.
pub fn input_signature(input: &Value) -> String {
    let mut buf = String::new();
    write_canonical(input, &mut buf);
    let hash = blake3::hash(buf.as_bytes());
    hash.to_hex()[..16].to_string()
}

fn write_canonical(v: &Value, buf: &mut String) {
    match v {
        Value::Null => buf.push_str("null"),
        Value::Bool(b) => buf.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => buf.push_str(&n.to_string()),
        Value::String(s) => {
            // Reuse serde_json's string escaping rather than reinvent.
            if let Ok(escaped) = serde_json::to_string(s) {
                buf.push_str(&escaped);
            }
        }
        Value::Array(arr) => {
            buf.push('[');
            for (i, item) in arr.iter().enumerate() {
                if i > 0 {
                    buf.push(',');
                }
                write_canonical(item, buf);
            }
            buf.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            buf.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    buf.push(',');
                }
                if let Ok(escaped) = serde_json::to_string(k) {
                    buf.push_str(&escaped);
                }
                buf.push(':');
                write_canonical(&map[*k], buf);
            }
            buf.push('}');
        }
    }
}

/// Built-in read-only tools whose results are safe to collapse in
/// older history. Hard-coded rather than threaded through from the
/// registry because this function runs in contexts (compaction
/// summariser, history load) where the registry isn't available, and
/// the set is small and stable. MCP and skill tools deliberately
/// stay verbatim — without per-tool metadata we can't tell side
/// effects from pure reads, and false positives lose audit trail.
pub const COLLAPSIBLE_TOOL_NAMES: &[&str] =
    &["Read", "Grep", "Glob", "LS", "MemoryRead", "TaskOutput"];

fn is_collapsible_tool(name: &str) -> bool {
    COLLAPSIBLE_TOOL_NAMES.contains(&name)
}

/// Replace the body of `ToolResult` blocks for old read-only tool
/// calls with a short marker. Preserves the `tool_use_id` and
/// `is_error` flag so the assistant → tool pairing the providers
/// require stays well-formed; only the inner text content is shrunk.
///
/// `keep_recent` messages at the tail are left verbatim — the model
/// usually references the most recent results in the very next turn.
/// `threshold` is the minimum total text size (bytes) that triggers
/// collapse; smaller results stay as-is. `threshold = 0` disables.
///
/// Errors are *not* collapsed: failure messages are usually small
/// and always load-bearing for next-step decisions.
pub fn collapse_old_tool_results(
    messages: Vec<Message>,
    keep_recent: usize,
    threshold: usize,
) -> Vec<Message> {
    if threshold == 0 || messages.len() <= keep_recent + 1 {
        return messages;
    }
    let cutoff = messages.len() - keep_recent;

    // First pass: build tool_use_id → tool_name across the *whole*
    // history. The pairing can span the cutoff (assistant tool_use
    // in old turn, tool message right at the cutoff) — we still want
    // to look up the name from anywhere.
    let mut name_by_id: HashMap<String, String> = HashMap::new();
    for m in &messages {
        for b in &m.content {
            if let ContentBlock::ToolUse { id, name, .. } = b {
                name_by_id.insert(id.as_str().to_string(), name.clone());
            }
        }
    }

    messages
        .into_iter()
        .enumerate()
        .map(|(i, m)| {
            if i >= cutoff {
                return m;
            }
            let collapsed: Vec<ContentBlock> = m
                .content
                .into_iter()
                .map(|b| collapse_block_if_old_read(b, &name_by_id, threshold))
                .collect();
            Message {
                content: collapsed,
                ..m
            }
        })
        .collect()
}

fn collapse_block_if_old_read(
    block: ContentBlock,
    name_by_id: &HashMap<String, String>,
    threshold: usize,
) -> ContentBlock {
    let ContentBlock::ToolResult {
        tool_use_id,
        content,
        is_error,
    } = block
    else {
        return block;
    };
    // Never collapse errors — they're small and load-bearing.
    if is_error {
        return ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error,
        };
    }
    let tool_name = name_by_id
        .get(tool_use_id.as_str())
        .map(|s| s.as_str())
        .unwrap_or("");
    if !is_collapsible_tool(tool_name) {
        return ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error,
        };
    }
    let total: usize = content
        .iter()
        .map(|c| match c {
            ContentBlock::Text { text } => text.len(),
            _ => 0,
        })
        .sum();
    if total < threshold {
        return ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error,
        };
    }
    ContentBlock::ToolResult {
        tool_use_id,
        content: vec![ContentBlock::text(format!(
            "<{tool_name} result: {total} bytes elided to save context; \
             call again if you need the full body>"
        ))],
        is_error,
    }
}

pub(crate) fn enforce_history_byte_cap(
    mut messages: Vec<Message>,
    max_bytes: usize,
) -> Vec<Message> {
    if max_bytes == 0 || messages.is_empty() {
        return messages;
    }
    let mut total = messages_byte_size(&messages);
    let original_len = messages.len();
    while total > max_bytes && messages.len() > 1 {
        let dropped = messages.remove(0);
        total = total.saturating_sub(message_byte_size(&dropped));
    }
    // After byte-trimming, the new head must NOT be a `Role::Tool`
    // message — providers reject `tool` messages that don't follow an
    // assistant `tool_use`. Drop leading orphans the same way.
    while messages
        .first()
        .map(|m| matches!(m.role, Role::Tool))
        .unwrap_or(false)
    {
        messages.remove(0);
    }
    let kept = messages.len();
    if kept != original_len {
        warn!(
            dropped = original_len - kept,
            kept,
            cap_bytes = max_bytes,
            "history-load: dropped oldest messages to fit byte cap"
        );
    }
    messages
}

fn messages_byte_size(msgs: &[Message]) -> usize {
    msgs.iter().map(message_byte_size).sum()
}

fn message_byte_size(m: &Message) -> usize {
    let mut n = 0usize;
    for b in &m.content {
        match b {
            ContentBlock::Text { text } => n += text.len(),
            ContentBlock::Thinking { text, .. } => n += text.len(),
            ContentBlock::ToolUse { name, input, .. } => {
                n += name.len();
                n += serde_json::to_string(input).map(|s| s.len()).unwrap_or(0);
            }
            ContentBlock::ToolResult { content, .. } => {
                for inner in content {
                    if let ContentBlock::Text { text } = inner {
                        n += text.len();
                    }
                }
            }
            ContentBlock::Image { .. } => {
                // Synthetic constant — image references don't carry
                // bytes inline, but tokens count differently. Pick a
                // safe estimate.
                n += 1024;
            }
        }
    }
    n
}

/// Walk `messages` chronologically and ensure every assistant `tool_use`
/// block is followed by a matching `tool_result` (or `tool_error`)
/// somewhere downstream. When an orphan is found, splice in a
/// synthetic `Role::Tool` message right after the offending assistant
/// turn so the wire format stays well-formed.
///
/// Why this is necessary: providers like DeepSeek (and Anthropic)
/// reject any history submission whose `tool_calls` aren't all
/// answered. We persist each turn's pieces incrementally, so a crash
/// or transient gate failure between "assistant tool_use written" and
/// "tool_result written" leaves the DB in a state the next turn can't
/// load. M2's solution was to abort the engine on those failures; M3
/// switched to "every tool_use produces a result block" but legacy
/// rows from older builds still need patching at load time.
fn repair_orphan_tool_uses(messages: Vec<Message>) -> Vec<Message> {
    use std::collections::HashSet;
    let mut out: Vec<Message> = Vec::with_capacity(messages.len());
    let mut iter = messages.into_iter().peekable();
    while let Some(msg) = iter.next() {
        // Drop any leading or unattached tool message — providers
        // reject a tool block that doesn't follow an assistant
        // tool_use. The byte-cap trim usually catches the leading
        // case; this second pass handles a tool message that ends up
        // sandwiched between two non-assistants (e.g. user → tool →
        // user, which can result from orphan-id assistant repair
        // dropping the wrong side).
        if matches!(msg.role, Role::Tool) {
            let last_was_assistant_with_tool_use = out
                .last()
                .map(|prev| {
                    matches!(prev.role, Role::Assistant)
                        && prev
                            .content
                            .iter()
                            .any(|b| matches!(b, ContentBlock::ToolUse { .. }))
                })
                .unwrap_or(false);
            if !last_was_assistant_with_tool_use {
                warn!("history-load: dropping orphan tool message with no preceding assistant tool_use");
                continue;
            }
        }

        let assistant_tool_uses: Vec<String> = if matches!(msg.role, Role::Assistant) {
            msg.content
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::ToolUse { id, .. } => Some(id.as_str().to_string()),
                    _ => None,
                })
                .collect()
        } else {
            Vec::new()
        };

        out.push(msg);

        if assistant_tool_uses.is_empty() {
            continue;
        }
        // Look at the very next message: if it's a Tool message,
        // collect the tool_use_ids it answers. Anything missing
        // becomes a synthetic tool_error block we splice in. If the
        // next message *isn't* a Tool message, every tool_use is
        // orphaned.
        let answered: HashSet<String> = if matches!(iter.peek().map(|m| m.role), Some(Role::Tool)) {
            iter.peek()
                .map(|m| {
                    m.content
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::ToolResult { tool_use_id, .. } => {
                                Some(tool_use_id.as_str().to_string())
                            }
                            _ => None,
                        })
                        .collect()
                })
                .unwrap_or_default()
        } else {
            HashSet::new()
        };
        let missing: Vec<String> = assistant_tool_uses
            .into_iter()
            .filter(|id| !answered.contains(id))
            .collect();
        if missing.is_empty() {
            continue;
        }
        warn!(
            count = missing.len(),
            "history-load: synthesising tool_error blocks for orphan tool_use ids"
        );
        // Build a synthetic tool message holding tool_error for each
        // missing id. If the next message is already a Tool message,
        // merge into it instead of creating a new one — keeps the
        // history compact.
        let synthetic: Vec<ContentBlock> = missing
            .into_iter()
            .map(|id| {
                ContentBlock::tool_error(
                    snaca_core::ToolUseId::new(id),
                    "tool execution interrupted (orphan tool_use repaired at load time)"
                        .to_string(),
                )
            })
            .collect();
        if matches!(iter.peek().map(|m| m.role), Some(Role::Tool)) {
            // Pop the existing tool message, append the synthetic
            // blocks, push it back.
            let mut next = iter.next().expect("peeked Some");
            next.content.extend(synthetic);
            out.push(next);
        } else {
            out.push(Message {
                id: MessageId::new(),
                role: Role::Tool,
                content: synthetic,
                created_at: Utc::now(),
            });
        }
    }
    out
}

/// Flatten a slice of messages into a transcript the summariser
/// can read in one shot. We deliberately drop tool-use payloads beyond
/// their names — the summary just needs to know "the assistant called
/// Read on file X", not the full byte stream of the result.
///
/// Takes `&[Message]` rather than the raw `MessageRow` so callers can
/// pre-run `collapse_old_tool_results` against the input — both paths
/// (compaction summary, live load) get the same view.
fn render_for_summary(rows: &[Message]) -> String {
    let mut out = String::new();
    for r in rows {
        let label = match r.role {
            Role::User => "USER",
            Role::Assistant => "ASSISTANT",
            Role::Tool => "TOOL",
            Role::System => "SYSTEM",
        };
        out.push_str(label);
        out.push_str(": ");
        for block in &r.content {
            match block {
                ContentBlock::Text { text } => out.push_str(text),
                ContentBlock::Thinking { text, .. } => {
                    out.push_str("[thinking] ");
                    out.push_str(text);
                }
                ContentBlock::ToolUse { name, input, .. } => {
                    out.push_str(&format!(
                        "[called tool {} with {}]",
                        name,
                        serde_json::to_string(input).unwrap_or_default()
                    ));
                }
                ContentBlock::ToolResult {
                    content, is_error, ..
                } => {
                    let prefix = if *is_error {
                        "[tool error]"
                    } else {
                        "[tool result]"
                    };
                    out.push_str(prefix);
                    out.push(' ');
                    for inner in content {
                        if let ContentBlock::Text { text } = inner {
                            out.push_str(text);
                        }
                    }
                }
                ContentBlock::Image { .. } => out.push_str("[image]"),
            }
            out.push(' ');
        }
        out.push('\n');
    }
    out
}

// `Utc` use kept silenced — we may need it for future M2 cycle accounting.
#[allow(dead_code)]
fn _utc_anchor() -> chrono::DateTime<Utc> {
    Utc::now()
}

/// True when an `LlmError` looks like the provider rejecting the
/// request because the prompt exceeds the model's context window.
/// Different vendors phrase this differently — we look for any of the
/// common substrings on the wire body or the error message. The
/// alternative (parsing structured error codes) requires per-provider
/// branches that miss new providers; substring matching catches
/// Anthropic, DeepSeek, OpenAI, and any clone speaking compatible
/// error envelopes today.
pub(crate) fn is_context_length_error(err: &LlmError) -> bool {
    // (1) Structured signal — the LLM crate's classifier already
    // identified this as a context-window overflow. Always wins over
    // the substring fallback below.
    if matches!(err, LlmError::ContextOverflow) {
        return true;
    }
    // (2) Substring fallback for older error shapes the classifier
    // didn't route to `ContextOverflow` (legacy `HttpStatus` /
    // `Provider` envelopes, unknown providers). Lowercased once per
    // check; the haystacks are short.
    let haystack = match err {
        LlmError::HttpStatus { status, body } => {
            // 4xx + length hint = recoverable; 5xx is a server problem
            // we shouldn't paper over with compaction.
            if !(*status >= 400 && *status < 500) {
                return false;
            }
            body.to_ascii_lowercase()
        }
        LlmError::Provider { message, .. } => message.to_ascii_lowercase(),
        LlmError::MalformedResponse(s) | LlmError::Other(s) => s.to_ascii_lowercase(),
        _ => return false,
    };
    // Each phrase appears in at least one shipping provider's error
    // body. Keep them anchored enough to avoid false positives on
    // ordinary text (`"too long"` alone would match a prompt about
    // any long thing the model talked about).
    const HINTS: &[&str] = &[
        "prompt is too long",
        "prompt too long",
        "input is too long",
        "context length",
        "context_length_exceeded",
        "maximum context",
        "too many tokens",
        "request too large",
        "input length exceeds",
    ];
    HINTS.iter().any(|h| haystack.contains(h))
}

#[cfg(test)]
mod context_length_tests {
    use super::*;

    #[test]
    fn matches_anthropic_phrasing() {
        let e = LlmError::HttpStatus {
            status: 400,
            body: r#"{"error":{"type":"invalid_request_error","message":"prompt is too long: 220000 tokens > 200000 maximum"}}"#.to_string(),
        };
        assert!(is_context_length_error(&e));
    }

    #[test]
    fn matches_openai_phrasing() {
        let e = LlmError::HttpStatus {
            status: 400,
            body: "This model's maximum context length is 128000 tokens. However, ...".to_string(),
        };
        assert!(is_context_length_error(&e));
    }

    #[test]
    fn matches_deepseek_phrasing() {
        let e = LlmError::Provider {
            code: "context_length_exceeded".into(),
            message: "too many tokens in request".into(),
        };
        assert!(is_context_length_error(&e));
    }

    #[test]
    fn does_not_match_unrelated_4xx() {
        let e = LlmError::HttpStatus {
            status: 401,
            body: "invalid api key".to_string(),
        };
        assert!(!is_context_length_error(&e));
    }

    #[test]
    fn does_not_match_5xx_with_length_words() {
        // Server errors aren't recoverable via compaction even if the
        // body mentions length — the issue is upstream, not us.
        let e = LlmError::HttpStatus {
            status: 503,
            body: "context length subsystem temporarily unavailable".to_string(),
        };
        assert!(!is_context_length_error(&e));
    }

    #[test]
    fn matches_structured_context_overflow() {
        // The classifier in `snaca-llm` maps prompt-too-long bodies
        // straight to `ContextOverflow`. The substring fallback is no
        // longer the load-bearing path — the variant alone is enough.
        assert!(is_context_length_error(&LlmError::ContextOverflow));
    }
}
