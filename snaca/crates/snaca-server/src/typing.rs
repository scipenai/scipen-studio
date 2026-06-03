//! `ChannelTypingListener` — forwards LLM text deltas straight to the IM
//! channel as `message.send` (first delta) → `message.update` (each
//! subsequent delta). The user sees a typewriter effect tracking the
//! model's output verbatim.
//!
//! ## Default: no throttle
//!
//! `DEFAULT_UPDATE_INTERVAL = Duration::ZERO`. We push every delta to
//! the wire as fast as it arrives. Lark's `update_message` (PATCH on a
//! card) is the only IM platform we currently target that has a real
//! per-card QPS cap, and even there a chatty provider rarely sustains
//! more than a few deltas per second after token boundaries. Operators
//! who hit `RateLimited` errors can re-introduce throttling by setting
//! `[server] typing_update_interval_ms = 200` in `snaca.toml`.
//!
//! ## Editable channels only
//!
//! The listener writes nothing to the wire when the plugin advertises
//! `capabilities.update_message = false` (e.g. plain-text IM channels
//! that can't edit messages in place). The dispatcher's post-turn
//! `send_message` then delivers a single clean reply once the turn
//! ends.
//!
//! Design choices:
//! - **Text only**: thinking blocks and tool_use blocks are deliberately
//!   not surfaced — they're either internal reasoning the user shouldn't
//!   see, or wire-level tool calls the dispatcher renders separately.
//! - **First send creates a card**: subsequent updates need an editable
//!   surface. We pass `format = "card"` so plugins like Lark wrap the
//!   first delta in an interactive card; the same card is then patched
//!   by every following `message.update`.

use async_trait::async_trait;
use snaca_channel_host::PluginHandle;
use snaca_channel_protocol::methods::{MessageSendParams, MessageUpdateParams};
use snaca_engine::TurnEventListener;
use snaca_llm::{ContentDelta, StreamEvent};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tracing::warn;

/// Default delay between successive `update_message` RPCs. Zero =
/// push every delta immediately. Override per-deployment via
/// `[server] typing_update_interval_ms` if your channel rate-limits.
pub const DEFAULT_UPDATE_INTERVAL: Duration = Duration::ZERO;

pub struct ChannelTypingListener {
    plugin: PluginHandle,
    plugin_tenant_id: String,
    chat_id: String,
    state: Mutex<TypingState>,
    update_interval: Duration,
    /// True when the plugin's manifest declares
    /// `capabilities.update_message = true`. Editable channels stream
    /// text live; non-editable channels stay silent and let the
    /// dispatcher's post-turn send deliver one clean reply.
    update_supported: bool,
}

#[derive(Default)]
struct TypingState {
    /// Text accumulated across all `ContentBlockDelta::Text` events.
    accumulated: String,
    /// Last text we actually pushed to the plugin. May lag `accumulated`
    /// while we're inside the throttle window (only relevant when
    /// `update_interval > 0`).
    pushed_text: String,
    /// Plugin-side message id returned by the first `send_message`.
    message_id: Option<String>,
    /// Wall clock at the most recent successful push (send or update).
    /// `None` until the first push completes.
    last_pushed_at: Option<Instant>,
}

/// What the dispatcher needs to know after the turn finishes.
pub struct TypingHandoff {
    pub message_id: String,
    pub streamed_text: String,
}

impl ChannelTypingListener {
    /// Build with the production default throttle interval.
    pub fn new(plugin: PluginHandle, plugin_tenant_id: String, chat_id: String) -> Self {
        Self::with_interval(
            plugin,
            plugin_tenant_id,
            chat_id,
            DEFAULT_UPDATE_INTERVAL,
        )
    }

    /// Build with a custom throttle interval. Pass `Duration::ZERO`
    /// (the default) to disable throttling — one plugin RPC per delta.
    pub fn with_interval(
        plugin: PluginHandle,
        plugin_tenant_id: String,
        chat_id: String,
        update_interval: Duration,
    ) -> Self {
        let update_supported = plugin.manifest().capabilities.update_message;
        Self {
            plugin,
            plugin_tenant_id,
            chat_id,
            state: Mutex::new(TypingState::default()),
            update_interval,
            update_supported,
        }
    }

    /// After the turn ends: if the listener pushed at least one text
    /// delta, returns `Some((message_id, streamed_text))` so the
    /// dispatcher can issue a final `update_message` with the engine's
    /// authoritative output. `None` means the listener never fired —
    /// dispatcher should send a fresh message instead.
    pub async fn finalize(&self) -> Option<TypingHandoff> {
        let state = self.state.lock().await;
        state.message_id.as_ref().map(|mid| TypingHandoff {
            message_id: mid.clone(),
            streamed_text: state.pushed_text.clone(),
        })
    }
}

#[async_trait]
impl TurnEventListener for ChannelTypingListener {
    async fn on_event(&self, event: &StreamEvent) {
        let StreamEvent::ContentBlockDelta { delta, .. } = event else {
            return;
        };
        let ContentDelta::Text { text } = delta else {
            return;
        };
        if text.is_empty() {
            return;
        }

        // Plugins that can't edit messages: stay silent. The
        // dispatcher's post-turn `send_message` delivers the only
        // user-visible reply.
        if !self.update_supported {
            let mut state = self.state.lock().await;
            state.accumulated.push_str(text);
            return;
        }

        // Step 1: accumulate + decide whether this delta becomes a push.
        let snapshot;
        let mid_opt;
        {
            let mut state = self.state.lock().await;
            state.accumulated.push_str(text);
            snapshot = state.accumulated.clone();
            mid_opt = state.message_id.clone();

            // Throttle (only after the initial send_message — that one
            // always goes out so the user sees something fast).
            if mid_opt.is_some() && !self.update_interval.is_zero() {
                if let Some(last) = state.last_pushed_at {
                    if last.elapsed() < self.update_interval {
                        // Skip the wire push; accumulated text is still
                        // updated so the next out-of-window delta picks
                        // up everything seen so far.
                        return;
                    }
                }
            }

            state.pushed_text = snapshot.clone();
            state.last_pushed_at = Some(Instant::now());
        }

        // Step 2: do the actual plugin RPC outside the lock.
        match mid_opt {
            None => {
                // First delta: send a card so subsequent updates have
                // an editable surface to patch.
                let params = MessageSendParams {
                    tenant_id: self.plugin_tenant_id.clone(),
                    chat_id: self.chat_id.clone(),
                    content: snapshot,
                    format: Some("card".into()),
                    reply_to: None,
                    // Streaming/typing pushes are intentionally ephemeral
                    // — see [`crate::outbox`]'s module doc on why typing
                    // does not go through the durable outbox. No need
                    // for an idempotency key on a fire-and-forget chunk.
                    idempotency_key: None,
                };
                match self.plugin.send_message(params).await {
                    Ok(result) => {
                        let mut state = self.state.lock().await;
                        if state.message_id.is_none() {
                            state.message_id = Some(result.message_id);
                        }
                    }
                    Err(e) => {
                        warn!(error = ?e, "typing listener: initial send_message failed");
                    }
                }
            }
            Some(mid) => {
                let params = MessageUpdateParams {
                    tenant_id: self.plugin_tenant_id.clone(),
                    message_id: mid,
                    content: snapshot,
                };
                if let Err(e) = self.plugin.update_message(params).await {
                    warn!(error = ?e, "typing listener: update_message failed");
                }
            }
        }
    }
}
