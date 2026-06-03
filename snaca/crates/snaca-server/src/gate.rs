//! `ChannelApprovalGate` — adapter that lets the engine ask an IM plugin
//! for an approval decision.
//!
//! Implements [`snaca_engine::ApprovalGate`] by delegating to
//! [`snaca_channel_host::PluginHandle::request_approval`], which:
//! 1. allocates a fresh `callback_token`,
//! 2. sends `approval.present` to the plugin (with the request text the
//!    user will see in their IM),
//! 3. waits for the matching `event.approval_callback` to come back.
//!
//! Translation rules between the protocol's `ApprovalDecision` enum and
//! the engine's:
//! - `protocol::Allow` / `protocol::AllowOnce` → `engine::AllowOnce`
//!   (don't persist; ask again next time).
//! - `protocol::AllowAlways` → `engine::AllowAlways` (engine remembers
//!   the decision in `approval_decisions`).
//! - `protocol::Deny` → `engine::Deny`.

use async_trait::async_trait;
use snaca_channel_host::{ChannelError, PluginHandle};
use snaca_channel_protocol::methods::ApprovalDecision as WireDecision;
use snaca_engine::{
    ApprovalDecision, ApprovalError, ApprovalGate, ApprovalRequest, DenyAllApprovalGate,
    NoopApprovalGate,
};
use std::sync::Arc;
use std::time::Duration;
use tracing::warn;

const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);

/// Pick the approval gate the dispatcher hands to the engine, based on
/// the `SNACA_APPROVAL_MODE` env var.
///
/// - `interactive` (default, or unset): send a card to the IM channel and
///   wait for the user to click — the M1 behavior.
/// - `allow`: skip the card entirely; every tool that would have asked is
///   auto-allowed (`NoopApprovalGate`). For trusted single-tenant
///   deployments where the operator wants the bot to "just work".
/// - `deny`: every gated tool is rejected (`DenyAllApprovalGate`). The
///   LLM sees a clean "permission denied" tool_error and can adapt.
///
/// This is a different axis from [`SNACA_NO_APPROVAL_FALLBACK`], which
/// only kicks in when the underlying plugin lacks `interactive_card`
/// capability. `SNACA_APPROVAL_MODE` is the explicit operator override
/// and wins regardless of plugin capability.
pub fn build_approval_gate(
    plugin: PluginHandle,
    plugin_tenant_id: String,
    chat_id: String,
) -> Arc<dyn ApprovalGate> {
    match resolve_approval_mode() {
        ResolvedApprovalMode::Allow => Arc::new(NoopApprovalGate),
        ResolvedApprovalMode::Deny => Arc::new(DenyAllApprovalGate),
        ResolvedApprovalMode::Interactive => Arc::new(ChannelApprovalGate::new(
            plugin,
            plugin_tenant_id,
            chat_id,
        )),
        ResolvedApprovalMode::Unknown(other) => {
            warn!(
                value = %other,
                "unknown SNACA_APPROVAL_MODE value; falling back to interactive"
            );
            Arc::new(ChannelApprovalGate::new(
                plugin,
                plugin_tenant_id,
                chat_id,
            ))
        }
    }
}

/// Parsed `SNACA_APPROVAL_MODE`. Keeps `build_approval_gate` and the
/// startup-log helper in sync — when the parsing logic changes, both
/// sites pick it up.
enum ResolvedApprovalMode {
    Allow,
    Deny,
    Interactive,
    Unknown(String),
}

fn resolve_approval_mode() -> ResolvedApprovalMode {
    let raw = std::env::var("SNACA_APPROVAL_MODE").unwrap_or_default();
    match raw.trim().to_ascii_lowercase().as_str() {
        "allow" => ResolvedApprovalMode::Allow,
        "deny" => ResolvedApprovalMode::Deny,
        "" | "interactive" => ResolvedApprovalMode::Interactive,
        other => ResolvedApprovalMode::Unknown(other.to_string()),
    }
}

/// Log the resolved approval mode once at server startup. Operators
/// setting `SNACA_APPROVAL_MODE=allow` in the wrong shell (or in
/// `[plugins.env]`, which only reaches plugin subprocesses) get a clear
/// "still interactive" line here, instead of guessing why a write tool
/// still asks for a card.
pub fn log_approval_mode_at_startup() {
    let raw = std::env::var("SNACA_APPROVAL_MODE").ok();
    let raw_display = raw.as_deref().unwrap_or("<unset>");
    let resolved: &str = match resolve_approval_mode() {
        ResolvedApprovalMode::Allow => "allow (auto-allow, no card sent)",
        ResolvedApprovalMode::Deny => "deny (auto-reject every gated tool)",
        ResolvedApprovalMode::Interactive => {
            "interactive (default — card sent to chat, user clicks to decide)"
        }
        ResolvedApprovalMode::Unknown(_) => {
            "unknown value — will fall back to interactive at first gated call"
        }
    };
    tracing::info!(
        SNACA_APPROVAL_MODE = raw_display,
        resolved = resolved,
        "approval gate"
    );
}

pub struct ChannelApprovalGate {
    plugin: PluginHandle,
    /// IM-side tenant id passed back to the plugin so it knows which
    /// account to render the card under. Distinct from
    /// `request.tenant_id`, which is the engine's logical tenant key.
    plugin_tenant_id: String,
    chat_id: String,
    timeout: Duration,
}

impl ChannelApprovalGate {
    pub fn new(plugin: PluginHandle, plugin_tenant_id: String, chat_id: String) -> Self {
        Self {
            plugin,
            plugin_tenant_id,
            chat_id,
            timeout: DEFAULT_APPROVAL_TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    fn render_card(&self, request: &ApprovalRequest) -> String {
        let input_pretty = serde_json::to_string_pretty(&request.tool_input)
            .unwrap_or_else(|_| request.tool_input.to_string());
        if request.reason.is_empty() {
            format!(
                "Allow `{}` with input:\n```json\n{input_pretty}\n```",
                request.tool_name
            )
        } else {
            format!(
                "Allow `{}` ({}) with input:\n```json\n{input_pretty}\n```",
                request.tool_name, request.reason,
            )
        }
    }
}

#[async_trait]
impl ApprovalGate for ChannelApprovalGate {
    async fn request(&self, request: ApprovalRequest) -> Result<ApprovalDecision, ApprovalError> {
        // Skip the gate entirely when the underlying plugin doesn't
        // implement card-based approvals. The choice between
        // auto-allow and auto-deny is a deployment policy: trusted
        // single-tenant setups (e.g. a personal Lark bot) want the
        // bot to "just work"; multi-tenant or untrusted shells want
        // to refuse anything that would otherwise need a user click.
        //
        // `SNACA_NO_APPROVAL_FALLBACK` controls it:
        //   `allow` (default) — auto-grant `AllowOnce`. The current
        //                       turn proceeds; nothing is persisted.
        //   `deny`           — auto-`Deny`. LLM sees a clean
        //                      "permission denied" tool_error.
        //
        // Either way we never bubble an error: the engine's tool_error
        // synthesis depends on the gate returning *some* decision.
        if !self.plugin.manifest().capabilities.interactive_card {
            let fallback = std::env::var("SNACA_NO_APPROVAL_FALLBACK")
                .unwrap_or_else(|_| "allow".to_string())
                .to_ascii_lowercase();
            return Ok(if fallback == "deny" {
                ApprovalDecision::Deny
            } else {
                ApprovalDecision::AllowOnce
            });
        }
        let card_text = self.render_card(&request);
        let wire_decision = self
            .plugin
            .request_approval(
                self.plugin_tenant_id.clone(),
                self.chat_id.clone(),
                card_text,
                self.timeout,
            )
            .await
            .map_err(map_channel_error)?;
        Ok(translate(wire_decision))
    }
}

fn translate(d: WireDecision) -> ApprovalDecision {
    match d {
        // `Allow` and `AllowOnce` both mean "this call only" in our model.
        WireDecision::Allow | WireDecision::AllowOnce => ApprovalDecision::AllowOnce,
        WireDecision::AllowAlways => ApprovalDecision::AllowAlways,
        WireDecision::Deny => ApprovalDecision::Deny,
    }
}

fn map_channel_error(e: ChannelError) -> ApprovalError {
    match e {
        ChannelError::Timeout => ApprovalError::Timeout,
        ChannelError::Disconnected | ChannelError::SendClosed => ApprovalError::Cancelled,
        other => ApprovalError::Other(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translation_matrix() {
        assert_eq!(translate(WireDecision::Allow), ApprovalDecision::AllowOnce);
        assert_eq!(
            translate(WireDecision::AllowOnce),
            ApprovalDecision::AllowOnce
        );
        assert_eq!(
            translate(WireDecision::AllowAlways),
            ApprovalDecision::AllowAlways
        );
        assert_eq!(translate(WireDecision::Deny), ApprovalDecision::Deny);
    }

    #[test]
    fn channel_timeout_maps_to_approval_timeout() {
        let mapped = map_channel_error(ChannelError::Timeout);
        assert!(matches!(mapped, ApprovalError::Timeout));
    }
}
