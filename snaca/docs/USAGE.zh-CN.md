# SNACA 使用手册

[English](./USAGE.md) | 中文

面向部署者与运维人员，覆盖从源码编译到飞书上线、再到 Skill / 记忆 / MCP 等扩展能力的全流程。开发者更关心的插件协议见 [im-plugin-protocol.md](./im-plugin-protocol.md)。

---

## 1. 先决条件

| 工具 | 版本 | 备注 |
|---|---|---|
| Rust | 1.88+（推荐 stable 最新） | `rustup` 安装即可 |
| Node.js | ≥22；想用 admin Web UI 或走 OpenClaw sidecar 路径就需要 | 纯后端 + 飞书插件可以不装 |
| protoc | 3.x | 需要构建 gRPC / protobuf 相关依赖时安装；通常可通过系统包管理器或 `protobuf` 发行包获得 |
| SQLite | ≥3.35 | sqlx 自带 driver，系统不需要额外安装 |
| LLM API key | DeepSeek 或 Anthropic 任一 | `${DEEPSEEK_API_KEY}` / `${ANTHROPIC_API_KEY}` |
| 飞书自建应用 | 拥有 `im:message`、`im:resource`、`im:message:send_as_bot` 权限 | 用于 `snaca-plugin-lark` |
| Tavily API key | 可选 | 启用 `WebSearch` 工具时填，否则只有 `WebFetch` 可用 |

可选 feature：

- `snaca-server/pdf` — 启用进程内 PDF 文本抽取（依赖 `pdf-extract`）

DOCX / XLSX / PPTX 不再有编译期 feature——这些格式通过仓库自带的 `office-extract` skill 出进程抽取（依赖 `python-docx` / `openpyxl` / `python-pptx`），不装也不影响主程序启动。

---

## 2. 编译与目录布局

```bash
# 一次性编译全部成员（带 PDF 抽取 feature）
cargo build --workspace --features snaca-server/pdf

# 一条命令同时构建前端 SPA + release 后端二进制（SPA 嵌入到 snaca-server 里）
make build           # 等价于 (cd web && npm ci && npm run build) && cargo build --release -p snaca-server
make build-noweb     # 只构 server；admin UI 回落到 "SPA not built" JSON，其它功能正常
make release         # 同 build，但额外构 snaca-plugin-lark + snaca-cli（部署实际需要的全套）
make package         # = make release + scripts/package.sh，产物在 dist/snaca-<ver>-<target>.tar.gz
make dev-web         # 起 vite dev server 在 :5173，前端代理到 :8080（开发用）
```

`make package` 产物结构：

```
dist/
├── snaca-0.1.0-x86_64-unknown-linux-gnu.tar.gz
├── snaca-0.1.0-x86_64-unknown-linux-gnu.tar.gz.sha256   ← 旁挂校验和
└── snaca-0.1.0-x86_64-unknown-linux-gnu/                ← 解压后的目录
    ├── bin/{snaca-server, snaca-plugin-lark, snaca-cli}
    ├── snaca.toml.example
    ├── docs/                                            ← 整份 USAGE / 协议规范
    ├── examples/skills/office-extract/                  ← 拷到 skills 目录即可启用
    ├── scripts/install-minimax-skills.sh                ← MiniMax 五件套一键部署（详见 §8.5）
    ├── README.md / LICENSE（如有）
    └── SHA256SUMS                                       ← 包内每个文件的校验和
```

`scripts/package.sh` 是纯打包脚本，不触发任何 cargo / npm 构建——所以只要 release 已经构好就可以单独重跑（覆盖 dist/）。常用环境变量：`VERSION` 覆盖版本号、`TARGET_TRIPLE` 覆盖目标三元组（交叉编译时）、`STRIP=0` 跳过 `strip`、`DIST_DIR` 换输出目录。

### 2.1 Docker 部署

仓库提供 `Dockerfile`、`docker-compose.yml` 和容器专用配置
[`docker/snaca.toml`](../docker/snaca.toml)。Compose 默认只启动
`snaca-server` 和 admin UI；飞书插件配置在 `docker/snaca.toml` 里作为注释块，
需要 IM 接入时再打开。

```bash
cp .env.example .env
# 编辑 .env，至少设置 DEEPSEEK_API_KEY
docker compose up --build
```

默认映射：

| 宿主 | 容器 | 用途 |
|---|---|---|
| `localhost:8080` | `0.0.0.0:8080` | admin UI / `/healthz` / `/api/v1/*` |
| `snaca-data` volume | `/data` | `state.sqlite`、workspace、memory、skills |
| `snaca-config` volume | `/config` | 运行配置，可由 admin UI 写回 |

容器配置和本地开发配置有三个关键差异：

- `server.http_listen` 必须是 `0.0.0.0:8080`，否则端口映射后宿主机访问不到。
- `server.data_root` 使用 `/data`，并通过 Docker volume 持久化。
- 插件命令使用容器内绝对路径，例如 `/app/bin/snaca-plugin-lark`。

首次启动时，镜像内置的 [`docker/snaca.toml`](../docker/snaca.toml) 会初始化到
`snaca-config` volume 的 `/config/snaca.toml`。`[admin].token = ""` 会触发服务端
生成 token 并写回该文件；之后可以在启动日志里找到 token，或通过
`docker compose exec snaca grep '^token' /config/snaca.toml` 查看。

启用 bundled Lark/Feishu 插件时：

1. 在 `.env` 中设置 `LARK_APP_ID` / `LARK_APP_SECRET`。
2. 取消 `/config/snaca.toml` 末尾 `[[plugins]] name = "lark"` 区块的注释。可在
   admin UI 的 System 页修改；命令行场景可用 `docker compose cp` 把配置导出编辑后
   再拷回容器。
3. 重启容器：`docker compose up -d --build`。

注意：SQLite 数据库适合单实例部署；不要让多个 SNACA 容器同时共享同一个
`/data/state.sqlite`。如果启用 `office-extract` 或 MiniMax skills，还需要在镜像里
安装相应 Python / Node / Playwright / LibreOffice 运行时依赖，基础镜像只覆盖主服务和
bundled Lark 插件的常规运行需求。

产物：

| 路径 | 用途 |
|---|---|
| `target/debug/snaca-server` | 主进程，加载配置、起 HTTP、拉起插件、（启用 `[admin]` 时）嵌入 admin SPA |
| `target/debug/snaca-plugin-lark` | 飞书插件子进程 |
| `target/debug/snaca-cli` | 调试 / 运维 CLI（含 mock 插件） |
| `web/dist/` | Vite 构建产物；`snaca-server` build.rs 检测到缺失会打 warning，但不阻断编译 |

数据落盘根目录由配置项 `server.data_root` 决定，常见结构：

```
data-lark/
├── state.sqlite                         ← threads / messages / bindings ...
└── <tenant_id>/                         ← `154ec583b3dad75f` 这种 hash
    ├── skills/<name>.md                 ← tenant 级 Skill
    └── projects/<project_id>/           ← `auto-kapbiztjy2` / `proj-...`
        ├── workspace/                   ← Read/Write/Bash 的 cwd
        ├── memory/{user,project,reference,feedback}/*.md
        ├── memory/MEMORY.md             ← 条目索引；完整快照由引擎按需渲染
        ├── memory/pending/*.json        ← 可选：待人工审批的 MemoryWrite
        ├── settings.json                ← project 级配置
        └── skills/<name>.md             ← project 级 Skill
```

每个 `chat_id` 默认派生一个 `auto-...` 项目；用户可通过 `/snaca create <slug>` 显式建命名项目。

---

## 3. 主程序配置 (`snaca.toml`)

完整 schema 见 [crates/snaca-server/src/config.rs](../crates/snaca-server/src/config.rs)。一个跑得起来的最小配置：

```toml
[server]
http_listen = "127.0.0.1:18080"
data_root = "./data"

[tenant]
id = "default"

[llm]
provider = "deepseek"           # 或 "anthropic"
api_key = "${DEEPSEEK_API_KEY}" # 启动时从环境读取
model = "deepseek-chat"         # R1：deepseek-reasoner
# base_url   = "https://api.deepseek.com"
# timeout_secs = 120
# anthropic_version = "2023-06-01"   # 仅 anthropic provider 用得上

[engine]
max_iterations = 8
history_limit = 20
compact_after_input_tokens = 600000   # DeepSeek 1M 窗口的安全阈
compact_keep_recent = 6
# loop_guard_max_repeats = 3        # 同 (tool, args) 反复触发的硬上限
# memory_extractor = true           # 开 turn 后台记忆提取
# memory_write_approval = false     # MemoryWrite 是否先进入 pending 等人工审批
# history_max_bytes = 1500000       # 最后一道兜底字节剪裁

# 可选：IM 多条碎片输入组装（默认开启）
[im_input]
# assembly_enabled = true
# text_debounce_ms = 1500              # 连发短文本合成一轮
# attachment_wait_secs = 90            # 文件先到时等待用户补要求
# referential_text_wait_secs = 45      # "帮我看这个文件" 先到时等待后续文件
# pending_expire_secs = 300            # 提醒后仍无补充则丢弃 pending
# file_only_autorun = false            # false=文件-only 不自动跑 LLM

# IM 插件，可写多个，进程级互相隔离
[[plugins]]
name = "lark"
command = "./target/debug/snaca-plugin-lark"
args = []

[plugins.env]
LARK_APP_ID = "cli_xxxxxxxxxxxx"
LARK_APP_SECRET = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
LARK_BASE_URL = "https://open.feishu.cn"
LARK_REACTION_EMOJI = "Typing"
RUST_LOG = "info,snaca_plugin_lark=debug,open_lark=info"

# 可选：admin Web UI + /api/v1 REST API（详见 §11.1）
# [admin]
# enabled = true
# token = ""                       # 留空首次启动会自动生成 160-bit token 写回本文件
# cors_origins = ["http://127.0.0.1:5173"]   # vite dev 才需要；同源生产部署留空

# 可选：内置 WebSearch / WebFetch 工具配置
# [web]
# tavily_api_key = "${TAVILY_API_KEY}"  # 不填 WebSearch 仍注册，但调用会返回缺 key 的错误；WebFetch 无需 key

# 可选：跨租户共享的 skills 目录（详见 §8.1）
# [skills]
# global_dir = "./skills-global"

# 可选：日志写文件 + 大小轮转（设置后 stderr 不再收日志）
# [logging]
# filter = "info,snaca_llm=debug"
# file = "./data/logs/snaca-server.log"   # 相对路径锚在配置文件目录；父目录自动创建
# max_size_mb = 50                         # 活动文件超阈值即轮转 → file.1 → file.2 ...
# max_files = 10                           # 保留的归档份数；0 = 不归档（活动文件直接 truncate）

# 可选：[[mcp]] 块，每个对应一个 MCP server
# [[mcp]]
# name = "filesystem"
# transport = "stdio"
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-filesystem", "/some/path"]
```

### 配置要点

- `${VAR}` 占位符在启动时展开，缺失变量会硬失败（fail-fast）。可用字段：`llm.api_key`、`web.tavily_api_key`、`[plugins.env]` / `[mcp.env]` 任意 value，以及路径字段 `server.data_root`、`logging.file`、`skills.global_dir`、`[[plugins]]` / `[[mcp]]` 的 `command` / `args` / `cwd`。比如 `command = "${SNACA_DIR}/bin/snaca-plugin-lark"`，配合 systemd `Environment=SNACA_DIR=/opt/snaca` 让同一份 config 跨机器复用。
- 路径字段优先级：`${VAR}` 展开 → 仍为相对路径时再以**配置文件所在目录**为锚。已展开为绝对路径的不会被二次锚定。`[[plugins]].command` 是少数例外（不做相对锚定，需要绝对路径或走 `${VAR}` / 父 shell `PATH`）。
- `[plugins.env]` 仅写入插件子进程，主进程读不到（例：landlock 相关的 `SNACA_BASH_RELAXED` 必须从父 shell 导出，写在这里不生效）。
- `engine.compact_after_input_tokens`：建议设为模型窗口的 60–75 %。DeepSeek 1M → ≈600 k；Claude Sonnet 200 k → ≈140 k。
- 单租户场景下 `[tenant].id` 设个固定字符串即可；多租户在 M2 由插件 manifest 透传 `tenant_key`。

---

## 4. 启动与停止

### 启动

```bash
export DEEPSEEK_API_KEY="sk-..."
./target/debug/snaca-server --config snaca.toml
```

Bash 工具默认就是 **relaxed**——管道、重定向、`rm` / `curl` / `npm` 等全部可用，Linux 上 landlock 还放开了 `/tmp` + `$HOME` 写入。多租户或不信任部署想锁回 M1 严格白名单：

```bash
export SNACA_BASH_RELAXED=0   # 必须导出在父 shell，[plugins.env] 不会生效
```

健康检查：

```bash
curl http://127.0.0.1:18080/healthz
# {"status":"ok","plugins":[{"name":"lark","initialized":true}]}
```

### 停止

```bash
pkill -f snaca-server          # 子进程会被 supervisor 一并清理
```

### 后台运行

简单做法：

```bash
nohup ./target/debug/snaca-server --config snaca.toml > /tmp/snaca-server.log 2>&1 &
```

systemd / docker 的 unit 模板留给部署方按需写。

### 环境变量参考

下表里的变量都被**主进程**读取，因此必须由启动 `snaca-server` 的**父 shell** 导出（`export VAR=...`），或者由 systemd `Environment=` / docker `-e` 注入。**写到 `snaca.toml` 的 `[plugins.env]` 里不会生效**——那张表只注入到插件子进程。

| 变量 | 取值 | 默认 | 作用 |
|---|---|---|---|
| `SNACA_APPROVAL_MODE` | `allow` / `interactive` / `deny` | `allow` | 工具审批总开关。**默认 `allow`**——自动放行所有需审批的工具调用，**不发卡片**，让 bot 直接干活；`deny` 自动拒绝，LLM 看到 `permission denied` 的 `tool_error` 后会换路；`interactive` 走飞书互动卡片让用户点 ✅/❌（多租户或不信任部署再切回这个）。启动日志会打一行 `approval gate SNACA_APPROVAL_MODE=… resolved=…`，肉眼复核 env 有没有真的进到进程。 |
| `SNACA_NO_APPROVAL_FALLBACK` | `allow` / `deny` | `allow` | **仅在**插件未声明 `interactive_card` 能力时才会被读到（例：mock plugin、还没接卡片的早期适配器）。`SNACA_APPROVAL_MODE` 优先级更高，一旦显式设了 allow/deny，这个变量根本走不到。 |
| `SNACA_BASH_RELAXED` | `1`/`true`/`yes`/`on`（=放开）、`0`/`false`/`no`/`off`（=严格） | `1`（放开） | **默认放开**：Bash 工具接受任意命令——管道、重定向、`rm` / `mv` / `tee` 等全部允许；Linux 上 landlock 把可写路径扩到 workspace + `/tmp` + `$HOME`（pandoc / pdflatex / npm 需要）。读路径不受限。设 `=0` 回到 M1 严格白名单（只读命令 + git 子集，禁止 shell 组合）；多租户或不信任部署用这个。 |
| `SNACA_CHAT_MAILBOX` | 正整数 | `8` | 每个会话（`chat_id`）的待处理消息排队上限。同一会话短时间内消息超过这个数会**丢弃多出来的**并回一条"排队太多"提示（按会话节流，不会刷屏）。不同会话之间天然并发，这个值只影响单会话的突发承受能力。给特别活跃的群可以调到 `16`–`32`。 |
| `RUST_LOG` | tracing-filter 表达式 | `snaca_server=info,snaca_engine=info,snaca_channel_host=info,info` | 日志级别。优先级高于 `snaca.toml [logging].filter`。 |
| `${VAR}` 占位符 | 例：`DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` | — | `snaca.toml` 里 `${VAR}` 形式的占位符在启动时展开，缺失变量**硬失败**。 |

插件子进程的环境变量（`LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_BASE_URL` / `LARK_REACTION_EMOJI` 等）从 `snaca.toml` 的 `[plugins.env]` 注入，见第 3 节。

一个完整的"撒开手让 SNACA 干活"的启动命令：

```bash
export DEEPSEEK_API_KEY="sk-..."
# 两个权限相关 env var 都已经默认放开：
#   SNACA_APPROVAL_MODE 默认 allow（不再弹审批卡）
#   SNACA_BASH_RELAXED  默认 1（Bash 任意命令 + /tmp + $HOME 可写）
# 想反过来收紧：=interactive / =0。
export RUST_LOG=info,snaca_server=debug,snaca_server::gate=debug
./target/debug/snaca-server --config snaca.toml
```

启动头几行你应当看到：

```
INFO  starting snaca-server listen=... provider=deepseek model=... plugins=1
INFO  approval gate SNACA_APPROVAL_MODE=<unset> resolved=allow (default — auto-allow, no card sent)
```

如果 `resolved=` 那段跟你 export 的不一致，说明 env 没传进进程（最常见原因：server 是更早起的、或被 systemd 接管了没有继承当前 shell）。验证手段：

```bash
cat /proc/$(pgrep -f snaca-server | head -1)/environ | tr '\0' '\n' | grep SNACA_
```

---

## 5. 接入飞书（生产路径）

### 5.1 飞书侧

1. 在「开发者后台 → 我的应用」创建一个**自建应用**，拿到 `App ID` / `App Secret`。
2. 「权限管理」勾选：
   - `im:message`（接收消息）
   - `im:message:send_as_bot`（发消息）
   - `im:resource`（上下行附件）
   - 群聊场景再加 `im:chat:read` 等
3. 「事件订阅」选 **WebSocket** 模式（plugin 默认拉长连接）。
4. 「机器人」启用后发布版本，邀请到测试群或私聊。

### 5.2 SNACA 侧

把第 3 节示例配置粘贴 `snaca.toml`，填上 `LARK_APP_ID` / `LARK_APP_SECRET`，启动。日志看到这两行就稳了：

```
plugin initialized plugin=lark advertised_version=0.1.0 protocol_version=1.0
connected to wss://msg-frontier.feishu.cn/ws/v2?...
```

### 5.3 飞书表情反应

`LARK_REACTION_EMOJI` 必须是飞书白名单内的 emoji 名，否则 Lark 会回 `code 231001` 拒绝。常用值：`Typing` / `OK` / `THUMBSUP` / `EYES`（注意 EYES 不在最新白名单内，部分租户会被拒）。

### 5.4 与 OpenClaw 兼容路径的取舍

| 路径 | 适用场景 |
|---|---|
| `snaca-plugin-lark`（本仓） | 不愿装 Node、要纯 Rust 部署、功能子集足够 |
| `snaca-plugin-openclaw-host`（独立仓库） | 已经有 OpenClaw 生态包想直接复用、要跑钉钉 / Slack 等多家 |

两条路径不冲突，可以同一个 `snaca.toml` 里同时开两个 `[[plugins]]`。

---

## 6. 调试用 mock 插件

```bash
# 在 snaca.toml 里改成：
# [[plugins]]
# name = "mock"
# command = "./target/debug/snaca-cli"
# args = ["mock-plugin"]

./target/debug/snaca-server --config snaca.toml
# 然后对着 mock 插件的 stdin 粘 JSON-RPC：
echo '{"jsonrpc":"2.0","method":"event.message_received","params":{"tenant_id":"default","chat_id":"c1","user_id":"u1","message_id":"m1","content":"@SNACA 列一下当前目录","received_at":"2026-05-07T00:00:00Z","auth":"<token>"}}' \
  | ./target/debug/snaca-cli mock-plugin
```

实际生产里 mock 用得不多；它的价值在于不依赖 IM 平台、跑 protocol 级别的回归。

---

## 7. 在 IM 里使用 SNACA

### 7.1 一般对话

机器人加群后 `@SNACA <问题>` 即可。私聊直接发文本（不需要 @）。第一次提问会自动给 `chat_id` 派生一个 `auto-...` 项目。

### 7.2 Slash 命令

发送以 `/snaca` 开头的消息（或先 @ 机器人再写 `/snaca`）：

| 命令 | 作用 |
|---|---|
| `/snaca create <slug>` | 在当前 chat 上绑定一个新项目（slug 形如 `alpha-1`） |
| `/snaca switch <slug>` | 切到已有项目；不存在则创建（同 create） |
| `/snaca list` | 当前租户的所有项目 |
| `/snaca status` | 当前 chat 绑到了哪个 tenant / project |
| `/snaca help` | 简短参考卡 |

群聊里项目按 `(chat_id, sender_id)` 二元组绑定，不同人可以在同群切到自己的项目。

### 7.3 工具调用

LLM 看得到下面这套工具（顺序可能因 MCP / Skill 而扩展）：

| 工具 | 默认审批 | 说明 |
|---|---|---|
| `Read` / `Grep` / `Glob` / `LS` | 永不审批 | 只读，全在 workspace 沙箱内 |
| `Bash` | 写命令默认放行（`SNACA_APPROVAL_MODE=allow`），收紧后写命令需审批 | 默认 relaxed：任意命令 + landlock 放宽到 workspace/`/tmp`/`$HOME`；`SNACA_BASH_RELAXED=0` 回到严格白名单 |
| `Write` / `Edit` / `MultiEdit` | 写入审批 | 路径强制 `resolve_within(workspace_root)` |
| `TodoWrite` | 永不 | session 内 task list |
| `MemoryRead` / `MemoryWrite` | 永不 / 永不 | 操作 `memory/<scope>/*.md` |
| `SendFile` | 永不 | 把 workspace 里的文件作为附件回传到 IM（≤50 MB） |
| `WebSearch` | 永不 | Tavily 后端；缺 `[web].tavily_api_key` 时调用会返回明确错误，工具不消失 |
| `WebFetch` | 永不 | 抓 URL 转 Markdown；不跟跨 host 跳转，私网 / 本地地址（127.x、RFC1918、`*.internal` 等）拒绝 |
| `Skill` | 永不 | 触发后续的 skill body 指令；按 frontmatter `allowed_tools` 限工具 |

需要审批的工具会通过 `approval.present` → 飞书互动卡片落到聊天里，按钮：✅ 允许 / ✅ 始终允许 / ❌ 拒绝。决策落到 `<project>/settings.json`。

默认 `SNACA_APPROVAL_MODE=allow`——bot 自治，卡片完全不出。想恢复"每次写都问一下"行为，export `SNACA_APPROVAL_MODE=interactive`；想反过来让任何需审批工具都被拒绝（多租户/不信任场景），设 `=deny`。详见第 4 节的环境变量表。

### 7.4 上下行附件

- **下行**（agent → 用户）：让 SNACA 用 `SendFile` 工具发文件，例如「把刚才生成的 markdown 用 SendFile 发给我」。
- **上行**（用户 → agent）：直接在飞书拖文件 / 图片。SNACA 会先把同一用户的短时间多条 IM 输入组装成一轮：
  - `文件 → 处理要求`、`处理要求 → 文件`、`多个文件 → 处理要求` 都会合并后再进 agent。
  - 只有文件、没有要求时，默认只暂存并提示用户继续发送处理要求；发送「开始处理」才按默认方式提交，发送「取消」会丢弃 pending。
  - 普通连发文本只做短 debounce；`/snaca ...` 命令、审批/问题回复不参与组装。
  - 群聊按 `(chat_id, user_id, reply_to)` 隔离，避免 A 的文件绑定到 B 的文字。
  - `[im_input]` 可调等待窗口；`file_only_autorun = true` 可恢复文件-only 超时后自动处理。
- 文件真正提交给 agent 后，SNACA 落地两份：
  1. `<workspace>/<basename>` 让 Read/Bash 可见
  2. 走 memory 导入流水线：MD / code / zip 进程内解；PDF 走 `snaca-server/pdf` feature；DOCX / XLSX / PPTX 走仓库自带的 `office-extract` skill 出进程抽取（缺依赖时报错可见，主进程不挂）

---

## 8. Skills（指令片段）

Skill 是一段带 YAML frontmatter 的 markdown，触发后把 body 作为补充指令塞进当前 turn。

### 8.1 文件位置

| Scope | 路径 | 优先级 |
|---|---|---|
| `bundled` | 二进制内嵌（M3 之后预留） | 最低 |
| `global`  | `[skills].global_dir` 指向的目录（详见 §3） | 低（跨所有 tenant 共享） |
| `tenant`  | `<data_root>/<tenant_id>/skills/<name>.md` | 中（同名覆盖 global） |
| `project` | `<data_root>/<tenant_id>/projects/<project_id>/skills/<name>.md` | 最高（同名覆盖 tenant） |

`global` scope 适合「所有租户都要遵守的公司级写作规范」「统一的 changelog 格式」这类公共指令。文件丢失/路径不存在不报错，启动后改文件 5 秒内热加载——与 tenant / project 完全一致。

**目录布局**（global / tenant / project 三种 scope 用同一套扫描规则）：

```
<skills-root>/
├── auth.md                       ← 平铺：直接是一个 skill
├── changelog/
│   ├── SKILL.md                  ← 目录式：folder + SKILL.md = 一个 skill
│   └── templates/                ← SKILL.md 同级的任何资源会作为 sidecar 暴露给该 skill
│       └── release.md            ← 不会被当成独立 skill
├── dev/                          ← 没 SKILL.md ⇒ 分类目录，继续往下扫
│   ├── auth.md                   ← 平铺 skill
│   ├── login.md
│   └── advanced/
│       └── jwt-refresh/
│           └── SKILL.md          ← 任意深度的目录式 skill 都会加载
└── .git/                         ← `.` 开头的文件/目录全树跳过
```

要点：

- **目录式 skill**（folder + `SKILL.md`）一旦命中就**停止下钻**，里头的文件全部视为该 skill 的 sidecar 资源——这是单个 skill 想带 prompt 之外的脚本/模板时该用的形式。
- **分类目录**（folder 内没有 `SKILL.md`）只是组织手段，可以任意深度嵌套，里面的 `*.md` 当平铺 skill 加载，里面再嵌的 `<name>/SKILL.md` 当目录式加载。
- **skill 名字以 frontmatter 的 `name:` 为准**，跟文件路径无关；跨目录同 scope 同名时只保留先加载的那个并打 warn——所以分类目录起到的是组织作用，不影响命名空间。
- **隐藏文件/目录**（名字以 `.` 起头）全树跳过，`.git`、`.cache`、编辑器 swap 文件不会污染。

### 8.2 Frontmatter

```markdown
---
name: pirate-mode               # 唯一名字；LLM 通过这个调用
description: 一行内的功能介绍   # 出现在 Skill 工具的描述里
when_to_use: 用户希望用海盗口吻说话时
allowed_tools: []               # 限制本 skill 触发后能调的工具
---

正文是给 LLM 的指令……
```

`allowed_tools` 留空表示沿用现有工具集；填了之后只允许列出的工具。

### 8.3 调用流程

1. SNACA 启动后 `LayoutSkillProvider` 每 5 秒重新扫描 skills 目录，**热加载**，无需重启。
2. 当存在任何 skill 时，工具集中会出现一个 `Skill` 工具，描述里枚举所有可用 skill + when_to_use。
3. 当用户的话命中 when_to_use 描述时，LLM 主动 `Skill(name="<id>")`，之后按 body 指令完成回复。

### 8.4 例子

参见仓库里两个示例：
- 项目级 [pirate-mode.md](../data-lark/154ec583b3dad75f/projects/auto-kapbiztjy2/skills/pirate-mode.md)
- 租户级 [changelog-format.md](../data-lark/154ec583b3dad75f/skills/changelog-format.md)

### 8.5 一键部署 MiniMax skills

`scripts/install-minimax-skills.sh`（包内 `scripts/` 下，`make package` 自动塞入 tarball）把 [MiniMax-AI/skills](https://github.com/MiniMax-AI/skills) 仓库的五个本地工具型 skill 部署到指定目录，并装好它们各自需要的运行时。

| Skill | 干什么 | 运行时依赖 |
|---|---|---|
| `minimax-pdf` | 生成/填表/重排 PDF（带封面设计系统） | python3 + reportlab/pypdf/matplotlib，Node + Playwright Chromium |
| `minimax-docx` | OpenXML DOCX 创建/编辑/套模板 | .NET 8 SDK（脚本会装 `~/.dotnet`），构建产物 `MiniMaxAIDocx.Cli` |
| `minimax-xlsx` | XLSX 读写/公式校验/格式 | python3 + pandas/openpyxl/lxml，可选 LibreOffice 用于公式重算 |
| `pptx-generator` | PptxGenJS 出 PPTX，markitdown 抽文本 | Node + pptxgenjs，python3 + `markitdown[pptx]` |
| `pptx-plugin` | PPT orchestra（封面/TOC/正文/分节/总结子 skill 套件） | 同 `pptx-generator` |

> 全部**纯本地工具**，不调任何 MiniMax 服务端 API。

#### 用法

```bash
# 解压 tarball 后在包根目录：
./scripts/install-minimax-skills.sh --dest ./skills-global
```

跑完后会装到 `./skills-global/{minimax-pdf,minimax-docx,minimax-xlsx,pptx-generator,pptx-plugin}/`，然后在 `snaca.toml` 启用：

```toml
[skills]
global_dir = "/绝对路径/skills-global"
```

snaca 的目录扫描会自动把 `pptx-plugin/skills/*` 下的 5 个嵌套 skill（color-font / design-style / ppt-editing / ppt-orchestra / slide-making）也一并加载，所以总共 9 个 skill 进注册表。

#### 常用 flag

| flag | 作用 |
|---|---|
| `--dest DIR` | 部署目录，默认 `./skills-global` |
| `--ref REF` | git ref，默认 `main` |
| `--source-dir DIR` | 用已 clone 的本地源，跳过 `git clone`（离线/重跑） |
| `--skip-deps` | 只布文件，不动 pip/npm/dotnet |
| `--minimal` | 必需依赖装，跳过 LibreOffice/CJK 字体/pandoc（约省 600MB） |
| `--skip SKILL` | 可重复。例：`--skip minimax-docx` 跳过 .NET SDK 安装 |

#### 注意事项

- **sudo**：脚本会在需要装系统包时弹 sudo 提示。无 TTY 环境（CI/远程脚本）请先 `sudo -v` 缓存。
- **.NET SDK 8**：脚本优先用 apt/dnf/brew 装；找不到就用 Microsoft 官方 `dotnet-install.sh` 装到 `$HOME/.dotnet`，会在 `~/.bashrc` / `~/.zshrc` 追加一行 PATH。snaca-server 通过子进程调 `dotnet`，记得它的启动 shell 能看到这个 PATH。
- **Playwright Chromium**：上游对宿主 OS 版本有预编译矩阵限制，太新的发行版（如 Ubuntu 26.04）可能装不上，脚本会 warn 但不阻塞。仅影响 `minimax-pdf` 封面渲染那一步，其他流程不受影响；修复办法：`npm install -g playwright@latest && npx playwright install chromium`。
- **幂等**：重跑会 `rsync --delete` 覆盖目标目录，已装的系统/pip/npm 包会被检测后跳过。

---

## 9. 记忆系统

### 9.1 文件结构

```
memory/
├── MEMORY.md                  ← 索引；启动时被注入 system prompt
├── user/<topic>.md            ← 用户偏好 / 角色
├── feedback/<topic>.md        ← 用户对 agent 行为的反馈
├── project/<topic>.md         ← 项目状态 / 决策
└── reference/<topic>.md       ← 外部信息指针
```

每条 markdown 都有 frontmatter：

```markdown
---
name: testing-policy
description: 集成测试不允许 mock 数据库
type: feedback
---

正文……
```

### 9.2 写入

- LLM 通过 `MemoryWrite` 工具在对话里直接落盘。
- 启 `engine.memory_extractor = true` 后，每 turn 结束 SNACA 跑一次后台抽取，把对话里的偏好 / 反馈写入。

### 9.3 检索

SNACA 不再维护向量 recall 索引。每个 thread 第一次 turn 会把当前项目记忆树渲染成冻结快照注入 system prompt；同一 thread 中后续 `MemoryWrite` 仍会落盘，但要到新 thread 或显式失效后才会进入提示词。需要查历史对话时，模型可用 `SessionSearch` 工具按 FTS5 搜索 transcript。

### 9.4 命令行查看

```bash
./target/debug/snaca-cli memory list   --data-root ./data --tenant default --project auto-kapbiztjy2
./target/debug/snaca-cli memory index  --data-root ./data --tenant default --project auto-kapbiztjy2
./target/debug/snaca-cli memory show   --data-root ./data --tenant default --project auto-kapbiztjy2 --scope user --name role
./target/debug/snaca-cli memory import --data-root ./data --tenant default --project auto-kapbiztjy2 ./docs/  # 批量导入目录
./target/debug/snaca-cli memory pending --data-root ./data --tenant default --project auto-kapbiztjy2
```

> `pending` / `approve` / `reject` 只在 `engine.memory_write_approval = true` 时有内容；用于把 LLM 发起的 MemoryWrite 先暂存给人工审核。

---

## 10. MCP Server 集成

每个 `[[mcp]]` 块对应一个外部 MCP server。SNACA 按 `(tenant, project, server)` 三元组缓存子进程；同一租户内默认 5 个活跃、10 分钟空闲淘汰。

```toml
[[mcp]]
name = "filesystem"
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/share"]
init_timeout_secs = 30

[[mcp]]
name = "remote-tool"
transport = "http"
command = ""    # http 模式忽略 command
# url 等远端字段在对应 transport 的实现里
```

工具命名固定为 `mcp__<server_name>__<tool>`，会进入同一个 ToolRegistry，被 LLM 一并看到。

---

## 11. 运维与排错

### 11.1 admin HTTP API

`snaca-server` 同一个监听端口上挂了三个层级的 HTTP 入口：

**legacy `/admin/*`** — 无需鉴权，给 `snaca admin` CLI 用，老脚本不变：

| 路径 | 方法 | 作用 |
|---|---|---|
| `/healthz` | GET | 健康检查 + plugin 列表 |
| `/admin/plugins` | GET | 所有插件状态 JSON |
| `/admin/plugins/{name}/reload` | POST | 杀掉指定插件并重启（不影响其他对话） |
| `/admin/threads/{thread_id}/abort` | POST | 中止指定 thread 正在跑的 turn |

```bash
curl http://127.0.0.1:18080/admin/plugins | jq
curl -X POST http://127.0.0.1:18080/admin/plugins/lark/reload
```

**`/api/v1/*`** — Bearer 鉴权（`[admin].token`），给 Web UI 和外部脚本用。只在 `[admin].enabled = true` 时挂载，否则整个 `/api/v1` 返回 503：

| 路径 | 方法 | 作用 |
|---|---|---|
| `/api/v1/status` / `/config` | GET | 运行时摘要 + 配置快照（脱敏） |
| `/api/v1/config/file` | GET / PUT | 读取 / 校验并写回 `snaca.toml` 原文；保存后重启生效 |
| `/api/v1/system/shutdown` | POST | 请求进程正常退出；由 systemd/docker 等 supervisor 重启后加载新配置 |
| `/api/v1/plugins` / `/plugins/{name}/reload` | GET / POST | 同 legacy，加 token |
| `/api/v1/tenants` / `/tenants/{t}/projects` | GET | 浏览租户和项目 |
| `/api/v1/projects/{t}/{p}/threads` | GET | 项目下所有 thread |
| `/api/v1/threads/{id}/messages` / `/abort` | GET / POST | 消息回放 / 中止 turn |
| `/api/v1/approvals` | GET / DELETE | 列出 / 撤销已经持久化的「始终允许」决策 |
| `/api/v1/schedules` / `/schedules/{id}` / `/schedules/{id}/enabled` | GET / POST / DELETE / PATCH | 创建 / 查看 / 删除 / 暂停定时任务 |
| `/api/v1/outbox` / `/outbox/{id}/retry` | GET / POST | 查未投递消息 / 手动 retry |

```bash
TOKEN=$(grep '^token' snaca.toml | head -1 | cut -d'"' -f2)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18080/api/v1/status | jq
```

**embedded SPA `/`** — 同样在 `[admin].enabled = true` 下生效。访问 `http://<host>:<port>/` 进入登录页，把上面那个 token 粘进去就能用。页面：Dashboard / Plugins / Threads / Approvals / Schedules / Outbox / System，i18n 中英双语。System 页可以直接维护当前 `--config` 指向的 `snaca.toml`：左侧表单结构化覆盖 `Config` schema 的几乎全部字段——监听地址 / 数据目录 / 租户、LLM（含重试与 `anthropic_version`）、engine（迭代/超时/并发、输出 token 上探、循环保护）、历史压缩、记忆（embedder / 抽取器 / 重排序）、admin、logging（含轮转）、`[[plugins]]`、`[[mcp]]`；每个字段都带有内联说明（中英双语，取自 `Config` 字段语义），不必离开页面查源码或 `snaca.toml.example`；右侧完整 TOML 编辑器用于任何剩余的高级项，且始终是最终真实来源。保存前服务端会用同一套启动配置解析器校验，校验失败不会覆盖文件；保存成功后需要重启 `snaca-server` 才会应用到 LLM、插件、MCP、HTTP listener 等启动期资源。页面上的「重启/退出服务」会请求进程正常退出；它不做进程内热重载，实际重启依赖 systemd/docker/supervisord 等外部进程管理器。

前端源码在 [`web/`](../web/)；`make build` 会把 `web/dist/` 嵌进 `snaca-server` 二进制（rust-embed），所以发布时只丢一个 elf 也带 UI。

首次启动看启动日志找 token：

```
INFO  admin token generated and persisted to snaca.toml: NUWXSY3M...
```

要轮换：清掉 `snaca.toml` 里的 `token = "..."` 值，重启即可。

### 11.2 CLI 运维命令

```bash
# 直连 state.sqlite，无需 server 在跑
./target/debug/snaca-cli tenant  list   --data-root ./data
./target/debug/snaca-cli project list   --data-root ./data --tenant default
./target/debug/snaca-cli binding list   --data-root ./data

# 远程 admin（需要 server 在跑）
./target/debug/snaca-cli plugin  list   --server http://127.0.0.1:18080
./target/debug/snaca-cli plugin  reload --server http://127.0.0.1:18080 lark
./target/debug/snaca-cli health         --server http://127.0.0.1:18080
```

### 11.3 日志

- 主进程：默认走 stderr，可用 `RUST_LOG=info,snaca_engine=debug` 之类调粒度。
- 写文件 + 轮转：`[logging].file` 设置后所有 tracing 输出改走非阻塞后台 writer 写文件，stderr 不再收日志。`max_size_mb`（默认 50）触发一次 `file.log → file.log.1 → file.log.2 …` 的位移，`max_files`（默认 10）控制归档保留份数；`max_files = 0` 表示不归档（活动文件直接 truncate 重来）。systemd / docker 部署推荐开这个，避免 journald 重复收一份。
- 飞书插件：日志通过协议反向 `log.write` 上报，主进程 INFO 级别打印。
- 启动失败常见原因：
  - `environment variable DEEPSEEK_API_KEY is not set` → `${VAR}` 没在父 shell 导出。
  - `Could not automatically determine CryptoProvider` → 重新 `cargo build`，新二进制已经 `install_default()` ring。
  - `code 231001` → reaction emoji 不在飞书白名单。
  - `logging.max_size_mb must be > 0` → 显式写了 `max_size_mb = 0`，去掉或改正值。

### 11.4 数据库直查

```bash
sqlite3 data/state.sqlite "SELECT thread_id, role, length(content_json) FROM messages ORDER BY id DESC LIMIT 30"
sqlite3 data/state.sqlite "SELECT * FROM chat_session_binding"
```

### 11.5 常见症状

| 症状 | 一般原因 | 处理 |
|---|---|---|
| LLM 报「tool_calls without tool messages」 | 历史里有 dangling tool_use | 当前版本 `ensure_tool_result_pairing`（请求边界统一兜底）会修复；继续报就 `truncate messages` 或建新 thread |
| 「turn loop exceeded N iterations」 | LLM 在某个工具上反复重试 | 看日志哪个工具 / 参数；考虑放宽 Bash relaxed 或扩 max_iterations |
| context length exceeded | 大附件入栈 | 调小 `compact_after_input_tokens` 或 `history_max_bytes` |
| approval card 没出现 | 默认 `SNACA_APPROVAL_MODE=allow` 已经全放行（v0 后改的默认），或工具是 ApprovalRequirement::Never，或插件没声明 `interactive_card` 能力 | 启动日志 `approval gate ... resolved=...` 那行先确认模式；想恢复卡片就 `export SNACA_APPROVAL_MODE=interactive` |
| AI 总说"我只能只读 / 无法写入" | `engine.system_prompt` 被覆盖成限制性文本，或 `SNACA_APPROVAL_MODE=deny` 把每次写都拒了 | 留空 `[engine].system_prompt` 用默认值；unset `SNACA_APPROVAL_MODE`（默认就是 allow）或显式 `=allow` |
| skills 不生效 | frontmatter 写错 / 没等满 5 秒 cache | `tail -f` 服务日志看 `loaded skills count=N`；frontmatter `name` 为空会整文件被拒 |

---

## 12. 测试

```bash
cargo test --workspace --features snaca-server/pdf
```

跑完应当全绿（无 warning）。手测 IM 端到端用第 5/6 节的方案。

---

## 13. 进一步阅读

- [im-plugin-protocol.md](./im-plugin-protocol.md) — IM 插件协议规范
- [../crates/snaca-server/src/config.rs](../crates/snaca-server/src/config.rs) — 配置 schema 完整字段（含未在本手册展开的）
- [../crates/snaca-engine/src/engine.rs](../crates/snaca-engine/src/engine.rs) — turn loop 实现入口
