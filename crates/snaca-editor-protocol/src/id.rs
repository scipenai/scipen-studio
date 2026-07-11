//! Type-wrapped UUIDs.
//!
//! Each protocol-level identifier is a newtype around `String` so the
//! type system catches mix-ups (passing a `ThreadId` where a `TurnId` was
//! expected). Construction validates UUIDv4 shape.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum IdError {
    #[error("invalid uuid: {0}")]
    InvalidUuid(String),
}

macro_rules! id_newtype {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            /// Generate a fresh UUIDv4.
            pub fn new() -> Self {
                Self(uuid::Uuid::new_v4().to_string())
            }

            /// Wrap an existing string after validating UUID shape.
            pub fn parse(raw: impl Into<String>) -> Result<Self, IdError> {
                let s = raw.into();
                uuid::Uuid::from_str(&s).map_err(|_| IdError::InvalidUuid(s.clone()))?;
                Ok(Self(s))
            }

            /// Wrap without validation. Caller-asserted UUID. Prefer
            /// [`Self::parse`] at trust boundaries.
            pub fn unchecked(raw: impl Into<String>) -> Self {
                Self(raw.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
    };
}

id_newtype!(SessionId, "Session identifier (one per opened project).");
id_newtype!(ThreadId, "Thread identifier (multiple per session, single active).");
id_newtype!(TurnId, "Turn identifier (one per agent invocation).");
id_newtype!(ProposalId, "Edit proposal identifier.");
id_newtype!(ToolCallId, "Tool invocation identifier within a turn.");
id_newtype!(RequestId, "context.request identifier (SNACA→host reverse RPC).");
id_newtype!(ProjectId, "Project identifier (host-assigned, persistent).");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_produces_valid_uuid() {
        let id = SessionId::new();
        assert!(uuid::Uuid::from_str(id.as_str()).is_ok());
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(matches!(
            SessionId::parse("not-a-uuid"),
            Err(IdError::InvalidUuid(_))
        ));
    }

    #[test]
    fn unchecked_skips_validation() {
        let id = SessionId::unchecked("anything-goes");
        assert_eq!(id.as_str(), "anything-goes");
    }

    #[test]
    fn types_are_distinct_at_compile_time() {
        let s = SessionId::new();
        let t = ThreadId::new();
        // The following would fail to compile, which is the point:
        // let _: SessionId = t;
        assert_ne!(s.as_str(), t.as_str()); // (uuids differ trivially anyway)
    }

    #[test]
    fn serializes_as_bare_string() {
        let id = SessionId::unchecked("abc");
        let s = serde_json::to_string(&id).unwrap();
        assert_eq!(s, "\"abc\"");
    }
}
