//! Typed identifiers.
//!
//! All IDs are newtype wrappers around `String` or `Uuid` to prevent mix-ups
//! at API boundaries (e.g. accidentally passing a `TenantId` where a
//! `ProjectId` is expected).
//!
//! `ProjectId::auto_from_chat` derives a stable 10-char base32 ID from an IM
//! chat ID via blake3 — same chat always maps to the same project, no
//! collision-by-name issues. Display name is a separate alias and never
//! participates in path resolution.

use data_encoding::BASE32_NOPAD;
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

macro_rules! string_id {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_inner(self) -> String {
                self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self(s)
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(s.to_string())
            }
        }
    };
}

macro_rules! uuid_id {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }

            pub fn from_uuid(uuid: Uuid) -> Self {
                Self(uuid)
            }

            pub fn as_uuid(&self) -> Uuid {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }
    };
}

string_id!(
    TenantId,
    "IM tenant identifier (e.g. Lark `tenant_key`). Format is plugin-defined; \
     SNACA does not interpret it, only uses it as an isolation key."
);

string_id!(
    ThreadId,
    "Per-IM-conversation thread identifier — typically the `chat_id` from the \
     IM platform, possibly suffixed with a thread/topic id."
);

string_id!(
    ToolUseId,
    "Identifier of a single tool invocation, propagated through the LLM round trip."
);

uuid_id!(SessionId, "Engine-side conversation session, internal to SNACA.");
uuid_id!(MessageId, "Engine-side message identifier, internal to SNACA.");

/// Project identifier — stable across renames. Two construction paths:
/// - [`ProjectId::auto_from_chat`] — derived from IM `chat_id` via blake3,
///   so the same chat always resolves to the same project.
/// - [`ProjectId::new_random`] — for explicit user-created projects
///   (`/snaca create <slug>`); display slug is held separately.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProjectId(String);

impl ProjectId {
    /// Derive a stable `auto-<base32(blake3(chat_id))[..10]>` ID.
    pub fn auto_from_chat(chat_id: &str) -> Self {
        let hash = blake3::hash(chat_id.as_bytes());
        let encoded = BASE32_NOPAD.encode(hash.as_bytes());
        // 10 chars of base32 = 50 bits, far enough to avoid collisions in practice.
        let short = encoded.chars().take(10).collect::<String>().to_lowercase();
        Self(format!("auto-{}", short))
    }

    /// Generate a fresh random project ID for user-created projects.
    pub fn new_random() -> Self {
        let id = Uuid::new_v4().simple().to_string();
        Self(format!("proj-{}", &id[..12]))
    }

    pub fn from_raw(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

impl fmt::Display for ProjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_id_is_deterministic_per_chat() {
        let a = ProjectId::auto_from_chat("oc_chat_xyz");
        let b = ProjectId::auto_from_chat("oc_chat_xyz");
        assert_eq!(a, b);
    }

    #[test]
    fn project_id_differs_per_chat() {
        let a = ProjectId::auto_from_chat("oc_chat_a");
        let b = ProjectId::auto_from_chat("oc_chat_b");
        assert_ne!(a, b);
    }

    #[test]
    fn project_id_starts_with_auto_prefix() {
        let id = ProjectId::auto_from_chat("any");
        assert!(id.as_str().starts_with("auto-"));
        assert_eq!(id.as_str().len(), 5 + 10);
    }

    #[test]
    fn random_project_ids_are_unique() {
        let a = ProjectId::new_random();
        let b = ProjectId::new_random();
        assert_ne!(a, b);
        assert!(a.as_str().starts_with("proj-"));
    }

    #[test]
    fn tenant_and_thread_ids_roundtrip_serde() {
        let t = TenantId::new("tenant_abc");
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(json, "\"tenant_abc\"");
        let back: TenantId = serde_json::from_str(&json).unwrap();
        assert_eq!(t, back);
    }
}
