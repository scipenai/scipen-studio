//! Persistence errors.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum StateError {
    #[error("sqlx error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("migration failed: {0}")]
    Migration(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type StateResult<T> = Result<T, StateError>;
