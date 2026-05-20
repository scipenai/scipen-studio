//! `snaca-editor` — SNACA editor-mode sidecar binary.
//!
//! Speaks the [editor protocol](../../../../docs/editor-protocol.md) over
//! stdio JSON-RPC 2.0. Spawned by SciPen Studio (or any host) and held for
//! the lifetime of the editor session.
//!
//! ## Lifecycle
//! 1. Host spawns process; injects sensitive env (e.g. `SNACA_API_KEY`).
//! 2. Host sends `init` on stdin; we reply manifest on stdout.
//! 3. Host sends `session.open` per opened project.
//! 4. Host sends `chat.send` / `inline_edit.start` / `composer.start`;
//!    we stream `turn.delta` etc. back on stdout.
//! 5. Host sends `shutdown`; we drain and exit.
//!
//! P0 scope (this file): wiring + stub `chat.send` that emits canned
//! deltas. Real LLM / tools / engine integration arrives in later phases.

mod approval_gate;
mod composer;
mod config;
mod context_inject;
mod handler;
mod llm;
mod mcp_runtime;
mod memory_handler;
mod outbound;
mod session;
mod session_manager;
mod skills_handler;
mod turn_engine;
mod turn_listener;

use crate::handler::EditorHandler;
use crate::outbound::OutboundWriter;
use crate::session_manager::SessionManager;
use anyhow::Context;
use clap::Parser;
use snaca_editor_protocol::Dispatcher;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "snaca-editor", version, about = "SNACA editor-mode sidecar")]
struct Cli {
    /// Optional path to a `snaca.toml` (defaults to none; host can also pass
    /// the full config inside `init.snaca_config`).
    #[arg(long)]
    config: Option<std::path::PathBuf>,
    /// Log filter (overridable via `RUST_LOG`).
    #[arg(long)]
    log_filter: Option<String>,
    /// Pre-download the fastembed ONNX model into the cache dir and
    /// exit. Used by the Studio "select fastembed" UI flow before
    /// persisting the setting — avoids a multi-minute hang inside the
    /// next `init`. Reads the cache dir from `SCIPEN_FASTEMBED_CACHE_DIR`
    /// when set; falls back to fastembed-rs's default (`~/.cache/fastembed`).
    /// Only available when built with `--features fastembed`.
    #[arg(long)]
    download_fastembed: bool,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    setup_tracing(cli.log_filter.as_deref());

    if cli.download_fastembed {
        return run_download_fastembed();
    }

    info!(
        version = env!("CARGO_PKG_VERSION"),
        config = ?cli.config,
        "snaca-editor starting"
    );

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("build tokio runtime")?;

    runtime.block_on(run(cli))
}

/// Stand up `FastEmbedEmbedder` once so its lazy download into the
/// cache directory completes, then exit. The host (Studio) captures
/// stderr for progress; success is signalled by exit code 0 and the
/// `READY` final line on stdout.
#[cfg(feature = "fastembed")]
fn run_download_fastembed() -> anyhow::Result<()> {
    use snaca_memory::{FastEmbedConfig, FastEmbedEmbedder};
    let cache_dir = std::env::var_os("SCIPEN_FASTEMBED_CACHE_DIR")
        .map(std::path::PathBuf::from);
    let mut cfg = FastEmbedConfig::default();
    cfg.cache_dir = cache_dir.clone();
    cfg.show_download_progress = true;
    eprintln!(
        "[snaca-editor] starting fastembed model fetch (cache_dir={})",
        cache_dir
            .as_deref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "<default>".into())
    );
    FastEmbedEmbedder::try_new(cfg)
        .context("fastembed download/init failed")?;
    // Marker line the host watches for so it can distinguish a graceful
    // exit from a process that died silently.
    println!("READY");
    Ok(())
}

#[cfg(not(feature = "fastembed"))]
fn run_download_fastembed() -> anyhow::Result<()> {
    Err(anyhow::anyhow!(
        "snaca-editor was built without the `fastembed` feature; rebuild with \
         `cargo build -p snaca-editor --features fastembed` to enable on-demand \
         ONNX model downloads"
    ))
}

async fn run(cli: Cli) -> anyhow::Result<()> {
    let outbound = Arc::new(OutboundWriter::new(tokio::io::stdout()));
    let sessions = Arc::new(SessionManager::new());
    sessions.set_outbound(outbound.clone());

    if let Some(path) = cli.config.as_deref() {
        if let Err(e) = config::preload_from_file(path).await {
            warn!(error = %e, path = %path.display(), "ignoring config file (will wait for init.snaca_config)");
        }
    }

    let handler = EditorHandler::new(outbound.clone(), sessions.clone());
    let dispatcher = Dispatcher::new(handler);

    // Stdin lines are processed **serially**: each dispatch returns quickly
    // (long-running work like `chat.send` spawns its own background task
    // for streaming and returns the turn_id immediately). Serial processing
    // guarantees host-observed response ordering matches send ordering — no
    // surprises like `session.open` racing ahead of an in-flight `init`.
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();

    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let line_bytes = line.into_bytes();
                if line_bytes.iter().all(|b| b.is_ascii_whitespace()) {
                    continue;
                }
                if let Some(reply) = dispatcher.process_line(&line_bytes).await {
                    if let Err(e) = outbound.write_raw(&reply).await {
                        error!(error = %e, "failed to write response");
                    }
                }
            }
            Ok(None) => {
                info!("stdin EOF, exiting");
                break;
            }
            Err(e) => {
                error!(error = %e, "stdin read error, exiting");
                break;
            }
        }
    }

    // Background tasks spawned by handlers (e.g. the stub `chat.send`
    // turn-runner) detach by design — host wanting a clean shutdown should
    // send `turn.cancel` followed by `shutdown` before closing stdin. We
    // still let in-flight detached tasks see ~50 ms to emit their last
    // delta before the runtime drops.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    info!("snaca-editor shut down");
    Ok(())
}

fn setup_tracing(filter_arg: Option<&str>) {
    use std::io::IsTerminal;

    let filter = std::env::var("RUST_LOG")
        .ok()
        .or_else(|| filter_arg.map(String::from))
        .unwrap_or_else(|| "snaca_editor=info,snaca_editor_protocol=info,info".into());

    // ANSI escapes are great in a real terminal but turn into garbage like
    // `[2m...[0m` when the host pipes stderr into a log file (Studio's
    // SnacaSidecarService does exactly that). Detect TTY and respect the
    // standard `NO_COLOR` env var, otherwise emit plain text.
    let use_ansi = std::io::stderr().is_terminal()
        && std::env::var_os("NO_COLOR").is_none();

    // Logs go to stderr — stdout is reserved for JSON-RPC frames.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new(filter))
        .with_writer(std::io::stderr)
        .with_ansi(use_ansi)
        .try_init();
}
