//! Remote admin subcommands — talk to a running server's admin HTTP API.
//!
//! Mirrors the routes wired in `snaca-server`:
//!   GET  /healthz
//!   GET  /admin/plugins
//!   POST /admin/plugins/{name}/reload
//!
//! All commands take `--server <url>` (default `http://127.0.0.1:8080`).
//! Output is plain text by default; pass `--json` to dump the raw JSON
//! body — handy for piping into `jq` or saving as a fixture.

use anyhow::{Context, Result};
use clap::{Args, Subcommand};

#[derive(Debug, Args)]
pub struct RemoteArgs {
    /// Base URL of the running server's admin endpoint.
    #[arg(long, global = true, default_value = "http://127.0.0.1:8080")]
    pub server: String,
    /// Print the raw JSON response body instead of a human summary.
    #[arg(long, global = true)]
    pub json: bool,
}

#[derive(Debug, Subcommand)]
pub enum PluginCommand {
    /// List every plugin currently registered with the running server.
    List,
    /// Hot-reload a single plugin by name. Shuts the old subprocess
    /// down, respawns it from the original config, and rewires the
    /// dispatcher.
    Reload {
        /// Plugin name (must match `plugins[].name` in `snaca.toml`).
        name: String,
    },
}

pub async fn run_health(args: &RemoteArgs) -> Result<()> {
    let url = format!("{}/healthz", args.server.trim_end_matches('/'));
    let resp = reqwest::get(&url).await.with_context(|| format!("GET {url}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&body)?);
    } else {
        println!(
            "{} -> HTTP {} ({})",
            url,
            status.as_u16(),
            body["status"].as_str().unwrap_or("?")
        );
    }
    Ok(())
}

pub async fn run_plugin(cmd: PluginCommand, args: &RemoteArgs) -> Result<()> {
    let base = args.server.trim_end_matches('/');
    match cmd {
        PluginCommand::List => {
            let url = format!("{base}/admin/plugins");
            let resp = reqwest::get(&url)
                .await
                .with_context(|| format!("GET {url}"))?;
            let body: serde_json::Value = resp.json().await?;
            if args.json {
                println!("{}", serde_json::to_string_pretty(&body)?);
                return Ok(());
            }
            let plugins = body["plugins"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if plugins.is_empty() {
                println!("(no plugins registered)");
                return Ok(());
            }
            println!("{} plugin(s):", plugins.len());
            for p in plugins {
                let name = p["name"].as_str().unwrap_or("?");
                let cmd = p["command"].as_str().unwrap_or("?");
                let started = p["started_at"].as_str().unwrap_or("?");
                let reloads = p["reload_count"].as_i64().unwrap_or(0);
                let proto = p["manifest_version"].as_str().unwrap_or("?");
                println!(
                    "  {name}\n      command={cmd}\n      protocol={proto} reloads={reloads} started_at={started}"
                );
            }
        }
        PluginCommand::Reload { name } => {
            let url = format!("{base}/admin/plugins/{name}/reload");
            let resp = reqwest::Client::new()
                .post(&url)
                .send()
                .await
                .with_context(|| format!("POST {url}"))?;
            let status = resp.status();
            let body: serde_json::Value = resp.json().await?;
            if args.json {
                println!("{}", serde_json::to_string_pretty(&body)?);
                return Ok(());
            }
            if !status.is_success() {
                let msg = body["error"].as_str().unwrap_or("?");
                anyhow::bail!("reload failed (HTTP {}): {msg}", status.as_u16());
            }
            let reloads = body["plugin"]["reload_count"].as_i64().unwrap_or(-1);
            println!("✓ plugin `{name}` reloaded (count = {reloads})");
        }
    }
    Ok(())
}
