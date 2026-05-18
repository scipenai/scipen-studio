//! `LlmClient` trait + provider capability advertising.

use crate::error::LlmResult;
use crate::request::MessageRequest;
use crate::response::MessageResponse;
use crate::stream::{synthesize_events, StreamEvent};
use async_trait::async_trait;
use futures::stream::BoxStream;

/// Per-provider capability flags. The engine reads these to decide which
/// canonical features to emit (e.g. only attach `cache_control` when the
/// provider supports prompt caching).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProviderCaps {
    /// Tool calling support. `false` = engine must run "no tools" mode.
    pub tool_use: bool,
    /// Prompt caching (Anthropic only at the moment).
    pub prompt_cache: bool,
    /// Extended thinking blocks (Anthropic) or `reasoning_content` (DeepSeek R1).
    pub thinking: bool,
    /// Streaming responses via SSE.
    pub streaming: bool,
}

#[async_trait]
pub trait LlmClient: Send + Sync {
    /// Stable provider identifier for observability and dispatch.
    fn provider_name(&self) -> &'static str;

    /// Default model string this client will use unless overridden in the
    /// request.
    fn model(&self) -> &str;

    /// Capabilities the engine can rely on.
    fn capabilities(&self) -> ProviderCaps;

    /// Single round trip; returns the assistant message + usage + stop reason.
    /// Streaming is added in a follow-up (M2) — until then engines either
    /// poll this or accept "no typing indicator".
    async fn create_message(&self, request: MessageRequest) -> LlmResult<MessageResponse>;

    /// Streaming variant — yields canonical [`StreamEvent`]s as the model
    /// produces them. The default implementation runs the non-streaming
    /// path and synthesizes a single `MessageStart` → blocks → `MessageStop`
    /// sequence; providers with native SSE support override this with a
    /// real wire-level stream so partial deltas reach the caller as they
    /// arrive.
    async fn create_message_stream(
        &self,
        request: MessageRequest,
    ) -> LlmResult<BoxStream<'static, LlmResult<StreamEvent>>> {
        let response = self.create_message(request).await?;
        let events = synthesize_events(response);
        Ok(Box::pin(futures::stream::iter(
            events.into_iter().map(Ok),
        )))
    }
}
