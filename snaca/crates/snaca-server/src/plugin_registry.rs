//! `PluginRegistry` — owns the running plugin handles + their dispatcher
//! tasks, and exposes hot-reload via the admin HTTP API.
//!
//! ## Why a dedicated registry
//!
//! `Runtime::build` originally held a `Vec<PluginHandle>` and a parallel
//! `Vec<JoinHandle>`. That worked for startup + shutdown but didn't model
//! mid-life mutations: reloading a plugin requires shutting down the old
//! `PluginHandle`, aborting its dispatcher task, and respawning both with
//! the same config — three coupled state changes that have to land
//! atomically. Pulling them into one struct keeps the invariant local.
//!
//! ## Reload semantics
//!
//! On reload:
//! 1. Remove the slot from the map. The old handle becomes orphaned to
//!    later operations — ongoing in-flight RPCs are best-effort cancelled.
//! 2. Send `shutdown` to the plugin (with a short timeout). If the plugin
//!    is already dead, the call returns an error which we log + ignore.
//! 3. Abort the dispatcher task. The dispatcher's inbound mpsc closes
//!    when the plugin's stdio closes, so this is mostly a safety net.
//! 4. Spawn a fresh `PluginHandle` from the same `PluginConfig`. New
//!    inbound stream → new dispatcher task.
//! 5. Insert the fresh slot back into the map.
//!
//! Steps 2–5 hold no lock — concurrent reloads on different plugins
//! proceed in parallel; concurrent reloads of the *same* plugin are
//! serialised because step 1 takes the slot, leaving step 5 nothing to
//! collide with.

use crate::dispatch;
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use serde::Serialize;
use snaca_channel_host::{PluginConfig, PluginHandle};
use snaca_core::TenantId;
use snaca_engine::Engine;
use snaca_state::Database;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};
use tokio::task::{AbortHandle, JoinHandle};
use tracing::{error, info, warn};

/// Captures everything the `dispatch::dispatch_loop` needs that is *not*
/// the plugin handle itself. Cloned per plugin, threaded through reloads.
#[derive(Clone)]
pub struct PluginSpawner {
    pub engine: Arc<Engine>,
    pub db: Database,
    pub tenant_id: TenantId,
    pub typing_interval: Duration,
}

impl PluginSpawner {
    /// Spawn the dispatcher task for an already-spawned plugin. Returns
    /// the `JoinHandle` so the registry can abort it on reload/shutdown.
    pub async fn spawn_dispatcher(
        &self,
        plugin: PluginHandle,
    ) -> Result<JoinHandle<()>> {
        let inbound = plugin.take_inbound().await.ok_or_else(|| {
            anyhow!("inbound stream missing for plugin {}", plugin.name())
        })?;
        let engine = self.engine.clone();
        let db = self.db.clone();
        let tenant = self.tenant_id.clone();
        let interval = self.typing_interval;
        Ok(tokio::spawn(async move {
            dispatch::dispatch_loop(engine, db, plugin, tenant, interval, inbound).await;
        }))
    }
}

struct PluginSlot {
    handle: PluginHandle,
    config: PluginConfig,
    /// Abort handle for the dispatcher task. The actual `JoinHandle` is
    /// owned by the per-slot supervisor task (see [`spawn_supervisor`])
    /// which awaits it to drive auto-respawn on unexpected plugin exit.
    dispatcher_abort: AbortHandle,
    started_at: DateTime<Utc>,
    /// How many times this slot has been replaced via `reload`. Useful
    /// for operators to confirm a reload actually landed. Auto-respawn
    /// also bumps this so the count reflects total restarts.
    reload_count: u32,
    /// Flips to `true` when the registry intentionally tears down this
    /// slot (graceful `reload` / `shutdown_all`). The supervisor reads
    /// it after the dispatcher exits to distinguish "we asked to stop"
    /// from "the plugin crashed/exited on its own."
    shutdown_requested: Arc<AtomicBool>,
}

/// Snapshot of one plugin's state — what `GET /admin/plugins` returns.
#[derive(Debug, Clone, Serialize)]
pub struct PluginStatus {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub started_at: DateTime<Utc>,
    pub reload_count: u32,
    pub manifest_version: String,
    pub manifest_capabilities: serde_json::Value,
}

/// Backoff between auto-respawn attempts when a plugin keeps dying.
/// We don't escalate exponentially: the watchdog only fires after 5
/// minutes of WS silence, so the natural cycle (5 min healthy → 5 sec
/// restart) keeps load minimal even in the worst case.
const RESPAWN_BACKOFF: Duration = Duration::from_secs(5);

/// Message sent by per-slot supervisor tasks when their plugin process
/// exits unexpectedly. A single registry-level worker drains this queue
/// and calls `insert_with_count` to bring the slot back. We use a
/// channel rather than direct recursion because `async fn` recursion
/// runs into `Send`-derivation cycles that the compiler can't break.
struct RespawnReq {
    config: PluginConfig,
    prior_count: u32,
}

pub struct PluginRegistry {
    spawner: PluginSpawner,
    slots: Mutex<HashMap<String, PluginSlot>>,
    respawn_tx: mpsc::UnboundedSender<RespawnReq>,
}

impl PluginRegistry {
    pub fn new(spawner: PluginSpawner) -> Arc<Self> {
        let (respawn_tx, respawn_rx) = mpsc::unbounded_channel();
        let registry = Arc::new(Self {
            spawner,
            slots: Mutex::new(HashMap::new()),
            respawn_tx,
        });
        // Respawn worker — single consumer, single producer-per-slot.
        // Lives as long as the registry: when all senders close (on
        // shutdown_all clearing the slots) the channel returns None
        // and the worker exits naturally.
        let registry_for_worker = registry.clone();
        tokio::spawn(async move {
            let mut rx = respawn_rx;
            while let Some(req) = rx.recv().await {
                let name = req.config.name.clone();
                if let Err(e) =
                    registry_for_worker.insert_with_count(req.config, req.prior_count).await
                {
                    error!(
                        plugin = %name,
                        error = %e,
                        "auto-respawn failed; operator must POST /admin/plugins/{}/reload",
                        name
                    );
                } else {
                    info!(
                        plugin = %name,
                        restart_count = req.prior_count,
                        "plugin auto-respawned after unexpected exit"
                    );
                }
            }
        });
        registry
    }

    /// Spawn a fresh plugin from `config` and register its dispatcher.
    /// Used at startup, as the second half of `reload`, and from the
    /// respawn worker when a plugin exits unexpectedly.
    pub async fn insert(&self, config: PluginConfig) -> Result<()> {
        self.insert_with_count(config, 0).await
    }

    /// Internal: same as [`insert`] but preserves the slot's
    /// `reload_count` across an auto-respawn so operators see total
    /// restarts (manual reloads + crash recoveries) in admin status.
    async fn insert_with_count(
        &self,
        config: PluginConfig,
        prior_count: u32,
    ) -> Result<()> {
        let name = config.name.clone();
        let handle = PluginHandle::spawn(config.clone())
            .await
            .with_context(|| format!("spawning plugin {name}"))?;
        let dispatcher = self.spawner.spawn_dispatcher(handle.clone()).await?;
        let dispatcher_abort = dispatcher.abort_handle();
        let shutdown_requested = Arc::new(AtomicBool::new(false));

        let slot = PluginSlot {
            handle,
            config: config.clone(),
            dispatcher_abort,
            started_at: Utc::now(),
            reload_count: prior_count,
            shutdown_requested: shutdown_requested.clone(),
        };
        self.slots.lock().await.insert(name.clone(), slot);

        // Supervisor task: watch the dispatcher; on unexpected exit,
        // queue a respawn via the channel. The respawn worker (in `new`)
        // drains the queue and calls `insert_with_count` — keeping the
        // recursion at the message-passing layer instead of in
        // `async fn` types so `Send` derivation stays simple.
        let respawn_tx = self.respawn_tx.clone();
        let sup_name = name.clone();
        let sup_config = config;
        let sup_count = prior_count;
        tokio::spawn(async move {
            // Resolves when the dispatcher task ends (plugin process
            // gone, panic, abort). At that point either the registry
            // intentionally tore us down (shutdown_requested=true) or
            // the plugin died on us.
            let _ = dispatcher.await;
            if shutdown_requested.load(Ordering::Acquire) {
                info!(
                    plugin = %sup_name,
                    "dispatcher exited gracefully (shutdown requested)"
                );
                return;
            }
            warn!(
                plugin = %sup_name,
                backoff_secs = RESPAWN_BACKOFF.as_secs(),
                "dispatcher exited unexpectedly; queuing respawn"
            );
            tokio::time::sleep(RESPAWN_BACKOFF).await;
            // Re-check the flag in case a graceful reload landed during
            // the backoff window.
            if shutdown_requested.load(Ordering::Acquire) {
                return;
            }
            // Send into the channel; the worker handles slot eviction
            // and respawning. If the channel is closed (registry
            // shutting down), drop the request silently.
            let _ = respawn_tx.send(RespawnReq {
                config: sup_config,
                prior_count: sup_count + 1,
            });
        });

        info!(plugin = %name, restart_count = prior_count, "plugin registered");
        Ok(())
    }


    /// Snapshot every running plugin. Order is alphabetical for stable
    /// JSON output.
    pub async fn list_status(&self) -> Vec<PluginStatus> {
        let slots = self.slots.lock().await;
        let mut out: Vec<PluginStatus> = slots.values().map(slot_status).collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Restart `name` in-place. Returns the freshly-spawned slot's
    /// status. The old plugin's pending RPCs are best-effort cancelled.
    pub async fn reload(&self, name: &str) -> Result<PluginStatus> {
        // Step 1: remove the old slot under the lock so concurrent reloads
        // serialise here.
        let old = {
            let mut slots = self.slots.lock().await;
            slots
                .remove(name)
                .ok_or_else(|| anyhow!("plugin {name} not registered"))?
        };
        // Mark the old slot as "intentional shutdown" so its supervisor
        // task (which will see the dispatcher exit shortly) doesn't
        // double-respawn while we're spawning the replacement.
        old.shutdown_requested.store(true, Ordering::Release);
        let prior_reloads = old.reload_count;
        let config = old.config.clone();

        // Step 2-3: tear down old. Do this outside the lock — graceful
        // shutdown can take seconds when the plugin is wedged.
        if let Err(e) = old.handle.shutdown().await {
            warn!(plugin = name, error = ?e, "shutdown of old plugin failed; aborting dispatcher anyway");
        }
        old.dispatcher_abort.abort();

        // Step 4-5: respawn through `insert_with_count` so the supervisor
        // task is wired up the same way as on initial registration.
        // Bump the reload count so admin status reflects total restarts
        // (manual + auto).
        self.insert_with_count(config, prior_reloads + 1).await?;
        let status = {
            let slots = self.slots.lock().await;
            slots
                .get(name)
                .map(slot_status)
                .ok_or_else(|| anyhow!("plugin {name} disappeared right after respawn"))?
        };
        info!(plugin = name, reload = prior_reloads + 1, "plugin reloaded");
        Ok(status)
    }

    /// Drain everything. Each slot's plugin gets a graceful shutdown
    /// followed by a dispatcher abort. Errors are logged, never
    /// propagated — caller is in tear-down anyway.
    pub async fn shutdown_all(&self) {
        let drained: HashMap<String, PluginSlot> = {
            let mut slots = self.slots.lock().await;
            std::mem::take(&mut *slots)
        };
        for (name, slot) in drained {
            // Tell the supervisor task this is intentional so it doesn't
            // race in a respawn while the binary is exiting.
            slot.shutdown_requested.store(true, Ordering::Release);
            if let Err(e) = slot.handle.shutdown().await {
                warn!(plugin = %name, error = ?e, "plugin shutdown failed");
            }
            slot.dispatcher_abort.abort();
        }
    }

    /// Snapshot of every plugin's `PluginHandle`. Exposed for code paths
    /// that pre-date the registry (e.g. tests that hold the runtime and
    /// peek at the plugins directly).
    pub async fn handles(&self) -> Vec<PluginHandle> {
        let slots = self.slots.lock().await;
        slots.values().map(|s| s.handle.clone()).collect()
    }

    /// Look up the currently-live handle for a plugin by name. Returns
    /// `None` when the plugin isn't registered or is mid-respawn (slot
    /// briefly absent between supervisor exit and the respawn worker
    /// re-inserting it). Used by the outbox worker to acquire a fresh
    /// handle each tick so retries pick up the post-respawn process.
    pub async fn handle(&self, name: &str) -> Option<PluginHandle> {
        let slots = self.slots.lock().await;
        slots.get(name).map(|s| s.handle.clone())
    }
}

fn slot_status(s: &PluginSlot) -> PluginStatus {
    let manifest = s.handle.manifest();
    PluginStatus {
        name: s.handle.name().to_string(),
        command: s.config.command.clone(),
        args: s.config.args.clone(),
        started_at: s.started_at,
        reload_count: s.reload_count,
        manifest_version: manifest.protocol_version.clone(),
        manifest_capabilities: serde_json::to_value(&manifest.capabilities)
            .unwrap_or(serde_json::Value::Null),
    }
}
