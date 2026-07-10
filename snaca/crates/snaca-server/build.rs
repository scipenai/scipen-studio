//! Build script — surface a friendly warning when the admin SPA hasn't
//! been built yet so backend-only developers (who don't have Node)
//! aren't surprised by an empty admin page later.
//!
//! We deliberately don't *fail* the build: there are plenty of cases
//! (running `cargo test`, working on a Lark plugin) where the SPA
//! doesn't matter. The runtime serves a clear 404 JSON when the SPA is
//! missing — see `crate::admin::web::spa_missing_response`.

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let dist_dir = std::path::Path::new(&manifest_dir).join("../../web/dist");
    let index = dist_dir.join("index.html");
    if !index.exists() {
        println!(
            "cargo:warning=admin SPA not built (web/dist/index.html missing). \
             Run `npm --prefix web ci && npm --prefix web run build` for a usable admin UI."
        );
    }
    if let Err(err) = std::fs::create_dir_all(&dist_dir) {
        println!(
            "cargo:warning=could not create missing admin SPA dir {}: {err}",
            dist_dir.display()
        );
    }
    // Rebuild when web/dist contents change so release builds pick up
    // freshly-built SPA bytes without `cargo clean`.
    println!("cargo:rerun-if-changed={}", dist_dir.display());
    println!("cargo:rerun-if-changed={}", index.display());
    println!("cargo:rerun-if-changed=build.rs");
}
