//! `snaca-cli memory ...` — inspect the per-project memory tree.
//!
//! Reads only — never mutates (except `import`, which writes). Useful
//! for ops poking at deployments after-the-fact: list entries, dump
//! the rendered MEMORY.md, print one entry's body, run a one-off
//! bulk import.
//!
//! Vector recall used to live here as a `search` subcommand. The
//! memory system no longer ships a vector layer — recall happens via
//! a frozen snapshot of the memory tree pinned into the system prompt
//! at session start. There is nothing for the CLI to query against.

use anyhow::{Context, Result};
use clap::{Args, Subcommand};
use snaca_core::{ProjectId, TenantId};
use snaca_memory::{
    approve_pending, import_one, list_pending, reject_pending, ImportConfig, ImportSource,
    MemoryScope, MemoryStore,
};
use snaca_workspace::WorkspaceLayout;
use std::path::PathBuf;
use std::str::FromStr;

#[derive(Debug, Args)]
pub struct MemoryArgs {
    /// Data-root directory (per-project memory dirs live under
    /// `<root>/<tenant>/projects/<project>/memory/`).
    #[arg(long, global = true, default_value = "./data")]
    pub data_root: PathBuf,
}

#[derive(Debug, Subcommand)]
pub enum MemoryCommand {
    /// List entries under one project's memory.
    List {
        #[arg(long)]
        tenant: String,
        #[arg(long)]
        project: String,
        /// Limit to one scope (user/project/reference/feedback). Omit
        /// to list every scope.
        #[arg(long)]
        scope: Option<String>,
    },
    /// Print the rendered `MEMORY.md` index for a project.
    Index {
        #[arg(long)]
        tenant: String,
        #[arg(long)]
        project: String,
    },
    /// Print the full body of one entry.
    Show {
        #[arg(long)]
        tenant: String,
        #[arg(long)]
        project: String,
        #[arg(long)]
        scope: String,
        #[arg(long)]
        name: String,
    },
    /// Bulk import a file (or every file in a directory) into a
    /// project's memory tree as a single entry per source.
    ///
    /// Supported formats: plain text, markdown, source code, PDF
    /// (with `--features pdf`), ZIP bundle of any of the above (with
    /// `--features bundle`). DOCX / XLSX / PPTX surface a clear error
    /// pointing at the `office-extract` skill.
    ///
    /// Bulk imports may only land in `project` or `reference` scopes;
    /// `user` and `feedback` are owned by conversation history and
    /// rejected by the importer.
    Import {
        #[arg(long)]
        tenant: String,
        #[arg(long)]
        project: String,
        /// File or directory to import. Directories are walked
        /// non-recursively.
        path: PathBuf,
        /// Scope to write entries under. Default: reference.
        #[arg(long, default_value = "reference")]
        scope: String,
    },
    /// List staged-but-not-yet-approved memory writes for a project.
    /// The IM-driven `MemoryWriteTool` stages here when the engine
    /// is configured to require approval; operators can review the
    /// pending JSON files by hand and then approve / reject.
    Pending {
        #[arg(long)]
        tenant: String,
        #[arg(long)]
        project: String,
    },
    /// Approve one staged memory write by its id (the JSON file
    /// stem under `<project>/memory/pending/`). Runs the threat
    /// scanner unless `--bypass-threat-scan` is supplied — only
    /// pass that when you've already eyeballed the JSON.
    Approve {
        #[arg(long)]
        tenant: String,
        #[arg(long)]
        project: String,
        id: String,
        /// Skip the threat scanner. Use only after manual review.
        #[arg(long, default_value_t = false)]
        bypass_threat_scan: bool,
    },
    /// Drop one staged memory write without applying it.
    Reject {
        #[arg(long)]
        tenant: String,
        #[arg(long)]
        project: String,
        id: String,
    },
}

fn workspace(data_root: &std::path::Path) -> Result<WorkspaceLayout> {
    let canonical = std::fs::canonicalize(data_root)
        .with_context(|| format!("resolving data_root {}", data_root.display()))?;
    WorkspaceLayout::new(canonical).map_err(Into::into)
}

fn store(layout: &WorkspaceLayout, tenant: &TenantId, project: &ProjectId) -> MemoryStore {
    MemoryStore::new(layout.memory_dir(tenant, project))
}

/// Resolve a path argument to a flat list of files. A file path
/// returns `[that_file]`; a directory path returns its non-recursive
/// children (files only). Hidden entries (`.` prefix) are skipped so
/// `.git/` etc. don't pollute imports.
fn collect_paths(p: &std::path::Path) -> Result<Vec<PathBuf>> {
    let meta = std::fs::metadata(p).with_context(|| format!("stat {}", p.display()))?;
    if meta.is_file() {
        return Ok(vec![p.to_path_buf()]);
    }
    if !meta.is_dir() {
        anyhow::bail!("{} is neither a file nor a directory", p.display());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(p).with_context(|| format!("read_dir {}", p.display()))? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        let ft = entry.file_type()?;
        if ft.is_file() {
            out.push(entry.path());
        }
    }
    out.sort();
    Ok(out)
}

pub async fn run(cmd: MemoryCommand, args: &MemoryArgs) -> Result<()> {
    let layout = workspace(&args.data_root)?;
    match cmd {
        MemoryCommand::List {
            tenant,
            project,
            scope,
        } => {
            let tenant = TenantId::new(tenant);
            let project = ProjectId::from_raw(project);
            let s = store(&layout, &tenant, &project);
            let scopes: Vec<MemoryScope> = match scope {
                None => MemoryScope::all().to_vec(),
                Some(raw) => vec![MemoryScope::from_str(&raw).map_err(|e| anyhow::anyhow!(e))?],
            };
            let mut total = 0usize;
            for sc in scopes {
                let names = s.list(sc).await?;
                if names.is_empty() {
                    continue;
                }
                println!("## {} ({} entries)", sc, names.len());
                for n in names {
                    println!("  - {n}");
                    total += 1;
                }
                println!();
            }
            if total == 0 {
                println!("(no memory entries)");
            }
        }

        MemoryCommand::Index { tenant, project } => {
            let tenant = TenantId::new(tenant);
            let project = ProjectId::from_raw(project);
            let s = store(&layout, &tenant, &project);
            let idx = s.index_text().await?;
            if idx.trim().is_empty() {
                println!("(empty MEMORY.md)");
            } else {
                print!("{}", idx);
            }
        }

        MemoryCommand::Show {
            tenant,
            project,
            scope,
            name,
        } => {
            let tenant = TenantId::new(tenant);
            let project = ProjectId::from_raw(project);
            let scope = MemoryScope::from_str(&scope).map_err(|e| anyhow::anyhow!(e))?;
            let s = store(&layout, &tenant, &project);
            let entry = s.read(scope, &name).await?;
            print!("{}", entry.content);
        }

        MemoryCommand::Import {
            tenant,
            project,
            path,
            scope,
        } => {
            let tenant = TenantId::new(tenant);
            let project = ProjectId::from_raw(project);
            let scope = MemoryScope::from_str(&scope).map_err(|e| anyhow::anyhow!(e))?;
            let s = store(&layout, &tenant, &project);
            let cfg = ImportConfig {
                default_scope: scope,
                ..Default::default()
            };

            let paths = collect_paths(&path)?;
            if paths.is_empty() {
                anyhow::bail!("no files found at {}", path.display());
            }
            let mut total_entries = 0usize;
            for file in paths {
                let bytes =
                    std::fs::read(&file).with_context(|| format!("reading {}", file.display()))?;
                let filename = file
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| file.to_string_lossy().into_owned());
                if filename.to_ascii_lowercase().ends_with(".zip") {
                    #[cfg(feature = "bundle")]
                    {
                        let reports = snaca_memory::import_bundle(&s, &bytes, &filename, &cfg)
                            .await
                            .with_context(|| format!("importing bundle {}", file.display()))?;
                        let n: usize = reports.iter().map(|r| r.entries.len()).sum();
                        println!(
                            "imported bundle `{}` → {} member(s), {} entries",
                            filename,
                            reports.len(),
                            n
                        );
                        total_entries += n;
                        continue;
                    }
                    #[cfg(not(feature = "bundle"))]
                    {
                        anyhow::bail!(
                            "ZIP bundle import requested for {} but the `bundle` feature is not enabled",
                            file.display()
                        );
                    }
                }
                let report = import_one(
                    &s,
                    ImportSource {
                        bytes,
                        filename: filename.clone(),
                        kind: None,
                    },
                    &cfg,
                )
                .await
                .with_context(|| format!("importing {}", file.display()))?;
                println!(
                    "imported `{}` ({:?}) → {} entries",
                    filename,
                    report.kind,
                    report.entries.len()
                );
                total_entries += report.entries.len();
            }
            println!("done. {total_entries} memory entries written.");
        }

        MemoryCommand::Pending { tenant, project } => {
            let tenant = TenantId::new(tenant);
            let project = ProjectId::from_raw(project);
            let memory_root = layout.memory_dir(&tenant, &project);
            let pending = list_pending(&memory_root)
                .await
                .context("listing pending memory writes")?;
            if pending.is_empty() {
                println!("(no pending memory writes)");
                return Ok(());
            }
            for p in pending {
                println!("- id: {}", p.id);
                println!("  scope/name: {}/{}", p.scope, p.name);
                println!("  requested_by: {}", p.requested_by);
                println!("  requested_at: {}", p.requested_at);
                let preview: String = p.content.chars().take(160).collect();
                let suffix = if p.content.chars().count() > 160 {
                    "…"
                } else {
                    ""
                };
                println!("  content preview: {preview}{suffix}");
                println!();
            }
        }

        MemoryCommand::Approve {
            tenant,
            project,
            id,
            bypass_threat_scan,
        } => {
            let tenant = TenantId::new(tenant);
            let project = ProjectId::from_raw(project);
            let memory_root = layout.memory_dir(&tenant, &project);
            let store = MemoryStore::new(&memory_root);
            let entry = approve_pending(&memory_root, &store, &id, bypass_threat_scan)
                .await
                .with_context(|| format!("approving pending {id}"))?;
            println!(
                "approved `{}/{}` ({} bytes)",
                entry.scope,
                entry.name,
                entry.content.len()
            );
        }

        MemoryCommand::Reject {
            tenant,
            project,
            id,
        } => {
            let tenant = TenantId::new(tenant);
            let project = ProjectId::from_raw(project);
            let memory_root = layout.memory_dir(&tenant, &project);
            let dropped = reject_pending(&memory_root, &id)
                .await
                .with_context(|| format!("rejecting pending {id}"))?;
            println!("rejected `{}/{}`", dropped.scope, dropped.name);
        }
    }
    Ok(())
}
