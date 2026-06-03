# SciPen Studio × SNACA Editor Protocol

| 字段 | 值 |
| :--- | :--- |
| **Version** | `1.0.0-draft` |
| **Status** | Design — 接受评审，锁版前可变 |
| **Last updated** | 2026-05-18 |
| **Owners** | SciPen Studio / SNACA Editor Mode |
| **Replaces** | 无；与 [im-plugin-protocol.md](./im-plugin-protocol.md) 并列存在，IM 形态独立保留 |

---

## 0. 摘要

`editor-protocol` 定义 **SciPen Studio**（Electron 桌面 IDE，host）与 **`snaca-editor`**（SNACA editor 形态 sidecar 子进程）之间的双向通信契约。目标是让 SNACA 内核驱动一个本地优先、Cursor 级别交互体验的 LaTeX/Typst 写作 IDE：流式聊天、行内改写、多文件 agent、上下文自动注入、编辑提议 + Diff Review、工具审批、项目级记忆隔离。

协议在 **stdio JSON-RPC 2.0** 之上，**NDJSON** 帧分隔。所有写入工具不直接落盘，而是产出 `edit.propose` 提议，由 host 决策；agent 永远不持有对用户文件的最终写权。

### 0.1 方法速查

| 方向 | 方法 | 类型 | 用途 |
| :--- | :--- | :---: | :--- |
| Host → SNACA | `init` | request | 握手 |
| Host → SNACA | `config.reload` | request | 热更新配置 |
| Host → SNACA | `health.ping` | request | 心跳 |
| Host → SNACA | `shutdown` | request | 优雅关停 |
| Host → SNACA | `session.open` / `session.close` | request | 项目级会话 |
| Host → SNACA | `session.list_threads` / `new_thread` / `switch_thread` / `delete_thread` / `rename_thread` | request | 线程管理 |
| Host → SNACA | `chat.send` | request | Ctrl+L 聊天 |
| Host → SNACA | `inline_edit.start` | request | Ctrl+K 行内改写 |
| Host → SNACA | `composer.start` | request | Ctrl+I 多文件 agent |
| Host → SNACA | `plan.confirm` | request | Composer plan-first 确认 |
| Host → SNACA | `turn.cancel` | notification | 中断 |
| Host → SNACA | `edit.confirm` | request | 编辑决策 |
| Host → SNACA | `tool.confirm` | request | 工具审批回执 |
| Host → SNACA | `context.respond` | response | 应答 `context.request` |
| SNACA → Host | `turn.delta` | notification | 流式：text / thinking / tool / done |
| SNACA → Host | `edit.propose` / `edit.propose_delta` / `edit.propose_complete` | notification | 编辑提议（含流式） |
| SNACA → Host | `plan.update` | notification | 多文件 plan 事件 |
| SNACA → Host | `context.request` | request | 反向索要上下文 |
| SNACA → Host | `tool.approval_request` | notification | 触发审批 UI |
| SNACA → Host | `usage.update` | notification | LLM 计量 |
| SNACA → Host | `memory.updated` | notification | 记忆变更广播 |
| SNACA → Host | `error` | notification | 非 turn 上下文错误 |
| SNACA → Host | `log.write` | notification | tracing 反向投递 |

---

## 1. 范围与原则

### 1.1 In scope
- Studio 与 `snaca-editor` 的进程间通信
- 项目（project）/ 会话（session）/ 线程（thread）/ 回合（turn）/ 提议（proposal）语义
- 三种 agent 调用面：`chat`、`inline_edit`、`composer`
- 编辑提议提交、流式、确认、回滚、漂移检测
- 工具调用进度、审批、上下文反向请求
- LLM 计量、错误、取消

### 1.2 Out of scope
- IM 多租户场景（见 [im-plugin-protocol.md](./im-plugin-protocol.md)）
- 远程协同（OT/CRDT）
- 用户认证 / SSO（单用户单机部署）
- 文件版本控制（交给 git）

### 1.3 设计原则
| 原则 | 表现 |
| :--- | :--- |
| **编辑器是一等公民** | 一类概念为 `selection / file / range / hunk / proposal / plan`，非 `message / chat_id` |
| **写不直接落盘** | 所有写工具产出 proposal，等待 host 决策；agent 不持最终写权 |
| **流式即视觉** | text / thinking / tool / edit 全程流式，UI 实时呈现 |
| **上下文显式注入** | host 主动提交结构化上下文，减少 LLM 反复 Read |
| **协议幂等** | 同一 `turn_id` / `proposal_id` 重复确认安全 |
| **能力协商** | 双方声明能力，按交集工作；未知字段静默忽略以利前向兼容 |
| **取消随时可发** | 任何 in-flight turn / tool 必须可被中断 |

---

## 2. 术语表

| 术语 | 定义 |
| :--- | :--- |
| **host** | Studio 主进程，是 `snaca-editor` 的唯一对端 |
| **session** | 项目级长连接，由 `session.open` 建立，绑定 `(workspace_root, metadata_root)` |
| **thread** | session 内的对话线程；多 thread 共享 workspace 与 memory，消息历史隔离 |
| **active thread** | 当前 UI 显示并接受输入的 thread；每 session **同时只有一个** |
| **turn** | 一次完整 agent 调用周期，由 `chat.send` / `inline_edit.start` / `composer.start` 启动，以 `turn.delta { kind: "done" }` 或 `kind: "error" }` 结束 |
| **proposal** | 编辑提议，由 Write/Edit/MultiEdit/InlineEdit 工具产出，等待 host 决策 |
| **hunk** | proposal 内最小可独立接受/拒绝单元，包含一个 `Range` 与 `old_text / new_text` 对 |
| **base_hash** | proposal 计算时 SNACA 看到的文件内容的 SHA-256，用于漂移检测 |
| **workspace_root** | SNACA 工具操作的根目录，等于用户项目根的绝对路径 |
| **metadata_root** | SNACA 私有目录，memory / skills / settings 落于此，必须在 `workspace_root` 之外 |

---

## 3. 传输与帧

### 3.1 传输
- **默认 / 必须**：stdio。host spawn `snaca-editor` 子进程；stdin 写请求，stdout 读响应与通知，stderr 视为日志（host 转发至自身 tracing）。
- **可选 / M2**：WebSocket（远端 sidecar）。同 JSON 负载，token 通过 `Authorization` 头传入。

### 3.2 帧
- 默认 **newline-delimited JSON**（NDJSON）：每条消息一行 UTF-8 JSON，以 `\n` 收尾。
- 单条负载超过 1 MiB 时双方可协商升级为 `Content-Length` 头帧（LSP 风格）。能力位 `framing.content_length`。

### 3.3 编码与路径
- 所有字符串 UTF-8，**无 BOM**。
- 路径**绝对**且**正斜杠**。Windows 路径在协议边界规范化（`C:\foo\bar` → `C:/foo/bar`）。

---

## 4. 消息格式

[JSON-RPC 2.0](https://www.jsonrpc.org/specification) 全量遵循。三种类型：

```jsonc
// request（含 id，期待响应）
{ "jsonrpc": "2.0", "id": 17, "method": "chat.send", "params": { ... } }
// response（匹配请求 id，含 result 或 error）
{ "jsonrpc": "2.0", "id": 17, "result": { "turn_id": "..." } }
// notification（无 id，fire-and-forget）
{ "jsonrpc": "2.0", "method": "turn.delta",
  "params": { "turn_id": "...", "seq": 3, "kind": "text", "text": "..." } }
```

所有流式事件使用 notification。`context.request`（SNACA → host）是 SNACA 端唯一发出的 request 类型。

---

## 5. 生命周期

```
host                                   snaca-editor
 │ spawn (env: SNACA_API_KEY etc.)         │
 │ ───────────────────────────────────────►│
 │                                         │ 启动；加载 config；初始化 LLM
 │ init { snaca_config, host_caps }        │
 │ ───────────────────────────────────────►│
 │ ◄────── manifest { caps, version } ────│
 │                                         │
 │ session.open { project_id, ... }        │
 │ ───────────────────────────────────────►│
 │ ◄────── { session_id, threads }        │
 │                                         │
 │ chat.send / inline_edit.start / ...     │
 │ ◄═════ streaming deltas ═══════════════►│
 │                                         │
 │ session.close                           │
 │ ───────────────────────────────────────►│
 │                                         │
 │ shutdown                                │
 │ ───────────────────────────────────────►│
 │ ◄────── ack ──────────────────────────  │
 │                                         │ 退出
```

### 5.1 启动顺序
1. host spawn 子进程，注入 `SNACA_API_KEY` 等敏感 env 变量
2. host 立刻发 `init`；未 `init` 时任何其他方法返回 `-32000 not_initialized`
3. snaca-editor 返回 manifest 后，host 可开 session

### 5.2 崩溃恢复
host 监视子进程退出 → 指数退避重启（base 500 ms，上限 60 s，最多 10 次）→ 重新 `init` + 自动 `session.open` 恢复上次活动项目。**in-flight turn 不保证恢复**，host 应通知用户并允许重发。

---

## 6. 身份与路径

### 6.1 项目身份
| 字段 | 来源 | 形式 |
| :--- | :--- | :--- |
| `project_id` | host 主导 | UUIDv4，永久不变 |
| `workspace_root` | host 提供 | 用户项目根绝对路径（正斜杠） |
| `metadata_root` | host 提供 | SNACA 私有目录绝对路径 |
| `shared_metadata_root` | host 提供，可选 | 跨项目共享目录（user 级 memory / 全局 skills） |

**约束**：`metadata_root` 与 `shared_metadata_root` 都**不得**位于 `workspace_root` 内部，否则 snaca-editor 必须返回 `-32008 workspace_invalid`。

### 6.2 路径规范
- 协议字段中 `file` / `path` 始终为绝对、正斜杠
- 工具内部相对路径（如 LLM 调用 `Read("abstract.tex")`）由 SNACA 解析为 `workspace_root + relative`，必须落在 `workspace_root` 子树内（path security 强制）

### 6.3 ID 规范
- `session_id` / `thread_id` / `turn_id` / `proposal_id` / `tool_call_id` / `request_id`：UUIDv4
- `hunk_id`：proposal 内唯一即可，建议 `h0`、`h1`、…

### 6.4 时间戳
所有时间戳 **ISO 8601 with timezone**，如 `2026-05-18T08:15:30+08:00`。

---

## 7. 会话与线程模型

### 7.1 单 active 约束
- 一个 host 同时只能维持一个 **active session**（= 当前打开的项目）
- 一个 session 同时只能有一个 **active thread**
- snaca-editor 进程**可以**持有多个 session（host 短时间多次 `session.open` 不报错），但 host **不应**并发跑 turn——非 active thread 收到的 `chat.send` 等返回 `-32005 inflight_turn_busy`

### 7.2 Thread 隔离
- 同 session 内多 thread 共享 `workspace_root` 与 `metadata_root`
- 消息历史按 `thread_id` 隔离（SQLite `threads` 表 + `messages` 表外键）
- Memory 共享（`metadata_root/memory/`）；project-level skill 共享
- 切换 thread 前必须保证当前 thread 无 in-flight turn

### 7.3 跨 session
- 当前 SNACA 进程内禁止并发 session 跑 turn
- host 切 session 前必须 `session.close`
- 多个 Studio 窗口同开一个 `project_id` 由 host 自治禁止（不在协议范围）

---

## 8. 能力协商

`init` 双方各自声明能力。host 仅使用双方都声明的能力。

### 8.1 SNACA capabilities

```typescript
interface SnacaCapabilities {
  protocol_version: "1.0"
  engine_version: string                              // 例: "0.2.0"
  streaming_text: boolean
  streaming_thinking: boolean
  streaming_edit: boolean                             // 支持 edit.propose_delta
  inline_edit: boolean
  composer: boolean
  context_request: Array<                             // 支持的 context.request kind
    "flush_unsaved" | "file_content" | "codebase_search" | "symbol_def" | "diagnostics"
  >
  tools_builtin: string[]                             // ["Read","Grep","Glob",...]
  approval_modes: Array<"interactive" | "auto_allow" | "auto_deny">
  memory_embedders: Array<"none" | "hash" | "fastembed">
  framing: Array<"ndjson" | "content_length">
}
```

### 8.2 Host capabilities

```typescript
interface HostCapabilities {
  ui_surfaces: Array<"chat" | "inline_edit" | "composer">
  context_kinds: Array<                               // host 能提供的上下文
    "active_file" | "selection" | "cursor" | "visible_range" |
    "open_tabs" | "recent_edits" | "diagnostics" | "project_meta"
  >
  edit_apply_strategy: "host_applies" | "snaca_applies"   // §12.5
  approval_ui: "local_card" | "passthrough"
  framing: Array<"ndjson" | "content_length">
}
```

### 8.3 协商规则
- **主版本号不同**：snaca-editor 启动失败，host 收到 `init` 错误
- **次版本号差异**：双方按 capabilities 求交集，缺位降级
- **未知字段静默忽略**（前向兼容）

---

## 9. 上下文注入

### 9.1 `ChatContext` schema

```typescript
interface ChatContext {
  active_file?: {
    path: string                                      // 绝对
    language: "latex" | "typst" | "markdown" | "bibtex" | string
    cursor?: { line: number; column: number }        // 0-based
    visible_range?: { start_line: number; end_line: number }
    selection?: { range: Range; text: string }
    dirty?: boolean
  }
  open_tabs?: Array<{ path: string; dirty: boolean }>
  recent_edits?: Array<{ path: string; ts: string; summary: string }>   // 本 session 内
  mentions?: Mention[]
  diagnostics?: Array<{
    path: string
    severity: "error" | "warning" | "info"
    message: string
    range?: Range
  }>
  project?: {
    type: "latex" | "typst" | "mixed"
    main_file?: string
    engine?: string                                   // "xelatex" | "lualatex" | ...
  }
}

interface Range {
  start: { line: number; column: number }             // 0-based
  end:   { line: number; column: number }
}

type Mention =
  | { kind: "file";      path: string; inline_content?: string }
  | { kind: "folder";    path: string }
  | { kind: "symbol";    path: string; name: string; range: Range }
  | { kind: "selection"; path: string; range: Range; text: string }
  | { kind: "url";       url: string; content?: string }
```

### 9.2 `InlineEditContext` schema

```typescript
interface InlineEditContext {
  surrounding_before: string                          // 选区前若干行（建议 ±30 行）
  surrounding_after:  string
  language: string
  project_type?: "latex" | "typst" | "mixed"
}
```

### 9.3 System prompt 拼接顺序

snaca-editor 每次 LLM 调用按下列顺序拼装 system prompt：

```
1. SNACA 基础 system prompt
2. shared/MEMORY.md 内容（若存在）
3. metadata_root/memory/MEMORY.md 内容
4. (memory_embedder != none) 当前用户消息的 recall top-K
5. 项目级 skill 描述清单（仅 frontmatter，不含 body）
6. 结构化 context（XML 化）:
     <context>
       <project type="latex" main="main.tex" engine="xelatex"/>
       <active_file path="..." cursor="42:13">
         <visible>...</visible>
         <selection range="42:5-42:30">...</selection>
       </active_file>
       <open_tabs>...</open_tabs>
       <recent_edits>...</recent_edits>
       <mentions>...</mentions>
       <diagnostics>...</diagnostics>
     </context>
7. 用户消息正文
```

---

## 10. Host → SNACA 方法详述

### 10.1 `init`

握手；必须首条。

**params**
```typescript
interface InitParams {
  protocol_version: "1.0"
  host: { name: string; version: string }             // 例: "scipen-studio", "0.3.0"
  snaca_config: SnacaConfig                           // 见附录 A
  host_caps: HostCapabilities                         // §8.2
}
```

**result**
```typescript
interface InitResult {
  protocol_version: "1.0"
  engine_version: string
  capabilities: SnacaCapabilities                     // §8.1
}
```

**errors**: `-32007 config_invalid`, `-32009 llm_auth_failed`

### 10.2 `config.reload`

热更新配置。已运行的 turn 不受影响，新 turn 起按新配置。

**params**: `{ snaca_config: SnacaConfig }`
**result**: `{ applied: true; restart_required: boolean }`
**errors**: `-32007 config_invalid`

`restart_required = true` 时表示有字段（如 `memory_embedder`）无法热加载，host 应提示用户。

### 10.3 `session.open`

```typescript
interface SessionOpenParams {
  project_id: string                                  // UUIDv4
  workspace_root: string
  metadata_root: string
  shared_metadata_root?: string
  display_name: string
  project_type: "latex" | "typst" | "mixed"
}

interface SessionOpenResult {
  session_id: string
  threads: ThreadSummary[]
}

interface ThreadSummary {
  thread_id: string
  title: string
  created_at: string                                  // ISO 8601
  last_active_at: string
  turn_count: number
}
```

**errors**: `-32008 workspace_invalid`

### 10.4 `session.close`

**params**: `{ session_id: string }`
**result**: `{ closed: true }`

收到该方法后 snaca-editor 必须：① 取消该 session 所有 inflight turn；② 刷盘 memory / SQLite；③ 释放该 session 内存。**不删除** SQLite 中的 thread 记录。

### 10.5 `session.list_threads`

**params**: `{ session_id: string; limit?: number; offset?: number }`
**result**: `{ threads: ThreadSummary[]; total: number }`

默认按 `last_active_at` 降序。

### 10.6 `session.new_thread`

**params**: `{ session_id: string; title?: string }`
**result**: `{ thread_id: string; title: string }`

未提供 `title` 时使用默认（如 "New conversation"），首次有用户输入后由引擎自动生成。

### 10.7 `session.switch_thread`

**params**: `{ session_id: string; thread_id: string }`
**result**: `{ switched: true; thread: ThreadSummary }`

切换前 host 必须保证无 in-flight turn；否则 snaca-editor 返回 `-32005 inflight_turn_busy`。

### 10.8 `session.delete_thread`

**params**: `{ session_id: string; thread_id: string }`
**result**: `{ deleted: true }`

物理删除该 thread 的所有 messages / proposals 记录，不可恢复。

### 10.9 `session.rename_thread`

**params**: `{ session_id: string; thread_id: string; title: string }`
**result**: `{ renamed: true }`

### 10.10 `chat.send`

**params**
```typescript
interface ChatSendParams {
  session_id: string
  thread_id: string
  content: string                                     // 用户原始输入
  context: ChatContext                                // §9.1
  attachments?: Attachment[]
}

interface Attachment {
  kind: "file" | "image"
  path?: string
  base64?: string
  mime_type?: string
}
```

**result**: `{ turn_id: string }`
**errors**: `-32002 thread_not_found`, `-32005 inflight_turn_busy`

返回 `turn_id` 后 snaca-editor 立即开始 emit `turn.delta`。

### 10.11 `inline_edit.start`

不进 turn loop，单次 LLM 调用 + 流式响应。

**params**
```typescript
interface InlineEditStartParams {
  session_id: string
  thread_id?: string                                  // 提供则记入 thread；否则瞬态
  file: string                                        // 绝对路径
  range: Range                                        // 待替换区
  instruction: string
  context: InlineEditContext                          // §9.2
}
```

**result**: `{ turn_id: string; proposal_id: string }`

`proposal_id` 立即返回，host 可立刻准备 ghost text 占位；随后 `edit.propose` (streaming=true) + `edit.propose_delta` 流式追加 newText。

### 10.12 `composer.start`

多文件 agent。

**params**
```typescript
interface ComposerStartParams {
  session_id: string
  thread_id: string
  instruction: string
  mentions: Mention[]
  context: ChatContext
  mode: "plan_first" | "immediate"
  scope?: { paths: string[] }                         // 限定影响范围
}
```

**result**: `{ turn_id: string }`

`mode = "plan_first"` 时 snaca-editor 第一次 LLM 调用后 emit `plan.update { awaiting: true }`，等待 `plan.confirm`。

### 10.13 `plan.confirm`

**params**
```typescript
interface PlanConfirmParams {
  turn_id: string
  decision: "accept" | "reject" | "modify"
  modifications?: {
    add_files?: string[]
    remove_files?: string[]
    note?: string                                     // 自然语言补充
  }
}
```

**result**: `{ ok: true }`

`modify` 携带 `note` 时 snaca-editor 重新规划；`reject` 直接结束 turn。

### 10.14 `turn.cancel`

**通知性**（无 id）；snaca-editor 必须 best-effort 中断：
1. 取消 LLM 流（HTTP abort）
2. 中断正执行的工具（向 Bash 子进程发 SIGTERM 等）
3. 未确认的 proposal 自动 reject
4. 落 SQLite，emit `turn.delta { kind: "done", cancelled: true }`

**params**: `{ turn_id: string; reason?: string }`

### 10.15 `edit.confirm`

**params**
```typescript
interface EditConfirmParams {
  proposal_id: string
  decision: "accept" | "reject" | "accept_partial"
  per_hunk?: Array<{ hunk_id: string; decision: "accept" | "reject" }>     // 仅 accept_partial
  modified_text?: Array<{ hunk_id: string; new_text: string }>             // 用户手编后接受
}
```

**result**
```typescript
interface EditConfirmResult {
  applied: boolean
  applied_hash?: string                               // host 实际写入后 SHA-256
  errors?: Array<{ hunk_id: string; message: string }>
}
```

**errors**: `-32004 proposal_not_found`, `-32012 base_hash_mismatch`

`applied_hash` 仅在 `edit_apply_strategy = "host_applies"` 且至少一个 hunk 实际写入时返回。

### 10.16 `tool.confirm`

**params**
```typescript
interface ToolConfirmParams {
  tool_call_id: string
  decision: "allow" | "deny" | "allow_always" | "deny_always"
}
```

**result**: `{ ok: true }`

`allow_always` / `deny_always` 持久化到 `metadata_root/settings.json`，键为 `(tool_name, args_hash)`。

### 10.17 `context.respond`

应答 SNACA 发起的 `context.request`。

**params**
```typescript
interface ContextRespondParams {
  request_id: string
  ok: boolean
  payload?: ContextPayload
  error?: string
}

type ContextPayload =
  | { kind: "flush_unsaved"; flushed_files: string[] }
  | { kind: "file_content"; path: string; content: string; sha256: string }
  | { kind: "codebase_search"; results: Array<{
        path: string; range: Range; snippet: string; score: number
      }> }
  | { kind: "symbol_def"; matches: Array<{ path: string; range: Range }> }
  | { kind: "diagnostics"; items: Array<{
        path: string; severity: string; message: string; range?: Range
      }> }
```

### 10.18 `health.ping`

**params**: `{}`
**result**: `{ pong: true; engine_uptime_secs: number }`

host 推荐每 30 s ping 一次；连续 3 次失败视为不可用 → 重启子进程。

### 10.19 `shutdown`

**params**: `{}`
**result**: `{ ok: true }`

snaca-editor 接收后 graceful drain：① 取消所有 inflight turn；② 刷盘 SQLite + memory；③ 返回 result 后 100 ms 内自行 exit。

---

## 11. SNACA → Host 方法详述

除 `context.request` 是 request（有 id），其余全部 notification。

### 11.1 `turn.delta`

```typescript
interface TurnDeltaParams {
  turn_id: string
  seq: number                                         // 单调递增；host 必须按 seq 排序
  kind: TurnDeltaKind
}

type TurnDeltaKind =
  | { kind: "text";          text: string }                                  // 追加文本
  | { kind: "thinking";      text: string }                                  // reasoning 流
  | { kind: "tool_use";      tool_call_id: string; tool: string; args: object }
  | { kind: "tool_progress"; tool_call_id: string; message: string }
  | { kind: "tool_result";   tool_call_id: string; ok: boolean;
                             content: string; truncated?: boolean }
  | { kind: "done";          reason: "completed" | "cancelled" | "error";
                             cancelled?: boolean }
  | { kind: "error";         code: number; message: string; recoverable: boolean }
```

`seq` 全 turn 内单调递增；host 按 seq 排序处理（保证 thinking / text 交替时不乱）。

### 11.2 `edit.propose`

```typescript
interface EditProposalParams {
  proposal_id: string
  turn_id: string
  tool_call_id?: string                               // 若由工具触发
  file: string                                        // 绝对
  base_hash: string                                   // SHA-256 hex
  hunks: LineHunk[]                                   // streaming=true 时可初始为空 / 部分
  streaming: boolean
  summary?: string                                    // LLM 给的自然语言描述
  expected_post_hash?: string                         // 可选，accept 后预期 hash
}

interface LineHunk {
  hunk_id: string                                     // proposal 内唯一
  range: Range                                        // 基于 base_hash 时刻
  old_text: string                                    // = file.slice(range)
  new_text: string                                    // 替换后内容
}
```

### 11.3 `edit.propose_delta`

```typescript
interface EditProposalDeltaParams {
  proposal_id: string
  hunk_id: string
  append_text: string                                 // 追加到 new_text 末尾
  done?: boolean                                      // 该 hunk 收尾
}
```

### 11.4 `edit.propose_complete`

```typescript
interface EditProposalCompleteParams {
  proposal_id: string
  final_hunks: LineHunk[]                             // 权威版本
}
```

host 收到 `edit.propose_complete` 后才允许用户点 ✓（流式期间按钮可见但 disabled）。

### 11.5 `plan.update`

```typescript
interface PlanUpdateParams {
  turn_id: string
  awaiting: boolean                                   // true 时 host 必须等待 plan.confirm
  files: Array<{
    path: string
    action: "create" | "modify" | "delete" | "rename"
    rename_to?: string
    summary: string
    status: "pending" | "in_progress" | "done" | "rejected" | "failed"
  }>
  rationale: string                                   // 整体说明
}
```

### 11.6 `context.request`

**唯一例外**：SNACA → host 的 **request**（有 id）。

```typescript
interface ContextRequestParams {
  request_id: string
  turn_id: string
  kind: "flush_unsaved" | "file_content" | "codebase_search" | "symbol_def" | "diagnostics"
  params: object                                      // kind 决定 shape
}
```

各 kind 的 `params`：
- `flush_unsaved`: `{ paths?: string[] }`（省略则刷所有 dirty）
- `file_content`: `{ path: string }`
- `codebase_search`: `{ query: string; top_k?: number; scope?: "current_file" | "project" }`
- `symbol_def`: `{ name: string; type_hint?: string }`
- `diagnostics`: `{ path?: string }`（省略则全项目）

host 必须 5 s 内 `context.respond`，超时 snaca-editor 视为失败但 turn 继续。

### 11.7 `tool.approval_request`

```typescript
interface ToolApprovalRequestParams {
  tool_call_id: string
  turn_id: string
  tool: string                                        // "Bash" / "mcp__filesystem__delete" / ...
  args: object
  summary: string                                     // 人类可读
  risk: "low" | "medium" | "high"
  default_decision?: "allow" | "deny"                 // 超时回退
  timeout_secs?: number                               // 默认 300
}
```

host 渲染本地 UI，最终通过 `tool.confirm` 回应。超时按 `default_decision` 自决（建议 `deny`）。

### 11.8 `usage.update`

```typescript
interface UsageUpdateParams {
  turn_id: string
  cumulative: {
    input_tokens: number
    output_tokens: number
    cached_input_tokens: number
    thinking_tokens?: number
    cost_usd?: number                                 // 按 model 价格表估算
  }
}
```

每轮 LLM 调用结束后 emit 一次（含工具间隔）。

### 11.9 `memory.updated`

```typescript
interface MemoryUpdatedParams {
  session_id: string
  scope: "user" | "feedback" | "project" | "reference"
  name: string                                        // memory 文件 slug
  action: "created" | "updated" | "deleted"
}
```

host 用以触发 MemoryViewer 刷新。

### 11.10 `error`

```typescript
interface ErrorNotificationParams {
  turn_id?: string                                    // 若是 turn 上下文
  session_id?: string
  code: number
  message: string
  data?: object
  recoverable: boolean
}
```

非 turn 上下文错误（如 LLM 鉴权失败、SQLite 连接断开）通过此通道广播。

### 11.11 `log.write`

```typescript
interface LogWriteParams {
  level: "trace" | "debug" | "info" | "warn" | "error"
  target: string                                      // tracing target
  message: string
  ts: string                                          // ISO 8601
  fields?: Record<string, unknown>
}
```

---

## 12. 编辑语义（重点章节）

### 12.1 Proposal 生命周期

```
SNACA 工具产出编辑意图
   ↓
emit edit.propose（streaming 标记）
   ↓
[streaming=true] emit edit.propose_delta × N
   ↓
emit edit.propose_complete
   ↓
host 渲染 Diff Review
   ↓
用户决策
   ↓
host send edit.confirm
   ↓
SNACA:
  - accept         → 工具返回 success → engine 继续 turn
  - reject         → 工具返回 tool_error("rejected by user")
  - accept_partial → 工具返回 success + note "partial accept"
```

### 12.2 Hunk 语义

- `range` 为字符级 `Range`（行 + 列，0-based）
- `old_text` 必须等于 `file.slice(range)`（基于 `base_hash` 的快照）
- `new_text` 为替换后内容
- **多 hunk 不重叠**；snaca-editor 必须保证 hunks 按 `range.start` 升序
- host 应用时建议从末尾 hunk 开始（避免索引漂移）

### 12.3 流式 newText

`streaming = true` 时：
1. 首次 `edit.propose` 的 hunks[i].new_text 可为空或 prefix
2. `edit.propose_delta` 按 hunk_id 追加 append_text
3. 同一 hunk 的 delta 按 NDJSON 顺序到达，host 按到达顺序拼接
4. `edit.propose_complete` 标志结束，final_hunks 是权威版本

**host UI 建议**：流式期间显示 ghost text 但 ✓ 按钮 disabled；complete 后启用。

### 12.4 多文件 Proposal

Composer 场景：
- 每个文件**独立** emit `edit.propose`（一个 proposal 仅对应一个 file）
- 同一 turn 可并行有多个 in-flight proposal
- host 在 ComposerPanel 聚合呈现
- `edit.confirm` 按 proposal 独立确认

### 12.5 Apply Atomicity

`host_caps.edit_apply_strategy` 决定谁负责写盘：

| 策略 | 谁写盘 | 适用 |
| :--- | :--- | :--- |
| `host_applies`（推荐） | host accept 后写盘 + 同步 Monaco model | Studio：保持 model 同步、单点写入 |
| `snaca_applies` | SNACA accept 后写盘，host 只负责 Diff Review UI | 简单 host |

`host_applies` 时：
- host 应用 hunks 到文件 + Monaco model
- host 在 `edit.confirm.result` 返回 `applied_hash`
- 后续 SNACA 工具（如 Read）读到新内容

### 12.6 Base Hash 漂移检测

工具调用前 SNACA 必须 Read 文件得到 `base_hash`。host 收到 `edit.propose` 后必须校验：

```
local_hash = SHA-256(current_file_bytes)
if local_hash != proposal.base_hash:
    通知用户检测到漂移，允许：
      - rebase（让 SNACA 用最新内容重做）
      - force apply（按提议照常应用，可能错位）
      - reject
```

host 选择 reject 时 `edit.confirm { decision: "reject" }`，snaca-editor 视为工具失败，engine 进入下一轮（可重新 Read + Edit）。

---

## 13. 取消语义

### 13.1 `turn.cancel`
- best-effort 中断 LLM 流（HTTP abort）
- 向正在执行的 Bash 子进程发 SIGTERM（5 s 后 SIGKILL）
- 未确认的 proposal 自动 reject（无需 host 主动 `edit.confirm`）
- emit `turn.delta { kind: "done", cancelled: true }` ≤ 2 s
- 已写入 thread 的部分消息保留（用户视角"被打断的对话"）

### 13.2 工具调用中取消
工具必须接受 `CancellationToken`：
- Read / Grep / Glob：瞬时操作，几乎不可被打断
- Bash：发 SIGTERM；5 s 后强 kill
- Write/Edit/MultiEdit：proposal 自动 reject

### 13.3 LLM 流中取消
利用底层 HTTP client 的 abort signal；snaca-editor LLM client 必须支持。

---

## 14. 错误码

| Code | Symbol | 来源 | 含义 |
| :---: | :--- | :--- | :--- |
| -32700 | parse_error | 任 | 非法 JSON |
| -32600 | invalid_request | 任 | 非 JSON-RPC 2.0 |
| -32601 | method_not_found | 任 | 未实现方法 |
| -32602 | invalid_params | 任 | 字段缺失 / 类型错 |
| -32603 | internal_error | 任 | 未预期异常 |
| -32000 | not_initialized | 任 | `init` 未完成 |
| -32001 | session_not_found | 多 | `session_id` 无效 |
| -32002 | thread_not_found | 多 | `thread_id` 无效 |
| -32003 | turn_not_found | turn.cancel 等 | `turn_id` 无效 / 已结束 |
| -32004 | proposal_not_found | edit.confirm | `proposal_id` 无效 |
| -32005 | inflight_turn_busy | chat.send 等 | 当前 thread 有未完成 turn |
| -32006 | capability_not_supported | 多 | 协商未启用 |
| -32007 | config_invalid | init / config.reload | 配置错误 |
| -32008 | workspace_invalid | session.open | workspace_root 不存在 / metadata 嵌套 |
| -32009 | llm_auth_failed | turn 中 | API key 拒绝 |
| -32010 | llm_context_overflow | turn 中 | 上下文超长（compact 后仍失败） |
| -32011 | llm_rate_limited | turn 中 | 上游限流 |
| -32012 | base_hash_mismatch | edit.confirm | 文件已被改动 |
| -32013 | cancelled | turn 中 | 已取消 |
| -32014 | timeout | 多 | context.respond / 工具等超时 |

`error.data` 可含结构化辅助信息（如 `{ retry_after_secs: 30 }` 对应 -32011）。

---

## 15. 一致性测试

`snaca-editor` 必须通过下列测试方可宣称 v1 兼容。参考实现：`snaca-cli editor-conformance --binary <path>`（M2 提供）。

1. **handshake**：`init` → manifest 含 `protocol_version: "1.0"`
2. **lifecycle**：`session.open` → `session.close` → 重复 100 次稳定，无内存泄漏
3. **chat turn**：`chat.send` 返回 `turn_id`，后续收到至少一个 text delta + done
4. **流式 inline edit**：`inline_edit.start` → 收到 `edit.propose (streaming=true)` + ≥1 个 delta + complete
5. **edit accept**：`edit.confirm(accept)` → 工具结果 ok；下一次 Read 看到新内容（host_applies 策略下）
6. **edit reject**：`edit.confirm(reject)` → 工具结果含 "rejected by user"
7. **base_hash drift**：host reject 时声明 `base_hash_mismatch` → engine 重新 Read + 重出 proposal
8. **plan_first**：`composer.start(plan_first)` → 收到 `plan.update(awaiting=true)` → `plan.confirm` → 后续 emit edit.propose
9. **plan reject**：`plan.confirm(reject)` → turn 立即 `done`，不出 edit
10. **多 session 拒绝并发**：在前一 turn 未结束时 `chat.send` 到 active thread → 返回 `-32005`
11. **context.request 超时**：host 不响应 → snaca-editor 5 s 后视为失败但 turn 继续
12. **取消**：`turn.cancel` → `done(cancelled=true)` ≤ 2 s
13. **shutdown**：`shutdown` → 100 ms 内 ack → 进程退出
14. **错误恢复**：杀掉 snaca-editor → host 检测到 → 重启 → `init` 成功 → 历史 thread 可重开

---

## 16. 完整示例

### 16.1 Chat 单文件编辑

```jsonc
// 1. Host → SNACA
{"jsonrpc":"2.0","id":1,"method":"chat.send","params":{
  "session_id":"s-1","thread_id":"t-1",
  "content":"把 abstract 改简洁",
  "context":{
    "active_file":{"path":"/proj/sections/abstract.tex","language":"latex",
                   "cursor":{"line":12,"column":0}},
    "open_tabs":[{"path":"/proj/main.tex","dirty":false}],
    "project":{"type":"latex","main_file":"main.tex","engine":"xelatex"}
  }
}}

// 2. SNACA → Host (response)
{"jsonrpc":"2.0","id":1,"result":{"turn_id":"tu-1"}}

// 3. SNACA → Host (流式 deltas)
{"jsonrpc":"2.0","method":"turn.delta","params":{
  "turn_id":"tu-1","seq":0,"kind":"text","text":"我先看看当前 abstract。"}}
{"jsonrpc":"2.0","method":"turn.delta","params":{
  "turn_id":"tu-1","seq":1,"kind":"tool_use",
  "tool_call_id":"tc-1","tool":"Read","args":{"path":"sections/abstract.tex"}}}

// 4. SNACA → Host (request: flush_unsaved)
{"jsonrpc":"2.0","id":"ctx-1","method":"context.request","params":{
  "request_id":"ctx-1","turn_id":"tu-1","kind":"flush_unsaved",
  "params":{"paths":["/proj/sections/abstract.tex"]}}}

// 5. Host → SNACA (response)
{"jsonrpc":"2.0","id":"ctx-1","result":{
  "request_id":"ctx-1","ok":true,
  "payload":{"kind":"flush_unsaved","flushed_files":[]}}}

// 6. SNACA → Host
{"jsonrpc":"2.0","method":"turn.delta","params":{
  "turn_id":"tu-1","seq":2,"kind":"tool_result",
  "tool_call_id":"tc-1","ok":true,"content":"<abstract content>"}}
{"jsonrpc":"2.0","method":"turn.delta","params":{
  "turn_id":"tu-1","seq":3,"kind":"text","text":"我建议改成："}}

// 7. SNACA → Host (edit proposal)
{"jsonrpc":"2.0","method":"edit.propose","params":{
  "proposal_id":"p-1","turn_id":"tu-1","tool_call_id":"tc-2",
  "file":"/proj/sections/abstract.tex","base_hash":"a1b2c3...",
  "streaming":false,"summary":"简化 abstract 第二段",
  "hunks":[{
    "hunk_id":"h0",
    "range":{"start":{"line":3,"column":0},"end":{"line":7,"column":0}},
    "old_text":"原文...","new_text":"简化后..."
  }]
}}
{"jsonrpc":"2.0","method":"edit.propose_complete","params":{
  "proposal_id":"p-1","final_hunks":[/* ... */]}}

// 8. User → Host: 点 ✓
// Host → SNACA
{"jsonrpc":"2.0","id":2,"method":"edit.confirm","params":{
  "proposal_id":"p-1","decision":"accept"}}

// 9. SNACA → Host (response)
{"jsonrpc":"2.0","id":2,"result":{"applied":true,"applied_hash":"c3d4e5..."}}

// 10. SNACA → Host
{"jsonrpc":"2.0","method":"turn.delta","params":{
  "turn_id":"tu-1","seq":4,"kind":"tool_result",
  "tool_call_id":"tc-2","ok":true,"content":"applied"}}
{"jsonrpc":"2.0","method":"usage.update","params":{
  "turn_id":"tu-1","cumulative":{
    "input_tokens":1234,"output_tokens":456,
    "cached_input_tokens":1000,"cost_usd":0.0042}}}
{"jsonrpc":"2.0","method":"turn.delta","params":{
  "turn_id":"tu-1","seq":5,"kind":"done","reason":"completed"}}
```

### 16.2 Inline Edit（Ctrl+K）

```jsonc
// Host → SNACA
{"jsonrpc":"2.0","id":1,"method":"inline_edit.start","params":{
  "session_id":"s-1","file":"/proj/sections/method.tex",
  "range":{"start":{"line":42,"column":2},"end":{"line":45,"column":40}},
  "instruction":"换成被动语态",
  "context":{
    "surrounding_before":"...前 30 行...",
    "surrounding_after":"...后 30 行...",
    "language":"latex","project_type":"latex"
  }
}}

// SNACA → Host
{"jsonrpc":"2.0","id":1,"result":{"turn_id":"tu-2","proposal_id":"p-2"}}

// SNACA → Host (流式)
{"jsonrpc":"2.0","method":"edit.propose","params":{
  "proposal_id":"p-2","turn_id":"tu-2",
  "file":"/proj/sections/method.tex","base_hash":"...",
  "streaming":true,
  "hunks":[{
    "hunk_id":"h0",
    "range":{"start":{"line":42,"column":2},"end":{"line":45,"column":40}},
    "old_text":"...","new_text":""
  }]
}}
{"jsonrpc":"2.0","method":"edit.propose_delta","params":{
  "proposal_id":"p-2","hunk_id":"h0","append_text":"The system "}}
{"jsonrpc":"2.0","method":"edit.propose_delta","params":{
  "proposal_id":"p-2","hunk_id":"h0","append_text":"is initialized..."}}
{"jsonrpc":"2.0","method":"edit.propose_complete","params":{
  "proposal_id":"p-2","final_hunks":[/* ... */]}}

// User Tab → accept
{"jsonrpc":"2.0","id":2,"method":"edit.confirm","params":{
  "proposal_id":"p-2","decision":"accept"}}
{"jsonrpc":"2.0","id":2,"result":{"applied":true,"applied_hash":"..."}}

// SNACA → Host
{"jsonrpc":"2.0","method":"turn.delta","params":{
  "turn_id":"tu-2","seq":0,"kind":"done","reason":"completed"}}
```

### 16.3 Composer Plan-First

```jsonc
// Host → SNACA
{"jsonrpc":"2.0","id":1,"method":"composer.start","params":{
  "session_id":"s-1","thread_id":"t-1",
  "instruction":"给所有章节加 \\label{sec:slug} 风格",
  "mentions":[{"kind":"folder","path":"/proj/sections"}],
  "context":{/* ... */},
  "mode":"plan_first"
}}
{"jsonrpc":"2.0","id":1,"result":{"turn_id":"tu-3"}}

// SNACA → Host (plan)
{"jsonrpc":"2.0","method":"plan.update","params":{
  "turn_id":"tu-3","awaiting":true,
  "files":[
    {"path":"/proj/sections/intro.tex","action":"modify",
     "summary":"加 \\label{sec:intro}","status":"pending"},
    {"path":"/proj/sections/method.tex","action":"modify",
     "summary":"加 \\label{sec:method}","status":"pending"}
  ],
  "rationale":"统一节标签风格 sec:<slug>"
}}

// User accepts plan
{"jsonrpc":"2.0","id":2,"method":"plan.confirm","params":{
  "turn_id":"tu-3","decision":"accept"}}
{"jsonrpc":"2.0","id":2,"result":{"ok":true}}

// SNACA proceeds; emits per-file edit.propose, plan.update(status=in_progress→done),
// each file independently confirmed via edit.confirm.
// Finally:
{"jsonrpc":"2.0","method":"turn.delta","params":{
  "turn_id":"tu-3","seq":N,"kind":"done","reason":"completed"}}
```

### 16.4 工具审批（Bash）

```jsonc
// 工具被调用时，SNACA → Host
{"jsonrpc":"2.0","method":"tool.approval_request","params":{
  "tool_call_id":"tc-bash-1","turn_id":"tu-1",
  "tool":"Bash","args":{"command":"latexmk -xelatex main.tex"},
  "summary":"运行 latexmk 编译","risk":"medium",
  "default_decision":"deny","timeout_secs":120
}}

// Host 渲染 UI；用户点 Allow Always
{"jsonrpc":"2.0","id":3,"method":"tool.confirm","params":{
  "tool_call_id":"tc-bash-1","decision":"allow_always"}}
{"jsonrpc":"2.0","id":3,"result":{"ok":true}}

// SNACA 执行 Bash，emit tool_progress + tool_result via turn.delta
```

### 16.5 取消

```jsonc
// 用户点 Stop
// Host → SNACA (notification)
{"jsonrpc":"2.0","method":"turn.cancel","params":{
  "turn_id":"tu-1","reason":"user_clicked_stop"}}

// SNACA 中断 LLM 流 + Bash 子进程
// SNACA → Host
{"jsonrpc":"2.0","method":"turn.delta","params":{
  "turn_id":"tu-1","seq":N,"kind":"done",
  "reason":"cancelled","cancelled":true}}
```

---

## 17. 未决议题 / 未来扩展

| ID | 议题 | 当前态度 |
| :---: | :--- | :--- |
| Q-1 | 图像输入（multimodal） | M2 完善 Attachment.image 全链路 |
| Q-2 | Voice 输入 | M3+ |
| Q-3 | Web 搜索工具 | M2 通过内置 `WebSearch` 工具或用户 MCP 加 |
| Q-4 | 并发多 thread 跑 turn | 不在 v1 范围；若需要走"每 session 多 thread 并发"显式扩展 |
| Q-5 | 远端 sidecar（WS transport） | M2 加 ws:// 模式，复用 JSON-RPC payload |
| Q-6 | Plan 修改的结构化语法 | v1 仅 accept/reject/modify(简单 note)；M2 加结构化 patch |
| Q-7 | 多 SNACA 实例（用户级 / 项目级） | v1 单进程；M2 评估每 session 独立进程隔离 |
| Q-8 | 增量 codebase 索引归 host 还是 SNACA | v1 host 维护，通过 `context.request(codebase_search)` 提供 |
| Q-9 | `edit.confirm` 的 `modified_text` 复杂语义 | v1 仅允许全 hunk 替换文本；不支持局部再编辑 |

---

## 附录 A：`SnacaConfig` schema

```typescript
interface SnacaConfig {
  llm: {
    provider: "deepseek" | "anthropic" | "openai_compatible"
    api_key_env: string                               // env 变量名，实际 key 通过 env 注入
    model: string
    inline_edit_model?: string                        // 可选独立小快模型
    base_url?: string
    timeout_secs?: number
    retry?: {
      max_attempts: number
      base_delay_ms: number
      max_delay_secs: number
      jitter_ratio: number
    }
  }
  engine: {
    max_iterations?: number
    loop_guard_max_repeats?: number
    concurrent_tool_limit?: number
    max_tokens?: number
    history_limit?: number
    compact_after_input_tokens?: number
    compact_keep_recent?: number
    protect_first_n?: number
    compact_max_retries?: number
    system_prompt?: string                            // 覆盖默认
    memory_extractor?: boolean
    memory_extractor_model?: string
    memory_embedder?: "none" | "hash" | "fastembed"
  }
  approval_mode: "interactive" | "auto_allow" | "auto_deny"
  mcp_servers?: Array<{
    name: string
    transport: "stdio" | "http"
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    init_timeout_secs?: number
  }>
  logging?: { filter?: string }
}
```

**安全约束**：`api_key_env` 指明从 env 读 key 的变量名，**实际 key 永远不能落 toml 或协议负载**。host 在 spawn `snaca-editor` 时通过 `process.env` 注入。

---

## 附录 B：`HostCapabilities` 完整 schema

见 §8.2。

---

## 附录 C：与 IM Plugin Protocol 的差异

| 维度 | `im-plugin-protocol` | `editor-protocol` |
| :--- | :--- | :--- |
| 角色 | 多租户 IM 服务（飞书 / 钉钉等） | 单用户本地编辑器 |
| 会话单位 | `(tenant, chat_id)` | `(project_id, session_id, thread_id)` |
| 消息单位 | `event.message_received` / `message.send` | `chat.send` + `turn.delta` 流 |
| 编辑表达 | 工具结果中嵌入文本（无原生编辑概念） | 一等公民 `edit.propose` + streaming |
| 上下文 | 隐式（让 LLM 自己 Read） | 显式 `context` 字段每请求注入 |
| 中断 | `event.recall` | `turn.cancel` |
| Approval | `approval.present` IM 卡片 | `tool.approval_request` 本地 UI |
| 多 thread | 不支持，按 sender_id 派生 project | 同 session 多 thread，单 active |
| Composer | 不支持 | `composer.start` + `plan.update` + `plan.confirm` |

两份协议共享 SNACA 内核（engine / tools / llm / state / skills / memory / mcp），仅入口层分叉。

---

## 19. 变更记录

- **1.0.0-draft** (2026-05-18) — 初始草案。
