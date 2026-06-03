//! `AskUserQuestion` — present a structured multiple-choice question
//! to the user via the IM channel and wait for their selection.
//!
//! Modelled on Claude Code's
//! `reference/claude-code/src/tools/AskUserQuestionTool/`. The tool
//! itself is thin: validate the LLM-supplied schema, hand off to the
//! attached `QuestionGate`, and serialise the result back into a JSON
//! payload the model can interpret directly.
//!
//! Gate is pulled out of the opaque slot on `ToolContext`. When the
//! engine attaches a `NoopQuestionGate` (direct embed, no IM channel)
//! the gate returns `Unsupported`, which becomes a clean tool_error —
//! the model sees a clear "this channel can't ask questions" message
//! and falls back to a textual question of its own.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_engine::{
    QuestionError, QuestionGateSlot, QuestionOption as EngineOption, QuestionRequest,
    QuestionSpec,
};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use std::sync::Arc;

const MAX_QUESTIONS: usize = 4;
const MIN_OPTIONS: usize = 2;
const MAX_OPTIONS: usize = 4;
const MAX_HEADER_CHARS: usize = 12;

/// Mirror of Claude Code's
/// [`AskUserQuestionTool`](https://docs.claude.com/) input shape.
#[derive(Debug, Deserialize)]
struct Input {
    questions: Vec<InputQuestion>,
}

#[derive(Debug, Deserialize)]
struct InputQuestion {
    question: String,
    header: Option<String>,
    options: Vec<InputOption>,
    #[serde(default)]
    multi_select: bool,
    #[serde(default = "default_true")]
    allow_other: bool,
}

#[derive(Debug, Deserialize)]
struct InputOption {
    label: String,
    description: Option<String>,
    preview: Option<String>,
}

fn default_true() -> bool {
    true
}

pub struct AskUserQuestionTool;

#[async_trait]
impl Tool for AskUserQuestionTool {
    fn name(&self) -> &str {
        "AskUserQuestion"
    }

    fn description(&self) -> &str {
        "Ask the user one or more multiple-choice questions when you need \
         their input to proceed: clarify ambiguous instructions, choose \
         between implementation paths, gather preferences, or pick which \
         feature to build first. Each question has 2-4 distinct options; \
         the user always gets an implicit \"Other\" choice to type a free-form \
         answer (do NOT include \"Other\" as an option yourself). Use \
         `multi_select: true` when the options aren't mutually exclusive. \
         If you recommend an option, put it first and append \"(Recommended)\" \
         to its label. Returns a JSON object mapping each question to the \
         user's choice; use the answers verbatim in your next step."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_QUESTIONS,
                    "description": "1-4 questions to present together in one card.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": {
                                "type": "string",
                                "description": "The full prompt shown to the user. End with a question mark."
                            },
                            "header": {
                                "type": "string",
                                "description": "Optional short label (≤12 chars) rendered as a chip above the question."
                            },
                            "options": {
                                "type": "array",
                                "minItems": MIN_OPTIONS,
                                "maxItems": MAX_OPTIONS,
                                "description": "2-4 distinct choices. Labels must be unique within the question.",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": {
                                            "type": "string",
                                            "description": "Short display text the user sees on the button (1-5 words)."
                                        },
                                        "description": {
                                            "type": "string",
                                            "description": "One-line explanation / trade-off summary for this choice."
                                        },
                                        "preview": {
                                            "type": "string",
                                            "description": "Optional markdown content (code snippet, ASCII mockup) the renderer may show alongside this option. Skip for simple preference questions."
                                        }
                                    },
                                    "required": ["label"]
                                }
                            },
                            "multi_select": {
                                "type": "boolean",
                                "description": "Set true to let the user pick multiple options. Default false."
                            },
                            "allow_other": {
                                "type": "boolean",
                                "description": "Set false to suppress the implicit \"Other\" free-form choice. Default true."
                            }
                        },
                        "required": ["question", "options"]
                    }
                }
            },
            "required": ["questions"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        // Conceptually read-only — the tool doesn't touch filesystem,
        // doesn't run commands, and only "writes" to the IM channel
        // (which is what the user invited the bot to do anyway).
        ToolCapabilities {
            reads_filesystem: false,
            writes_filesystem: false,
            executes_commands: false,
            network_access: true,
        }
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        // Asking the user a question is the *opposite* of needing
        // approval — never gate it.
        ApprovalRequirement::Never
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let parsed: Input = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        validate_input(&parsed)?;

        let questions: Vec<QuestionSpec> = parsed
            .questions
            .iter()
            .enumerate()
            .map(|(qi, q)| QuestionSpec {
                id: format!("q_{qi}"),
                question: q.question.clone(),
                header: q.header.clone(),
                options: q
                    .options
                    .iter()
                    .enumerate()
                    .map(|(oi, o)| EngineOption {
                        id: format!("opt_{oi}"),
                        label: o.label.clone(),
                        description: o.description.clone(),
                        preview: o.preview.clone(),
                    })
                    .collect(),
                multi_select: q.multi_select,
                allow_other: q.allow_other,
            })
            .collect();

        let gate = gate_from_ctx(ctx).ok_or_else(|| {
            ToolError::Execution(
                "AskUserQuestion: no question gate is attached to this engine — \
                 this deployment does not support interactive questions. \
                 Fall back to asking the question in plain prose."
                    .into(),
            )
        })?;

        let request = QuestionRequest {
            tenant_id: ctx.tenant_id().clone(),
            project_id: ctx.project_id().clone(),
            questions: questions.clone(),
        };

        // Cooperative-cancel: race the gate against the turn's
        // cancellation token so a `MessageRecalled` or admin abort
        // doesn't leave us hanging on a card the user will never
        // click.
        let answers = if let Some(token) = ctx.cancellation_token() {
            tokio::select! {
                biased;
                _ = token.cancelled() => return Err(ToolError::Cancelled),
                res = gate.ask(request) => res,
            }
        } else {
            gate.ask(request).await
        };

        let answers = match answers {
            Ok(a) => a,
            Err(QuestionError::Timeout) => {
                return Err(ToolError::Execution(
                    "User did not answer within the timeout window. \
                     Consider asking again or proceeding with a safe default."
                        .into(),
                ));
            }
            Err(QuestionError::Cancelled) => return Err(ToolError::Cancelled),
            Err(QuestionError::Unsupported) => {
                return Err(ToolError::Execution(
                    "This IM channel does not support interactive multiple-choice \
                     questions. Fall back to asking the question in plain prose."
                        .into(),
                ));
            }
            Err(QuestionError::Other(msg)) => return Err(ToolError::Execution(msg)),
        };

        // Render the result as a structured JSON payload. Keys are the
        // verbatim question text so the model can correlate without
        // re-reading its own tool_use input.
        let mut by_question = serde_json::Map::new();
        for (qi, q) in parsed.questions.iter().enumerate() {
            let qid = format!("q_{qi}");
            let answer = answers
                .answers
                .iter()
                .find(|a| a.question_id == qid)
                .cloned()
                .unwrap_or_default();
            let selected_labels: Vec<String> = answer
                .selected_option_ids
                .iter()
                .filter_map(|sid| {
                    sid.strip_prefix("opt_")
                        .and_then(|n| n.parse::<usize>().ok())
                        .and_then(|i| q.options.get(i).map(|o| o.label.clone()))
                })
                .collect();
            let entry = json!({
                "selected": selected_labels,
                "selected_option_ids": answer.selected_option_ids,
                "other_text": answer.other_text,
                "notes": answer.notes,
            });
            by_question.insert(q.question.clone(), entry);
        }

        Ok(ToolOutput::json(json!({
            "answers": Value::Object(by_question),
            "user_id": answers.user_id,
            "decided_at": answers.decided_at,
        })))
    }
}

fn validate_input(input: &Input) -> Result<(), ToolError> {
    if input.questions.is_empty() {
        return Err(ToolError::InvalidInput(
            "questions must contain at least 1 entry".into(),
        ));
    }
    if input.questions.len() > MAX_QUESTIONS {
        return Err(ToolError::InvalidInput(format!(
            "at most {MAX_QUESTIONS} questions allowed; got {}",
            input.questions.len()
        )));
    }
    let mut seen_questions = std::collections::HashSet::new();
    for (qi, q) in input.questions.iter().enumerate() {
        if q.question.trim().is_empty() {
            return Err(ToolError::InvalidInput(format!(
                "question {qi}: text is empty"
            )));
        }
        if !seen_questions.insert(q.question.as_str()) {
            return Err(ToolError::InvalidInput(format!(
                "duplicate question text at index {qi}: {}",
                q.question
            )));
        }
        if let Some(h) = &q.header {
            if h.chars().count() > MAX_HEADER_CHARS {
                return Err(ToolError::InvalidInput(format!(
                    "question {qi}: header exceeds {MAX_HEADER_CHARS} chars (got {})",
                    h.chars().count()
                )));
            }
        }
        if q.options.len() < MIN_OPTIONS || q.options.len() > MAX_OPTIONS {
            return Err(ToolError::InvalidInput(format!(
                "question {qi}: options must be {MIN_OPTIONS}..={MAX_OPTIONS}; got {}",
                q.options.len()
            )));
        }
        let mut seen_labels = std::collections::HashSet::new();
        for (oi, o) in q.options.iter().enumerate() {
            if o.label.trim().is_empty() {
                return Err(ToolError::InvalidInput(format!(
                    "question {qi} option {oi}: label is empty"
                )));
            }
            if !seen_labels.insert(o.label.as_str()) {
                return Err(ToolError::InvalidInput(format!(
                    "question {qi}: duplicate option label: {}",
                    o.label
                )));
            }
            if o.label.eq_ignore_ascii_case("other") {
                return Err(ToolError::InvalidInput(format!(
                    "question {qi} option {oi}: do not include an \"Other\" \
                     option — the user always gets a free-form fallback automatically"
                )));
            }
        }
    }
    Ok(())
}

fn gate_from_ctx(ctx: &ToolContext) -> Option<Arc<dyn snaca_engine::QuestionGate>> {
    let opaque = ctx.question_gate_opaque()?;
    let slot = opaque.downcast::<QuestionGateSlot>().ok()?;
    Some(slot.gate())
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, SessionId, TenantId};
    use snaca_engine::{FixedQuestionGate, QuestionAnswer, QuestionAnswers, QuestionGate};

    fn make_ctx(gate: Option<Arc<dyn QuestionGate>>) -> ToolContext {
        let tmp = std::env::temp_dir().join("snaca-ask-test");
        let mut ctx = ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            tmp,
        );
        if let Some(g) = gate {
            ctx = ctx.with_question_gate(
                Arc::new(QuestionGateSlot::new(g)) as Arc<dyn std::any::Any + Send + Sync>
            );
        }
        ctx
    }

    fn good_input() -> Value {
        json!({
            "questions": [{
                "question": "Pick a flavor?",
                "options": [
                    {"label": "Chocolate"},
                    {"label": "Vanilla"}
                ]
            }]
        })
    }

    #[tokio::test]
    async fn accepts_minimal_input_and_returns_fixed_answer() {
        let gate = FixedQuestionGate::new(QuestionAnswers {
            answers: vec![QuestionAnswer {
                question_id: "q_0".into(),
                selected_option_ids: vec!["opt_0".into()],
                other_text: None,
                notes: None,
            }],
            user_id: "u1".into(),
            decided_at: "2026-05-24T00:00:00Z".into(),
        });
        let ctx = make_ctx(Some(Arc::new(gate)));
        let out = AskUserQuestionTool
            .execute(good_input(), &ctx)
            .await
            .unwrap();
        let value = match out {
            ToolOutput::Json(v) => v,
            other => panic!("expected Json, got {other:?}"),
        };
        let selected = value["answers"]["Pick a flavor?"]["selected"]
            .as_array()
            .unwrap();
        assert_eq!(selected[0], "Chocolate");
        assert_eq!(value["user_id"], "u1");
    }

    #[tokio::test]
    async fn rejects_other_label() {
        let ctx = make_ctx(Some(Arc::new(FixedQuestionGate::new(
            QuestionAnswers::default(),
        ))));
        let input = json!({
            "questions": [{
                "question": "X?",
                "options": [{"label":"A"}, {"label":"Other"}]
            }]
        });
        let err = AskUserQuestionTool.execute(input, &ctx).await.unwrap_err();
        let ToolError::InvalidInput(msg) = err else {
            panic!("expected InvalidInput, got {err:?}");
        };
        assert!(msg.contains("Other"), "msg={msg}");
    }

    #[tokio::test]
    async fn rejects_too_few_options() {
        let ctx = make_ctx(Some(Arc::new(FixedQuestionGate::new(
            QuestionAnswers::default(),
        ))));
        let input = json!({
            "questions": [{
                "question": "X?",
                "options": [{"label":"Only"}]
            }]
        });
        let err = AskUserQuestionTool.execute(input, &ctx).await.unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn rejects_duplicate_question_text() {
        let ctx = make_ctx(Some(Arc::new(FixedQuestionGate::new(
            QuestionAnswers::default(),
        ))));
        let input = json!({
            "questions": [
                {"question":"Same?","options":[{"label":"A"},{"label":"B"}]},
                {"question":"Same?","options":[{"label":"C"},{"label":"D"}]}
            ]
        });
        let err = AskUserQuestionTool.execute(input, &ctx).await.unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn rejects_too_many_questions() {
        let ctx = make_ctx(Some(Arc::new(FixedQuestionGate::new(
            QuestionAnswers::default(),
        ))));
        let mut qs = Vec::new();
        for i in 0..5 {
            qs.push(json!({
                "question": format!("Q{i}?"),
                "options": [{"label":"A"},{"label":"B"}]
            }));
        }
        let input = json!({"questions": qs});
        let err = AskUserQuestionTool.execute(input, &ctx).await.unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn no_gate_attached_returns_clean_error() {
        let ctx = make_ctx(None);
        let err = AskUserQuestionTool
            .execute(good_input(), &ctx)
            .await
            .unwrap_err();
        let ToolError::Execution(msg) = err else {
            panic!("expected Execution error, got {err:?}");
        };
        assert!(msg.contains("no question gate"), "msg={msg}");
    }

    #[tokio::test]
    async fn unsupported_gate_produces_clean_error() {
        let ctx = make_ctx(Some(Arc::new(snaca_engine::NoopQuestionGate)));
        let err = AskUserQuestionTool
            .execute(good_input(), &ctx)
            .await
            .unwrap_err();
        let ToolError::Execution(msg) = err else {
            panic!("expected Execution error, got {err:?}");
        };
        assert!(msg.contains("does not support"), "msg={msg}");
    }

    #[tokio::test]
    async fn renders_multi_select_labels_into_payload() {
        let gate = FixedQuestionGate::new(QuestionAnswers {
            answers: vec![QuestionAnswer {
                question_id: "q_0".into(),
                selected_option_ids: vec!["opt_0".into(), "opt_2".into()],
                other_text: None,
                notes: None,
            }],
            user_id: "u1".into(),
            decided_at: "2026-05-24T00:00:00Z".into(),
        });
        let ctx = make_ctx(Some(Arc::new(gate)));
        let input = json!({
            "questions": [{
                "question": "Which features?",
                "multi_select": true,
                "options": [
                    {"label": "Auth"},
                    {"label": "Billing"},
                    {"label": "Reports"}
                ]
            }]
        });
        let out = AskUserQuestionTool.execute(input, &ctx).await.unwrap();
        let value = match out {
            ToolOutput::Json(v) => v,
            other => panic!("expected Json, got {other:?}"),
        };
        let labels = value["answers"]["Which features?"]["selected"]
            .as_array()
            .unwrap();
        assert_eq!(labels.len(), 2);
        assert_eq!(labels[0], "Auth");
        assert_eq!(labels[1], "Reports");
    }

    #[tokio::test]
    async fn renders_multiple_questions_into_payload() {
        let gate = FixedQuestionGate::new(QuestionAnswers {
            answers: vec![
                QuestionAnswer {
                    question_id: "q_0".into(),
                    selected_option_ids: vec!["opt_0".into()],
                    other_text: None,
                    notes: None,
                },
                QuestionAnswer {
                    question_id: "q_1".into(),
                    selected_option_ids: vec![],
                    other_text: Some("typed answer".into()),
                    notes: None,
                },
            ],
            user_id: "u1".into(),
            decided_at: "2026-05-24T00:00:00Z".into(),
        });
        let ctx = make_ctx(Some(Arc::new(gate)));
        let input = json!({
            "questions": [
                {"question": "Q1?", "options": [{"label":"A"}, {"label":"B"}]},
                {"question": "Q2?", "options": [{"label":"X"}, {"label":"Y"}]}
            ]
        });
        let out = AskUserQuestionTool.execute(input, &ctx).await.unwrap();
        let value = match out {
            ToolOutput::Json(v) => v,
            other => panic!("expected Json, got {other:?}"),
        };
        assert_eq!(value["answers"]["Q1?"]["selected"][0], "A");
        assert_eq!(value["answers"]["Q2?"]["other_text"], "typed answer");
        assert!(value["answers"]["Q2?"]["selected"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn renders_other_text_into_payload() {
        let gate = FixedQuestionGate::new(QuestionAnswers {
            answers: vec![QuestionAnswer {
                question_id: "q_0".into(),
                selected_option_ids: vec![],
                other_text: Some("custom answer".into()),
                notes: None,
            }],
            user_id: "u1".into(),
            decided_at: "2026-05-24T00:00:00Z".into(),
        });
        let ctx = make_ctx(Some(Arc::new(gate)));
        let out = AskUserQuestionTool
            .execute(good_input(), &ctx)
            .await
            .unwrap();
        let value = match out {
            ToolOutput::Json(v) => v,
            other => panic!("expected Json, got {other:?}"),
        };
        assert_eq!(
            value["answers"]["Pick a flavor?"]["other_text"],
            "custom answer"
        );
    }
}
