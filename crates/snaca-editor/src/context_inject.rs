//! `ChatContext` → XML-ish system-prompt prefix.
//!
//! Renders the host-supplied [`ChatContext`] into a compact XML block that
//! `handle_chat_send` appends to the per-turn system prompt (via
//! `TurnRequest::ephemeral_system`). It rides the system prompt, not thread
//! history, so volatile editor state never persists across turns.
//!
//! Every field the host sends must be rendered here — dropping one means the
//! user's explicit signal (an `@file` mention's content, a diagnostic they
//! expect the model to see) silently vanishes before it reaches the model.

use snaca_editor_protocol::types::context::{
    ChatContext, DiagnosticSeverity, Mention, ProjectType,
};
use snaca_editor_protocol::types::range::Range;

/// Render the context, returning `None` when there is nothing to inject
/// (an empty `ChatContext` produces only the `<context></context>`
/// wrapper). Callers pass the `Some` value straight into
/// `TurnRequest::ephemeral_system`.
pub fn render_xml_opt(ctx: &ChatContext) -> Option<String> {
    let xml = render_xml(ctx);
    // Empty context = wrapper only. Any child element line makes it
    // non-empty; this is the single source of truth for that check
    // (`handler::build_system_prompt` delegates here).
    let has_children = xml
        .lines()
        .any(|l| !matches!(l.trim(), "" | "<context>" | "</context>"));
    if has_children {
        Some(xml)
    } else {
        None
    }
}

pub fn render_xml(ctx: &ChatContext) -> String {
    let mut out = String::with_capacity(512);
    out.push_str("<context>\n");

    if let Some(p) = &ctx.project {
        let ty = match p.project_type {
            ProjectType::Latex => "latex",
            ProjectType::Typst => "typst",
            ProjectType::Mixed => "mixed",
        };
        out.push_str(&format!(
            "  <project type=\"{}\" main=\"{}\" engine=\"{}\"/>\n",
            ty,
            escape_xml(p.main_file.as_deref().unwrap_or("")),
            escape_xml(p.engine.as_deref().unwrap_or("")),
        ));
    }

    if let Some(af) = &ctx.active_file {
        let mut attrs = String::new();
        if let Some(c) = af.cursor {
            attrs.push_str(&format!(" cursor=\"{}:{}\"", c.line, c.column));
        }
        if let Some(vr) = &af.visible_range {
            attrs.push_str(&format!(" visible_range=\"{}-{}\"", vr.start_line, vr.end_line));
        }
        if af.dirty == Some(true) {
            attrs.push_str(" dirty=\"true\"");
        }
        out.push_str(&format!(
            "  <active_file path=\"{}\" language=\"{}\"{}>\n",
            escape_xml(&af.path),
            escape_xml(&af.language),
            attrs
        ));
        if let Some(sel) = &af.selection {
            out.push_str(&format!(
                "    <selection range=\"{}\">{}</selection>\n",
                fmt_range(&sel.range),
                escape_xml(&sel.text),
            ));
        }
        out.push_str("  </active_file>\n");
    }

    if let Some(tabs) = &ctx.open_tabs {
        if !tabs.is_empty() {
            out.push_str("  <open_tabs>\n");
            for t in tabs {
                let dirty = if t.dirty { " dirty=\"true\"" } else { "" };
                out.push_str(&format!(
                    "    <tab path=\"{}\"{}/>\n",
                    escape_xml(&t.path),
                    dirty
                ));
            }
            out.push_str("  </open_tabs>\n");
        }
    }

    if let Some(edits) = &ctx.recent_edits {
        if !edits.is_empty() {
            out.push_str("  <recent_edits>\n");
            for e in edits {
                out.push_str(&format!(
                    "    <edit path=\"{}\" ts=\"{}\">{}</edit>\n",
                    escape_xml(&e.path),
                    escape_xml(&e.ts),
                    escape_xml(&e.summary)
                ));
            }
            out.push_str("  </recent_edits>\n");
        }
    }

    if let Some(mentions) = &ctx.mentions {
        if !mentions.is_empty() {
            out.push_str("  <mentions>\n");
            for m in mentions {
                render_mention(&mut out, m);
            }
            out.push_str("  </mentions>\n");
        }
    }

    if let Some(diags) = &ctx.diagnostics {
        if !diags.is_empty() {
            out.push_str("  <diagnostics>\n");
            for d in diags {
                let sev = match d.severity {
                    DiagnosticSeverity::Error => "error",
                    DiagnosticSeverity::Warning => "warning",
                    DiagnosticSeverity::Info => "info",
                };
                let range = d
                    .range
                    .as_ref()
                    .map(|r| format!(" range=\"{}\"", fmt_range(r)))
                    .unwrap_or_default();
                out.push_str(&format!(
                    "    <diagnostic path=\"{}\" severity=\"{}\"{}>{}</diagnostic>\n",
                    escape_xml(&d.path),
                    sev,
                    range,
                    escape_xml(&d.message)
                ));
            }
            out.push_str("  </diagnostics>\n");
        }
    }

    if let Some(intel) = &ctx.project_intel {
        if !intel.is_empty() {
            out.push_str("  <project_intel>\n");
            out.push_str(&escape_xml(intel));
            if !intel.ends_with('\n') {
                out.push('\n');
            }
            out.push_str("  </project_intel>\n");
        }
    }

    if let Some(key) = &ctx.active_zotero_item {
        out.push_str(&format!(
            "  <active_paper zotero_item=\"{}\"/>\n",
            escape_xml(key)
        ));
    }

    if let Some(section) = &ctx.markdown_section {
        out.push_str(&format!(
            "  <reading_section>{}</reading_section>\n",
            escape_xml(section)
        ));
    }

    out.push_str("</context>\n");
    out
}

fn render_mention(out: &mut String, m: &Mention) {
    match m {
        Mention::File {
            path,
            inline_content,
        } => match inline_content {
            // The host already truncates inline content (AtMentionResolver
            // caps it); render it verbatim so an explicit `@file` actually
            // delivers the file body to the model.
            Some(content) => out.push_str(&format!(
                "    <file path=\"{}\">{}</file>\n",
                escape_xml(path),
                escape_xml(content)
            )),
            None => out.push_str(&format!("    <file path=\"{}\"/>\n", escape_xml(path))),
        },
        Mention::Folder { path } => {
            out.push_str(&format!(
                "    <folder path=\"{}\"/>\n",
                escape_xml(path)
            ));
        }
        Mention::Symbol { path, name, range } => {
            out.push_str(&format!(
                "    <symbol path=\"{}\" name=\"{}\" range=\"{}\"/>\n",
                escape_xml(path),
                escape_xml(name),
                fmt_range(range)
            ));
        }
        Mention::Selection { path, range, text } => {
            out.push_str(&format!(
                "    <selection path=\"{}\" range=\"{}\">{}</selection>\n",
                escape_xml(path),
                fmt_range(range),
                escape_xml(text)
            ));
        }
        Mention::Url { url, content } => match content {
            Some(c) => out.push_str(&format!(
                "    <url href=\"{}\">{}</url>\n",
                escape_xml(url),
                escape_xml(c)
            )),
            None => out.push_str(&format!("    <url href=\"{}\"/>\n", escape_xml(url))),
        },
    }
}

/// `start.line:start.col-end.line:end.col` — matches the cursor/selection
/// attribute format used elsewhere in the prompt.
fn fmt_range(r: &Range) -> String {
    format!(
        "{}:{}-{}:{}",
        r.start.line, r.start.column, r.end.line, r.end.column
    )
}

/// Escape for XML text and double-quoted attribute values. Single pass —
/// the old triple-`replace` allocated an intermediate `String` per step.
fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_editor_protocol::types::context::{
        ActiveFileContext, CursorPosition, DiagnosticItem, OpenTab, ProjectMeta, RecentEdit,
        SelectionInfo, VisibleRange,
    };
    use snaca_editor_protocol::types::range::{Position, Range};

    #[test]
    fn renders_minimal() {
        let ctx = ChatContext::default();
        let s = render_xml(&ctx);
        assert!(s.starts_with("<context>"));
        assert!(s.ends_with("</context>\n"));
        assert!(render_xml_opt(&ctx).is_none());
    }

    #[test]
    fn renders_active_file_with_cursor() {
        let ctx = ChatContext {
            active_file: Some(ActiveFileContext {
                path: "/p/a.tex".into(),
                language: "latex".into(),
                cursor: Some(CursorPosition {
                    line: 5,
                    column: 10,
                }),
                visible_range: None,
                selection: None,
                dirty: None,
            }),
            ..Default::default()
        };
        let s = render_xml(&ctx);
        assert!(s.contains("path=\"/p/a.tex\""));
        assert!(s.contains("cursor=\"5:10\""));
    }

    #[test]
    fn renders_visible_range_and_dirty() {
        let ctx = ChatContext {
            active_file: Some(ActiveFileContext {
                path: "/p/a.tex".into(),
                language: "latex".into(),
                cursor: None,
                visible_range: Some(VisibleRange {
                    start_line: 12,
                    end_line: 40,
                }),
                selection: None,
                dirty: Some(true),
            }),
            ..Default::default()
        };
        let s = render_xml(&ctx);
        assert!(s.contains("visible_range=\"12-40\""));
        assert!(s.contains("dirty=\"true\""));
    }

    #[test]
    fn renders_project_and_tabs() {
        let ctx = ChatContext {
            project: Some(ProjectMeta {
                project_type: ProjectType::Latex,
                main_file: Some("main.tex".into()),
                engine: Some("xelatex".into()),
            }),
            open_tabs: Some(vec![
                OpenTab {
                    path: "/p/main.tex".into(),
                    dirty: false,
                },
                OpenTab {
                    path: "/p/a.tex".into(),
                    dirty: true,
                },
            ]),
            ..Default::default()
        };
        let s = render_xml(&ctx);
        assert!(s.contains("<project type=\"latex\""));
        assert!(s.contains("main=\"main.tex\""));
        assert!(s.contains("dirty=\"true\""));
    }

    #[test]
    fn escapes_selection_text() {
        let ctx = ChatContext {
            active_file: Some(ActiveFileContext {
                path: "/p/a.tex".into(),
                language: "latex".into(),
                cursor: None,
                visible_range: None,
                selection: Some(SelectionInfo {
                    range: Range::new(Position::new(0, 0), Position::new(0, 5)),
                    text: "a < b & c".into(),
                }),
                dirty: None,
            }),
            ..Default::default()
        };
        let s = render_xml(&ctx);
        assert!(s.contains("a &lt; b &amp; c"));
    }

    #[test]
    fn escapes_attribute_values() {
        let ctx = ChatContext {
            active_file: Some(ActiveFileContext {
                path: "/p/a & b<c>.tex".into(),
                language: "latex".into(),
                cursor: None,
                visible_range: None,
                selection: None,
                dirty: None,
            }),
            ..Default::default()
        };
        let s = render_xml(&ctx);
        assert!(
            s.contains("path=\"/p/a &amp; b&lt;c&gt;.tex\""),
            "path attribute must be escaped: {s}"
        );
    }

    #[test]
    fn renders_recent_edits() {
        let ctx = ChatContext {
            recent_edits: Some(vec![RecentEdit {
                path: "/p/intro.tex".into(),
                ts: "2026-10-12T10:00:00Z".into(),
                summary: "rewrote the lead paragraph".into(),
            }]),
            ..Default::default()
        };
        let s = render_xml(&ctx);
        assert!(s.contains("<recent_edits>"));
        assert!(s.contains("<edit path=\"/p/intro.tex\""));
        assert!(s.contains("rewrote the lead paragraph</edit>"));
        assert!(render_xml_opt(&ctx).is_some());
    }

    #[test]
    fn renders_diagnostics_with_severity() {
        let ctx = ChatContext {
            diagnostics: Some(vec![DiagnosticItem {
                path: "/p/main.tex".into(),
                severity: DiagnosticSeverity::Error,
                message: "Undefined control sequence \\foo".into(),
                range: Some(Range::new(Position::new(3, 1), Position::new(3, 5))),
            }]),
            ..Default::default()
        };
        let s = render_xml(&ctx);
        assert!(s.contains("<diagnostics>"));
        assert!(s.contains("severity=\"error\""));
        assert!(s.contains("range=\"3:1-3:5\""));
        assert!(s.contains("Undefined control sequence"));
    }

    #[test]
    fn renders_mention_inline_content_and_ranges() {
        let ctx = ChatContext {
            mentions: Some(vec![
                Mention::File {
                    path: "/p/refs.bib".into(),
                    inline_content: Some("@article{...}".into()),
                },
                Mention::File {
                    path: "/p/plain.tex".into(),
                    inline_content: None,
                },
                Mention::Selection {
                    path: "/p/a.tex".into(),
                    range: Range::new(Position::new(1, 0), Position::new(2, 4)),
                    text: "selected text".into(),
                },
            ]),
            ..Default::default()
        };
        let s = render_xml(&ctx);
        assert!(
            s.contains("<file path=\"/p/refs.bib\">@article{...}</file>"),
            "inline content of an @file mention must reach the model"
        );
        // No content → stays self-closing.
        assert!(s.contains("<file path=\"/p/plain.tex\"/>"));
        assert!(s.contains("<selection path=\"/p/a.tex\" range=\"1:0-2:4\">selected text</selection>"));
    }

    #[test]
    fn renders_project_intel_block() {
        let ctx = ChatContext {
            project_intel: Some("# Document\n\\documentclass{article}".into()),
            ..Default::default()
        };
        let s = render_xml(&ctx);
        assert!(s.contains("<project_intel>"));
        assert!(s.contains("\\documentclass{article}"));
        assert!(s.contains("</project_intel>"));
    }

    #[test]
    fn omits_project_intel_when_empty() {
        let ctx = ChatContext {
            project_intel: Some(String::new()),
            ..Default::default()
        };
        let s = render_xml(&ctx);
        assert!(!s.contains("project_intel"));
        assert!(render_xml_opt(&ctx).is_none());
    }

    #[test]
    fn renders_active_paper_and_reading_section() {
        let ctx = ChatContext {
            active_zotero_item: Some("8FXYZ123".into()),
            markdown_section: Some("3.2 Experimental Setup".into()),
            ..Default::default()
        };
        let s = render_xml(&ctx);
        assert!(s.contains("zotero_item=\"8FXYZ123\""));
        assert!(s.contains("<reading_section>3.2 Experimental Setup</reading_section>"));
        // 有内容时不再是空壳。
        assert!(render_xml_opt(&ctx).is_some());
    }

    #[test]
    fn empty_open_tabs_vec_is_treated_as_empty() {
        let ctx = ChatContext {
            open_tabs: Some(vec![]),
            ..Default::default()
        };
        assert!(render_xml_opt(&ctx).is_none());
    }
}
