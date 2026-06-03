//! `snaca-skills` — `.md` skill loader with YAML frontmatter.
//!
//! ## File format
//!
//! ```text
//! ---
//! name: review
//! description: Review pending changes for issues.
//! when_to_use: When the user asks to review code or a diff.
//! allowed_tools: [Read, Grep, Glob]
//! ---
//!
//! When asked to review code:
//! 1. Read the diff with `git diff` (via Bash).
//! 2. Look for issues in...
//! ```
//!
//! Frontmatter is required and must contain `name`. `description` and
//! `when_to_use` are surfaced to the LLM (via `SkillTool` or system prompt
//! injection); `allowed_tools` is informational in M2 and enforced once the
//! engine grows a per-skill tool gate.
//!
//! ## Scopes
//!
//! Skills live in four layered scopes:
//! - **Bundled**: app-shipped read-only dir (host passes it; rank 0, lowest).
//! - **Global**:  optional operator-supplied dir, shared across tenants.
//! - **Tenant**:  `<data_root>/<tenant_id>/skills/*.md`
//! - **Project**: `<data_root>/<tenant_id>/projects/<project_id>/skills/*.md`
//!
//! Same `name` across scopes resolves by rank: **project > tenant > global > bundled**.

pub mod error;
pub mod provider;
pub mod registry;
pub mod scope;
pub mod skill;

pub use error::{SkillError, SkillResult};
pub use provider::{DynSkillProvider, LayoutSkillProvider, SkillProvider, StaticSkillProvider};
pub use registry::{SkillRegistry, SkillRegistryBuilder};
pub use scope::SkillScope;
pub use skill::{Skill, SkillFrontmatter};
