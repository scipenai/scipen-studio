//! `Read` — read a file from the project workspace.
//!
//! Text files render `cat -n` style (right-aligned line number, tab,
//! content). Long lines are truncated to keep tool output bounded.
//!
//! Format-aware dispatch by extension:
//!  - `.pdf` → text extracted via `snaca_memory::pdf_extract`.
//!  - `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.bmp` → returned
//!    as a `ContentBlock::Image` so vision-capable models see the
//!    pixels. Non-vision models will get an "image not viewable"
//!    placeholder in the text fallback; that's accepted — sniffing
//!    model capabilities is the engine's job, not the tool's.
//!  - `.ipynb` → Jupyter cells rendered as fenced code / markdown,
//!    with outputs collapsed to a `=== output ===` segment.
//!  - `.docx` / `.xlsx` / `.pptx` → not parsed natively. Read returns
//!    a structured nudge naming the conventional `office-extract` skill
//!    so the model invokes that skill (which uses an out-of-process
//!    Python extractor) instead of seeing `<binary file: N bytes>`.
//!  - Anything else → plain UTF-8 text.

use async_trait::async_trait;
use data_encoding::BASE64;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_core::{ContentBlock, ImageSource};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use snaca_workspace::resolve_within;
use std::path::Path;

const DEFAULT_LIMIT: usize = 2000;
const MAX_LINE_CHARS: usize = 2000;
const MAX_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct ReadInput {
    path: String,
    /// 1-indexed line number to start reading from. Default 1.
    /// Text files only — ignored for PDF / image / notebook.
    #[serde(default)]
    offset: Option<usize>,
    /// Maximum number of lines to return. Default 2000.
    /// Text files only.
    #[serde(default)]
    limit: Option<usize>,
    /// PDF only. Page range in `N` or `N-M` form (1-indexed,
    /// inclusive). Default: all pages. Note: `pdf-extract` returns
    /// a single string for the whole document, so the page filter
    /// applies on the form-feed-separated split — accurate for most
    /// PDFs, best-effort on documents with non-standard pagination.
    #[serde(default)]
    pages: Option<String>,
}

pub struct ReadTool;

#[async_trait]
impl Tool for ReadTool {
    fn name(&self) -> &str {
        "Read"
    }

    fn description(&self) -> &str {
        "Read a file from the project workspace. Returns the file contents \
         numbered like `cat -n`. Path is relative to the project workspace \
         root; absolute paths are rejected unless they are inside the root."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file relative to the project workspace root. Text, PDF, image, and Jupyter notebook formats are recognised."
                },
                "offset": {
                    "type": "integer",
                    "description": "1-indexed line number to start at. Default 1. Text files only.",
                    "minimum": 1
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of lines to return. Default 2000. Text files only.",
                    "minimum": 1
                },
                "pages": {
                    "type": "string",
                    "description": "PDF page range (e.g. \"1-5\" or \"3\"). Default: all pages."
                }
            },
            "required": ["path"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::read_only_filesystem()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input: ReadInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        let resolved = resolve_within(ctx.workspace_root(), Path::new(&input.path))
            .map_err(|e| ToolError::PathOutsideWorkspace(e.to_string()))?;

        let metadata = match tokio::fs::metadata(&resolved).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(ToolError::NotFound(input.path));
            }
            Err(e) => return Err(ToolError::Io(e)),
        };
        if !metadata.is_file() {
            return Err(ToolError::InvalidInput(format!(
                "{} is not a regular file",
                input.path
            )));
        }
        if metadata.len() > MAX_BYTES {
            return Err(ToolError::Execution(format!(
                "{} is {} bytes; refusing to read more than {} bytes (use offset/limit)",
                input.path,
                metadata.len(),
                MAX_BYTES
            )));
        }

        let bytes = tokio::fs::read(&resolved).await?;

        // Record the read so a subsequent Edit knows we've seen this
        // path at this size/mtime. Use the pre-read metadata — that's
        // the view the model is responding to. If reading mtime fails
        // (filesystem doesn't expose it) we silently skip recording;
        // Edit's check will then trip and the model will be told to
        // re-Read, which is the right escape hatch.
        if let Ok(mtime) = metadata.modified() {
            ctx.record_read(&resolved, mtime, metadata.len());
        }

        // Format-aware dispatch by lowercased extension. Falls through
        // to plain-text rendering when the extension is unknown.
        let ext = resolved
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase());
        if let Some(ext) = ext.as_deref() {
            match ext {
                "pdf" => return render_pdf(&bytes, input.pages.as_deref(), &input.path),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => {
                    return render_image(&bytes, ext);
                }
                "ipynb" => return render_notebook(&bytes, &input.path),
                "docx" | "xlsx" | "pptx" => {
                    return Ok(ToolOutput::text(office_nudge(ext, bytes.len())));
                }
                _ => {}
            }
        }

        // Quick binary detection on the bytes: any NUL byte → treat
        // as binary. (PDF / image / notebook branches above don't go
        // through this check because they handle their own formats.)
        if bytes.contains(&0) {
            return Ok(ToolOutput::text(format!(
                "<binary file: {} bytes>",
                bytes.len()
            )));
        }

        let text = String::from_utf8_lossy(&bytes);
        let offset = input.offset.unwrap_or(1).saturating_sub(1);
        let limit = input.limit.unwrap_or(DEFAULT_LIMIT);

        // Walk lines once for output, once for the total so we can
        // tell Edit / MultiEdit whether the model has the whole file
        // in context or only a slice. The total-count walk is cheap on
        // the 5 MiB cap and saves us a more invasive refactor.
        let total_lines = text.lines().count();
        let mut out = String::new();
        for (idx, line) in text.lines().enumerate().skip(offset).take(limit) {
            let line_num = idx + 1;
            let truncated: String = line.chars().take(MAX_LINE_CHARS).collect();
            out.push_str(&format!("{:>6}\t{}\n", line_num, truncated));
            if line.chars().count() > MAX_LINE_CHARS {
                out.push_str("       \t<line truncated>\n");
            }
        }
        if out.is_empty() {
            out.push_str("<empty file or offset past end>\n");
        }

        // Upgrade the read-tracker entry now that we know whether the
        // model is looking at a full file or only a slice. The early
        // `record_read` above already recorded as full-view (the
        // common case for PDF / image / notebook formats too). For
        // text reads, override with the precise flag — Edit refuses
        // partial entries.
        let is_partial = offset > 0 || total_lines.saturating_sub(offset) > limit;
        if let Ok(mtime) = metadata.modified() {
            ctx.record_partial_read(&resolved, mtime, metadata.len(), is_partial);
        }
        Ok(ToolOutput::text(out))
    }
}

/// Extract text from a PDF. `pages` accepts `N` or `N-M` (1-indexed,
/// inclusive). The `pdf-extract` crate returns a single string for
/// the document; we split on form-feed (`\x0C`) — the standard page
/// separator that `pdf-extract` emits — and slice. PDFs that don't
/// emit form feeds collapse to a single page; in that case the slice
/// is best-effort.
fn render_pdf(bytes: &[u8], pages: Option<&str>, path: &str) -> ToolResult {
    let raw = snaca_memory::pdf_extract::extract(bytes).map_err(|e| {
        ToolError::Execution(format!("pdf parse failed for {path}: {e}"))
    })?;
    let split: Vec<&str> = raw.split('\x0C').collect();
    let selected = if let Some(range) = pages {
        let (lo, hi) = parse_page_range(range, split.len())?;
        split[lo..=hi].join("\n--- page break ---\n")
    } else {
        raw
    };
    Ok(ToolOutput::text(selected))
}

fn parse_page_range(range: &str, total: usize) -> Result<(usize, usize), ToolError> {
    if total == 0 {
        return Err(ToolError::Execution(
            "PDF has no extractable pages".into(),
        ));
    }
    let parse = |s: &str| -> Result<usize, ToolError> {
        s.trim()
            .parse::<usize>()
            .map_err(|e| ToolError::InvalidInput(format!("invalid page number {s:?}: {e}")))
            .and_then(|n| {
                if n == 0 {
                    Err(ToolError::InvalidInput(
                        "pages are 1-indexed; 0 is not valid".into(),
                    ))
                } else {
                    Ok(n - 1)
                }
            })
    };
    let (lo, hi) = if let Some((a, b)) = range.split_once('-') {
        (parse(a)?, parse(b)?)
    } else {
        let p = parse(range)?;
        (p, p)
    };
    if lo > hi {
        return Err(ToolError::InvalidInput(format!(
            "page range {range:?}: lower bound exceeds upper"
        )));
    }
    let hi = hi.min(total - 1);
    let lo = lo.min(hi);
    Ok((lo, hi))
}

/// Build the nudge string returned for `.docx` / `.xlsx` / `.pptx`.
/// Read does not extract these formats; instead it tells the model
/// to invoke the conventional `office-extract` skill, which ships as
/// a directory-form skill operators install separately (see
/// `data-lark/example-skills/office-extract/`).
fn office_nudge(ext: &str, byte_len: usize) -> String {
    format!(
        "<office file: {ext}, {byte_len} bytes>\n\
         This format is not parsed by Read. Invoke the `office-extract` skill \
         (or the equivalent skill your operator has installed) and follow its \
         instructions to extract the text via an out-of-process script."
    )
}

/// Wrap raw image bytes into a `ContentBlock::Image` so vision-capable
/// models see the pixels directly. Non-vision providers will get an
/// `<image: media/type>` placeholder if some other path renders this
/// block to text — that fallback lives in `ToolOutput::render_text`.
fn render_image(bytes: &[u8], ext: &str) -> ToolResult {
    let media = match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    };
    let encoded = BASE64.encode(bytes);
    Ok(ToolOutput::blocks(vec![ContentBlock::Image {
        source: ImageSource::Base64 {
            media_type: media.to_string(),
            data: encoded,
        },
    }]))
}

/// Render a Jupyter notebook (.ipynb) — minimum-effort transformation
/// to text that mirrors how a model would naturally consume cells:
/// markdown cells flow inline, code cells get a fenced block, outputs
/// collapse to an `=== output ===` segment with the text streams
/// concatenated. Non-text outputs (images, html) are noted by type
/// rather than rendered — most chat-LLM contexts wouldn't surface them
/// usefully even if expanded.
fn render_notebook(bytes: &[u8], path: &str) -> ToolResult {
    let nb: Value = serde_json::from_slice(bytes).map_err(|e| {
        ToolError::Execution(format!("ipynb parse failed for {path}: {e}"))
    })?;
    let cells = nb.get("cells").and_then(|c| c.as_array()).ok_or_else(|| {
        ToolError::Execution(format!("{path} has no `cells` array"))
    })?;
    let lang = nb
        .pointer("/metadata/kernelspec/language")
        .and_then(|v| v.as_str())
        .or_else(|| {
            nb.pointer("/metadata/language_info/name")
                .and_then(|v| v.as_str())
        })
        .unwrap_or("python");

    let mut out = String::new();
    for (idx, cell) in cells.iter().enumerate() {
        let kind = cell
            .get("cell_type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let source = join_source(cell.get("source"));
        out.push_str(&format!("--- cell {} ({}) ---\n", idx + 1, kind));
        match kind {
            "markdown" | "raw" => {
                out.push_str(&source);
                if !source.ends_with('\n') {
                    out.push('\n');
                }
            }
            "code" => {
                out.push_str("```");
                out.push_str(lang);
                out.push('\n');
                out.push_str(&source);
                if !source.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str("```\n");
                if let Some(outputs) = cell.get("outputs").and_then(|v| v.as_array()) {
                    if !outputs.is_empty() {
                        out.push_str("=== output ===\n");
                        for o in outputs {
                            render_cell_output(o, &mut out);
                        }
                    }
                }
            }
            _ => {
                out.push_str(&source);
                out.push('\n');
            }
        }
    }
    Ok(ToolOutput::text(out))
}

fn join_source(src: Option<&Value>) -> String {
    match src {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str())
            .collect::<Vec<_>>()
            .concat(),
        _ => String::new(),
    }
}

fn render_cell_output(output: &Value, dst: &mut String) {
    let kind = output.get("output_type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "stream" => {
            let text = join_source(output.get("text"));
            dst.push_str(&text);
            if !text.ends_with('\n') {
                dst.push('\n');
            }
        }
        "execute_result" | "display_data" => {
            if let Some(data) = output.get("data").and_then(|v| v.as_object()) {
                if let Some(text) = data.get("text/plain").map(|v| join_source(Some(v))) {
                    dst.push_str(&text);
                    if !text.ends_with('\n') {
                        dst.push('\n');
                    }
                }
                // Non-text mime bundles get a one-line note rather
                // than the bytes.
                for mime in data.keys() {
                    if mime != "text/plain" {
                        dst.push_str(&format!("<output: {mime}>\n"));
                    }
                }
            }
        }
        "error" => {
            let ename = output.get("ename").and_then(|v| v.as_str()).unwrap_or("");
            let evalue = output.get("evalue").and_then(|v| v.as_str()).unwrap_or("");
            dst.push_str(&format!("Error: {ename}: {evalue}\n"));
        }
        _ => {
            dst.push_str(&format!("<output: {kind}>\n"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, SessionId, TenantId};

    fn ctx(root: &Path) -> ToolContext {
        ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            root.to_path_buf(),
        )
    }

    #[tokio::test]
    async fn reads_file_with_line_numbers() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, "alpha\nbeta\ngamma\n").unwrap();

        let out = ReadTool
            .execute(json!({"path": "a.txt"}), &ctx(dir.path()))
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("     1\talpha"));
        assert!(out.contains("     2\tbeta"));
        assert!(out.contains("     3\tgamma"));
    }

    #[tokio::test]
    async fn offset_and_limit_are_honored() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, "1\n2\n3\n4\n5\n").unwrap();

        let out = ReadTool
            .execute(
                json!({"path": "a.txt", "offset": 2, "limit": 2}),
                &ctx(dir.path()),
            )
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("     2\t2"));
        assert!(out.contains("     3\t3"));
        assert!(!out.contains("     1\t"));
        assert!(!out.contains("     4\t"));
    }

    #[tokio::test]
    async fn rejects_path_outside_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let err = ReadTool
            .execute(json!({"path": "../etc/passwd"}), &ctx(dir.path()))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::PathOutsideWorkspace(_)));
    }

    #[tokio::test]
    async fn detects_binary_files() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("bin.dat");
        std::fs::write(&f, [0x00, 0xff, 0xab]).unwrap();
        let out = ReadTool
            .execute(json!({"path": "bin.dat"}), &ctx(dir.path()))
            .await
            .unwrap()
            .render_text();
        assert!(out.starts_with("<binary file"));
    }

    #[tokio::test]
    async fn office_formats_return_skill_nudge_not_binary_fallback() {
        // Minimal valid ZIP magic — enough to mimic an OOXML container.
        const ZIP_MAGIC: &[u8] = &[0x50, 0x4b, 0x03, 0x04];
        let dir = tempfile::tempdir().unwrap();
        for ext in &["docx", "xlsx", "pptx"] {
            let path = dir.path().join(format!("sample.{ext}"));
            std::fs::write(&path, ZIP_MAGIC).unwrap();
            let out = ReadTool
                .execute(
                    json!({"path": format!("sample.{ext}")}),
                    &ctx(dir.path()),
                )
                .await
                .unwrap()
                .render_text();
            assert!(
                out.contains("office-extract"),
                "missing skill nudge for {ext}: {out}"
            );
            assert!(
                !out.starts_with("<binary file"),
                "office formats must not fall through to <binary file> for {ext}: {out}"
            );
        }
    }

    #[tokio::test]
    async fn missing_file_returns_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let err = ReadTool
            .execute(json!({"path": "nope.txt"}), &ctx(dir.path()))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::NotFound(_)));
    }

    #[tokio::test]
    async fn image_returns_blocks_output() {
        // 1x1 transparent PNG (minimal valid PNG bytes).
        const PNG_1X1: &[u8] = &[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ];
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("pixel.png"), PNG_1X1).unwrap();

        let out = ReadTool
            .execute(json!({"path": "pixel.png"}), &ctx(dir.path()))
            .await
            .unwrap();
        match out {
            ToolOutput::Blocks(blocks) => {
                assert_eq!(blocks.len(), 1);
                match &blocks[0] {
                    ContentBlock::Image {
                        source: ImageSource::Base64 { media_type, data },
                    } => {
                        assert_eq!(media_type, "image/png");
                        assert!(!data.is_empty());
                    }
                    other => panic!("expected base64 image, got {other:?}"),
                }
            }
            other => panic!("expected Blocks output, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn notebook_renders_cells_and_outputs() {
        let nb = json!({
            "cells": [
                {
                    "cell_type": "markdown",
                    "source": ["# Title\n", "Some prose"],
                },
                {
                    "cell_type": "code",
                    "source": "print('hi')",
                    "outputs": [
                        {"output_type": "stream", "name": "stdout", "text": "hi\n"}
                    ]
                }
            ],
            "metadata": {"kernelspec": {"language": "python"}}
        });
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("nb.ipynb"),
            serde_json::to_vec(&nb).unwrap(),
        )
        .unwrap();
        let out = ReadTool
            .execute(json!({"path": "nb.ipynb"}), &ctx(dir.path()))
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("# Title"));
        assert!(out.contains("```python"));
        assert!(out.contains("print('hi')"));
        assert!(out.contains("=== output ==="));
        assert!(out.contains("hi"));
    }

    #[tokio::test]
    async fn notebook_with_error_output_renders_traceback() {
        let nb = json!({
            "cells": [{
                "cell_type": "code",
                "source": "1/0",
                "outputs": [
                    {"output_type": "error", "ename": "ZeroDivisionError", "evalue": "division by zero"}
                ]
            }],
        });
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("nb.ipynb"),
            serde_json::to_vec(&nb).unwrap(),
        )
        .unwrap();
        let out = ReadTool
            .execute(json!({"path": "nb.ipynb"}), &ctx(dir.path()))
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("ZeroDivisionError"));
        assert!(out.contains("division by zero"));
    }

    #[test]
    fn page_range_parses_single_and_dashed_forms() {
        assert_eq!(parse_page_range("3", 10).unwrap(), (2, 2));
        assert_eq!(parse_page_range("2-5", 10).unwrap(), (1, 4));
        // Upper bound clamps to total.
        assert_eq!(parse_page_range("8-99", 10).unwrap(), (7, 9));
    }

    #[test]
    fn page_range_rejects_zero_and_inversion() {
        assert!(parse_page_range("0", 10).is_err());
        assert!(parse_page_range("5-2", 10).is_err());
        assert!(parse_page_range("abc", 10).is_err());
    }

    #[tokio::test]
    async fn records_into_read_tracker_when_attached() {
        use snaca_workspace::resolve_within;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hi\n").unwrap();

        let tracker: snaca_tools_api::ReadTracker =
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
        let c = ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            dir.path().to_path_buf(),
        )
        .with_read_tracker(tracker.clone());

        ReadTool
            .execute(json!({"path": "a.txt"}), &c)
            .await
            .unwrap();

        let resolved = resolve_within(dir.path(), Path::new("a.txt")).unwrap();
        let rec = c.last_read(&resolved).expect("tracker entry missing");
        assert_eq!(rec.size, 3);
        // Sanity: same record visible through the original tracker handle.
        assert!(tracker.lock().unwrap().contains_key(&resolved));
    }
}
