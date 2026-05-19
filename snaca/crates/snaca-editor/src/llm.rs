//! LLM client wiring + streaming → `turn.delta` conversion.
//!
//! P1 scope: a single chat round-trip — no tools, no turn loop, no history.
//! User message → provider → stream of text/thinking deltas → done. History
//! persistence and tool-calling arrive in later phases via the engine.

use crate::outbound::OutboundWriter;
use crate::session_manager::SessionManager;
use futures::StreamExt;
use snaca_core::{ContentBlock, Message, Role, Usage};
use snaca_editor_protocol::error::{ErrorCode, ProtocolError};
use snaca_editor_protocol::messages::turn::{DoneReason, TurnDeltaKind, TurnDeltaParams};
use snaca_editor_protocol::messages::usage::{UsageTotals, UsageUpdateParams};
use snaca_editor_protocol::types::config::{LlmProvider, SnacaConfig};
use snaca_llm::{
    anthropic::AnthropicConfig, deepseek::DeepSeekConfig, openai::OpenAIConfig, AnthropicClient,
    ContentDelta, DeepSeekClient, LlmClient, MessageRequest, OpenAIClient, StreamEvent,
};
use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, info, warn};

/// Build a provider-agnostic `LlmClient` from validated `SnacaConfig`.
///
/// The API key is resolved from the env var named in `llm.api_key_env`.
/// Missing or empty env → `ConfigInvalid`.
pub fn build_llm_client(cfg: &SnacaConfig) -> Result<Arc<dyn LlmClient>, ProtocolError> {
    let api_key = std::env::var(&cfg.llm.api_key_env).map_err(|_| {
        ProtocolError::new(
            ErrorCode::ConfigInvalid,
            format!(
                "env var `{}` is not set; host must inject the LLM key before init",
                cfg.llm.api_key_env
            ),
        )
    })?;
    if api_key.is_empty() {
        return Err(ProtocolError::new(
            ErrorCode::ConfigInvalid,
            format!("env var `{}` is empty", cfg.llm.api_key_env),
        ));
    }

    let timeout = cfg
        .llm
        .timeout_secs
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(120));

    let client: Arc<dyn LlmClient> = match cfg.llm.provider {
        LlmProvider::OpenaiCompatible => {
            let mut oc = OpenAIConfig::new(api_key)
                .with_model(cfg.llm.model.clone())
                .with_timeout(timeout);
            if let Some(url) = cfg.llm.base_url.clone() {
                oc = oc.with_base_url(url);
            }
            Arc::new(OpenAIClient::new(oc).map_err(|e| {
                ProtocolError::new(
                    ErrorCode::ConfigInvalid,
                    format!("OpenAI client init failed: {e}"),
                )
            })?)
        }
        LlmProvider::Deepseek => {
            let mut dc = DeepSeekConfig::new(api_key)
                .with_model(cfg.llm.model.clone())
                .with_timeout(timeout);
            if let Some(url) = cfg.llm.base_url.clone() {
                dc = dc.with_base_url(url);
            }
            Arc::new(DeepSeekClient::new(dc).map_err(|e| {
                ProtocolError::new(
                    ErrorCode::ConfigInvalid,
                    format!("DeepSeek client init failed: {e}"),
                )
            })?)
        }
        LlmProvider::Anthropic => {
            let mut ac = AnthropicConfig::new(api_key)
                .with_model(cfg.llm.model.clone())
                .with_timeout(timeout);
            if let Some(url) = cfg.llm.base_url.clone() {
                ac = ac.with_base_url(url);
            }
            Arc::new(AnthropicClient::new(ac).map_err(|e| {
                ProtocolError::new(
                    ErrorCode::ConfigInvalid,
                    format!("Anthropic client init failed: {e}"),
                )
            })?)
        }
    };

    info!(
        provider = ?cfg.llm.provider,
        model = %cfg.llm.model,
        thinking = client.capabilities().thinking,
        "LLM client constructed"
    );
    Ok(client)
}

/// Run one chat turn end-to-end against a real LLM.
///
/// `messages` is the full prior conversation history (already includes the
/// new user message at the tail). `system` is the assembled system prompt
/// (XML context, memory hints, etc. — `None` for bare chat).
///
/// On stream completion the accumulated assistant text is appended back to
/// the thread as a stored `Role::Assistant` message so subsequent turns see
/// it. Thinking content is **not** persisted (DeepSeek's `reasoning_content`
/// is intentionally a per-turn artifact, not part of multi-turn history).
pub async fn run_chat_turn(
    llm: Arc<dyn LlmClient>,
    outbound: Arc<OutboundWriter>,
    sessions: Arc<SessionManager>,
    session_id: String,
    thread_id: String,
    turn_id: String,
    system: Option<String>,
    messages: Vec<Message>,
) {
    let model = llm.model().to_string();
    let request = MessageRequest {
        model,
        system,
        messages,
        tools: Vec::new(),
        max_tokens: Some(4096),
        temperature: None,
        stop_sequences: Vec::new(),
    };

    let mut seq: u64 = 0;
    let mut usage: Option<Usage> = None;
    let mut assistant_text = String::new();

    let stream_result = llm.create_message_stream(request).await;
    let mut stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            warn!(error = %e, "LLM stream open failed");
            emit_terminal_error(&outbound, &turn_id, &mut seq, e.to_string()).await;
            sessions.end_turn(&session_id, &turn_id).await;
            return;
        }
    };

    while let Some(event) = stream.next().await {
        match event {
            Ok(StreamEvent::ContentBlockDelta { delta, .. }) => {
                // Capture text for history persistence (not thinking — DeepSeek's
                // reasoning_content is not echoed back in subsequent turns).
                if let ContentDelta::Text { text } = &delta {
                    assistant_text.push_str(text);
                }
                if let Some(kind) = delta_to_turn_kind(delta) {
                    let _ = outbound
                        .emit_turn_delta(TurnDeltaParams {
                            turn_id: turn_id.clone(),
                            seq,
                            kind,
                        })
                        .await;
                    seq += 1;
                }
            }
            Ok(StreamEvent::MessageDelta { usage: Some(u), .. }) => {
                usage = Some(u);
            }
            Ok(StreamEvent::Error { message }) => {
                warn!(error = %message, "LLM stream error event");
                emit_terminal_error(&outbound, &turn_id, &mut seq, message).await;
                sessions.end_turn(&session_id, &turn_id).await;
                return;
            }
            Ok(_) => {
                // MessageStart / ContentBlockStart / ContentBlockStop /
                // MessageStop don't surface individually.
            }
            Err(e) => {
                warn!(error = %e, "LLM stream transport error");
                emit_terminal_error(&outbound, &turn_id, &mut seq, e.to_string()).await;
                sessions.end_turn(&session_id, &turn_id).await;
                return;
            }
        }
    }

    // Persist the assistant turn (text only) before signalling done so
    // a follow-up chat.send sees it in `recent_messages`. Bind to
    // `turn_id` so the host UI can re-attach thinking trace / tool
    // calls / edit proposals from its own caches after a hydrate.
    if !assistant_text.is_empty() {
        let msg = Message::new(Role::Assistant, vec![ContentBlock::text(assistant_text)]);
        if let Err(e) = sessions
            .append_message(&session_id, &thread_id, msg, Some(turn_id.clone()))
            .await
        {
            warn!(error = %e, "failed to persist assistant message; history will gap");
        }
    } else {
        debug!("turn produced no text content; nothing to persist");
    }

    if let Some(u) = usage {
        let _ = outbound
            .emit_usage_update(UsageUpdateParams {
                turn_id: turn_id.clone(),
                cumulative: UsageTotals {
                    input_tokens: u.input_tokens,
                    output_tokens: u.output_tokens,
                    cached_input_tokens: u.cache_read_input_tokens.unwrap_or(0),
                    thinking_tokens: None,
                    cost_usd: None,
                },
            })
            .await;
    } else {
        debug!("LLM did not report usage for turn {turn_id}");
    }

    let _ = outbound
        .emit_turn_delta(TurnDeltaParams {
            turn_id: turn_id.clone(),
            seq,
            kind: TurnDeltaKind::Done {
                reason: DoneReason::Completed,
                cancelled: None,
            },
        })
        .await;
    sessions.end_turn(&session_id, &turn_id).await;
}

fn delta_to_turn_kind(delta: ContentDelta) -> Option<TurnDeltaKind> {
    match delta {
        ContentDelta::Text { text } => Some(TurnDeltaKind::Text { text }),
        ContentDelta::Thinking { text } => Some(TurnDeltaKind::Thinking { text }),
        // Tool input JSON deltas aren't surfaced in P1 — tool calls are
        // engine-runtime work that lands in a later phase.
        ContentDelta::ToolInputJson { .. } => None,
    }
}

async fn emit_terminal_error(
    outbound: &OutboundWriter,
    turn_id: &str,
    seq: &mut u64,
    message: String,
) {
    let _ = outbound
        .emit_turn_delta(TurnDeltaParams {
            turn_id: turn_id.to_string(),
            seq: *seq,
            kind: TurnDeltaKind::Error {
                code: ErrorCode::InternalError.as_i32(),
                message,
                recoverable: false,
            },
        })
        .await;
    *seq += 1;
    let _ = outbound
        .emit_turn_delta(TurnDeltaParams {
            turn_id: turn_id.to_string(),
            seq: *seq,
            kind: TurnDeltaKind::Done {
                reason: DoneReason::Error,
                cancelled: None,
            },
        })
        .await;
    *seq += 1;
}
