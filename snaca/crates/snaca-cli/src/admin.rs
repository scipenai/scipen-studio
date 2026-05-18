//! Local admin subcommands — read directly from the SNACA state DB.
//!
//! These touch the SQLite file (`<data_root>/state.sqlite`) without
//! talking to a running server. Convenient for poking at deployments
//! after-the-fact: list tenants, projects, chat bindings.
//!
//! For commands that mutate live state (plugin reloads etc.) see
//! [`crate::remote`], which goes through the admin HTTP API.

use anyhow::{Context, Result};
use clap::{Args, Subcommand};
use snaca_core::TenantId;
use snaca_state::Database;
use std::path::PathBuf;

#[derive(Debug, Args)]
pub struct AdminArgs {
    /// Data-root directory (`<root>/state.sqlite` is opened). Defaults
    /// to `./data` to match the example config.
    #[arg(long, global = true, default_value = "./data")]
    pub data_root: PathBuf,
}

#[derive(Debug, Subcommand)]
pub enum TenantCommand {
    /// List every tenant that has a thread on file.
    List,
}

#[derive(Debug, Subcommand)]
pub enum ProjectCommand {
    /// List every project under a given tenant.
    List {
        /// Tenant whose projects to list.
        #[arg(long)]
        tenant: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum BindingCommand {
    /// List every chat → project binding stored in `chat_session_binding`.
    List,
}

async fn open_db(data_root: &std::path::Path) -> Result<Database> {
    let path = data_root.join("state.sqlite");
    Database::open(&path)
        .await
        .with_context(|| format!("opening {}", path.display()))
}

pub async fn run_tenant(cmd: TenantCommand, args: &AdminArgs) -> Result<()> {
    let db = open_db(&args.data_root).await?;
    match cmd {
        TenantCommand::List => {
            let tenants = db.list_tenants().await?;
            if tenants.is_empty() {
                println!("(no tenants — no threads on file yet)");
                return Ok(());
            }
            println!("{} tenant(s):", tenants.len());
            for t in tenants {
                println!("  {}", t.as_str());
            }
        }
    }
    Ok(())
}

pub async fn run_project(cmd: ProjectCommand, args: &AdminArgs) -> Result<()> {
    let db = open_db(&args.data_root).await?;
    match cmd {
        ProjectCommand::List { tenant } => {
            let tenant = TenantId::new(tenant);
            let projects = db.list_projects_for_tenant(&tenant).await?;
            if projects.is_empty() {
                println!("(no projects under tenant `{}`)", tenant.as_str());
                return Ok(());
            }
            println!(
                "{} project(s) under tenant `{}`:",
                projects.len(),
                tenant.as_str()
            );
            for p in projects {
                println!("  {}", p.as_str());
            }
        }
    }
    Ok(())
}

pub async fn run_binding(cmd: BindingCommand, args: &AdminArgs) -> Result<()> {
    let db = open_db(&args.data_root).await?;
    match cmd {
        BindingCommand::List => {
            let bindings = db.list_bindings().await?;
            if bindings.is_empty() {
                println!("(no chat bindings)");
                return Ok(());
            }
            println!("{} binding(s):", bindings.len());
            for b in bindings {
                println!(
                    "  chat=`{}` user=`{}` -> project=`{}` (bound {})",
                    b.chat_id,
                    b.user_id,
                    b.project_id.as_str(),
                    b.bound_at.format("%Y-%m-%d %H:%M:%SZ")
                );
            }
        }
    }
    Ok(())
}
