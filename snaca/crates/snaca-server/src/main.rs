//! `snaca-server` — main process entrypoint.
//!
//! Loads the config, builds a `Runtime`, and waits for Ctrl-C. All the
//! interesting wiring lives in `lib.rs` so integration tests can drive a
//! full SNACA process in-process with a mock `LlmClient`.

use anyhow::{Context, Result};
use clap::Parser;
use file_rotate::{compression::Compression, suffix::AppendCount, ContentLimit, FileRotate};
use snaca_server::{log_approval_mode_at_startup, Config, LoggingSection, Runtime};
use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "snaca-server", version, about = "SNACA agent server")]
struct Args {
    /// Path to `snaca.toml`. Defaults to `./snaca.toml`.
    #[arg(long, short = 'c', default_value = "snaca.toml")]
    config: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let mut config = Config::load(&args.config)
        .with_context(|| format!("loading config {}", args.config.display()))?;
    // Keep the WorkerGuard alive for the whole process — when it drops,
    // any pending log writes in the non-blocking writer's queue are
    // dropped on the floor. We let it fall through to the end of `main`.
    let _log_guard = init_tracing(&config.logging)?;

    // First-run admin onboarding: generate a bearer token and persist it
    // to the config so subsequent restarts use the same value. We log it
    // exactly once at INFO so the operator can copy it from the startup
    // banner without having to grep the file.
    if let Some(token) = config
        .ensure_admin_token(&args.config)
        .context("preparing admin token")?
    {
        tracing::info!(token = %token, "admin token generated and persisted to config");
    }

    tracing::info!(
        listen = %config.server.http_listen,
        provider = %config.llm.provider,
        model = %config.llm.model,
        plugins = config.plugins.len(),
        admin_enabled = config.admin.enabled,
        "starting snaca-server"
    );
    log_approval_mode_at_startup();

    let runtime = Runtime::build_with_config_path(config, args.config.clone()).await?;
    let mut admin_shutdown_rx = runtime.admin_shutdown_rx.clone();

    // Block until Ctrl-C or an authenticated admin shutdown request, then
    // shut down normally. Supervisors can restart us to apply saved config.
    tokio::select! {
        sig = tokio::signal::ctrl_c() => {
            if let Err(e) = sig {
                tracing::warn!(error=%e, "failed to install Ctrl-C handler; running until killed");
                std::future::pending::<()>().await;
            }
            tracing::info!("Ctrl-C received, shutting down");
        }
        changed = admin_shutdown_rx.changed() => {
            match changed {
                Ok(()) if *admin_shutdown_rx.borrow() => {
                    tracing::info!("admin shutdown requested, shutting down");
                }
                Ok(()) => {
                    tracing::warn!("admin shutdown channel changed without shutdown flag");
                }
                Err(_) => {
                    tracing::warn!("admin shutdown channel closed unexpectedly");
                }
            }
        }
    }
    runtime.shutdown().await;
    Ok(())
}

fn init_tracing(logging: &LoggingSection) -> Result<Option<WorkerGuard>> {
    use std::io::IsTerminal;
    // Precedence: RUST_LOG (operator override) > snaca.toml `[logging].filter`
    // > built-in default. We don't warn on a malformed toml directive — fall
    // through to the default so a typo doesn't lock us out of stderr.
    const DEFAULT: &str = "snaca_server=info,snaca_engine=info,snaca_channel_host=info,info";
    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| {
            logging
                .filter
                .as_deref()
                .map(EnvFilter::try_new)
                .unwrap_or_else(|| EnvFilter::try_new(DEFAULT))
        })
        .unwrap_or_else(|_| EnvFilter::new(DEFAULT));

    // File sink: size-based rotation via `file-rotate`, fronted by
    // `tracing_appender::non_blocking` so the formatting layer never
    // blocks on disk I/O. When configured, stderr is silenced — typical
    // for systemd / docker deployments where stderr already goes
    // somewhere the operator doesn't want duplicated.
    if let Some(path) = logging.file.as_ref() {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("creating log directory {}", parent.display()))?;
            }
        }
        const DEFAULT_MAX_MB: u64 = 50;
        const DEFAULT_MAX_FILES: usize = 10;
        let max_bytes = logging
            .max_size_mb
            .unwrap_or(DEFAULT_MAX_MB)
            .saturating_mul(1024 * 1024);
        if max_bytes == 0 {
            anyhow::bail!("logging.max_size_mb must be > 0");
        }
        let max_files = logging.max_files.unwrap_or(DEFAULT_MAX_FILES);
        let rotator = FileRotate::new(
            path.clone(),
            AppendCount::new(max_files),
            ContentLimit::Bytes(max_bytes as usize),
            Compression::None,
            None,
        );
        let (writer, guard) = tracing_appender::non_blocking(rotator);
        let _ = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_target(false)
            .with_ansi(false)
            .with_writer(writer)
            .try_init();
        return Ok(Some(guard));
    }

    // ANSI on only when stderr is an interactive terminal. When the
    // operator redirects to a file (`> log 2>&1`) or pipes to journald,
    // colour escapes survive as raw 0x1B bytes and become noise (or get
    // rendered as `\x1b[…m` by viewers that escape control chars).
    let ansi = std::io::stderr().is_terminal();
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_ansi(ansi)
        .with_writer(std::io::stderr)
        .try_init();
    Ok(None)
}
