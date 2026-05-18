//! `snaca-cli memory ...` — inspect the per-project memory tree.
//!
//! Reads only — never mutates. Useful for ops poking at deployments
//! after-the-fact: list entries, dump the rendered MEMORY.md, print one
//! entry's body, run a search query against the vector index.
//!
//! Search uses the deterministic `HashEmbedder` so the CLI doesn't pull
//! in fastembed (which would download a 50 MB ONNX model on first
//! call). Operators who want production-quality scoring should run
//! recall through the live server's tools instead.

use anyhow::{Context, Result};
use clap::{Args, Subcommand};
use snaca_core::{ProjectId, TenantId};
use snaca_memory::{
    import_one, HashEmbedder, ImportConfig, ImportSource, IndexedMemoryStore, MemoryScope,
    MemoryStore,
};
use snaca_state::Database;
use snaca_workspace::WorkspaceLayout;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

#[derive(Debug, Args)]
pub struct MemoryArgs {
    /// Data-root directory (`<root>/state.sqlite` is opened, and per-project
    /// memory dirs live under `<root>/<tenant>/projects/<project>/memory/`).
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
    /// Run a vector search against a project's memory using the
    /// deterministic hash embedder. Returns the top-k matches with
    /// scores. Note: hash embedder is for diagnostics — production
    /// scoring uses fastembed via the running server.
    Search {
        #[arg(long)]
        tenant: String,
        #[arg(long)]
        project: String,
        /// Query text.
        query: String,
        #[arg(long, short = 'k', default_value_t = 5)]
        k: usize,
    },
    /// Bulk import a file (or every file in a directory) into a
    /// project's memory tree. Uses the deterministic hash embedder
    /// — same caveat as `search`: production-quality embeddings come
    /// from the running server, not this command.
    ///
    /// Supported formats: plain text, markdown, source code. PDF /
    /// DOCX / ZIP land in a follow-up release. Unknown extensions
    /// are treated as plain text.
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
    let meta = std::fs::metadata(p)
        .with_context(|| format!("stat {}", p.display()))?;
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

async fn open_db(data_root: &std::path::Path) -> Result<Database> {
    let path = data_root.join("state.sqlite");
    Database::open(&path)
        .await
        .with_context(|| format!("opening {}", path.display()))
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
                Some(raw) => vec![MemoryScope::from_str(&raw)
                    .map_err(|e| anyhow::anyhow!(e))?],
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
            let db = open_db(&args.data_root).await?;
            let embedder = Arc::new(HashEmbedder::default());
            let idx = IndexedMemoryStore::new(
                s,
                db,
                embedder,
                tenant.clone(),
                project.clone(),
            );
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
                let bytes = std::fs::read(&file)
                    .with_context(|| format!("reading {}", file.display()))?;
                let filename = file
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| file.to_string_lossy().into_owned());
                // Route ZIP archives through the bundle importer when
                // the feature is on; otherwise fall through to
                // `import_one` (which would fail since ZIP isn't a
                // recognised SourceKind here, but we surface a clear
                // message instead of letting the user wonder).
                if filename.to_ascii_lowercase().ends_with(".zip") {
                    #[cfg(feature = "bundle")]
                    {
                        let reports = snaca_memory::import_bundle(
                            &idx, &bytes, &filename, &cfg,
                        )
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
                    &idx,
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

        MemoryCommand::Search {
            tenant,
            project,
            query,
            k,
        } => {
            let tenant = TenantId::new(tenant);
            let project = ProjectId::from_raw(project);
            let s = store(&layout, &tenant, &project);
            let db = open_db(&args.data_root).await?;
            let embedder = Arc::new(HashEmbedder::default());
            let idx = IndexedMemoryStore::new(
                s,
                db,
                embedder,
                tenant.clone(),
                project.clone(),
            );
            // Bring the vector table in sync with anything written
            // through the file tree alone (the tool path).
            let synced = idx.ensure_indexed().await?;
            if synced > 0 {
                eprintln!("(indexed {synced} entries before search)");
            }
            let hits = idx.search(&query, k).await?;
            if hits.is_empty() {
                println!("(no matches above the recall threshold)");
                return Ok(());
            }
            for h in hits {
                println!("{:>6.3}  {}/{}", h.score, h.scope.as_str(), h.name);
            }
        }
    }
    Ok(())
}
