//! Integration tests for the local admin CLI subcommands. Builds the
//! `snaca-cli` binary via `escargot`, seeds a SQLite database directly,
//! and then runs `tenant list` / `project list` / `binding list` against
//! it, asserting the human-readable output covers the seeded rows.

use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_state::{Database, NewThread};
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

fn snaca_cli_binary() -> PathBuf {
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

async fn seed(data_root: &std::path::Path) {
    std::fs::create_dir_all(data_root).unwrap();
    let db_path = data_root.join("state.sqlite");
    let db = Database::open(&db_path).await.unwrap();
    let alpha = TenantId::new("alpha");
    let beta = TenantId::new("beta");
    let p1 = ProjectId::from_raw("proj-one");
    let p2 = ProjectId::from_raw("proj-two");

    db.insert_thread(&NewThread {
        id: ThreadId::new("thr-1"),
        tenant_id: alpha.clone(),
        project_id: p1.clone(),
    })
    .await
    .unwrap();
    db.insert_thread(&NewThread {
        id: ThreadId::new("thr-2"),
        tenant_id: alpha.clone(),
        project_id: p2.clone(),
    })
    .await
    .unwrap();
    db.insert_thread(&NewThread {
        id: ThreadId::new("thr-3"),
        tenant_id: beta.clone(),
        project_id: p1.clone(),
    })
    .await
    .unwrap();

    db.upsert_binding("chat_x", "user_y", &p1).await.unwrap();
}

fn run_cli(bin: &std::path::Path, args: &[&str]) -> String {
    let out = Command::new(bin)
        .args(args)
        .output()
        .expect("spawn snaca-cli");
    assert!(
        out.status.success(),
        "snaca-cli {args:?} failed: stderr={}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).expect("utf-8 stdout")
}

#[tokio::test]
async fn tenant_list_shows_seeded_tenants() {
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    seed(&data_root).await;

    let bin = snaca_cli_binary();
    let stdout = run_cli(
        &bin,
        &[
            "tenant",
            "list",
            "--data-root",
            data_root.to_str().unwrap(),
        ],
    );
    assert!(stdout.contains("alpha"), "got: {stdout}");
    assert!(stdout.contains("beta"), "got: {stdout}");
    assert!(stdout.contains("2 tenant"));
}

#[tokio::test]
async fn project_list_filters_by_tenant() {
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    seed(&data_root).await;

    let bin = snaca_cli_binary();
    let stdout = run_cli(
        &bin,
        &[
            "project",
            "list",
            "--tenant",
            "alpha",
            "--data-root",
            data_root.to_str().unwrap(),
        ],
    );
    assert!(stdout.contains("proj-one"), "got: {stdout}");
    assert!(stdout.contains("proj-two"), "got: {stdout}");

    // Filtering by `beta` returns only the one project.
    let stdout = run_cli(
        &bin,
        &[
            "project",
            "list",
            "--tenant",
            "beta",
            "--data-root",
            data_root.to_str().unwrap(),
        ],
    );
    assert!(stdout.contains("proj-one"));
    assert!(!stdout.contains("proj-two"), "leaked alpha project: {stdout}");
}

#[tokio::test]
async fn binding_list_shows_chat_bindings() {
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    seed(&data_root).await;

    let bin = snaca_cli_binary();
    let stdout = run_cli(
        &bin,
        &[
            "binding",
            "list",
            "--data-root",
            data_root.to_str().unwrap(),
        ],
    );
    assert!(stdout.contains("chat_x"), "got: {stdout}");
    assert!(stdout.contains("user_y"));
    assert!(stdout.contains("proj-one"));
}

#[tokio::test]
async fn empty_tenant_list_reports_no_tenants() {
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    std::fs::create_dir_all(&data_root).unwrap();
    // Open the DB so `state.sqlite` exists but no threads are inserted.
    let _ = Database::open(data_root.join("state.sqlite")).await.unwrap();

    let bin = snaca_cli_binary();
    let stdout = run_cli(
        &bin,
        &[
            "tenant",
            "list",
            "--data-root",
            data_root.to_str().unwrap(),
        ],
    );
    assert!(stdout.contains("no tenants"), "got: {stdout}");
}
