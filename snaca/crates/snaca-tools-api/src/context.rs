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

#[derive(Debug)]
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
    /// engine keeps one tracker per thread so it survives across turns.
    read_tracker: Option<ReadTracker>,
    /// Opaque side-channel for tools that need a long-lived shared
    /// resource the engine attaches. Currently used by Bash's
    /// `run_in_background` mode for its TaskRegistry (defined in
    /// `snaca-tools`). Stored as `Arc<dyn Any>` so this crate stays
    /// dependency-light: the concrete type lives in `snaca-tools`,
    /// callers downcast on read.
    task_registry: Option<Arc<dyn Any + Send + Sync>>,
    /// Cooperative cancellation signal for the current turn. The
    /// engine creates one token per `handle_turn_full` invocation and
    /// fires it on abort / timeout. Tools don't have to inspect this
    /// — the engine's `tokio::select!` wrapper drops their futures on
    /// cancel and that already kills child processes (Bash
    /// `kill_on_drop`), aborts in-flight HTTP requests, etc. Long
    /// CPU-bound tools that want to exit cleanly mid-loop can call
    /// `is_cancelled()` between iterations.
    cancellation_token: Option<CancellationToken>,
    /// Reverse-RPC bridge to the host. The editor binary attaches one
    /// per turn so context tools (zotero_*) can fetch host-resident
    /// data. `None` in headless / direct-embed deployments where no
    /// editor host is connected — affected tools surface a clear
    /// "unavailable" error instead of crashing.
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
                cancellation_token: None,
                context_requester: None,
            }),
        }
    }

    /// Attach an outbound file collector. Tools call
    /// `queue_outbound_file(...)` to enqueue; engine drains via
    /// `take_outbound_files()` once the turn ends.
    pub fn with_outbound_files(
        mut self,
        files: Arc<Mutex<Vec<OutboundFile>>>,
    ) -> Self {
        let inner = Inner {
            tenant_id: self.inner.tenant_id.clone(),
            project_id: self.inner.project_id.clone(),
            session_id: self.inner.session_id,
            workspace_root: self.inner.workspace_root.clone(),
            outbound_files: Some(files),
            read_tracker: self.inner.read_tracker.clone(),
            task_registry: self.inner.task_registry.clone(),
            cancellation_token: self.inner.cancellation_token.clone(),
            context_requester: self.inner.context_requester.clone(),
        };
        self.inner = Arc::new(inner);
        self
    }

    /// Attach a Read tracker. Production turns inject one per turn so
    /// Edit / MultiEdit can enforce "Read before Edit" and refuse
    /// stale-view edits. Unit tests that don't care about that
    /// invariant can skip this and Edit will fall through to the old
    /// permissive behaviour.
    pub fn with_read_tracker(mut self, tracker: ReadTracker) -> Self {
        let inner = Inner {
            tenant_id: self.inner.tenant_id.clone(),
            project_id: self.inner.project_id.clone(),
            session_id: self.inner.session_id,
            workspace_root: self.inner.workspace_root.clone(),
            outbound_files: self.inner.outbound_files.clone(),
            read_tracker: Some(tracker),
            task_registry: self.inner.task_registry.clone(),
            cancellation_token: self.inner.cancellation_token.clone(),
            context_requester: self.inner.context_requester.clone(),
        };
        self.inner = Arc::new(inner);
        self
    }

    /// Attach a task registry (opaque). Concrete type lives in
    /// `snaca-tools`; this crate only holds the `Arc<dyn Any>` so the
    /// trait surface stays small. Bash's `run_in_background` mode and
    /// the companion TaskOutput / TaskStop tools downcast from this
    /// slot.
    pub fn with_task_registry(mut self, registry: Arc<dyn Any + Send + Sync>) -> Self {
        let inner = Inner {
            tenant_id: self.inner.tenant_id.clone(),
            project_id: self.inner.project_id.clone(),
            session_id: self.inner.session_id,
            workspace_root: self.inner.workspace_root.clone(),
            outbound_files: self.inner.outbound_files.clone(),
            read_tracker: self.inner.read_tracker.clone(),
            task_registry: Some(registry),
            cancellation_token: self.inner.cancellation_token.clone(),
            context_requester: self.inner.context_requester.clone(),
        };
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
        let inner = Inner {
            tenant_id: self.inner.tenant_id.clone(),
            project_id: self.inner.project_id.clone(),
            session_id: self.inner.session_id,
            workspace_root: self.inner.workspace_root.clone(),
            outbound_files: self.inner.outbound_files.clone(),
            read_tracker: self.inner.read_tracker.clone(),
            task_registry: self.inner.task_registry.clone(),
            cancellation_token: Some(token),
            context_requester: self.inner.context_requester.clone(),
        };
        self.inner = Arc::new(inner);
        self
    }

    /// Opaque getter for the attached task registry. Caller downcasts
    /// to the concrete type they expect. `None` if no registry was
    /// attached (tests, direct embedding without background tasks).
    pub fn task_registry_opaque(&self) -> Option<Arc<dyn Any + Send + Sync>> {
        self.inner.task_registry.clone()
    }

    /// Attach a reverse-RPC channel back to the host. Used by context
    /// tools (zotero_*) to fetch host-resident data; unset in headless
    /// deployments where no editor host is connected.
    pub fn with_context_requester(mut self, requester: Arc<dyn ContextRequester>) -> Self {
        let inner = Inner {
            tenant_id: self.inner.tenant_id.clone(),
            project_id: self.inner.project_id.clone(),
            session_id: self.inner.session_id,
            workspace_root: self.inner.workspace_root.clone(),
            outbound_files: self.inner.outbound_files.clone(),
            read_tracker: self.inner.read_tracker.clone(),
            task_registry: self.inner.task_registry.clone(),
            cancellation_token: self.inner.cancellation_token.clone(),
            context_requester: Some(requester),
        };
        self.inner = Arc::new(inner);
        self
    }

    /// Borrow the attached reverse-RPC channel. Tools that need it must
    /// surface a clear "unavailable" error when this is `None` rather
    /// than panic — direct-embed test paths legitimately don't supply
    /// one.
    pub fn context_requester(&self) -> Option<&Arc<dyn ContextRequester>> {
        self.inner.context_requester.as_ref()
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
    pub fn record_partial_read(
        &self,
        path: &Path,
        mtime: SystemTime,
        size: u64,
        partial: bool,
    ) {
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
}
