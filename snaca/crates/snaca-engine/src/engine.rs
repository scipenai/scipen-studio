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
use crate::question_gate::{NoopQuestionGate, QuestionGate, QuestionGateSlot};
use crate::tools_factory::RuntimeToolFactory;
use chrono::Utc;
use futures::StreamExt;
use serde_json::{json, Value};
use snaca_agent_api::{MemoryIndexRequest, MemoryProvider, MemoryProviderSlot, MemoryWriteRequest};
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
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

/// scipen-studio fork: builds a per-turn reverse-RPC `ContextRequester`
/// bound to the turn id. Registered via [`Engine::with_context_requester_factory`].
pub type ContextRequesterFactory =
    Arc<dyn Fn(String) -> Arc<dyn ContextRequester> + Send + Sync>;

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
    /// scipen-studio fork: per-turn ephemeral system context, appended as
    /// a *volatile* segment after the cacheable prefix. Hosts use it to
    /// inject volatile ambient state (the editor's active file / selection).
    /// `None` keeps the turn identical to having no extra context.
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

#[derive(Debug, Clone)]
struct ToolFailureEvent {
    tool: String,
    input: Value,
    input_signature: String,
    error: String,
}

#[derive(Debug, Default)]
struct ToolBatchResult {
    blocks: Vec<ContentBlock>,
    failures: Vec<ToolFailureEvent>,
}

#[derive(Debug)]
struct ToolBlockOutcome {
    block: ContentBlock,
    failure: Option<ToolFailureEvent>,
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
    /// Optional memory extractor. When attached, the engine fires it
    /// on a background task after every successful turn; proposals are
    /// written through the project's `MemoryStore`. None disables
    /// extraction.
    extractor: Option<crate::memory_extractor::SharedExtractor>,
    /// Optional SDK-level memory provider. When attached, MemoryRead /
    /// MemoryWrite tools use this provider instead of deriving the
    /// file-tree store from `workspace_root`; system-prompt index also
    /// prefers this provider. None keeps the historical file-tree
    /// memory behavior.
    memory_provider: Option<Arc<dyn MemoryProvider>>,
    /// Optional background-task registry. When attached, Bash's
    /// `run_in_background = true` path can spawn long-lived tasks
    /// whose status is polled via the TaskOutput tool. Held as an
    /// opaque Arc so the engine doesn't need to know the concrete
    /// type (it lives in `snaca-tools`).
    task_registry: Option<Arc<dyn std::any::Any + Send + Sync>>,
    /// scipen-studio fork: per-turn factory building a reverse-RPC
    /// `ContextRequester` (Zotero) injected into the tool `ToolContext`.
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
    /// Per-thread Read tracker — shared across turns on the same
    /// thread. Each `ReadTracker` is itself `Arc<Mutex<HashMap<...>>>`,
    /// so the engine just hands the same Arc to every turn on a given
    /// thread and Edit/MultiEdit's "Read before Edit" gate accumulates
    /// across user interrupts. Without this, every user message
    /// ("你怎么样了？") reset the tracker and forced the model to
    /// re-Read large files just to satisfy the gate — which is exactly
    /// the wedged-model loop `loop_guard` was tripping on.
    /// Mtime/size validation in edit.rs catches files that changed on
    /// disk; the model's own "old_string not found" feedback handles
    /// the case where it has forgotten the file from its context.
    /// In-memory only — process restart drops trackers, which is
    /// acceptable: the worst case is the model has to Read again.
    read_trackers: Arc<Mutex<HashMap<ThreadId, snaca_tools_api::ReadTracker>>>,
    /// Per-thread one-shot hint about the previous turn's loop_guard
    /// trip. Set when `run_tool_calls` aborts a turn for repeated
    /// identical tool calls; the next turn's system prompt picks it up
    /// and tells the model "don't repeat the same call", then clears
    /// it. Without this nudge, the next turn often re-walks into the
    /// same loop because nothing in its context names the failure.
    loop_guard_hints: Arc<Mutex<HashMap<ThreadId, LoopGuardHint>>>,
    /// Per-project async lock for the memory extractor. Two
    /// `spawn_memory_extraction` tasks on the same project would
    /// otherwise race on `MemoryStore::regenerate_index` (last writer
    /// wins on `MEMORY.md`) and on same-name entry files. The lock
    /// serialises writes per project while still letting different
    /// projects (different chats sharing a bot) extract in parallel.
    /// Held across awaits, so it's a `tokio::sync::Mutex`; the outer
    /// `std::sync::Mutex` only guards the map's entry/insert and is
    /// released before any await.
    extraction_locks: Arc<Mutex<HashMap<ProjectId, Arc<tokio::sync::Mutex<()>>>>>,
    /// Per-thread frozen memory snapshot. Computed lazily on the
    /// first turn that needs the system prompt; reused verbatim
    /// across every subsequent turn on the same thread so the
    /// LLM provider's prompt-prefix cache holds. `MemoryWrite`
    /// tool calls and the post-turn extractor still hit disk —
    /// in-session writes only become visible on the next thread.
    /// Process-restart resets the cache; the next first turn
    /// re-renders.
    memory_snapshots: Arc<Mutex<HashMap<ThreadId, Arc<String>>>>,
    /// Per-project file-tree memory stores shared by MemoryRead /
    /// MemoryWrite tool calls. `MemoryStore` carries the last-seen
    /// hashes used for external-drift detection, so constructing a
    /// fresh store for every tool call would make the check toothless.
    /// Process-local only; restart trusts the current disk state.
    memory_stores: Arc<Mutex<HashMap<(String, String), snaca_memory::MemoryStore>>>,
}

/// One-shot hint about a loop_guard trip, injected into the next
/// turn's system prompt so the model can break out of the loop.
/// Short by design — the snippet is only enough for the model to
/// recognise the call it should avoid repeating, not a transcript.
#[derive(Debug, Clone)]
struct LoopGuardHint {
    tool: String,
    input_snippet: String,
    count: usize,
}

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
            extractor: None,
            memory_provider: None,
            task_registry: None,
            context_requester_factory: None,
            inflight: Arc::new(Mutex::new(HashMap::new())),
            read_trackers: Arc::new(Mutex::new(HashMap::new())),
            loop_guard_hints: Arc::new(Mutex::new(HashMap::new())),
            extraction_locks: Arc::new(Mutex::new(HashMap::new())),
            memory_snapshots: Arc::new(Mutex::new(HashMap::new())),
            memory_stores: Arc::new(Mutex::new(HashMap::new())),
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

    /// Attach a runtime tool factory. The engine will call
    /// `factory.build(tenant, project)` once at the start of every turn
    /// and use the returned registry instead of the static one passed to
    /// `Engine::new`.
    pub fn with_tool_factory(mut self, factory: Arc<dyn RuntimeToolFactory>) -> Self {
        self.tool_factory = Some(factory);
        self
    }

    /// Attach a memory provider. Built-in memory tools, project
    /// memory index injection, and extractor writes prefer this
    /// provider. Without one, the engine uses the existing file-tree
    /// memory store under `WorkspaceLayout`.
    pub fn with_memory_provider(mut self, provider: Arc<dyn MemoryProvider>) -> Self {
        self.memory_provider = Some(provider);
        self
    }

    /// scipen-studio fork: attach a per-turn `ContextRequester` factory
    /// (Zotero reverse-RPC to the editor host).
    pub fn with_context_requester_factory(mut self, factory: ContextRequesterFactory) -> Self {
        self.context_requester_factory = Some(factory);
        self
    }

    /// Stage an attachment in the project's workspace dir. The bytes
    /// land at `<workspace>/<basename(filename)>` so the `Read` /
    /// `Glob` / `Bash` tools can open the file by name. Returns the
    /// final path on success.
    ///
    /// Filename is sanitised to its basename — directory components
    /// are stripped before write, defending against a malicious /
    /// buggy plugin sending `../escape.txt`. Empty / dot-only names
    /// fall back to `attachment.bin`.
    ///
    /// Note: this used to also push the bytes through a chunk, embed,
    /// and memory-vector pipeline. That pipeline was removed when the
    /// engine adopted the frozen-snapshot memory model — attachments
    /// no longer auto-populate the memory tree. The dispatch layer
    /// surfaces the staged file in the next turn's user message
    /// (filename + size + optional preview); the LLM decides whether
    /// to persist anything via `MemoryWrite`.
    pub async fn stage_attachment(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
        bytes: &[u8],
        filename: &str,
    ) -> std::io::Result<std::path::PathBuf> {
        self.workspace
            .ensure_project(tenant, project)
            .map_err(|e| std::io::Error::other(format!("ensure_project failed: {e}")))?;

        let basename = std::path::Path::new(filename)
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty() && *s != "." && *s != "..")
            .unwrap_or("attachment.bin");
        let target = self.workspace.workspace_dir(tenant, project).join(basename);
        tokio::fs::write(&target, bytes).await.map_err(|e| {
            warn!(
                error = %e,
                path = %target.display(),
                "attachment workspace drop failed"
            );
            e
        })?;
        debug!(
            path = %target.display(),
            bytes = bytes.len(),
            "attachment dropped into workspace"
        );
        Ok(target)
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
        self.handle_turn_full(
            req,
            gate,
            Arc::new(NoopListener),
            Arc::new(NoopQuestionGate),
        )
        .await
    }

    /// Run a single turn with both an approval gate and a per-event
    /// listener. The listener observes every [`snaca_llm::StreamEvent`]
    /// produced by the LLM round trips inside this turn — used by IM
    /// channels to render typing indicators / `update_message` deltas
    /// while the turn is still in flight.
    ///
    /// `question_gate` is consulted only by the `AskUserQuestion` tool
    /// (when registered). Direct-embed deployments without an IM
    /// channel pass `Arc::new(NoopQuestionGate)`; that gate returns
    /// `Unsupported` so the tool surfaces a clean tool_error rather
    /// than hanging.
    pub async fn handle_turn_full(
        &self,
        req: TurnRequest,
        gate: Arc<dyn ApprovalGate>,
        listener: Arc<dyn TurnEventListener>,
        question_gate: Arc<dyn QuestionGate>,
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
        // Per-thread Read tracker. Edit / MultiEdit consult this to
        // enforce "Read before Edit" and to detect external
        // modifications between Read and Edit. Shared across turns
        // on the same thread so a "how's it going?" mid-task ping
        // doesn't reset the gate and force the model to re-Read.
        // edit.rs revalidates mtime/size on every call, so a file
        // that changed on disk between turns still gets caught.
        let read_tracker: snaca_tools_api::ReadTracker = {
            let mut map = self
                .read_trackers
                .lock()
                .expect("read_trackers mutex poisoned");
            map.entry(thread_id.clone())
                .or_insert_with(|| Arc::new(Mutex::new(std::collections::HashMap::new())))
                .clone()
        };
        let mut tool_ctx = ToolContext::new(
            tenant_id.clone(),
            project_id.clone(),
            session_id,
            workspace_root,
        )
        .with_outbound_files(outbound_slot.clone())
        .with_read_tracker(read_tracker)
        .with_cancellation_token(cancel_token.clone())
        .with_db_handle(Arc::new(self.state.clone()) as Arc<dyn std::any::Any + Send + Sync>)
        .with_memory_write_approval(self.config.memory_write_approval);
        let shared_memory_store = {
            let key = (
                tenant_id.as_str().to_string(),
                project_id.as_str().to_string(),
            );
            let mut map = self
                .memory_stores
                .lock()
                .expect("memory_stores mutex poisoned");
            map.entry(key)
                .or_insert_with(|| {
                    snaca_memory::MemoryStore::new(
                        self.workspace.memory_dir(&tenant_id, &project_id),
                    )
                })
                .clone()
        };
        tool_ctx = tool_ctx.with_memory_store(
            Arc::new(shared_memory_store) as Arc<dyn std::any::Any + Send + Sync>
        );
        // Bash run_in_background + TaskOutput / TaskStop share a
        // process-wide registry attached to the engine. When not
        // attached the companion tools surface a clear "no registry"
        // error instead of silently degrading.
        if let Some(reg) = self.task_registry.clone() {
            tool_ctx = tool_ctx.with_task_registry(reg);
        }
        if let Some(provider) = self.memory_provider.clone() {
            tool_ctx = tool_ctx
                .with_memory_provider(Arc::new(MemoryProviderSlot::new(provider))
                    as Arc<dyn std::any::Any + Send + Sync>);
        }
        // Question gate goes in as `Arc<QuestionGateSlot>` (a `Sized`
        // wrapper around `Arc<dyn QuestionGate>`) because Rust won't
        // coerce one trait object to another (`dyn QuestionGate` →
        // `dyn Any`). The AskUserQuestion tool downcasts back to
        // `QuestionGateSlot`. NoopQuestionGate is fine here too — the
        // tool just surfaces a clean tool_error on Unsupported.
        tool_ctx = tool_ctx
            .with_question_gate(Arc::new(QuestionGateSlot::new(question_gate.clone()))
                as Arc<dyn std::any::Any + Send + Sync>);
        // scipen-studio fork: per-turn reverse-RPC channel for the Zotero
        // context tools. Absent factory => tools return a clean error.
        if let Some(factory) = self.context_requester_factory.clone() {
            tool_ctx = tool_ctx.with_context_requester(factory(turn_message_id.clone()));
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
                    turn_id: Some(turn_message_id.clone()),
                })
                .await?;

            // 4–5. agent loop.
            // The tool registry is composed once per turn (per tenant + project).
            // Calling the factory per iteration would be redundant and lose the
            // schema cache between rounds.
            let runtime_tools = self.runtime_tools(&tenant_id, &project_id).await;
            let tool_schemas = registry_schemas(&runtime_tools);
            // Build the per-turn system prompt by splicing in the
            // per-thread frozen memory snapshot. Memory writes made
            // later in the same thread stay on disk until a new thread
            // or explicit invalidation refreshes the snapshot.
            // Drain a one-shot loop_guard hint if the previous turn on
            // this thread tripped the guard. None on the common path.
            let loop_guard_hint = self
                .loop_guard_hints
                .lock()
                .ok()
                .and_then(|mut m| m.remove(&thread_id));
            let base_system_segments = self
                .system_prompt_for(
                    &tenant_id,
                    &project_id,
                    &thread_id,
                    &turn_query,
                    loop_guard_hint.as_ref(),
                )
                .await;
            // scipen-studio fork: splice the host's per-turn ephemeral
            // context onto the tail as a *volatile* segment so it reaches
            // the model without polluting the cacheable base+memory prefix.
            let system_segments = match ephemeral_system.as_ref() {
                Some(extra) if !extra.is_empty() => {
                    let mut segs = base_system_segments;
                    segs.push(SystemSegment::volatile(extra.clone()));
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
            // Bounded recovery counter for `LlmError::MalformedToolArgs`.
            // The provider-level non-streaming retry inside
            // `call_llm_and_prerun` only patches SSE-concat bugs; when the
            // model itself emits broken JSON (unescaped `"` inside a long
            // Chinese tool payload is the recurring offender), both
            // streaming and non-streaming land on the same malformed
            // string and the error surfaces here. We then persist a
            // synthetic User feedback message naming the column / tool /
            // escaping rule and re-enter the loop — the model gets to see
            // *why* its previous response was rejected and can self-correct.
            // Bound this with the configured retry cap so a model that
            // can't write valid JSON doesn't burn the whole iteration budget.
            let mut malformed_args_attempts: u8 = 0;
            let max_malformed_args_retries = self.config.malformed_tool_args_max_retries;
            // Bounded recovery counter for `LlmError::ContentFiltered` —
            // the provider's moderation layer rejecting the request because
            // a *persisted* history message carries flagged content. Each
            // strike localizes and redacts one poison message, then
            // re-enters the loop. Bound so a thread whose poison can't be
            // localized (e.g. it lives in a user message) degrades
            // gracefully instead of looping.
            let mut content_filter_attempts: u8 = 0;
            let max_content_filter_retries = self.config.content_filter_max_retries;
            let mut repeated_tool_failures: HashMap<(String, String), usize> = HashMap::new();

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
                    Err(EngineError::Llm(LlmError::MalformedToolArgs {
                        tool,
                        args_len,
                        message,
                    })) if malformed_args_attempts < max_malformed_args_retries => {
                        // Model emitted invalid JSON in a tool_use arguments
                        // block AND the provider-level non-streaming retry
                        // already failed (otherwise this error wouldn't have
                        // bubbled up). The malformation is almost always an
                        // unescaped `"` inside a long Chinese string payload
                        // — the model can fix it if we tell it where. Persist
                        // a User-role feedback message and re-enter the loop;
                        // the next iteration's history will include our
                        // feedback so the model knows what to correct.
                        //
                        // Note: we deliberately do NOT persist any partial
                        // assistant content from the failed turn. The
                        // streamed text/thinking blocks (if any) preceded the
                        // broken tool_use, and an assistant message with no
                        // valid tool_use to match a later tool_result would
                        // poison subsequent turns on providers that enforce
                        // the pairing (OpenAI / DeepSeek both do).
                        malformed_args_attempts += 1;
                        warn!(
                            thread_id = thread_id.as_str(),
                            tool = %tool,
                            args_len,
                            attempt = malformed_args_attempts,
                            max = max_malformed_args_retries,
                            "model emitted invalid JSON tool args; persisting \
                             feedback and retrying turn"
                        );
                        let feedback = format!(
                            "Your previous response attempted to call tool `{tool}` \
                         but the JSON arguments could not be parsed.\n\n\
                         Parser error: {message}\n\n\
                         The most common cause is an unescaped `\"` inside a \
                         JSON string value. Please retry the same tool call, \
                         making sure every `\"` that appears INSIDE a JSON \
                         string is escaped as `\\\"`. Chinese curly quotes \
                         (`\u{201C}` U+201C and `\u{201D}` U+201D) do NOT need \
                         escaping. Newlines inside string values must be `\\n`, \
                         not literal line breaks. Backslashes themselves must \
                         be escaped as `\\\\`."
                        );
                        self.state
                            .append_message(&NewMessage {
                                thread_id: thread_id.clone(),
                                session_id,
                                role: Role::User,
                                content: vec![ContentBlock::text(feedback)],
                                turn_id: Some(turn_message_id.clone()),
                            })
                            .await?;
                        continue;
                    }
                    Err(EngineError::Llm(e))
                        if content_filter_attempts < max_content_filter_retries
                            && is_content_filter_error(&e) =>
                    {
                        // Provider content-moderation rejection (DeepSeek
                        // "Content Exists Risk" et al.). The flagged content
                        // is almost always a persisted history message —
                        // replaying it re-triggers the filter every turn and
                        // bricks the thread. Localize the offending message
                        // via binary search, mark it redacted (future
                        // `load_history` substitutes a placeholder), and
                        // retry. Withheld-error pattern: don't surface to the
                        // channel while recovery can still run.
                        content_filter_attempts += 1;
                        warn!(
                            thread_id = thread_id.as_str(),
                            attempt = content_filter_attempts,
                            max = max_content_filter_retries,
                            error = %e,
                            "provider content filter rejected the request; \
                             localizing and redacting the poison history message"
                        );
                        match self
                            .localize_and_redact_poison(&thread_id, &system_segments, &tool_schemas)
                            .await?
                        {
                            PoisonLocation::Redacted(ids) => {
                                warn!(
                                    thread_id = thread_id.as_str(),
                                    redacted = ids.len(),
                                    "redacted poison message(s); retrying turn"
                                );
                                continue;
                            }
                            PoisonLocation::Unredactable => {
                                // Poison sits in a user message or the system
                                // prompt — we won't silently rewrite the
                                // user's own words. Emit a graceful notice and
                                // end the turn cleanly; the thread stays usable
                                // for the next message.
                                warn!(
                                    thread_id = thread_id.as_str(),
                                    "content-filter poison not in a redactable message; \
                                     ending turn with degraded notice"
                                );
                                let notice = "抱歉，本轮对话中包含无法通过内容安全审核的内容，\
                                    我暂时无法继续处理。请换一种表述，或开启一个新的话题。";
                                self.state
                                    .append_message(&NewMessage {
                                        thread_id: thread_id.clone(),
                                        session_id,
                                        role: Role::Assistant,
                                        content: vec![ContentBlock::text(notice)],
                                        turn_id: Some(turn_message_id.clone()),
                                    })
                                    .await?;
                                let outbound_files = drain_outbound(&outbound_slot);
                                return Ok(TurnOutcome {
                                    session_id,
                                    assistant_text: notice.to_string(),
                                    iterations,
                                    usage: total_usage,
                                    outbound_files,
                                });
                            }
                        }
                    }
                    Err(e) => return Err(e),
                };
                total_usage.add(&resp.usage);
                // Per-iteration cache visibility. `cache_creation_input_tokens`
                // = the cost of writing this turn's prefix to the cache;
                // `cache_read_input_tokens` = bill avoided by reading from
                // it. Cache hit rate = read / (read + creation + fresh_input).
                // Logged at debug per-iteration; aggregated at turn end.
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

                // Skip persisting an empty assistant response. A turn that
                // produced no text / thinking / tool_use blocks at all would
                // poison every subsequent turn — DeepSeek and OpenAI both
                // reject an assistant message with neither `content` nor
                // `tool_calls` set (`invalid_request_error: Invalid assistant
                // message: content or tool_calls must be set`). End the turn
                // cleanly so the thread stays usable.
                if resp.message.content.is_empty() {
                    warn!(
                        thread_id = thread_id.as_str(),
                        iterations,
                        stop_reason = ?resp.stop_reason,
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
                        turn_id: Some(turn_message_id.clone()),
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
                    // fresh. Denominator combines fresh input + cache-read +
                    // cache-creation so the ratio reflects what the user
                    // paid for end-to-end. Stays at 0 when no cache info is
                    // returned (non-Anthropic provider or cache disabled).
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
                let tool_batch = match self
                    .run_tool_calls(
                        &resp.message.content,
                        &assistant_msg.id,
                        &tool_ctx,
                        gate.as_ref(),
                        &runtime_tools,
                        loop_guard.as_mut(),
                        prerun_cache,
                    )
                    .await
                {
                    Ok(v) => v,
                    Err(EngineError::LoopGuardTripped { tool, count }) => {
                        // Stash a one-shot hint keyed by thread so the next
                        // turn's system prompt can tell the model "you
                        // looped on X — try something else". Without this,
                        // the next turn starts with no memory of why the
                        // previous one died and often re-walks straight
                        // back into the same loop.
                        let snippet = loop_guard_input_snippet(&resp.message.content, &tool);
                        if let Ok(mut map) = self.loop_guard_hints.lock() {
                            map.insert(
                                thread_id.clone(),
                                LoopGuardHint {
                                    tool: tool.clone(),
                                    input_snippet: snippet,
                                    count,
                                },
                            );
                        }
                        return Err(EngineError::LoopGuardTripped { tool, count });
                    }
                    Err(e) => return Err(e),
                };

                if tool_batch.blocks.is_empty() {
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
                        content: tool_batch.blocks,
                        turn_id: Some(turn_message_id.clone()),
                    })
                    .await?;

                if self.config.repeated_tool_failure_feedback {
                    let mut feedback: Option<String> = None;
                    for failure in tool_batch.failures {
                        let key = (failure.tool.clone(), failure.input_signature.clone());
                        let count = repeated_tool_failures.entry(key).or_insert(0);
                        *count += 1;
                        if *count >= 2 {
                            feedback = Some(repeated_tool_failure_feedback(&failure, *count));
                            warn!(
                                tool = %failure.tool,
                                count = *count,
                                "repeated identical tool failure; injecting diagnostic feedback"
                            );
                            break;
                        }
                    }
                    if let Some(text) = feedback {
                        self.state
                            .append_message(&NewMessage {
                                thread_id: thread_id.clone(),
                                session_id,
                                role: Role::User,
                                content: vec![ContentBlock::text(text)],
                                turn_id: Some(turn_message_id.clone()),
                            })
                            .await?;
                        continue;
                    }
                }
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
                title: "New conversation".to_string(),
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
                head_rows.into_iter().map(message_from_persisted).collect()
            } else {
                Vec::new()
            };
            let live = self
                .state
                .messages_after(
                    thread_id,
                    &comp.summary_until_message_id,
                    self.config.conversation_history_limit,
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
            let live_msgs: Vec<Message> = live.into_iter().map(message_from_persisted).collect();
            // Apply the byte cap to the live tail too — the summary
            // preamble already shrinks the history by definition, but
            // a single oversized post-compaction message (e.g. a
            // tool_result carrying a freshly extracted PDF body) can
            // still blow the window.
            let bounded = enforce_history_byte_cap(
                live_msgs,
                self.config.history_max_bytes,
                self.config.compact_keep_recent,
                self.config.max_tool_result_bytes,
            );
            // Collapse old read-only tool_results so the model
            // doesn't re-pay token budget for stale Read/Grep
            // output on every turn after compaction. The kept tail
            // matches `compact_keep_recent` so the model still
            // sees its most recent tool work verbatim. Pairing repair
            // happens once at the request boundary
            // (`ensure_tool_result_pairing` in `call_llm_and_prerun`)
            // over the whole `head ++ summary ++ live` assembly.
            //
            // Order matters: byte-cap runs before collapse. A byte-cap
            // marker is intentionally tiny (well under
            // `collapse_tool_results_threshold`), so collapse leaves it
            // alone and the two elision markers never fight.
            let collapsed = collapse_old_tool_results(
                bounded,
                self.config.compact_keep_recent,
                self.config.collapse_tool_results_threshold,
            );
            out.extend(collapsed);
            return Ok(out);
        }
        // Dual window: pull a generous candidate pool of raw rows, then
        // size the kept window by *conversational* (User+Assistant)
        // message count via a whole-prefix cut, so a couple of huge
        // Role::Tool dumps can't evict the user's earlier goals/files
        // the way a flat last-N-rows window does.
        let pool_limit = self.config.pool_limit();
        let rows = self.state.recent_messages(thread_id, pool_limit).await?;
        let messages: Vec<Message> = rows.into_iter().map(message_from_persisted).collect();
        let windowed =
            trim_to_conversation_window(messages, self.config.conversation_history_limit as usize);
        let bounded = enforce_history_byte_cap(
            windowed,
            self.config.history_max_bytes,
            self.config.compact_keep_recent,
            self.config.max_tool_result_bytes,
        );
        // Pairing repair is deferred to the request boundary
        // (`ensure_tool_result_pairing` in `call_llm_and_prerun`).
        Ok(collapse_old_tool_results(
            bounded,
            self.config.compact_keep_recent,
            self.config.collapse_tool_results_threshold,
        ))
    }

    /// One localize-and-redact round for a `LlmError::ContentFiltered`.
    ///
    /// Loads the current thread window, then binary-searches the
    /// redactable messages (tool_results + assistant messages) to the
    /// single row whose content trips the provider's moderation filter,
    /// marks it redacted, and returns [`PoisonLocation::Redacted`]. When
    /// even redacting every redactable message can't clear the filter the
    /// poison lives in a user message or the system prompt, which we won't
    /// silently rewrite — returns [`PoisonLocation::Unredactable`] so the
    /// caller can degrade gracefully.
    ///
    /// Each probe is a minimal (`max_tokens = 1`) LLM call: moderation acts
    /// on the request *input*, so a one-token completion is enough to learn
    /// whether a given redaction set passes. Probe count is
    /// `O(log n)`-ish and hard-capped; the outer
    /// `content_filter_max_retries` bounds how many rounds run in a turn,
    /// so multiple independent poison messages are peeled off one per round.
    async fn localize_and_redact_poison(
        &self,
        thread_id: &ThreadId,
        system_segments: &[SystemSegment],
        tool_schemas: &[ToolSchema],
    ) -> EngineResult<PoisonLocation> {
        let rows = self
            .state
            .recent_messages(thread_id, self.config.pool_limit())
            .await?;
        // Only rows that actually reach the model can be the culprit —
        // build the probe history once with nothing redacted and keep the
        // ids it contains. Rows that `build_probe_history` windows or
        // byte-caps out (or collapses to an elision marker) can't affect a
        // probe, so leaving them in `candidates` would only inflate the
        // search and risk hitting `probe_cap` before isolating the poison.
        let in_window: HashSet<MessageId> =
            build_probe_history(&rows, &HashSet::new(), &self.config)
                .iter()
                .map(|m| m.id)
                .collect();
        // Redactable candidates: in-window tool_results and assistant
        // messages that aren't already redacted. User messages are excluded
        // — redacting them would rewrite the user's own words; if the poison
        // is there we degrade instead. Already-redacted rows are held
        // redacted by `build_probe_history` but aren't re-localized.
        let candidates: Vec<MessageId> = rows
            .iter()
            .filter(|r| matches!(r.role, Role::Tool | Role::Assistant))
            .filter(|r| r.redacted_at.is_none())
            .filter(|r| in_window.contains(&r.id))
            .map(|r| r.id)
            .collect();
        if candidates.is_empty() {
            return Ok(PoisonLocation::Unredactable);
        }

        // Hard cap on probes so a pathological thread can't spin the LLM.
        let probe_cap: u32 = 24;
        let mut probes: u32 = 0;

        // Coarse check: redact ALL candidates. If the filter still fires,
        // the poison is outside the redactable set (user/system).
        let all: HashSet<MessageId> = candidates.iter().copied().collect();
        probes += 1;
        if self
            .probe_content_filter(system_segments, &rows, &all, tool_schemas)
            .await?
            == ProbeOutcome::Filtered
        {
            return Ok(PoisonLocation::Unredactable);
        }

        // Binary search for one offending row. Invariant across the loop:
        //   probe(base)            == Filtered  (poison still present)
        //   probe(base ∪ suspects) == Passed    (redacting suspects clears it)
        // `base` starts empty — probe(∅) mirrors the real failing request.
        let mut base: HashSet<MessageId> = HashSet::new();
        let mut suspects: Vec<MessageId> = candidates;
        while suspects.len() > 1 && probes < probe_cap {
            let mid = suspects.len() / 2;
            let left = suspects[..mid].to_vec();
            let right = suspects[mid..].to_vec();

            // Does redacting `right` (on top of base) clear the filter?
            let mut set = base.clone();
            set.extend(right.iter().copied());
            probes += 1;
            if self
                .probe_content_filter(system_segments, &rows, &set, tool_schemas)
                .await?
                == ProbeOutcome::Passed
            {
                suspects = right;
                continue;
            }

            // No — try `left` alone.
            let mut set = base.clone();
            set.extend(left.iter().copied());
            probes += 1;
            if self
                .probe_content_filter(system_segments, &rows, &set, tool_schemas)
                .await?
                == ProbeOutcome::Passed
            {
                suspects = left;
                continue;
            }

            // Neither half alone clears it → poison in BOTH halves. Hold
            // `right` redacted (in memory only) and narrow into `left`. The
            // invariant is preserved: probe(base ∪ right) is Filtered, and
            // probe(base ∪ right ∪ left) == probe(base ∪ suspects) Passed.
            // Only the finally-isolated row is ever persisted, so this
            // never over-redacts innocent history.
            base.extend(right.iter().copied());
            suspects = left;
        }

        // Only persist a redaction when the search actually isolated a
        // single row. If we exited because `probe_cap` was hit with more
        // than one suspect left, `suspects[0]` is a guess that might be an
        // innocent row (and might not even be the poison) — marking it would
        // over-redact without healing. Degrade gracefully instead.
        if suspects.len() != 1 {
            warn!(
                thread_id = thread_id.as_str(),
                probes,
                remaining = suspects.len(),
                "content-filter localization hit the probe cap without isolating \
                 a single row; degrading instead of guessing"
            );
            return Ok(PoisonLocation::Unredactable);
        }

        let target = suspects[0];
        self.state.mark_message_redacted(&target).await?;
        Ok(PoisonLocation::Redacted(vec![target]))
    }

    /// Minimal moderation probe: build the candidate history (with
    /// `redact_ids` ∪ already-redacted rows neutralized), send it with
    /// `max_tokens = 1`, and report whether the provider's content filter
    /// fired. Non-moderation errors propagate — a transient during
    /// localization aborts the round rather than silently mislabeling.
    async fn probe_content_filter(
        &self,
        system_segments: &[SystemSegment],
        rows: &[snaca_state::MessageRow],
        redact_ids: &HashSet<MessageId>,
        tool_schemas: &[ToolSchema],
    ) -> EngineResult<ProbeOutcome> {
        let history = build_probe_history(rows, redact_ids, &self.config);
        let history = ensure_tool_result_pairing(history);
        let req = MessageRequest::new(&self.config.model)
            .with_system_segments(system_segments.to_vec())
            .with_messages(history)
            .with_tools(tool_schemas.to_vec())
            .with_max_tokens(1);
        match self.llm.create_message(req).await {
            Ok(_) => Ok(ProbeOutcome::Passed),
            Err(LlmError::ContentFiltered { .. }) => Ok(ProbeOutcome::Filtered),
            Err(e) => Err(EngineError::Llm(e)),
        }
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
        let memory_provider = self.memory_provider.clone();
        // Pull recent messages from the thread the worker can see. Use
        // the conversational window's raw-row pool so the extractor sees
        // roughly the same context the LLM did.
        let pool_limit = self.config.pool_limit();
        // Per-project serial lock so two concurrent extractor tasks on
        // the same project don't trample each other's `MEMORY.md`
        // regeneration or same-name entry writes. Map insert is fast
        // and synchronous; the actual lock is held across awaits.
        let project_lock = {
            let mut map = self
                .extraction_locks
                .lock()
                .expect("extraction_locks mutex poisoned");
            map.entry(project.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        tokio::spawn(async move {
            let _g = project_lock.lock().await;
            let rows = match state.recent_messages(&thread, pool_limit).await {
                Ok(r) => r,
                Err(e) => {
                    warn!(error = %e, "extractor: history fetch failed");
                    return;
                }
            };
            let messages: Vec<Message> = rows.into_iter().map(message_from_persisted).collect();
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
                // Wrap the proposal body in YAML frontmatter so the
                // index can audit `source` and `created_at`. The
                // legacy `confidence` field is no longer consumed
                // (the vector recall layer that used it has been
                // removed); proposal.confidence is still surfaced
                // through the extractor → write log so operators can
                // see what the extractor was thinking.
                let confidence = proposal.confidence;
                let meta = snaca_memory::MemoryMeta {
                    source: Some("extractor".into()),
                    confidence: None,
                    created_at: Some(chrono::Utc::now().to_rfc3339()),
                };
                let wrapped = snaca_memory::render_with_frontmatter(&meta, &proposal.content);
                if let Some(provider) = memory_provider.clone() {
                    let scope_str = proposal.scope.as_str().to_string();
                    let name_str = proposal.name.clone();
                    match provider
                        .write(MemoryWriteRequest {
                            tenant_id: tenant.clone(),
                            project_id: project.clone(),
                            scope: scope_str.clone(),
                            name: name_str.clone(),
                            content: wrapped,
                        })
                        .await
                    {
                        Ok(entry) => {
                            debug!(
                                scope = entry.scope.as_str(),
                                name = entry.name.as_str(),
                                confidence = ?confidence,
                                "extractor wrote memory entry through provider"
                            );
                            // Fire-and-forget hook so observers can
                            // mirror or invalidate caches. We don't
                            // bubble errors — the hook is advisory.
                            if let Err(e) = provider
                                .on_memory_write(&snaca_agent_api::MemoryWriteCtx {
                                    tenant_id: tenant.clone(),
                                    project_id: project.clone(),
                                    action: snaca_agent_api::MemoryWriteAction::Extractor,
                                    scope: scope_str,
                                    name: name_str,
                                })
                                .await
                            {
                                warn!(error = %e, "memory provider on_memory_write hook failed");
                            }
                        }
                        Err(e) => warn!(
                            scope = %proposal.scope,
                            name = proposal.name.as_str(),
                            error = %e,
                            "extractor provider write failed"
                        ),
                    }
                    continue;
                }
                match store
                    .write_force(proposal.scope, &proposal.name, &wrapped)
                    .await
                {
                    Ok(entry) => debug!(
                        scope = %entry.scope,
                        name = entry.name.as_str(),
                        confidence = ?confidence,
                        "extractor wrote memory entry"
                    ),
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
    /// base prompt + frozen `## Project Memory` snapshot. The snapshot
    /// is rendered once per thread and reused verbatim on every
    /// subsequent turn — the entire prefix stays byte-stable so the
    /// LLM provider's prompt cache holds. `MemoryWrite` calls and the
    /// post-turn extractor still hit disk, but their effects only
    /// surface in the next thread (or after an explicit
    /// [`Self::invalidate_memory_snapshot`] call).
    ///
    /// IO failures degrade gracefully: a project with no memory tree
    /// or a transient read error caches an empty snapshot for the
    /// thread instead of bouncing the turn.
    async fn system_prompt_for(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
        thread: &ThreadId,
        _user_query: &str,
        loop_guard_hint: Option<&LoopGuardHint>,
    ) -> Vec<SystemSegment> {
        // Live workspace file listing — recomputed every turn (cheap
        // bounded dir read), even on the memory-snapshot cache-hit path,
        // so the model's view of its files is never stale. It rides as a
        // volatile segment, so this per-turn recompute never busts the
        // cacheable memory prefix. The listing uses blocking `std::fs`
        // syscalls (read_dir + per-entry metadata), so it runs on a
        // `spawn_blocking` thread to keep it off the async executor; a
        // panic falls back to an empty listing, matching the in-fn error
        // handling.
        let workspace_dir = self.workspace.workspace_dir(tenant, project);
        let workspace_files =
            tokio::task::spawn_blocking(move || render_workspace_files(&workspace_dir))
                .await
                .unwrap_or_default();

        // Cache hit on the second-and-later turns of a thread; this
        // is the whole point of the frozen-snapshot model.
        if let Some(cached) = self
            .memory_snapshots
            .lock()
            .ok()
            .and_then(|m| m.get(thread).cloned())
        {
            return compose_system_segments(
                &self.config.system_prompt,
                &cached,
                "",
                &workspace_files,
                loop_guard_hint,
            );
        }

        let snapshot_text = self.render_memory_snapshot(tenant, project).await;

        if let Ok(mut map) = self.memory_snapshots.lock() {
            map.insert(thread.clone(), Arc::new(snapshot_text.clone()));
        }

        compose_system_segments(
            &self.config.system_prompt,
            &snapshot_text,
            "",
            &workspace_files,
            loop_guard_hint,
        )
    }

    /// Render the full memory tree as the frozen snapshot text used
    /// inside `## Project Memory`. Pulled out of `system_prompt_for`
    /// so tests and the future `on_session_switch` hook can call it
    /// directly. IO errors are logged and surfaced as an empty
    /// string — no memory beats a poisoned turn.
    async fn render_memory_snapshot(&self, tenant: &TenantId, project: &ProjectId) -> String {
        // SDK-injected provider: defer to its `index` text. We cannot
        // call snaca-memory's snapshot renderer through the trait
        // without leaking concrete types, so the provider's `index`
        // is the snapshot for that case. The built-in
        // `FileTreeMemoryProvider` returns `MEMORY.md` here, which
        // is a structurally similar listing.
        if let Some(provider) = self.memory_provider.clone() {
            return match provider
                .index(MemoryIndexRequest {
                    tenant_id: tenant.clone(),
                    project_id: project.clone(),
                })
                .await
            {
                Ok(s) => s,
                Err(e) => {
                    warn!(error = %e, "memory provider index read failed; turning without memory preamble");
                    String::new()
                }
            };
        }

        let memory_dir = self.workspace.memory_dir(tenant, project);
        let store = snaca_memory::MemoryStore::new(memory_dir);
        match snaca_memory::render_snapshot(&store, &snaca_memory::RenderConfig::default()).await {
            Ok(snap) => snap.text,
            Err(e) => {
                warn!(error = %e, "memory snapshot render failed; turning without memory preamble");
                String::new()
            }
        }
    }

    /// Drop the cached frozen snapshot for `thread`. The next turn on
    /// that thread re-renders from disk. Call this from session-reset
    /// flows (future `/reset` slash command, or when the session id
    /// is rolled forward by a compaction). No-op when the lock is
    /// poisoned — the worst case is a stale prompt for one extra
    /// turn.
    pub fn invalidate_memory_snapshot(&self, thread: &ThreadId) {
        if let Ok(mut map) = self.memory_snapshots.lock() {
            map.remove(thread);
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
        // Memory-provider hook before we touch anything: gives the
        // provider a chance to mine durable facts from the
        // soon-to-be-discarded middle band. We pass a best-effort
        // transcript excerpt rather than the raw `Message` rows so
        // the provider doesn't have to depend on snaca-state.
        // Errors are logged and discarded — the hook is advisory.
        if let Some(provider) = self.memory_provider.clone() {
            // Pull the same window we'll compact, build a short
            // transcript excerpt. Cheap relative to the LLM
            // summarise call that follows.
            let preview_rows = self
                .state
                .recent_messages(thread_id, self.config.pool_limit())
                .await
                .unwrap_or_default();
            let mut excerpt = String::new();
            for r in &preview_rows {
                let mut text = String::new();
                for block in &r.content {
                    if let ContentBlock::Text { text: t } = block {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(t);
                    }
                }
                if text.is_empty() {
                    continue;
                }
                excerpt.push_str(&format!("[{:?}] {}\n", r.role, text));
                if excerpt.len() > 8192 {
                    break;
                }
            }
            // We don't know the active TenantId/ProjectId at this
            // call site — `maybe_compact_thread` only carries
            // `thread_id`. Surface them via a parsed thread_id
            // (the dispatcher uses `chat_id::project_id`); when
            // that fails, fall back to empty ids so the hook still
            // fires with the transcript excerpt the provider can
            // act on.
            let (parsed_tenant, parsed_project) = parse_thread_id_for_hook(thread_id);
            let ctx = snaca_agent_api::PreCompactCtx {
                tenant_id: parsed_tenant,
                project_id: parsed_project,
                thread_id: thread_id.as_str().to_string(),
                reason: if keep_recent_override.is_some() {
                    snaca_agent_api::CompactReason::ContextOverflowRetry
                } else {
                    snaca_agent_api::CompactReason::InputBudgetExceeded
                },
                transcript_excerpt: excerpt,
            };
            if let Err(e) = provider.on_pre_compact(&ctx).await {
                warn!(error = %e, "memory provider on_pre_compact hook failed");
            }
        }

        let protect_last = keep_recent_override
            .unwrap_or(self.config.compact_keep_recent)
            .max(2);
        let protect_first = self.config.protect_first_n;
        // Pull the entire thread's messages — `pool_limit()` (history_limit
        // * 4, clamped) keeps a safe ceiling even when load_history is
        // summary-spliced. We need the raw row order from oldest to newest
        // to pick the cutoffs.
        let mut all = self
            .state
            .recent_messages(thread_id, self.config.pool_limit())
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
        // Neutralize any already-redacted (poison) rows here too — a
        // summary request that renders their flagged content would itself
        // trip the provider's content filter, so `message_from_persisted`
        // substitutes the placeholder before the body is rendered.
        let body_count = body_rows.len();
        let body_msgs: Vec<Message> = body_rows.into_iter().map(message_from_persisted).collect();
        let body_collapsed =
            collapse_old_tool_results(body_msgs, 0, self.config.collapse_tool_results_threshold);
        // Cap each block AND the aggregate so a band of large error / Bash
        // / write bodies (which collapse leaves verbatim) can't blow the
        // summary request — the request meant to rescue an over-long
        // context. 16 KiB/block is ample for a gist; the total ceiling is
        // the hard guarantee the request itself never overflows.
        let body_text = render_for_summary(
            &body_collapsed,
            SUMMARY_BLOCK_MAX_BYTES,
            SUMMARY_TOTAL_MAX_BYTES,
        );

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
        // Single pairing-invariant gate over the *complete* assembled
        // history. `load_history` splices `head ++ summary ++ live_tail`
        // and an orphan tool_use/tool_result can sit on any seam; running
        // the invariant here — the one choke point every *tool-bearing*
        // request passes through, including the prompt-too-long
        // shrink-retry — means no assembly path can send a malformed
        // history to the provider. (The compaction-summary and memory
        // extractor requests bypass this, but they render history to a
        // single flat user-text message with no tool blocks, so they
        // can't carry an orphan.)
        let history = ensure_tool_result_pairing(history);
        let mut attempt: u8 = 0;
        loop {
            match self
                .call_llm_and_prerun_once(
                    system_segments,
                    history.clone(),
                    tool_schemas.clone(),
                    tools,
                    tool_ctx,
                    listener,
                    max_tokens_override,
                )
                .await
            {
                Ok(v) => return Ok(v),
                Err(EngineError::Llm(e))
                    if matches!(e, LlmError::StreamInterrupted(_))
                        && attempt < self.config.stream_interrupted_max_retries =>
                {
                    attempt += 1;
                    let delay = stream_retry_delay(attempt);
                    warn!(
                        attempt,
                        max = self.config.stream_interrupted_max_retries,
                        delay_ms = delay.as_millis() as u64,
                        error = %e,
                        "LLM stream interrupted; retrying the same request"
                    );
                    listener.on_stream_retry(attempt, &e).await;
                    tokio::time::sleep(delay).await;
                }
                Err(e) => return Err(e),
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn call_llm_and_prerun_once(
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
        // Keep a clone for the non-streaming retry path. Cheap on the
        // common case (just an Arc bump on each segment / message body).
        let retry_req = req.clone();
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

        // Per-text-block fence scrubbers. The model occasionally
        // echoes our injected `<memory-context>` / `<attachments>`
        // fences back in its visible output. If we let those through
        // they hit two surfaces we care about: the user-facing stream
        // (via `listener`) and the next-turn transcript (via `acc`,
        // which the extractor later reads). Scrubbing the text deltas
        // right here — the single chokepoint every provider's stream
        // flows through — kills both at once. Keyed by block index so
        // interleaved blocks don't corrupt each other's partial-tag
        // state; the kind tag lets the flush re-emit the right delta
        // variant.
        let mut text_scrubbers: HashMap<
            u32,
            (crate::memory_fence::StreamingScrubber, FenceTextKind),
        > = HashMap::new();

        while let Some(ev) = stream.next().await {
            let ev = ev?;
            for ev in scrub_stream_event(&mut text_scrubbers, ev) {
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
                                } else if let Some(h) = self.maybe_spawn_prerun(p, tools, tool_ctx)
                                {
                                    handles.push(h);
                                }
                            }
                        }
                        _ => {}
                    }
                }

                acc.ingest(ev);
            }
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

        let resp = match acc.finalize() {
            Ok(r) => r,
            Err(LlmError::MalformedToolArgs {
                tool,
                args_len,
                message,
            }) => {
                // Provider's SSE concatenated tool_use args into invalid
                // JSON — most often DeepSeek with long Chinese tool args
                // where escape sequences get corrupted between deltas.
                // Re-issue the same request without streaming: the
                // non-streaming endpoint returns `arguments` as a single
                // complete string field that doesn't go through SSE
                // deltas, sidestepping the bug entirely. Drop the prerun
                // cache — its tool_use IDs come from the busted stream
                // and won't match the new response's blocks.
                warn!(
                    tool = %tool,
                    args_len,
                    "streamed tool args malformed; retrying request in non-streaming mode"
                );
                let resp = self.llm.create_message(retry_req).await.map_err(|e| {
                    // If the retry also fails, surface the *original*
                    // streaming error — that's the one the operator
                    // needs to see to diagnose. Wrap the retry failure
                    // as context.
                    warn!(error = %e, "non-streaming retry also failed");
                    EngineError::Llm(LlmError::MalformedToolArgs {
                        tool: tool.clone(),
                        args_len,
                        message: format!("{message} (non-streaming retry also failed: {e})"),
                    })
                })?;
                debug!(
                    tool = %tool,
                    "non-streaming retry succeeded; discarding streamed prerun cache"
                );
                return Ok((resp, PrerunCache::new()));
            }
            Err(e) => return Err(e.into()),
        };
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
    ) -> EngineResult<ToolBatchResult> {
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
        let mut results: Vec<(usize, ToolBlockOutcome)> = Vec::with_capacity(pending.len());
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
                let collected: Vec<(usize, ToolBlockOutcome)> = futures::stream::iter(futs)
                    .buffer_unordered(limit)
                    .collect()
                    .await;
                results.extend(collected);
            }
        }

        // 5. Restore original tool_use order; buffer_unordered may
        // have completed them out of order.
        results.sort_by_key(|(pos, _)| *pos);
        let mut batch = ToolBatchResult::default();
        for (_, outcome) in results {
            if let Some(failure) = outcome.failure {
                batch.failures.push(failure);
            }
            batch.blocks.push(outcome.block);
        }
        Ok(batch)
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
    ) -> ToolBlockOutcome {
        // Every `tool_use` block in the assistant message MUST get a
        // corresponding `tool_result` (or `tool_error`) block,
        // otherwise providers like DeepSeek reject the next history
        // submission. So we catch every failure mode here and
        // synthesise a tool_error block instead of bubbling out.
        let outcome = self
            .execute_one(
                id,
                name,
                input.clone(),
                assistant_msg_id,
                tool_ctx,
                gate,
                tools,
                prebuilt,
            )
            .await;
        // Cap every result path at capture time (layer ① of the
        // oversized-result defence): a single tool output that exceeds
        // `max_tool_result_bytes` is truncated to a head+tail preview
        // before it is ever persisted, so it can neither blow the model
        // context on load nor blow the compaction-summary request.
        let mut result = match outcome {
            Ok(Ok(out)) => {
                // Block-list outputs (Read on .pdf / image /
                // notebook) pass through straight as ToolResult
                // content. Text / Json collapse to a single text
                // block via render_text — the historical shape.
                let content = match out {
                    snaca_tools_api::ToolOutput::Blocks(bs) => bs,
                    other => vec![ContentBlock::text(other.render_text())],
                };
                ToolBlockOutcome {
                    block: ContentBlock::tool_result(id.clone(), content),
                    failure: None,
                }
            }
            Ok(Err(e)) => {
                warn!(tool = %name, error = %e, "tool execution returned error");
                let error = e.to_string();
                let signature = input_signature(&input);
                ToolBlockOutcome {
                    block: ContentBlock::tool_error(id.clone(), error.clone()),
                    failure: Some(ToolFailureEvent {
                        tool: name.to_string(),
                        input,
                        input_signature: signature,
                        error,
                    }),
                }
            }
            Err(engine_err) => {
                warn!(
                    tool = %name,
                    error = %engine_err,
                    "engine-level error during tool dispatch; surfacing as tool_error"
                );
                let error = format!("tool dispatch failed: {engine_err}");
                let signature = input_signature(&input);
                ToolBlockOutcome {
                    block: ContentBlock::tool_error(id.clone(), error.clone()),
                    failure: Some(ToolFailureEvent {
                        tool: name.to_string(),
                        input,
                        input_signature: signature,
                        error,
                    }),
                }
            }
        };
        result.block = cap_tool_result_block(result.block, self.config.max_tool_result_bytes);
        result
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

fn snippet(s: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut truncated = false;
    for (idx, ch) in s.chars().enumerate() {
        if idx >= max_chars {
            truncated = true;
            break;
        }
        out.push(ch);
    }
    if truncated {
        out.push_str("...");
    }
    out
}

fn input_snippet(input: &Value) -> String {
    let rendered = serde_json::to_string(input).unwrap_or_else(|_| input.to_string());
    snippet(&rendered, 500)
}

fn error_snippet(error: &str) -> String {
    let lines: Vec<&str> = error.lines().collect();
    let start = lines.len().saturating_sub(20);
    snippet(&lines[start..].join("\n"), 2000)
}

fn repeated_tool_failure_feedback(failure: &ToolFailureEvent, count: usize) -> String {
    format!(
        "Your previous identical tool call failed {count} times in this turn.\n\n\
         Tool: `{tool}`\n\
         Input: `{input}`\n\n\
         Latest error excerpt:\n\
         ```text\n{error}\n```\n\n\
         Do not run this exact same `{tool}` call again. First inspect the \
         error output, explain the likely root cause, and change the approach \
         before retrying. For example, modify the command/script/arguments, \
         restore corrupted inputs, or run a different diagnostic command that \
         can disambiguate the failure.",
        tool = failure.tool,
        input = input_snippet(&failure.input),
        error = error_snippet(&failure.error),
    )
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
    tools.schemas().to_vec()
}

/// Pull a short, displayable snippet of the input that tripped the
/// loop guard. Walks the assistant content for a `ToolUse` block whose
/// name matches `tool`; takes the *last* match because the guard
/// records *every* call and the final one is the one that pushed the
/// count past the limit. Falls back to an empty string when no
/// matching block is found (shouldn't happen in practice — the guard
/// just inspected this content — but the error path shouldn't panic).
fn loop_guard_input_snippet(content: &[ContentBlock], tool: &str) -> String {
    const SNIPPET_BYTES: usize = 240;
    let raw = content
        .iter()
        .rev()
        .find_map(|b| match b {
            ContentBlock::ToolUse { name, input, .. } if name == tool => {
                Some(serde_json::to_string(input).unwrap_or_default())
            }
            _ => None,
        })
        .unwrap_or_default();
    excerpt(&raw, SNIPPET_BYTES)
}

/// Build the per-turn system prompt as ordered, cache-aware segments.
///
/// Segmentation strategy:
///
/// - **Segment 1 (cacheable)** — date preamble + base prompt + MEMORY.md
///   index. The date rolls daily, but within a day the segment is
///   byte-stable, so Anthropic's prompt cache holds the entire
///   prefix. MEMORY.md changing (a new entry, an extractor write)
///   invalidates this segment exactly once — the expected cost of
///   memory writes.
///
/// - **Segment 2 (volatile, optional)** — a loop-guard hint when the
///   previous turn was aborted for repeating the same tool call. Held
///   out of the cacheable prefix because it's per-turn and only set
///   on rare error-recovery paths.
///
/// `recall` is currently unused — the parameter is kept so callers can
/// be migrated incrementally; it will carry the future frozen-snapshot
/// "auto-retrieved" block once that lands. An empty string is the
/// expected production input today.
fn compose_system_segments(
    base: &str,
    index: &str,
    _recall: &str,
    workspace_files: &str,
    loop_guard_hint: Option<&LoopGuardHint>,
) -> Vec<SystemSegment> {
    let mut stable = current_date_preamble(chrono::Local::now());
    stable.push_str(base);
    if !index.trim().is_empty() {
        stable.push_str(
            "\n\n---\n\n## Project Memory\n\n\
             A frozen snapshot of this project's memory tree. Each entry \
             is shown verbatim under its `scope/name` heading. The \
             snapshot was taken at the start of this thread session — \
             writes you make through `MemoryWrite` only become visible \
             on the next session. If a `[truncated, N more entries \
             hidden]` marker is present, use the `MemoryRead` tool with \
             `scope` and `name` to fetch entries that didn't fit.\n\n",
        );
        stable.push_str(index.trim());
    }
    let mut segs: Vec<SystemSegment> = vec![SystemSegment::cacheable(stable)];
    // Live workspace file listing — a VOLATILE (non-cacheable) segment
    // recomputed every turn and held out of the cacheable prefix, so the
    // model always sees the current set of files (the durable source of
    // truth for uploads) even after the turns that introduced them have
    // been evicted, and adding/removing a file never busts the memory
    // prefix cache.
    if !workspace_files.trim().is_empty() {
        segs.push(SystemSegment::volatile(format!(
            "\n\n---\n\n## Workspace Files\n\n\
             These files are in your project workspace — the durable \
             source of truth for anything the user uploaded. Read them \
             with the `Read` tool (paths are workspace-relative). This \
             list is current as of THIS turn; before telling the user you \
             don't have a file, check here first.\n\n{}",
            workspace_files.trim(),
        )));
    }
    if let Some(hint) = loop_guard_hint {
        let snippet = if hint.input_snippet.is_empty() {
            "(input not captured)".to_string()
        } else {
            hint.input_snippet.clone()
        };
        let body = format!(
            "\n\n---\n\n## Previous turn aborted: loop guard\n\n\
             The previous turn on this thread was aborted because you called \
             `{tool}` {count} times with identical input. Do **not** repeat \
             that exact call. If the same operation is still required, change \
             the approach — e.g. read the file in full (no offset/limit), \
             split a large MultiEdit into smaller Edits, or use Grep to \
             locate the target before retrying. The exact input that tripped \
             the guard was: `{snippet}`.\n",
            tool = hint.tool,
            count = hint.count,
        );
        segs.push(SystemSegment::volatile(body));
    }
    segs
}

/// Backwards-compatible string view for tests. Derived from
/// [`compose_system_segments`] so the two stay in sync; gated to test
/// builds since the engine itself only ever speaks segments.
#[cfg(test)]
fn compose_system_prompt(base: &str, index: &str, recall: &str) -> String {
    let segs = compose_system_segments(base, index, recall, "", None);
    let mut out = String::new();
    for s in segs {
        out.push_str(&s.text);
    }
    out
}

/// Best-effort recovery of `(tenant_id, project_id)` from a thread
/// id for the `on_pre_compact` / `on_session_switch` hook context.
/// The dispatcher constructs thread ids as `<chat_id>::<project_id>`
/// — see `crates/snaca-server/src/dispatch.rs::thread_id_for`. When
/// the format diverges we fall back to empty ids; the provider
/// still gets the rest of the context (thread id + transcript)
/// which is the high-leverage payload.
fn parse_thread_id_for_hook(thread: &ThreadId) -> (TenantId, ProjectId) {
    // Tenant routing isn't encoded in the thread id today, so we
    // surface the empty tenant — providers that care can derive it
    // from their own session bookkeeping. Project, on the other
    // hand, IS encoded as the suffix after `::`.
    let raw = thread.as_str();
    let project = raw
        .rsplit_once("::")
        .map(|(_, project)| project.to_string())
        .unwrap_or_default();
    (TenantId::new(""), ProjectId::from_raw(project))
}

/// Emit the dated preamble the model sees at the very top of every
/// system prompt: "Today's date is 2026-05-19 (Tuesday).\n\n". LLMs
/// have no clock — without this they routinely confuse the year or
/// say "I don't know today's date". Date-only (no time) so the prompt
/// cache stays warm for the whole local day.
fn current_date_preamble<Tz: chrono::TimeZone>(now: chrono::DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    format!(
        "Today's date is {} ({}).\n\n",
        now.format("%Y-%m-%d"),
        now.format("%A")
    )
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

/// Which text-bearing delta variant a scrubbed block emits. Tracked
/// per block index so [`scrub_stream_event`]'s flush re-emits the
/// matching delta on `ContentBlockStop`.
#[derive(Debug, Clone, Copy)]
enum FenceTextKind {
    Text,
    Thinking,
}

/// Rewrite one streaming event so any echoed `<memory-context>` /
/// `<attachments>` fence in a text or thinking delta is stripped
/// before it reaches the user (listener) or the next-turn transcript
/// (accumulator). Returns the events to actually process — usually
/// one, but a `ContentBlockStop` may be preceded by a synthetic
/// flush delta carrying the scrubber's held-back tail. Non-text
/// events pass through untouched.
fn scrub_stream_event(
    scrubbers: &mut HashMap<u32, (crate::memory_fence::StreamingScrubber, FenceTextKind)>,
    ev: StreamEvent,
) -> Vec<StreamEvent> {
    use crate::memory_fence::StreamingScrubber;
    match ev {
        StreamEvent::ContentBlockStart {
            index,
            block: ContentBlockStart::Text,
        } => {
            scrubbers.insert(index, (StreamingScrubber::new(), FenceTextKind::Text));
            vec![StreamEvent::ContentBlockStart {
                index,
                block: ContentBlockStart::Text,
            }]
        }
        StreamEvent::ContentBlockStart {
            index,
            block: ContentBlockStart::Thinking,
        } => {
            scrubbers.insert(index, (StreamingScrubber::new(), FenceTextKind::Thinking));
            vec![StreamEvent::ContentBlockStart {
                index,
                block: ContentBlockStart::Thinking,
            }]
        }
        StreamEvent::ContentBlockDelta {
            index,
            delta: ContentDelta::Text { text },
        } => {
            let cleaned = scrubbers
                .get_mut(&index)
                .map(|(s, _)| s.push(&text))
                .unwrap_or(text);
            if cleaned.is_empty() {
                vec![]
            } else {
                vec![StreamEvent::ContentBlockDelta {
                    index,
                    delta: ContentDelta::Text { text: cleaned },
                }]
            }
        }
        StreamEvent::ContentBlockDelta {
            index,
            delta: ContentDelta::Thinking { text },
        } => {
            let cleaned = scrubbers
                .get_mut(&index)
                .map(|(s, _)| s.push(&text))
                .unwrap_or(text);
            if cleaned.is_empty() {
                vec![]
            } else {
                vec![StreamEvent::ContentBlockDelta {
                    index,
                    delta: ContentDelta::Thinking { text: cleaned },
                }]
            }
        }
        StreamEvent::ContentBlockStop { index } => {
            let mut out = Vec::new();
            if let Some((mut scrubber, kind)) = scrubbers.remove(&index) {
                let tail = scrubber.flush();
                if !tail.is_empty() {
                    let delta = match kind {
                        FenceTextKind::Text => ContentDelta::Text { text: tail },
                        FenceTextKind::Thinking => ContentDelta::Thinking { text: tail },
                    };
                    out.push(StreamEvent::ContentBlockDelta { index, delta });
                }
            }
            out.push(StreamEvent::ContentBlockStop { index });
            out
        }
        other => vec![other],
    }
}

fn stream_retry_delay(attempt: u8) -> Duration {
    let exp = attempt.saturating_sub(1).min(5);
    Duration::from_millis(500u64.saturating_mul(1u64 << exp))
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
    let total = tool_result_text_len(&content);
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

/// Marker substituted for an old `tool_result`'s body when the byte cap
/// clears it. The block and its `tool_use_id` are kept so pairing stays
/// intact — only the payload is elided.
const BYTE_CAP_CLEARED_MARKER: &str = "[Old tool result content cleared to fit context budget]";

/// Per-block byte cap when rendering the compaction-summary input
/// (`render_for_summary`). Bounds each message's contribution so no single
/// message dominates the summariser request.
const SUMMARY_BLOCK_MAX_BYTES: usize = 16 * 1024;

/// Aggregate byte ceiling for the whole compaction-summary transcript.
/// The hard guarantee that the summariser request — the one meant to
/// rescue an over-long context — can never itself overflow, even when a
/// band holds many mid-sized results. ~256 KiB (~64k tokens) leaves ample
/// headroom under any modern context window.
const SUMMARY_TOTAL_MAX_BYTES: usize = 256 * 1024;

/// Byte size of a `tool_result` body's text blocks — the portion the byte
/// cap can elide. Mirrors how `message_byte_size` counts a `ToolResult`.
fn tool_result_text_len(content: &[ContentBlock]) -> usize {
    content
        .iter()
        .map(|c| match c {
            ContentBlock::Text { text } => text.len(),
            _ => 0,
        })
        .sum()
}

/// Largest byte prefix of `s` that ends on a UTF-8 char boundary and is
/// `<= max`.
fn floor_char_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    end
}

/// Truncate a `tool_result`'s text to a head+tail preview when it exceeds
/// `max` bytes, keeping non-text blocks (images) intact. Layer ① of the
/// oversized-result defence — applied at capture time so no single result
/// can dominate the model context or the compaction-summary request.
/// `max == 0` disables it.
fn cap_tool_result_content(content: Vec<ContentBlock>, max: usize) -> Vec<ContentBlock> {
    if max == 0 || tool_result_text_len(&content) <= max {
        return content;
    }
    // Split text from non-text (image) blocks. Avoid materialising the
    // whole body in the common single-text-block case (a Bash dump is one
    // `Text` block) — borrow it directly; only concatenate when the text
    // is genuinely spread across several blocks.
    let mut texts: Vec<String> = Vec::new();
    let mut others: Vec<ContentBlock> = Vec::new();
    for b in content {
        match b {
            ContentBlock::Text { text: t } => texts.push(t),
            other => others.push(other),
        }
    }
    let body: std::borrow::Cow<str> = match texts.len() {
        1 => std::borrow::Cow::Borrowed(texts[0].as_str()),
        _ => std::borrow::Cow::Owned(texts.concat()),
    };
    let text: &str = &body;
    // Keep a head and a tail so both the start of the output and any
    // trailing error/summary survive.
    let half = (max / 2).max(1);
    let head_end = floor_char_boundary(text, half);
    let mut tail_start = text.len().saturating_sub(half);
    while tail_start < text.len() && !text.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    // Guard against overlap when head and tail would meet.
    let tail_start = tail_start.max(head_end);
    let dropped = tail_start.saturating_sub(head_end);
    let preview = format!(
        "{}\n\n[... {dropped} bytes truncated to fit the context window; \
         re-run the tool if the full output is needed ...]\n\n{}",
        &text[..head_end],
        &text[tail_start..],
    );
    let mut out = Vec::with_capacity(others.len() + 1);
    out.push(ContentBlock::text(preview));
    out.extend(others);
    out
}

/// Apply `cap_tool_result_content` to a `ToolResult` block, preserving its
/// `tool_use_id` and `is_error`. Non-result blocks pass through.
fn cap_tool_result_block(block: ContentBlock, max: usize) -> ContentBlock {
    match block {
        ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => ContentBlock::ToolResult {
            tool_use_id,
            content: cap_tool_result_content(content, max),
            is_error,
        },
        other => other,
    }
}

/// Bring `messages` under `max_bytes` while keeping the wire format
/// pairing-safe.
///
/// Phase A — clear content, keep blocks: walk the messages oldest→newest,
/// excluding the most recent `keep_recent`, and replace each
/// `tool_result` body with `BYTE_CAP_CLEARED_MARKER`. The block and its
/// `tool_use_id` survive, so no `tool_use` is ever orphaned by this pass.
/// This is the common case — a single oversized `tool_result` (a freshly
/// extracted PDF/xlsx body) is what usually blows the cap.
///
/// Phase B — fallback drop: if clearing every eligible body still leaves
/// us over the cap (bulk sits in text / thinking / tool_use args), drop
/// whole leading messages as a last resort. Any forward-orphan this
/// creates is repaired by `ensure_tool_result_pairing` at the request
/// boundary; a leading `Role::Tool` left at the new head is stripped here
/// so the fallback alone never emits a leading tool message.
///
/// Layer ③ (`per_result_max`): before the total-cap phases, clamp *any*
/// single `tool_result` body larger than `per_result_max` to a head+tail
/// preview — even one inside the protected `keep_recent` tail. A single
/// oversized recent result (a legacy row from before the capture-time cap,
/// or one written by another path) would otherwise dominate the window
/// while Phase A's `keep_recent` protection deliberately skips it. `0`
/// disables this clamp.
pub(crate) fn enforce_history_byte_cap(
    mut messages: Vec<Message>,
    max_bytes: usize,
    keep_recent: usize,
    per_result_max: usize,
) -> Vec<Message> {
    if max_bytes == 0 || messages.is_empty() {
        return messages;
    }

    // Layer ③: retroactively clamp oversized individual results anywhere
    // in the window (including the recent tail) to a preview.
    if per_result_max > 0 {
        for msg in messages.iter_mut() {
            if !matches!(msg.role, Role::Tool) {
                continue;
            }
            for block in msg.content.iter_mut() {
                if let ContentBlock::ToolResult { content, .. } = block {
                    if tool_result_text_len(content) > per_result_max {
                        *content = cap_tool_result_content(std::mem::take(content), per_result_max);
                    }
                }
            }
        }
    }

    let mut total = messages_byte_size(&messages);

    // Phase A: clear old tool_result bodies (only when over cap).
    // Protect the most recent `keep_recent` messages (floored at 1) so
    // the model still sees its latest tool work verbatim. Single pass per
    // message: only clear a body that is actually LARGER than the marker
    // (so clearing always shrinks, never grows a tiny body), and account
    // the freed bytes incrementally.
    const MARKER_LEN: usize = BYTE_CAP_CLEARED_MARKER.len();
    let mut cleared = 0usize;
    if total > max_bytes {
        let protect_from = messages.len().saturating_sub(keep_recent.max(1));
        for msg in messages.iter_mut().take(protect_from) {
            if total <= max_bytes {
                break;
            }
            if !matches!(msg.role, Role::Tool) {
                continue;
            }
            let mut freed = 0usize;
            for block in msg.content.iter_mut() {
                if let ContentBlock::ToolResult {
                    content, is_error, ..
                } = block
                {
                    // Errors are small and load-bearing; leave them.
                    if *is_error {
                        continue;
                    }
                    let body = tool_result_text_len(content);
                    // Skip bodies no larger than the marker — that covers
                    // already-cleared results and anything too small to be
                    // worth eliding (clearing would only add bytes).
                    if body <= MARKER_LEN {
                        continue;
                    }
                    *content = vec![ContentBlock::text(BYTE_CAP_CLEARED_MARKER)];
                    freed += body - MARKER_LEN;
                }
            }
            if freed > 0 {
                total = total.saturating_sub(freed);
                cleared += 1;
            }
        }
    }

    // Phase B: still over cap — drop whole leading messages.
    let original_len = messages.len();
    while total > max_bytes && messages.len() > 1 {
        let dropped = messages.remove(0);
        total = total.saturating_sub(message_byte_size(&dropped));
    }
    // On every path (even when already under cap) the head must NOT be a
    // `Role::Tool` message — providers reject `tool` messages that don't
    // follow an assistant `tool_use`. Drop leading orphans regardless of
    // whether Phase B ran, so this function never returns a leading tool.
    while messages
        .first()
        .map(|m| matches!(m.role, Role::Tool))
        .unwrap_or(false)
    {
        messages.remove(0);
    }
    let dropped = original_len - messages.len();
    if cleared > 0 || dropped > 0 {
        warn!(
            cleared,
            dropped,
            kept = messages.len(),
            cap_bytes = max_bytes,
            "history-load: enforced byte cap (cleared old tool_result bodies, then dropped oldest)"
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
            ContentBlock::ToolResult { content, .. } => n += tool_result_text_len(content),
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

/// Conversational half of the dual history window. Cuts a whole PREFIX
/// so that at most `conversation_limit` *conversational* (User +
/// Assistant) messages remain (the most recent ones). Tool and System
/// messages don't count toward the budget but ride along inside the
/// kept suffix.
///
/// Cutting a whole prefix (rather than dropping individual messages)
/// means dropped tool round-trips drop as pairs — the only pairing
/// hazard is a leading `Role::Tool` left at the new head when the cut
/// lands mid-round-trip, which `enforce_history_byte_cap` and
/// `ensure_tool_result_pairing` both strip downstream.
///
/// `conversation_limit == 0` disables the trim (returns the input
/// unchanged), as does any history whose conversational count already
/// fits.
fn trim_to_conversation_window(messages: Vec<Message>, conversation_limit: usize) -> Vec<Message> {
    if conversation_limit == 0 {
        return messages;
    }
    let conv_total = messages
        .iter()
        .filter(|m| matches!(m.role, Role::User | Role::Assistant))
        .count();
    if conv_total <= conversation_limit {
        return messages;
    }
    let to_drop = conv_total - conversation_limit;
    let mut dropped = 0usize;
    let mut cut = 0usize;
    for (i, m) in messages.iter().enumerate() {
        // Stop BEFORE counting/advancing past the first message we want
        // to keep — otherwise we'd drop one conversational turn too many.
        if dropped == to_drop {
            cut = i;
            break;
        }
        if matches!(m.role, Role::User | Role::Assistant) {
            dropped += 1;
        }
        cut = i + 1;
    }
    messages.into_iter().skip(cut).collect()
}

/// Render a compact, bounded listing of the project workspace's top
/// level for injection into the system prompt. Uploaded files land at
/// the workspace root (see [`Engine::stage_attachment`]), so a top-level
/// view surfaces exactly what the user sent. Hidden entries and noise
/// directories (build output, dependency trees) are pruned; the listing
/// is capped in both entry count and characters. Returns `""` for a
/// missing / empty workspace so the caller emits no segment.
fn render_workspace_files(dir: &std::path::Path) -> String {
    const MAX_ENTRIES: usize = 60;
    const MAX_CHARS: usize = 4096;
    /// Non-dotted directories that are build output or dependency trees,
    /// never user uploads. (Dotted dirs like `.git` / `.snaca` are
    /// already skipped by the hidden-entry filter below.)
    const NOISE_DIRS: &[&str] = &[
        "node_modules",
        "target",
        "bin",
        "obj",
        "venv",
        "__pycache__",
        "dist",
        "build",
    ];

    let Ok(read) = std::fs::read_dir(dir) else {
        return String::new();
    };
    // (is_dir, name, size) — skip hidden entries and noise dirs.
    let mut entries: Vec<(bool, String, u64)> = Vec::new();
    for ent in read.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = ent.metadata() else { continue };
        let is_dir = meta.is_dir();
        if is_dir && NOISE_DIRS.contains(&name.as_str()) {
            continue;
        }
        entries.push((is_dir, name, if is_dir { 0 } else { meta.len() }));
    }
    if entries.is_empty() {
        return String::new();
    }
    // Files first (false < true), then dirs; each group alphabetical —
    // the user's uploads (files at the root) lead the listing.
    entries.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    let total = entries.len();
    let mut out = String::new();
    let mut shown = 0usize;
    for (is_dir, name, size) in entries.into_iter().take(MAX_ENTRIES) {
        let line = if is_dir {
            format!("- {name}/\n")
        } else {
            format!("- {name} ({})\n", human_size(size))
        };
        if out.len() + line.len() > MAX_CHARS {
            break;
        }
        out.push_str(&line);
        shown += 1;
    }
    if shown < total {
        out.push_str(&format!("- […{} more not shown]\n", total - shown));
    }
    out
}

/// Compact human-readable byte size (`832 B`, `12.4 KiB`, `5.3 MiB`).
/// Binary (1024-based) divisions with matching IEC unit labels.
fn human_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * 1024;
    const GB: u64 = 1024 * 1024 * 1024;
    match bytes {
        b if b < KB => format!("{b} B"),
        b if b < MB => format!("{:.1} KiB", b as f64 / KB as f64),
        b if b < GB => format!("{:.1} MiB", b as f64 / MB as f64),
        b => format!("{:.1} GiB", b as f64 / GB as f64),
    }
}

/// Filter a `Role::Tool` message's blocks so only well-formed
/// `tool_result`s survive: each must answer a `tool_use` that appeared
/// earlier (`seen_tool_use_ids`) and must not repeat an id already
/// answered (`answered_ids`). Reverse orphans (a result whose
/// `tool_use` was dropped by compaction / never existed) and duplicate
/// results (from resume or double-splice) are stripped. Kept ids are
/// recorded into `answered_ids`. Non-`tool_result` blocks pass through
/// untouched.
fn filter_tool_result_blocks(
    content: Vec<ContentBlock>,
    seen_tool_use_ids: &std::collections::HashSet<String>,
    answered_ids: &mut std::collections::HashSet<String>,
) -> Vec<ContentBlock> {
    content
        .into_iter()
        .filter(|b| match b {
            ContentBlock::ToolResult { tool_use_id, .. } => {
                let id = tool_use_id.as_str();
                if !seen_tool_use_ids.contains(id) {
                    warn!(%id, "history-load: dropping orphan tool_result with no matching tool_use");
                    return false;
                }
                if !answered_ids.insert(id.to_string()) {
                    warn!(%id, "history-load: dropping duplicate tool_result");
                    return false;
                }
                true
            }
            _ => true,
        })
        .collect()
}

/// Single pairing-invariant gate, applied to the *complete* assembled
/// history right before it is sent to the provider (see
/// `call_llm_and_prerun`). Guarantees the wire format is well-formed:
///
/// * every assistant `tool_use` is followed by a `Role::Tool` message
///   answering each id (a synthetic `tool_error` is spliced in for any
///   that isn't — the forward-orphan case that a compaction boundary or
///   an interrupted turn can leave behind);
/// * every `tool_result` answers a `tool_use` seen earlier, else it is
///   dropped (reverse orphan — the assistant half was compacted away);
/// * no `tool_use_id` is answered twice (dedup, guards resume /
///   double-splice).
///
/// Why one gate over the whole list rather than per-segment repairs:
/// `load_history` assembles `head ++ summary ++ live_tail`, and an
/// orphan can sit on any seam. Running the invariant once at the
/// request boundary means no assembly path can bypass it.
///
/// Providers like DeepSeek (and Anthropic) reject any history whose
/// `tool_calls` aren't all answered, or that carries a dangling
/// `tool_result` — this is the backstop that keeps that from happening.
fn ensure_tool_result_pairing(messages: Vec<Message>) -> Vec<Message> {
    use std::collections::HashSet;
    let mut out: Vec<Message> = Vec::with_capacity(messages.len());
    let mut iter = messages.into_iter().peekable();
    // Every `tool_use` id emitted by an assistant so far, and every
    // `tool_result` id already consumed. Accumulated across the whole
    // list so reverse-orphan and dedup checks span message boundaries.
    let mut seen_tool_use_ids: HashSet<String> = HashSet::new();
    let mut answered_ids: HashSet<String> = HashSet::new();
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
            // Strip reverse-orphan / duplicate result blocks; if the
            // message is emptied out, drop it entirely.
            let filtered =
                filter_tool_result_blocks(msg.content, &seen_tool_use_ids, &mut answered_ids);
            if filtered.is_empty() {
                continue;
            }
            out.push(Message {
                content: filtered,
                ..msg
            });
            continue;
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
        // Record this assistant's ids before touching the following
        // tool message so its results resolve against them.
        for id in &assistant_tool_uses {
            seen_tool_use_ids.insert(id.clone());
        }

        out.push(msg);

        if assistant_tool_uses.is_empty() {
            continue;
        }
        // Finalize the following tool message (if any) FIRST — filter
        // its blocks — then decide which tool_use ids are still
        // unanswered. Deriving `missing` from what *survives* filtering
        // (not a raw peek) is load-bearing: a result dropped as a
        // duplicate or reverse-orphan must count as unanswered so it
        // gets a synthetic error, otherwise the assistant tool_use is
        // silently orphaned again.
        let mut result_msg: Option<Message> =
            if matches!(iter.peek().map(|m| m.role), Some(Role::Tool)) {
                let next = iter.next().expect("peeked Some");
                let filtered =
                    filter_tool_result_blocks(next.content, &seen_tool_use_ids, &mut answered_ids);
                Some(Message {
                    content: filtered,
                    ..next
                })
            } else {
                None
            };
        let answered_here: HashSet<String> = result_msg
            .as_ref()
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
            .unwrap_or_default();
        let missing: Vec<String> = assistant_tool_uses
            .into_iter()
            .filter(|id| !answered_here.contains(id))
            .collect();
        if !missing.is_empty() {
            warn!(
                count = missing.len(),
                "history-load: synthesising tool_error blocks for orphan tool_use ids"
            );
            let synth = synthetic_tool_errors(missing, &mut answered_ids);
            match result_msg.as_mut() {
                Some(m) => m.content.extend(synth),
                None => {
                    result_msg = Some(Message {
                        id: MessageId::new(),
                        role: Role::Tool,
                        content: synth,
                        created_at: Utc::now(),
                    })
                }
            }
        }
        // Push the finalized tool turn. It is never empty here: this
        // branch only runs when `assistant_tool_uses` is non-empty, and
        // if the filtered content were empty then `answered_here` would
        // be empty, forcing `missing` = all ids and a synthetic error to
        // be appended above. The assert documents (and, in tests, guards)
        // that invariant — an empty tool turn would re-orphan the
        // assistant, the exact failure this gate exists to prevent.
        if let Some(m) = result_msg {
            debug_assert!(
                !m.content.is_empty(),
                "finalized tool turn must answer the assistant's tool_use ids"
            );
            out.push(m);
        }
    }
    out
}

/// Build a `tool_error` block for each orphaned tool_use id, marking each
/// id as answered. Recording the id is load-bearing: a synthetic error
/// answers the tool_use, so a later stray/duplicate `tool_result` for the
/// same id must be deduped by `filter_tool_result_blocks` rather than
/// double-answering it on the wire.
fn synthetic_tool_errors(
    ids: Vec<String>,
    answered_ids: &mut std::collections::HashSet<String>,
) -> Vec<ContentBlock> {
    ids.into_iter()
        .map(|id| {
            answered_ids.insert(id.clone());
            ContentBlock::tool_error(
                snaca_core::ToolUseId::new(id),
                "tool execution interrupted (orphan tool_use repaired at load time)".to_string(),
            )
        })
        .collect()
}

/// Flatten a slice of messages into a transcript the summariser
/// can read in one shot. We deliberately drop tool-use payloads beyond
/// their names — the summary just needs to know "the assistant called
/// Read on file X", not the full byte stream of the result.
///
/// Takes `&[Message]` rather than the raw `MessageRow` so callers can
/// pre-run `collapse_old_tool_results` against the input — both paths
/// (compaction summary, live load) get the same view.
///
/// Every block's text is capped at `max_block_bytes` and the whole
/// transcript at `total_max` (layer ② of the oversized-result defence).
/// `collapse_old_tool_results` only shrinks *read-only, non-error*
/// results, so a large Bash / write / error body would otherwise reach
/// here in full and blow the summary request itself — the request that is
/// supposed to *rescue* an over-long context. The per-block cap stops one
/// message dominating; the `total_max` ceiling bounds the aggregate so a
/// band of many mid-sized results can't overflow it either.
///
/// When the band overflows `total_max` we keep the **newest** messages and
/// drop the oldest (noting how many). The band is the *middle* slice —
/// its head overlaps the `preserved_head` that compaction already keeps
/// verbatim, while its newest messages bridge into the verbatim live tail,
/// so recency is the more useful thing to preserve. `0` disables the
/// respective cap.
fn render_for_summary(rows: &[Message], max_block_bytes: usize, total_max: usize) -> String {
    // Push `s`, truncated on a char boundary to `max_block_bytes`, with a
    // short note when anything was dropped.
    fn push_capped(out: &mut String, s: &str, max: usize) {
        let end = floor_char_boundary(s, max);
        out.push_str(&s[..end]);
        if end < s.len() {
            out.push_str(&format!("[…{} bytes truncated…]", s.len() - end));
        }
    }
    // Render one message (label + per-block-capped content) into a chunk.
    fn render_row(r: &Message, max_block_bytes: usize) -> String {
        let label = match r.role {
            Role::User => "USER",
            Role::Assistant => "ASSISTANT",
            Role::Tool => "TOOL",
            Role::System => "SYSTEM",
        };
        let mut out = String::new();
        out.push_str(label);
        out.push_str(": ");
        for block in &r.content {
            match block {
                ContentBlock::Text { text } => push_capped(&mut out, text, max_block_bytes),
                ContentBlock::Thinking { text, .. } => {
                    out.push_str("[thinking] ");
                    push_capped(&mut out, text, max_block_bytes);
                }
                ContentBlock::ToolUse { name, input, .. } => {
                    let input = serde_json::to_string(input).unwrap_or_default();
                    out.push_str(&format!("[called tool {name} with "));
                    push_capped(&mut out, &input, max_block_bytes);
                    out.push(']');
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
                    let body: String = content
                        .iter()
                        .filter_map(|inner| match inner {
                            ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect();
                    push_capped(&mut out, &body, max_block_bytes);
                }
                ContentBlock::Image { .. } => out.push_str("[image]"),
            }
            out.push(' ');
        }
        out.push('\n');
        out
    }

    // Render newest→oldest, keeping messages until the byte budget is
    // reached (always at least the newest, whose own blocks are already
    // per-block-capped). Rendering stops at the budget, so the
    // dropped-oldest prefix is never rendered. `total_max == 0` disables
    // the cap (keeps everything).
    let mut kept: Vec<String> = Vec::new();
    let mut used = 0usize;
    for r in rows.iter().rev() {
        let chunk = render_row(r, max_block_bytes);
        if total_max > 0 && !kept.is_empty() && used + chunk.len() > total_max {
            break;
        }
        used += chunk.len();
        kept.push(chunk);
    }
    let omitted = rows.len() - kept.len();
    let mut out = String::new();
    if omitted > 0 {
        out.push_str(&format!(
            "[… {omitted} older messages omitted to fit the summary budget …]\n"
        ));
    }
    // `kept` is newest→oldest; emit it chronologically.
    for chunk in kept.iter().rev() {
        out.push_str(chunk);
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

/// Placeholder substituted for a redacted message's body. Kept short so
/// it stays well under `collapse_tool_results_threshold` (the collapse
/// pass leaves it alone) and carries no flaggable content of its own.
pub(crate) const REDACTED_PLACEHOLDER: &str =
    "[SNACA: content omitted — flagged by provider content policy]";

/// Whether this error is a provider content-moderation rejection that the
/// engine should recover from by localizing and redacting the offending
/// history message (rather than surfacing a hard error that bricks the
/// thread on every replayed turn).
pub(crate) fn is_content_filter_error(err: &LlmError) -> bool {
    matches!(err, LlmError::ContentFiltered { .. })
}

/// Rewrite a single content block into a structurally-identical but
/// content-free form. Preserves everything the provider's message-shape
/// validation and tool_use/tool_result pairing depend on — block kind,
/// `ToolUse` id + name, `ToolResult` tool_use_id + is_error — while
/// replacing every free-text / argument / image payload with
/// [`REDACTED_PLACEHOLDER`]. Redacting any message therefore never
/// orphans a tool_result or drops a tool_use.
fn redact_block(block: ContentBlock) -> ContentBlock {
    match block {
        ContentBlock::Text { .. } | ContentBlock::Thinking { .. } | ContentBlock::Image { .. } => {
            ContentBlock::text(REDACTED_PLACEHOLDER)
        }
        ContentBlock::ToolUse { id, name, .. } => ContentBlock::ToolUse {
            id,
            name,
            input: serde_json::json!({ "_snaca_redacted": true }),
        },
        ContentBlock::ToolResult {
            tool_use_id,
            is_error,
            ..
        } => ContentBlock::ToolResult {
            tool_use_id,
            content: vec![ContentBlock::text(REDACTED_PLACEHOLDER)],
            is_error,
        },
    }
}

/// Apply [`redact_block`] to every block of a message's content.
fn redact_message_content(content: Vec<ContentBlock>) -> Vec<ContentBlock> {
    content.into_iter().map(redact_block).collect()
}

/// Build the LLM-facing [`Message`] from a persisted row, substituting a
/// neutral placeholder for the body when the row is marked redacted.
fn message_from_persisted(row: snaca_state::MessageRow) -> Message {
    let content = if row.redacted_at.is_some() {
        redact_message_content(row.content)
    } else {
        row.content
    };
    Message {
        id: row.id,
        role: row.role,
        content,
        created_at: row.created_at,
    }
}

/// Outcome of [`Engine::localize_and_redact_poison`].
enum PoisonLocation {
    /// The offending message(s) were localized and marked redacted; a
    /// retry of the turn will now pass the content filter.
    Redacted(Vec<MessageId>),
    /// The poison is in a user message or the system prompt — nothing the
    /// engine can safely auto-redact. The caller degrades gracefully.
    Unredactable,
}

/// Result of a single content-moderation probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeOutcome {
    /// The request passed the provider's content filter.
    Passed,
    /// The provider's content filter rejected the request.
    Filtered,
}

/// Assemble a probe history from raw rows, neutralizing every row in
/// `redact_ids` (the in-memory trial set) as well as rows already marked
/// redacted in the DB. Mirrors `load_history`'s non-compaction pipeline
/// (window → byte-cap → collapse) so a probe's shape matches what a real
/// turn would send; pairing repair is applied by the caller.
fn build_probe_history(
    rows: &[snaca_state::MessageRow],
    redact_ids: &HashSet<MessageId>,
    cfg: &EngineConfig,
) -> Vec<Message> {
    let msgs: Vec<Message> = rows
        .iter()
        .map(|r| {
            let redact = r.redacted_at.is_some() || redact_ids.contains(&r.id);
            let content = if redact {
                redact_message_content(r.content.clone())
            } else {
                r.content.clone()
            };
            Message {
                id: r.id,
                role: r.role,
                content,
                created_at: r.created_at,
            }
        })
        .collect();
    let windowed = trim_to_conversation_window(msgs, cfg.conversation_history_limit as usize);
    let bounded = enforce_history_byte_cap(
        windowed,
        cfg.history_max_bytes,
        cfg.compact_keep_recent,
        cfg.max_tool_result_bytes,
    );
    collapse_old_tool_results(
        bounded,
        cfg.compact_keep_recent,
        cfg.collapse_tool_results_threshold,
    )
}

#[cfg(test)]
mod system_prompt_tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn date_preamble_uses_iso_date_and_weekday() {
        // 2026-05-19 is a Tuesday.
        let fixed = chrono::Utc.with_ymd_and_hms(2026, 5, 19, 12, 0, 0).unwrap();
        let preamble = current_date_preamble(fixed);
        assert_eq!(preamble, "Today's date is 2026-05-19 (Tuesday).\n\n");
    }

    #[test]
    fn compose_prepends_date_then_base() {
        let out = compose_system_prompt("YOU ARE SNACA.", "", "");
        // The preamble line lands first, followed by the base content.
        assert!(out.starts_with("Today's date is "));
        assert!(out.contains("\n\nYOU ARE SNACA."));
    }

    #[test]
    fn compose_keeps_memory_section_and_drops_recall_input() {
        // The recall slot is a forward-compat placeholder while the
        // frozen-snapshot rework lands; today it must be ignored so
        // the cacheable prefix stays byte-stable across turns.
        let out = compose_system_prompt("BASE", "  user/foo — bar  ", "  hit one  ");
        assert!(out.contains("Today's date is "));
        assert!(out.contains("BASE"));
        assert!(out.contains("## Project Memory"));
        assert!(out.contains("user/foo — bar"));
        assert!(!out.contains("## Relevant Memories"));
        assert!(!out.contains("hit one"));
    }

    #[test]
    fn segments_collapse_into_single_cacheable_prefix() {
        // No more vector-recall second segment — base + memory live in
        // one cacheable segment. Loop-guard hints (tested separately)
        // are the only thing that can ever push a volatile second
        // segment into the prompt now.
        let segs = compose_system_segments("BASE", "user/foo — bar", "hit one", "", None);
        assert_eq!(
            segs.len(),
            1,
            "expected one cacheable segment, got {segs:?}"
        );
        assert!(segs[0].cacheable, "the only segment must be cacheable");
        assert!(segs[0].text.contains("BASE"));
        assert!(segs[0].text.contains("## Project Memory"));
        assert!(segs[0].text.contains("user/foo — bar"));
        assert!(!segs[0].text.contains("Relevant Memories"));
    }

    #[test]
    fn segments_collapse_when_no_recall() {
        let segs = compose_system_segments("BASE", "user/foo", "", "", None);
        assert_eq!(segs.len(), 1, "no recall => single segment");
        assert!(segs[0].cacheable);
        assert!(segs[0].text.contains("BASE"));
        assert!(segs[0].text.contains("user/foo"));
    }

    #[test]
    fn segments_collapse_when_no_memory_and_no_recall() {
        let segs = compose_system_segments("BASE", "", "", "", None);
        assert_eq!(segs.len(), 1);
        assert!(segs[0].cacheable);
        assert!(!segs[0].text.contains("## Project Memory"));
    }

    #[test]
    fn workspace_files_ride_a_volatile_segment_without_busting_the_prefix() {
        // With a file list present, a SECOND segment appears — and it is
        // volatile, so it never busts the cacheable memory prefix.
        let with_files = compose_system_segments(
            "BASE",
            "user/foo",
            "",
            "- report.pdf (1.2 KB)\n- notes.md (300 B)\n",
            None,
        );
        assert_eq!(with_files.len(), 2, "file list adds one segment");
        assert!(with_files[0].cacheable, "memory prefix stays cacheable");
        assert!(!with_files[1].cacheable, "file list segment is volatile");
        assert!(with_files[1].text.contains("## Workspace Files"));
        assert!(with_files[1].text.contains("report.pdf"));

        // The cacheable prefix is byte-identical whether or not the file
        // list changes — the whole point of holding it out of the cache.
        let no_files = compose_system_segments("BASE", "user/foo", "", "", None);
        assert_eq!(
            with_files[0].text, no_files[0].text,
            "adding/removing files must not change the cacheable prefix"
        );
        assert_eq!(no_files.len(), 1, "empty file list emits no segment");
    }
}

#[cfg(test)]
mod history_window_tests {
    use super::*;

    fn u(text: &str) -> Message {
        Message::new(Role::User, vec![ContentBlock::text(text)])
    }
    fn a(text: &str) -> Message {
        Message::new(Role::Assistant, vec![ContentBlock::text(text)])
    }
    /// Assistant message that drives a tool call — counts toward the
    /// conversational budget, like the real loop.
    fn a_call(id: &str, name: &str) -> Message {
        Message::new(
            Role::Assistant,
            vec![
                ContentBlock::text("calling..."),
                ContentBlock::tool_use(id, name, json!({})),
            ],
        )
    }
    /// Tool-result envelope — excluded from the conversational budget;
    /// this is the key to the dual window.
    fn tr(id: &str, body: &str) -> Message {
        Message::new(
            Role::Tool,
            vec![ContentBlock::tool_result(
                ToolUseId::new(id),
                vec![ContentBlock::text(body)],
            )],
        )
    }
    fn has_text(messages: &[Message], needle: &str) -> bool {
        messages.iter().any(|m| {
            m.content.iter().any(|b| match b {
                ContentBlock::Text { text } => text == needle,
                _ => false,
            })
        })
    }
    fn conv_count(messages: &[Message]) -> usize {
        messages
            .iter()
            .filter(|m| matches!(m.role, Role::User | Role::Assistant))
            .count()
    }

    #[test]
    fn conversation_preserved_when_tool_results_present() {
        // Two file-reading round-trips interleaved with conversation.
        // Role::Tool result dumps must NOT consume the conversational
        // budget, so the opening goal survives a budget that a flat
        // last-N-rows window of the same count would have evicted.
        let big = "x".repeat(4096);
        let messages = vec![
            u("goal: edit config"),
            a_call("c1", "Bash"),
            tr("c1", &big),
            u("q2"),
            a_call("c2", "Bash"),
            tr("c2", &big),
            u("q3"),
            a("answer"),
        ];
        assert_eq!(conv_count(&messages), 6);

        let out = trim_to_conversation_window(messages.clone(), 6);
        assert!(
            has_text(&out, "goal: edit config"),
            "goal must survive the conversational window"
        );
        let flat_tail = &messages[messages.len() - 6..];
        assert!(
            !has_text(flat_tail, "goal: edit config"),
            "sanity: a flat last-6-rows window loses the goal"
        );
    }

    #[test]
    fn prefix_cut_keeps_pairing_valid() {
        // Cut lands mid-round-trip: repair must strip the leading orphan
        // tool result so providers don't reject a leading tool message.
        let messages = vec![
            a_call("c1", "Read"),
            tr("c1", "body"),
            u("a"),
            a("b"),
            u("c"),
            a("d"),
        ];
        let trimmed = trim_to_conversation_window(messages, 4);
        assert!(
            matches!(trimmed[0].role, Role::Tool),
            "setup: head is orphan tool"
        );
        let repaired = ensure_tool_result_pairing(trimmed);
        assert!(
            !matches!(repaired[0].role, Role::Tool),
            "repair must drop the leading orphan tool message"
        );
    }

    #[test]
    fn assistant_with_text_and_tool_use_counts_as_one() {
        let messages = vec![
            u("a"),
            a_call("c1", "Read"),
            tr("c1", "body"),
            u("b"),
            a("c"),
        ];
        let trimmed = trim_to_conversation_window(messages, 2);
        assert_eq!(
            conv_count(&trimmed),
            2,
            "exactly two conversational messages kept"
        );
        assert!(has_text(&trimmed, "b") && has_text(&trimmed, "c"));
        assert!(!has_text(&trimmed, "a"), "older user turn trimmed");
    }

    #[test]
    fn empty_all_tool_and_zero_limit_safe() {
        assert!(trim_to_conversation_window(Vec::new(), 5).is_empty());
        // zero limit disables the trim.
        let msgs = vec![u("a"), a("b")];
        assert_eq!(trim_to_conversation_window(msgs.clone(), 0).len(), 2);
        // all-tool history: no conversational messages → no-op.
        let all_tool = vec![tr("c1", "x"), tr("c2", "y")];
        let trimmed = trim_to_conversation_window(all_tool, 5);
        assert_eq!(trimmed.len(), 2, "trim leaves all-tool history untouched");
    }

    #[test]
    fn render_workspace_files_lists_uploads_and_prunes_noise() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("利润分析.xlsx"), vec![0u8; 2048]).unwrap();
        std::fs::write(root.join("notes.md"), b"hi").unwrap();
        std::fs::create_dir(root.join("slides")).unwrap();
        // Noise that must be pruned.
        std::fs::create_dir(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules").join("junk.js"), b"x").unwrap();
        std::fs::create_dir(root.join(".snaca")).unwrap();

        let out = render_workspace_files(root);
        assert!(out.contains("利润分析.xlsx"), "upload listed: {out}");
        assert!(out.contains("notes.md"));
        assert!(out.contains("slides/"), "user dir listed with slash: {out}");
        assert!(!out.contains("node_modules"), "noise dir pruned: {out}");
        assert!(!out.contains(".snaca"), "hidden dir pruned: {out}");
        // Files lead, dirs follow.
        assert!(out.find("notes.md").unwrap() < out.find("slides/").unwrap());
    }

    #[test]
    fn render_workspace_files_empty_for_missing_or_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(render_workspace_files(dir.path()), "");
        assert_eq!(render_workspace_files(&dir.path().join("nope")), "");
    }

    // ---- pairing-invariant gate (`ensure_tool_result_pairing`) ----

    /// Assistant message driving multiple tool calls in one turn.
    fn a_calls(ids: &[&str]) -> Message {
        let mut blocks = vec![ContentBlock::text("calling...")];
        for id in ids {
            blocks.push(ContentBlock::tool_use(*id, "Read", json!({})));
        }
        Message::new(Role::Assistant, blocks)
    }
    /// Ids answered (as `tool_result` or `tool_error`) by a `Role::Tool` msg.
    fn answered_ids(m: &Message) -> Vec<String> {
        m.content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ToolResult { tool_use_id, .. } => {
                    Some(tool_use_id.as_str().to_string())
                }
                _ => None,
            })
            .collect()
    }
    /// Concatenated text of the `tool_result` block answering `id`.
    fn tool_result_body(m: &Message, id: &str) -> String {
        m.content
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    ..
                } if tool_use_id.as_str() == id => Some(
                    content
                        .iter()
                        .filter_map(|c| match c {
                            ContentBlock::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect::<String>(),
                ),
                _ => None,
            })
            .unwrap_or_default()
    }
    /// Assert the wire invariant a provider enforces: every assistant
    /// `tool_use` id is answered by the immediately-following tool
    /// message, and every `tool_result` answers an earlier `tool_use`.
    fn assert_pairing_valid(msgs: &[Message]) {
        let mut seen = std::collections::HashSet::new();
        for (i, m) in msgs.iter().enumerate() {
            match m.role {
                Role::Assistant => {
                    let ids: Vec<String> = m
                        .content
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::ToolUse { id, .. } => Some(id.as_str().to_string()),
                            _ => None,
                        })
                        .collect();
                    for id in &ids {
                        seen.insert(id.clone());
                    }
                    if !ids.is_empty() {
                        let next = msgs.get(i + 1);
                        assert!(
                            matches!(next.map(|n| n.role), Some(Role::Tool)),
                            "assistant tool_use at {i} not followed by a tool message"
                        );
                        let ans = answered_ids(next.unwrap());
                        for id in &ids {
                            assert!(ans.contains(id), "tool_use {id} at {i} left unanswered");
                        }
                    }
                }
                Role::Tool => {
                    for id in answered_ids(m) {
                        assert!(
                            seen.contains(&id),
                            "tool_result {id} answers no prior tool_use"
                        );
                    }
                }
                _ => {}
            }
        }
    }

    #[test]
    fn boundary_gate_repairs_head_orphan_from_compaction() {
        // Regression for the production incident: `load_history` splices
        // `head ++ summary ++ live`, and the head's last message is an
        // assistant with two tool_uses whose results were compacted away.
        // The gate must synthesize a tool message between it and the
        // summary so the assistant tool_use is no longer orphaned.
        let head = vec![u("q1"), a("hi"), u("q2"), a_calls(&["c1", "c2"])];
        let summary = u("[SNACA SUMMARY of earlier conversation]");
        let live = vec![a_call("c3", "Bash"), tr("c3", "body")];
        let assembled = [head, vec![summary], live].concat();

        let out = ensure_tool_result_pairing(assembled);
        assert_pairing_valid(&out);
        // The synthetic answers sit right after the head assistant,
        // before the summary user message.
        let idx = out
            .iter()
            .position(|m| {
                m.content
                    .iter()
                    .any(|b| matches!(b, ContentBlock::ToolUse { id, .. } if id.as_str() == "c1"))
            })
            .unwrap();
        assert!(matches!(out[idx + 1].role, Role::Tool));
        let ans = answered_ids(&out[idx + 1]);
        assert!(ans.contains(&"c1".to_string()) && ans.contains(&"c2".to_string()));
        assert!(
            matches!(out[idx + 2].role, Role::User),
            "summary preserved after synth"
        );
    }

    #[test]
    fn boundary_gate_drops_reverse_orphan_block_keeps_valid() {
        // A tool message carrying one valid result (c1) and one orphan
        // (z, whose tool_use never existed): keep c1, drop z.
        let tool_msg = Message::new(
            Role::Tool,
            vec![
                ContentBlock::tool_result(ToolUseId::new("c1"), vec![ContentBlock::text("ok")]),
                ContentBlock::tool_result(ToolUseId::new("z"), vec![ContentBlock::text("orphan")]),
            ],
        );
        let out = ensure_tool_result_pairing(vec![u("q"), a_call("c1", "Read"), tool_msg]);
        assert_pairing_valid(&out);
        let ans = answered_ids(&out[2]);
        assert_eq!(ans, vec!["c1".to_string()], "orphan z dropped, c1 kept");
    }

    #[test]
    fn boundary_gate_dedups_repeated_result() {
        let tool_msg = Message::new(
            Role::Tool,
            vec![
                ContentBlock::tool_result(ToolUseId::new("c1"), vec![ContentBlock::text("first")]),
                ContentBlock::tool_result(ToolUseId::new("c1"), vec![ContentBlock::text("dupe")]),
            ],
        );
        let out = ensure_tool_result_pairing(vec![u("q"), a_call("c1", "Read"), tool_msg]);
        assert_eq!(
            answered_ids(&out[2]),
            vec!["c1".to_string()],
            "duplicate c1 dropped"
        );
    }

    #[test]
    fn byte_cap_clears_old_tool_result_body_keeps_pairing() {
        let big = "x".repeat(5000);
        let msgs = vec![
            u("q"),
            a_call("c1", "Read"),
            tr("c1", &big),
            u("q2"),
            a_call("c2", "Read"),
            tr("c2", "recent"),
        ];
        let out = enforce_history_byte_cap(msgs, 2000, 2, 0);
        assert_eq!(out.len(), 6, "no message dropped — content cleared instead");
        assert!(messages_byte_size(&out) <= 2000, "under cap after clearing");
        // c1 body elided to the marker, block + id intact.
        assert_eq!(answered_ids(&out[2]), vec!["c1".to_string()]);
        assert!(
            tool_result_body(&out[2], "c1") == BYTE_CAP_CLEARED_MARKER,
            "c1 body cleared to marker"
        );
        // Recent tail (within keep_recent=2) left verbatim.
        assert_eq!(
            tool_result_body(&out[5], "c2"),
            "recent",
            "recent tool result untouched"
        );
    }

    #[test]
    fn byte_cap_falls_back_to_drop_when_bulk_not_clearable() {
        // Oversized bulk sits in a user text block — nothing to clear, so
        // Phase B drops leading messages.
        let big = "x".repeat(5000);
        let msgs = vec![u(&big), a("small"), u("q2"), a("keep")];
        let out = enforce_history_byte_cap(msgs, 300, 1, 0);
        assert!(out.len() < 4, "leading messages dropped");
        assert!(has_text(&out, "keep"), "recent turn survives");
        assert!(!matches!(out[0].role, Role::Tool), "no leading orphan tool");
    }

    #[test]
    fn boundary_gate_dedup_does_not_orphan_assistant() {
        // Regression for the review finding: a double-spliced round-trip
        // (same tool_use id answered twice). The dedup drops the second
        // result — but `missing` must be derived from what survives
        // filtering, so the second assistant tool_use gets a synthetic
        // error rather than an empty tool message + orphan.
        let msgs = vec![
            u("q"),
            a_call("c1", "Read"),
            tr("c1", "first"),
            a_call("c1", "Read"),
            tr("c1", "dupe"),
        ];
        let out = ensure_tool_result_pairing(msgs);
        assert_pairing_valid(&out);
        assert!(
            out.iter()
                .all(|m| !(matches!(m.role, Role::Tool) && m.content.is_empty())),
            "no empty tool message emitted"
        );
        // Second turn's duplicate result was replaced by a synthetic error.
        assert!(
            matches!(out.last().map(|m| &m.role), Some(Role::Tool)),
            "last turn is the answering tool message"
        );
        assert_eq!(answered_ids(out.last().unwrap()), vec!["c1".to_string()]);
    }

    #[test]
    fn boundary_gate_synthetic_answer_dedups_later_stray_result() {
        // A(c1) is a forward orphan → gets a synthetic tool_error. A later
        // spliced tool message carries a stray real result for the same
        // c1. Because the synthetic answer records c1 as answered, the
        // stray must be deduped — otherwise c1 is answered twice on the
        // wire (synthetic error + stray result), which providers reject.
        let merged = Message::new(
            Role::Tool,
            vec![
                ContentBlock::tool_result(ToolUseId::new("c2"), vec![ContentBlock::text("ok")]),
                ContentBlock::tool_result(ToolUseId::new("c1"), vec![ContentBlock::text("stray")]),
            ],
        );
        let msgs = vec![
            a_call("c1", "Read"), // orphan: no following tool message
            u("x"),
            a_call("c2", "Read"),
            merged,
        ];
        let out = ensure_tool_result_pairing(msgs);
        assert_pairing_valid(&out);
        // c1 must be answered exactly once across the whole history.
        let c1_answers: usize = out
            .iter()
            .flat_map(|m| m.content.iter())
            .filter(|b| matches!(b, ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id.as_str() == "c1"))
            .count();
        assert_eq!(c1_answers, 1, "c1 answered exactly once (stray deduped)");
    }

    #[test]
    fn byte_cap_strips_leading_tool_even_under_cap() {
        // Regression for the review finding: when already under the byte
        // cap, the leading-Role::Tool strip must still run so the function
        // never returns a history that begins with an unattached tool
        // message.
        let msgs = vec![tr("c1", "orphan"), a("b"), u("c")];
        let out = enforce_history_byte_cap(msgs, 10_000_000, 6, 0);
        assert!(
            !matches!(out[0].role, Role::Tool),
            "leading orphan tool stripped"
        );
        assert_eq!(out.len(), 2);
    }

    // ---- oversized-tool-result defence (layers ①/②/③) ----

    fn result_body_text(block: &ContentBlock) -> String {
        match block {
            ContentBlock::ToolResult { content, .. } => content
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::Text { text } => Some(text.clone()),
                    _ => None,
                })
                .collect(),
            _ => String::new(),
        }
    }

    #[test]
    fn cap_tool_result_truncates_oversized_body_keeps_id() {
        // Layer ①: a huge body is truncated to a head+tail preview while
        // the tool_use_id and is_error survive (so pairing is intact).
        let big = "x".repeat(500_000);
        let block = ContentBlock::tool_result(ToolUseId::new("c1"), vec![ContentBlock::text(&big)]);
        let capped = cap_tool_result_block(block, 100_000);
        match &capped {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                ..
            } => {
                assert_eq!(tool_use_id.as_str(), "c1");
                let len = tool_result_text_len(content);
                assert!(len <= 100_000 + 256, "truncated to ~max, got {len}");
                assert!(result_body_text(&capped).contains("bytes truncated"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[test]
    fn cap_tool_result_noop_when_small_or_disabled() {
        let block =
            ContentBlock::tool_result(ToolUseId::new("c1"), vec![ContentBlock::text("small")]);
        assert_eq!(cap_tool_result_block(block.clone(), 100_000), block);
        // max == 0 disables the cap entirely.
        let big = ContentBlock::tool_result(
            ToolUseId::new("c1"),
            vec![ContentBlock::text("x".repeat(50_000))],
        );
        assert_eq!(cap_tool_result_block(big.clone(), 0), big);
    }

    #[test]
    fn render_for_summary_caps_each_block() {
        // Layer ②: a large tool_error body (which collapse never shrinks)
        // must not blow the summary render.
        let big_err = Message::new(
            Role::Tool,
            vec![ContentBlock::tool_error(
                ToolUseId::new("c1"),
                "x".repeat(500_000),
            )],
        );
        let rendered = render_for_summary(&[big_err], 16 * 1024, 256 * 1024);
        assert!(
            rendered.len() < 40_000,
            "render bounded, got {}",
            rendered.len()
        );
        assert!(rendered.contains("truncated"));
    }

    #[test]
    fn render_for_summary_bounds_aggregate() {
        // Layer ② aggregate guarantee: many results each UNDER the per-block
        // cap must still be bounded in total, so a large band can't overflow
        // the summary request.
        let msgs: Vec<Message> = (0..100)
            .map(|i| {
                Message::new(
                    Role::Tool,
                    vec![ContentBlock::tool_result(
                        ToolUseId::new(format!("c{i}")),
                        // Distinguishable marker at the head of each body so
                        // we can assert WHICH messages survived.
                        vec![ContentBlock::text(format!(
                            "MARK{i} {}",
                            "y".repeat(10_000)
                        ))],
                    )],
                )
            })
            .collect();
        // 100 × 10 KiB = ~1 MiB unbounded; total_max = 64 KiB must cap it
        // by keeping the newest suffix and dropping the oldest. Bound is
        // total_max + at most one (always-kept newest) message.
        let rendered = render_for_summary(&msgs, 16 * 1024, 64 * 1024);
        assert!(
            rendered.len() < 64 * 1024 + 16 * 1024,
            "aggregate bounded, got {}",
            rendered.len()
        );
        assert!(rendered.contains("messages omitted"));
        // Tail-biased: the newest survives, the oldest is dropped.
        assert!(rendered.contains("MARK99"), "newest kept");
        assert!(!rendered.contains("MARK0 "), "oldest dropped");
    }

    #[test]
    fn byte_cap_clamps_oversized_result_in_recent_tail() {
        // Layer ③ (the production incident shape): the newest tool result
        // is 1 MB and sits inside the protected keep_recent tail, so Phase
        // A skips it — but per_result_max must still clamp it to a preview.
        let big = "x".repeat(1_000_000);
        let msgs = vec![
            u("q"),
            a_call("c1", "Bash"),
            Message::new(
                Role::Tool,
                vec![ContentBlock::tool_result(
                    ToolUseId::new("c1"),
                    vec![ContentBlock::text(&big)],
                )],
            ),
        ];
        let out = enforce_history_byte_cap(msgs, 1_500_000, 6, 200 * 1024);
        let tool_msg = out.iter().find(|m| matches!(m.role, Role::Tool)).unwrap();
        let len = tool_result_text_len(&tool_msg.content);
        assert!(
            len <= 200 * 1024 + 256,
            "recent oversized result clamped, got {len}"
        );
        // tool_use_id preserved → still answers c1.
        assert_eq!(answered_ids(tool_msg), vec!["c1".to_string()]);
    }
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
