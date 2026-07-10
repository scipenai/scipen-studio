//! Text-fallback registry for `AskUserQuestion` on non-interactive
//! channels.
//!
//! When the IM plugin does NOT advertise `interactive_card` capability
//! (e.g. a plain webhook bot, a SMS bridge, a Telegram plugin without
//! inline-keyboard wiring), `ChannelQuestionGate` falls back to sending
//! the question as plain markdown. The user then types their answer as
//! a normal IM message. The dispatcher checks this registry before
//! starting a new turn — when a pending question is waiting on the
//! chat, the next message routes to the answer parser instead.
//!
//! Scope:
//! - **Per-chat single slot**: at most one pending text question per
//!   `(plugin, chat_id)`. If a second `ask` arrives while one is
//!   pending we replace the older waiter (it will see a `Cancelled`
//!   error and the LLM can retry). Multi-question prompts route to a
//!   single slot too.
//! - **Process-wide**: a global `OnceLock` keyed by
//!   `(plugin_name, chat_id)`. Both `ChannelQuestionGate` (which lives
//!   per-turn) and the dispatcher (which lives per-plugin) need
//!   access; a singleton keeps the wiring trivial.
//! - **In-memory only**: parity with `QuestionRegistry` /
//!   `ApprovalRegistry`. Process restart drops all pending waiters
//!   along with the engine tasks awaiting them.

use snaca_engine::{QuestionAnswer, QuestionAnswers, QuestionSpec};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio::sync::oneshot;

/// Key used to look up a pending text question. `(plugin_name, chat_id)`
/// matches the dispatcher's per-chat actor scope, so attribution stays
/// per-chat even in multi-tenant deployments.
pub type TextKey = (String, String);

/// Per-slot context — needed by both the gate (to know what to parse
/// against) and the dispatcher (to render a "received" ack).
#[derive(Debug, Clone)]
pub struct PendingTextQuestion {
    pub questions: Vec<QuestionSpec>,
    pub tx: TextSender,
}

/// `Arc<Mutex<Option<Sender>>>` so we can take the oneshot without
/// taking the registry's HashMap entry — the entry is removed
/// separately so the slot becomes available for the next ask.
pub type TextSender = std::sync::Arc<Mutex<Option<oneshot::Sender<QuestionAnswers>>>>;

#[derive(Default)]
pub struct TextQuestionRegistry {
    pending: Mutex<HashMap<TextKey, PendingTextQuestion>>,
}

impl TextQuestionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Install a pending text question for `(plugin, chat_id)`. Any
    /// prior entry under the same key is dropped — its oneshot Sender
    /// is closed, the awaiting future on the other end resolves with
    /// `Cancelled`.
    pub fn register(
        &self,
        key: TextKey,
        questions: Vec<QuestionSpec>,
        tx: oneshot::Sender<QuestionAnswers>,
    ) {
        let mut map = self.pending.lock().expect("text question registry mutex");
        map.insert(
            key,
            PendingTextQuestion {
                questions,
                tx: std::sync::Arc::new(Mutex::new(Some(tx))),
            },
        );
    }

    /// Take the pending entry under `key` (consumes the slot). Returns
    /// `None` if no question is pending. Caller is expected to either
    /// fire the sender with parsed answers or drop it (latter is
    /// equivalent to Cancelled on the awaiting end).
    pub fn take(&self, key: &TextKey) -> Option<PendingTextQuestion> {
        let mut map = self.pending.lock().expect("text question registry mutex");
        map.remove(key)
    }

    /// Release a slot WITHOUT firing the sender. Used by the gate's
    /// timeout / cancel paths.
    pub fn release(&self, key: &TextKey) -> Option<PendingTextQuestion> {
        self.take(key)
    }

    pub fn pending_count(&self) -> usize {
        self.pending
            .lock()
            .expect("text question registry mutex")
            .len()
    }
}

static REGISTRY: OnceLock<TextQuestionRegistry> = OnceLock::new();

/// Process-wide singleton. Both the gate and dispatcher pull from
/// here.
pub fn registry() -> &'static TextQuestionRegistry {
    REGISTRY.get_or_init(TextQuestionRegistry::new)
}

/// Render a question set as the markdown body the user will see in
/// IM. Format mirrors what the Lark interactive card looks like in
/// principle so the experience is consistent across channels:
///
/// ```text
/// ❓ 请回答:
///
/// **Q1: Which auth method?**
///   1) OAuth
///   2) JWT
/// 回复数字(如 `1` 或 `1,3`),或直接输入文本作为"其他"答案。
/// ```
pub fn render_text_prompt(questions: &[QuestionSpec]) -> String {
    let mut s = String::from("❓ 请回答:\n");
    for (qi, q) in questions.iter().enumerate() {
        s.push('\n');
        if questions.len() == 1 {
            s.push_str(&format!("**{}**\n", q.question));
        } else {
            s.push_str(&format!("**Q{}: {}**\n", qi + 1, q.question));
        }
        for (oi, opt) in q.options.iter().enumerate() {
            s.push_str(&format!("  {}) {}\n", oi + 1, opt.label));
            if let Some(d) = opt.description.as_deref().filter(|d| !d.is_empty()) {
                s.push_str(&format!("     · {d}\n"));
            }
        }
    }
    s.push('\n');
    if questions.len() == 1 && questions[0].multi_select {
        s.push_str("回复一个或多个数字(逗号分隔,如 `1,3`),或直接输入文本作为\"其他\"答案。");
    } else if questions.len() == 1 {
        s.push_str("回复一个数字(如 `2`),或直接输入文本作为\"其他\"答案。");
    } else {
        s.push_str("按顺序回复,每问一行,数字或文本均可。多选题用逗号分隔(如 `1,3`)。");
    }
    s
}

/// Parse the user's raw IM message into structured answers.
///
/// Strategy (in order):
///
/// 1. Single-question, integers like `2` or `1,3`: 1-based option
///    indices. Out-of-range indices fall through to Other text.
/// 2. Single-question, case-insensitive substring match against a
///    unique option label (e.g. user typed `oauth` and one option is
///    `OAuth`).
/// 3. Single-question multi-question: NOT supported; the entire raw
///    message becomes the `other_text` of question 0 and the rest
///    arrive empty. Multi-question chats should switch to interactive
///    cards or split the questions across turns.
/// 4. Anything else: the raw text becomes `other_text` of the first
///    question and the rest answer empty.
///
/// Multi-line answers for multi-question text fallback are not
/// supported in this iteration — the parser intentionally stays simple.
/// Plugins that need multi-question must advertise `interactive_card`.
pub fn parse_text_answer(questions: &[QuestionSpec], raw: &str, user_id: &str) -> QuestionAnswers {
    let trimmed = raw.trim();
    let mut answers: Vec<QuestionAnswer> = questions
        .iter()
        .map(|q| QuestionAnswer {
            question_id: q.id.clone(),
            selected_option_ids: vec![],
            other_text: None,
            notes: None,
        })
        .collect();

    if questions.len() == 1 && !trimmed.is_empty() {
        let q = &questions[0];
        // Try indices first.
        if let Some(ids) = parse_indices(trimmed, q) {
            answers[0].selected_option_ids = ids;
        } else if let Some(id) = match_label_unique(trimmed, q) {
            answers[0].selected_option_ids = vec![id];
        } else {
            answers[0].other_text = Some(trimmed.to_string());
        }
    } else if !trimmed.is_empty() {
        // Multi-question: dump the whole message into Q1's other_text.
        // Clearer than silently misparsing.
        answers[0].other_text = Some(trimmed.to_string());
    }

    QuestionAnswers {
        answers,
        user_id: user_id.to_string(),
        decided_at: chrono::Utc::now().to_rfc3339(),
    }
}

fn parse_indices(text: &str, q: &QuestionSpec) -> Option<Vec<String>> {
    // Accept `1`, `1,3`, `1, 3`, `1 3`, etc. Reject if any token is
    // not a positive integer or out of range.
    let tokens: Vec<&str> = text
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    let mut ids = Vec::with_capacity(tokens.len());
    for tok in tokens {
        let n: usize = tok.parse().ok()?;
        if n == 0 || n > q.options.len() {
            return None;
        }
        ids.push(q.options[n - 1].id.clone());
    }
    if !q.multi_select && ids.len() > 1 {
        // single-select but user typed multiple indices — let it fall
        // through to other_text rather than guess.
        return None;
    }
    Some(ids)
}

fn match_label_unique(text: &str, q: &QuestionSpec) -> Option<String> {
    let needle = text.to_ascii_lowercase();
    let matches: Vec<&str> = q
        .options
        .iter()
        .filter(|o| o.label.to_ascii_lowercase().contains(&needle))
        .map(|o| o.id.as_str())
        .collect();
    if matches.len() == 1 {
        Some(matches[0].to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_engine::QuestionOption;

    fn q(id: &str, multi: bool, options: &[(&str, &str)]) -> QuestionSpec {
        QuestionSpec {
            id: id.into(),
            question: format!("{id}?"),
            header: None,
            options: options
                .iter()
                .map(|(oid, label)| QuestionOption {
                    id: (*oid).into(),
                    label: (*label).into(),
                    description: None,
                    preview: None,
                })
                .collect(),
            multi_select: multi,
            allow_other: true,
        }
    }

    #[test]
    fn render_single_question_with_options() {
        let qs = vec![q("q_0", false, &[("opt_0", "OAuth"), ("opt_1", "JWT")])];
        let s = render_text_prompt(&qs);
        assert!(s.contains("**q_0?**"));
        assert!(s.contains("1) OAuth"));
        assert!(s.contains("2) JWT"));
        assert!(s.contains("回复一个数字"));
    }

    #[test]
    fn render_multi_select_hint_mentions_csv() {
        let qs = vec![q("q_0", true, &[("opt_0", "A"), ("opt_1", "B")])];
        let s = render_text_prompt(&qs);
        assert!(s.contains("1,3"));
    }

    #[test]
    fn parse_integer_picks_option() {
        let qs = vec![q(
            "q_0",
            false,
            &[("opt_0", "A"), ("opt_1", "B"), ("opt_2", "C")],
        )];
        let out = parse_text_answer(&qs, "2", "u1");
        assert_eq!(
            out.answers[0].selected_option_ids,
            vec!["opt_1".to_string()]
        );
        assert_eq!(out.answers[0].other_text, None);
    }

    #[test]
    fn parse_csv_multi_select() {
        let qs = vec![q(
            "q_0",
            true,
            &[("opt_0", "A"), ("opt_1", "B"), ("opt_2", "C")],
        )];
        let out = parse_text_answer(&qs, "1, 3", "u1");
        assert_eq!(
            out.answers[0].selected_option_ids,
            vec!["opt_0".to_string(), "opt_2".to_string()]
        );
    }

    #[test]
    fn parse_csv_on_single_select_falls_through_to_other() {
        let qs = vec![q("q_0", false, &[("opt_0", "A"), ("opt_1", "B")])];
        let out = parse_text_answer(&qs, "1,2", "u1");
        assert!(out.answers[0].selected_option_ids.is_empty());
        assert_eq!(out.answers[0].other_text.as_deref(), Some("1,2"));
    }

    #[test]
    fn parse_out_of_range_falls_through_to_other() {
        let qs = vec![q("q_0", false, &[("opt_0", "A"), ("opt_1", "B")])];
        let out = parse_text_answer(&qs, "99", "u1");
        assert!(out.answers[0].selected_option_ids.is_empty());
        assert_eq!(out.answers[0].other_text.as_deref(), Some("99"));
    }

    #[test]
    fn parse_label_substring_match() {
        let qs = vec![q("q_0", false, &[("opt_0", "OAuth"), ("opt_1", "JWT")])];
        let out = parse_text_answer(&qs, "oauth", "u1");
        assert_eq!(
            out.answers[0].selected_option_ids,
            vec!["opt_0".to_string()]
        );
    }

    #[test]
    fn parse_ambiguous_label_falls_through_to_other() {
        let qs = vec![q(
            "q_0",
            false,
            &[("opt_0", "Auth Token"), ("opt_1", "Auth Cookie")],
        )];
        let out = parse_text_answer(&qs, "auth", "u1");
        assert!(out.answers[0].selected_option_ids.is_empty());
        assert_eq!(out.answers[0].other_text.as_deref(), Some("auth"));
    }

    #[test]
    fn parse_free_text_becomes_other() {
        let qs = vec![q("q_0", false, &[("opt_0", "A"), ("opt_1", "B")])];
        let out = parse_text_answer(&qs, "I want something else", "u1");
        assert!(out.answers[0].selected_option_ids.is_empty());
        assert_eq!(
            out.answers[0].other_text.as_deref(),
            Some("I want something else")
        );
    }

    #[test]
    fn parse_multi_question_dumps_into_q0_other() {
        let qs = vec![
            q("q_0", false, &[("opt_0", "A")]),
            q("q_1", false, &[("opt_0", "X")]),
        ];
        let out = parse_text_answer(&qs, "any text", "u1");
        assert_eq!(out.answers[0].other_text.as_deref(), Some("any text"));
        assert!(out.answers[1].other_text.is_none());
        assert!(out.answers[1].selected_option_ids.is_empty());
    }

    #[tokio::test]
    async fn registry_round_trip() {
        let reg = TextQuestionRegistry::new();
        let key = ("plug".to_string(), "chat".to_string());
        let (tx, rx) = oneshot::channel();
        let qs = vec![q("q_0", false, &[("opt_0", "A"), ("opt_1", "B")])];
        reg.register(key.clone(), qs.clone(), tx);
        assert_eq!(reg.pending_count(), 1);

        let pending = reg.take(&key).expect("present");
        let answers = parse_text_answer(&pending.questions, "2", "u1");
        let sender = pending.tx.lock().unwrap().take().expect("sender available");
        sender.send(answers).unwrap();
        let got = rx.await.unwrap();
        assert_eq!(
            got.answers[0].selected_option_ids,
            vec!["opt_1".to_string()]
        );
        assert_eq!(reg.pending_count(), 0);
    }
}
