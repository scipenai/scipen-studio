# SNACA 使用手册

面向部署者与运维人员，覆盖从源码编译到飞书上线、再到 Skill / 记忆 / MCP 等扩展能力的全流程。开发者更关心的内部协议见 [im-plugin-protocol.md](./im-plugin-protocol.md)；项目愿景与里程碑见 [../plan.md](../plan.md)。

---

## 1. 先决条件

| 工具 | 版本 | 备注 |
|---|---|---|
| Rust | 1.78+（推荐 stable 最新） | `rustup` 安装即可 |
| Node.js | 仅当走 OpenClaw sidecar 路径时才需要，≥22 | 纯 Rust 飞书插件不依赖 |
| protoc | 3.x（或本仓自带的 wrapper 也可） | `.cargo/config.toml` 已经把 `PROTOC` 指向 `/tmp/protoc-wrapper.sh` |
| SQLite | ≥3.35 | sqlx 自带 driver，系统不需要额外安装 |
| LLM API key | DeepSeek 或 Anthropic 任一 | `${DEEPSEEK_API_KEY}` / `${ANTHROPIC_API_KEY}` |
| 飞书自建应用 | 拥有 `im:message`、`im:resource`、`im:message:send_as_bot` 权限 | 用于 `snaca-plugin-lark` |

可选 feature：

- `snaca-server/pdf` — 启用 PDF 附件抽取（依赖 `pdf-extract`）
- `snaca-server/docx` — 启用 DOCX 附件抽取
- `snaca-memory/fastembed` — 用真实 ONNX embedder 替换默认的 hash stub

---

## 2. 编译与目录布局

```bash
# 一次性编译全部成员（含上面两个文档抽取 feature）
cargo build --workspace --features snaca-server/pdf,snaca-server/docx
```

产物：

| 路径 | 用途 |
|---|---|
| `target/debug/snaca-server` | 主进程，加载配置、起 HTTP、拉起插件 |
| `target/debug/snaca-plugin-lark` | 飞书插件子进程 |
| `target/debug/snaca-cli` | 调试 / 运维 CLI（含 mock 插件） |

数据落盘根目录由配置项 `server.data_root` 决定，常见结构：

```
data-lark/
├── state.sqlite                         ← threads / messages / bindings ...
└── <tenant_id>/                         ← `154ec583b3dad75f` 这种 hash
    ├── skills/<name>.md                 ← tenant 级 Skill
    └── projects/<project_id>/           ← `auto-kapbiztjy2` / `proj-...`
        ├── workspace/                   ← Read/Write/Bash 的 cwd
        ├── memory/{user,project,reference,feedback}/*.md
        ├── memory/MEMORY.md             ← 索引（系统提示注入）
        ├── memory/.index/               ← 向量索引（启用 fastembed 后）
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
# memory_embedder = "fastembed"     # 启 vector recall 时填
# memory_extractor = true           # 开 turn 后台记忆提取
# memory_reranker = true            # 开 LLM rerank
# history_max_bytes = 1500000       # 最后一道兜底字节剪裁

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

# 可选：[[mcp]] 块，每个对应一个 MCP server
# [[mcp]]
# name = "filesystem"
# transport = "stdio"
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-filesystem", "/some/path"]
```

### 配置要点

- `${VAR}` 占位符在启动时展开，缺失变量会硬失败（fail-fast）。
- `data_root` 相对路径以**配置文件所在目录**为锚，不是进程 CWD。
- `[plugins.env]` 仅写入插件子进程，主进程读不到（例：landlock 相关的 `SNACA_BASH_RELAXED=1` 必须从父 shell 导出）。
- `engine.compact_after_input_tokens`：建议设为模型窗口的 60–75 %。DeepSeek 1M → ≈600 k；Claude Sonnet 200 k → ≈140 k。
- 单租户场景下 `[tenant].id` 设个固定字符串即可；多租户在 M2 由插件 manifest 透传 `tenant_key`。

---

## 4. 启动与停止

### 启动

```bash
export DEEPSEEK_API_KEY="sk-..."
./target/debug/snaca-server --config snaca.toml
```

如果想让 Bash 工具在容器外执行（默认 landlock + 命令白名单较严格）：

```bash
export SNACA_BASH_RELAXED=1   # 必须导出在父 shell，[plugins.env] 不会生效
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
| `SNACA_APPROVAL_MODE` | `interactive` / `allow` / `deny` | `interactive` | 工具审批总开关。`allow` 自动放行所有需审批的工具调用，**不发卡片**；`deny` 自动拒绝，LLM 看到 `permission denied` 的 `tool_error` 后会换路；`interactive` 走飞书互动卡片让用户点 ✅/❌。启动日志会打一行 `approval gate SNACA_APPROVAL_MODE=… resolved=…`，肉眼复核 env 有没有真的进到进程。 |
| `SNACA_NO_APPROVAL_FALLBACK` | `allow` / `deny` | `allow` | **仅在**插件未声明 `interactive_card` 能力时才会被读到（例：mock plugin、还没接卡片的早期适配器）。`SNACA_APPROVAL_MODE` 优先级更高，一旦显式设了 allow/deny，这个变量根本走不到。 |
| `SNACA_BASH_RELAXED` | 任意非空值（习惯写 `1`） | unset | 关闭 Bash 工具的 landlock + 命令白名单，按 LLM 给的命令原样执行（路径仍然被锁在 workspace 内）。需要 `mv` / `rm` / `tee` / 复杂管道时必开。 |
| `RUST_LOG` | tracing-filter 表达式 | `snaca_server=info,snaca_engine=info,snaca_channel_host=info,info` | 日志级别。优先级高于 `snaca.toml [logging].filter`。 |
| `${VAR}` 占位符 | 例：`DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` | — | `snaca.toml` 里 `${VAR}` 形式的占位符在启动时展开，缺失变量**硬失败**。 |

插件子进程的环境变量（`LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_BASE_URL` / `LARK_REACTION_EMOJI` 等）从 `snaca.toml` 的 `[plugins.env]` 注入，见第 3 节。

一个完整的"撒开手让 SNACA 干活"的启动命令：

```bash
export DEEPSEEK_API_KEY="sk-..."
export SNACA_APPROVAL_MODE=allow      # 不再每次写文件都弹卡片
export SNACA_BASH_RELAXED=1           # 放开 Bash 白名单
export RUST_LOG=info,snaca_server=debug,snaca_server::gate=debug
./target/debug/snaca-server --config snaca.toml
```

启动头几行你应当看到：

```
INFO  starting snaca-server listen=... provider=deepseek model=... plugins=1
INFO  approval gate SNACA_APPROVAL_MODE=allow resolved=allow (auto-allow, no card sent)
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
| `Bash` | 写命令需审批；relaxed 模式按白名单放行 | 默认 landlock + 命令白名单 |
| `Write` / `Edit` / `MultiEdit` | 写入审批 | 路径强制 `resolve_within(workspace_root)` |
| `TodoWrite` | 永不 | session 内 task list |
| `MemoryRead` / `MemoryWrite` | 永不 / 永不 | 操作 `memory/<scope>/*.md` |
| `SendFile` | 永不 | 把 workspace 里的文件作为附件回传到 IM（≤50 MB） |
| `Skill` | 永不 | 触发后续的 skill body 指令；按 frontmatter `allowed_tools` 限工具 |

需要审批的工具会通过 `approval.present` → 飞书互动卡片落到聊天里，按钮：✅ 允许 / ✅ 始终允许 / ❌ 拒绝。决策落到 `<project>/settings.json`。

想跳过卡片让机器人完全自治，设 `SNACA_APPROVAL_MODE=allow`；想反过来让任何需审批工具都被拒绝（多租户/不信任场景），设 `=deny`。详见第 4 节的环境变量表。

### 7.4 上下行附件

- **下行**（agent → 用户）：让 SNACA 用 `SendFile` 工具发文件，例如「把刚才生成的 markdown 用 SendFile 发给我」。
- **上行**（用户 → agent）：直接在飞书拖文件 / 图片。SNACA 落地两份：
  1. `<workspace>/<basename>` 让 Read/Bash 可见
  2. 走 memory 导入流水线（PDF/DOCX/MD/code/zip）

---

## 8. Skills（指令片段）

Skill 是一段带 YAML frontmatter 的 markdown，触发后把 body 作为补充指令塞进当前 turn。

### 8.1 文件位置

| Scope | 路径 | 优先级 |
|---|---|---|
| `bundled` | 二进制内嵌（M3 之后预留） | 最低 |
| `tenant`  | `<data_root>/<tenant_id>/skills/<name>.md` | 中 |
| `project` | `<data_root>/<tenant_id>/projects/<project_id>/skills/<name>.md` | 最高（同名覆盖 tenant） |

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

### 9.3 检索（可选 vector recall）

`engine.memory_embedder` 设为：
- `"none"` / 默认 → 仅注入 `MEMORY.md` 索引
- `"hash"` → 确定性 stub embedder（开发 / smoke 测试）
- `"fastembed"` → ONNX `multilingual-e5-small`（需 `--features fastembed`）

启用后每个 turn 把用户的话 embed → 顶部 `RECALL_POOL_SIZE` cosine 候选 → 可选 LLM rerank → top 5 拼进 system prompt。

### 9.4 命令行查看

```bash
./target/debug/snaca-cli memory list   --data-root ./data --tenant default --project auto-kapbiztjy2
./target/debug/snaca-cli memory index  --data-root ./data --tenant default --project auto-kapbiztjy2
./target/debug/snaca-cli memory show   --data-root ./data --tenant default --project auto-kapbiztjy2 --scope user --name role
./target/debug/snaca-cli memory search --data-root ./data --tenant default --project auto-kapbiztjy2 "测试" -k 5
./target/debug/snaca-cli memory import --data-root ./data --tenant default --project auto-kapbiztjy2 ./docs/  # 批量导入目录
```

> `search` / `import` 用确定性 hash embedder，**仅供调试**，不和服务器在线检索的精度等价；线上质量看 fastembed 路径。

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

| 路径 | 方法 | 作用 |
|---|---|---|
| `/healthz` | GET | 健康检查 + plugin 列表 |
| `/admin/plugins` | GET | 所有插件状态 JSON |
| `/admin/plugins/{name}/reload` | POST | 杀掉指定插件并重启（不影响其他对话） |

```bash
curl http://127.0.0.1:18080/admin/plugins | jq
curl -X POST http://127.0.0.1:18080/admin/plugins/lark/reload
```

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
- 飞书插件：日志通过协议反向 `log.write` 上报，主进程 INFO 级别打印。
- 启动失败常见原因：
  - `environment variable DEEPSEEK_API_KEY is not set` → `${VAR}` 没在父 shell 导出。
  - `Could not automatically determine CryptoProvider` → 重新 `cargo build`，新二进制已经 `install_default()` ring。
  - `code 231001` → reaction emoji 不在飞书白名单。

### 11.4 数据库直查

```bash
sqlite3 data/state.sqlite "SELECT thread_id, role, length(content_json) FROM messages ORDER BY id DESC LIMIT 30"
sqlite3 data/state.sqlite "SELECT * FROM chat_session_binding"
```

### 11.5 常见症状

| 症状 | 一般原因 | 处理 |
|---|---|---|
| LLM 报「tool_calls without tool messages」 | 历史里有 dangling tool_use | 当前版本 `repair_orphan_tool_uses` 会兜底；继续报就 `truncate messages` 或建新 thread |
| 「turn loop exceeded N iterations」 | LLM 在某个工具上反复重试 | 看日志哪个工具 / 参数；考虑放宽 Bash relaxed 或扩 max_iterations |
| context length exceeded | 大附件入栈 | 调小 `compact_after_input_tokens` 或 `history_max_bytes` |
| approval card 没出现 | 工具 ApprovalRequirement::Never，或 `SNACA_APPROVAL_MODE=allow/deny` 绕过了卡片，或插件没声明 `interactive_card` 能力 | 启动日志 `approval gate ... resolved=...` 那行先确认模式；read-only 工具直接执行不触发卡片 |
| AI 总说"我只能只读 / 无法写入" | `engine.system_prompt` 被覆盖成限制性文本，或 `SNACA_APPROVAL_MODE=deny` 把每次写都拒了 | 留空 `[engine].system_prompt` 用默认值；按需开 `SNACA_APPROVAL_MODE=allow` |
| skills 不生效 | frontmatter 写错 / 没等满 5 秒 cache | `tail -f` 服务日志看 `loaded skills count=N`；frontmatter `name` 为空会整文件被拒 |

---

## 12. 测试

```bash
cargo test --workspace --features snaca-server/pdf,snaca-server/docx
```

跑完应当全绿（无 warning）。手测 IM 端到端用第 5/6 节的方案。

---

## 13. 进一步阅读

- [im-plugin-protocol.md](./im-plugin-protocol.md) — IM 插件协议规范
- [../plan.md](../plan.md) — 整体设计、里程碑、关键风险
- [../crates/snaca-server/src/config.rs](../crates/snaca-server/src/config.rs) — 配置 schema 完整字段（含未在本手册展开的）
- [../crates/snaca-engine/src/engine.rs](../crates/snaca-engine/src/engine.rs) — turn loop 实现入口
