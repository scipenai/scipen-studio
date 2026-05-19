//! `EditorHandler` implements [`MessageHandler`] for SNACA editor mode.
//!
//! P1 scope:
//! - `init` builds the real LLM client from `snaca_config.llm` (API key
//!   read from env var named in `api_key_env` — never on the wire).
//! - `chat.send` streams real provider output: text → `turn.delta(text)`,
//!   reasoning → `turn.delta(thinking)`, usage → `usage.update`, then
//!   `done`. No turn loop / tools yet — those land with engine integration.
//! - `inline_edit.start` / `composer.start` / `edit.confirm` / `tool.confirm`
//!   still return `method_not_found` (next phases).

use crate::composer::{run_composer_plan_first, ComposerPlanArgs, PendingPlans};
use crate::context_inject;
use crate::approval_gate::{decision_from_edit, decision_from_wire};
use crate::llm::{build_llm_client, run_chat_turn};
use crate::turn_engine::{gate_for_mode, run_engine_turn};
use crate::outbound::OutboundWriter;
use crate::session::TurnKind;
use crate::session_manager::SessionManager;
use async_trait::async_trait;
use snaca_core::Message;
use snaca_editor_protocol::error::ProtocolError;
use snaca_editor_protocol::messages::composer::{
    ComposerMode, ComposerStartParams, ComposerStartResult, PlanConfirmParams, PlanConfirmResult,
};
use snaca_editor_protocol::messages::edit::{EditConfirmParams, EditConfirmResult};
use snaca_editor_protocol::messages::memory::{
    MemoryDeleteParams, MemoryDeleteResult, MemoryGetParams, MemoryGetResult, MemoryListParams,
    MemoryListResult, MemoryRevealParams, MemoryRevealResult, MemoryWriteParams,
    MemoryWriteResult,
};
use snaca_editor_protocol::messages::skills::{
    SkillsGetParams, SkillsGetResult, SkillsListParams, SkillsListResult, SkillsReloadParams,
    SkillsReloadResult,
};
use snaca_editor_protocol::messages::tool::{
    ToolConfirmParams, ToolConfirmResult,
};
use snaca_editor_protocol::messages::{chat::*, init::*, session::*, turn::*};
use snaca_editor_protocol::routing::MessageHandler;
use snaca_editor_protocol::types::context::ChatContext;
use snaca_editor_protocol::types::{HostCapabilities, SnacaCapabilities, SnacaConfig};
use snaca_llm::LlmClient;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tracing::{debug, info, warn};

/// Hard cap on history sent per turn before SQLite + compaction land. Set
/// generous enough for normal back-and-forth chat but bounded enough that
/// a runaway thread won't OOM the request.
const MAX_HISTORY_MESSAGES: usize = 40;

/// Base instruction prepended to every turn's system prompt. Kept short
/// so it doesn't dominate the context window.
const BASE_SYSTEM_PROMPT: &str =
    "You are SciPen Studio's writing assistant. The user is working on a \
     LaTeX or Typst document. Answer concisely and prefer minimal-diff \
     suggestions when proposing edits.";

pub struct EditorHandler {
    outbound: Arc<OutboundWriter>,
    sessions: Arc<SessionManager>,
    started_at: Instant,
    /// Set after `init` succeeds. Stored as `Option` so other methods can
    /// short-circuit with `NotInitialized` until then.
    inner: tokio::sync::RwLock<InnerState>,
    /// `tool_call_id → sender` parked by `EditorApprovalGate`; resolved
    /// by `handle_tool_confirm`.
    pending_approvals: Arc<std::sync::Mutex<
        std::collections::HashMap<String, tokio::sync::oneshot::Sender<snaca_engine::ApprovalDecision>>,
    >>,
    /// `proposal_id → sender` for Edit/Write routed through Diff Review.
    pending_edit_approvals: Arc<std::sync::Mutex<
        std::collections::HashMap<String, tokio::sync::oneshot::Sender<snaca_engine::ApprovalDecision>>,
    >>,
    /// `turn_id → token`. Fired by `turn.cancel`; all cancellable awaits
    /// in the turn select on it so the task unwinds through the normal
    /// Done(Cancelled) path.
    pending_turns: Arc<std::sync::Mutex<
        std::collections::HashMap<String, tokio_util::sync::CancellationToken>,
    >>,
    /// Composer plan-phase parking: turn_id → decision sender. Resolved by
    /// `handle_plan_confirm`.
    pending_plans: PendingPlans,
}

#[derive(Default)]
struct InnerState {
    initialized: bool,
    host_caps: Option<HostCapabilities>,
    snaca_config: Option<SnacaConfig>,
    llm_client: Option<Arc<dyn LlmClient>>,
}

impl EditorHandler {
    pub fn new(outbound: Arc<OutboundWriter>, sessions: Arc<SessionManager>) -> Self {
        Self {
            outbound,
            sessions,
            started_at: Instant::now(),
            inner: tokio::sync::RwLock::new(InnerState::default()),
            pending_approvals: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            pending_edit_approvals: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            pending_turns: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            pending_plans: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    async fn require_initialized(&self) -> Result<(), ProtocolError> {
        if self.inner.read().await.initialized {
            Ok(())
        } else {
            Err(ProtocolError::not_initialized())
        }
    }

    async fn get_llm(&self) -> Result<Arc<dyn LlmClient>, ProtocolError> {
        let guard = self.inner.read().await;
        guard.llm_client.clone().ok_or_else(|| {
            ProtocolError::not_initialized()
        })
    }

    fn engine_uptime_secs(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }
}

#[async_trait]
impl MessageHandler for EditorHandler {
    // ---------------- Lifecycle ----------------

    async fn handle_init(&self, params: InitParams) -> Result<InitResult, ProtocolError> {
        if params.protocol_version != snaca_editor_protocol::PROTOCOL_VERSION {
            warn!(
                client = %params.protocol_version,
                server = snaca_editor_protocol::PROTOCOL_VERSION,
                "protocol version mismatch (continuing - capabilities will degrade)"
            );
        }

        // Build the LLM client up-front. Failures (missing env, bad model)
        // surface immediately as ConfigInvalid rather than as the first
        // chat.send hanging.
        let llm = build_llm_client(&params.snaca_config)?;

        let mut caps = SnacaCapabilities::minimal_editor(env!("CARGO_PKG_VERSION"));
        // Reflect actual provider thinking capability into the manifest so the
        // host can decide whether to surface a thinking UI affordance.
        caps.streaming_thinking = llm.capabilities().thinking;

        {
            let mut inner = self.inner.write().await;
            inner.initialized = true;
            inner.host_caps = Some(params.host_caps.clone());
            inner.snaca_config = Some(params.snaca_config.clone());
            inner.llm_client = Some(llm);
        }

        info!(
            host = %params.host.name,
            host_version = %params.host.version,
            model = %params.snaca_config.llm.model,
            "init complete"
        );

        Ok(InitResult {
            protocol_version: snaca_editor_protocol::PROTOCOL_VERSION.to_string(),
            engine_version: env!("CARGO_PKG_VERSION").to_string(),
            capabilities: caps,
        })
    }

    async fn handle_shutdown(&self, _: ShutdownParams) -> Result<ShutdownResult, ProtocolError> {
        info!("shutdown requested");
        // Cancel everything before stdin loop notices EOF.
        // (Real implementation would also flush SQLite etc.)
        // The main loop exits when stdin closes, which the host should do
        // after acking this response.
        Ok(ShutdownResult { ok: true })
    }

    async fn handle_health_ping(
        &self,
        _: HealthPingParams,
    ) -> Result<HealthPingResult, ProtocolError> {
        Ok(HealthPingResult {
            pong: true,
            engine_uptime_secs: self.engine_uptime_secs(),
        })
    }

    async fn handle_config_reload(
        &self,
        params: ConfigReloadParams,
    ) -> Result<ConfigReloadResult, ProtocolError> {
        self.require_initialized().await?;
        // Rebuild LLM client with the new config — covers API-key rotation,
        // model swap, base-URL change. In-flight turns still see the previous
        // client until they finish (by Arc snapshot semantics).
        let new_llm = build_llm_client(&params.snaca_config)?;
        {
            let mut inner = self.inner.write().await;
            inner.snaca_config = Some(params.snaca_config.clone());
            inner.llm_client = Some(new_llm);
        }
        debug!(model = %params.snaca_config.llm.model, "config.reload applied");
        Ok(ConfigReloadResult {
            applied: true,
            restart_required: false,
        })
    }

    // ---------------- Session ----------------

    async fn handle_session_open(
        &self,
        params: SessionOpenParams,
    ) -> Result<SessionOpenResult, ProtocolError> {
        self.require_initialized().await?;
        let llm = self.get_llm().await?;
        // Snapshot snaca_config for engine wiring — held across the
        // await so subsequent config.reload calls don't tear the session
        // build mid-construction.
        let snaca_config = {
            let inner = self.inner.read().await;
            inner
                .snaca_config
                .clone()
                .ok_or_else(ProtocolError::not_initialized)?
        };
        let (session_id, active_thread_id, threads) = self
            .sessions
            .open(
                params.project_id,
                PathBuf::from(&params.workspace_root),
                PathBuf::from(&params.metadata_root),
                params.shared_metadata_root.as_ref().map(PathBuf::from),
                params.display_name,
                params.project_type,
                llm,
                &snaca_config,
            )
            .await?;
        info!(session_id = %session_id, workspace = %params.workspace_root, "session opened");
        Ok(SessionOpenResult {
            session_id,
            active_thread_id,
            threads,
        })
    }

    async fn handle_session_close(
        &self,
        params: SessionCloseParams,
    ) -> Result<SessionCloseResult, ProtocolError> {
        self.require_initialized().await?;
        self.sessions.close(&params.session_id).await?;
        Ok(SessionCloseResult { closed: true })
    }

    async fn handle_session_list_threads(
        &self,
        params: SessionListThreadsParams,
    ) -> Result<SessionListThreadsResult, ProtocolError> {
        self.require_initialized().await?;
        let (threads, total) = self
            .sessions
            .list_threads(&params.session_id, params.limit, params.offset)
            .await?;
        Ok(SessionListThreadsResult { threads, total })
    }

    async fn handle_session_new_thread(
        &self,
        params: SessionNewThreadParams,
    ) -> Result<SessionNewThreadResult, ProtocolError> {
        self.require_initialized().await?;
        let (thread_id, title) = self
            .sessions
            .new_thread(&params.session_id, params.title)
            .await?;
        Ok(SessionNewThreadResult { thread_id, title })
    }

    async fn handle_session_switch_thread(
        &self,
        params: SessionSwitchThreadParams,
    ) -> Result<SessionSwitchThreadResult, ProtocolError> {
        self.require_initialized().await?;
        let thread = self
            .sessions
            .switch_thread(&params.session_id, &params.thread_id)
            .await?;
        Ok(SessionSwitchThreadResult {
            switched: true,
            thread,
        })
    }

    async fn handle_session_delete_thread(
        &self,
        params: SessionDeleteThreadParams,
    ) -> Result<SessionDeleteThreadResult, ProtocolError> {
        self.require_initialized().await?;
        let active_thread_id = self
            .sessions
            .delete_thread(&params.session_id, &params.thread_id)
            .await?;
        Ok(SessionDeleteThreadResult {
            deleted: true,
            active_thread_id,
        })
    }

    async fn handle_session_rename_thread(
        &self,
        params: SessionRenameThreadParams,
    ) -> Result<SessionRenameThreadResult, ProtocolError> {
        self.require_initialized().await?;
        self.sessions
            .rename_thread(&params.session_id, &params.thread_id, params.title)
            .await?;
        Ok(SessionRenameThreadResult { renamed: true })
    }

    async fn handle_session_get_messages(
        &self,
        params: SessionGetMessagesParams,
    ) -> Result<SessionGetMessagesResult, ProtocolError> {
        self.require_initialized().await?;
        let (messages, total) = self
            .sessions
            .get_messages(&params.session_id, &params.thread_id, params.limit)
            .await?;
        Ok(SessionGetMessagesResult { messages, total })
    }

    // ---------------- Agent surfaces ----------------

    /// Streams a chat turn from the configured LLM with prior history.
    ///
    /// Builds the system prompt from `BASE_SYSTEM_PROMPT` + the host-supplied
    /// `ChatContext` (XML-rendered), appends the new user message to the
    /// thread's history, snapshots the recent N messages, and hands them to
    /// the LLM. After the stream completes the assistant text is appended
    /// to thread history so the next turn sees it.
    async fn handle_chat_send(
        &self,
        params: ChatSendParams,
    ) -> Result<ChatSendResult, ProtocolError> {
        self.require_initialized().await?;
        info!(
            session_id = %params.session_id,
            thread_id = %params.thread_id,
            content_len = params.content.len(),
            "chat.send received"
        );

        // Allocate the turn id up front. It seeds the engine's
        // `message_id` keying so `turn.cancel` can target one running
        // turn precisely, and gives the legacy path a single source of
        // truth too.
        let turn_id = self
            .sessions
            .begin_turn(&params.session_id, &params.thread_id, TurnKind::Chat)
            .await?;

        let (engine_opt, project_id, workspace_root) =
            self.sessions.engine_for(&params.session_id).await?;

        match engine_opt {
            Some(engine) => {
                // ---- P5 path: snaca-engine drives the turn ----
                // Engine owns user/assistant/tool message persistence,
                // tool selection, the loop, and approval gating.
                let outbound = self.outbound.clone();
                let sessions = self.sessions.clone();
                let session_id = params.session_id.clone();
                let thread_id = params.thread_id.clone();
                let turn_id_clone = turn_id.clone();
                let user_text = params.content.clone();
                let approval_mode = self
                    .inner
                    .read()
                    .await
                    .snaca_config
                    .as_ref()
                    .map(|c| c.approval_mode)
                    .unwrap_or(snaca_editor_protocol::types::config::ApprovalMode::Interactive);
                let cancel_token = tokio_util::sync::CancellationToken::new();
                self.pending_turns
                    .lock()
                    .unwrap()
                    .insert(turn_id.clone(), cancel_token.clone());
                let gate = gate_for_mode(
                    approval_mode,
                    outbound.clone(),
                    turn_id_clone.clone(),
                    self.pending_approvals.clone(),
                    self.pending_edit_approvals.clone(),
                    workspace_root.clone(),
                    cancel_token.clone(),
                );

                let pending_turns_for_task = self.pending_turns.clone();
                let handle = tokio::spawn(async move {
                    run_engine_turn(
                        engine,
                        outbound,
                        sessions,
                        session_id,
                        project_id,
                        thread_id,
                        turn_id_clone.clone(),
                        user_text,
                        gate,
                        cancel_token,
                    )
                    .await;
                    pending_turns_for_task.lock().unwrap().remove(&turn_id_clone);
                });
                let _ = self
                    .sessions
                    .set_abort(&params.session_id, &turn_id, handle.abort_handle())
                    .await;
            }
            None => {
                // ---- Legacy P1 path: bare LLM round-trip. ----
                // Used when engine wiring failed at session.open (logged
                // there). Kept as a temporary safety net; Phase F removes
                // run_chat_turn once the engine path is the only one.
                warn!(
                    session_id = %params.session_id,
                    "engine unavailable for session; falling back to run_chat_turn"
                );
                let llm = self.get_llm().await?;
                let user_msg = Message::user_text(params.content.clone());
                self.sessions
                    .append_message(&params.session_id, &params.thread_id, user_msg, None)
                    .await?;
                let system_prompt = build_system_prompt(&params.context);
                let messages = self
                    .sessions
                    .recent_messages(&params.session_id, &params.thread_id, MAX_HISTORY_MESSAGES)
                    .await;

                let outbound = self.outbound.clone();
                let sessions = self.sessions.clone();
                let session_id = params.session_id.clone();
                let thread_id = params.thread_id.clone();
                let turn_id_clone = turn_id.clone();

                let handle = tokio::spawn(async move {
                    run_chat_turn(
                        llm,
                        outbound,
                        sessions,
                        session_id,
                        thread_id,
                        turn_id_clone,
                        Some(system_prompt),
                        messages,
                    )
                    .await;
                });
                let _ = self
                    .sessions
                    .set_abort(&params.session_id, &turn_id, handle.abort_handle())
                    .await;
            }
        }

        Ok(ChatSendResult { turn_id })
    }

    async fn handle_composer_start(
        &self,
        params: ComposerStartParams,
    ) -> Result<ComposerStartResult, ProtocolError> {
        self.require_initialized().await?;
        info!(
            session_id = %params.session_id,
            thread_id = %params.thread_id,
            mode = ?params.mode,
            "composer.start received"
        );

        let plan_turn_id = self
            .sessions
            .begin_turn(&params.session_id, &params.thread_id, TurnKind::Composer)
            .await?;

        let (engine_opt, project_id, workspace_root) =
            self.sessions.engine_for(&params.session_id).await?;
        let engine = engine_opt.ok_or_else(|| {
            ProtocolError::internal("composer requires an active engine for this session")
        })?;

        let snaca_config = {
            let inner = self.inner.read().await;
            inner
                .snaca_config
                .clone()
                .ok_or_else(ProtocolError::not_initialized)?
        };
        let llm = self.get_llm().await?;
        let cancel = tokio_util::sync::CancellationToken::new();
        self.pending_turns
            .lock()
            .unwrap()
            .insert(plan_turn_id.clone(), cancel.clone());

        match params.mode {
            ComposerMode::Immediate => {
                let gate = gate_for_mode(
                    snaca_config.approval_mode,
                    self.outbound.clone(),
                    plan_turn_id.clone(),
                    self.pending_approvals.clone(),
                    self.pending_edit_approvals.clone(),
                    workspace_root.clone(),
                    cancel.clone(),
                );
                let outbound = self.outbound.clone();
                let sessions = self.sessions.clone();
                let session_id = params.session_id.clone();
                let thread_id = params.thread_id.clone();
                let turn_id_clone = plan_turn_id.clone();
                let user_text = params.instruction.clone();
                let pending_turns = self.pending_turns.clone();
                let handle = tokio::spawn(async move {
                    run_engine_turn(
                        engine,
                        outbound,
                        sessions,
                        session_id,
                        project_id,
                        thread_id,
                        turn_id_clone.clone(),
                        user_text,
                        gate,
                        cancel,
                    )
                    .await;
                    pending_turns.lock().unwrap().remove(&turn_id_clone);
                });
                let _ = self
                    .sessions
                    .set_abort(&params.session_id, &plan_turn_id, handle.abort_handle())
                    .await;
            }
            ComposerMode::PlanFirst => {
                let (db, metadata_root, _ws, _proj) =
                    self.sessions.composer_context(&params.session_id).await?;
                let args = ComposerPlanArgs {
                    main_engine: engine,
                    llm,
                    snaca_config,
                    db,
                    outbound: self.outbound.clone(),
                    sessions: self.sessions.clone(),
                    session_id: params.session_id.clone(),
                    project_id,
                    workspace_root,
                    metadata_root,
                    thread_id: params.thread_id.clone(),
                    plan_turn_id: plan_turn_id.clone(),
                    user_text: params.instruction.clone(),
                    plan_cancel: cancel,
                    pending_plans: self.pending_plans.clone(),
                    pending_turns: self.pending_turns.clone(),
                    pending_approvals: self.pending_approvals.clone(),
                    pending_edit_approvals: self.pending_edit_approvals.clone(),
                };
                let plan_turn_id_clone = plan_turn_id.clone();
                let handle = tokio::spawn(async move {
                    run_composer_plan_first(args).await;
                    let _ = plan_turn_id_clone;
                });
                let _ = self
                    .sessions
                    .set_abort(&params.session_id, &plan_turn_id, handle.abort_handle())
                    .await;
            }
        }

        Ok(ComposerStartResult {
            turn_id: plan_turn_id,
        })
    }

    async fn handle_plan_confirm(
        &self,
        params: PlanConfirmParams,
    ) -> Result<PlanConfirmResult, ProtocolError> {
        let sender = self.pending_plans.lock().unwrap().remove(&params.turn_id);
        if let Some(s) = sender {
            let _ = s.send(params.decision);
            info!(turn_id = %params.turn_id, decision = ?params.decision, "plan.confirm");
            Ok(PlanConfirmResult { ok: true })
        } else {
            debug!(turn_id = %params.turn_id, "plan.confirm: unknown turn");
            Ok(PlanConfirmResult { ok: false })
        }
    }

    // ---------------- Control ----------------

    async fn handle_turn_cancel(&self, params: TurnCancelParams) {
        let token = self.pending_turns.lock().unwrap().remove(&params.turn_id);
        if let Some(t) = token {
            t.cancel();
            debug!(turn_id = %params.turn_id, reason = ?params.reason, "turn.cancel (token fired)");
        } else {
            debug!(turn_id = %params.turn_id, "turn.cancel: no pending turn");
        }
    }

    async fn handle_edit_confirm(
        &self,
        params: EditConfirmParams,
    ) -> Result<EditConfirmResult, ProtocolError> {
        let sender = self
            .pending_edit_approvals
            .lock()
            .unwrap()
            .remove(&params.proposal_id);
        if let Some(s) = sender {
            let _ = s.send(decision_from_edit(params.decision));
            info!(proposal_id = %params.proposal_id, decision = ?params.decision, "edit.confirm");
        } else {
            debug!(proposal_id = %params.proposal_id, "edit.confirm: unknown id");
        }
        // The engine's Edit/Write tool writes after the gate releases;
        // host did not apply here.
        Ok(EditConfirmResult {
            applied: false,
            applied_hash: None,
            errors: None,
        })
    }

    async fn handle_tool_confirm(
        &self,
        params: ToolConfirmParams,
    ) -> Result<ToolConfirmResult, ProtocolError> {
        let sender = {
            let mut map = self.pending_approvals.lock().unwrap();
            map.remove(&params.tool_call_id)
        };
        if let Some(s) = sender {
            let _ = s.send(decision_from_wire(params.decision));
            info!(tool_call_id = %params.tool_call_id, decision = ?params.decision, "tool.confirm");
        } else {
            debug!(tool_call_id = %params.tool_call_id, "tool.confirm: unknown id");
        }
        Ok(ToolConfirmResult { ok: true })
    }

    // ---------------- Memory viewer ----------------

    async fn handle_memory_list(
        &self,
        params: MemoryListParams,
    ) -> Result<MemoryListResult, ProtocolError> {
        self.require_initialized().await?;
        crate::memory_handler::handle_memory_list(self.sessions.as_ref(), params).await
    }

    async fn handle_memory_get(
        &self,
        params: MemoryGetParams,
    ) -> Result<MemoryGetResult, ProtocolError> {
        self.require_initialized().await?;
        crate::memory_handler::handle_memory_get(self.sessions.as_ref(), params).await
    }

    async fn handle_memory_write(
        &self,
        params: MemoryWriteParams,
    ) -> Result<MemoryWriteResult, ProtocolError> {
        self.require_initialized().await?;
        crate::memory_handler::handle_memory_write(self.sessions.as_ref(), &self.outbound, params)
            .await
    }

    async fn handle_memory_delete(
        &self,
        params: MemoryDeleteParams,
    ) -> Result<MemoryDeleteResult, ProtocolError> {
        self.require_initialized().await?;
        crate::memory_handler::handle_memory_delete(self.sessions.as_ref(), &self.outbound, params)
            .await
    }

    async fn handle_memory_reveal(
        &self,
        params: MemoryRevealParams,
    ) -> Result<MemoryRevealResult, ProtocolError> {
        self.require_initialized().await?;
        crate::memory_handler::handle_memory_reveal(self.sessions.as_ref(), params).await
    }

    // ---------------- Skills viewer ----------------

    async fn handle_skills_list(
        &self,
        params: SkillsListParams,
    ) -> Result<SkillsListResult, ProtocolError> {
        self.require_initialized().await?;
        crate::skills_handler::handle_skills_list(self.sessions.as_ref(), params).await
    }

    async fn handle_skills_get(
        &self,
        params: SkillsGetParams,
    ) -> Result<SkillsGetResult, ProtocolError> {
        self.require_initialized().await?;
        crate::skills_handler::handle_skills_get(self.sessions.as_ref(), params).await
    }

    async fn handle_skills_reload(
        &self,
        params: SkillsReloadParams,
    ) -> Result<SkillsReloadResult, ProtocolError> {
        self.require_initialized().await?;
        crate::skills_handler::handle_skills_reload(self.sessions.as_ref(), params).await
    }
}

/// Assemble the per-turn system prompt: base instruction followed by the
/// host-supplied `ChatContext` rendered as XML. Empty contexts collapse to
/// just the base instruction.
fn build_system_prompt(context: &ChatContext) -> String {
    let xml = context_inject::render_xml(context);
    // `render_xml` always returns at least `<context>\n</context>\n`. Skip the
    // wrapper when there is nothing meaningful inside to keep the prompt tight.
    let context_is_empty = xml
        .lines()
        .all(|l| matches!(l.trim(), "" | "<context>" | "</context>"));
    if context_is_empty {
        BASE_SYSTEM_PROMPT.to_string()
    } else {
        format!("{BASE_SYSTEM_PROMPT}\n\n{xml}")
    }
}

