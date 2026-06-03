//! In-memory registry of background tasks spawned by `Bash` with
//! `run_in_background = true`.
//!
//! Design notes:
//!
//! - **Scope**: process-wide, shared across all tenants / projects.
//!   Each `TaskHandle` records its `(tenant, project, thread)` so
//!   `TaskOutput` and `TaskStop` refuse to surface tasks owned by a
//!   different tenant in multi-tenant deployments.
//! - **Memory only**: tasks live in a `HashMap` and are lost on
//!   restart. Persistence isn't useful — a respawned process can't
//!   resurrect a dead child anyway.
//! - **Output capture**: stdout / stderr each get a tail-keeping
//!   buffer capped at `STREAM_CAP_BYTES`. Once the cap is hit, older
//!   bytes are dropped — diagnostic queries usually want the *end* of
//!   a long log, not the start.
//! - **Cleanup**: `Drop for TaskRegistry` sends SIGKILL to every
//!   still-running child so a server shutdown doesn't leak processes.

use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_tools_api::ToolContext;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use uuid::Uuid;

/// Per-stream cap. 256 KiB is well over what an IM consumer can
/// reasonably surface in chat; if the model wants more it should pull
/// the binary off disk with another tool.
const STREAM_CAP_BYTES: usize = 256 * 1024;

pub type TaskId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Running,
    Exited(i32),
    /// Killed by us via `stop()` (or by the server's Drop on shutdown).
    Killed,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Running => "running",
            TaskStatus::Exited(_) => "exited",
            TaskStatus::Killed => "killed",
        }
    }
}

#[derive(Debug)]
pub struct TaskHandle {
    pub id: TaskId,
    pub cmd: String,
    pub started_at: SystemTime,
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    pub thread_id: ThreadId,

    status: Mutex<TaskStatus>,
    stdout: Arc<Mutex<RingBytes>>,
    stderr: Arc<Mutex<RingBytes>>,
    /// `None` once the child has reaped — kept in the registry so
    /// `TaskOutput` can still surface the final stdout / stderr / exit
    /// code after the process is gone.
    child: tokio::sync::Mutex<Option<Child>>,
}

impl TaskHandle {
    pub fn status(&self) -> TaskStatus {
        *self.status.lock().unwrap()
    }
}

/// Tail-keeping byte buffer. Once `STREAM_CAP_BYTES` is hit the oldest
/// bytes are dropped to make room. `truncated` is sticky so the
/// snapshot can tell the model "you're not seeing everything".
#[derive(Debug, Default)]
struct RingBytes {
    data: Vec<u8>,
    truncated: bool,
}

impl RingBytes {
    fn append(&mut self, chunk: &[u8]) {
        if self.data.len() + chunk.len() <= STREAM_CAP_BYTES {
            self.data.extend_from_slice(chunk);
            return;
        }
        // Overflow path: keep only the tail.
        self.truncated = true;
        let total = self.data.len() + chunk.len();
        let excess = total - STREAM_CAP_BYTES;
        if excess >= self.data.len() {
            // Even the new chunk alone won't fit — drop everything
            // and keep just the tail of `chunk`.
            self.data.clear();
            let keep = chunk.len().min(STREAM_CAP_BYTES);
            self.data.extend_from_slice(&chunk[chunk.len() - keep..]);
        } else {
            self.data.drain(..excess);
            self.data.extend_from_slice(chunk);
        }
    }

    fn snapshot(&self) -> (String, bool) {
        (
            String::from_utf8_lossy(&self.data).into_owned(),
            self.truncated,
        )
    }
}

/// Snapshot returned by `TaskRegistry::snapshot` — what the TaskOutput
/// tool surfaces back to the LLM.
#[derive(Debug, Clone)]
pub struct TaskSnapshot {
    pub id: TaskId,
    pub cmd: String,
    pub status: TaskStatus,
    pub stdout: String,
    pub stdout_truncated: bool,
    pub stderr: String,
    pub stderr_truncated: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Default)]
pub struct TaskRegistry {
    tasks: Mutex<HashMap<TaskId, Arc<TaskHandle>>>,
}

impl TaskRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Spawn `cmd` and return its id. Caller pre-configures the
    /// `Command` (stdio piped, working directory, any pre_exec
    /// hooks). The registry owns the child afterwards.
    pub fn spawn(
        self: &Arc<Self>,
        tenant: TenantId,
        project: ProjectId,
        thread: ThreadId,
        cmd_str: String,
        mut cmd: Command,
    ) -> std::io::Result<TaskId> {
        let mut child = cmd.spawn()?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let id = Uuid::new_v4().to_string();
        let handle = Arc::new(TaskHandle {
            id: id.clone(),
            cmd: cmd_str,
            started_at: SystemTime::now(),
            tenant_id: tenant,
            project_id: project,
            thread_id: thread,
            status: Mutex::new(TaskStatus::Running),
            stdout: Arc::new(Mutex::new(RingBytes::default())),
            stderr: Arc::new(Mutex::new(RingBytes::default())),
            child: tokio::sync::Mutex::new(Some(child)),
        });

        if let Some(out) = stdout {
            let buf = handle.stdout.clone();
            tokio::spawn(pump(out, buf));
        }
        if let Some(err) = stderr {
            let buf = handle.stderr.clone();
            tokio::spawn(pump(err, buf));
        }

        // Reaper task: wait for exit and stamp the final status.
        let h = handle.clone();
        tokio::spawn(async move {
            let mut guard = h.child.lock().await;
            // `child` may already be `None` if `stop()` reaped it.
            if let Some(child) = guard.as_mut() {
                match child.wait().await {
                    Ok(status) => {
                        let final_status = match status.code() {
                            Some(code) => TaskStatus::Exited(code),
                            // Unix: no exit code → terminated by signal.
                            // We treat that as Killed regardless of who
                            // sent the signal; the cmd field still says
                            // what the user asked for.
                            None => TaskStatus::Killed,
                        };
                        // Don't overwrite a `Killed` status that
                        // `stop()` already set — the explicit kill
                        // path is more informative than the wait
                        // result's "Signalled".
                        let mut s = h.status.lock().unwrap();
                        if !matches!(*s, TaskStatus::Killed) {
                            *s = final_status;
                        }
                    }
                    Err(_) => {
                        let mut s = h.status.lock().unwrap();
                        if !matches!(*s, TaskStatus::Killed) {
                            *s = TaskStatus::Exited(-1);
                        }
                    }
                }
            }
            // Drop the Child to release pidfd / zombie slots.
            *guard = None;
        });

        self.tasks
            .lock()
            .unwrap()
            .insert(id.clone(), handle);
        Ok(id)
    }

    /// Look up a task. Tenant/project guard is the caller's
    /// responsibility — see [`Self::snapshot`].
    pub fn get(&self, id: &str) -> Option<Arc<TaskHandle>> {
        self.tasks.lock().unwrap().get(id).cloned()
    }

    /// Snapshot a task with tenant/project access control. Returns
    /// `None` if the task doesn't exist, *or* if it belongs to a
    /// different tenant/project (so cross-tenant probes look the same
    /// as a typo, leaking no existence information).
    pub fn snapshot(
        &self,
        id: &str,
        tenant: &TenantId,
        project: &ProjectId,
    ) -> Option<TaskSnapshot> {
        let handle = self.get(id)?;
        if &handle.tenant_id != tenant || &handle.project_id != project {
            return None;
        }
        let status = handle.status();
        let (stdout, stdout_truncated) = handle.stdout.lock().unwrap().snapshot();
        let (stderr, stderr_truncated) = handle.stderr.lock().unwrap().snapshot();
        let elapsed_ms = handle
            .started_at
            .elapsed()
            .unwrap_or_default()
            .as_millis() as u64;
        Some(TaskSnapshot {
            id: handle.id.clone(),
            cmd: handle.cmd.clone(),
            status,
            stdout,
            stdout_truncated,
            stderr,
            stderr_truncated,
            elapsed_ms,
        })
    }

    /// Kill `id`. Returns the post-kill status (or `None` if the task
    /// doesn't exist / belongs to a different tenant). SIGKILL via
    /// `tokio::process::Child::start_kill`; we don't try SIGTERM first
    /// — IM tasks are expected to be short-lived and the user just
    /// asked us to stop, not to clean up.
    pub async fn stop(
        &self,
        id: &str,
        tenant: &TenantId,
        project: &ProjectId,
    ) -> Option<TaskStatus> {
        let handle = self.get(id)?;
        if &handle.tenant_id != tenant || &handle.project_id != project {
            return None;
        }
        // Mark as Killed up front so the reaper doesn't clobber it.
        *handle.status.lock().unwrap() = TaskStatus::Killed;
        {
            let mut guard = handle.child.lock().await;
            if let Some(child) = guard.as_mut() {
                let _ = child.start_kill();
            }
        }
        // Give the reaper a tick to release the child slot.
        tokio::time::sleep(Duration::from_millis(50)).await;
        Some(handle.status())
    }

    /// All task ids visible to `(tenant, project)`. Used by TaskList
    /// in the future; currently no tool surfaces it but the helper is
    /// cheap and self-contained.
    pub fn list(&self, tenant: &TenantId, project: &ProjectId) -> Vec<TaskId> {
        self.tasks
            .lock()
            .unwrap()
            .values()
            .filter(|h| &h.tenant_id == tenant && &h.project_id == project)
            .map(|h| h.id.clone())
            .collect()
    }
}

impl Drop for TaskRegistry {
    fn drop(&mut self) {
        // Best-effort orphan cleanup. We're in synchronous Drop so we
        // can't await on `tokio::sync::Mutex`; instead we try the lock
        // non-blockingly and SIGKILL whatever we can grab.
        let Ok(tasks) = self.tasks.lock() else {
            return;
        };
        for handle in tasks.values() {
            if let Ok(mut guard) = handle.child.try_lock() {
                if let Some(child) = guard.as_mut() {
                    let _ = child.start_kill();
                }
            }
        }
    }
}

/// Helper for tool implementations: pull the `TaskRegistry` out of
/// the opaque slot on `ToolContext`. Returns `None` when no registry
/// is attached (tests, single-process direct embed without a server).
pub fn task_registry_from_ctx(ctx: &ToolContext) -> Option<Arc<TaskRegistry>> {
    let opaque = ctx.task_registry_opaque()?;
    opaque.downcast::<TaskRegistry>().ok()
}

async fn pump<R>(mut reader: R, dst: Arc<Mutex<RingBytes>>)
where
    R: AsyncReadExt + Unpin + Send + 'static,
{
    let mut tmp = [0u8; 8192];
    loop {
        match reader.read(&mut tmp).await {
            Ok(0) => break,
            Ok(n) => {
                if let Ok(mut buf) = dst.lock() {
                    buf.append(&tmp[..n]);
                }
            }
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    fn make_cmd(shell_line: &str) -> Command {
        let mut c = Command::new("/bin/sh");
        c.arg("-c")
            .arg(shell_line)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        c
    }

    fn tenant_project_thread() -> (TenantId, ProjectId, ThreadId) {
        (
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            ThreadId::new("th"),
        )
    }

    #[tokio::test]
    async fn captures_stdout_after_completion() {
        let reg = TaskRegistry::new();
        let (t, p, th) = tenant_project_thread();
        let id = reg
            .spawn(t.clone(), p.clone(), th, "echo hello".into(), make_cmd("echo hello"))
            .unwrap();
        // Wait long enough for the child to finish + reaper to stamp status.
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            if let Some(s) = reg.snapshot(&id, &t, &p) {
                if !matches!(s.status, TaskStatus::Running) {
                    break;
                }
            }
        }
        let s = reg.snapshot(&id, &t, &p).expect("task missing");
        assert!(matches!(s.status, TaskStatus::Exited(0)), "got {:?}", s.status);
        assert!(s.stdout.contains("hello"), "stdout: {:?}", s.stdout);
    }

    #[tokio::test]
    async fn stop_kills_running_task() {
        let reg = TaskRegistry::new();
        let (t, p, th) = tenant_project_thread();
        let id = reg
            .spawn(
                t.clone(),
                p.clone(),
                th,
                "sleep 30".into(),
                make_cmd("sleep 30"),
            )
            .unwrap();
        // Confirm it's running first.
        let s = reg.snapshot(&id, &t, &p).expect("task missing");
        assert!(matches!(s.status, TaskStatus::Running));
        let status = reg.stop(&id, &t, &p).await.expect("stop returned None");
        assert!(matches!(status, TaskStatus::Killed));
    }

    #[tokio::test]
    async fn snapshot_refuses_cross_tenant() {
        let reg = TaskRegistry::new();
        let (t, p, th) = tenant_project_thread();
        let id = reg
            .spawn(t.clone(), p.clone(), th, "echo".into(), make_cmd("echo"))
            .unwrap();
        let other = TenantId::new("other");
        assert!(reg.snapshot(&id, &other, &p).is_none());
        // Same tenant — visible.
        assert!(reg.snapshot(&id, &t, &p).is_some());
    }

    #[test]
    fn ring_bytes_keeps_tail_on_overflow() {
        let mut r = RingBytes::default();
        let chunk = vec![b'a'; STREAM_CAP_BYTES];
        r.append(&chunk);
        assert!(!r.truncated);
        assert_eq!(r.data.len(), STREAM_CAP_BYTES);
        r.append(b"XYZ");
        assert!(r.truncated);
        assert_eq!(r.data.len(), STREAM_CAP_BYTES);
        // Tail is what we appended last.
        assert_eq!(&r.data[STREAM_CAP_BYTES - 3..], b"XYZ");
    }
}
