//! Proactive task scheduler.
//!
//! Polls `scheduled_tasks` for due rows, hands each to a
//! [`FireHandler`] for delivery, then reschedules (recurring) or
//! disables (one-shot) the row. The handler is the seam where the
//! synthetic-message firing actually injects into the IM dispatch
//! pipeline — production wires [`PluginFireHandler`], which builds a
//! `MessageReceivedParams` from the row and pushes it onto the
//! matching plugin's inbound channel so the dispatcher handles it
//! exactly like a real user message (auto-project resolution,
//! engine turn, outbox delivery — all reused).
//!
//! Why a trait rather than baking the fire path in: tests need a
//! no-op handler that just records what fired, and the dispatcher
//! wiring isn't reachable from `snaca-state`-only test setups. The
//! trait keeps the polling math testable in isolation.
//!
//! Cron expressions are *not* parsed here — `interval_secs` is the
//! only recurrence form. The DB row stores the wall-clock
//! `next_fire_at`; the firing path adds `interval_secs` (when set)
//! to compute the next slot. Callers wanting "every Monday 9am"
//! shape it as `(initial_next_fire_at = next-monday-9am,
//! interval_secs = 7*24*3600)`. Standard cron parsing is a
//! follow-up; this MVP keeps the scheduler dependency-free.
//!
//! Drift policy: when a tick discovers the task is overdue by more
//! than one interval (e.g. the server was offline for an hour and
//! a 5-minute task missed 12 fires), we fire *once* and advance
//! `next_fire_at` to the next slot *after* the current wall clock,
//! NOT to the original schedule. Skipping the missed fires is the
//! lesser evil — replaying every missed fire on startup would
//! drown the user in noise from a momentary outage. Operators who
//! need every fire delivered can configure a smaller interval and
//! treat consecutive duplicates as idempotent on the receiving end.

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use snaca_state::{Database, ScheduledTask};
use std::sync::Arc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

/// Action taken when a scheduled task fires. Implementations live in
/// the server wiring layer — typically delivering the synthetic
/// message into the matching plugin's inbound channel so the existing
/// dispatcher pipeline handles it.
///
/// Returning `Err` doesn't disable the task — the scheduler logs and
/// proceeds to reschedule. The task fires again at its next slot.
/// (Repeated failures aren't auto-paused yet; that's a follow-up.)
#[async_trait]
pub trait FireHandler: Send + Sync + 'static {
    async fn fire(&self, task: &ScheduledTask) -> Result<()>;
}

/// Drop-in test/null handler — records every fire in a Vec the test
/// can inspect, takes no other action. Useful for asserting scheduler
/// math without standing up the full dispatcher wiring.
#[derive(Default)]
pub struct LoggingFireHandler {
    pub fired: tokio::sync::Mutex<Vec<ScheduledTask>>,
}

#[async_trait]
impl FireHandler for LoggingFireHandler {
    async fn fire(&self, task: &ScheduledTask) -> Result<()> {
        info!(
            id = task.id.as_str(),
            chat = task.chat_id.as_str(),
            prompt = task.prompt.as_str(),
            "scheduled task fired (logging handler)"
        );
        self.fired.lock().await.push(task.clone());
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct SchedulerConfig {
    /// Wall-clock period between poll passes. Trade-off: lower =
    /// tighter fire timing but more DB pressure; higher = cleaner
    /// load but a fire's actual time can lag its `next_fire_at` by
    /// up to one tick. Default 30s — fine for human-scale reminders;
    /// drop to 5s for sub-minute scheduling.
    pub tick_period: std::time::Duration,
    /// Max rows the poll claims per tick. Bounds the burst on
    /// recovery from an outage — if 200 tasks are simultaneously
    /// overdue we don't try to fire them all at once.
    pub batch_size: u32,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            tick_period: std::time::Duration::from_secs(30),
            batch_size: 50,
        }
    }
}

/// Spawn the scheduler's poll loop. The returned `JoinHandle` runs
/// until `cancel` fires. Each tick: claim due rows → fire each in
/// order → reschedule (or disable for one-shot).
pub fn spawn_scheduler<H: FireHandler>(
    db: Database,
    handler: Arc<H>,
    cfg: SchedulerConfig,
    cancel: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        info!(
            tick_period_secs = cfg.tick_period.as_secs(),
            batch_size = cfg.batch_size,
            "scheduler poll loop started"
        );
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    info!("scheduler shutting down");
                    return;
                }
                _ = tokio::time::sleep(cfg.tick_period) => {
                    if let Err(e) = run_tick(&db, handler.as_ref(), cfg.batch_size).await {
                        error!(error = %e, "scheduler tick failed; continuing");
                    }
                }
            }
        }
    })
}

/// One poll pass. Public so tests can drive the math without spawning
/// the loop. Visible behaviour matches the loop: claim due rows, fire
/// each, advance `next_fire_at` (or disable).
pub async fn run_tick<H: FireHandler>(
    db: &Database,
    handler: &H,
    batch_size: u32,
) -> Result<()> {
    let now = Utc::now();
    let due = db.list_due_scheduled_tasks(now, batch_size).await?;
    if due.is_empty() {
        debug!("scheduler tick: no due tasks");
        return Ok(());
    }
    debug!(count = due.len(), "scheduler tick: firing due tasks");
    for task in due {
        // Fire first, then reschedule. If fire errors we still
        // reschedule — otherwise a flaky handler pins the row at
        // `next_fire_at <= now` forever and chokes the batch on
        // every tick.
        if let Err(e) = handler.fire(&task).await {
            warn!(
                id = task.id.as_str(),
                chat = task.chat_id.as_str(),
                error = %e,
                "scheduled fire handler errored; rescheduling anyway"
            );
        }
        let next = advance_next_fire(&task, now);
        if let Err(e) = db.reschedule_task(&task.id, now, next).await {
            error!(
                id = task.id.as_str(),
                error = %e,
                "failed to reschedule task; will retry next tick (potential duplicate fire)"
            );
        }
    }
    Ok(())
}

/// Compute the next `next_fire_at`. `None` for one-shot (the DB
/// layer disables the row). For recurring tasks: add `interval_secs`
/// to the wall-clock `now`, skipping over any missed slots so we
/// don't replay a backlog on recovery.
fn advance_next_fire(task: &ScheduledTask, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let secs = task.interval_secs?;
    if secs <= 0 {
        // Defensive: nonsensical interval treated as one-shot rather
        // than busy-looping the scheduler.
        warn!(
            id = task.id.as_str(),
            interval_secs = secs,
            "non-positive interval; treating as one-shot"
        );
        return None;
    }
    let interval = Duration::seconds(secs);
    // Forward-only walk from the original `next_fire_at` until we're
    // strictly in the future. Bounded by a generous safety cap so a
    // misconfigured row with a tiny interval and an old next_fire_at
    // doesn't spin the CPU.
    let mut next = task.next_fire_at;
    let mut hops = 0u32;
    while next <= now && hops < 100_000 {
        next += interval;
        hops += 1;
    }
    if next <= now {
        // Safety bail — fall back to `now + interval`.
        next = now + interval;
    }
    Some(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, TenantId};
    use snaca_state::{Database, NewScheduledTask};

    fn task_template(
        chat: &str,
        prompt: &str,
        interval_secs: Option<i64>,
        next_fire_at: DateTime<Utc>,
    ) -> NewScheduledTask {
        NewScheduledTask {
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("p"),
            chat_id: chat.into(),
            plugin: "lark".into(),
            prompt: prompt.into(),
            interval_secs,
            next_fire_at,
        }
    }

    #[tokio::test]
    async fn run_tick_fires_due_one_shot_and_disables_it() {
        let db = Database::open_in_memory().await.unwrap();
        let handler = Arc::new(LoggingFireHandler::default());
        let now = Utc::now();
        let t = db
            .schedule_task(&task_template(
                "chat_a",
                "hi",
                None,
                now - Duration::seconds(5),
            ))
            .await
            .unwrap();

        run_tick(&db, handler.as_ref(), 10).await.unwrap();

        let fired = handler.fired.lock().await.clone();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].id, t.id);
        // One-shot → disabled, not due again.
        let still_due = db
            .list_due_scheduled_tasks(now + Duration::hours(1), 10)
            .await
            .unwrap();
        assert!(still_due.iter().all(|r| r.id != t.id));
    }

    #[tokio::test]
    async fn run_tick_advances_recurring_to_next_slot() {
        let db = Database::open_in_memory().await.unwrap();
        let handler = Arc::new(LoggingFireHandler::default());
        let t0 = Utc::now() - Duration::seconds(10);
        let t = db
            .schedule_task(&task_template("chat_r", "tick", Some(60), t0))
            .await
            .unwrap();
        // First tick fires.
        run_tick(&db, handler.as_ref(), 10).await.unwrap();
        assert_eq!(handler.fired.lock().await.len(), 1);

        // Immediate second tick should NOT fire it again — next_fire_at
        // was advanced into the future.
        run_tick(&db, handler.as_ref(), 10).await.unwrap();
        assert_eq!(handler.fired.lock().await.len(), 1);

        // The row is still enabled with a future fire time.
        let listed = db
            .list_scheduled_tasks_for_chat(&TenantId::new("t"), "chat_r")
            .await
            .unwrap();
        let row = listed.iter().find(|r| r.id == t.id).unwrap();
        assert!(row.enabled);
        assert!(row.next_fire_at > Utc::now());
        assert!(row.last_fired_at.is_some());
    }

    /// Recovery from an outage: a 5-minute task that was overdue
    /// by an hour fires *once*, not 12 times. `next_fire_at`
    /// advances past `now`.
    #[tokio::test]
    async fn recovery_skips_missed_slots() {
        let db = Database::open_in_memory().await.unwrap();
        let handler = Arc::new(LoggingFireHandler::default());
        let t0 = Utc::now() - Duration::hours(1);
        let t = db
            .schedule_task(&task_template("chat_x", "tick", Some(300), t0))
            .await
            .unwrap();
        run_tick(&db, handler.as_ref(), 10).await.unwrap();
        assert_eq!(
            handler.fired.lock().await.len(),
            1,
            "must fire exactly once on recovery, not the 12 missed slots"
        );
        let listed = db
            .list_scheduled_tasks_for_chat(&TenantId::new("t"), "chat_x")
            .await
            .unwrap();
        let row = listed.iter().find(|r| r.id == t.id).unwrap();
        assert!(
            row.next_fire_at > Utc::now(),
            "next_fire_at must skip past missed slots"
        );
    }

    /// A failing handler doesn't pin the task forever — the row is
    /// still rescheduled / disabled despite the error.
    struct FailingHandler;
    #[async_trait]
    impl FireHandler for FailingHandler {
        async fn fire(&self, _task: &ScheduledTask) -> Result<()> {
            Err(anyhow::anyhow!("handler kaboom"))
        }
    }

    #[tokio::test]
    async fn handler_error_still_advances_next_fire() {
        let db = Database::open_in_memory().await.unwrap();
        let handler = Arc::new(FailingHandler);
        let now = Utc::now();
        db.schedule_task(&task_template(
            "chat_e",
            "p",
            None,
            now - Duration::seconds(5),
        ))
        .await
        .unwrap();

        run_tick(&db, handler.as_ref(), 10).await.unwrap();

        let still_due = db
            .list_due_scheduled_tasks(now + Duration::hours(1), 10)
            .await
            .unwrap();
        assert!(
            still_due.is_empty(),
            "row must be disabled even after handler failure"
        );
    }

    #[tokio::test]
    async fn future_tasks_dont_fire() {
        let db = Database::open_in_memory().await.unwrap();
        let handler = Arc::new(LoggingFireHandler::default());
        let now = Utc::now();
        db.schedule_task(&task_template(
            "chat_f",
            "later",
            None,
            now + Duration::hours(1),
        ))
        .await
        .unwrap();
        run_tick(&db, handler.as_ref(), 10).await.unwrap();
        assert!(handler.fired.lock().await.is_empty());
    }
}
