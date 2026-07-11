//! `skills.*` RPC handlers — read-only viewer over the project / tenant
//! skill libraries. Builds a fresh `SkillRegistry` on every call so an
//! editor-side `.md` change shows up immediately after a single
//! `skills.reload` round-trip; skill counts are tiny so the cost is
//! negligible.

use crate::session_manager::SessionManager;
use snaca_editor_protocol::error::{ErrorCode, ProtocolError};
use snaca_editor_protocol::messages::skills::{
    SkillDetail, SkillScope as WireScope, SkillSummary, SkillsGetParams, SkillsGetResult,
    SkillsListParams, SkillsListResult, SkillsReloadParams, SkillsReloadResult,
};
use snaca_skills::{Skill, SkillRegistry, SkillRegistryBuilder, SkillScope};

fn scope_to_wire(s: SkillScope) -> WireScope {
    match s {
        SkillScope::Bundled => WireScope::Bundled,
        SkillScope::Global => WireScope::Global,
        SkillScope::Tenant => WireScope::Tenant,
        SkillScope::Project => WireScope::Project,
    }
}

async fn build_registry_async(
    sessions: &SessionManager,
    session_id: &str,
) -> Result<SkillRegistry, ProtocolError> {
    let (project_dir, tenant_dir, bundled_dir) = sessions.skills_dirs_for(session_id).await?;
    let mut builder = SkillRegistryBuilder::default();
    // Bundled (lowest) scanned first; tenant/project override by scope rank.
    if let Some(dir) = &bundled_dir {
        if let Err(e) = builder.add_from_dir(dir, SkillScope::Bundled) {
            return Err(ProtocolError::new(
                ErrorCode::InternalError,
                format!("load bundled skills failed: {e}"),
            ));
        }
    }
    if let Err(e) = builder.add_from_dir(&tenant_dir, SkillScope::Tenant) {
        return Err(ProtocolError::new(
            ErrorCode::InternalError,
            format!("load tenant skills failed: {e}"),
        ));
    }
    if let Err(e) = builder.add_from_dir(&project_dir, SkillScope::Project) {
        return Err(ProtocolError::new(
            ErrorCode::InternalError,
            format!("load project skills failed: {e}"),
        ));
    }
    Ok(builder.build())
}

fn to_summary(s: &Skill) -> SkillSummary {
    SkillSummary {
        scope: scope_to_wire(s.scope),
        name: s.frontmatter.name.clone(),
        description: non_empty(&s.frontmatter.description),
        when_to_use: non_empty(&s.frontmatter.when_to_use),
        allowed_tools: s.frontmatter.allowed_tools.clone(),
        source_path: s
            .source_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

fn to_detail(s: &Skill) -> SkillDetail {
    SkillDetail {
        scope: scope_to_wire(s.scope),
        name: s.frontmatter.name.clone(),
        description: non_empty(&s.frontmatter.description),
        when_to_use: non_empty(&s.frontmatter.when_to_use),
        allowed_tools: s.frontmatter.allowed_tools.clone(),
        source_path: s
            .source_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        body: s.body.clone(),
    }
}

fn non_empty(s: &str) -> Option<String> {
    if s.trim().is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

pub async fn handle_skills_list(
    sessions: &SessionManager,
    params: SkillsListParams,
) -> Result<SkillsListResult, ProtocolError> {
    let registry = build_registry_async(sessions, &params.session_id).await?;
    let mut skills: Vec<SkillSummary> = registry.iter().map(to_summary).collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(SkillsListResult { skills })
}

pub async fn handle_skills_get(
    sessions: &SessionManager,
    params: SkillsGetParams,
) -> Result<SkillsGetResult, ProtocolError> {
    let registry = build_registry_async(sessions, &params.session_id).await?;
    let skill = registry.get(&params.name).ok_or_else(|| {
        ProtocolError::new(
            ErrorCode::NotFound,
            format!("skill not found: {}", params.name),
        )
    })?;
    Ok(SkillsGetResult {
        skill: to_detail(skill),
    })
}

pub async fn handle_skills_reload(
    _sessions: &SessionManager,
    _params: SkillsReloadParams,
) -> Result<SkillsReloadResult, ProtocolError> {
    // `skills.list` rebuilds the registry on every call, so the user's
    // intent ("I edited the .md, reflect it") is already satisfied as
    // soon as they query the list again. Returning `reloaded: true`
    // keeps the wire surface honest with the user mental model.
    Ok(SkillsReloadResult { reloaded: true })
}
