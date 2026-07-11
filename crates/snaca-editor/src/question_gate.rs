//! Concrete `QuestionGate` impl that bridges the `AskUserQuestion` tool
//! to the host via the JSON-RPC `context.request` reverse-RPC (kind
//! `ask_user_question`).
//!
//! Mirrors [`crate::context_requester::EditorContextRequester`] but for
//! the engine's `QuestionGate` trait: it sends the question card to the
//! host and parks (on the long [`crate::outbound::QUESTION_TIMEOUT`])
//! until the user picks. Engine wiring attaches one per turn, scoped to
//! the current `turn_id`.

use crate::outbound::{ContextCallError, OutboundWriter};
use async_trait::async_trait;
use snaca_editor_protocol::messages::context_req::{
    ContextPayload, ContextRequestPayload, QuestionAskParams, QuestionOptionWire, QuestionSpecWire,
};
use snaca_engine::{QuestionAnswer, QuestionAnswers, QuestionError, QuestionGate, QuestionRequest};
use std::sync::Arc;

pub struct EditorQuestionGate {
    outbound: Arc<OutboundWriter>,
    turn_id: String,
}

impl std::fmt::Debug for EditorQuestionGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EditorQuestionGate")
            .field("turn_id", &self.turn_id)
            .finish_non_exhaustive()
    }
}

impl EditorQuestionGate {
    pub fn new(outbound: Arc<OutboundWriter>, turn_id: impl Into<String>) -> Self {
        Self {
            outbound,
            turn_id: turn_id.into(),
        }
    }
}

#[async_trait]
impl QuestionGate for EditorQuestionGate {
    async fn ask(&self, request: QuestionRequest) -> Result<QuestionAnswers, QuestionError> {
        // engine QuestionSpec -> protocol wire.
        let params = QuestionAskParams {
            questions: request
                .questions
                .iter()
                .map(|q| QuestionSpecWire {
                    id: q.id.clone(),
                    question: q.question.clone(),
                    header: q.header.clone(),
                    options: q
                        .options
                        .iter()
                        .map(|o| QuestionOptionWire {
                            id: o.id.clone(),
                            label: o.label.clone(),
                            description: o.description.clone(),
                            preview: o.preview.clone(),
                        })
                        .collect(),
                    multi_select: q.multi_select,
                    allow_other: q.allow_other,
                })
                .collect(),
        };

        let payload = ContextRequestPayload::AskUserQuestion { params };
        let resp = self
            .outbound
            .call_question(self.turn_id.clone(), payload)
            .await
            .map_err(map_error)?;

        match resp {
            // protocol wire -> engine QuestionAnswers.
            ContextPayload::AskUserQuestion { answers } => Ok(QuestionAnswers {
                answers: answers
                    .answers
                    .into_iter()
                    .map(|a| QuestionAnswer {
                        question_id: a.question_id,
                        selected_option_ids: a.selected_option_ids,
                        other_text: a.other_text,
                        notes: a.notes,
                    })
                    .collect(),
                user_id: answers.user_id,
                decided_at: answers.decided_at,
            }),
            _ => Err(QuestionError::Other(
                "host returned a non-question payload for AskUserQuestion".into(),
            )),
        }
    }
}

fn map_error(err: ContextCallError) -> QuestionError {
    match err {
        ContextCallError::Timeout(_) => QuestionError::Timeout,
        ContextCallError::HostError(msg) => QuestionError::Other(msg),
        ContextCallError::Io(io_err) => QuestionError::Other(io_err.to_string()),
        // Correlator dropped before a reply — treat as cancellation
        // (turn aborted / host disconnected) rather than a hard error.
        ContextCallError::Closed => QuestionError::Cancelled,
    }
}
