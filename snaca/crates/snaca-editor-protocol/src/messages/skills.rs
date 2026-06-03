//! `skills.*` RPC — read-only viewer for the project / tenant skill
//! libraries.
//!
//! Skills are `.md` files (or `SKILL.md` inside a directory) maintained
//! by developers using their editor of choice. SNACA loads them at engine
//! build time and exposes them to the LLM via the SkillTool; this RPC
//! lets the host introspect what's loaded so users can verify a skill
//! file took effect.
//!
//! Write/delete are intentionally not provided — the canonical edit
//! workflow is "open the .md in the editor, save, then `skills.reload`".

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    /// Bundled with SNACA itself. Not editable.
    Bundled,
    /// Operator-supplied global dir, shared across tenants.
    Global,
    /// `<data_root>/<tenant>/skills/`
    Tenant,
    /// `<data_root>/<tenant>/projects/<project>/skills/`
    Project,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillSummary {
    pub scope: SkillScope,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when_to_use: Option<String>,
    /// Tool names this skill is permitted to invoke when active. Empty
    /// vec means "no restriction" (informational in current engine).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
    /// Absolute path to the skill's `.md` (flat) or `SKILL.md` (directory
    /// form). Used by the host to surface "reveal in folder" / "open in
    /// editor" affordances. Empty when the skill is bundled.
    pub source_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillDetail {
    pub scope: SkillScope,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when_to_use: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
    pub source_path: String,
    /// Markdown body (post-frontmatter). Frontmatter fields stay on the
    /// struct, not duplicated here.
    pub body: String,
}

// ---------------- skills.list ----------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillsListParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillsListResult {
    pub skills: Vec<SkillSummary>,
}

// ---------------- skills.get ----------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillsGetParams {
    pub session_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillsGetResult {
    pub skill: SkillDetail,
}

// ---------------- skills.reload ----------------

/// Host calls this after the user edits a skill `.md` in their editor.
/// Implementations may be a no-op when the registry is rebuilt on every
/// list — the call exists so the wire surface mirrors the user's mental
/// model ("I edited the file, now reload").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillsReloadParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillsReloadResult {
    pub reloaded: bool,
}
