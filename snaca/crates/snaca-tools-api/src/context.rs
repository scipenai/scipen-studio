//! Per-call context passed to tool implementations.

use crate::context_request::ContextRequester;
use snaca_core::{ProjectId, SessionId, TenantId};
use std::any::Any;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use tokio_util::sync::CancellationToken;

/// One file the engine should send back to the IM channel after the
/// turn completes. Built by `SendFile`-style tools; collected by the
/// engine; surfaced through `TurnOutcome.outbound_files`; finally
/// delivered by the dispatcher via `plugin.file_upload`.
#[derive(Debug, Clone)]
pub struct OutboundFile {
    /// Absolute path inside the project workspace. Bytes get read off
    /// disk by the dispatcher rather than carried around in memory —
    /// keeps the engine free of buffers when a tool produces large
    /// outputs.
    pub absolute_path: PathBuf,
    /// Filename to display in IM. Defaults to `absolute_path.file_name()`.
    pub filename: String,
    /// MIME hint sent through to the plugin.
    pub mime_type: String,
}

/// Snapshot of a file's identity at the moment it was last Read. Used
/// by Edit / MultiEdit to refuse edits against stale views: if `mtime`
/// or `size` changed since the recorded read, the model is working
/// from outdated content and should re-Read first. `mtime + size` is
/// good enough — content hashing buys precision we don't need and
/// doubles the cost of every Read.
///
/// `partial` is true when the Read returned only a slice of the file
/// (offset > 0 or limit truncated the tail). Edit / MultiEdit refuse
/// partial reads — the `old_string` the model is matching against may
/// live outside the window it actually saw, so a blind edit would
/// silently corrupt the unread portion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadRecord {
    pub mtime: SystemTime,
    pub size: u64,
    pub partial: bool,
}

/// Shared map of `absolute path -> ReadRecord`. The engine keeps one
/// tracker per thread (not per turn) so a user pinging "how's it
/// going?" mid-task doesn't force the model to re-Read every file just
/// to satisfy the Read-before-Edit gate. The mtime/size check in
/// edit.rs catches files that changed externally; the model's own
/// "old_string not found" feedback handles the case where it has
/// forgotten the file contents from its context window. Wrapped in
/// `Arc<Mutex<...>>` because multiple tool calls in one turn share it.
pub type ReadTracker = Arc<Mutex<HashMap<PathBuf, ReadRecord>>>;

/// Information available during a tool call. Cheap to clone (Arc inside).
#[derive(Debug, Clone)]
pub struct ToolContext {
    inner: Arc<Inner>,
}

#[derive(Debug, Clone)]
struct Inner {
    tenant_id: TenantId,
    project_id: ProjectId,
    session_id: SessionId,
    workspace_root: PathBuf,
    /// Side channel for tools that need to ship a file back to the
    /// IM channel. `None` in tests / direct embedding paths; `Some`
    /// when an IM channel is wired through. Mutex<Vec<...>> instead
    /// of an mpsc channel because tools are sync-await; one shared
    /// vec is the simplest correct primitive and the access pattern
    /// (push during turn, drain after) doesn't justify a real queue.
    outbound_files: Option<Arc<Mutex<Vec<OutboundFile>>>>,
    /// Per-thread record of every successful Read. Edit / MultiEdit
    /// consult this to enforce "Read before Edit" and to detect
    /// external modifications between Read and Edit. `None` keeps the
    /// old semantics — the tracker is opt-in so unit tests that drive
    /// Edit directly (without a Read step) keep working. Production
    /// turns always inject a tracker via `with_read_tracker`; the
    /// engine keeps one tracker per thread so it survives across
    /// turns.
    read_tracker: Option<ReadTracker>,
    /// Opaque side-channel for tools that need a long-lived shared
    /// resource the engine attaches. Currently used by Bash's
    /// `run_in_background` mode for its TaskRegistry (defined in
    /// `snaca-tools`). Stored as `Arc<dyn Any>` so this crate stays
    /// dependency-light: the concrete type lives in `snaca-tools`,
    /// callers downcast on read.
    task_registry: Option<Arc<dyn Any + Send + Sync>>,
    /// Opaque side-channel for `QuestionGate` (defined in
    /// `snaca-agent-api`). Used by the `AskUserQuestion` tool to send a
    /// multiple-choice prompt to the user via the IM channel and await
    /// their selection. Stored as `Arc<dyn Any>` for the same
    /// dependency-decoupling reason as `task_registry`: the concrete
    /// trait lives one layer up, this crate stays leaf.
    question_gate: Option<Arc<dyn Any + Send + Sync>>,
    /// Opaque side-channel for `MemoryProvider` (defined in
    /// `snaca-agent-api`). Memory tools downcast this slot when an
    /// embedder wires a custom memory backend; if absent they keep the
    /// historical file-tree sibling of `workspace_root`.
    memory_provider: Option<Arc<dyn Any + Send + Sync>>,
    /// Opaque handle to the built-in `snaca_memory::MemoryStore`.
    /// Stored type-erased so this API crate stays leaf. The engine
    /// injects one shared store per project/thread tool context so
    /// MemoryRead can record last-seen hashes that a later MemoryWrite
    /// uses for drift detection.
    memory_store: Option<Arc<dyn Any + Send + Sync>>,
    /// Cooperative cancellation signal for the current turn. The
    /// engine creates one token per `handle_turn_full` invocation and
    /// fires it on abort / timeout. Tools don't have to inspect this
    /// — the engine's `tokio::select!` wrapper drops their futures on
    /// cancel and that already kills child processes (Bash
    /// `kill_on_drop`), aborts in-flight HTTP requests, etc. Long
    /// CPU-bound tools that want to exit cleanly mid-loop can call
    /// `is_cancelled()` between iterations.
    cancellation_token: Option<CancellationToken>,
    /// Opaque handle to the SQLite `Database`. Stored as
    /// `Arc<dyn Any>` so this crate stays leaf — concrete type
    /// lives in `snaca-state` and `snaca-tools` downcasts on read.
    /// `None` for unit tests that don't need DB access.
    db_handle: Option<Arc<dyn Any + Send + Sync>>,
    /// When true, `MemoryWrite` tool calls don't hit the project
    /// memory tree directly — they stage a pending JSON file
    /// under `<project>/memory/pending/` and return a placeholder
    /// to the LLM. An operator approves / rejects via
    /// `snaca-cli memory approve|reject`. Default `false` (write
    /// directly). Mirrors hermes's `write_approval` switch.
    memory_write_approval: bool,
    /// scipen-studio fork: reverse-RPC channel back to the editor host
    /// (Zotero context lookups). Concrete impl lives in `snaca-editor`;
    /// `None` in tests / non-editor deployments.
    context_requester: Option<Arc<dyn ContextRequester>>,
}

impl ToolContext {
    pub fn new(
        tenant_id: TenantId,
        project_id: ProjectId,
        session_id: SessionId,
        workspace_root: PathBuf,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                tenant_id,
                project_id,
                session_id,
                workspace_root,
                outbound_files: None,
                read_tracker: None,
                task_registry: None,
                question_gate: None,
                memory_provider: None,
                memory_store: None,
                cancellation_token: None,
                db_handle: None,
                memory_write_approval: false,
                context_requester: None,
            }),
        }
    }

    /// Attach an outbound file collector. Tools call
    /// `queue_outbound_file(...)` to enqueue; engine drains via
    /// `take_outbound_files()` once the turn ends.
    pub fn with_outbound_files(mut self, files: Arc<Mutex<Vec<OutboundFile>>>) -> Self {
        let mut inner = (*self.inner).clone();
        inner.outbound_files = Some(files);
        self.inner = Arc::new(inner);
        self
    }

    /// Attach a Read tracker. Production turns inject one per turn so
    /// Edit / MultiEdit can enforce "Read before Edit" and refuse
    /// stale-view edits. Unit tests that don't care about that
    /// invariant can skip this and Edit will fall through to the old
    /// permissive behaviour.
    pub fn with_read_tracker(mut self, tracker: ReadTracker) -> Self {
        let mut inner = (*self.inner).clone();
        inner.read_tracker = Some(tracker);
        self.inner = Arc::new(inner);
        self
    }

    /// Attach a task registry (opaque). Concrete type lives in
    /// `snaca-tools`; this crate only holds the `Arc<dyn Any>` so the
    /// trait surface stays small. Bash's `run_in_background` mode and
    /// the companion TaskOutput / TaskStop tools downcast from this
    /// slot.
    pub fn with_task_registry(mut self, registry: Arc<dyn Any + Send + Sync>) -> Self {
        let mut inner = (*self.inner).clone();
        inner.task_registry = Some(registry);
        self.inner = Arc::new(inner);
        self
    }

    /// Attach a question gate (opaque). The concrete trait lives in
    /// `snaca-agent-api` (`QuestionGate`); this crate only holds the
    /// `Arc<dyn Any>` so the API surface stays leaf. The
    /// `AskUserQuestion` tool downcasts this slot to call into the gate.
    /// `None` (the default) makes `AskUserQuestion` return a clean
    /// "no question gate attached" tool_error — useful in tests and in
    /// direct-embed deployments that have no IM channel to ask.
    pub fn with_question_gate(mut self, gate: Arc<dyn Any + Send + Sync>) -> Self {
        let mut inner = (*self.inner).clone();
        inner.question_gate = Some(gate);
        self.inner = Arc::new(inner);
        self
    }

    /// Attach a memory provider (opaque). The concrete trait lives in
    /// `snaca-agent-api`; this crate only stores the typed-erased slot.
    /// MemoryRead / MemoryWrite downcast it to `MemoryProviderSlot`.
    pub fn with_memory_provider(mut self, provider: Arc<dyn Any + Send + Sync>) -> Self {
        let mut inner = (*self.inner).clone();
        inner.memory_provider = Some(provider);
        self.inner = Arc::new(inner);
        self
    }

    /// Attach the built-in file-tree memory store (opaque). Memory
    /// tools downcast this to `snaca_memory::MemoryStore` and clone it
    /// so drift detection survives across multiple MemoryRead /
    /// MemoryWrite calls in the same tool context.
    pub fn with_memory_store(mut self, store: Arc<dyn Any + Send + Sync>) -> Self {
        let mut inner = (*self.inner).clone();
        inner.memory_store = Some(store);
        self.inner = Arc::new(inner);
        self
    }

    /// Attach a per-turn cancellation token. The engine fires it when
    /// the turn is aborted (admin API, IM recall) or hits the
    /// wall-clock timeout. Tools needn't poll it: `tokio::select!` in
    /// the turn loop will drop their futures on cancel, which is
    /// enough to terminate child processes (Bash `kill_on_drop`),
    /// abort in-flight HTTP, and roll back file writes that hadn't
    /// flushed.
    pub fn with_cancellation_token(mut self, token: CancellationToken) -> Self {
        let mut inner = (*self.inner).clone();
        inner.cancellation_token = Some(token);
        self.inner = Arc::new(inner);
        self
    }

    /// Attach an opaque SQLite database handle. The concrete type
    /// is `snaca_state::Database`; this crate stays leaf so the
    /// slot is `Arc<dyn Any>` and callers downcast on read. The
    /// `session_search` tool reads through this to run BM25 over
    /// the message FTS5 index.
    pub fn with_db_handle(mut self, db: Arc<dyn Any + Send + Sync>) -> Self {
        let mut inner = (*self.inner).clone();
        inner.db_handle = Some(db);
        self.inner = Arc::new(inner);
        self
    }

    /// Opaque getter for the attached database handle. Caller
    /// downcasts to `snaca_state::Database`. `None` for unit tests
    /// without DB access — the `session_search` tool surfaces a
    /// clear "no db handle attached" error in that case.
    pub fn db_handle_opaque(&self) -> Option<Arc<dyn Any + Send + Sync>> {
        self.inner.db_handle.clone()
    }

    /// Toggle memory-write approval gating for this turn. With
    /// `true`, `MemoryWrite` tool calls don't write to the
    /// project's memory tree — they stage a pending JSON file
    /// under `<project>/memory/pending/<id>.json` and return a
    /// placeholder so the LLM can keep going. An operator
    /// approves with `snaca-cli memory approve <id>`.
    pub fn with_memory_write_approval(mut self, on: bool) -> Self {
        let mut inner = (*self.inner).clone();
        inner.memory_write_approval = on;
        self.inner = Arc::new(inner);
        self
    }

    /// Whether the engine wants `MemoryWrite` calls staged for
    /// human approval. The tool consults this — there's no other
    /// caller of this getter.
    pub fn memory_write_approval(&self) -> bool {
        self.inner.memory_write_approval
    }

    /// Opaque getter for the attached task registry. Caller downcasts
    /// to the concrete type they expect. `None` if no registry was
    /// attached (tests, direct embedding without background tasks).
    pub fn task_registry_opaque(&self) -> Option<Arc<dyn Any + Send + Sync>> {
        self.inner.task_registry.clone()
    }

    /// Opaque getter for the attached question gate. Caller downcasts
    /// to `QuestionGateSlot` (defined in `snaca-agent-api`). `None`
    /// when no gate was attached — `AskUserQuestion` surfaces a clear
    /// "no gate attached" error in that case.
    pub fn question_gate_opaque(&self) -> Option<Arc<dyn Any + Send + Sync>> {
        self.inner.question_gate.clone()
    }

    /// Opaque getter for the attached memory provider. Caller downcasts
    /// to `MemoryProviderSlot` (defined in `snaca-agent-api`). `None`
    /// keeps the historical file-tree memory behavior.
    pub fn memory_provider_opaque(&self) -> Option<Arc<dyn Any + Send + Sync>> {
        self.inner.memory_provider.clone()
    }

    /// Opaque getter for the attached built-in memory store. Caller
    /// downcasts to `snaca_memory::MemoryStore`. `None` is fine for
    /// unit tests and direct embeddings; tools fall back to deriving a
    /// fresh store from `workspace_root`.
    pub fn memory_store_opaque(&self) -> Option<Arc<dyn Any + Send + Sync>> {
        self.inner.memory_store.clone()
    }

    pub fn tenant_id(&self) -> &TenantId {
        &self.inner.tenant_id
    }

    pub fn project_id(&self) -> &ProjectId {
        &self.inner.project_id
    }

    pub fn session_id(&self) -> SessionId {
        self.inner.session_id
    }

    /// Absolute filesystem root for this project's workspace. All filesystem
    /// tools must resolve paths relative to this and reject anything that
    /// escapes (see `snaca_workspace::resolve_within`).
    pub fn workspace_root(&self) -> &std::path::Path {
        &self.inner.workspace_root
    }

    /// Push an outbound file. No-op if no IM channel is attached
    /// (e.g. a direct-embed deployment) — tools should still treat
    /// queue calls as fire-and-forget. Returns true when the entry
    /// landed.
    pub fn queue_outbound_file(&self, file: OutboundFile) -> bool {
        let Some(slot) = self.inner.outbound_files.as_ref() else {
            return false;
        };
        if let Ok(mut guard) = slot.lock() {
            guard.push(file);
            true
        } else {
            false
        }
    }

    /// True when a Read tracker is attached. Edit / MultiEdit gate
    /// their "Read before Edit" check on this — production turns inject
    /// a tracker so the check is enforced; bare unit tests don't and
    /// the check is silently skipped.
    pub fn read_tracker_active(&self) -> bool {
        self.inner.read_tracker.is_some()
    }

    /// Record that `path` was just Read in full at the given mtime/size.
    /// Path should be the absolute, workspace-resolved path (what the
    /// filesystem tools see — not the user-supplied relative path).
    /// No-op when no tracker is attached. Shorthand for
    /// `record_partial_read(..., partial=false)`.
    pub fn record_read(&self, path: &Path, mtime: SystemTime, size: u64) {
        self.record_partial_read(path, mtime, size, false);
    }

    /// Same as `record_read` but lets the caller flag the entry as a
    /// partial view (offset > 0 or limit-truncated tail). Edit /
    /// MultiEdit refuse partial entries — see `ReadRecord::partial`.
    /// Re-inserting overwrites: a later full Read on the same path
    /// upgrades the entry to non-partial.
    pub fn record_partial_read(&self, path: &Path, mtime: SystemTime, size: u64, partial: bool) {
        let Some(tracker) = self.inner.read_tracker.as_ref() else {
            return;
        };
        if let Ok(mut map) = tracker.lock() {
            map.insert(
                path.to_path_buf(),
                ReadRecord {
                    mtime,
                    size,
                    partial,
                },
            );
        }
    }

    /// Look up the last recorded Read for `path`. `None` when either
    /// no tracker is attached or the path has never been Read this
    /// turn. Edit distinguishes the two via `read_tracker_active`.
    pub fn last_read(&self, path: &Path) -> Option<ReadRecord> {
        self.inner
            .read_tracker
            .as_ref()?
            .lock()
            .ok()?
            .get(path)
            .copied()
    }

    /// Borrow the per-turn cancellation token. `None` in tests / paths
    /// that didn't attach one. Long CPU-bound tools that want to
    /// abort cleanly mid-loop should clone this and `cancelled()` on
    /// it; everything else is covered by the engine's outer `select!`
    /// dropping the tool future.
    pub fn cancellation_token(&self) -> Option<&CancellationToken> {
        self.inner.cancellation_token.as_ref()
    }

    /// True if the current turn has been cancelled. Convenience —
    /// equivalent to `cancellation_token().map(|t| t.is_cancelled())
    /// == Some(true)`.
    pub fn is_cancelled(&self) -> bool {
        self.inner
            .cancellation_token
            .as_ref()
            .map(|t| t.is_cancelled())
            .unwrap_or(false)
    }

    /// Attach a reverse-RPC context requester (scipen-studio fork). The
    /// concrete impl lives in `snaca-editor` and bridges to the editor
    /// host over JSON-RPC; the Zotero tools consult it via
    /// `context_requester()`. `None` (the default) makes those tools
    /// return a clean "no editor host" tool_error.
    pub fn with_context_requester(mut self, requester: Arc<dyn ContextRequester>) -> Self {
        let mut inner = (*self.inner).clone();
        inner.context_requester = Some(requester);
        self.inner = Arc::new(inner);
        self
    }

    /// Borrow the attached context requester. `None` in tests /
    /// non-editor deployments; the Zotero tools surface a clear
    /// "requires an editor host" error in that case.
    pub fn context_requester(&self) -> Option<&Arc<dyn ContextRequester>> {
        self.inner.context_requester.as_ref()
    }
}
