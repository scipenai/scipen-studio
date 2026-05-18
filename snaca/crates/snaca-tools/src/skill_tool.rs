//! `SkillTool` — exposes the skill registry to the LLM as a single tool.
//!
//! Design choice: rather than registering each skill as its own tool (which
//! bloats the tool list and the schema cache), we expose one `Skill` tool
//! whose `description` enumerates available skills and whose `name`
//! parameter is constrained to the registry's keys via JSON Schema `enum`.
//! On invocation, the tool returns the skill's body as plain text — the
//! LLM treats the body as additional instructions for the rest of the turn.
//!
//! ## Body template expansion
//!
//! Directory-form skills (those loaded from a folder containing
//! `SKILL.md` plus sidecar assets) carry an `asset_dir`. Before
//! returning the body we substitute the single token `{{SKILL_DIR}}`
//! with that absolute path, so a skill can instruct the model to run
//! `python3 {{SKILL_DIR}}/scripts/extract.py <path>` and have the model
//! see a real, resolved path. Flat-form skills (no `asset_dir`) using
//! the token surface a clear error rather than emitting a literal
//! `{{SKILL_DIR}}` the model would then mistake for a real path.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_skills::SkillRegistry;
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};

#[derive(Debug, Deserialize)]
struct SkillToolInput {
    name: String,
}

pub struct SkillTool {
    registry: SkillRegistry,
    description: String,
    schema: Value,
}

impl SkillTool {
    pub fn new(registry: SkillRegistry) -> Self {
        let description = build_description(&registry);
        let schema = build_schema(&registry);
        Self {
            registry,
            description,
            schema,
        }
    }

    pub fn registry(&self) -> &SkillRegistry {
        &self.registry
    }
}

#[async_trait]
impl Tool for SkillTool {
    fn name(&self) -> &str {
        "Skill"
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn input_schema(&self) -> Value {
        self.schema.clone()
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::default()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, _ctx: &ToolContext) -> ToolResult {
        let SkillToolInput { name } =
            serde_json::from_value(input).map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        let skill = self.registry.get(&name).ok_or_else(|| {
            ToolError::NotFound(format!("skill '{name}' is not registered"))
        })?;
        let body = expand_skill_dir(&skill.body, skill.asset_dir.as_deref(), &name)?;
        Ok(ToolOutput::text(body))
    }
}

/// Replace `{{SKILL_DIR}}` in `body` with the absolute path of the
/// skill's asset directory. If the body uses the token but the skill
/// was loaded in flat form (no asset dir), return a clear error rather
/// than letting the literal token reach the model.
fn expand_skill_dir(
    body: &str,
    asset_dir: Option<&std::path::Path>,
    skill_name: &str,
) -> Result<String, ToolError> {
    const TOKEN: &str = "{{SKILL_DIR}}";
    if !body.contains(TOKEN) {
        return Ok(body.to_string());
    }
    let dir = asset_dir.ok_or_else(|| {
        ToolError::Execution(format!(
            "skill '{skill_name}' uses {{{{SKILL_DIR}}}} but is loaded as a flat-form (.md) skill. \
             Convert it to a directory-form skill (`<skill>/SKILL.md` with sidecar files) so the \
             token can be resolved."
        ))
    })?;
    Ok(body.replace(TOKEN, &dir.display().to_string()))
}

fn build_description(registry: &SkillRegistry) -> String {
    let mut s = String::new();
    s.push_str(
        "Activate a registered skill. Returns the skill's instruction body, \
         which you should follow for the remainder of the turn. Pick a skill \
         only when its 'when_to_use' matches the user's request.",
    );
    if registry.is_empty() {
        s.push_str("\n\n(No skills are currently registered.)");
        return s;
    }
    s.push_str("\n\nAvailable skills:");
    let mut entries: Vec<&snaca_skills::Skill> = registry.iter().collect();
    entries.sort_by(|a, b| a.name().cmp(b.name()));
    for skill in entries {
        let fm = &skill.frontmatter;
        s.push_str(&format!("\n- `{}`: {}", fm.name, fm.description.trim()));
        if !fm.when_to_use.trim().is_empty() {
            s.push_str(&format!(" — use when: {}", fm.when_to_use.trim()));
        }
    }
    s
}

fn build_schema(registry: &SkillRegistry) -> Value {
    let mut names: Vec<String> = registry.names().map(String::from).collect();
    names.sort();
    let name_prop = if names.is_empty() {
        json!({
            "type": "string",
            "description": "Skill name to activate. (No skills currently registered.)"
        })
    } else {
        json!({
            "type": "string",
            "description": "Skill name to activate.",
            "enum": names
        })
    };
    json!({
        "type": "object",
        "properties": { "name": name_prop },
        "required": ["name"]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, SessionId, TenantId};
    use snaca_skills::{Skill, SkillRegistry, SkillScope};
    use std::path::Path;

    fn ctx(root: &Path) -> ToolContext {
        ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            root.to_path_buf(),
        )
    }

    fn skill(name: &str, body: &str) -> Skill {
        let raw = format!(
            "---\nname: {name}\ndescription: {name} desc\nwhen_to_use: when {name}\n---\n{body}\n"
        );
        Skill::from_str(&raw, SkillScope::Project, None).unwrap()
    }

    #[tokio::test]
    async fn returns_skill_body_on_invocation() {
        let reg = SkillRegistry::from_skills(vec![skill("review", "review body content")]);
        let tool = SkillTool::new(reg);
        let dir = tempfile::tempdir().unwrap();
        let out = tool
            .execute(json!({"name": "review"}), &ctx(dir.path()))
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("review body content"));
    }

    #[tokio::test]
    async fn unknown_skill_yields_not_found() {
        let reg = SkillRegistry::from_skills(vec![skill("a", "x")]);
        let tool = SkillTool::new(reg);
        let dir = tempfile::tempdir().unwrap();
        let err = tool
            .execute(json!({"name": "nope"}), &ctx(dir.path()))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::NotFound(_)));
    }

    #[test]
    fn description_lists_available_skills_alphabetically() {
        let reg = SkillRegistry::from_skills(vec![
            skill("review", "x"),
            skill("audit", "y"),
            skill("test", "z"),
        ]);
        let tool = SkillTool::new(reg);
        let desc = tool.description();
        assert!(desc.contains("- `audit`"));
        assert!(desc.contains("- `review`"));
        let audit_idx = desc.find("- `audit`").unwrap();
        let review_idx = desc.find("- `review`").unwrap();
        let test_idx = desc.find("- `test`").unwrap();
        assert!(audit_idx < review_idx);
        assert!(review_idx < test_idx);
    }

    #[test]
    fn description_handles_empty_registry() {
        let tool = SkillTool::new(SkillRegistry::empty());
        assert!(tool.description().contains("No skills"));
    }

    #[tokio::test]
    async fn expands_skill_dir_token_for_directory_form() {
        let dir = tempfile::tempdir().unwrap();
        let skill_dir = dir.path().join("office");
        std::fs::create_dir(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: office\ndescription: d\n---\nrun {{SKILL_DIR}}/scripts/x.py\n",
        )
        .unwrap();
        let s = Skill::load_directory(&skill_dir, SkillScope::Project).unwrap();
        let reg = SkillRegistry::from_skills(vec![s]);
        let tool = SkillTool::new(reg);
        let workspace = tempfile::tempdir().unwrap();
        let out = tool
            .execute(json!({"name": "office"}), &ctx(workspace.path()))
            .await
            .unwrap()
            .render_text();
        let expected = format!("{}/scripts/x.py", skill_dir.display());
        assert!(out.contains(&expected), "got: {out}");
        assert!(!out.contains("{{SKILL_DIR}}"));
    }

    #[tokio::test]
    async fn flat_form_with_skill_dir_token_errors() {
        let reg = SkillRegistry::from_skills(vec![skill(
            "bad",
            "use {{SKILL_DIR}}/whatever",
        )]);
        let tool = SkillTool::new(reg);
        let dir = tempfile::tempdir().unwrap();
        let err = tool
            .execute(json!({"name": "bad"}), &ctx(dir.path()))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::Execution(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn body_without_token_passes_through_unchanged() {
        let reg = SkillRegistry::from_skills(vec![skill("plain", "no tokens {{here}}")]);
        let tool = SkillTool::new(reg);
        let dir = tempfile::tempdir().unwrap();
        let out = tool
            .execute(json!({"name": "plain"}), &ctx(dir.path()))
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("{{here}}"));
    }

    #[test]
    fn schema_constrains_name_to_enum_when_skills_present() {
        let reg = SkillRegistry::from_skills(vec![skill("a", "x"), skill("b", "y")]);
        let tool = SkillTool::new(reg);
        let schema = tool.input_schema();
        let enum_vals = schema
            .pointer("/properties/name/enum")
            .expect("enum constraint")
            .as_array()
            .unwrap();
        let names: Vec<&str> = enum_vals.iter().filter_map(Value::as_str).collect();
        assert_eq!(names, vec!["a", "b"]);
    }
}
