//! `ChatContext` → XML-ish system-prompt prefix.
//!
//! P0 placeholder: returns a structured stringification of the host-supplied
//! [`ChatContext`]. Real prompt assembly (with shared/project memory,
//! skills, recall pool) lives in `snaca-engine`'s editor runtime and is
//! wired in a later phase. Functions are kept unused for now;
//! `handle_chat_send` will call into `render_xml` once the engine arrives.

#![allow(dead_code)]

use snaca_editor_protocol::types::context::{ChatContext, Mention, ProjectType};

pub fn render_xml(ctx: &ChatContext) -> String {
    let mut out = String::with_capacity(256);
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
            p.main_file.as_deref().unwrap_or(""),
            p.engine.as_deref().unwrap_or(""),
        ));
    }

    if let Some(af) = &ctx.active_file {
        let cursor = af
            .cursor
            .map(|c| format!(" cursor=\"{}:{}\"", c.line, c.column))
            .unwrap_or_default();
        out.push_str(&format!(
            "  <active_file path=\"{}\" language=\"{}\"{}>\n",
            af.path, af.language, cursor
        ));
        if let Some(sel) = &af.selection {
            out.push_str(&format!(
                "    <selection range=\"{}:{}-{}:{}\">{}</selection>\n",
                sel.range.start.line,
                sel.range.start.column,
                sel.range.end.line,
                sel.range.end.column,
                escape_xml(&sel.text),
            ));
        }
        out.push_str("  </active_file>\n");
    }

    if let Some(tabs) = &ctx.open_tabs {
        out.push_str("  <open_tabs>\n");
        for t in tabs {
            let dirty = if t.dirty { " dirty=\"true\"" } else { "" };
            out.push_str(&format!("    <tab path=\"{}\"{}/>\n", t.path, dirty));
        }
        out.push_str("  </open_tabs>\n");
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

    out.push_str("</context>\n");
    out
}

fn render_mention(out: &mut String, m: &Mention) {
    match m {
        Mention::File { path, .. } => {
            out.push_str(&format!("    <file path=\"{}\"/>\n", path));
        }
        Mention::Folder { path } => {
            out.push_str(&format!("    <folder path=\"{}\"/>\n", path));
        }
        Mention::Symbol { path, name, .. } => {
            out.push_str(&format!(
                "    <symbol path=\"{}\" name=\"{}\"/>\n",
                path, name
            ));
        }
        Mention::Selection { path, .. } => {
            out.push_str(&format!("    <selection path=\"{}\"/>\n", path));
        }
        Mention::Url { url, .. } => {
            out.push_str(&format!("    <url href=\"{}\"/>\n", url));
        }
    }
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_editor_protocol::types::context::{
        ActiveFileContext, CursorPosition, OpenTab, ProjectMeta,
    };

    #[test]
    fn renders_minimal() {
        let ctx = ChatContext::default();
        let s = render_xml(&ctx);
        assert!(s.starts_with("<context>"));
        assert!(s.ends_with("</context>\n"));
    }

    #[test]
    fn renders_active_file_with_cursor() {
        let ctx = ChatContext {
            active_file: Some(ActiveFileContext {
                path: "/p/a.tex".into(),
                language: "latex".into(),
                cursor: Some(CursorPosition { line: 5, column: 10 }),
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
        use snaca_editor_protocol::types::context::SelectionInfo;
        use snaca_editor_protocol::types::range::{Position, Range};
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
    }
}
