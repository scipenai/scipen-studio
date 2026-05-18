//! IM slash-command parser + handler.
//!
//! The dispatcher peeks at incoming user text before invoking the engine.
//! If the text starts with `/snaca` (after `@mention` stripping), control
//! is diverted here: parse the subcommand, mutate routing state in the DB,
//! and return a short reply that the dispatcher sends back through the
//! plugin. The engine is *not* invoked for slash commands — they're pure
//! routing operations, no LLM round trip.
//!
//! Supported subcommands:
//! - `/snaca create <slug>` — bind a custom project (creates if absent)
//! - `/snaca switch <slug>` — same as create; idempotent
//! - `/snaca list`           — list projects in the current tenant
//! - `/snaca status`         — show the current routing
//! - `/snaca help`           — short reference card
//!
//! Slug rules: 1–32 chars, `[a-z0-9_-]`, otherwise rejected. The on-disk
//! project id becomes `proj-<slug>`. We deliberately do *not* let the user
//! type a raw `auto-...` id — those are reserved for the chat-id-derived
//! default project so users can't impersonate routing buckets.
//!
//! Slash commands route bindings on `(chat_id, user_id)` so multiple users
//! in the same group can have private projects without colliding.

use snaca_core::{ProjectId, TenantId};
use snaca_state::Database;

const HELP_TEXT: &str = "/snaca commands:\n\
    • /snaca create <slug>  — bind a new project for this chat\n\
    • /snaca switch <slug>  — switch this chat to an existing project\n\
    • /snaca list           — list projects in this tenant\n\
    • /snaca status         — show current routing\n\
    • /snaca help           — this help";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlashCommand {
    Create { slug: String },
    Switch { slug: String },
    List,
    Status,
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    NotASlashCommand,
    UnknownSubcommand(String),
    MissingArgument(&'static str),
    InvalidSlug(String),
}

/// Try to interpret `text` as a `/snaca …` command. The first token must
/// be exactly `/snaca`; any leading `@mention` stripping is the caller's
/// responsibility.
pub fn parse(text: &str) -> Result<SlashCommand, ParseError> {
    let trimmed = text.trim();
    let mut tokens = trimmed.split_whitespace();
    match tokens.next() {
        Some("/snaca") => {}
        _ => return Err(ParseError::NotASlashCommand),
    }
    let sub = tokens.next().unwrap_or("help");
    match sub {
        "create" => {
            let slug = tokens
                .next()
                .ok_or(ParseError::MissingArgument("slug"))?;
            validate_slug(slug)?;
            Ok(SlashCommand::Create {
                slug: slug.to_string(),
            })
        }
        "switch" => {
            let slug = tokens
                .next()
                .ok_or(ParseError::MissingArgument("slug"))?;
            validate_slug(slug)?;
            Ok(SlashCommand::Switch {
                slug: slug.to_string(),
            })
        }
        "list" => Ok(SlashCommand::List),
        "status" => Ok(SlashCommand::Status),
        "help" | "-h" | "--help" => Ok(SlashCommand::Help),
        other => Err(ParseError::UnknownSubcommand(other.to_string())),
    }
}

fn validate_slug(slug: &str) -> Result<(), ParseError> {
    if slug.is_empty() || slug.len() > 32 {
        return Err(ParseError::InvalidSlug(format!(
            "slug must be 1–32 chars (got {})",
            slug.len()
        )));
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    {
        return Err(ParseError::InvalidSlug(format!(
            "slug {slug:?} must match [a-z0-9_-]+"
        )));
    }
    Ok(())
}

/// Build the canonical `ProjectId` from a slug. The `proj-` prefix
/// distinguishes user-created projects from chat-id-derived `auto-...`
/// defaults.
pub fn project_id_from_slug(slug: &str) -> ProjectId {
    ProjectId::from_raw(format!("proj-{slug}"))
}

/// Execute a parsed command against the DB. Returns the reply text the
/// dispatcher should send back to the user. Pure side-effects — no LLM,
/// no plugin calls.
pub async fn execute(
    cmd: SlashCommand,
    db: &Database,
    tenant: &TenantId,
    chat_id: &str,
    user_id: &str,
) -> String {
    match cmd {
        SlashCommand::Help => HELP_TEXT.to_string(),
        SlashCommand::Create { slug } | SlashCommand::Switch { slug } => {
            let project = project_id_from_slug(&slug);
            match db.upsert_binding(chat_id, user_id, &project).await {
                Ok(_) => format!(
                    "✓ this chat is now bound to project `{}` (slug `{slug}`).",
                    project.as_str()
                ),
                Err(e) => format!("error: failed to bind project: {e}"),
            }
        }
        SlashCommand::List => match db.list_projects_for_tenant(tenant).await {
            Ok(projects) if projects.is_empty() => {
                "no projects yet. Use `/snaca create <slug>` to start one.".to_string()
            }
            Ok(projects) => {
                let mut out = format!("{} project(s) in this tenant:\n", projects.len());
                for p in projects {
                    out.push_str(&format!("  • {}\n", p.as_str()));
                }
                out
            }
            Err(e) => format!("error: failed to list projects: {e}"),
        },
        SlashCommand::Status => {
            let binding = db.find_binding(chat_id, user_id).await;
            let active = match binding {
                Ok(Some(b)) => format!(
                    "bound to `{}` (since {})",
                    b.project_id.as_str(),
                    b.bound_at.format("%Y-%m-%d %H:%M:%SZ")
                ),
                Ok(None) => format!(
                    "auto-routed to `{}` (chat-id-derived default)",
                    ProjectId::auto_from_chat(chat_id).as_str()
                ),
                Err(e) => format!("error reading binding: {e}"),
            };
            format!(
                "tenant: `{}`\nchat:   `{chat_id}`\nuser:   `{user_id}`\nproject: {active}",
                tenant.as_str()
            )
        }
    }
}

/// Convenience: parse + execute in one shot. Returns `None` when the
/// input isn't a slash command (caller falls back to engine dispatch).
/// Returns `Some(reply)` for both successful execution and parser errors —
/// in either case the dispatcher should send `reply` back without invoking
/// the LLM.
pub async fn try_handle(
    text: &str,
    db: &Database,
    tenant: &TenantId,
    chat_id: &str,
    user_id: &str,
) -> Option<String> {
    match parse(text) {
        Err(ParseError::NotASlashCommand) => None,
        Err(ParseError::UnknownSubcommand(sub)) => Some(format!(
            "unknown subcommand `{sub}`. Try `/snaca help`."
        )),
        Err(ParseError::MissingArgument(name)) => {
            Some(format!("missing argument `{name}`. Try `/snaca help`."))
        }
        Err(ParseError::InvalidSlug(msg)) => Some(format!("invalid slug: {msg}")),
        Ok(cmd) => Some(execute(cmd, db, tenant, chat_id, user_id).await),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_create_with_valid_slug() {
        assert_eq!(
            parse("/snaca create alpha-1").unwrap(),
            SlashCommand::Create {
                slug: "alpha-1".into()
            }
        );
    }

    #[test]
    fn parse_switch() {
        assert_eq!(
            parse("/snaca switch beta_v2").unwrap(),
            SlashCommand::Switch {
                slug: "beta_v2".into()
            }
        );
    }

    #[test]
    fn parse_list_status_help() {
        assert_eq!(parse("/snaca list").unwrap(), SlashCommand::List);
        assert_eq!(parse("/snaca status").unwrap(), SlashCommand::Status);
        assert_eq!(parse("/snaca help").unwrap(), SlashCommand::Help);
        assert_eq!(parse("/snaca").unwrap(), SlashCommand::Help);
    }

    #[test]
    fn parse_rejects_uppercase_slug() {
        let err = parse("/snaca create Alpha").unwrap_err();
        assert!(matches!(err, ParseError::InvalidSlug(_)), "got {err:?}");
    }

    #[test]
    fn parse_rejects_too_long_slug() {
        let long = "a".repeat(33);
        let err = parse(&format!("/snaca create {long}")).unwrap_err();
        assert!(matches!(err, ParseError::InvalidSlug(_)));
    }

    #[test]
    fn parse_rejects_special_chars_in_slug() {
        let err = parse("/snaca create what.dot").unwrap_err();
        assert!(matches!(err, ParseError::InvalidSlug(_)), "got: {err:?}");
        let err = parse("/snaca create has space").unwrap();
        // Whitespace splits, so "has" parses as a valid slug; the
        // dispatcher would just bind to `proj-has`. That's fine — slugs
        // can't contain spaces by construction.
        assert_eq!(err, SlashCommand::Create { slug: "has".into() });
    }

    #[test]
    fn parse_missing_slug_arg() {
        let err = parse("/snaca create").unwrap_err();
        assert!(matches!(err, ParseError::MissingArgument("slug")));
    }

    #[test]
    fn parse_unknown_subcommand() {
        let err = parse("/snaca frobnicate").unwrap_err();
        assert!(matches!(err, ParseError::UnknownSubcommand(_)));
    }

    #[test]
    fn parse_non_command_passes_through() {
        let err = parse("hello world").unwrap_err();
        assert!(matches!(err, ParseError::NotASlashCommand));
        let err = parse("/other command").unwrap_err();
        assert!(matches!(err, ParseError::NotASlashCommand));
    }

    #[test]
    fn project_id_from_slug_has_proj_prefix() {
        assert_eq!(project_id_from_slug("alpha").as_str(), "proj-alpha");
    }

    #[tokio::test]
    async fn execute_create_writes_binding() {
        let db = Database::open_in_memory().await.unwrap();
        let tenant = TenantId::new("t");
        let reply = execute(
            SlashCommand::Create {
                slug: "alpha".into(),
            },
            &db,
            &tenant,
            "chat_1",
            "user_a",
        )
        .await;
        assert!(reply.contains("proj-alpha"));
        let binding = db.find_binding("chat_1", "user_a").await.unwrap().unwrap();
        assert_eq!(binding.project_id.as_str(), "proj-alpha");
    }

    #[tokio::test]
    async fn execute_status_shows_default_when_no_binding() {
        let db = Database::open_in_memory().await.unwrap();
        let tenant = TenantId::new("t");
        let reply = execute(
            SlashCommand::Status,
            &db,
            &tenant,
            "chat_zzz",
            "user_q",
        )
        .await;
        assert!(reply.contains("auto-"), "got: {reply}");
        assert!(reply.contains("chat_zzz"));
    }

    #[tokio::test]
    async fn execute_list_returns_distinct_projects() {
        use snaca_state::NewThread;
        let db = Database::open_in_memory().await.unwrap();
        let tenant = TenantId::new("t");
        // Distinct thread ids per row; the second alpha thread tests
        // that list_projects_for_tenant deduplicates.
        let rows = [
            ("thr-1", "alpha"),
            ("thr-2", "beta"),
            ("thr-3", "alpha"),
        ];
        for (tid, slug) in rows {
            db.insert_thread(&NewThread {
                id: snaca_core::ThreadId::new(tid),
                tenant_id: tenant.clone(),
                project_id: project_id_from_slug(slug),
            })
            .await
            .unwrap();
        }
        let reply = execute(SlashCommand::List, &db, &tenant, "c", "u").await;
        assert!(reply.contains("proj-alpha"));
        assert!(reply.contains("proj-beta"));
        // Distinct: alpha appears exactly once.
        assert_eq!(reply.matches("proj-alpha").count(), 1, "got: {reply}");
    }

    #[tokio::test]
    async fn try_handle_passes_through_non_slash_text() {
        let db = Database::open_in_memory().await.unwrap();
        let tenant = TenantId::new("t");
        assert!(try_handle("hello", &db, &tenant, "c", "u").await.is_none());
        assert!(try_handle("@SNACA hi", &db, &tenant, "c", "u")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn try_handle_returns_help_for_unknown_subcmd() {
        let db = Database::open_in_memory().await.unwrap();
        let tenant = TenantId::new("t");
        let reply = try_handle("/snaca zzz", &db, &tenant, "c", "u")
            .await
            .unwrap();
        assert!(reply.contains("unknown") && reply.contains("zzz"));
    }
}
