//! LLM provider helpers for SDK users.

use crate::{Result, SdkError};
use snaca_llm::{
    AnthropicClient, AnthropicConfig, DeepSeekClient, DeepSeekConfig, LlmClient, LlmError,
    RetryConfig, RetryingLlmClient,
};
use std::sync::Arc;
use std::time::Duration;

pub use snaca_llm::{
    ContentBlockStart, ContentDelta, MessageRequest, MessageResponse, ProviderCaps, StopReason,
    StreamEvent,
};

pub fn deepseek(api_key: impl Into<String>, model: impl Into<String>) -> Result<DeepSeekClient> {
    let config = DeepSeekConfig::new(api_key).with_model(model);
    Ok(DeepSeekClient::new(config)?)
}

pub fn deepseek_from_env(model: impl Into<String>) -> Result<DeepSeekClient> {
    let api_key = std::env::var("DEEPSEEK_API_KEY").map_err(|_| SdkError::MissingEnv {
        name: "DEEPSEEK_API_KEY",
    })?;
    deepseek(api_key, model)
}

pub fn anthropic(api_key: impl Into<String>, model: impl Into<String>) -> Result<AnthropicClient> {
    let config = AnthropicConfig::new(api_key).with_model(model);
    Ok(AnthropicClient::new(config)?)
}

pub fn anthropic_from_env(model: impl Into<String>) -> Result<AnthropicClient> {
    let api_key = std::env::var("ANTHROPIC_API_KEY").map_err(|_| SdkError::MissingEnv {
        name: "ANTHROPIC_API_KEY",
    })?;
    anthropic(api_key, model)
}

pub fn boxed(client: impl LlmClient + 'static) -> Arc<dyn LlmClient> {
    Arc::new(client)
}

pub fn invalid_config(message: impl Into<String>) -> LlmError {
    LlmError::InvalidConfig(message.into())
}

#[derive(Debug, Clone)]
pub struct LlmOptions {
    pub provider: LlmProvider,
    pub api_key: String,
    pub model: String,
    pub base_url: Option<String>,
    pub timeout: Option<Duration>,
    pub anthropic_version: Option<String>,
    pub retry: RetryConfig,
}

impl LlmOptions {
    pub fn new(
        provider: LlmProvider,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            provider,
            api_key: api_key.into(),
            model: model.into(),
            base_url: None,
            timeout: None,
            anthropic_version: None,
            retry: RetryConfig::default(),
        }
    }

    pub fn deepseek(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        Self::new(LlmProvider::DeepSeek, api_key, model)
    }

    pub fn anthropic(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        Self::new(LlmProvider::Anthropic, api_key, model)
    }

    pub fn base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn anthropic_version(mut self, version: impl Into<String>) -> Self {
        self.anthropic_version = Some(version.into());
        self
    }

    pub fn retry(mut self, retry: RetryConfig) -> Self {
        self.retry = retry;
        self
    }

    pub fn build(self) -> Result<Arc<dyn LlmClient>> {
        match self.provider {
            LlmProvider::DeepSeek => {
                let mut cfg = DeepSeekConfig::new(self.api_key).with_model(self.model);
                if let Some(url) = self.base_url {
                    cfg = cfg.with_base_url(url);
                }
                if let Some(timeout) = self.timeout {
                    cfg = cfg.with_timeout(timeout);
                }
                let raw = DeepSeekClient::new(cfg)?;
                Ok(Arc::new(RetryingLlmClient::new(raw, self.retry)))
            }
            LlmProvider::Anthropic => {
                let mut cfg = AnthropicConfig::new(self.api_key).with_model(self.model);
                if let Some(url) = self.base_url {
                    cfg = cfg.with_base_url(url);
                }
                if let Some(timeout) = self.timeout {
                    cfg = cfg.with_timeout(timeout);
                }
                if let Some(version) = self.anthropic_version {
                    cfg = cfg.with_anthropic_version(version);
                }
                let raw = AnthropicClient::new(cfg)?;
                Ok(Arc::new(RetryingLlmClient::new(raw, self.retry)))
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmProvider {
    DeepSeek,
    Anthropic,
}

impl std::str::FromStr for LlmProvider {
    type Err = LlmError;

    fn from_str(raw: &str) -> std::result::Result<Self, Self::Err> {
        match raw {
            "deepseek" => Ok(Self::DeepSeek),
            "anthropic" => Ok(Self::Anthropic),
            other => Err(LlmError::InvalidConfig(format!(
                "unsupported llm.provider: {other}"
            ))),
        }
    }
}

impl std::fmt::Display for LlmProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DeepSeek => f.write_str("deepseek"),
            Self::Anthropic => f.write_str("anthropic"),
        }
    }
}
