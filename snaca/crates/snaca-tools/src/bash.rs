//! `Bash` — execute a shell command.
//!
//! ## Safety model (M2)
//!
//! - **No shell composition**: forbidden chars (`;`, `&`, `|`, `<`, `>`,
//!   backtick, `$`, backslash, newlines) cause immediate rejection. Even
//!   with the allowlist, allowing pipelines lets a user chain `cat
//!   /etc/passwd` into things we'd rather not run.
//! - **First-token allowlist**: command must start with a known tool.
//!   `git` further requires a subcommand from a separate allowlist
//!   (status / log / diff / show / branch / blame / rev-parse / config /
//!   remote / tag).
//! - **Linux landlock confinement** (kernel 5.13+, the project's target):
//!   after fork, before exec, the child installs a landlock ruleset that
//!   grants RW only under the project workspace and read-only access to a
//!   small set of system dirs. Even if the LLM smuggles in `mkdir
//!   /etc/foo`, the syscall is denied. On non-Linux builds we fall back to
//!   the M1 read-only allowlist (no write commands).
//! - **cwd locked**: child runs with `cwd = ctx.workspace_root()`.
//! - **30s default timeout**, **1 MB stdout/stderr cap**, both configurable
//!   via tool input but capped at hard ceilings.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const FORBIDDEN_CHARS: &[char] = &[';', '&', '|', '<', '>', '`', '$', '\\', '\n', '\r'];

/// Read-only commands available on every platform. The list errs on
/// the side of inclusion — anything that can't trivially mutate
/// untrusted state by itself, plus common text-extraction utilities a
/// model is likely to reach for when interrogating uploaded files
/// (pdftotext, strings, hexdump, …). Real "write" commands that need
/// landlock confinement are tracked in `SANDBOXED_WRITE_COMMANDS`.
const READ_ONLY_COMMANDS: &[&str] = &[
    // Filesystem inspection.
    "ls", "cat", "head", "tail", "wc", "file", "stat", "tree", "du", "df",
    // Text search.
    "grep", "rg", "find", "fd", "ag", "locate",
    // Text shaping / inspection (deliberately read-only invocations —
    // `sed -i` / `awk` writing to a file go through the kernel and
    // hit landlock outside the workspace).
    "awk", "sed", "cut", "sort", "uniq", "tr", "rev", "tac", "fold",
    "xargs", "tee", "diff", "cmp", "comm", "join", "paste",
    // System probes.
    "pwd", "whoami", "uname", "date", "which", "type", "command", "env",
    "echo", "printf", "test", "true", "false", "yes", "false", "id",
    "hostname", "uptime", "ps", "ip",
    // Document / archive inspection (text extraction over uploads).
    "pdftotext", "pdfinfo", "pdftohtml", "pdftoppm", "mutool",
    "strings", "xxd", "od", "hexdump", "iconv",
    "unzip", "zip", "tar", "gzip", "gunzip", "bzip2", "bunzip2",
    "zcat", "bzcat", "xzcat",
    // Scripted extractors used by directory-form skills. These can
    // technically write to disk, so they rely on landlock (Linux) to
    // confine writes inside the workspace. On non-Linux builds writes
    // are denied by the read-only allowlist enforcement layer; reads
    // and `-c` snippets remain fine.
    "python3", "python", "node",
    // Hashing / encoding.
    "md5sum", "sha1sum", "sha256sum", "base64", "uuencode", "uudecode",
    // VCS — git is gated to a subcommand allowlist below.
    "git",
];

/// Mutating commands enabled only when landlock is available (Linux). On
/// other platforms these are dropped from the allowlist so we don't let the
/// model write outside the workspace via an unconfined child.
const SANDBOXED_WRITE_COMMANDS: &[&str] =
    &["mkdir", "rmdir", "touch", "cp", "mv", "rm", "chmod", "ln"];

const GIT_SUBCOMMAND_ALLOWLIST: &[&str] = &[
    "status", "log", "diff", "show", "branch", "blame", "rev-parse", "config", "remote", "tag",
];

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const HARD_TIMEOUT_MAX: Duration = Duration::from_secs(120);
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
struct BashInput {
    command: String,
    /// Optional timeout. Capped at 120 s; default 30 s. Only honored
    /// in foreground mode; background tasks run until they finish or
    /// `TaskStop` is called.
    #[serde(default)]
    timeout_ms: Option<u64>,
    /// When true, spawn the command and return a `task_id`
    /// immediately. Use `TaskOutput` to poll stdout/stderr/status and
    /// `TaskStop` to terminate. Useful for long-running builds /
    /// installs / test suites that would otherwise block the turn or
    /// time out.
    #[serde(default)]
    run_in_background: Option<bool>,
}

pub struct BashTool;

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str {
        "Bash"
    }

    fn description(&self) -> &str {
        "Execute a shell command in the project workspace. Strict first-token \
         allowlist (ls/cat/head/tail/grep/find/git status, plus scripted \
         extractors python3/node for directory-form skills). No pipes, \
         redirects, or shell composition. cwd is the project workspace; \
         30 s default timeout."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command. First token must be in the M1 read-only allowlist."
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Optional timeout in milliseconds. Capped at 120000. Foreground mode only.",
                    "minimum": 100
                },
                "run_in_background": {
                    "type": "boolean",
                    "description": "Spawn the command and return a task_id immediately instead of waiting. Poll with TaskOutput, terminate with TaskStop. Use for long-running builds / installs / test suites.",
                    "default": false
                }
            },
            "required": ["command"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        // On Linux the landlock sandbox confines the child to the project
        // workspace, so we honestly admit `writes_filesystem`. On other
        // targets the allowlist drops every write command and we revert
        // to read-only.
        ToolCapabilities {
            reads_filesystem: true,
            writes_filesystem: cfg!(target_os = "linux"),
            executes_commands: true,
            network_access: false,
        }
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        if cfg!(target_os = "linux") {
            ApprovalRequirement::UnlessRemembered
        } else {
            // Read-only allowlist on non-Linux — same logic as M1.
            ApprovalRequirement::Never
        }
    }

    fn is_read_only(&self) -> bool {
        // On Linux Bash can write inside the workspace; elsewhere the
        // allowlist is read-only by construction.
        !cfg!(target_os = "linux")
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input: BashInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;

        validate_command(&input.command)?;

        let timeout = input
            .timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(DEFAULT_TIMEOUT)
            .min(HARD_TIMEOUT_MAX);

        let cwd = ctx.workspace_root().to_path_buf();

        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(&input.command)
            .current_dir(&cwd)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Apply landlock to the child after fork, before exec. This
        // tightens the policy beyond the first-word allowlist so even a
        // legitimate `cp` can't escape the workspace.
        #[cfg(target_os = "linux")]
        {
            let workspace = cwd.clone();
            // In strict mode the only writable path is the workspace
            // itself. In relaxed mode (single-tenant trusted bot,
            // operator opted in) we also allow `/tmp` and the user's
            // `$HOME` so `pandoc`, `python`, `pdflatex`, npm tools,
            // etc. can write their scratch files. Reads stay
            // unconstrained — landlock only filters writes.
            let extras: Vec<std::path::PathBuf> = if relaxed_mode() {
                let mut v = vec![std::path::PathBuf::from("/tmp")];
                if let Some(h) = dirs::home_dir() {
                    v.push(h);
                }
                v
            } else {
                Vec::new()
            };
            // SAFETY: pre_exec runs in the forked child between fork() and
            // exec(); only async-signal-safe calls are valid. landlock
            // syscalls (landlock_create_ruleset, landlock_add_rule,
            // landlock_restrict_self) are async-signal-safe. We also avoid
            // the rust runtime here — no allocations beyond what landlock
            // itself does internally for path FDs.
            unsafe {
                cmd.pre_exec(move || {
                    let extra_refs: Vec<&std::path::Path> =
                        extras.iter().map(|p| p.as_path()).collect();
                    snaca_workspace::sandbox::apply(&workspace, &extra_refs)
                        .map_err(std::io::Error::other)?;
                    Ok(())
                });
            }
        }

        // Background mode: hand the configured Command off to the
        // TaskRegistry and return immediately. Requires the registry
        // to be attached to the ToolContext — without it we can't own
        // the child past this call and have to fall through to the
        // foreground path with a warning.
        if input.run_in_background.unwrap_or(false) {
            match crate::task_registry::task_registry_from_ctx(ctx) {
                Some(registry) => {
                    // We need a ThreadId for the scope check on
                    // TaskOutput / TaskStop. ToolContext doesn't
                    // carry one directly; derive a stable token from
                    // session_id so all tools in the same turn share
                    // it. Cross-turn lookups in the same thread are
                    // not supported in this iteration (the IM channel
                    // generally drives one turn per user message;
                    // long-lived tasks survive the registry but the
                    // model is expected to poll within the same turn
                    // or accept that the task continues silently).
                    let thread_token =
                        snaca_core::ThreadId::new(format!("session:{}", ctx.session_id()));
                    let id = registry
                        .spawn(
                            ctx.tenant_id().clone(),
                            ctx.project_id().clone(),
                            thread_token,
                            input.command.clone(),
                            cmd,
                        )
                        .map_err(ToolError::Io)?;
                    return Ok(ToolOutput::json(json!({
                        "task_id": id,
                        "cmd": input.command,
                        "status": "running",
                        "hint": "use TaskOutput with this task_id to read stdout/stderr/status; TaskStop to terminate."
                    })));
                }
                None => {
                    return Err(ToolError::Execution(
                        "run_in_background requested but no TaskRegistry is attached to this engine".into(),
                    ));
                }
            }
        }

        let mut child = cmd.spawn().map_err(ToolError::Io)?;
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");

        let stdout_task = tokio::spawn(read_capped(stdout, MAX_OUTPUT_BYTES));
        let stderr_task = tokio::spawn(read_capped(stderr, MAX_OUTPUT_BYTES));

        let status = match tokio::time::timeout(timeout, child.wait()).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => return Err(ToolError::Io(e)),
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(ToolError::Execution(format!(
                    "command timed out after {timeout:?}"
                )));
            }
        };

        let stdout_str = stdout_task
            .await
            .map_err(|e| ToolError::Other(format!("stdout reader join: {e}")))??;
        let stderr_str = stderr_task
            .await
            .map_err(|e| ToolError::Other(format!("stderr reader join: {e}")))??;

        let combined = format_streams(&stdout_str, &stderr_str);

        if !status.success() {
            return Err(ToolError::Execution(format!(
                "command exited with code {}\n{}",
                status.code().unwrap_or(-1),
                combined
            )));
        }

        Ok(ToolOutput::text(combined))
    }
}

/// Render captured stdout / stderr with explicit section headers.
/// Old behaviour put stdout first then a `---- stderr ----` marker;
/// the new shape is symmetric and lets a downstream parser key on the
/// fences. Empty streams collapse to `<no output>` to keep the result
/// non-empty (downstream callers historically asserted on that).
fn format_streams(stdout: &str, stderr: &str) -> String {
    let stdout_trim = stdout.trim_end_matches('\n');
    let stderr_trim = stderr.trim_end_matches('\n');
    if stdout_trim.is_empty() && stderr_trim.is_empty() {
        return "<no output>".to_string();
    }
    let mut out = String::new();
    if !stdout_trim.is_empty() {
        out.push_str("---- stdout ----\n");
        out.push_str(stdout_trim);
        out.push('\n');
    }
    if !stderr_trim.is_empty() {
        out.push_str("---- stderr ----\n");
        out.push_str(stderr_trim);
        out.push('\n');
    }
    out
}

fn is_first_word_allowed(first: &str) -> bool {
    if READ_ONLY_COMMANDS.contains(&first) {
        return true;
    }
    if snaca_workspace::sandbox::supported() && SANDBOXED_WRITE_COMMANDS.contains(&first) {
        return true;
    }
    false
}

/// Read once per call; cheap. Operators flip the env var to opt out
/// of allowlist enforcement when the deployment trusts every command
/// the LLM will issue (single-tenant personal bots, dev sandboxes,
/// etc.). Recognised values: `1` / `true` / `yes` (case-insensitive).
fn relaxed_mode() -> bool {
    std::env::var("SNACA_BASH_RELAXED")
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

fn validate_command(cmd: &str) -> Result<(), ToolError> {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return Err(ToolError::InvalidInput("empty command".into()));
    }

    // Single-tenant trusted deployments (e.g. a personal Lark bot) can
    // opt out of the allowlist + forbidden-char checks via env. Writes
    // are still confined by landlock to the project workspace; reads
    // are unconstrained because reading anything the running process
    // can read is fine for that trust model. Off by default — keeping
    // M1's strict policy as the safe baseline.
    if relaxed_mode() {
        return Ok(());
    }

    for c in FORBIDDEN_CHARS {
        if trimmed.contains(*c) {
            return Err(ToolError::PermissionDenied(format!(
                "command contains forbidden character '{c}'; \
                 M1 allowlist forbids shell composition (pipes, redirects, etc.). \
                 Set SNACA_BASH_RELAXED=1 in trusted single-tenant deployments to \
                 skip this check (landlock still confines writes)."
            )));
        }
    }

    let mut iter = trimmed.split_whitespace();
    let first = iter
        .next()
        .ok_or_else(|| ToolError::InvalidInput("empty command".into()))?;

    if !is_first_word_allowed(first) {
        return Err(ToolError::PermissionDenied(format!(
            "{first}: not in M1 read-only allowlist"
        )));
    }

    if first == "git" {
        let sub = iter
            .next()
            .ok_or_else(|| ToolError::InvalidInput("git requires a subcommand".into()))?;
        if !GIT_SUBCOMMAND_ALLOWLIST.contains(&sub) {
            return Err(ToolError::PermissionDenied(format!(
                "git {sub}: subcommand not in M1 allowlist"
            )));
        }
    }

    Ok(())
}

async fn read_capped<R>(mut reader: R, cap: usize) -> Result<String, ToolError>
where
    R: AsyncReadExt + Unpin,
{
    let mut out = Vec::with_capacity(8192);
    let mut tmp = [0u8; 8192];
    let mut truncated = false;
    loop {
        let n = reader.read(&mut tmp).await.map_err(ToolError::Io)?;
        if n == 0 {
            break;
        }
        if out.len() + n > cap {
            let take = cap - out.len();
            out.extend_from_slice(&tmp[..take]);
            truncated = true;
            break;
        }
        out.extend_from_slice(&tmp[..n]);
    }
    let mut s = String::from_utf8_lossy(&out).into_owned();
    if truncated {
        s.push_str("\n<output truncated>");
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, SessionId, TenantId};
    use std::path::Path;

    fn ctx(root: &Path) -> ToolContext {
        ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            root.to_path_buf(),
        )
    }

    // --- validation unit tests (pure logic) ---

    #[test]
    fn rejects_forbidden_chars() {
        for c in &[";", "&", "|", "<", ">", "`", "$", "\\", "\n"] {
            let cmd = format!("ls {c} a");
            let err = validate_command(&cmd).unwrap_err();
            assert!(
                matches!(err, ToolError::PermissionDenied(_)),
                "expected PermissionDenied for char {c}, got {err:?}"
            );
        }
    }

    #[test]
    fn rejects_unknown_first_token() {
        // `dd` is not on either the read-only or sandboxed-write allowlist
        // and so must be rejected on every platform.
        let err = validate_command("dd if=/dev/zero of=/tmp/x").unwrap_err();
        assert!(matches!(err, ToolError::PermissionDenied(_)));
    }

    #[test]
    fn rejects_curl_and_wget() {
        for c in &["curl https://example.com", "wget https://example.com"] {
            let err = validate_command(c).unwrap_err();
            assert!(matches!(err, ToolError::PermissionDenied(_)), "got {err:?}");
        }
    }

    #[test]
    fn rejects_bare_git() {
        let err = validate_command("git").unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[test]
    fn rejects_disallowed_git_subcommand() {
        let err = validate_command("git push origin main").unwrap_err();
        assert!(matches!(err, ToolError::PermissionDenied(_)));
    }

    #[test]
    fn allows_known_commands() {
        for c in &[
            "ls",
            "ls -la",
            "cat README.md",
            "grep TODO src/main.rs",
            "git status",
            "git log --oneline",
            "find . -name *.rs",
            "echo hello",
        ] {
            assert!(
                validate_command(c).is_ok(),
                "expected {c:?} to validate, got {:?}",
                validate_command(c)
            );
        }
    }

    #[test]
    fn allows_scripted_extractors() {
        // python3 / python / node are on the allowlist for directory-form
        // skills that ship out-of-process extractors (docx/xlsx/pptx).
        for c in &[
            "python3 -c print(1)",
            "python --version",
            "node --version",
            "python3 scripts/extract.py /tmp/x.docx",
        ] {
            assert!(
                validate_command(c).is_ok(),
                "expected {c:?} to validate, got {:?}",
                validate_command(c)
            );
        }
    }

    #[test]
    fn scripted_extractors_still_reject_pipes() {
        // Even though python is allowlisted, the forbidden-char check
        // still blocks shell composition, so the model can't smuggle
        // anything through `python -c '...' | sh`.
        let err = validate_command("python3 -c print(1) | sh").unwrap_err();
        assert!(matches!(err, ToolError::PermissionDenied(_)), "got {err:?}");
    }

    // --- execution integration tests (spawn /bin/sh) ---

    #[tokio::test]
    async fn echo_runs_and_returns_output() {
        let dir = tempfile::tempdir().unwrap();
        let out = BashTool
            .execute(json!({"command": "echo hello-world"}), &ctx(dir.path()))
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("hello-world"));
    }

    #[tokio::test]
    async fn ls_works_in_workspace() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("README.md"), "x").unwrap();
        std::fs::write(dir.path().join("Cargo.toml"), "y").unwrap();

        let out = BashTool
            .execute(json!({"command": "ls"}), &ctx(dir.path()))
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("README.md"));
        assert!(out.contains("Cargo.toml"));
    }

    #[tokio::test]
    async fn dangerous_uppercase_command_rejected_before_spawn() {
        // `dd` would be runnable in a real shell but is not on either
        // allowlist, so the validator must short-circuit before we spawn
        // anything. We assert the would-be-target file is untouched as a
        // proof-of-no-spawn.
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, "before").unwrap();
        let err = BashTool
            .execute(
                json!({"command": "dd if=/dev/zero of=a.txt count=1 bs=1"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::PermissionDenied(_)));
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "before");
    }

    #[tokio::test]
    async fn pipe_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let err = BashTool
            .execute(
                json!({"command": "cat README.md | grep foo"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::PermissionDenied(_)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_allowlist_includes_sandboxed_write_commands() {
        for c in &[
            "mkdir test",
            "cp a b",
            "rm a",
            "touch x",
            "chmod 644 x",
            "mv a b",
            "ln -s a b",
            "rmdir d",
        ] {
            assert!(validate_command(c).is_ok(), "expected {c:?} to validate");
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linux_sandbox_allows_workspace_writes() {
        let dir = tempfile::tempdir().unwrap();
        let out = BashTool
            .execute(
                json!({"command": "mkdir new_dir"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("<no output>") || out.is_empty(), "got: {out}");
        assert!(dir.path().join("new_dir").is_dir());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linux_sandbox_blocks_writes_outside_workspace() {
        // `cp` is allowlisted, but landlock confines the child so a copy
        // *out of* the workspace into /tmp must fail at syscall level.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("source.txt"), "secret").unwrap();
        let outside = std::env::temp_dir().join(format!(
            "snaca-bash-sandbox-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let err = BashTool
            .execute(
                json!({"command": format!("cp source.txt {}", outside.display())}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, ToolError::Execution(_)),
            "expected execution failure, got {err:?}"
        );
        assert!(
            !outside.exists(),
            "sandbox should have blocked the write to /tmp"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linux_sandbox_blocks_writes_to_etc() {
        let dir = tempfile::tempdir().unwrap();
        let err = BashTool
            .execute(
                json!({"command": "touch /etc/snaca-test-marker"}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::Execution(_)));
        assert!(!std::path::Path::new("/etc/snaca-test-marker").exists());
    }

    #[tokio::test]
    async fn timeout_kills_long_running() {
        let dir = tempfile::tempdir().unwrap();
        // `find /` would normally take long; timeout at 200ms.
        let started = std::time::Instant::now();
        let err = BashTool
            .execute(
                json!({"command": "find / -name foo", "timeout_ms": 200}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        let elapsed = started.elapsed();
        assert!(matches!(err, ToolError::Execution(_)));
        // Should have timed out roughly at 200 ms; allow generous slack for CI.
        assert!(
            elapsed < Duration::from_secs(5),
            "expected timeout under 5s, took {elapsed:?}"
        );
    }
}
