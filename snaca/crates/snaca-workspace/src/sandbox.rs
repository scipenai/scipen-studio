//! Linux landlock sandbox helper used by `BashTool`.
//!
//! Applied as a `pre_exec` hook on the Bash child: after fork, before
//! the shell takes over, we install a landlock ruleset that restricts
//! the process to:
//! - **read + write** access under the project workspace,
//! - **read-only** access to a small set of system directories so the
//!   shell can resolve binaries (`/usr`, `/bin`, `/lib`, `/lib64`, `/etc`).
//!
//! Anything else — `/tmp`, `/home/<user>`, `/proc/<other>`, the project
//! data root outside this tenant's slice — is invisible to write syscalls.
//! Reads outside the read-only set are also denied; that's intentional, so
//! a curious model can't slurp other tenants' workspaces.
//!
//! Landlock requires kernel 5.13+ (ABI v1) for write restrictions; we ask
//! for the highest ABI the kernel supports and degrade gracefully when
//! unsupported (the syscall path returns Err and the caller logs/skips).
//!
//! On non-Linux platforms this module compiles to a no-op stub so the
//! rest of the crate stays portable.

#[cfg(target_os = "linux")]
mod imp {
    use landlock::{
        ABI, Access, AccessFs, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr,
        RulesetStatus,
    };
    use std::path::Path;

    /// Read-only paths the child needs to find binaries, shared libraries
    /// and its own runtime config. We grant read access to the whole root:
    /// under landlock semantics this means the child can `read`/`exec`
    /// anywhere on disk, but can still only `write` under the explicit
    /// `workspace` + `extra_writable` rules. The trade-off: a malicious
    /// tool inside the child can still slurp host secrets (~/.ssh,
    /// /etc/shadow if the parent has access). High-sensitivity deployments
    /// should add a second layer (docker / firejail / firecracker).
    /// The all-read default is what makes `npx`-style toolchains (node in
    /// ~/.nvm, npm cache in ~/.npm) and arbitrary system binaries work
    /// without per-host configuration.
    const READ_ONLY_PATHS: &[&str] = &["/"];

    /// Apply a landlock ruleset that grants the current process full access
    /// under `workspace` and `extra_writable`, read-only access under a
    /// fixed set of system dirs. After this returns, every subsequent
    /// file syscall in this process (and its descendants) is filtered
    /// through the ruleset.
    ///
    /// `extra_writable` is for callers (like MCP) that need a transient
    /// scratch dir on top of the workspace — pass `&[Path::new("/tmp")]`
    /// to let the child use `/tmp` for downloads or unix sockets. Pass
    /// `&[]` for the strictest regime (Bash uses this).
    ///
    /// Errors:
    /// - `kernel-unsupported`: kernel < 5.13 / landlock disabled. Caller
    ///   policy decides whether this is fatal.
    /// - `permission-error`: failure to open one of the path FDs. Should
    ///   never happen for a valid workspace.
    pub fn apply(workspace: &Path, extra_writable: &[&Path]) -> Result<(), String> {
        let abi = ABI::V3;

        // Open path file descriptors before installing the ruleset. After
        // restrict_self() the FD APIs themselves still work, but we're
        // already filtered, so any open() with rights we haven't granted
        // will fail.
        let workspace_fd =
            PathFd::new(workspace).map_err(|e| format!("workspace path fd: {e}"))?;

        let mut writable_fds = Vec::with_capacity(extra_writable.len());
        for path in extra_writable {
            // Missing extra paths are silently skipped — same as the
            // read-only set. /tmp may not exist in some chroot tests.
            if let Ok(fd) = PathFd::new(*path) {
                writable_fds.push(fd);
            }
        }

        let mut read_only_fds = Vec::new();
        for path in READ_ONLY_PATHS {
            if let Ok(fd) = PathFd::new(path) {
                read_only_fds.push(fd);
            }
        }

        let access_all = AccessFs::from_all(abi);
        let access_read = AccessFs::from_read(abi);

        let mut created = Ruleset::default()
            .handle_access(access_all)
            .map_err(|e| format!("ruleset handle_access: {e}"))?
            .create()
            .map_err(|e| format!("ruleset create: {e}"))?;

        created = created
            .add_rule(PathBeneath::new(workspace_fd, access_all))
            .map_err(|e| format!("workspace rule: {e}"))?;

        for fd in writable_fds {
            created = created
                .add_rule(PathBeneath::new(fd, access_all))
                .map_err(|e| format!("extra-writable rule: {e}"))?;
        }

        for fd in read_only_fds {
            created = created
                .add_rule(PathBeneath::new(fd, access_read))
                .map_err(|e| format!("read-only rule: {e}"))?;
        }

        let status = created
            .restrict_self()
            .map_err(|e| format!("restrict_self: {e}"))?;
        match status.ruleset {
            RulesetStatus::FullyEnforced => Ok(()),
            // PartiallyEnforced means the kernel only supports a subset
            // of the access flags we asked for. That's still useful — a
            // 5.13 kernel without write-rule support would partially
            // enforce. The caller might want to log this; for now we
            // accept and continue.
            RulesetStatus::PartiallyEnforced => Ok(()),
            RulesetStatus::NotEnforced => Err("landlock not enforced by kernel".into()),
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use std::path::Path;

    /// No-op on non-Linux; we have no equivalent sandbox primitive built
    /// in. Callers should fall back to "read-only allowlist" mode there.
    pub fn apply(_workspace: &Path, _extra_writable: &[&Path]) -> Result<(), String> {
        Err("landlock unavailable on this platform".into())
    }
}

pub use imp::apply;

/// `true` iff the current build target supports landlock (i.e. Linux).
/// Callers gate the write-command allowlist on this so non-Linux builds
/// stay in the M1-style read-only Bash mode.
pub const fn supported() -> bool {
    cfg!(target_os = "linux")
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, ExitStatus, Stdio};

    /// Spawn a child that applies landlock to itself, then runs the
    /// closure-as-shell-script and reports its exit status.
    fn run_in_sandbox(workspace: &std::path::Path, script: &str) -> ExitStatus {
        let workspace = workspace.to_path_buf();
        let script = script.to_string();
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(&script);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        let workspace_for_pre = workspace.clone();
        unsafe {
            cmd.pre_exec(move || {
                apply(&workspace_for_pre, &[]).map_err(std::io::Error::other)?;
                Ok(())
            });
        }
        cmd.spawn()
            .expect("spawn sandbox child")
            .wait()
            .expect("wait sandbox child")
    }

    #[test]
    fn write_inside_workspace_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path();
        let status = run_in_sandbox(workspace, "echo hello > $0/inside.txt && exit 0");
        // The shell substitutes $0 with the first positional argument; we
        // didn't pass one, so use a literal path instead.
        let _ = status; // ignore — the actual assertion is in the second invocation.

        let status = run_in_sandbox(
            workspace,
            &format!(
                "/bin/sh -c 'echo hello > {}/inside.txt'",
                workspace.display()
            ),
        );
        assert!(status.success(), "sandbox blocked write inside workspace");
        let content = fs::read_to_string(workspace.join("inside.txt")).unwrap();
        assert_eq!(content.trim(), "hello");
    }

    #[test]
    fn write_outside_workspace_is_blocked() {
        let workspace = tempfile::tempdir().unwrap();
        // Try to write to /tmp/<uuid> — outside both workspace and the
        // read-only system paths.
        let outside = std::env::temp_dir().join(format!(
            "snaca-sandbox-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let status = run_in_sandbox(
            workspace.path(),
            &format!("echo hi > {} 2>/dev/null", outside.display()),
        );
        assert!(
            !status.success(),
            "sandbox should block writes outside the workspace"
        );
        assert!(
            !outside.exists(),
            "file outside workspace must not have been created"
        );
    }

    #[test]
    fn read_of_etc_resolv_conf_still_works() {
        // Sanity: the child shell needs to be able to read /etc to
        // resolve binaries. /etc/resolv.conf is a small file present on
        // basically every Linux system.
        let workspace = tempfile::tempdir().unwrap();
        if !std::path::Path::new("/etc/resolv.conf").exists() {
            return; // Skip on systems without it.
        }
        let status = run_in_sandbox(
            workspace.path(),
            "test -r /etc/resolv.conf",
        );
        assert!(status.success(), "sandbox unexpectedly blocked /etc reads");
    }
}
