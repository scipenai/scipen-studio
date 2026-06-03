# SNACA IM Plugin Protocol

**Version:** 1.0 (draft)
**Status:** in design — subject to change before M1 freeze.

This document defines the wire protocol between the SNACA host process and IM
plugins. Any plugin that conforms to this protocol can be hot-plugged into a
running SNACA server, regardless of language. Existing implementations are:

| Plugin | Language | Repo | Notes |
|---|---|---|---|
| `snaca-plugin-openclaw-host` | Node.js / TypeScript | (separate repo) | Loads `@larksuite/openclaw-lark` and other OpenClaw channel npm packages with **zero source modification** |
| `snaca-plugin-lark` | Rust | (separate repo, M2) | Native Lark adapter using `openlark` v0.15 |
| `snaca-cli mock-plugin` | Rust | this repo | Debug helper |

## 1. Transport

- **Default:** stdio. The host spawns the plugin as a child process; the plugin
  reads JSON-RPC requests on `stdin` and writes responses/notifications on
  `stdout`. `stderr` is treated as logs (mirrored to host tracing).
- **Optional:** WebSocket. For remotely-deployed plugins. Same JSON-RPC
  payloads, framed by WS messages. Authentication via the same shared token
  passed in the `Authorization` header.
- All payloads are UTF-8 encoded JSON, framed by **newline delimiter** (`\n`)
  on stdio. (We may upgrade to LSP-style `Content-Length` headers if any
  legitimate payload exceeds 1 MB; for now newline-framing keeps debug tools
  cheap.)

## 2. Message format

[JSON-RPC 2.0](https://www.jsonrpc.org/specification). Three message types:
**request** (has `id`), **response** (matches an `id`), **notification**
(no `id`, fire-and-forget).

```json
{ "jsonrpc": "2.0", "id": 1, "method": "message.send",
  "params": { "tenant_id": "t1", "chat_id": "c1", "content": "hello" } }
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "message_id": "om_xyz" } }
```

```json
{ "jsonrpc": "2.0", "method": "event.message_received",
  "params": { "tenant_id": "t1", "chat_id": "c1", "user_id": "u1",
              "message_id": "om_abc", "content": "@SNACA hi" } }
```

## 3. Lifecycle

```
host                            plugin
 │  spawn child + inject env      │
 │ ─────────────────────────────► │
 │  initialize(config)            │
 │ ─────────────────────────────► │
 │                                │  load IM SDK / connect to platform
 │ ◄───────── manifest ─────────  │
 │                                │
 │  health.ping (every 30s)       │
 │ ─────────────────────────────► │
 │ ◄────────── pong ─────────────  │
 │                                │
 │ ◄─── event.message_received ── │  (user sends a message)
 │                                │
 │  message.send                  │
 │ ─────────────────────────────► │  (reply)
 │                                │
 │  shutdown                      │
 │ ─────────────────────────────► │
 │ ◄────────── ack ──────────────  │
```

If the plugin process dies unexpectedly, `snaca-channel-host`'s
`PluginSupervisor` restarts it with exponential backoff (capped at 60s) and
re-runs `initialize`. In-flight tool/approval state for affected sessions is
not preserved — clients should expect lost messages from the kill-window.

## 4. Plugin authentication

On spawn, the host injects a per-process secret as the environment variable
`SNACA_PLUGIN_TOKEN` (a 32-byte URL-safe base64 string). The plugin **must**
include this in every reverse call (plugin → host) as the `auth` field of
the request `params`. The host drops requests with missing or mismatched
tokens. Tokens are not reused across plugin restarts.

```json
{ "jsonrpc": "2.0", "method": "event.message_received",
  "params": { "auth": "<token>", "tenant_id": "t1", ... } }
```

## 5. Versioning

`initialize.params.protocolVersion` advertises the host's capability
(currently `"1.0"`). The plugin's manifest replies with the version it
implements. If they diverge:

- **Same major, different minor:** continue. Host falls back to features
  available on the lower side.
- **Different major:** host logs an error and refuses to route messages
  through this plugin. Operator must upgrade.

## 6. Methods (host → plugin)

| Method | Direction | Description |
|---|---|---|
| `initialize` | request | Handshake. Plugin returns its [Manifest](#7-plugin-manifest). |
| `shutdown` | request | Graceful shutdown. Plugin should drain in-flight work and reply ack. |
| `health.ping` | request | Heartbeat; plugin replies `pong`. |
| `message.send` | request | Send a plain message. Returns `{ message_id }`. |
| `message.update` | request | Edit a previously-sent message (typing indicators, partial streaming). Plugins without `update_message` capability must reply `method_unsupported`. |
| `card.send` | request | Send a structured card (interactive buttons, layout). Plugins without `interactive_card` capability must reply `method_unsupported`. |
| `approval.present` | request | Render an approval card with allow/deny buttons; the response is **not** the user's decision — that arrives later via `event.approval_callback` keyed on `callback_token`. |
| `file.upload` | request | Upload a file/attachment to IM. Returns `{ message_id }`. |
| `file.download` | request | Download an attachment the plugin previously surfaced. Returns the bytes (base64) or a temp-file path. |
| `acknowledge` | request | Idempotent dedup ack — host tells plugin "I've processed `event_id`". |

### `message.send` params

```jsonc
{
  "tenant_id": "t1",
  "chat_id": "c1",
  "content": "hello",
  "format": "markdown" | "text",   // optional, default markdown
  "reply_to": "om_abc"              // optional thread/quote
}
```

### `approval.present` params

```jsonc
{
  "tenant_id": "t1",
  "chat_id": "c1",
  "request": "Allow Bash to run `ls /tmp`?",
  "options": ["allow", "deny", "allow_once", "allow_always"],
  "callback_token": "<opaque>",
  "timeout_sec": 300
}
```

The plugin renders this however the IM platform allows (interactive card on
Lark, action buttons on Slack, etc.) and immediately returns `{ message_id }`.
When the user clicks, the plugin sends `event.approval_callback` referencing
the `callback_token`.

## 7. Plugin manifest

Returned by `initialize`:

```jsonc
{
  "protocolVersion": "1.0",
  "plugin": { "name": "lark", "version": "0.1.0" },
  "tenantIdFormat": "lark.tenant_key",   // documentary; SNACA does not parse
  "capabilities": {
    "send_message": true,
    "update_message": true,
    "send_card": true,
    "interactive_card": true,
    "file_upload": true,
    "file_download": true,
    "max_message_bytes": 30720,
    "supports_thread": true,
    "supports_streaming": false
  }
}
```

If a capability is `false`, the host transparently degrades. For example, a
plugin without `interactive_card` causes `approval.present` to fall back to a
plain text "reply yes/no within 5 minutes" loop.

## 8. Methods (plugin → host)

| Method | Direction | Description |
|---|---|---|
| `event.message_received` | notification | A user sent a message in IM. |
| `event.approval_callback` | notification | The user clicked a button on a previously-sent approval card. |
| `event.error` | notification | Plugin-internal error (e.g. lost IM connection). Host logs and may surface in `/healthz`. |
| `log.write` | notification | Forward a structured log line into host tracing. |
| `tool.advertise` | request (M2+) | Plugin offers an extra tool to the engine — used by OpenClaw `api.registerTool`. |
| `command.advertise` | request (M2+) | Plugin offers an IM slash command handler. |

### `event.message_received` params

```jsonc
{
  "auth": "<SNACA_PLUGIN_TOKEN>",
  "tenant_id": "t1",
  "chat_id": "c1",
  "user_id": "u1",
  "message_id": "om_abc",       // plugin-side IM message id (for ack/dedup)
  "content": "@SNACA help me read README",
  "mentions": ["@SNACA"],
  "attachments": [               // optional; download via file.download
    { "id": "att_1", "filename": "spec.pdf", "mime_type": "application/pdf", "size": 12345 }
  ],
  "reply_to": "om_xyz",          // optional thread parent
  "received_at": "2026-05-06T08:00:00Z"
}
```

### `event.approval_callback` params

```jsonc
{
  "auth": "<SNACA_PLUGIN_TOKEN>",
  "callback_token": "<opaque>",   // matches the one passed to approval.present
  "decision": "allow" | "deny" | "allow_once" | "allow_always",
  "user_id": "u1",
  "decided_at": "2026-05-06T08:01:00Z"
}
```

## 9. Error codes

JSON-RPC errors use the standard envelope:

```json
{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": -32601, "message": "method_unsupported", "data": null } }
```

| Code | Symbol | Meaning |
|---|---|---|
| -32700 | parse_error | Invalid JSON. |
| -32600 | invalid_request | Not a valid JSON-RPC 2.0 message. |
| -32601 | method_not_found / method_unsupported | Method not implemented (or capability not advertised). |
| -32602 | invalid_params | Required field missing or wrong type. |
| -32603 | internal_error | Plugin or host crashed. |
| -32000 | auth_failed | Missing / invalid `SNACA_PLUGIN_TOKEN`. Plugin → host only. |
| -32001 | rate_limited | IM platform rejected the call due to rate limit. |
| -32002 | platform_error | Underlying IM platform error; details in `data`. |
| -32003 | not_initialized | Method called before `initialize` completed. |

## 10. Worked example: a full turn

```
[plugin] -> host
  event.message_received {tenant_id:"t1",chat_id:"c1",user_id:"u1",message_id:"om_001",content:"@SNACA grep TODO"}

  -- engine routes to project, runs turn loop, calls Grep tool, gets result --

[host] -> plugin
  message.send {tenant_id:"t1",chat_id:"c1",content:"Found 3 TODOs:\n..."}
  -> { message_id: "om_002" }

[host] -> plugin
  acknowledge {event_id:"om_001"}
  -> {}
```

## 11. Compliance test plan

`snaca-cli protocol-conformance --plugin <cmd>` (M2) drives a registered
plugin through:

1. spawn + initialize handshake.
2. health.ping liveness.
3. round-trip `message.send` → `event.acknowledge`.
4. capability negotiation (assert manifest matches advertised features).
5. approval flow (`approval.present` → simulated callback within timeout).
6. error injection (malformed input → expect `-32602`).
7. graceful shutdown.

A plugin must pass all seven to be considered protocol-conformant.

## 12. Open questions

- **Streaming responses:** how do plugins report progressive token emission
  back to IM (typing indicator vs partial card update)? Current direction:
  `message.update` chunks; `supports_streaming` capability gate. To be
  finalized in M2.
- **Multi-attachment ordering:** if a user sends multiple files in one
  message, is order preserved through `attachments[]`? Yes by convention,
  enforced by plugin implementations — to add to compliance tests.
- **Plugin-supplied tools:** the OpenClaw host plans to surface tools via
  `tool.advertise`. Schema not yet locked — depends on `snaca-tools-api`
  Tool trait stabilizing in M1.

## 13. Change log

- **1.0-draft (M1)** — initial draft.
