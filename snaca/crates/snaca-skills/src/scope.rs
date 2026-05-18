//! Skill scope ordering. Higher rank wins when names collide.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    Bundled,
    Tenant,
    Project,
}

impl SkillScope {
    /// Higher rank overrides lower rank when two skills share a name.
    pub fn rank(self) -> u8 {
        match self {
            SkillScope::Bundled => 0,
            SkillScope::Tenant => 1,
            SkillScope::Project => 2,
        }
    }
}

impl std::fmt::Display for SkillScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SkillScope::Bundled => f.write_str("bundled"),
            SkillScope::Tenant => f.write_str("tenant"),
            SkillScope::Project => f.write_str("project"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_outranks_tenant_outranks_bundled() {
        assert!(SkillScope::Project.rank() > SkillScope::Tenant.rank());
        assert!(SkillScope::Tenant.rank() > SkillScope::Bundled.rank());
    }
}
