//! Engine-backed turn dispatcher. Replaces the P1 `llm::run_chat_turn`
//! for sessions that successfully wired an `snaca-engine::Engine` at
//! session open. Falls back to the legacy path is handled by the caller
//! (`handler::handle_chat_send`) when this module's prerequisites aren't
//! met.
//!
//! Flow:
//!   1. Build `TurnRequest`, pinning `message_id` to the session-level
//!      `turn_id` so `Engine::abort_turn` / `abort_thread` can target a
//!      specific in-flight turn from the editor protocol's `turn.cancel`.
//!   2. Run `engine.handle_turn_full(req, gate, listener)` — Engine owns
//!      user/assistant/tool message persistence and the LLM loop.
//!   3. On completion, emit one `turn.delta.kind=done` (or `error`) with
//!      `seq` continued from the listener's atomic counter so the host
//!      observes a total order.
//!   4. Release the session-level `inflight` slot via `end_turn`.

use crate::outbound::OutboundWriter;
use crate::session_manager::{SessionManager, STUDIO_TENANT_ID};
use crate::turn_listener::EditorTurnListener;
use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_editor_protocol::messages::turn::{DoneReason, TurnDeltaKind, TurnDeltaParams};
use snaca_editor_protocol::messages::usage::{UsageTotals, UsageUpdateParams};
use snaca_engine::{
    ApprovalGate, Engine, NoopApprovalGate, TurnEventListener, TurnRequest,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tracing::{info, warn};

/// Drive one chat turn through `Engine`. Spawned by `handle_chat_send`;
/// runs to completion regardless of host-side cancellation (the engine
/// cooperatively checks `abort_turn`).
#[allow(clippy::too_many_arguments)]
pub async fn run_engine_turn(
    engine: Arc<Engine>,
    outbound: Arc<OutboundWriter>,
    sessions: Arc<SessionManager>,
    session_id: String,
    project_id: String,
    thread_id: String,
    turn_id: String,
    user_text: String,
    gate: Arc<dyn ApprovalGate>,
) {
    info!(
        turn_id = %turn_id,
        thread_id = %thread_id,
        project = %project_id,
        "engine turn starting"
    );

    let seq = Arc::new(AtomicU64::new(0));
    let listener: Arc<dyn TurnEventListener> = Arc::new(EditorTurnListener::new(
        outbound.clone(),
        turn_id.clone(),
        seq.clone(),
    ));

    let req = TurnRequest {
        tenant_id: TenantId::new(STUDIO_TENANT_ID),
        project_id: ProjectId::from_raw(&project_id),
        thread_id: ThreadId::new(&thread_id),
        user_text,
        message_id: Some(turn_id.clone()),
    };

    let outcome = engine.handle_turn_full(req, gate, listener).await;

    // After listener returns, emit one final ordering anchor on the wire.
    // `seq` here is the post-listener value (atomic .load is the last
    // emitted + 1 thanks to fetch_add semantics).
    match &outcome {
        Ok(o) => {
            // Forward Engine's aggregated usage to the host so it can
            // render the per-turn token totals.
            let cumulative = UsageTotals {
                input_tokens: o.usage.input_tokens,
                output_tokens: o.usage.output_tokens,
                cached_input_tokens: o.usage.cache_read_input_tokens.unwrap_or(0),
                thinking_tokens: None,
                cost_usd: None,
            };
            let _ = outbound
                .emit_usage_update(UsageUpdateParams {
                    turn_id: turn_id.clone(),
                    cumulative,
                })
                .await;
            info!(
                turn_id = %turn_id,
                iterations = o.iterations,
                input_tokens = o.usage.input_tokens,
                output_tokens = o.usage.output_tokens,
                "engine turn completed"
            );
        }
        Err(e) => {
            warn!(turn_id = %turn_id, error = %e, "engine turn failed");
        }
    }

    let final_kind = match outcome {
        Ok(_) => TurnDeltaKind::Done {
            reason: DoneReason::Completed,
            cancelled: None,
        },
        Err(e) => TurnDeltaKind::Error {
            code: 0,
            message: e.to_string(),
            recoverable: false,
        },
    };
    let final_seq = seq.fetch_add(1, Ordering::SeqCst);
    let _ = outbound
        .emit_turn_delta(TurnDeltaParams {
            turn_id: turn_id.clone(),
            seq: final_seq,
            kind: final_kind,
        })
        .await;

    sessions.end_turn(&session_id, &turn_id).await;
}

/// Default gate used by Phase B — auto-approves everything. Phase C
/// swaps this for `EditorApprovalGate` that bridges to the host UI.
pub fn default_approval_gate() -> Arc<dyn ApprovalGate> {
    Arc::new(NoopApprovalGate)
}
