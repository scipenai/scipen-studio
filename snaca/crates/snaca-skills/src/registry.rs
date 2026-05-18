//! `SkillRegistry` — name-keyed store with scope override semantics.

use crate::error::SkillResult;
use crate::scope::SkillScope;
use crate::skill::Skill;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tracing::{debug, warn};

/// Cheap to clone (`Arc<HashMap<...>>` inside).
#[derive(Clone, Default)]
pub struct SkillRegistry {
    skills: Arc<HashMap<String, Skill>>,
}

impl SkillRegistry {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn from_skills<I>(skills: I) -> Self
    where
        I: IntoIterator<Item = Skill>,
    {
        let mut map: HashMap<String, Skill> = HashMap::new();
        for skill in skills {
            insert_with_priority(&mut map, skill);
        }
        Self {
            skills: Arc::new(map),
        }
    }

    pub fn get(&self, name: &str) -> Option<&Skill> {
        self.skills.get(name)
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.skills.keys().map(String::as_str)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Skill> {
        self.skills.values()
    }

    pub fn len(&self) -> usize {
        self.skills.len()
    }

    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }
}

/// Builder pattern — accumulate skills from multiple scopes (and from
/// individual files / directories) before sealing into an `Arc`-backed
/// registry. Cheap to drop in tests.
#[derive(Default)]
pub struct SkillRegistryBuilder {
    skills: HashMap<String, Skill>,
}

impl SkillRegistryBuilder {
    pub fn add(&mut self, skill: Skill) -> &mut Self {
        insert_with_priority(&mut self.skills, skill);
        self
    }

    /// Scan a directory for skills and load each into the registry with
    /// the given scope. Two forms are recognised at depth 1:
    ///
    /// - **Flat:** a `*.md` file → loaded via `Skill::load`. Body has no
    ///   asset directory; `{{SKILL_DIR}}` cannot be used.
    /// - **Directory:** a subdirectory containing `SKILL.md` → loaded
    ///   via `Skill::load_directory`. Sidecar files (scripts, fixtures)
    ///   sit alongside the manifest and can be referenced from the body
    ///   via `{{SKILL_DIR}}`.
    ///
    /// Missing directory is treated as "no skills" (not an error).
    /// Per-entry load failures are logged + skipped so one bad skill
    /// doesn't kill the whole registry. Deeper nesting (e.g. a
    /// `SKILL.md` two levels down) is intentionally not loaded — keep
    /// the layout predictable.
    pub fn add_from_dir(&mut self, dir: &Path, scope: SkillScope) -> SkillResult<&mut Self> {
        if !dir.exists() {
            debug!(path = %dir.display(), "skill dir does not exist; skipping");
            return Ok(self);
        }
        if !dir.is_dir() {
            warn!(path = %dir.display(), "skill path exists but is not a directory; skipping");
            return Ok(self);
        }
        for entry in walkdir::WalkDir::new(dir)
            .max_depth(1)
            .min_depth(1)
            .follow_links(false)
        {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    warn!(error = %e, "failed walking skill dir");
                    continue;
                }
            };
            let ft = entry.file_type();
            if ft.is_dir() {
                // Directory-form: requires a SKILL.md inside. Folders
                // without one are silently ignored (they may hold
                // unrelated assets / non-skill content).
                let manifest = entry.path().join("SKILL.md");
                if !manifest.exists() {
                    debug!(path = %entry.path().display(), "directory has no SKILL.md; skipping");
                    continue;
                }
                match Skill::load_directory(entry.path(), scope) {
                    Ok(skill) => {
                        insert_with_priority(&mut self.skills, skill);
                    }
                    Err(e) => {
                        warn!(error = %e, path = %manifest.display(), "failed to load directory-form skill; skipping");
                    }
                }
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            if entry.path().extension().and_then(|x| x.to_str()) != Some("md") {
                continue;
            }
            match Skill::load(entry.path(), scope) {
                Ok(skill) => {
                    insert_with_priority(&mut self.skills, skill);
                }
                Err(e) => {
                    warn!(error = %e, path = %entry.path().display(), "failed to load skill; skipping");
                }
            }
        }
        Ok(self)
    }

    pub fn build(self) -> SkillRegistry {
        SkillRegistry {
            skills: Arc::new(self.skills),
        }
    }
}

fn insert_with_priority(map: &mut HashMap<String, Skill>, candidate: Skill) {
    let key = candidate.name().to_string();
    let candidate_is_dir = candidate.asset_dir.is_some();
    match map.get(&key) {
        Some(existing) if existing.scope.rank() > candidate.scope.rank() => {
            // Higher-rank scope wins outright.
            debug!(
                skill = %key,
                kept = %existing.scope,
                dropped = %candidate.scope,
                "skill already registered with higher-rank scope; keeping existing"
            );
        }
        Some(existing) if existing.scope.rank() == candidate.scope.rank() => {
            // Same scope: directory-form beats flat-form (richer layout
            // with sidecar assets). Otherwise first-loaded wins — same
            // as the previous behaviour.
            let existing_is_dir = existing.asset_dir.is_some();
            if candidate_is_dir && !existing_is_dir {
                warn!(
                    skill = %key,
                    scope = %candidate.scope,
                    "directory-form skill shadows flat-form of the same name at the same scope"
                );
                map.insert(key, candidate);
            } else {
                if !candidate_is_dir && existing_is_dir {
                    warn!(
                        skill = %key,
                        scope = %candidate.scope,
                        "flat-form skill ignored; directory-form already registered at the same scope"
                    );
                } else {
                    debug!(
                        skill = %key,
                        scope = %existing.scope,
                        "skill already registered at the same scope; keeping existing"
                    );
                }
            }
        }
        _ => {
            map.insert(key, candidate);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill::Skill;

    fn skill(name: &str, body: &str, scope: SkillScope) -> Skill {
        let raw = format!("---\nname: {name}\ndescription: {name} desc\n---\n{body}\n");
        Skill::from_str(&raw, scope, None).unwrap()
    }

    #[test]
    fn registry_lookup_and_iter() {
        let reg = SkillRegistry::from_skills(vec![
            skill("a", "body a", SkillScope::Project),
            skill("b", "body b", SkillScope::Project),
        ]);
        assert_eq!(reg.len(), 2);
        assert!(reg.get("a").is_some());
        assert!(reg.get("b").is_some());
        assert!(reg.get("c").is_none());
        let names: Vec<&str> = reg.names().collect();
        assert!(names.contains(&"a") && names.contains(&"b"));
    }

    #[test]
    fn project_scope_overrides_tenant() {
        let mut b = SkillRegistryBuilder::default();
        b.add(skill("review", "tenant body", SkillScope::Tenant));
        b.add(skill("review", "project body", SkillScope::Project));
        let reg = b.build();
        assert_eq!(reg.get("review").unwrap().body.trim(), "project body");
        assert_eq!(reg.get("review").unwrap().scope, SkillScope::Project);
    }

    #[test]
    fn tenant_does_not_override_project() {
        // Insert in opposite order — project loaded first, tenant should not overwrite.
        let mut b = SkillRegistryBuilder::default();
        b.add(skill("review", "project body", SkillScope::Project));
        b.add(skill("review", "tenant body", SkillScope::Tenant));
        let reg = b.build();
        assert_eq!(reg.get("review").unwrap().body.trim(), "project body");
    }

    #[test]
    fn add_from_dir_is_lenient_for_missing_dir() {
        let mut b = SkillRegistryBuilder::default();
        b.add_from_dir(Path::new("/nonexistent/path/here"), SkillScope::Tenant)
            .unwrap();
        assert!(b.build().is_empty());
    }

    #[test]
    fn add_from_dir_skips_non_md() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("good.md"),
            "---\nname: good\ndescription: ok\n---\nbody\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("noise.txt"), "ignore me").unwrap();
        std::fs::write(dir.path().join("README"), "no extension").unwrap();

        let mut b = SkillRegistryBuilder::default();
        b.add_from_dir(dir.path(), SkillScope::Tenant).unwrap();
        let reg = b.build();
        assert_eq!(reg.len(), 1);
        assert!(reg.get("good").is_some());
    }

    #[test]
    fn add_from_dir_loads_directory_form_skills() {
        let dir = tempfile::tempdir().unwrap();
        let skill_dir = dir.path().join("office-extract");
        std::fs::create_dir(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: office-extract\ndescription: d\n---\nrun {{SKILL_DIR}}/scripts/x.py\n",
        )
        .unwrap();
        // Sidecar — must NOT be loaded as its own skill.
        std::fs::create_dir(skill_dir.join("scripts")).unwrap();
        std::fs::write(skill_dir.join("scripts").join("x.py"), "print(1)").unwrap();

        let mut b = SkillRegistryBuilder::default();
        b.add_from_dir(dir.path(), SkillScope::Tenant).unwrap();
        let reg = b.build();
        assert_eq!(reg.len(), 1);
        let s = reg.get("office-extract").unwrap();
        assert_eq!(s.asset_dir.as_deref(), Some(skill_dir.as_path()));
    }

    #[test]
    fn add_from_dir_ignores_folder_without_skill_md() {
        let dir = tempfile::tempdir().unwrap();
        let nope = dir.path().join("not-a-skill");
        std::fs::create_dir(&nope).unwrap();
        std::fs::write(nope.join("README.md"), "just docs").unwrap();

        let mut b = SkillRegistryBuilder::default();
        b.add_from_dir(dir.path(), SkillScope::Tenant).unwrap();
        assert!(b.build().is_empty());
    }

    #[test]
    fn add_from_dir_does_not_descend_below_depth_one() {
        // A `SKILL.md` two levels down must not be loaded — layout is
        // intentionally flat-or-one-level.
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("outer").join("inner");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(
            nested.join("SKILL.md"),
            "---\nname: deep\ndescription: d\n---\nbody\n",
        )
        .unwrap();

        let mut b = SkillRegistryBuilder::default();
        b.add_from_dir(dir.path(), SkillScope::Tenant).unwrap();
        assert!(b.build().get("deep").is_none());
    }

    #[test]
    fn directory_form_overrides_flat_form_at_same_scope() {
        // Insertion order: flat first, directory second. Directory wins.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("office-extract.md"),
            "---\nname: office-extract\ndescription: d\n---\nflat body\n",
        )
        .unwrap();
        let skill_dir = dir.path().join("office-extract");
        std::fs::create_dir(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: office-extract\ndescription: d\n---\ndirectory body\n",
        )
        .unwrap();

        let mut b = SkillRegistryBuilder::default();
        b.add_from_dir(dir.path(), SkillScope::Tenant).unwrap();
        let reg = b.build();
        let s = reg.get("office-extract").unwrap();
        assert!(
            s.asset_dir.is_some(),
            "directory-form should win; got asset_dir = None"
        );
        assert!(s.body.contains("directory body"));
    }

    #[test]
    fn flat_form_cannot_shadow_existing_directory_form() {
        // Insertion order: directory first, flat second. Flat must lose.
        let mut b = SkillRegistryBuilder::default();
        let mut dir_skill = Skill::from_str(
            "---\nname: office-extract\ndescription: d\n---\ndirectory body\n",
            SkillScope::Tenant,
            Some(Path::new("/fake/office-extract/SKILL.md").to_path_buf()),
        )
        .unwrap();
        dir_skill.asset_dir = Some(Path::new("/fake/office-extract").to_path_buf());
        b.add(dir_skill);
        b.add(skill("office-extract", "flat body", SkillScope::Tenant));
        let reg = b.build();
        let s = reg.get("office-extract").unwrap();
        assert!(s.asset_dir.is_some());
        assert!(s.body.contains("directory body"));
    }

    #[test]
    fn add_from_dir_skips_malformed_skills() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("ok.md"),
            "---\nname: ok\ndescription: ok\n---\nbody\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("bad.md"),
            "no frontmatter here at all",
        )
        .unwrap();

        let mut b = SkillRegistryBuilder::default();
        b.add_from_dir(dir.path(), SkillScope::Tenant).unwrap();
        let reg = b.build();
        assert_eq!(reg.len(), 1, "bad.md must not poison the load");
    }
}
