//! `Skill` — a parsed markdown file with YAML frontmatter.

use crate::error::{SkillError, SkillResult};
use crate::scope::SkillScope;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Single skill: frontmatter + body, plus where it came from.
#[derive(Debug, Clone)]
pub struct Skill {
    pub frontmatter: SkillFrontmatter,
    /// Markdown body — everything after the closing `---`. Trimmed of a
    /// single leading newline so callers don't see double-blank prefixes.
    pub body: String,
    pub scope: SkillScope,
    /// Absolute path the skill was loaded from. `None` for bundled skills.
    pub source_path: Option<PathBuf>,
    /// Directory holding the skill's sidecar assets (scripts, fixtures,
    /// READMEs). Set for **directory-form skills** loaded from a folder
    /// containing `SKILL.md`. `None` for flat single-file skills.
    ///
    /// `SkillTool::execute` expands the `{{SKILL_DIR}}` token in the
    /// body to this path so skill instructions can reference their own
    /// scripts by absolute path.
    pub asset_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SkillFrontmatter {
    /// Required. Must be non-empty after trimming. The unique key for this
    /// skill within its scope; cross-scope collisions are resolved by
    /// `SkillScope::rank`.
    pub name: String,
    /// One-line summary surfaced to the LLM (in tool description / system prompt).
    #[serde(default)]
    pub description: String,
    /// Free-form hint to the LLM about when this skill is appropriate.
    /// Anthropic-style; may be empty if the description already covers it.
    #[serde(default)]
    pub when_to_use: String,
    /// Names of tools this skill is permitted to use. Informational in M2;
    /// the engine does not enforce yet.
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    /// Optional: model that should be preferred when running this skill.
    /// Engine reads this on activation to override its default.
    #[serde(default)]
    pub model: Option<String>,
}

impl Skill {
    pub fn from_str(
        content: &str,
        scope: SkillScope,
        source_path: Option<PathBuf>,
    ) -> SkillResult<Self> {
        let path_str = source_path
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "<inline>".to_string());

        let (raw_yaml, body) = split_frontmatter(content, &path_str)?;

        let fm: SkillFrontmatter =
            serde_yaml_ng::from_str(raw_yaml).map_err(|source| SkillError::Yaml {
                path: path_str.clone(),
                source,
            })?;

        if fm.name.trim().is_empty() {
            return Err(SkillError::MissingField {
                path: path_str,
                field: "name",
            });
        }

        // `split_frontmatter` already strips the single newline that
        // belongs to the closing `---\n` delimiter; whatever follows is
        // user-authored body and gets passed through verbatim so a blank
        // line between the closing fence and the first heading is preserved.
        Ok(Skill {
            frontmatter: fm,
            body: body.to_string(),
            scope,
            source_path,
            asset_dir: None,
        })
    }

    pub fn load(path: &Path, scope: SkillScope) -> SkillResult<Self> {
        let content = std::fs::read_to_string(path).map_err(|source| SkillError::Io {
            path: path.display().to_string(),
            source,
        })?;
        Self::from_str(&content, scope, Some(path.to_path_buf()))
    }

    /// Load a directory-form skill — a folder containing `SKILL.md`
    /// plus optional sidecar files (scripts, READMEs, fixtures). The
    /// skill's `asset_dir` is set to `dir`, which `SkillTool::execute`
    /// substitutes into the body wherever `{{SKILL_DIR}}` appears.
    ///
    /// Errors if `<dir>/SKILL.md` does not exist or fails to parse.
    pub fn load_directory(dir: &Path, scope: SkillScope) -> SkillResult<Self> {
        let manifest = dir.join("SKILL.md");
        let content = std::fs::read_to_string(&manifest).map_err(|source| SkillError::Io {
            path: manifest.display().to_string(),
            source,
        })?;
        let mut skill = Self::from_str(&content, scope, Some(manifest))?;
        skill.asset_dir = Some(dir.to_path_buf());
        Ok(skill)
    }

    pub fn name(&self) -> &str {
        &self.frontmatter.name
    }
}

/// Split a `---`-delimited frontmatter block off the front of `content`.
/// Returns `(yaml_str, body_str)`. Errors if the document doesn't start
/// with `---` or the closing delimiter is missing.
fn split_frontmatter<'a>(content: &'a str, path: &str) -> SkillResult<(&'a str, &'a str)> {
    // Skip a possible BOM, then require `---\n` (or `---\r\n`).
    let stripped = content.strip_prefix('\u{feff}').unwrap_or(content);
    let after_open = stripped
        .strip_prefix("---\n")
        .or_else(|| stripped.strip_prefix("---\r\n"))
        .ok_or_else(|| SkillError::MissingFrontmatter {
            path: path.to_string(),
        })?;

    // Find the closing `---` on its own line. We search for `\n---` then
    // verify it's followed by `\n`, `\r\n`, or end-of-input.
    let mut search_from = 0;
    let close_idx = loop {
        let rel = after_open[search_from..].find("\n---").ok_or_else(|| {
            SkillError::UnterminatedFrontmatter {
                path: path.to_string(),
            }
        })?;
        let abs = search_from + rel;
        let tail_start = abs + 4; // length of "\n---"
        let tail = &after_open[tail_start..];
        if tail.is_empty() || tail.starts_with('\n') || tail.starts_with("\r\n") {
            break abs;
        }
        // Spurious "---" embedded in YAML (e.g. inside a string). Keep searching.
        search_from = abs + 1;
    };

    let yaml = &after_open[..close_idx];
    // Move past "\n---" + the trailing newline (if any).
    let mut body_start = close_idx + 4;
    if let Some(rest) = after_open.get(body_start..) {
        if let Some(stripped) = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n')) {
            body_start += rest.len() - stripped.len();
        }
    }
    let body = &after_open[body_start.min(after_open.len())..];
    Ok((yaml, body))
}


#[cfg(test)]
mod tests {
    use super::*;

    fn parse(content: &str) -> Skill {
        Skill::from_str(content, SkillScope::Project, None).unwrap()
    }

    #[test]
    fn parses_standard_frontmatter() {
        let s = parse(
            "---\n\
             name: review\n\
             description: Review pending changes\n\
             when_to_use: When the user asks to review code\n\
             allowed_tools: [Read, Grep, Glob]\n\
             ---\n\
             # body\n\
             content here\n",
        );
        assert_eq!(s.frontmatter.name, "review");
        assert_eq!(s.frontmatter.description, "Review pending changes");
        assert_eq!(
            s.frontmatter.allowed_tools,
            vec!["Read", "Grep", "Glob"]
        );
        assert!(s.body.starts_with("# body"));
    }

    #[test]
    fn rejects_missing_open_delimiter() {
        let err = Skill::from_str("no frontmatter here", SkillScope::Project, None).unwrap_err();
        assert!(matches!(err, SkillError::MissingFrontmatter { .. }));
    }

    #[test]
    fn rejects_unterminated_frontmatter() {
        let err = Skill::from_str(
            "---\nname: x\nno closing\n",
            SkillScope::Project,
            None,
        )
        .unwrap_err();
        assert!(matches!(err, SkillError::UnterminatedFrontmatter { .. }));
    }

    #[test]
    fn rejects_empty_name() {
        let err = Skill::from_str(
            "---\nname: \"\"\ndescription: x\n---\nbody\n",
            SkillScope::Project,
            None,
        )
        .unwrap_err();
        assert!(matches!(err, SkillError::MissingField { field: "name", .. }));
    }

    #[test]
    fn invalid_yaml_surfaces_yaml_error() {
        let err = Skill::from_str(
            "---\nname: [oops\n---\nbody\n",
            SkillScope::Project,
            None,
        )
        .unwrap_err();
        assert!(matches!(err, SkillError::Yaml { .. }));
    }

    #[test]
    fn body_leading_newline_trimmed() {
        let s = parse("---\nname: x\n---\n\nactual body\n");
        assert_eq!(s.body, "\nactual body\n");
    }

    #[test]
    fn handles_crlf_line_endings() {
        let s = parse("---\r\nname: x\r\ndescription: y\r\n---\r\nbody\r\n");
        assert_eq!(s.frontmatter.name, "x");
        assert!(s.body.contains("body"));
    }

    #[test]
    fn defaults_for_optional_fields() {
        let s = parse("---\nname: minimal\n---\nthe content\n");
        assert_eq!(s.frontmatter.description, "");
        assert_eq!(s.frontmatter.when_to_use, "");
        assert!(s.frontmatter.allowed_tools.is_empty());
    }

    #[test]
    fn flat_load_leaves_asset_dir_none() {
        let s = parse("---\nname: x\n---\nbody\n");
        assert!(s.asset_dir.is_none());
    }

    #[test]
    fn load_directory_sets_asset_dir() {
        let dir = tempfile::tempdir().unwrap();
        let skill_dir = dir.path().join("office-extract");
        std::fs::create_dir(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: office-extract\ndescription: d\n---\nrun {{SKILL_DIR}}/x.py\n",
        )
        .unwrap();

        let s = Skill::load_directory(&skill_dir, SkillScope::Project).unwrap();
        assert_eq!(s.frontmatter.name, "office-extract");
        assert_eq!(s.asset_dir.as_deref(), Some(skill_dir.as_path()));
        assert!(s.body.contains("{{SKILL_DIR}}"));
    }

    #[test]
    fn load_directory_missing_manifest_is_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let skill_dir = dir.path().join("empty");
        std::fs::create_dir(&skill_dir).unwrap();
        let err = Skill::load_directory(&skill_dir, SkillScope::Project).unwrap_err();
        assert!(matches!(err, SkillError::Io { .. }));
    }
}
