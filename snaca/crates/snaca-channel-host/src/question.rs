//! Question registry — pairs `question.present` outbound calls with
//! the `event.question_callback` notifications that resolve them.
//!
//! Structurally identical to [`crate::approval::ApprovalRegistry`]; the
//! only difference is the payload type carried over the oneshot. Lives
//! as a sibling rather than a generic-over-`T` registry because the
//! tradeoff is essentially nothing: two ~50-line files, each clearly
//! about exactly one thing, vs. one parameterised file that mixes
//! approval and question semantics in the type signature of every
//! method.

use snaca_channel_protocol::methods::QuestionCallbackParams;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;

#[derive(Default)]
pub struct QuestionRegistry {
    pending: Mutex<HashMap<String, oneshot::Sender<QuestionCallbackParams>>>,
}

impl QuestionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a sender for `token`. Replaces any prior entry under
    /// the same token; collisions are statistically negligible (32
    /// bytes of randomness) but the overwrite keeps behaviour
    /// well-defined when one does happen.
    pub fn register(&self, token: String, tx: oneshot::Sender<QuestionCallbackParams>) {
        let mut map = self.pending.lock().expect("question registry mutex");
        map.insert(token, tx);
    }

    /// Atomically remove and return the sender for `token`. Both the
    /// callback path (real answer) and the timeout path (release the
    /// slot) call `take`, so a second click on a stale card finds the
    /// slot empty and is silently dropped one layer up.
    pub fn take(&self, token: &str) -> Option<oneshot::Sender<QuestionCallbackParams>> {
        let mut map = self.pending.lock().expect("question registry mutex");
        map.remove(token)
    }

    /// In-flight question count, for diagnostics / health endpoints.
    pub fn pending_count(&self) -> usize {
        self.pending.lock().expect("question registry mutex").len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_channel_protocol::methods::QuestionAnswer;

    fn sample_callback(token: &str) -> QuestionCallbackParams {
        QuestionCallbackParams {
            auth: "auth".into(),
            callback_token: token.into(),
            answers: vec![QuestionAnswer {
                question_id: "q_0".into(),
                selected_option_ids: vec!["a".into()],
                other_text: None,
                notes: None,
            }],
            user_id: "u1".into(),
            decided_at: "2026-05-24T00:00:00Z".into(),
        }
    }

    #[tokio::test]
    async fn register_and_take_round_trip() {
        let reg = QuestionRegistry::new();
        let (tx, rx) = oneshot::channel();
        reg.register("tok-1".into(), tx);
        assert_eq!(reg.pending_count(), 1);

        let taken = reg.take("tok-1").expect("sender present");
        taken.send(sample_callback("tok-1")).unwrap();
        let got = rx.await.unwrap();
        assert_eq!(got.callback_token, "tok-1");
        assert_eq!(got.user_id, "u1");
        assert_eq!(reg.pending_count(), 0);
    }

    #[tokio::test]
    async fn take_unknown_token_is_none() {
        let reg = QuestionRegistry::new();
        assert!(reg.take("unknown").is_none());
    }

    #[tokio::test]
    async fn second_registration_replaces_first() {
        let reg = QuestionRegistry::new();
        let (tx_a, _rx_a) = oneshot::channel::<QuestionCallbackParams>();
        let (tx_b, rx_b) = oneshot::channel();
        reg.register("dup".into(), tx_a);
        reg.register("dup".into(), tx_b);
        let taken = reg.take("dup").unwrap();
        taken.send(sample_callback("dup")).unwrap();
        // The second sender must be the one that fires.
        let got = rx_b.await.unwrap();
        assert_eq!(got.callback_token, "dup");
    }
}
