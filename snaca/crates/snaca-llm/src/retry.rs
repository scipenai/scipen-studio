//! `RetryingLlmClient` — jittered exponential backoff wrapper.
//!
//! Wraps any [`LlmClient`] so transient errors (`RateLimited`,
//! `ServerTransient`, `Transport`, `Timeout`, `StreamInterrupted`) are
//! retried with backoff before bubbling up to the engine. Non-retryable
//! errors (`ContextOverflow`, `AuthExpired`, malformed responses,
//! unknown provider envelopes, ...) pass through immediately so the
//! engine's specialised recovery paths can handle them.
//!
//! ## Streaming semantics
//!
//! `create_message_stream` retries **only** errors raised before the
//! stream is established (HTTP handshake, status check, envelope
//! parse). Once a [`BoxStream`] is returned to the caller, mid-stream
//! errors (`StreamInterrupted`) are passed through unchanged — already
//! received SSE deltas cannot be rolled back, and silently retrying
//! the whole turn would double-bill tokens and reset state the engine
//! has already committed to.
//!
//! ## Jitter
//!
//! Backoff = `min(base * 2^(attempt-1), max_delay)` plus uniform
//! jitter in `[0, jitter_ratio * backoff]`. The jitter prevents
//! thundering-herd retries when many sessions hit the same rate-limit
//! window. `RateLimited` errors with a populated `retry_after` skip
//! the formula and sleep the suggested duration (clamped to
//! `max_delay`).

use crate::client::{LlmClient, ProviderCaps};
use crate::error::LlmResult;
use crate::request::MessageRequest;
use crate::response::MessageResponse;
use crate::stream::StreamEvent;
use async_trait::async_trait;
use futures::stream::BoxStream;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{debug, warn};

#[derive(Debug, Clone)]
pub struct RetryConfig {
    /// Total attempts including the initial try. `max_attempts = 1`
    /// disables retry. The default value of `5` covers ~30s of total
    /// backoff worst-case (0.5 → 1 → 2 → 4 → 8 with jitter), which
    /// is the order of magnitude an IM-driven turn can absorb without
    /// the user noticing the wait.
    pub max_attempts: u32,
    /// Initial backoff before the second attempt.
    pub base_delay: Duration,
    /// Cap on the deterministic component of the backoff. A provider
    /// suggesting a longer `Retry-After` is honoured up to this cap.
    pub max_delay: Duration,
    /// Fraction of the deterministic delay used as the uniform jitter
    /// upper bound. `0.5` means "0–50% jitter on top of the base".
    pub jitter_ratio: f64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            base_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(30),
            jitter_ratio: 0.5,
        }
    }
}

impl RetryConfig {
    /// Disable retry — useful in tests where determinism matters more
    /// than transient-failure tolerance.
    pub fn disabled() -> Self {
        Self {
            max_attempts: 1,
            ..Self::default()
        }
    }

    fn backoff_for(&self, attempt: u32) -> Duration {
        // attempt is 1-indexed: the first sleep happens after attempt 1
        // failed, so we use 2^(attempt-1) and not 2^attempt.
        let exp = attempt.saturating_sub(1).min(20);
        let base_ms = self.base_delay.as_millis() as u64;
        let scaled = base_ms.saturating_mul(1u64 << exp);
        let capped = scaled.min(self.max_delay.as_millis() as u64);
        let jitter_window =
            ((capped as f64) * self.jitter_ratio).max(0.0).round() as u64;
        let jitter = if jitter_window == 0 {
            0
        } else {
            jitter_seed() % jitter_window
        };
        Duration::from_millis(capped + jitter)
    }
}

/// `RetryingLlmClient` wraps an inner `LlmClient` and reissues
/// transient failures per [`RetryConfig`].
#[derive(Clone)]
pub struct RetryingLlmClient<C> {
    inner: Arc<C>,
    config: RetryConfig,
}

impl<C: LlmClient> RetryingLlmClient<C> {
    pub fn new(inner: C, config: RetryConfig) -> Self {
        Self {
            inner: Arc::new(inner),
            config,
        }
    }

    pub fn from_arc(inner: Arc<C>, config: RetryConfig) -> Self {
        Self { inner, config }
    }

    pub fn config(&self) -> &RetryConfig {
        &self.config
    }

    pub fn inner(&self) -> &C {
        &self.inner
    }
}

#[async_trait]
impl<C: LlmClient + 'static> LlmClient for RetryingLlmClient<C> {
    fn provider_name(&self) -> &'static str {
        self.inner.provider_name()
    }

    fn model(&self) -> &str {
        self.inner.model()
    }

    fn capabilities(&self) -> ProviderCaps {
        self.inner.capabilities()
    }

    async fn create_message(&self, request: MessageRequest) -> LlmResult<MessageResponse> {
        let mut attempt: u32 = 1;
        loop {
            match self.inner.create_message(request.clone()).await {
                Ok(resp) => return Ok(resp),
                Err(err) if !err.is_retryable() => return Err(err),
                Err(err) if attempt >= self.config.max_attempts => {
                    warn!(
                        provider = self.inner.provider_name(),
                        attempt,
                        error = %err,
                        "create_message giving up after retries exhausted"
                    );
                    return Err(err);
                }
                Err(err) => {
                    let delay = err
                        .retry_after()
                        .map(|d| d.min(self.config.max_delay))
                        .unwrap_or_else(|| self.config.backoff_for(attempt));
                    debug!(
                        provider = self.inner.provider_name(),
                        attempt,
                        next_delay_ms = delay.as_millis() as u64,
                        error = %err,
                        "create_message retryable error; sleeping before retry"
                    );
                    tokio::time::sleep(delay).await;
                    attempt += 1;
                }
            }
        }
    }

    /// Streaming retry covers only **establishment** errors. The HTTP
    /// handshake / status / envelope-parse can be re-issued safely;
    /// once we return a stream, mid-flight failures
    /// (`StreamInterrupted`, etc.) pass through to the caller unchanged.
    async fn create_message_stream(
        &self,
        request: MessageRequest,
    ) -> LlmResult<BoxStream<'static, LlmResult<StreamEvent>>> {
        let mut attempt: u32 = 1;
        loop {
            match self.inner.create_message_stream(request.clone()).await {
                Ok(stream) => return Ok(stream),
                Err(err) if !err.is_retryable() => return Err(err),
                Err(err) if attempt >= self.config.max_attempts => {
                    warn!(
                        provider = self.inner.provider_name(),
                        attempt,
                        error = %err,
                        "create_message_stream giving up after retries exhausted"
                    );
                    return Err(err);
                }
                Err(err) => {
                    let delay = err
                        .retry_after()
                        .map(|d| d.min(self.config.max_delay))
                        .unwrap_or_else(|| self.config.backoff_for(attempt));
                    debug!(
                        provider = self.inner.provider_name(),
                        attempt,
                        next_delay_ms = delay.as_millis() as u64,
                        error = %err,
                        "create_message_stream pre-stream retryable error; sleeping"
                    );
                    tokio::time::sleep(delay).await;
                    attempt += 1;
                }
            }
        }
    }
}

/// Cheap, dependency-free jitter source. Pulls nanos from the wall
/// clock — uniform enough for backoff jitter (we just need to spread
/// retries across the next backoff window). Not suitable for anything
/// that needs unpredictability.
fn jitter_seed() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::LlmError;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn backoff_curve_grows_then_caps() {
        let cfg = RetryConfig {
            max_attempts: 10,
            base_delay: Duration::from_millis(100),
            max_delay: Duration::from_secs(5),
            jitter_ratio: 0.0, // deterministic for assertion
        };
        // attempt 1 → 100ms, 2 → 200, 3 → 400, 4 → 800, 5 → 1600, 6 → 3200, 7+ capped at 5000.
        assert_eq!(cfg.backoff_for(1), Duration::from_millis(100));
        assert_eq!(cfg.backoff_for(2), Duration::from_millis(200));
        assert_eq!(cfg.backoff_for(3), Duration::from_millis(400));
        assert_eq!(cfg.backoff_for(7), Duration::from_millis(5000));
        assert_eq!(cfg.backoff_for(50), Duration::from_millis(5000));
    }

    #[test]
    fn jitter_stays_within_ratio_bound() {
        let cfg = RetryConfig {
            max_attempts: 1,
            base_delay: Duration::from_millis(1000),
            max_delay: Duration::from_secs(10),
            jitter_ratio: 0.5,
        };
        // attempt 1: base 1000ms, jitter range [0, 500] → total [1000, 1500].
        for _ in 0..32 {
            let d = cfg.backoff_for(1).as_millis() as u64;
            assert!(
                (1000..=1500).contains(&d),
                "backoff out of jitter band: {d}"
            );
        }
    }

    // ------------- stub client for retry-policy tests -------------

    #[derive(Clone, Default)]
    struct CountingStub {
        calls: Arc<AtomicU32>,
        // We return the configured outcomes in order — each call
        // returns the next outcome until they're exhausted, then we
        // panic to force the test to assert exact call counts.
        outcomes: Arc<std::sync::Mutex<Vec<StubOutcome>>>,
    }

    enum StubOutcome {
        Err(LlmError),
        Ok,
    }

    impl CountingStub {
        fn new(outcomes: Vec<StubOutcome>) -> Self {
            Self {
                calls: Arc::new(AtomicU32::new(0)),
                outcomes: Arc::new(std::sync::Mutex::new(outcomes)),
            }
        }

        fn call_count(&self) -> u32 {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl LlmClient for CountingStub {
        fn provider_name(&self) -> &'static str {
            "stub"
        }
        fn model(&self) -> &str {
            "stub-model"
        }
        fn capabilities(&self) -> ProviderCaps {
            ProviderCaps::default()
        }
        async fn create_message(&self, _req: MessageRequest) -> LlmResult<MessageResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut q = self.outcomes.lock().unwrap();
            if q.is_empty() {
                panic!("stub exhausted; test expected fewer calls");
            }
            match q.remove(0) {
                StubOutcome::Ok => Ok(MessageResponse {
                    id: "stub".into(),
                    message: snaca_core::Message::assistant_text("ok"),
                    usage: snaca_core::Usage::default(),
                    stop_reason: crate::response::StopReason::EndTurn,
                }),
                StubOutcome::Err(e) => Err(e),
            }
        }
    }

    fn dummy_request() -> MessageRequest {
        MessageRequest::new("stub-model")
    }

    fn fast_retry() -> RetryConfig {
        RetryConfig {
            max_attempts: 4,
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(10),
            jitter_ratio: 0.0,
        }
    }

    #[tokio::test]
    async fn retries_server_transient_until_ok() {
        let stub = CountingStub::new(vec![
            StubOutcome::Err(LlmError::ServerTransient { status: 503 }),
            StubOutcome::Err(LlmError::ServerTransient { status: 503 }),
            StubOutcome::Ok,
        ]);
        let client = RetryingLlmClient::new(stub.clone(), fast_retry());
        let res = client.create_message(dummy_request()).await;
        assert!(res.is_ok());
        assert_eq!(stub.call_count(), 3);
    }

    #[tokio::test]
    async fn auth_expired_does_not_retry() {
        let stub = CountingStub::new(vec![StubOutcome::Err(LlmError::AuthExpired {
            status: 401,
        })]);
        let client = RetryingLlmClient::new(stub.clone(), fast_retry());
        let err = client.create_message(dummy_request()).await.unwrap_err();
        assert!(matches!(err, LlmError::AuthExpired { .. }));
        assert_eq!(stub.call_count(), 1);
    }

    #[tokio::test]
    async fn context_overflow_does_not_retry() {
        let stub = CountingStub::new(vec![StubOutcome::Err(LlmError::ContextOverflow)]);
        let client = RetryingLlmClient::new(stub.clone(), fast_retry());
        let err = client.create_message(dummy_request()).await.unwrap_err();
        assert!(matches!(err, LlmError::ContextOverflow));
        assert_eq!(stub.call_count(), 1);
    }

    #[tokio::test]
    async fn rate_limited_respects_retry_after() {
        let stub = CountingStub::new(vec![
            StubOutcome::Err(LlmError::RateLimited {
                retry_after: Some(Duration::from_millis(3)),
            }),
            StubOutcome::Ok,
        ]);
        let started = std::time::Instant::now();
        let client = RetryingLlmClient::new(stub.clone(), fast_retry());
        let _ = client.create_message(dummy_request()).await.unwrap();
        let elapsed = started.elapsed();
        // retry_after = 3ms, so total elapsed should be >= 3ms but
        // < max_delay of 10ms. Buffer-friendly assertion.
        assert!(
            elapsed >= Duration::from_millis(3),
            "did not honour retry_after: {elapsed:?}"
        );
        assert_eq!(stub.call_count(), 2);
    }

    #[tokio::test]
    async fn max_attempts_is_honoured() {
        let stub = CountingStub::new(vec![
            StubOutcome::Err(LlmError::ServerTransient { status: 500 }),
            StubOutcome::Err(LlmError::ServerTransient { status: 500 }),
            StubOutcome::Err(LlmError::ServerTransient { status: 500 }),
            StubOutcome::Err(LlmError::ServerTransient { status: 500 }),
        ]);
        let client = RetryingLlmClient::new(stub.clone(), fast_retry());
        let err = client.create_message(dummy_request()).await.unwrap_err();
        assert!(matches!(err, LlmError::ServerTransient { .. }));
        // max_attempts=4 → exactly 4 calls.
        assert_eq!(stub.call_count(), 4);
    }
}
