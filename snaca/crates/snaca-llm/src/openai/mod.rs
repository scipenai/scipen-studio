//! Standard OpenAI Chat Completions client.
//!
//! Companion to [`crate::deepseek`] — both speak the OpenAI-compatible
//! `/v1/chat/completions` wire format, but this one omits DeepSeek-specific
//! extensions (`reasoning_content`, `prompt_cache_hit/miss_tokens`) so the
//! request/response shape stays clean for vanilla OpenAI servers and
//! generic OpenAI-compatible gateways (Anthropic-via-OpenAI proxy,
//! Together, Groq, Ollama, vLLM, …). Pick this when the Studio user
//! selects the "OpenAI 兼容" provider.

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

const DEFAULT_BASE_URL: &str = "https://api.openai.com";
const DEFAULT_MODEL: &str = "gpt-4o-mini";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct OpenAIConfig {
    pub api_key: String,
    pub base_url: String,
    pub default_model: String,
    pub request_timeout: Duration,
}

impl OpenAIConfig {
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
pub struct OpenAIClient {
    config: OpenAIConfig,
    http: reqwest::Client,
}

impl OpenAIClient {
    pub fn new(config: OpenAIConfig) -> LlmResult<Self> {
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

    pub fn with_http_client(config: OpenAIConfig, http: reqwest::Client) -> Self {
        Self { config, http }
    }

    fn endpoint(&self) -> String {
        // Studio's UI stores apiHost with a trailing /v1 (Vercel SDK
        // convention); bare hosts are common in third-party gateways.
        // Either way the call should land on /v1/chat/completions.
        let base = self.config.base_url.trim_end_matches('/');
        if base.ends_with("/v1") {
            format!("{base}/chat/completions")
        } else {
            format!("{base}/v1/chat/completions")
        }
    }
}

#[async_trait]
impl LlmClient for OpenAIClient {
    fn provider_name(&self) -> &'static str {
        "openai"
    }

    fn model(&self) -> &str {
        &self.config.default_model
    }

    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            // OpenAI's `prompt_tokens_details.cached_tokens` differs from
            // DeepSeek's `prompt_cache_hit_tokens`; advertised as unsupported
            // until a dedicated mapper lands.
            prompt_cache: false,
            // Vanilla chat-completions models do not stream chain-of-thought.
            thinking: false,
            streaming: true,
        }
    }

    async fn create_message(&self, mut request: MessageRequest) -> LlmResult<MessageResponse> {
        if request.model.is_empty() {
            request.model = self.config.default_model.clone();
        }
        let body = convert::build_chat_request(&request, false)?;
        debug!(
            provider = "openai",
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
            provider = "openai",
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

        log_response_headers("openai", &resp);
        let byte_stream = wrap_byte_stream("openai", resp.bytes_stream());
        Ok(sse::parse_byte_stream(byte_stream))
    }
}
