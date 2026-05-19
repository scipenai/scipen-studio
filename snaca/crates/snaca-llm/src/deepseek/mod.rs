//! DeepSeek LLM client (OpenAI-compatible, non-streaming in M1).
//!
//! Uses `reqwest` directly rather than `async-openai` so we control the
//! exact wire shape (e.g. propagating `reasoning_content`, `prompt_cache_*`)
//! without fighting BYOT plumbing.

mod convert;
mod sse;
mod wire;

#[cfg(test)]
pub use convert::{build_chat_request, parse_chat_response};

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
use tracing::{debug, warn};
use wire::{ChatResponse, WireErrorEnvelope};

const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
const DEFAULT_MODEL: &str = "deepseek-chat";
/// Max idle gap between SSE chunks (and total wait for a non-streaming
/// response body). Applied via `read_timeout`, not `timeout` — thinking
/// models legitimately stream `reasoning_content` for several minutes,
/// so bounding the total request lifetime would just cut them off
/// mid-generation (the original bug: "transport error: error decoding
/// response body" after 120 s with ~1 MB already streamed).
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
/// Hard cap on connect (DNS + TCP + TLS handshake). Independent of the
/// per-read budget so a slow server doesn't make us wait forever to
/// discover the network is down.
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct DeepSeekConfig {
    pub api_key: String,
    pub base_url: String,
    pub default_model: String,
    pub request_timeout: Duration,
}

impl DeepSeekConfig {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: DEFAULT_BASE_URL.into(),
            default_model: DEFAULT_MODEL.into(),
            request_timeout: DEFAULT_TIMEOUT,
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

    pub fn with_timeout(mut self, t: Duration) -> Self {
        self.request_timeout = t;
        self
    }
}

#[derive(Clone)]
pub struct DeepSeekClient {
    config: DeepSeekConfig,
    http: reqwest::Client,
}

impl DeepSeekClient {
    pub fn new(config: DeepSeekConfig) -> LlmResult<Self> {
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

    /// Construct a client pointing at an arbitrary base URL — used by tests
    /// against a mock HTTP server.
    pub fn with_http_client(config: DeepSeekConfig, http: reqwest::Client) -> Self {
        Self { config, http }
    }

    fn endpoint(&self) -> String {
        // Accept `base_url` with or without a trailing `/v1` — some hosts
        // (OpenAI Vercel-SDK conventions) store `https://api.example.com/v1`,
        // others store the bare host. Either way we land on the canonical
        // OpenAI-compatible `/v1/chat/completions` route.
        let base = self.config.base_url.trim_end_matches('/');
        if base.ends_with("/v1") {
            format!("{base}/chat/completions")
        } else {
            format!("{base}/v1/chat/completions")
        }
    }
}

#[async_trait]
impl LlmClient for DeepSeekClient {
    fn provider_name(&self) -> &'static str {
        "deepseek"
    }

    fn model(&self) -> &str {
        &self.config.default_model
    }

    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            prompt_cache: true, // DeepSeek context cache (free, automatic)
            thinking: true,     // R1 reasoning_content
            streaming: true,    // M2 — SSE via `data: {chunk}` ... `data: [DONE]`
        }
    }

    async fn create_message(&self, mut request: MessageRequest) -> LlmResult<MessageResponse> {
        if request.model.is_empty() {
            request.model = self.config.default_model.clone();
        }
        let body = convert::build_chat_request(&request, false)?;
        debug!(
            provider = "deepseek",
            model = %body.model,
            messages = body.messages.len(),
            tools = body.tools.len(),
            "sending chat completions request"
        );

        let resp = self
            .http
            .post(self.endpoint())
            .bearer_auth(&self.config.api_key)
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
                env.as_ref().and_then(|e| e.error.code.as_deref()),
                env.as_ref().map(|e| e.error.message.as_str()),
                &body_str,
            ));
        }

        let chat: ChatResponse = serde_json::from_slice(&bytes).map_err(|e| {
            warn!(error = %e, body = %String::from_utf8_lossy(&bytes), "failed to parse chat response");
            LlmError::MalformedResponse(format!("failed to deserialise response: {e}"))
        })?;
        convert::parse_chat_response(chat)
    }

    async fn create_message_stream(
        &self,
        mut request: MessageRequest,
    ) -> LlmResult<BoxStream<'static, LlmResult<StreamEvent>>> {
        if request.model.is_empty() {
            request.model = self.config.default_model.clone();
        }
        let body = convert::build_chat_request(&request, true)?;
        debug!(
            provider = "deepseek",
            model = %body.model,
            messages = body.messages.len(),
            tools = body.tools.len(),
            "sending streaming chat completions request"
        );

        let resp = self
            .http
            .post(self.endpoint())
            .bearer_auth(&self.config.api_key)
            .header("accept", "text/event-stream")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
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
                env.as_ref().and_then(|e| e.error.code.as_deref()),
                env.as_ref().map(|e| e.error.message.as_str()),
                &body_str,
            ));
        }

        log_response_headers("deepseek", &resp);
        let byte_stream = wrap_byte_stream("deepseek", resp.bytes_stream());
        Ok(sse::parse_byte_stream(byte_stream))
    }
}
