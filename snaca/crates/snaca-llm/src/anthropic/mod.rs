//! Anthropic Messages API client (`POST /v1/messages`).
//!
//! Auth uses `x-api-key` (not `Authorization: Bearer`). Every request must
//! also carry `anthropic-version`. See
//! <https://docs.anthropic.com/en/api/messages> for protocol details.
//!
//! Same shape as `DeepSeekClient` so swapping providers is purely a
//! config change. M1 non-streaming only; streaming lands in M2 alongside
//! the streaming path on the DeepSeek side.

mod convert;
mod sse;
mod wire;

#[cfg(test)]
pub use convert::{build_messages_request, parse_messages_response};

use crate::classify::classify_http_error;
use crate::client::{LlmClient, ProviderCaps};
use crate::error::{LlmError, LlmResult};
use crate::request::MessageRequest;
use crate::response::MessageResponse;
use crate::stream::StreamEvent;
use crate::transport::{log_response_headers, wrap_byte_stream};
use async_trait::async_trait;
use futures::stream::BoxStream;
use std::time::Duration;
use tracing::{debug, info, warn};
use wire::{MessagesResponse, WireErrorEnvelope};

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const DEFAULT_MODEL: &str = "claude-sonnet-4-5";
const DEFAULT_API_VERSION: &str = "2023-06-01";
/// Per-read budget (max idle gap between SSE chunks). See the DeepSeek
/// module's note — the same reasoning applies: Claude extended-thinking
/// runs can stream for many minutes, and a `.timeout()` capping total
/// lifetime would mis-fire as a transport error mid-stream.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct AnthropicConfig {
    pub api_key: String,
    pub base_url: String,
    pub default_model: String,
    pub anthropic_version: String,
    pub request_timeout: Duration,
    /// Emit `cache_control: { type: "ephemeral" }` on the last system
    /// block and the last tool. Default `true` — long-lived chat
    /// sessions get a meaningful prefix-cache hit rate and pay
    /// significantly less per turn. Flip to `false` only for
    /// debugging or when the operator wants to compare cached vs
    /// uncached cost in isolation.
    pub enable_prompt_cache: bool,
}

impl AnthropicConfig {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: DEFAULT_BASE_URL.into(),
            default_model: DEFAULT_MODEL.into(),
            anthropic_version: DEFAULT_API_VERSION.into(),
            request_timeout: DEFAULT_TIMEOUT,
            enable_prompt_cache: true,
        }
    }

    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.default_model = model.into();
        self
    }

    pub fn with_anthropic_version(mut self, v: impl Into<String>) -> Self {
        self.anthropic_version = v.into();
        self
    }

    pub fn with_timeout(mut self, t: Duration) -> Self {
        self.request_timeout = t;
        self
    }

    pub fn with_prompt_cache(mut self, enabled: bool) -> Self {
        self.enable_prompt_cache = enabled;
        self
    }
}

#[derive(Clone)]
pub struct AnthropicClient {
    config: AnthropicConfig,
    http: reqwest::Client,
}

impl AnthropicClient {
    pub fn new(config: AnthropicConfig) -> LlmResult<Self> {
        if config.api_key.is_empty() {
            return Err(LlmError::InvalidConfig("api_key is empty".into()));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
            .read_timeout(config.request_timeout)
            .user_agent(concat!("snaca-llm/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self { config, http })
    }

    pub fn with_http_client(config: AnthropicConfig, http: reqwest::Client) -> Self {
        Self { config, http }
    }

    fn endpoint(&self) -> String {
        // Accept `base_url` with or without a trailing `/v1` so hosts can
        // store the same value the OpenAI-compatible SDKs expect.
        let base = self.config.base_url.trim_end_matches('/');
        if base.ends_with("/v1") {
            format!("{base}/messages")
        } else {
            format!("{base}/v1/messages")
        }
    }
}

#[async_trait]
impl LlmClient for AnthropicClient {
    fn provider_name(&self) -> &'static str {
        "anthropic"
    }

    fn model(&self) -> &str {
        &self.config.default_model
    }

    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            prompt_cache: true,
            thinking: true,
            streaming: true,
        }
    }

    async fn create_message(&self, mut request: MessageRequest) -> LlmResult<MessageResponse> {
        if request.model.is_empty() {
            request.model = self.config.default_model.clone();
        }
        let body = convert::build_messages_request_with_cache(
            &request,
            false,
            self.config.enable_prompt_cache,
        )?;
        debug!(
            provider = "anthropic",
            model = %body.model,
            messages = body.messages.len(),
            tools = body.tools.len(),
            "sending messages request"
        );

        let resp = self
            .http
            .post(self.endpoint())
            .header("x-api-key", &self.config.api_key)
            .header("anthropic-version", &self.config.anthropic_version)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let bytes = resp.bytes().await?;
        if !status.is_success() {
            let body_str = String::from_utf8_lossy(&bytes);
            let env = serde_json::from_slice::<WireErrorEnvelope>(&bytes).ok();
            return Err(classify_http_error(
                status.as_u16(),
                retry_after.as_deref(),
                env.as_ref().and_then(|e| e.error.error_type.as_deref()),
                None,
                env.as_ref().map(|e| e.error.message.as_str()),
                &body_str,
            ));
        }

        let parsed: MessagesResponse = serde_json::from_slice(&bytes).map_err(|e| {
            warn!(error = %e, body = %String::from_utf8_lossy(&bytes), "failed to parse messages response");
            LlmError::MalformedResponse(format!("failed to deserialise response: {e}"))
        })?;
        convert::parse_messages_response(parsed)
    }

    async fn create_message_stream(
        &self,
        mut request: MessageRequest,
    ) -> LlmResult<BoxStream<'static, LlmResult<StreamEvent>>> {
        if request.model.is_empty() {
            request.model = self.config.default_model.clone();
        }
        let body = convert::build_messages_request_with_cache(
            &request,
            true,
            self.config.enable_prompt_cache,
        )?;
        let endpoint = self.endpoint();
        info!(
            provider = "anthropic",
            endpoint = %endpoint,
            model = %body.model,
            messages = body.messages.len(),
            tools = body.tools.len(),
            "sending streaming messages request"
        );

        let resp = self
            .http
            .post(&endpoint)
            .header("x-api-key", &self.config.api_key)
            .header("anthropic-version", &self.config.anthropic_version)
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        info!(provider = "anthropic", status = %status, "streaming response headers received");
        if !status.is_success() {
            // Drain body so the user sees the provider's error envelope.
            let retry_after = resp
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let bytes = resp.bytes().await?;
            let body_str = String::from_utf8_lossy(&bytes);
            let env = serde_json::from_slice::<WireErrorEnvelope>(&bytes).ok();
            return Err(classify_http_error(
                status.as_u16(),
                retry_after.as_deref(),
                env.as_ref().and_then(|e| e.error.error_type.as_deref()),
                None,
                env.as_ref().map(|e| e.error.message.as_str()),
                &body_str,
            ));
        }

        log_response_headers("anthropic", &resp);
        let byte_stream = wrap_byte_stream("anthropic", resp.bytes_stream());
        Ok(sse::parse_byte_stream(byte_stream))
    }
}
