//! `snaca-cli` — administrative & debug CLI.
//!
//! Subcommands:
//! - `mock-plugin` — run a mock IM plugin on stdio for protocol probing.
//! - `tenant list` / `project list --tenant` / `binding list` — read the
//!   state DB at `--data-root` directly. No running server required.
//! - `plugin list` / `plugin reload <name>` / `health` — talk to a
//!   running server's admin HTTP API at `--server`.

use anyhow::Result;
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

mod admin;
mod memory_inspect;
mod mock_plugin;
mod remote;

#[derive(Debug, Parser)]
#[command(name = "snaca-cli", version, about = "SNACA debug & admin CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run a mock IM plugin on stdio (speaks SNACA channel-protocol).
    ///
    /// The plugin reads JSON-RPC requests on stdin and writes responses on
    /// stdout. Useful for protocol probing and as a `snaca-channel-host` test
    /// fixture.
    MockPlugin(mock_plugin::MockPluginArgs),

    /// Tenant inspection (reads the state DB directly).
    Tenant {
        #[command(subcommand)]
        sub: admin::TenantCommand,
        #[command(flatten)]
        args: admin::AdminArgs,
    },

    /// Project inspection (reads the state DB directly).
    Project {
        #[command(subcommand)]
        sub: admin::ProjectCommand,
        #[command(flatten)]
        args: admin::AdminArgs,
    },

    /// Chat-binding inspection (reads the state DB directly).
    Binding {
        #[command(subcommand)]
        sub: admin::BindingCommand,
        #[command(flatten)]
        args: admin::AdminArgs,
    },

    /// Plugin management — talks to the running server's admin HTTP API.
    Plugin {
        #[command(subcommand)]
        sub: remote::PluginCommand,
        #[command(flatten)]
        args: remote::RemoteArgs,
    },

    /// Probe the running server's `/healthz` endpoint.
    Health {
        #[command(flatten)]
        args: remote::RemoteArgs,
    },

    /// Memory inspection (reads the per-project memory tree directly).
    Memory {
        #[command(subcommand)]
        sub: memory_inspect::MemoryCommand,
        #[command(flatten)]
        args: memory_inspect::MemoryArgs,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    match cli.command {
        Command::MockPlugin(args) => mock_plugin::run(args).await,
        Command::Tenant { sub, args } => admin::run_tenant(sub, &args).await,
        Command::Project { sub, args } => admin::run_project(sub, &args).await,
        Command::Binding { sub, args } => admin::run_binding(sub, &args).await,
        Command::Plugin { sub, args } => remote::run_plugin(sub, &args).await,
        Command::Health { args } => remote::run_health(&args).await,
        Command::Memory { sub, args } => memory_inspect::run(sub, &args).await,
    }
}

fn init_tracing() {
    // Logs go to stderr so they don't pollute the JSON-RPC stream on stdout.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_target(false)
        .try_init();
}
