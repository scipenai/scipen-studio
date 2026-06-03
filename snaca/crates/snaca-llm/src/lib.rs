//! `snaca-llm` — LLM provider abstraction.
//!
//! Defines a provider-agnostic [`LlmClient`] trait, the canonical
//! request/response shapes, and concrete implementations.
//!
//! ## Layout
//! - [`error`]     — `LlmError` / `LlmResult`
//! - [`request`]   — `MessageRequest` + `ToolSchema` + `StopSequence`
//! - [`response`]  — `MessageResponse` + `StopReason`
//! - [`client`]    — `LlmClient` trait + `ProviderCaps`
//! - [`openai`]    — standard OpenAI Chat Completions client (recommended
//!                   default for "OpenAI 兼容" gateways)
//! - [`deepseek`]  — OpenAI-compatible client extended for DeepSeek-R1
//!                   `reasoning_content` + context cache hit/miss tokens
//! - [`anthropic`] — Anthropic Messages API client

pub mod anthropic;
pub mod classify;
pub mod client;
pub mod deepseek;
pub mod error;
pub mod openai;
pub mod request;
pub mod response;
pub mod retry;
pub mod stream;
pub(crate) mod transport;

pub use anthropic::AnthropicClient;
pub use classify::classify_http_error;
pub use client::{LlmClient, ProviderCaps};
pub use deepseek::DeepSeekClient;
pub use error::{LlmError, LlmResult};
pub use openai::OpenAIClient;
pub use request::{MessageRequest, SystemSegment, ToolSchema};
pub use response::{MessageResponse, StopReason};
pub use retry::{RetryConfig, RetryingLlmClient};
pub use stream::{
    synthesize_events, ContentBlockStart, ContentDelta, StreamAccumulator, StreamEvent,
};
