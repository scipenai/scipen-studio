//! Composer PlanFirst driver. Two-stage:
//!   1. plan-only Engine (empty tools, plan-only system_prompt) streams
//!      its output as `turn.delta`, then we parse the fenced JSON, emit
//!      `plan.update awaiting=true`, and park on a oneshot waiting for
//!      `plan.confirm`.
//!   2. on Accept: hand off to the session's main Engine via
//!      `run_engine_turn` with a fresh turn_id; tools execute as usual.
//!
//! Cancellation is per-turn-id (P5 mechanism). Reject + Modify (treated
//! as Reject for now) emit Done(Cancelled) and skip the action stage.

use crate::outbound::OutboundWriter;
use crate::session::TurnKind;
use crate::session_manager::{SessionManager, STUDIO_TENANT_ID};
use crate::turn_engine::{run_engine_turn, PendingApprovals};
use crate::turn_listener::EditorTurnListener;
use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_editor_protocol::messages::composer::PlanDecision;
use snaca_editor_protocol::messages::plan::{
    PlanFile, PlanFileAction, PlanFileStatus, PlanUpdateParams,
};
use snaca_editor_protocol::messages::turn::{DoneReason, TurnDeltaKind, TurnDeltaParams};
use snaca_editor_protocol::types::config::SnacaConfig;
use snaca_engine::{Engine, EngineConfig, NoopApprovalGate, TurnRequest};
use snaca_llm::LlmClient;
use snaca_state::Database;
use snaca_tools_api::ToolRegistry;
use snaca_workspace::WorkspaceLayout;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

pub type PendingPlans = Arc<Mutex<HashMap<String, oneshot::Sender<PlanDecision>>>>;

const PLAN_SYSTEM_PROMPT: &str =
    "You are SciPen's task planner. The user gave you an instruction that may \
     involve modifying multiple files. Do NOT call any tools. Instead, reply \
     with ONLY a fenced JSON block describing the plan:\n\n\
     ```json\n\
     {\n\
       \"rationale\": \"one short paragraph explaining the approach\",\n\
       \"files\": [\n\
         {\"path\": \"src/foo.ts\", \"action\": \"modify\", \"summary\": \"why this file changes\"},\n\
         {\"path\": \"src/bar.ts\", \"action\": \"create\", \"summary\": \"...\"}\n\
       ]\n\
     }\n\
     ```\n\n\
     `action` is one of: create, modify, delete, rename. For rename add \
     `\"rename_to\": \"new/path\"`. Output nothing outside the fenced block.";

#[derive(serde::Deserialize)]
struct ParsedPlan {
    #[serde(default)]
    rationale: String,
    #[serde(default)]
    files: Vec<ParsedPlanFile>,
}

#[derive(serde::Deserialize)]
struct ParsedPlanFile {
    path: String,
    action: PlanFileAction,
    #[serde(default)]
    rename_to: Option<String>,
    #[serde(default)]
    summary: String,
}

pub struct ComposerPlanArgs {
    pub main_engine: Arc<Engine>,
    pub llm: Arc<dyn LlmClient>,
    pub snaca_config: SnacaConfig,
    pub db: Database,
    pub outbound: Arc<OutboundWriter>,
    pub sessions: Arc<SessionManager>,
    pub session_id: String,
    pub project_id: String,
    pub workspace_root: PathBuf,
    pub metadata_root: PathBuf,
    pub thread_id: String,
    pub plan_turn_id: String,
    pub user_text: String,
    pub plan_cancel: CancellationToken,
    pub pending_plans: PendingPlans,
    pub pending_turns: Arc<Mutex<HashMap<String, CancellationToken>>>,
    pub pending_approvals: PendingApprovals,
    pub pending_edit_approvals: PendingApprovals,
}

pub async fn run_composer_plan_first(args: ComposerPlanArgs) {
    let ComposerPlanArgs {
        main_engine,
        llm,
        snaca_config,
        db,
        outbound,
        sessions,
        session_id,
        project_id,
        workspace_root,
        metadata_root,
        thread_id,
        plan_turn_id,
        user_text,
        plan_cancel,
        pending_plans,
        pending_turns,
        pending_approvals,
        pending_edit_approvals,
    } = args;

    info!(turn_id = %plan_turn_id, "composer plan phase starting");

    let plan_seq = Arc::new(AtomicU64::new(0));
    let listener = Arc::new(EditorTurnListener::new(
        outbound.clone(),
        plan_turn_id.clone(),
        plan_seq.clone(),
    ));

    let plan_engine =
        match build_plan_engine(llm.clone(), &snaca_config, &metadata_root, &workspace_root, db) {
            Some(e) => e,
            None => {
                emit_done(&outbound, &plan_turn_id, &plan_seq, DoneReason::Error, false).await;
                sessions.end_turn(&session_id, &plan_turn_id).await;
                pending_turns.lock().unwrap().remove(&plan_turn_id);
                return;
            }
        };

    let req = TurnRequest {
        tenant_id: TenantId::new(STUDIO_TENANT_ID),
        project_id: ProjectId::from_raw(&project_id),
        thread_id: ThreadId::new(&thread_id),
        user_text: user_text.clone(),
        message_id: Some(plan_turn_id.clone()),
    };

    let outcome = tokio::select! {
        biased;
        _ = plan_cancel.cancelled() => {
            plan_engine.abort_turn(&ThreadId::new(&thread_id), &plan_turn_id);
            Err(snaca_engine::EngineError::Aborted)
        }
        o = plan_engine.handle_turn_full(req, Arc::new(NoopApprovalGate), listener) => o,
    };

    let assistant_text = match outcome {
        Ok(o) => o.assistant_text,
        Err(snaca_engine::EngineError::Aborted) => {
            emit_done(&outbound, &plan_turn_id, &plan_seq, DoneReason::Cancelled, true).await;
            sessions.end_turn(&session_id, &plan_turn_id).await;
            pending_turns.lock().unwrap().remove(&plan_turn_id);
            return;
        }
        Err(e) => {
            warn!(error = %e, "composer plan-phase engine failed");
            emit_error(&outbound, &plan_turn_id, &plan_seq, e.to_string()).await;
            sessions.end_turn(&session_id, &plan_turn_id).await;
            pending_turns.lock().unwrap().remove(&plan_turn_id);
            return;
        }
    };

    let parsed = parse_plan(&assistant_text);
    let plan_files: Vec<PlanFile> = parsed
        .files
        .into_iter()
        .map(|f| PlanFile {
            path: f.path,
            action: f.action,
            rename_to: f.rename_to,
            summary: f.summary,
            status: PlanFileStatus::Pending,
        })
        .collect();
    let rationale = if parsed.rationale.is_empty() {
        assistant_text.clone()
    } else {
        parsed.rationale
    };

    let (plan_tx, plan_rx) = oneshot::channel::<PlanDecision>();
    pending_plans
        .lock()
        .unwrap()
        .insert(plan_turn_id.clone(), plan_tx);

    let _ = outbound
        .emit_plan_update(PlanUpdateParams {
            turn_id: plan_turn_id.clone(),
            awaiting: true,
            files: plan_files.clone(),
            rationale,
        })
        .await;

    let decision = tokio::select! {
        biased;
        _ = plan_cancel.cancelled() => {
            pending_plans.lock().unwrap().remove(&plan_turn_id);
            PlanDecision::Reject
        }
        d = plan_rx => d.unwrap_or(PlanDecision::Reject),
    };

    emit_done(&outbound, &plan_turn_id, &plan_seq, DoneReason::Completed, false).await;
    sessions.end_turn(&session_id, &plan_turn_id).await;
    pending_turns.lock().unwrap().remove(&plan_turn_id);

    if !matches!(decision, PlanDecision::Accept) {
        info!(turn_id = %plan_turn_id, ?decision, "composer plan rejected");
        return;
    }

    let action_turn_id = match sessions
        .begin_turn(&session_id, &thread_id, TurnKind::Composer)
        .await
    {
        Ok(id) => id,
        Err(e) => {
            warn!(error = %e, "composer action begin_turn failed");
            return;
        }
    };

    let action_cancel = CancellationToken::new();
    pending_turns
        .lock()
        .unwrap()
        .insert(action_turn_id.clone(), action_cancel.clone());

    let gate = crate::turn_engine::gate_for_mode(
        snaca_config.approval_mode,
        outbound.clone(),
        action_turn_id.clone(),
        pending_approvals,
        pending_edit_approvals,
        workspace_root.clone(),
        action_cancel.clone(),
    );

    let action_text = format!(
        "[Approved plan; execute it now.]\n{}",
        plan_files
            .iter()
            .map(|f| format!("- {:?} {}: {}", f.action, f.path, f.summary))
            .collect::<Vec<_>>()
            .join("\n")
    );

    let action_turn_id_for_cleanup = action_turn_id.clone();
    run_engine_turn(
        main_engine,
        outbound,
        sessions,
        session_id,
        project_id,
        thread_id,
        action_turn_id,
        action_text,
        gate,
        action_cancel,
    )
    .await;
    pending_turns
        .lock()
        .unwrap()
        .remove(&action_turn_id_for_cleanup);
}

fn build_plan_engine(
    llm: Arc<dyn LlmClient>,
    snaca_config: &SnacaConfig,
    metadata_root: &Path,
    workspace_root: &Path,
    db: Database,
) -> Option<Arc<Engine>> {
    let layout = WorkspaceLayout::new(metadata_root.to_path_buf()).ok()?;
    let layout = layout.with_explicit_workspace(workspace_root.to_path_buf()).ok()?;
    let mut cfg = EngineConfig::default_for(snaca_config.llm.model.clone());
    cfg.system_prompt = PLAN_SYSTEM_PROMPT.to_string();
    cfg.max_iterations = 1;
    Some(Arc::new(Engine::new(
        llm,
        ToolRegistry::empty(),
        db,
        layout,
        cfg,
    )))
}

fn parse_plan(text: &str) -> ParsedPlan {
    let trimmed = text.trim();
    let stripped = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|s| s.trim_start())
        .unwrap_or(trimmed);
    let stripped = stripped
        .strip_suffix("```")
        .map(|s| s.trim_end())
        .unwrap_or(stripped);
    serde_json::from_str(stripped).unwrap_or_else(|e| {
        warn!(error = %e, "composer: LLM did not return valid plan JSON");
        ParsedPlan {
            rationale: String::new(),
            files: Vec::new(),
        }
    })
}

async fn emit_done(
    outbound: &OutboundWriter,
    turn_id: &str,
    seq: &Arc<AtomicU64>,
    reason: DoneReason,
    cancelled: bool,
) {
    let _ = outbound
        .emit_turn_delta(TurnDeltaParams {
            turn_id: turn_id.to_string(),
            seq: seq.fetch_add(1, Ordering::SeqCst),
            kind: TurnDeltaKind::Done {
                reason,
                cancelled: if cancelled { Some(true) } else { None },
            },
        })
        .await;
}

async fn emit_error(outbound: &OutboundWriter, turn_id: &str, seq: &Arc<AtomicU64>, msg: String) {
    let _ = outbound
        .emit_turn_delta(TurnDeltaParams {
            turn_id: turn_id.to_string(),
            seq: seq.fetch_add(1, Ordering::SeqCst),
            kind: TurnDeltaKind::Error {
                code: 0,
                message: msg,
                recoverable: false,
            },
        })
        .await;
}
