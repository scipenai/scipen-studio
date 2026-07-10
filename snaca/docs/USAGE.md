# SNACA Usage Guide

[中文](./USAGE.zh-CN.md) | English

This guide covers building, running, configuring, deploying, and operating
SNACA. For the IM plugin wire protocol, see [im-plugin-protocol.md](./im-plugin-protocol.md).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Rust | 1.88+ | Install with `rustup` |
| Node.js | 22+ | Needed for building the admin Web UI |
| protoc | 3.x | Needed by protobuf/gRPC dependencies |
| SQLite | 3.35+ | Runtime state is stored in `state.sqlite` |
| LLM API key | DeepSeek or Anthropic-compatible | Use environment variables |
| Lark/Feishu app | Optional | Needed for `snaca-plugin-lark` |
| Tavily API key | Optional | Enables `WebSearch` |

DOCX, XLSX, and PPTX extraction is handled by the optional `office-extract`
skill. The core server can start without Python office dependencies.

## Build

```sh
make build       # web SPA + release snaca-server
make release     # server + snaca-plugin-lark + snaca-cli
make package     # release + dist/snaca-<version>-<target>.tar.gz
make test        # cargo test --workspace --all-features
```

The release package contains binaries, `snaca.toml.example`, docs, example
skills, and checksums.

## Docker

The repository includes [Dockerfile](../Dockerfile), [docker-compose.yml](../docker-compose.yml),
and the container config [docker/snaca.toml](../docker/snaca.toml).

```sh
cp .env.example .env
# edit .env and set DEEPSEEK_API_KEY
docker compose up --build
```

Default mapping:

| Host | Container | Purpose |
|---|---|---|
| `localhost:8080` | `0.0.0.0:8080` | admin UI, `/healthz`, `/api/v1/*` |
| `snaca-data` volume | `/data` | `state.sqlite`, workspaces, memory, skills |
| `snaca-config` volume | `/config` | runtime config writable by the admin UI |

On first start, the image initializes `/config/snaca.toml` from
`docker/snaca.toml`. If `[admin].token = ""`, SNACA generates a token, writes
it back to `/config/snaca.toml`, and logs it once. You can also inspect it with:

```sh
docker compose exec snaca grep '^token' /config/snaca.toml
```

To enable the bundled Lark/Feishu plugin:

1. Set `LARK_APP_ID` and `LARK_APP_SECRET` in `.env`.
2. Uncomment the `[[plugins]] name = "lark"` block in `/config/snaca.toml`
   through the admin UI, or export/edit/import the file with `docker compose cp`.
3. Restart the container with `docker compose up -d --build`.

SQLite is intended for a single SNACA instance. Do not run multiple containers
against the same `/data/state.sqlite`.

## Local Config

Copy the example config:

```sh
cp snaca.toml.example snaca.toml
```

Keep secrets in environment variables:

```toml
[llm]
provider = "deepseek"
api_key = "${DEEPSEEK_API_KEY}"
model = "deepseek-chat"
```

Useful container/local differences:

- Use `server.http_listen = "0.0.0.0:8080"` inside containers.
- Use an absolute container path such as `server.data_root = "/data"`.
- Use absolute plugin commands such as `/app/bin/snaca-plugin-lark`.

`Config::load` expands `${VAR}` placeholders in LLM keys, WebSearch keys,
plugin/MCP environment values, and path-bearing fields such as `data_root`,
plugin commands, args, and cwd.

## Runtime Environment

| Variable | Values | Default | Purpose |
|---|---|---|---|
| `SNACA_APPROVAL_MODE` | `allow`, `interactive`, `deny` | `allow` | Approval behavior for risky tools |
| `SNACA_NO_APPROVAL_FALLBACK` | `allow`, `deny` | `allow` | Fallback when a plugin lacks interactive cards |
| `SNACA_BASH_RELAXED` | `1`/`true` or `0`/`false` | `1` | Whether Bash accepts broad shell commands |
| `SNACA_CHAT_MAILBOX` | positive integer | `8` | Per-chat pending message queue size |
| `TAVILY_API_KEY` | API key | unset | Enables `WebSearch` |

Environment variables read by the server must be set in the parent process,
systemd unit, Docker environment, or compose `.env`. Values inside
`[plugins.env]` are only passed to plugin subprocesses.

## IM Plugins

Each `[[plugins]]` block starts one IM channel plugin subprocess:

```toml
[[plugins]]
name = "lark"
command = "${SNACA_DIR}/bin/snaca-plugin-lark"
args = []

[plugins.env]
LARK_APP_ID = "${LARK_APP_ID}"
LARK_APP_SECRET = "${LARK_APP_SECRET}"
LARK_BASE_URL = "https://open.feishu.cn"
```

Plugins speak the SNACA channel protocol over stdio. See
[im-plugin-protocol.md](./im-plugin-protocol.md) for the protocol.

## Admin UI and API

When `[admin].enabled = true`, the embedded admin UI is served at `/` and
authenticated `/api/v1/*` routes are enabled with `[admin].token`.

Common endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/healthz` | GET | Health check and plugin summary |
| `/api/v1/status` | GET | Runtime status |
| `/api/v1/config` | GET | Redacted config snapshot |
| `/api/v1/config/file` | GET / PUT | Read, validate, and write the active config |
| `/api/v1/plugins` | GET | Plugin status |
| `/api/v1/system/shutdown` | POST | Request graceful process exit |

Config changes written through the admin UI take effect after restart. The
restart itself is handled by systemd, Docker, or another supervisor.

## Skills and Files

Skills are loaded from:

| Scope | Path | Priority |
|---|---|---|
| global | configured `skills.global_dir` | lowest |
| tenant | `<data_root>/<tenant_id>/skills/` | medium |
| project | `<data_root>/<tenant_id>/projects/<project_id>/skills/` | highest |

The built-in `Read` tool handles common text and source formats. Office formats
can be handled by copying `examples/skills/office-extract` into a skills
directory and installing its Python dependencies.

## Operations

Run checks before release:

```sh
./scripts/secret-scan.sh
cargo fmt --all -- --check
cargo test --workspace --all-targets
cd web && npm ci && npm run build
```

Inspect SQLite directly when needed:

```sh
sqlite3 data/state.sqlite "SELECT thread_id, role, length(content_json) FROM messages ORDER BY id DESC LIMIT 30"
```

## Further Reading

- [docs/README.md](./README.md) — documentation index
- [im-plugin-protocol.md](./im-plugin-protocol.md) — IM plugin protocol
- [SDK.md](./SDK.md) — Rust SDK guide
- [../crates/snaca-server/src/config.rs](../crates/snaca-server/src/config.rs) — config schema
