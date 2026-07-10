//! Question gating — lets tools ask a structured question and await an answer.
//!
//! Production applications can implement [`QuestionGate`] with IM cards,
//! terminal prompts, web UI modals, or any other interaction surface. Tools and
//! runtimes share this crate so the built-in tool pack does not need to depend
//! on a concrete engine implementation.

use async_trait::async_trait;
use snaca_core::{ProjectId, TenantId};
use std::sync::Arc;
use thiserror::Error;

/// One option in a [`QuestionSpec`]. `id` is the stable identifier the caller
/// uses to recognise the user's selection. `label` is what the user sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    /// Optional preview content (markdown / code snippet) the renderer may
    /// show next to the option. Surfaces without preview support ignore this.
    pub preview: Option<String>,
}

/// One question in a [`QuestionRequest`]. 2-4 options; single- or
/// multi-select; optional Other affordance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionSpec {
    pub id: String,
    pub question: String,
    pub header: Option<String>,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
    pub allow_other: bool,
}

/// What the runtime hands to the gate.
#[derive(Debug, Clone)]
pub struct QuestionRequest {
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    /// 1-4 questions to ask together.
    pub questions: Vec<QuestionSpec>,
}

/// One question's answer in [`QuestionAnswers`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct QuestionAnswer {
    pub question_id: String,
    pub selected_option_ids: Vec<String>,
    pub other_text: Option<String>,
    pub notes: Option<String>,
}

/// Bundle returned by the gate. One entry per question asked, in the same
/// order. `user_id` records which user answered.
#[derive(Debug, Clone, Default)]
pub struct QuestionAnswers {
    pub answers: Vec<QuestionAnswer>,
    pub user_id: String,
    pub decided_at: String,
}

#[derive(Debug, Error)]
pub enum QuestionError {
    #[error("question timed out without a user answer")]
    Timeout,

    #[error("question channel closed before an answer arrived")]
    Cancelled,

    /// The attached channel or deployment policy does not support interactive
    /// multiple-choice questions.
    #[error("question gate unsupported for this channel")]
    Unsupported,

    #[error("question gate failed: {0}")]
    Other(String),
}

#[async_trait]
pub trait QuestionGate: Send + Sync {
    async fn ask(&self, request: QuestionRequest) -> Result<QuestionAnswers, QuestionError>;
}

/// Concrete wrapper used to stash an `Arc<dyn QuestionGate>` in an opaque
/// `Arc<dyn Any>` slot. Trait-object to trait-object coercion is not allowed
/// on stable Rust, so callers store this sized wrapper and downcast it back.
pub struct QuestionGateSlot(pub Arc<dyn QuestionGate>);

impl QuestionGateSlot {
    pub fn new(gate: Arc<dyn QuestionGate>) -> Self {
        Self(gate)
    }

    pub fn gate(&self) -> Arc<dyn QuestionGate> {
        self.0.clone()
    }
}

/// Default gate when no interactive channel is attached.
pub struct NoopQuestionGate;

#[async_trait]
impl QuestionGate for NoopQuestionGate {
    async fn ask(&self, _request: QuestionRequest) -> Result<QuestionAnswers, QuestionError> {
        Err(QuestionError::Unsupported)
    }
}

/// Test fixture: returns a fixed canned answer regardless of input.
#[derive(Debug, Clone)]
pub struct FixedQuestionGate {
    pub answers: QuestionAnswers,
}

impl FixedQuestionGate {
    pub fn new(answers: QuestionAnswers) -> Self {
        Self { answers }
    }
}

#[async_trait]
impl QuestionGate for FixedQuestionGate {
    async fn ask(&self, _request: QuestionRequest) -> Result<QuestionAnswers, QuestionError> {
        Ok(self.answers.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> QuestionRequest {
        QuestionRequest {
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("p"),
            questions: vec![QuestionSpec {
                id: "q_0".into(),
                question: "Pick".into(),
                header: None,
                options: vec![
                    QuestionOption {
                        id: "a".into(),
                        label: "A".into(),
                        description: None,
                        preview: None,
                    },
                    QuestionOption {
                        id: "b".into(),
                        label: "B".into(),
                        description: None,
                        preview: None,
                    },
                ],
                multi_select: false,
                allow_other: true,
            }],
        }
    }

    #[tokio::test]
    async fn noop_gate_returns_unsupported() {
        let err = NoopQuestionGate.ask(req()).await.unwrap_err();
        assert!(matches!(err, QuestionError::Unsupported));
    }

    #[tokio::test]
    async fn fixed_gate_returns_canned_answer() {
        let canned = QuestionAnswers {
            answers: vec![QuestionAnswer {
                question_id: "q_0".into(),
                selected_option_ids: vec!["a".into()],
                other_text: None,
                notes: None,
            }],
            user_id: "u1".into(),
            decided_at: "2026-05-24T00:00:00Z".into(),
        };
        let gate = FixedQuestionGate::new(canned.clone());
        let got = gate.ask(req()).await.unwrap();
        assert_eq!(got.answers, canned.answers);
        assert_eq!(got.user_id, "u1");
    }
}
