//! Skill loading errors.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SkillError {
    #[error("io error reading {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("missing frontmatter delimiter `---` in {path}")]
    MissingFrontmatter { path: String },

    #[error("unterminated frontmatter (no closing `---`) in {path}")]
    UnterminatedFrontmatter { path: String },

    #[error("invalid frontmatter YAML in {path}: {source}")]
    Yaml {
        path: String,
        #[source]
        source: serde_yaml_ng::Error,
    },

    /// Frontmatter parsed but a required field (`name`) is missing or empty.
    #[error("frontmatter in {path} is missing required field `{field}`")]
    MissingField { path: String, field: &'static str },
}

pub type SkillResult<T> = Result<T, SkillError>;
