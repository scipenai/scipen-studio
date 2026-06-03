//! Dispatcher: bridges plugin inbound events to the agent engine and
//! routes assistant replies back through the plugin.
//!
//! One dispatcher task is spawned per plugin. For each `event.message_received`:
//! 1. derive `(tenant, project, thread)` from the IM payload
//! 2. ack the event so the plugin marks it processed
//! 3. invoke `Engine::handle_turn`
//! 4. on success: send the assistant text via `plugin.send_message`
//! 5. on engine error: still reply with a brief error message so the user
//!    isn't left wondering — the channel must always close out the request.
//!
//! Approval callbacks, plugin error events, and log forwarding are stubbed
//! for M1 (logged + ignored). They land in M2 along with the approval
//! state machine.

use crate::commands;
use crate::gate::build_approval_gate;
use crate::outbox;
use crate::typing::ChannelTypingListener;
use snaca_channel_host::{InboundEvent, PluginHandle};
use snaca_channel_protocol::methods::{
    FileDownloadParams, MessageReceivedParams, MessageSendParams, MessageUpdateParams,
};
use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_engine::{Engine, TurnRequest};
use snaca_state::Database;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{info, warn};

/// Run the dispatcher loop for one plugin until its inbound stream closes
/// (typically because the plugin process exited or `shutdown` was called).
pub async fn dispatch_loop(
    engine: Arc<Engine>,
    db: Database,
    plugin: PluginHandle,
    tenant_id: TenantId,
    typing_interval: std::time::Duration,
    mut inbound: mpsc::Receiver<InboundEvent>,
) {
    info!(plugin = plugin.name(), "dispatcher started");
    while let Some(event) = inbound.recv().await {
        match event {
            InboundEvent::MessageReceived { params, .. } => {
                handle_message_received(
                    &engine,
                    &db,
                    &plugin,
                    &tenant_id,
                    typing_interval,
                    params,
                )
                .await;
            }
            InboundEvent::MessageRecalled { params, .. } => {
                // User retracted a message — abort *only* the turn
                // that this message triggered. The engine indexes
                // inflight turns by (thread_id, message_id), so a
                // recall in a busy group chat no longer collaterally
                // kills sibling turns from other users or a later
                // message from the same user.
                let user_key = user_key_for(&params.chat_id, &params.user_id);
                let project_id = resolve_project_id(&db, &params.chat_id, user_key).await;
                let thread_id = thread_id_for(&params.chat_id, &project_id);
                let aborted = engine.abort_turn(&thread_id, &params.message_id);
                info!(
                    thread = thread_id.as_str(),
                    message_id = params.message_id.as_str(),
                    aborted,
                    "im recall received"
                );
            }
            InboundEvent::ApprovalCallback { plugin: p, .. } => {
                // M1: approval flow not wired yet; M2 will resolve the
                // pending future via `ApprovalRegistry`.
                warn!(plugin = %p, "approval callback received but approval state machine is M2; ignoring");
            }
            InboundEvent::PluginError {
                plugin: p,
                severity,
                message,
                ..
            } => {
                warn!(plugin = %p, severity, "plugin reported error: {message}");
            }
            InboundEvent::Log { plugin: p, params } => {
                tracing::info!(plugin = %p, level = ?params.level, "{}", params.message);
            }
            InboundEvent::Unknown {
                plugin: p,
                method,
                params,
            } => {
                warn!(plugin = %p, method, ?params, "unknown plugin notification");
            }
        }
    }
    info!(plugin = plugin.name(), "dispatcher stopped (inbound closed)");
}

/// Bindings key off `user_id` when present, falling back to `chat_id`
/// for plugins that don't attribute messages to a user (private DMs
/// where chat_id == user_id, or simple test plugins).
fn user_key_for<'a>(chat_id: &'a str, user_id: &'a str) -> &'a str {
    if user_id.is_empty() {
        chat_id
    } else {
        user_id
    }
}

/// Resolve the active `ProjectId` for `(chat_id, user)`. Looks up the
/// `/snaca create|switch` binding first; falls back to the chat-id
/// derived auto-project. Shared between `MessageReceived` (routing a
/// new turn) and `MessageRecalled` (computing the thread_id to
/// abort) so the two paths can never diverge.
async fn resolve_project_id(db: &Database, chat_id: &str, user_key: &str) -> ProjectId {
    match db.find_binding(chat_id, user_key).await {
        Ok(Some(b)) => b.project_id,
        _ => ProjectId::auto_from_chat(chat_id),
    }
}

/// Build the canonical `ThreadId` for `(chat_id, project_id)`. Same
/// shape used by `handle_message_received`; abort path relies on the
/// match being byte-for-byte identical.
fn thread_id_for(chat_id: &str, project_id: &ProjectId) -> ThreadId {
    ThreadId::new(format!("{}::{}", chat_id, project_id.as_str()))
}

async fn handle_message_received(
    engine: &Engine,
    db: &Database,
    plugin: &PluginHandle,
    tenant_id: &TenantId,
    typing_interval: std::time::Duration,
    params: MessageReceivedParams,
) {
    // Idempotency ack — best-effort; failure here is not fatal.
    let event_id = params.message_id.clone();
    if let Err(e) = plugin.acknowledge(event_id.clone()).await {
        warn!(plugin = plugin.name(), event_id, error = ?e, "acknowledge failed");
    }

    // Durable inbound dedup — the plugin's in-process HashMap dedup
    // doesn't survive its restart, so a Lark WS reconnect after a
    // watchdog-triggered respawn can replay the recent backlog. Drop
    // duplicates here before any engine work happens. Empty
    // `message_id` (some plugins emit synthetic events without one)
    // bypasses the check; those are rare and tolerating dupes is
    // cheaper than synthesising a stable key for them.
    if !params.message_id.is_empty() {
        match db
            .inbound_dedup_check_and_record(plugin.name(), &params.message_id)
            .await
        {
            Ok(true) => {
                info!(
                    plugin = plugin.name(),
                    message_id = params.message_id.as_str(),
                    "inbound dedup hit — dropping replay"
                );
                return;
            }
            Ok(false) => {}
            Err(e) => {
                warn!(
                    plugin = plugin.name(),
                    error = ?e,
                    "inbound dedup probe failed; proceeding (will process potentially-duplicate event)"
                );
            }
        }
    }

    // Multi-tenant routing: prefer the tenant id the plugin reports
    // alongside the message; fall back to the server's configured default
    // when the plugin sends an empty string (e.g. single-tenant mock setup).
    let routed_tenant = if params.tenant_id.is_empty() {
        tenant_id.clone()
    } else {
        TenantId::new(params.tenant_id.clone())
    };

    // Slash-command short-circuit: `/snaca …` never hits the engine. Route
    // the bind/list/status mutation through the DB and return the reply
    // directly. We use the user_id from the IM payload — falling back to
    // the chat_id when absent (private chat = single user, same key works).
    let cleaned = clean_user_input(&params.content);
    let user_key = if params.user_id.is_empty() {
        params.chat_id.as_str()
    } else {
        params.user_id.as_str()
    };
    if let Some(reply) = commands::try_handle(
        &cleaned,
        db,
        &routed_tenant,
        &params.chat_id,
        user_key,
    )
    .await
    {
        let send = MessageSendParams {
            tenant_id: params.tenant_id.clone(),
            chat_id: params.chat_id.clone(),
            content: reply,
            format: Some("markdown".into()),
            reply_to: None,
            idempotency_key: None,
        };
        if let Err(e) = outbox::send_message(db, plugin, send).await {
            warn!(plugin = plugin.name(), error = ?e, "failed to enqueue slash-command reply");
        }
        return;
    }

    // Plugin-advertised slash commands. We check *after* the built-in
    // `/snaca` handler so we never let a plugin shadow core admin verbs.
    // Routing is per-channel: only the originating plugin's advertised set
    // is consulted — a Lark-channel command shouldn't fire from DingTalk
    // even if both plugins declared the same name.
    if let Some(reply) = try_plugin_command(plugin, &cleaned, &params, user_key).await {
        let send = MessageSendParams {
            tenant_id: params.tenant_id.clone(),
            chat_id: params.chat_id.clone(),
            content: reply,
            format: Some("markdown".into()),
            reply_to: None,
            idempotency_key: None,
        };
        if let Err(e) = outbox::send_message(db, plugin, send).await {
            warn!(plugin = plugin.name(), error = ?e, "failed to enqueue plugin-command reply");
        }
        return;
    }

    let project_id = resolve_project_id(db, &params.chat_id, user_key).await;
    let thread_id = thread_id_for(&params.chat_id, &project_id);

    // Attachment import — for any uploaded files, pull them through
    // the bulk-import pipeline before invoking the LLM. The user's
    // turn then runs against a memory tree that already contains the
    // uploaded content, so retrieval / `MemoryRead` can surface it
    // immediately. Failures are logged but never abort the turn —
    // we'd rather give the model a partially-imported view than
    // refuse to talk.
    if !params.attachments.is_empty() {
        import_attachments(
            engine,
            db,
            plugin,
            &routed_tenant,
            &project_id,
            &params,
        )
        .await;
    }

    let send_chat_id = params.chat_id.clone();
    let send_tenant = params.tenant_id.clone();

    let turn = TurnRequest {
        tenant_id: routed_tenant,
        project_id,
        thread_id,
        user_text: clean_user_input(&params.content),
        // Carry the IM message id through so a later recall event
        // can target this specific turn via Engine::abort_turn.
        // Empty falls back to a UUID inside the engine; admin's
        // thread-level abort still works in that case.
        message_id: Some(params.message_id.clone()),
        // Server has no editor host, so no per-turn ephemeral context.
        ephemeral_system: None,
    };

    // Route every approval gate through the originating plugin so the user
    // sees the card on the same channel they sent the request from. The
    // dispatcher reads `SNACA_APPROVAL_MODE` here to optionally swap in a
    // Noop / DenyAll gate without touching the plugin path.
    let gate = build_approval_gate(
        plugin.clone(),
        params.tenant_id.clone(),
        params.chat_id.clone(),
    );
    // Same plugin handle is used to render typing deltas as the LLM
    // streams. After the turn ends, `finalize()` tells us whether any
    // text was streamed; the dispatcher then either issues a final
    // `update_message` (if so) or a fresh `send_message` (if not).
    let typing = Arc::new(ChannelTypingListener::with_interval(
        plugin.clone(),
        params.tenant_id.clone(),
        params.chat_id.clone(),
        typing_interval,
    ));
    let outcome = engine
        .handle_turn_full(turn, gate, typing.clone())
        .await;
    let (reply, outbound_files) = match outcome {
        Ok(o) => {
            info!(
                plugin = plugin.name(),
                iterations = o.iterations,
                input_tokens = o.usage.input_tokens,
                output_tokens = o.usage.output_tokens,
                outbound_files = o.outbound_files.len(),
                "turn complete"
            );
            let text = if o.assistant_text.is_empty() {
                "(no reply)".to_string()
            } else {
                o.assistant_text
            };
            (text, o.outbound_files)
        }
        Err(e) => {
            warn!(plugin = plugin.name(), error = %e, "engine turn failed");
            (format!("error: {e}"), Vec::new())
        }
    };

    let supports_update = plugin.manifest().capabilities.update_message;
    match typing.finalize().await {
        Some(handoff) if supports_update => {
            // Listener already showed the user something. Push the
            // engine's final text via update_message so the rendered
            // message ends up on the canonical reply (matters when the
            // model summarized differently after a tool round-trip).
            // [`outbox::update_message`] enqueues the row durably; on
            // terminal failure (card expired etc.) it auto-enqueues a
            // fresh send_message so the user still gets the reply.
            if reply != handoff.streamed_text {
                let upd = MessageUpdateParams {
                    tenant_id: send_tenant.clone(),
                    message_id: handoff.message_id,
                    content: reply.clone(),
                };
                if let Err(e) = outbox::update_message(db, plugin, send_chat_id.clone(), upd).await
                {
                    warn!(plugin = plugin.name(), error = ?e, "failed to enqueue update_message");
                }
            }
        }
        // Either nothing was streamed (tool-only turn or empty reply)
        // OR the plugin doesn't support update_message — in both cases
        // the right move is a fresh send_message with the full text.
        // The non-update-supporting case will end up showing the user
        // two messages (a stub from the listener's first push + the
        // full reply); acceptable until the plugin gains update.
        Some(_) | None => {
            let send = MessageSendParams {
                tenant_id: send_tenant.clone(),
                chat_id: send_chat_id.clone(),
                content: reply,
                format: Some("markdown".into()),
                reply_to: None,
                idempotency_key: None,
            };
            if let Err(e) = outbox::send_message(db, plugin, send).await {
                warn!(plugin = plugin.name(), error = ?e, "failed to enqueue reply");
            }
        }
    }

    // Files queued by tools (e.g. `SendFile`) ride after the text reply.
    // Sending here — rather than interleaving with the reply — keeps the
    // ordering deterministic and means a file_upload failure can't
    // derail the textual answer the user is waiting on.
    if !outbound_files.is_empty() {
        let supports_upload = plugin.manifest().capabilities.file_upload;
        if !supports_upload {
            warn!(
                plugin = plugin.name(),
                count = outbound_files.len(),
                "tool queued outbound file(s) but plugin does not advertise file_upload; dropping"
            );
        } else {
            for of in outbound_files {
                let bytes = match tokio::fs::read(&of.absolute_path).await {
                    Ok(b) => b,
                    Err(e) => {
                        warn!(
                            plugin = plugin.name(),
                            path = %of.absolute_path.display(),
                            error = %e,
                            "failed to read outbound file from disk; skipping"
                        );
                        continue;
                    }
                };
                if let Err(e) = outbox::file_upload(
                    db,
                    plugin,
                    send_tenant.clone(),
                    send_chat_id.clone(),
                    of.filename.clone(),
                    of.mime_type.clone(),
                    &bytes,
                )
                .await
                {
                    warn!(
                        plugin = plugin.name(),
                        filename = %of.filename,
                        error = ?e,
                        "failed to enqueue file_upload",
                    );
                }
            }
        }
    }
}

/// Parse `cleaned` as `/<name> <args>`. Returns `(name, args)` if it
/// looks like a slash command, else `None`.
///
/// We accept any leading-`/` token; the caller is responsible for filtering
/// out reserved namespaces (currently just `snaca`, handled upstream by
/// `commands::try_handle`).
fn parse_slash_command(cleaned: &str) -> Option<(&str, &str)> {
    let stripped = cleaned.strip_prefix('/')?;
    let stripped = stripped.trim_start();
    if stripped.is_empty() {
        return None;
    }
    let (name, rest) = match stripped.find(char::is_whitespace) {
        Some(idx) => (&stripped[..idx], stripped[idx..].trim()),
        None => (stripped, ""),
    };
    // Reject names that contain anything but alnum / `-` / `_` / `.` —
    // protocol declares command names are identifier-shaped, and looser
    // matching would let a stray "/foo!" become a command call.
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return None;
    }
    Some((name, rest))
}

/// If `cleaned` matches `/<name> <args>` and the originating plugin has
/// advertised a command with that name, invoke it via `command.invoke` and
/// return the reply string. Returns `None` when:
/// - the input isn't a slash command,
/// - the originating plugin hasn't advertised that command,
/// - the plugin's `command.invoke` raises (we log and fall through to the
///   LLM, since command failure shouldn't black-hole the user's message).
async fn try_plugin_command(
    plugin: &PluginHandle,
    cleaned: &str,
    params: &MessageReceivedParams,
    user_key: &str,
) -> Option<String> {
    let (name, args) = parse_slash_command(cleaned)?;
    // Reserve the `snaca` namespace for built-in admin verbs (handled
    // upstream). Don't let a plugin shadow them — better to silently fall
    // through to the LLM if a plugin declares one anyway.
    if name.eq_ignore_ascii_case("snaca") {
        return None;
    }
    let advertised = plugin.advertised_commands().await;
    if !advertised.iter().any(|c| c.name == name) {
        return None;
    }
    info!(
        plugin = plugin.name(),
        command = name,
        "routing slash command to plugin"
    );
    match plugin
        .invoke_command(
            params.tenant_id.clone(),
            params.chat_id.clone(),
            user_key.to_string(),
            name.to_string(),
            args.to_string(),
        )
        .await
    {
        Ok(result) if result.is_error => {
            // Plugin reported failure. Surface it back to the user as the
            // reply text — they typed the command, they should see why it
            // failed rather than have it silently routed to the LLM.
            Some(if result.reply.is_empty() {
                format!("/{name} failed")
            } else {
                result.reply
            })
        }
        Ok(result) => {
            // Empty reply means "the plugin handled it side-channel" (per
            // protocol §command.advertise). Surface a short ack so the user
            // knows the command landed; otherwise the dispatch returns
            // without sending anything and the user wonders.
            Some(if result.reply.is_empty() {
                format!("/{name} ✓")
            } else {
                result.reply
            })
        }
        Err(e) => {
            warn!(
                plugin = plugin.name(),
                command = name,
                error = ?e,
                "command.invoke failed; falling through to LLM"
            );
            None
        }
    }
}

/// Trim @mentions / leading whitespace before passing user text to the LLM.
/// Keeps things simple: drop any leading `@<token>` once.
fn clean_user_input(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix('@') {
        // Skip the mention token, then any whitespace, then return the rest.
        if let Some(idx) = rest.find(char::is_whitespace) {
            return rest[idx..].trim().to_string();
        }
        // `@SNACA` with nothing after — return empty so LLM gets a clear input.
        return String::new();
    }
    trimmed.to_string()
}

/// Pull each attachment from the originating plugin and import it
/// into the project's memory tree. Best-effort: a failure on any one
/// attachment is logged but doesn't poison the rest. Returns nothing
/// — the function side-effects on the memory tree and on the IM
/// channel (sends a status reply per attachment).
async fn import_attachments(
    engine: &Engine,
    db: &Database,
    plugin: &PluginHandle,
    tenant: &TenantId,
    project: &ProjectId,
    params: &MessageReceivedParams,
) {
    for att in &params.attachments {
        let download_params = FileDownloadParams {
            tenant_id: params.tenant_id.clone(),
            file_id: att.id.clone(),
        };
        let (bytes, filename, _mime) = match plugin.file_download(download_params).await {
            Ok(x) => x,
            Err(e) => {
                warn!(
                    plugin = plugin.name(),
                    file_id = att.id.as_str(),
                    error = ?e,
                    "file.download failed; skipping attachment"
                );
                send_attachment_notice(
                    db,
                    plugin,
                    params,
                    &format!("⚠ couldn't download `{}`: {}", att.filename, e),
                )
                .await;
                continue;
            }
        };
        // Plugin-reported filename usually matches `att.filename` but
        // we trust the download response — it's what the platform
        // resolved at fetch time.
        let report = engine
            .import_attachment(tenant, project, bytes, filename.clone())
            .await;
        match report {
            Ok(r) if r.entries.is_empty() => {
                info!(
                    plugin = plugin.name(),
                    filename = filename.as_str(),
                    kind = ?r.kind,
                    "attachment produced no memory entries"
                );
                send_attachment_notice(
                    db,
                    plugin,
                    params,
                    &format!(
                        "ℹ `{}` ({:?}) imported but no chunks were extracted",
                        filename, r.kind
                    ),
                )
                .await;
            }
            Ok(r) => {
                info!(
                    plugin = plugin.name(),
                    filename = filename.as_str(),
                    kind = ?r.kind,
                    chunks = r.entries.len(),
                    "attachment imported"
                );
                send_attachment_notice(
                    db,
                    plugin,
                    params,
                    &format!(
                        "✓ imported `{}` ({:?}) → {} memory entr{}",
                        filename,
                        r.kind,
                        r.entries.len(),
                        if r.entries.len() == 1 { "y" } else { "ies" }
                    ),
                )
                .await;
            }
            Err(e) => {
                warn!(
                    plugin = plugin.name(),
                    filename = filename.as_str(),
                    error = %e,
                    "attachment import failed"
                );
                send_attachment_notice(
                    db,
                    plugin,
                    params,
                    &format!("⚠ couldn't import `{}`: {}", filename, e),
                )
                .await;
            }
        }
    }
}

/// Send a short status line back to the originating chat. Used by the
/// attachment-import path to give the user immediate feedback per
/// file. Failures are logged — sending status notices isn't critical
/// to the turn.
async fn send_attachment_notice(
    db: &Database,
    plugin: &PluginHandle,
    params: &MessageReceivedParams,
    text: &str,
) {
    let send = MessageSendParams {
        tenant_id: params.tenant_id.clone(),
        chat_id: params.chat_id.clone(),
        content: text.to_string(),
        format: Some("markdown".into()),
        reply_to: None,
        idempotency_key: None,
    };
    if let Err(e) = outbox::send_message(db, plugin, send).await {
        warn!(
            plugin = plugin.name(),
            error = ?e,
            "failed to enqueue attachment status notice"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_user_input_strips_leading_mention() {
        assert_eq!(clean_user_input("@SNACA hello"), "hello");
        assert_eq!(clean_user_input("  @SNACA  read README  "), "read README");
        assert_eq!(clean_user_input("@SNACA"), "");
        assert_eq!(clean_user_input("just text"), "just text");
        assert_eq!(clean_user_input("  no mention here  "), "no mention here");
    }

    #[test]
    fn parse_slash_command_extracts_name_and_args() {
        assert_eq!(parse_slash_command("/ping"), Some(("ping", "")));
        assert_eq!(
            parse_slash_command("/ping hello world"),
            Some(("ping", "hello world"))
        );
        assert_eq!(
            parse_slash_command("/ping   spaced   args  "),
            Some(("ping", "spaced   args"))
        );
        assert_eq!(parse_slash_command("/foo-bar"), Some(("foo-bar", "")));
        assert_eq!(parse_slash_command("/foo.bar baz"), Some(("foo.bar", "baz")));
    }

    #[test]
    fn parse_slash_command_rejects_non_command_input() {
        assert_eq!(parse_slash_command("not a command"), None);
        assert_eq!(parse_slash_command("/"), None);
        assert_eq!(parse_slash_command("/   "), None);
        // Punctuation in the name is rejected so "/foo!" doesn't trigger.
        assert_eq!(parse_slash_command("/foo!bar"), None);
        // Leading whitespace after the slash is OK.
        assert_eq!(parse_slash_command("/ ping"), Some(("ping", "")));
    }
}
