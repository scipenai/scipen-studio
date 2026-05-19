//! Engine-backed chat turn driver. Builds the listener / gate, runs
//! `engine.handle_turn_full`, then emits the trailing `done` / `error`
//! delta and releases the session inflight slot.

use crate::approval_gate::EditorApprovalGate;
use crate::outbound::OutboundWriter;
use crate::session_manager::{SessionManager, STUDIO_TENANT_ID};
use crate::turn_listener::EditorTurnListener;
use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_editor_protocol::messages::turn::{DoneReason, TurnDeltaKind, TurnDeltaParams};
use snaca_editor_protocol::messages::usage::{UsageTotals, UsageUpdateParams};
use snaca_editor_protocol::types::config::ApprovalMode;
use snaca_engine::{
    ApprovalDecision, ApprovalGate, DenyAllApprovalGate, Engine, NoopApprovalGate,
    TurnEventListener, TurnRequest,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

/// `tool_call_id` (or `proposal_id`) → decision channel. Shared between
/// the gate and the editor-protocol confirm handler.
pub type PendingApprovals =
    Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>;

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
    cancel: CancellationToken,
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

    // Engine owns its own inflight tokens via abort_turn. Race its
    // future against `cancel`; on cancellation also signal the engine
    // so in-flight tools abort.
    let outcome = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            info!(turn_id = %turn_id, "turn cancelled before engine completion");
            engine.abort_turn(&ThreadId::new(&thread_id), &turn_id);
            Err(snaca_engine::EngineError::Aborted)
        }
        o = engine.handle_turn_full(req, gate, listener) => o,
    };

    match &outcome {
        Ok(o) => {
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
        Err(snaca_engine::EngineError::Aborted) => TurnDeltaKind::Done {
            reason: DoneReason::Cancelled,
            cancelled: Some(true),
        },
        Err(snaca_engine::EngineError::Approval(snaca_engine::ApprovalError::Cancelled)) => {
            TurnDeltaKind::Done {
                reason: DoneReason::Cancelled,
                cancelled: Some(true),
            }
        }
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

#[allow(clippy::too_many_arguments)]
pub fn gate_for_mode(
    mode: ApprovalMode,
    outbound: Arc<OutboundWriter>,
    turn_id: String,
    pending_tool: PendingApprovals,
    pending_edit: PendingApprovals,
    workspace_root: std::path::PathBuf,
    cancel: CancellationToken,
) -> Arc<dyn ApprovalGate> {
    match mode {
        ApprovalMode::AutoAllow => Arc::new(NoopApprovalGate),
        ApprovalMode::AutoDeny => Arc::new(DenyAllApprovalGate),
        ApprovalMode::Interactive => Arc::new(EditorApprovalGate::new(
            outbound,
            turn_id,
            pending_tool,
            pending_edit,
            workspace_root,
            cancel,
        )),
    }
}
