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

use crate::context_inject;
use crate::llm::{build_llm_client, run_chat_turn};
use crate::outbound::OutboundWriter;
use crate::session::TurnKind;
use crate::session_manager::SessionManager;
use async_trait::async_trait;
use snaca_core::Message;
use snaca_editor_protocol::error::ProtocolError;
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
        let (session_id, active_thread_id, threads) = self
            .sessions
            .open(
                params.project_id,
                PathBuf::from(&params.workspace_root),
                PathBuf::from(&params.metadata_root),
                params.shared_metadata_root.as_ref().map(PathBuf::from),
                params.display_name,
                params.project_type,
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
        let llm = self.get_llm().await?;

        // 1. Append the new user message to thread history *before* the
        //    turn starts so begin_turn's session validation already sees a
        //    consistent state (and a cancelled turn still records intent).
        let user_msg = Message::user_text(params.content.clone());
        self.sessions
            .append_message(&params.session_id, &params.thread_id, user_msg)
            .await?;

        // 2. Build the system prompt: base instruction + structured context.
        let system_prompt = build_system_prompt(&params.context);

        // 3. Snapshot recent history (last N) to send to the LLM.
        let messages = self
            .sessions
            .recent_messages(&params.session_id, &params.thread_id, MAX_HISTORY_MESSAGES)
            .await;

        // 4. Allocate the turn and spawn the streaming task.
        let turn_id = self
            .sessions
            .begin_turn(&params.session_id, &params.thread_id, TurnKind::Chat)
            .await?;

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

        Ok(ChatSendResult { turn_id })
    }

    // ---------------- Control ----------------

    async fn handle_turn_cancel(&self, params: TurnCancelParams) {
        let hit = self.sessions.cancel_turn(&params.turn_id).await;
        debug!(turn_id = %params.turn_id, hit, reason = ?params.reason, "turn.cancel");
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

