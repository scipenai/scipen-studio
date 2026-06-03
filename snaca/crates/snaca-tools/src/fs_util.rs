//! Filesystem helpers shared across file-touching tools.

use snaca_tools_api::ToolError;
use std::path::Path;

/// Stat a path and translate I/O errors into the per-tool taxonomy.
///
/// `NotFound` becomes a typed `ToolError::NotFound` carrying the
/// user-supplied path (so the model sees the same string it gave us);
/// every other I/O error is forwarded as `ToolError::Io`.
///
/// `display_path` is the model-supplied path (pre-resolution) — keep it
/// in errors so the message points at what the model asked for, not the
/// absolute path on disk.
pub async fn metadata_or_not_found(
    resolved: &Path,
    display_path: impl Into<String>,
) -> Result<std::fs::Metadata, ToolError> {
    match tokio::fs::metadata(resolved).await {
        Ok(m) => Ok(m),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(ToolError::NotFound(display_path.into()))
        }
        Err(e) => Err(ToolError::Io(e)),
    }
}
