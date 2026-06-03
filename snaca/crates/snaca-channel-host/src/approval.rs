//! Approval registry — pairs `approval.present` outbound calls with the
//! `event.approval_callback` notifications that resolve them.
//!
//! Flow:
//! 1. Engine asks the plugin for approval; `PluginHandle::request_approval`
//!    generates a fresh `callback_token`, registers it here with an
//!    `oneshot::Sender`, and emits `approval.present` to the plugin.
//! 2. Plugin (or, for tests, the mock plugin's `--auto-approve` mode)
//!    eventually sends `event.approval_callback {callback_token, decision}`.
//! 3. The reader task pulls the matching sender from the registry and
//!    delivers the decision; the engine's pending future resolves.

use snaca_channel_protocol::methods::ApprovalDecision;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;

#[derive(Default)]
pub struct ApprovalRegistry {
    pending: Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>,
}

impl ApprovalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a sender for `token`. Replaces any prior entry under the
    /// same token (which would only happen with a token collision — we use
    /// 32 bytes of randomness, so this is purely defensive).
    pub fn register(&self, token: String, tx: oneshot::Sender<ApprovalDecision>) {
        let mut map = self.pending.lock().expect("approval registry mutex");
        map.insert(token, tx);
    }

    /// Atomically remove and return the sender for `token`. The sender is
    /// removed regardless of whether the caller intends to send on it (e.g.
    /// a timeout path also calls `take` to release the slot).
    pub fn take(&self, token: &str) -> Option<oneshot::Sender<ApprovalDecision>> {
        let mut map = self.pending.lock().expect("approval registry mutex");
        map.remove(token)
    }

    /// Number of in-flight approval requests. For diagnostics.
    pub fn pending_count(&self) -> usize {
        self.pending.lock().expect("approval registry mutex").len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_and_take_round_trip() {
        let reg = ApprovalRegistry::new();
        let (tx, rx) = oneshot::channel();
        reg.register("tok-1".into(), tx);
        assert_eq!(reg.pending_count(), 1);

        let taken = reg.take("tok-1").expect("sender present");
        taken.send(ApprovalDecision::Allow).unwrap();
        let decision = rx.await.unwrap();
        assert_eq!(decision, ApprovalDecision::Allow);
        assert_eq!(reg.pending_count(), 0);
    }

    #[tokio::test]
    async fn take_unknown_token_is_none() {
        let reg = ApprovalRegistry::new();
        assert!(reg.take("unknown").is_none());
    }

    #[tokio::test]
    async fn second_registration_replaces_first() {
        let reg = ApprovalRegistry::new();
        let (tx_a, _rx_a) = oneshot::channel::<ApprovalDecision>();
        let (tx_b, rx_b) = oneshot::channel();
        reg.register("dup".into(), tx_a);
        reg.register("dup".into(), tx_b);
        let taken = reg.take("dup").unwrap();
        taken.send(ApprovalDecision::Deny).unwrap();
        // The second sender (tx_b) must be the one that fired.
        assert_eq!(rx_b.await.unwrap(), ApprovalDecision::Deny);
    }
}
