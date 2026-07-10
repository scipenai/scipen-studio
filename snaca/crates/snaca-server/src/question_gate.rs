//! `ChannelQuestionGate` — adapter that lets the engine ask the IM
//! plugin to put a structured multiple-choice question to the user.
//!
//! Structurally identical to [`crate::gate::ChannelApprovalGate`]:
//! 1. allocate a fresh `callback_token`,
//! 2. send `question.present` to the plugin (rendered as an
//!    interactive card),
//! 3. wait for the matching `event.question_callback`,
//! 4. translate the wire `QuestionCallbackParams` into the engine's
//!    [`QuestionAnswers`].
//!
//! Operator knobs:
//! - `SNACA_QUESTION_MODE` — same axis as `SNACA_APPROVAL_MODE`. Values:
//!   - `interactive` (default): real card flow.
//!   - `unsupported`: gate returns `Unsupported` for every call,
//!     `AskUserQuestion` surfaces a clean tool_error. Useful when you
//!     want to A/B disable the tool without unregistering it.
//! - `SNACA_QUESTION_FALLBACK` — only consulted when the underlying
//!   plugin lacks `interactive_card` capability. Options:
//!   - `text` (default): render the question(s) as a plain markdown
//!     message and wait for the user's next IM message; the
//!     dispatcher intercepts it via [`crate::text_question`] and the
//!     parser turns numbers / labels / free text into a structured
//!     answer.
//!   - `error` / `unsupported`: return `Unsupported`. Use for deployments
//!     where falling back to plain text would be inappropriate (e.g.
//!     read-only audit channels).

use async_trait::async_trait;
use snaca_channel_host::{ChannelError, PluginHandle};
use snaca_channel_protocol::methods::{
    MessageSendParams, Question as WireQuestion, QuestionOption as WireQuestionOption,
};
use snaca_engine::{QuestionAnswer, QuestionAnswers, QuestionError, QuestionGate, QuestionRequest};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;
use tracing::warn;

use crate::text_question;

const DEFAULT_QUESTION_TIMEOUT: Duration = Duration::from_secs(300);

/// Pick the question gate the dispatcher hands to the engine, based on
/// `SNACA_QUESTION_MODE`.
pub fn build_question_gate(
    plugin: PluginHandle,
    plugin_tenant_id: String,
    chat_id: String,
) -> Arc<dyn QuestionGate> {
    match resolve_question_mode() {
        ResolvedQuestionMode::Interactive => {
            Arc::new(ChannelQuestionGate::new(plugin, plugin_tenant_id, chat_id))
        }
        ResolvedQuestionMode::Unsupported => Arc::new(UnsupportedQuestionGate),
        ResolvedQuestionMode::Unknown(other) => {
            warn!(
                value = %other,
                "unknown SNACA_QUESTION_MODE value; falling back to interactive"
            );
            Arc::new(ChannelQuestionGate::new(plugin, plugin_tenant_id, chat_id))
        }
    }
}

enum ResolvedQuestionMode {
    Interactive,
    Unsupported,
    Unknown(String),
}

fn resolve_question_mode() -> ResolvedQuestionMode {
    let raw = std::env::var("SNACA_QUESTION_MODE").unwrap_or_default();
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | "interactive" => ResolvedQuestionMode::Interactive,
        "unsupported" | "error" => ResolvedQuestionMode::Unsupported,
        other => ResolvedQuestionMode::Unknown(other.to_string()),
    }
}

/// Startup-time log so operators see the resolved mode without grepping
/// for the first gated call. Mirrors `gate::log_approval_mode_at_startup`.
pub fn log_question_mode_at_startup() {
    let raw = std::env::var("SNACA_QUESTION_MODE").ok();
    let raw_display = raw.as_deref().unwrap_or("<unset>");
    let resolved: &str = match resolve_question_mode() {
        ResolvedQuestionMode::Interactive => "interactive (default — card sent to chat)",
        ResolvedQuestionMode::Unsupported => "unsupported (AskUserQuestion returns tool_error)",
        ResolvedQuestionMode::Unknown(_) => {
            "unknown value — will fall back to interactive at first call"
        }
    };
    tracing::info!(
        SNACA_QUESTION_MODE = raw_display,
        resolved = resolved,
        "question gate"
    );
}

/// Always returns `Unsupported`. The `AskUserQuestion` tool surfaces a
/// clean tool_error in that case. Used when the operator explicitly
/// opts the bot out of multiple-choice prompts.
pub struct UnsupportedQuestionGate;

#[async_trait]
impl QuestionGate for UnsupportedQuestionGate {
    async fn ask(&self, _request: QuestionRequest) -> Result<QuestionAnswers, QuestionError> {
        Err(QuestionError::Unsupported)
    }
}

pub struct ChannelQuestionGate {
    plugin: PluginHandle,
    plugin_tenant_id: String,
    chat_id: String,
    timeout: Duration,
}

impl ChannelQuestionGate {
    pub fn new(plugin: PluginHandle, plugin_tenant_id: String, chat_id: String) -> Self {
        Self {
            plugin,
            plugin_tenant_id,
            chat_id,
            timeout: DEFAULT_QUESTION_TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Send the question(s) as a plain markdown message and register
    /// an entry in the [`text_question`] singleton. The dispatcher's
    /// per-chat actor pops the entry on the user's next inbound
    /// message and resolves the oneshot through
    /// [`text_question::parse_text_answer`].
    ///
    /// Uses `(plugin_name, chat_id)` as the registry key — same scope
    /// as the per-chat actor, so multi-tenant routing stays correct.
    async fn ask_via_text_fallback(
        &self,
        request: QuestionRequest,
    ) -> Result<QuestionAnswers, QuestionError> {
        // Register the waiter FIRST so the dispatcher's intercept can
        // observe it the moment the user's reply lands. If we sent
        // first the reply notification could race the register call
        // and slip through to the per-chat mailbox, where the
        // already-in-flight turn would deadlock waiting for itself.
        let key: text_question::TextKey = (self.plugin.name().to_string(), self.chat_id.clone());
        let (tx, rx) = oneshot::channel();
        text_question::registry().register(key.clone(), request.questions.clone(), tx);

        let body = text_question::render_text_prompt(&request.questions);
        let send_params = MessageSendParams {
            tenant_id: self.plugin_tenant_id.clone(),
            chat_id: self.chat_id.clone(),
            content: body,
            format: Some("markdown".into()),
            reply_to: None,
            // Idempotency: derive from a fresh uuid so retries from the
            // gate path don't accidentally dedupe with a real outbox row.
            idempotency_key: Some(format!("question-text-{}", uuid::Uuid::new_v4())),
        };
        // Send via plugin RPC. We bypass the outbox here because the
        // outbox is owned by another task and persisting this row would
        // be misleading — it's a synchronous side-effect of the gate
        // call. If the send fails the user never sees a question; we
        // release the waiter and surface the error.
        if let Err(e) = self
            .plugin
            .call_method::<_, serde_json::Value>(
                snaca_channel_protocol::methods::host_to_plugin::MESSAGE_SEND,
                send_params,
            )
            .await
        {
            text_question::registry().release(&key);
            return Err(map_channel_error(e));
        }

        let result = tokio::time::timeout(self.timeout, rx).await;
        match result {
            Ok(Ok(answers)) => Ok(answers),
            Ok(Err(_)) => {
                // Sender dropped — registry was replaced by a newer ask,
                // or the dispatcher tore down. Either way the slot is
                // gone; report as Cancelled so the tool surfaces it
                // cleanly.
                text_question::registry().release(&key);
                Err(QuestionError::Cancelled)
            }
            Err(_) => {
                text_question::registry().release(&key);
                Err(QuestionError::Timeout)
            }
        }
    }
}

#[async_trait]
impl QuestionGate for ChannelQuestionGate {
    async fn ask(&self, request: QuestionRequest) -> Result<QuestionAnswers, QuestionError> {
        // Plugins without interactive_card support: route to the
        // text-fallback registry. The dispatcher's per-chat actor
        // checks for a pending text question before starting a new
        // turn, so the next user message lands here as the answer.
        if !self.plugin.manifest().capabilities.interactive_card {
            let fallback = std::env::var("SNACA_QUESTION_FALLBACK")
                .unwrap_or_else(|_| "text".to_string())
                .to_ascii_lowercase();
            return match fallback.as_str() {
                "text" => self.ask_via_text_fallback(request).await,
                _ => Err(QuestionError::Unsupported),
            };
        }

        let wire_questions: Vec<WireQuestion> = request
            .questions
            .iter()
            .map(|q| WireQuestion {
                id: q.id.clone(),
                question: q.question.clone(),
                header: q.header.clone(),
                options: q
                    .options
                    .iter()
                    .map(|o| WireQuestionOption {
                        id: o.id.clone(),
                        label: o.label.clone(),
                        description: o.description.clone(),
                        preview: o.preview.clone(),
                    })
                    .collect(),
                multi_select: q.multi_select,
                allow_other: q.allow_other,
            })
            .collect();

        let cb = self
            .plugin
            .request_question(
                self.plugin_tenant_id.clone(),
                self.chat_id.clone(),
                wire_questions,
                self.timeout,
            )
            .await
            .map_err(map_channel_error)?;

        Ok(QuestionAnswers {
            answers: cb
                .answers
                .into_iter()
                .map(|a| QuestionAnswer {
                    question_id: a.question_id,
                    selected_option_ids: a.selected_option_ids,
                    other_text: a.other_text,
                    notes: a.notes,
                })
                .collect(),
            user_id: cb.user_id,
            decided_at: cb.decided_at,
        })
    }
}

fn map_channel_error(e: ChannelError) -> QuestionError {
    match e {
        ChannelError::Timeout => QuestionError::Timeout,
        ChannelError::Disconnected | ChannelError::SendClosed => QuestionError::Cancelled,
        other => QuestionError::Other(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_timeout_maps_to_question_timeout() {
        assert!(matches!(
            map_channel_error(ChannelError::Timeout),
            QuestionError::Timeout
        ));
    }

    #[test]
    fn disconnected_maps_to_cancelled() {
        assert!(matches!(
            map_channel_error(ChannelError::Disconnected),
            QuestionError::Cancelled
        ));
    }

    #[tokio::test]
    async fn unsupported_gate_returns_unsupported() {
        let gate = UnsupportedQuestionGate;
        let err = gate
            .ask(QuestionRequest {
                tenant_id: snaca_core::TenantId::new("t"),
                project_id: snaca_core::ProjectId::from_raw("p"),
                questions: vec![],
            })
            .await
            .unwrap_err();
        assert!(matches!(err, QuestionError::Unsupported));
    }
}
