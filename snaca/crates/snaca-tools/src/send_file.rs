//! `SendFile` — emit a workspace file as an IM attachment.
//!
//! The tool itself is a thin façade: it resolves `path` against the
//! project workspace (via `resolve_within`, so escapes are rejected),
//! validates the file exists, then queues an [`OutboundFile`] entry
//! through the tool context. The engine collects the queue at turn
//! end; the dispatcher walks the list and calls `plugin.file_upload`
//! per entry.
//!
//! Why a queue and not an inline RPC: tools today don't have a
//! `PluginHandle` in scope, and the engine deliberately keeps tool
//! impls free of channel-host concerns. The queue is the smallest
//! seam that lets tools express intent without growing the trait.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_tools_api::{
    ApprovalRequirement, OutboundFile, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput,
    ToolResult,
};
use snaca_workspace::resolve_within;
use std::path::Path;

const MAX_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct SendFileInput {
    path: String,
    /// Override the displayed filename. Defaults to the basename of `path`.
    #[serde(default)]
    filename: Option<String>,
    /// Override the MIME hint. Defaults to a coarse extension lookup.
    #[serde(default)]
    mime_type: Option<String>,
}

pub struct SendFileTool;

#[async_trait]
impl Tool for SendFileTool {
    fn name(&self) -> &str {
        "SendFile"
    }

    fn description(&self) -> &str {
        "Send a file from the project workspace to the user via the \
         IM channel. The file must already exist inside the workspace \
         (use Write / Edit / Bash / pandoc / etc. to produce it first). \
         Optional `filename` overrides the displayed name; optional \
         `mime_type` overrides the MIME hint. 50 MB ceiling."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path inside the project workspace (relative or absolute)."
                },
                "filename": {
                    "type": "string",
                    "description": "Optional display filename. Default: basename of `path`."
                },
                "mime_type": {
                    "type": "string",
                    "description": "Optional MIME hint. Default: extension-based guess."
                }
            },
            "required": ["path"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::default()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        // Sending a file doesn't *modify* anything user-visible —
        // it's a fancy `message.send`. Keep approval at "Never" so
        // round-trip tasks (produce → send) don't ask twice.
        ApprovalRequirement::Never
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let parsed: SendFileInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        let resolved = resolve_within(ctx.workspace_root(), Path::new(&parsed.path))
            .map_err(|e| ToolError::PathOutsideWorkspace(e.to_string()))?;

        let meta = tokio::fs::metadata(&resolved)
            .await
            .map_err(ToolError::Io)?;
        if !meta.is_file() {
            return Err(ToolError::InvalidInput(format!(
                "{}: not a regular file",
                parsed.path
            )));
        }
        if meta.len() > MAX_BYTES {
            return Err(ToolError::Execution(format!(
                "{}: {} bytes exceeds {} byte ceiling",
                parsed.path,
                meta.len(),
                MAX_BYTES
            )));
        }

        let filename = parsed
            .filename
            .clone()
            .or_else(|| {
                resolved
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| "attachment.bin".into());
        let mime_type = parsed.mime_type.unwrap_or_else(|| guess_mime(&filename));

        let queued = ctx.queue_outbound_file(OutboundFile {
            absolute_path: resolved.clone(),
            filename: filename.clone(),
            mime_type,
        });
        if !queued {
            return Err(ToolError::Other(
                "no outbound channel attached — engine has no IM dispatcher to send through"
                    .into(),
            ));
        }
        Ok(ToolOutput::text(format!(
            "queued `{}` ({} bytes) for delivery as `{}`",
            parsed.path,
            meta.len(),
            filename
        )))
    }
}

/// Mirrors the helper inside the Lark plugin — kept local to avoid a
/// dep on snaca-plugin-lark from snaca-tools.
fn guess_mime(filename: &str) -> String {
    let lower = filename.to_ascii_lowercase();
    let ext = Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    match ext {
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "doc" => "application/msword",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "zip" => "application/zip",
        "json" => "application/json",
        "yaml" | "yml" => "text/yaml",
        "csv" => "text/csv",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, SessionId, TenantId};
    use std::sync::{Arc, Mutex};

    fn ctx_with_outbound(
        root: &Path,
    ) -> (ToolContext, Arc<Mutex<Vec<OutboundFile>>>) {
        let outbound = Arc::new(Mutex::new(Vec::new()));
        let ctx = ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            root.to_path_buf(),
        )
        .with_outbound_files(outbound.clone());
        (ctx, outbound)
    }

    #[tokio::test]
    async fn queues_file_inside_workspace() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.md"), "# hi").unwrap();
        let (ctx, outbound) = ctx_with_outbound(dir.path());

        let out = SendFileTool
            .execute(json!({"path": "hello.md"}), &ctx)
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("queued"));
        let q = outbound.lock().unwrap();
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].filename, "hello.md");
        assert_eq!(q[0].mime_type, "text/markdown");
    }

    #[tokio::test]
    async fn rejects_path_outside_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, _) = ctx_with_outbound(dir.path());
        let err = SendFileTool
            .execute(json!({"path": "../etc/passwd"}), &ctx)
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::PathOutsideWorkspace(_)));
    }

    #[tokio::test]
    async fn rejects_when_no_outbound_channel() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.md"), "hi").unwrap();
        // No `with_outbound_files` — bare ctx.
        let ctx = ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            dir.path().to_path_buf(),
        );
        let err = SendFileTool
            .execute(json!({"path": "hello.md"}), &ctx)
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::Other(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn rejects_oversized_file() {
        let dir = tempfile::tempdir().unwrap();
        let big = vec![0u8; (MAX_BYTES as usize) + 1];
        std::fs::write(dir.path().join("big.bin"), big).unwrap();
        let (ctx, _) = ctx_with_outbound(dir.path());
        let err = SendFileTool
            .execute(json!({"path": "big.bin"}), &ctx)
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::Execution(_)));
    }

    #[tokio::test]
    async fn override_filename_lands() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("draft.md"), "x").unwrap();
        let (ctx, outbound) = ctx_with_outbound(dir.path());
        SendFileTool
            .execute(
                json!({"path": "draft.md", "filename": "report.md"}),
                &ctx,
            )
            .await
            .unwrap();
        let q = outbound.lock().unwrap();
        assert_eq!(q[0].filename, "report.md");
    }
}
