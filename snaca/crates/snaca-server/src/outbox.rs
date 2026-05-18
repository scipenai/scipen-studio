//! Persistent outbox for outbound IM deliveries.
//!
//! Replaces the fire-and-forget direct `plugin.send_message` / `update_message`
//! / `file_upload` calls in [`crate::dispatch`] with a durable write-then-try
//! pipeline. The motivation is concrete: when the Lark plugin process dies
//! mid-RPC, the dispatcher's outbound future fails with `Disconnected` /
//! `Timeout` / `SendClosed` and the assistant's reply (or generated file) is
//! lost — even though the supervisor respawns the plugin seconds later.
//!
//! Architecture:
//! 1. Caller invokes [`send_message`] / [`update_message`] / [`file_upload`].
//! 2. A row is INSERTed into `outbox` with `status='pending'`, `attempts=0`,
//!    and a freshly-generated UUID that doubles as the IM platform's
//!    idempotency key (Lark's `?uuid=…`).
//! 3. The same call **immediately** tries the underlying plugin RPC, so the
//!    happy-path latency matches the pre-outbox direct-call path.
//! 4. On success: mark the row `delivered`.
//! 5. On retryable error (`ChannelError::Disconnected | Timeout | SendClosed
//!    | Io`): reschedule with backoff; the per-plugin worker picks it up.
//! 6. On terminal error: mark `failed`. For `update_message` specifically,
//!    enqueue a fresh `send_message` row with the same `(chat_id, content)`
//!    so the user still receives the assistant's reply (Lark cards can 404
//!    when the original message is too old to PATCH; rather than swallow
//!    the reply, we degrade to a brand-new message).
//!
//! The worker ([`spawn_worker`]) is one tokio task per plugin name, started
//! by the plugin registry at process startup and *not* tied to a single
//! plugin-process lifetime — it survives respawns and acquires a fresh
//! `PluginHandle` from the registry each tick.

use anyhow::{Context, Result};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use snaca_channel_host::{ChannelError, ChannelResult, PluginHandle};
use snaca_channel_protocol::methods::{
    host_to_plugin, FileUploadParams, FileUploadResult, MessageSendParams, MessageSendResult,
    MessageUpdateParams,
};
use snaca_state::{Database, NewOutboxEntry, OutboxKind, OutboxRow};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::plugin_registry::PluginRegistry;

/// How long the worker sleeps between polling iterations.
const WORKER_TICK: Duration = Duration::from_secs(2);

/// Max pending rows the worker pulls per tick. Bounds in-memory work
/// per iteration; well above sustained outbound rates so backpressure
/// never originates here.
const BATCH: u32 = 16;

/// Maximum attempts (including the dispatcher's immediate try). After
/// this we mark the row `failed` and stop trying. Six attempts spread
/// over ~2 hours of backoff cover the realistic case where a plugin
/// process is being debugged manually for a stretch.
const MAX_ATTEMPTS: u32 = 6;

/// Backoff between attempts, indexed by `attempts` (the count *after*
/// the failing attempt is recorded). `attempts == 1` → look up
/// `BACKOFF_SCHEDULE[0]`, etc. Values past the last index clamp to the
/// last entry — the worker won't get there because `MAX_ATTEMPTS = 6`.
const BACKOFF_SCHEDULE: &[Duration] = &[
    Duration::from_secs(5),    // attempt 1 failed → retry in 5s
    Duration::from_secs(30),   // 2 → 30s
    Duration::from_secs(120),  // 3 → 2min
    Duration::from_secs(600),  // 4 → 10min
    Duration::from_secs(1800), // 5 → 30min
    Duration::from_secs(5400), // 6 → 90min (only matters if MAX_ATTEMPTS bumps)
];

/// Retention for delivered rows. The worker purges anything older — we
/// keep ~1 week so operators can audit the last few days of deliveries
/// without the table growing forever.
const RETENTION_DAYS: i64 = 7;

/// Retention for inbound dedup records. Lark's WS reconnect only
/// re-delivers the recent backlog; one day is comfortably past the
/// realistic replay window and keeps the table tiny.
const INBOUND_DEDUP_RETENTION_DAYS: i64 = 1;

/// How many ticks between purge passes. ~5 minutes at WORKER_TICK=2s is
/// plenty given how rarely outbound rows churn.
const PURGE_EVERY_TICKS: u32 = 150;

/// How far into the future to set a fresh row's `next_attempt_at` when the
/// caller will do an inline first-try right after enqueue. Reserves a
/// window where the worker won't claim the row, so the inline send and
/// the worker can't race each other into double-sending the same payload
/// to the plugin (which would, on slow Lark RTTs, produce duplicate IMs
/// despite the platform-side `?uuid` dedup — `create_cardkit_card` has no
/// uuid, so the first hop generates two distinct cards before the second
/// hop has a chance to dedup).
///
/// Cushion is generous enough to cover Lark's slow paths (token refresh +
/// CardKit create + IM send + an occasional retry) but bounded so a real
/// inline crash doesn't park the row too long. If the inline call truly
/// dies before marking delivered, the worker takes over after this many
/// seconds.
const FIRST_TRY_CUSHION: ChronoDuration = ChronoDuration::seconds(30);

fn first_try_next_attempt() -> DateTime<Utc> {
    Utc::now() + FIRST_TRY_CUSHION
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

/// Classify a plugin RPC error as retryable vs terminal.
///
/// Retryable = transport / process-liveness issues that will plausibly
/// resolve once the plugin respawns or its peer connection reconnects.
///
/// Terminal = JSON-RPC-level rejections from the plugin (`Plugin { code }`,
/// `InvalidParams`, `Handshake`, `Serde`) and codec/auth failures. These
/// won't get better by retrying with the same payload.
fn is_retryable(e: &ChannelError) -> bool {
    matches!(
        e,
        ChannelError::Disconnected
            | ChannelError::Timeout
            | ChannelError::SendClosed
            | ChannelError::Io(_)
    )
}

/// Compute the next attempt timestamp given how many attempts have been
/// recorded so far (i.e. `row.attempts` *after* incrementing for the
/// failing attempt we just made).
fn next_attempt_after(attempts_so_far: u32) -> DateTime<Utc> {
    let idx = (attempts_so_far.saturating_sub(1)) as usize;
    let dur = BACKOFF_SCHEDULE
        .get(idx)
        .copied()
        .unwrap_or_else(|| *BACKOFF_SCHEDULE.last().expect("BACKOFF_SCHEDULE non-empty"));
    Utc::now()
        + ChronoDuration::from_std(dur).unwrap_or_else(|_| ChronoDuration::seconds(5))
}

// ---------------------------------------------------------------------
// Caller-facing API — used by dispatch.rs.
// ---------------------------------------------------------------------

/// Enqueue and immediately attempt a `message.send`. Returns `Ok(())`
/// once the row is durably persisted, regardless of whether the
/// immediate try succeeded — the worker drives retries from the row.
///
/// `params.idempotency_key` is overwritten with the freshly-generated
/// row id; callers do not need to pre-populate it.
pub async fn send_message(
    db: &Database,
    plugin: &PluginHandle,
    mut params: MessageSendParams,
) -> Result<()> {
    let id = new_id();
    params.idempotency_key = Some(id.clone());
    let payload = serde_json::to_value(&params).context("serialise MessageSendParams")?;
    db.outbox_enqueue(&NewOutboxEntry {
        id: id.clone(),
        plugin: plugin.name().to_string(),
        tenant_id: params.tenant_id.clone(),
        chat_id: params.chat_id.clone(),
        kind: OutboxKind::SendMessage,
        payload,
        next_attempt_at: first_try_next_attempt(),
    })
    .await
    .context("outbox enqueue (send_message)")?;

    let res = plugin
        .call_method::<MessageSendParams, MessageSendResult>(host_to_plugin::MESSAGE_SEND, params)
        .await
        .map(|r| Some(r.message_id));
    handle_first_attempt(db, plugin, &id, OutboxKind::SendMessage, None, res).await;
    Ok(())
}

/// Enqueue and immediately attempt a `message.update`. On terminal
/// failure (e.g. Lark 404 because the original card has expired), a
/// fresh `send_message` row is enqueued in the same call so the
/// assistant's reply still reaches the user — at the cost of a possible
/// duplicate if the original update actually succeeded server-side but
/// the response was lost. We accept that trade rather than silently
/// drop the reply.
///
/// `fallback_chat_id` is the chat where a replacement send should land
/// if the update fails terminally; the underlying Lark `update_message`
/// API is keyed by message_id alone and doesn't accept a chat_id, but
/// we need one for the fallback path.
pub async fn update_message(
    db: &Database,
    plugin: &PluginHandle,
    fallback_chat_id: String,
    params: MessageUpdateParams,
) -> Result<()> {
    let id = new_id();
    let payload = serde_json::to_value(&params).context("serialise MessageUpdateParams")?;
    db.outbox_enqueue(&NewOutboxEntry {
        id: id.clone(),
        plugin: plugin.name().to_string(),
        tenant_id: params.tenant_id.clone(),
        chat_id: fallback_chat_id.clone(),
        kind: OutboxKind::UpdateMessage,
        payload,
        next_attempt_at: first_try_next_attempt(),
    })
    .await
    .context("outbox enqueue (update_message)")?;

    // We need the content for the potential fallback, so clone before move.
    let content_for_fallback = params.content.clone();
    let tenant_for_fallback = params.tenant_id.clone();
    let res = plugin
        .call_method::<MessageUpdateParams, serde_json::Value>(host_to_plugin::MESSAGE_UPDATE, params)
        .await
        .map(|_| None);
    handle_first_attempt(
        db,
        plugin,
        &id,
        OutboxKind::UpdateMessage,
        Some(UpdateFallback {
            chat_id: fallback_chat_id,
            tenant_id: tenant_for_fallback,
            content: content_for_fallback,
        }),
        res,
    )
    .await;
    Ok(())
}

/// Enqueue and immediately attempt a `file.upload`. Bytes are
/// base64-encoded and stored verbatim in the payload so retries don't
/// require the source file to still exist on disk.
pub async fn file_upload(
    db: &Database,
    plugin: &PluginHandle,
    tenant_id: String,
    chat_id: String,
    filename: String,
    mime_type: String,
    bytes: &[u8],
) -> Result<()> {
    let id = new_id();
    let params = FileUploadParams {
        tenant_id: tenant_id.clone(),
        chat_id: chat_id.clone(),
        filename,
        mime_type,
        bytes_base64: data_encoding::BASE64.encode(bytes),
        idempotency_key: Some(id.clone()),
    };
    let payload = serde_json::to_value(&params).context("serialise FileUploadParams")?;
    db.outbox_enqueue(&NewOutboxEntry {
        id: id.clone(),
        plugin: plugin.name().to_string(),
        tenant_id,
        chat_id,
        kind: OutboxKind::FileUpload,
        payload,
        next_attempt_at: first_try_next_attempt(),
    })
    .await
    .context("outbox enqueue (file_upload)")?;

    let res = plugin
        .call_method::<FileUploadParams, FileUploadResult>(host_to_plugin::FILE_UPLOAD, params)
        .await
        .map(|r| Some(r.message_id));
    handle_first_attempt(db, plugin, &id, OutboxKind::FileUpload, None, res).await;
    Ok(())
}

struct UpdateFallback {
    chat_id: String,
    tenant_id: String,
    content: String,
}

/// Apply the first-try outcome to the outbox row. Identical state
/// transitions to the worker's [`dispatch_row`] but skips the
/// MAX_ATTEMPTS check (attempts is still 0 after the first try).
async fn handle_first_attempt(
    db: &Database,
    plugin: &PluginHandle,
    id: &str,
    kind: OutboxKind,
    update_fallback: Option<UpdateFallback>,
    result: ChannelResult<Option<String>>,
) {
    match result {
        Ok(platform_id) => {
            if let Err(e) = db.outbox_mark_delivered(id, platform_id.as_deref()).await {
                warn!(plugin=%plugin.name(), outbox_id=%id, error=%e, "outbox: mark_delivered failed");
            } else {
                debug!(
                    plugin=%plugin.name(),
                    outbox_id=%id,
                    kind=kind.as_str(),
                    "outbox: delivered on first try"
                );
            }
        }
        Err(e) if is_retryable(&e) => {
            let next = next_attempt_after(1);
            if let Err(reschedule_err) = db.outbox_reschedule(id, &e.to_string(), next).await {
                warn!(plugin=%plugin.name(), outbox_id=%id, error=%reschedule_err, "outbox: reschedule failed");
            }
            info!(
                plugin=%plugin.name(),
                outbox_id=%id,
                kind=kind.as_str(),
                error=%e,
                "outbox: transient failure on first try; worker will retry"
            );
        }
        Err(e) => {
            warn!(
                plugin=%plugin.name(),
                outbox_id=%id,
                kind=kind.as_str(),
                error=%e,
                "outbox: terminal failure on first try; marking failed"
            );
            if let Err(fail_err) = db.outbox_mark_failed(id, &e.to_string()).await {
                warn!(plugin=%plugin.name(), outbox_id=%id, error=%fail_err, "outbox: mark_failed failed");
            }
            if let Some(fb) = update_fallback {
                enqueue_update_fallback_inner(db, plugin, id, fb).await;
            }
        }
    }
}

async fn enqueue_update_fallback_inner(
    db: &Database,
    plugin: &PluginHandle,
    original_id: &str,
    fb: UpdateFallback,
) {
    let fresh_id = new_id();
    let params = MessageSendParams {
        tenant_id: fb.tenant_id.clone(),
        chat_id: fb.chat_id.clone(),
        content: fb.content,
        format: None,
        reply_to: None,
        idempotency_key: Some(fresh_id.clone()),
    };
    let payload = match serde_json::to_value(&params) {
        Ok(v) => v,
        Err(e) => {
            warn!(plugin=%plugin.name(), error=%e, "outbox fallback: serialise failed");
            return;
        }
    };
    if let Err(e) = db
        .outbox_enqueue(&NewOutboxEntry {
            id: fresh_id.clone(),
            plugin: plugin.name().to_string(),
            tenant_id: fb.tenant_id,
            chat_id: fb.chat_id,
            kind: OutboxKind::SendMessage,
            payload,
            // No inline first-try here — worker is the only sender, so
            // there's nothing to race. Let it pick the row up on the
            // next tick.
            next_attempt_at: Utc::now(),
        })
        .await
    {
        warn!(plugin=%plugin.name(), error=%e, "outbox fallback: enqueue failed");
    } else {
        info!(
            plugin=%plugin.name(),
            original_outbox_id=%original_id,
            fallback_outbox_id=%fresh_id,
            "outbox: enqueued send_message fallback after update_message terminal failure"
        );
    }
}

// ---------------------------------------------------------------------
// Worker — one task per plugin name, started at registry startup.
// ---------------------------------------------------------------------

/// Spawn the outbox worker for `plugin_name`. The returned `JoinHandle`
/// resolves when `shutdown` is notified.
///
/// The worker's lifetime is *independent* of any specific plugin process
/// instance — it acquires a fresh `PluginHandle` from the registry on
/// each iteration, so a plugin crash + respawn is invisible to it
/// (besides one or two ticks of "handle unavailable" while the
/// supervisor's respawn worker runs).
pub fn spawn_worker(
    db: Database,
    registry: Arc<PluginRegistry>,
    plugin_name: String,
    shutdown: Arc<Notify>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        info!(plugin=%plugin_name, "outbox worker started");
        let mut tick: u32 = 0;
        loop {
            tokio::select! {
                _ = shutdown.notified() => {
                    info!(plugin=%plugin_name, "outbox worker shutting down");
                    return;
                }
                _ = tokio::time::sleep(WORKER_TICK) => {}
            }
            tick = tick.wrapping_add(1);
            if tick % PURGE_EVERY_TICKS == 0 {
                let outbox_cutoff = Utc::now() - ChronoDuration::days(RETENTION_DAYS);
                match db.outbox_purge_delivered_older_than(outbox_cutoff).await {
                    Ok(n) if n > 0 => {
                        info!(plugin=%plugin_name, purged=n, "outbox: purged old delivered rows")
                    }
                    Ok(_) => {}
                    Err(e) => {
                        warn!(plugin=%plugin_name, error=%e, "outbox: purge failed")
                    }
                }
                let dedup_cutoff =
                    Utc::now() - ChronoDuration::days(INBOUND_DEDUP_RETENTION_DAYS);
                match db.inbound_dedup_purge_older_than(dedup_cutoff).await {
                    Ok(n) if n > 0 => {
                        info!(plugin=%plugin_name, purged=n, "inbound dedup: purged old rows")
                    }
                    Ok(_) => {}
                    Err(e) => {
                        warn!(plugin=%plugin_name, error=%e, "inbound dedup: purge failed")
                    }
                }
            }

            let rows = match db.outbox_claim_pending(&plugin_name, BATCH).await {
                Ok(r) => r,
                Err(e) => {
                    warn!(plugin=%plugin_name, error=%e, "outbox: claim_pending failed");
                    continue;
                }
            };
            if rows.is_empty() {
                continue;
            }
            let handle = match registry.handle(&plugin_name).await {
                Some(h) => h,
                None => {
                    debug!(
                        plugin=%plugin_name,
                        count=rows.len(),
                        "outbox worker: plugin handle unavailable (respawning?); deferring"
                    );
                    continue;
                }
            };
            for row in rows {
                dispatch_row(&db, &handle, row).await;
            }
        }
    })
}

async fn dispatch_row(db: &Database, plugin: &PluginHandle, row: OutboxRow) {
    let attempts_before = row.attempts;
    let attempts_after = attempts_before + 1;
    let res: ChannelResult<Option<String>> = match row.kind {
        OutboxKind::SendMessage => {
            let params: MessageSendParams = match serde_json::from_value(row.payload.clone()) {
                Ok(p) => p,
                Err(e) => {
                    warn!(outbox_id=%row.id, error=%e, "outbox: malformed send_message payload");
                    let _ = db
                        .outbox_mark_failed(&row.id, &format!("payload deserialise: {e}"))
                        .await;
                    return;
                }
            };
            plugin
                .call_method::<MessageSendParams, MessageSendResult>(
                    host_to_plugin::MESSAGE_SEND,
                    params,
                )
                .await
                .map(|r| Some(r.message_id))
        }
        OutboxKind::UpdateMessage => {
            let params: MessageUpdateParams = match serde_json::from_value(row.payload.clone()) {
                Ok(p) => p,
                Err(e) => {
                    warn!(outbox_id=%row.id, error=%e, "outbox: malformed update_message payload");
                    let _ = db
                        .outbox_mark_failed(&row.id, &format!("payload deserialise: {e}"))
                        .await;
                    return;
                }
            };
            plugin
                .call_method::<MessageUpdateParams, serde_json::Value>(
                    host_to_plugin::MESSAGE_UPDATE,
                    params,
                )
                .await
                .map(|_| None)
        }
        OutboxKind::FileUpload => {
            let params: FileUploadParams = match serde_json::from_value(row.payload.clone()) {
                Ok(p) => p,
                Err(e) => {
                    warn!(outbox_id=%row.id, error=%e, "outbox: malformed file_upload payload");
                    let _ = db
                        .outbox_mark_failed(&row.id, &format!("payload deserialise: {e}"))
                        .await;
                    return;
                }
            };
            plugin
                .call_method::<FileUploadParams, FileUploadResult>(
                    host_to_plugin::FILE_UPLOAD,
                    params,
                )
                .await
                .map(|r| Some(r.message_id))
        }
    };

    match res {
        Ok(platform_id) => {
            if let Err(e) = db.outbox_mark_delivered(&row.id, platform_id.as_deref()).await {
                warn!(outbox_id=%row.id, error=%e, "outbox: mark_delivered failed");
            } else {
                info!(
                    plugin=%plugin.name(),
                    outbox_id=%row.id,
                    attempts=attempts_after,
                    kind=row.kind.as_str(),
                    "outbox: delivered after retry"
                );
            }
        }
        Err(e) if is_retryable(&e) && attempts_after < MAX_ATTEMPTS => {
            let next = next_attempt_after(attempts_after);
            if let Err(reschedule_err) = db.outbox_reschedule(&row.id, &e.to_string(), next).await
            {
                warn!(outbox_id=%row.id, error=%reschedule_err, "outbox: reschedule failed");
            } else {
                debug!(
                    plugin=%plugin.name(),
                    outbox_id=%row.id,
                    attempts=attempts_after,
                    next=%next,
                    error=%e,
                    "outbox: retry scheduled"
                );
            }
        }
        Err(e) => {
            warn!(
                plugin=%plugin.name(),
                outbox_id=%row.id,
                attempts=attempts_after,
                kind=row.kind.as_str(),
                error=%e,
                "outbox: terminal — marking failed"
            );
            let _ = db.outbox_mark_failed(&row.id, &e.to_string()).await;
            if matches!(row.kind, OutboxKind::UpdateMessage) {
                // Worker-side fallback: same logic as the first-try path,
                // but we reconstruct UpdateFallback from the row + payload.
                if let Ok(upd) =
                    serde_json::from_value::<MessageUpdateParams>(row.payload.clone())
                {
                    enqueue_update_fallback_inner(
                        db,
                        plugin,
                        &row.id,
                        UpdateFallback {
                            chat_id: row.chat_id.clone(),
                            tenant_id: upd.tenant_id,
                            content: upd.content,
                        },
                    )
                    .await;
                }
            }
        }
    }
}
