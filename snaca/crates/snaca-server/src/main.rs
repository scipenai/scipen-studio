//! `snaca-server` — main process entrypoint.
//!
//! Loads the config, builds a `Runtime`, and waits for Ctrl-C. All the
//! interesting wiring lives in `lib.rs` so integration tests can drive a
//! full SNACA process in-process with a mock `LlmClient`.

use anyhow::{Context, Result};
use clap::Parser;
use snaca_server::{log_approval_mode_at_startup, Config, Runtime};
use std::path::PathBuf;
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
    let config = Config::load(&args.config)
        .with_context(|| format!("loading config {}", args.config.display()))?;
    init_tracing(config.logging.filter.as_deref());

    tracing::info!(
        listen = %config.server.http_listen,
        provider = %config.llm.provider,
        model = %config.llm.model,
        plugins = config.plugins.len(),
        "starting snaca-server"
    );
    log_approval_mode_at_startup();

    let runtime = Runtime::build(config).await?;

    // Block until Ctrl-C, then shut down.
    if let Err(e) = tokio::signal::ctrl_c().await {
        tracing::warn!(error=%e, "failed to install Ctrl-C handler; running until killed");
        // Park forever — process manager will SIGTERM us.
        std::future::pending::<()>().await;
    }
    tracing::info!("Ctrl-C received, shutting down");
    runtime.shutdown().await;
    Ok(())
}

fn init_tracing(toml_filter: Option<&str>) {
    use std::io::IsTerminal;
    // Precedence: RUST_LOG (operator override) > snaca.toml `[logging].filter`
    // > built-in default. We don't warn on a malformed toml directive — fall
    // through to the default so a typo doesn't lock us out of stderr.
    const DEFAULT: &str = "snaca_server=info,snaca_engine=info,snaca_channel_host=info,info";
    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| {
            toml_filter
                .map(EnvFilter::try_new)
                .unwrap_or_else(|| EnvFilter::try_new(DEFAULT))
        })
        .unwrap_or_else(|_| EnvFilter::new(DEFAULT));
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
}
