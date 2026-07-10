//! End-to-end tests for `snaca-cli memory`. Builds the CLI binary,
//! seeds a project's memory tree, and asserts each subcommand prints
//! what we expect.

use snaca_core::{ProjectId, TenantId};
use snaca_memory::{MemoryScope, MemoryStore};
use snaca_workspace::WorkspaceLayout;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

fn cli() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let cargo = escargot::CargoBuild::new()
            .bin("snaca-cli")
            .package("snaca-cli")
            .current_target()
            .run()
            .expect("build snaca-cli");
        cargo.path().to_path_buf()
    })
    .clone()
}

/// Seed a project's memory tree with three entries spanning two scopes
/// and run all CLI subcommands against it. We do the setup in one
/// shared helper so each test file is just an assert sandbox.
async fn seed(data_root: &std::path::Path) {
    std::fs::create_dir_all(data_root).unwrap();
    let layout = WorkspaceLayout::new(std::fs::canonicalize(data_root).unwrap()).unwrap();
    let tenant = TenantId::new("alpha");
    let project = ProjectId::from_raw("proj-one");
    layout.ensure_project(&tenant, &project).unwrap();
    let store = MemoryStore::new(layout.memory_dir(&tenant, &project));
    store
        .write(MemoryScope::User, "tone", "user prefers terse responses")
        .await
        .unwrap();
    store
        .write(
            MemoryScope::Project,
            "rust-style",
            "project uses kebab-case file names",
        )
        .await
        .unwrap();
    store
        .write(
            MemoryScope::Reference,
            "logs",
            "production logs at logs.internal/snaca",
        )
        .await
        .unwrap();
}

fn run(bin: &std::path::Path, args: &[&str]) -> String {
    let out = Command::new(bin).args(args).output().expect("spawn");
    assert!(
        out.status.success(),
        "{args:?} failed: stderr={}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).expect("utf-8")
}

#[tokio::test]
async fn list_shows_every_scope_by_default() {
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    seed(&data_root).await;
    let bin = cli();
    let stdout = run(
        &bin,
        &[
            "memory",
            "list",
            "--tenant",
            "alpha",
            "--project",
            "proj-one",
            "--data-root",
            data_root.to_str().unwrap(),
        ],
    );
    assert!(stdout.contains("user (1 entries)"), "got: {stdout}");
    assert!(stdout.contains("project (1 entries)"));
    assert!(stdout.contains("reference (1 entries)"));
    assert!(stdout.contains("tone"));
    assert!(stdout.contains("rust-style"));
    assert!(stdout.contains("logs"));
    // No feedback entries seeded — that section should be absent.
    assert!(!stdout.contains("feedback ("));
}

#[tokio::test]
async fn list_filters_by_scope() {
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    seed(&data_root).await;
    let bin = cli();
    let stdout = run(
        &bin,
        &[
            "memory",
            "list",
            "--tenant",
            "alpha",
            "--project",
            "proj-one",
            "--scope",
            "project",
            "--data-root",
            data_root.to_str().unwrap(),
        ],
    );
    assert!(stdout.contains("rust-style"));
    // Other scopes' entries must not appear.
    assert!(!stdout.contains("tone"));
    assert!(!stdout.contains("logs"));
}

#[tokio::test]
async fn show_prints_entry_body() {
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    seed(&data_root).await;
    let bin = cli();
    let stdout = run(
        &bin,
        &[
            "memory",
            "show",
            "--tenant",
            "alpha",
            "--project",
            "proj-one",
            "--scope",
            "user",
            "--name",
            "tone",
            "--data-root",
            data_root.to_str().unwrap(),
        ],
    );
    assert_eq!(stdout, "user prefers terse responses");
}

#[tokio::test]
async fn index_prints_memory_md() {
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    seed(&data_root).await;
    let bin = cli();
    let stdout = run(
        &bin,
        &[
            "memory",
            "index",
            "--tenant",
            "alpha",
            "--project",
            "proj-one",
            "--data-root",
            data_root.to_str().unwrap(),
        ],
    );
    assert!(stdout.contains("# Memory"), "got: {stdout}");
    assert!(stdout.contains("user/tone"));
}

#[tokio::test]
async fn import_writes_single_entry_per_file() {
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    std::fs::create_dir_all(&data_root).unwrap();
    let layout = WorkspaceLayout::new(std::fs::canonicalize(&data_root).unwrap()).unwrap();
    let tenant = TenantId::new("alpha");
    let project = ProjectId::from_raw("proj-import");
    layout.ensure_project(&tenant, &project).unwrap();

    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();
    let md_path = docs_dir.join("rust-style.md");
    std::fs::write(
        &md_path,
        "# Naming\n\nUse kebab-case for files.\n\n# Layout\n\nWorkspace lives at /home.",
    )
    .unwrap();

    let bin = cli();
    let stdout = run(
        &bin,
        &[
            "memory",
            "import",
            "--tenant",
            "alpha",
            "--project",
            "proj-import",
            md_path.to_str().unwrap(),
            "--data-root",
            data_root.to_str().unwrap(),
        ],
    );
    assert!(stdout.contains("imported `rust-style.md`"), "got: {stdout}");
    assert!(stdout.contains("memory entries written"));

    // Inspect the memory tree directly: one entry per source file,
    // named after the file's basename.
    let store = MemoryStore::new(layout.memory_dir(&tenant, &project));
    let names = store.list(MemoryScope::Reference).await.unwrap();
    assert_eq!(
        names,
        vec!["rust-style"],
        "expected one entry; got {names:?}"
    );
}

#[tokio::test]
async fn import_directory_walks_files_non_recursively() {
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    std::fs::create_dir_all(&data_root).unwrap();
    let layout = WorkspaceLayout::new(std::fs::canonicalize(&data_root).unwrap()).unwrap();
    let tenant = TenantId::new("alpha");
    let project = ProjectId::from_raw("proj-import-dir");
    layout.ensure_project(&tenant, &project).unwrap();

    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();
    std::fs::write(docs_dir.join("alpha.md"), "alpha content").unwrap();
    std::fs::write(docs_dir.join("beta.txt"), "beta content").unwrap();
    // Hidden file — should be skipped.
    std::fs::write(docs_dir.join(".hidden"), "ignored").unwrap();
    // A nested directory — should NOT be walked into.
    let nested = docs_dir.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(nested.join("inner.md"), "should not import").unwrap();

    let bin = cli();
    let stdout = run(
        &bin,
        &[
            "memory",
            "import",
            "--tenant",
            "alpha",
            "--project",
            "proj-import-dir",
            docs_dir.to_str().unwrap(),
            "--data-root",
            data_root.to_str().unwrap(),
        ],
    );
    // Two visible top-level files; hidden + nested are skipped.
    assert!(stdout.contains("alpha.md"));
    assert!(stdout.contains("beta.txt"));
    assert!(
        !stdout.contains(".hidden"),
        "hidden file leaked into output: {stdout}"
    );
    assert!(!stdout.contains("inner.md"), "nested file leaked: {stdout}");
}
