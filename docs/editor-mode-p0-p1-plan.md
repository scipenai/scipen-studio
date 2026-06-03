# SciPen Studio × SNACA Editor Mode — P0 + P1 实施 Plan

| 字段 | 值 |
| :--- | :--- |
| **覆盖阶段** | P0（协议骨架，~1 周）+ P1（Ctrl+L 完整闭环，~1 周） |
| **依赖文档** | [`snaca/docs/editor-protocol.md`](../../snaca/docs/editor-protocol.md) v1 |
| **交付状态** | 设计完成，待签发实施 |
| **目标** | 跑通"打开项目 → Ctrl+L 聊天 → AI Read 文件 → AI Edit → DiffReview → Accept → 引擎继续 → done"完整链路 |

---

## 0. 验收门（Definition of Done）

P0+P1 收尾时必须全部满足：

| 类别 | 条件 |
| :--- | :--- |
| **功能** | ① `snaca-editor` 子进程能被 Studio spawn / handshake / 优雅 shutdown<br>② 用户在 ChatSidebar 输入问题，能看到流式 text + 流式 tool_use + tool_result<br>③ AI 触发 `Edit` 工具时 Studio 弹出 Diff Review，用户 Accept 后文件被实际修改<br>④ Reject 时 LLM 看到 `tool_error("rejected by user")` 并可继续 turn<br>⑤ `turn.cancel` 在 2s 内中断当前 turn |
| **隔离** | 切换项目时旧 session 关闭、新 session 开启；thread 列表来自 SNACA SQLite |
| **安全** | API key 仅通过 env 注入 snaca-editor，不出现在 toml/IPC/日志 |
| **质量** | OxLint 零新增 warning；`cargo test --workspace` 全绿；`npm run typecheck:all` 通过；新增公共 API 单测覆盖 ≥ 85% |
| **UAT** | 至少 3 个端到端手测脚本通过（见 §10） |

不在 P0+P1 范围：Ctrl+K Inline Edit、Composer、MCP UI、流式 newText、CodebaseSearch、@-mention 自动完成、跨平台打包、Memory/Skills UI。

---

## 1. 时间表

| 周 | 工作日 | 主线 | 关键里程碑 |
| :---: | :---: | :--- | :--- |
| W1 D1 | SNACA | `snaca-editor-protocol` 类型定义 + JSON-RPC 路由骨架 | crate 编译通过 |
| W1 D2 | SNACA | `snaca-workspace` 双 root 拆分；`snaca-state` threads 索引 | 全 workspace 单测通过 |
| W1 D3 | SNACA | `snaca-editor` binary：init / session.open / chat.send 最小路径 | 命令行可对话 |
| W1 D4 | Studio | `SnacaSidecarService` + `EditorProtocolClient` 骨架 | spawn + handshake 成功 |
| W1 D5 | Studio | `ProjectRegistry` + `SessionManager` + chat IPC 通道 | renderer 能发 chat.send |
| W1 D6-7 | 双 | 联调 P0：完整 text 流式 + done | **P0 收尾 demo** |
| W2 D1 | SNACA | `Edit` 工具改造为 EditProposer 委派；`flush_unsaved` context.request | engine 单测 |
| W2 D2 | Studio | `ContextBuilder` + ChatContext 注入 | context 拼装单测 |
| W2 D3 | Studio | `ChatSidebar` + `ChatMessage` + `ToolUseRenderer` 流式渲染 | UI 可见 |
| W2 D4 | Studio | `EditProposalBridge` + 复用 DiffReviewService | accept 路径打通 |
| W2 D5 | 双 | `turn.cancel` + reject 路径 + 错误处理 | 取消按钮可用 |
| W2 D6-7 | 双 | 端到端 UAT + bug fix | **P1 收尾 demo** |

并行点：W1 D4 起 SNACA 与 Studio 双线推进。

---

## 2. SNACA 侧（Rust）

### 2.1 新建 Crate：`snaca-editor-protocol`

**位置**：`snaca/crates/snaca-editor-protocol/`

**目录结构**：
```
crates/snaca-editor-protocol/
├── Cargo.toml
└── src/
    ├── lib.rs                    # pub re-exports + crate-level docs
    ├── envelope.rs               # JSON-RPC 2.0 frame + NDJSON codec
    ├── id.rs                     # SessionId / ThreadId / TurnId / ProposalId 类型 wrapper
    ├── types/
    │   ├── mod.rs
    │   ├── range.rs              # Range / Position
    │   ├── context.rs            # ChatContext / InlineEditContext / Mention
    │   ├── hunk.rs               # LineHunk
    │   ├── capabilities.rs       # SnacaCapabilities / HostCapabilities
    │   └── config.rs             # SnacaConfig (toml + protocol 共用)
    ├── messages/
    │   ├── mod.rs
    │   ├── init.rs               # Init / Shutdown / health / config.reload
    │   ├── session.rs            # session.open / close / list / new / switch / delete / rename
    │   ├── chat.rs               # chat.send + ChatSendParams
    │   ├── inline_edit.rs        # inline_edit.start
    │   ├── composer.rs           # composer.start / plan.confirm
    │   ├── turn.rs               # turn.delta (含 TurnDeltaKind enum) / turn.cancel
    │   ├── edit.rs               # edit.propose / propose_delta / propose_complete / confirm
    │   ├── tool.rs               # tool.approval_request / tool.confirm
    │   ├── plan.rs               # plan.update
    │   ├── context_req.rs        # context.request / context.respond
    │   ├── usage.rs              # usage.update
    │   ├── memory.rs             # memory.updated
    │   ├── error.rs              # error notification
    │   └── log.rs                # log.write
    ├── error.rs                  # ProtocolError (codes -32xxx)
    └── routing.rs                # Method enum + Dispatcher trait
```

**关键类型草签**：

```rust
// src/messages/turn.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnDeltaKind {
    Text { text: String },
    Thinking { text: String },
    ToolUse { tool_call_id: String, tool: String, args: serde_json::Value },
    ToolProgress { tool_call_id: String, message: String },
    ToolResult { tool_call_id: String, ok: bool, content: String, truncated: Option<bool> },
    Done { reason: DoneReason, cancelled: Option<bool> },
    Error { code: i32, message: String, recoverable: bool },
}

// src/routing.rs
#[async_trait]
pub trait MessageHandler: Send + Sync {
    async fn handle_init(&self, params: InitParams) -> Result<InitResult, ProtocolError>;
    async fn handle_session_open(&self, params: SessionOpenParams) -> Result<SessionOpenResult, ProtocolError>;
    async fn handle_chat_send(&self, params: ChatSendParams) -> Result<ChatSendResult, ProtocolError>;
    // ... (按 spec §10 全部方法)
}

pub struct Dispatcher<H: MessageHandler> { ... }
impl<H: MessageHandler> Dispatcher<H> {
    pub async fn process_line(&self, line: &str) -> Option<String> { ... }
}
```

**依赖**：`serde`, `serde_json`, `tokio`, `async-trait`, `thiserror`, `uuid`

**估算行数**：~1200（含测试 ~600）

### 2.2 新建 Binary：`snaca-editor`

**位置**：`snaca/crates/snaca-editor/`

**目录结构**：
```
crates/snaca-editor/
├── Cargo.toml
└── src/
    ├── main.rs                   # 入口 + stdio loop
    ├── handler.rs                # impl MessageHandler for EditorHandler
    ├── session_manager.rs        # SessionManager: HashMap<SessionId, Session>
    ├── session.rs                # 单 session 状态：thread_id, turn_state, engine_handle
    ├── outbound.rs               # 子进程 → host 的 stdout writer（含 emit helpers）
    ├── context_inject.rs         # ChatContext → system prompt 拼接
    └── config.rs                 # SnacaConfig 加载（toml + env 注入 API key）
```

**关键流程**（main.rs）：
```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let outbound = Arc::new(OutboundWriter::new(stdout));
    let handler = Arc::new(EditorHandler::new(outbound.clone()));
    let dispatcher = Dispatcher::new(handler.clone());

    let mut reader = tokio::io::BufReader::new(stdin).lines();
    while let Some(line) = reader.next_line().await? {
        let dispatcher = dispatcher.clone();
        let outbound = outbound.clone();
        tokio::spawn(async move {
            if let Some(response) = dispatcher.process_line(&line).await {
                outbound.send_raw(&response).await;
            }
        });
    }
    Ok(())
}
```

**估算行数**：~1500

### 2.3 改造 Crate：`snaca-workspace`

**目标**：拆 `workspace_root` 与 `metadata_root`。

**diff 草签**：

```rust
// 旧
pub struct ProjectPaths {
    pub root: PathBuf,
    // workspace = root.join("workspace")
    // memory   = root.join("memory")
    // ...
}

// 新
pub struct ProjectPaths {
    pub workspace_root: PathBuf,        // Read/Write/Bash 操作
    pub metadata_root: PathBuf,         // memory/skills/settings 落地
    pub shared_metadata_root: Option<PathBuf>,
}

impl ProjectPaths {
    pub fn memory_dir(&self) -> PathBuf { self.metadata_root.join("memory") }
    pub fn skills_dir(&self) -> PathBuf { self.metadata_root.join("skills") }
    pub fn settings_file(&self) -> PathBuf { self.metadata_root.join("settings.json") }
    pub fn workspace(&self) -> &Path { &self.workspace_root }

    pub fn validate(&self) -> Result<(), WorkspaceError> {
        if self.metadata_root.starts_with(&self.workspace_root) {
            return Err(WorkspaceError::MetadataInsideWorkspace);
        }
        // ...
    }
}
```

**影响**：所有引用旧 `root` 字段的代码（`snaca-memory` / `snaca-skills` / `snaca-tools` / `snaca-engine`）须改路径方法调用。

**估算行数**：净改 ~250

### 2.4 改造 Crate：`snaca-tools`（编辑工具）

**目标**：`Edit` / `Write` / `MultiEdit` 改为 `EditProposer` 委派。

**新增 trait**：

```rust
// snaca-tools-api/src/edit_proposer.rs
#[async_trait]
pub trait EditProposer: Send + Sync {
    async fn propose(&self, req: EditProposalRequest) -> Result<EditProposalDecision, EditError>;
}

pub struct EditProposalRequest {
    pub file: PathBuf,
    pub base_hash: String,
    pub hunks: Vec<LineHunk>,
    pub summary: Option<String>,
    pub tool_call_id: Option<String>,
}

pub enum EditProposalDecision {
    Accepted { applied_hash: Option<String> },
    Rejected { reason: Option<String> },
    PartialAccepted { applied_hunks: Vec<String> },
}
```

**Edit 工具改造**（`snaca-tools/src/edit.rs`）：

```rust
// 旧：直接 fs::write
async fn execute(&self, ctx: ToolContext) -> Result<ToolResult> {
    let new_content = compute_new_content(&old_content, &self.old_string, &self.new_string)?;
    fs::write(&path, new_content).await?;
    Ok(ToolResult::success("file updated"))
}

// 新：委派
async fn execute(&self, ctx: ToolContext) -> Result<ToolResult> {
    let old_content = fs::read_to_string(&path).await?;
    let base_hash = sha256_hex(&old_content);
    let new_content = compute_new_content(&old_content, &self.old_string, &self.new_string)?;
    let hunks = compute_line_hunks(&old_content, &new_content)?;

    let request = EditProposalRequest {
        file: path.clone(),
        base_hash,
        hunks,
        summary: Some(format!("Edit {} via Edit tool", path.display())),
        tool_call_id: Some(ctx.tool_call_id.clone()),
    };

    match ctx.edit_proposer.propose(request).await? {
        EditProposalDecision::Accepted { .. } => {
            Ok(ToolResult::success("file updated"))
        }
        EditProposalDecision::Rejected { reason } => {
            Ok(ToolResult::error(format!(
                "rejected by user{}",
                reason.map(|r| format!(": {}", r)).unwrap_or_default()
            )))
        }
        EditProposalDecision::PartialAccepted { applied_hunks } => {
            Ok(ToolResult::success(format!(
                "partially applied ({} hunks)", applied_hunks.len()
            )))
        }
    }
}
```

**估算行数**：净改 ~400

### 2.5 改造 Crate：`snaca-engine`

**目标**：
1. Context 注入：`ChatContext` → system prompt 拼接
2. `context.request` 反向 RPC（`flush_unsaved` for Read）
3. `thinking_delta` / `tool_progress` 事件 emit
4. 多 session 并发隔离（按 session_id 路由 turn）

**新增模块**：`snaca-engine/src/editor_runtime.rs` —— 编辑器模式专用的 turn runner，与现有 `engine.rs`（IM 模式）共享 `step()` 等核心逻辑但 emit 不同事件。

**估算行数**：净改 ~500

### 2.6 改造 Crate：`snaca-state`

**目标**：`threads` 表加 `project_id` 索引，支持按 session 过滤。

**migration**：
```sql
ALTER TABLE threads ADD COLUMN project_id TEXT;
CREATE INDEX idx_threads_project ON threads(project_id, last_active_at DESC);
```

**估算行数**：~150

### 2.7 Cargo.toml 更新

```toml
# snaca/Cargo.toml [workspace]
members = [
    # ... existing
    "crates/snaca-editor-protocol",
    "crates/snaca-editor",
]

# snaca/Cargo.toml [workspace.dependencies]
snaca-editor-protocol = { path = "crates/snaca-editor-protocol", version = "0.1.0" }
```

### 2.8 SNACA 工作量汇总

| Crate | 净行数 |
| :--- | :---: |
| 新 `snaca-editor-protocol` | +1200 |
| 新 `snaca-editor` | +1500 |
| `snaca-workspace` | +250 |
| `snaca-tools` | +400 |
| `snaca-engine` | +500 |
| `snaca-state` | +150 |
| `snaca-tools-api`（加 EditProposer trait） | +100 |
| **合计** | **~4100 行 Rust**（P0+P1 范围；包含 inline_edit / composer 占位，但本期不实现完整路径） |

---

## 3. Studio 侧（TypeScript）

### 3.1 目录布局（新增/修改）

```
scipen-studio/src/
├── main/
│   ├── services/
│   │   ├── agent/                                  ← 新目录
│   │   │   ├── SnacaSidecarService.ts              ★ 新
│   │   │   ├── EditorProtocolClient.ts             ★ 新
│   │   │   ├── SessionManager.ts                   ★ 新
│   │   │   ├── ProjectRegistry.ts                  ★ 新
│   │   │   ├── ContextBuilder.ts                   ★ 新
│   │   │   ├── EditProposalBridge.ts               ★ 新
│   │   │   ├── ContextRequestHandler.ts            ★ 新
│   │   │   ├── ConfigSyncService.ts                ★ 新
│   │   │   └── interfaces/
│   │   │       ├── ISnacaSidecarService.ts
│   │   │       ├── IEditorProtocolClient.ts
│   │   │       ├── ISessionManager.ts
│   │   │       └── IProjectRegistry.ts
│   │   ├── ServiceContainer.ts                     ✏ 加 ServiceNames 常量
│   │   └── ServiceRegistry.ts                      ✏ 注册新服务
│   └── ipc/
│       ├── agentHandlers.ts                        ★ 新
│       ├── ipcSchemas.ts                           ✏ 加 schema
│       └── index.ts                                ✏ 引入新 handler
├── renderer/src/
│   ├── components/
│   │   ├── chat/                                   ← 新目录
│   │   │   ├── ChatSidebar.tsx                     ★ 新
│   │   │   ├── ChatMessage.tsx                     ★ 新
│   │   │   ├── ChatInput.tsx                       ★ 新
│   │   │   ├── ToolUseRenderer.tsx                 ★ 新
│   │   │   ├── ThinkingRenderer.tsx                ★ 新
│   │   │   └── AgentStatusBar.tsx                  ★ 新
│   │   ├── editor/
│   │   │   └── EditorPane.tsx                      ✏ 集成 EditProposalBridge
│   │   └── layout/                                 ✏ 加 ChatSidebar 槽位
│   ├── services/
│   │   └── agent/                                  ← 新目录
│   │       ├── AgentClientService.ts               ★ 新 (renderer 侧轻量 client)
│   │       ├── ChatStreamStore.ts                  ★ 新 (event-driven store)
│   │       └── ProjectSwitchOrchestrator.ts        ★ 新
│   └── hooks/
│       ├── useChatStream.ts                        ★ 新
│       └── useActiveSession.ts                     ★ 新
└── shared/
    └── ipc/
        ├── channels.ts                              ✏ 加 Agent_* 通道
        ├── agent-contract.ts                       ★ 新
        └── index.ts                                 ✏ 聚合 IPCAgentContract
```

`★` 新建，`✏` 修改。

### 3.2 核心 main 服务接口

#### `ISnacaSidecarService`

```typescript
// src/main/services/agent/interfaces/ISnacaSidecarService.ts
export interface ISnacaSidecarService extends Partial<IDisposable> {
  readonly onStateChange: Event<SidecarState>;
  readonly state: SidecarState;

  start(): Promise<void>;
  stop(graceful: boolean): Promise<void>;
  restart(): Promise<void>;
  isRunning(): boolean;

  // 暴露给 EditorProtocolClient
  getStdinWriter(): NodeJS.WritableStream | null;
  onStdoutLine(handler: (line: string) => void): IDisposable;
}

export type SidecarState =
  | { kind: 'stopped' }
  | { kind: 'starting' }
  | { kind: 'running'; pid: number }
  | { kind: 'crashed'; lastError: string; retryAt: number }
  | { kind: 'stopping' };
```

#### `IEditorProtocolClient`

```typescript
// src/main/services/agent/interfaces/IEditorProtocolClient.ts
export interface IEditorProtocolClient extends Partial<IDisposable> {
  init(params: InitParams): Promise<InitResult>;
  shutdown(): Promise<void>;

  // session
  sessionOpen(params: SessionOpenParams): Promise<SessionOpenResult>;
  sessionClose(sessionId: string): Promise<void>;
  sessionListThreads(sessionId: string, opts?: { limit?: number; offset?: number }): Promise<ThreadListResult>;
  sessionNewThread(sessionId: string, title?: string): Promise<{ threadId: string; title: string }>;
  sessionSwitchThread(sessionId: string, threadId: string): Promise<void>;

  // chat
  chatSend(params: ChatSendParams): Promise<{ turnId: string }>;
  turnCancel(turnId: string, reason?: string): void;  // notification

  // edit
  editConfirm(params: EditConfirmParams): Promise<EditConfirmResult>;
  toolConfirm(params: ToolConfirmParams): Promise<void>;

  // events
  readonly onTurnDelta: Event<TurnDeltaEvent>;
  readonly onEditPropose: Event<EditProposeEvent>;
  readonly onEditProposeDelta: Event<EditProposeDeltaEvent>;
  readonly onEditProposeComplete: Event<EditProposeCompleteEvent>;
  readonly onPlanUpdate: Event<PlanUpdateEvent>;
  readonly onUsageUpdate: Event<UsageUpdateEvent>;
  readonly onMemoryUpdated: Event<MemoryUpdatedEvent>;
  readonly onError: Event<ErrorEvent>;
  readonly onContextRequest: Event<ContextRequestEvent>;  // 由 ContextRequestHandler 订阅
}
```

#### `ISessionManager`

```typescript
// src/main/services/agent/interfaces/ISessionManager.ts
export interface ISessionManager extends Partial<IDisposable> {
  readonly activeSessionId: string | null;
  readonly activeThreadId: string | null;
  readonly inflightTurn: InflightTurn | null;
  readonly onActiveChange: Event<{ sessionId: string | null; threadId: string | null }>;
  readonly onInflightChange: Event<InflightTurn | null>;

  openProject(projectId: string): Promise<void>;        // 通过 ProjectRegistry 解析路径
  closeActiveSession(): Promise<void>;

  newThread(title?: string): Promise<string>;
  switchThread(threadId: string): Promise<void>;        // 内部检查 inflight，必要时阻塞或取消
  deleteThread(threadId: string): Promise<void>;
  listThreads(): Promise<ThreadSummary[]>;

  sendChat(content: string, context: ChatContext, attachments?: Attachment[]): Promise<string>;
  cancelInflight(): void;
}

export interface InflightTurn {
  turnId: string;
  kind: 'chat' | 'inline_edit' | 'composer';
  startedAt: number;
}
```

#### `IProjectRegistry`

```typescript
// src/main/services/agent/interfaces/IProjectRegistry.ts
export interface IProjectRegistry extends Partial<IDisposable> {
  list(): Promise<ProjectEntry[]>;
  getOrCreate(workspaceRoot: string): Promise<ProjectEntry>;
  get(projectId: string): Promise<ProjectEntry | null>;
  rename(projectId: string, displayName: string): Promise<void>;
  remove(projectId: string, opts: { purgeMemory: boolean }): Promise<void>;
  setLastOpened(projectId: string): Promise<void>;
}

export interface ProjectEntry {
  uuid: string;
  workspaceRoot: string;             // 绝对路径，正斜杠
  metadataRoot: string;              // <userData>/.scipen-studio/.snaca/local/projects/<uuid>
  displayName: string;
  projectType: 'latex' | 'typst' | 'mixed';
  createdAt: string;
  lastOpenedAt: string;
  pinned: boolean;
}
```

### 3.3 IPC 契约：`shared/ipc/agent-contract.ts`

```typescript
import type { IpcChannel } from './channels';
import type {
  ChatContext, EditConfirmParams, EditConfirmResult,
  ThreadSummary, InflightTurn, ProjectEntry,
} from './agent-types';   // 与 EditorProtocolClient 内部类型对齐

export interface IPCAgentContract {
  [IpcChannel.Agent_OpenProject]: {
    args: [projectId: string];
    result: { sessionId: string; threads: ThreadSummary[] };
  };
  [IpcChannel.Agent_CloseProject]: {
    args: [];
    result: { closed: true };
  };
  [IpcChannel.Agent_ListProjects]: {
    args: [];
    result: ProjectEntry[];
  };
  [IpcChannel.Agent_NewThread]: {
    args: [title?: string];
    result: { threadId: string; title: string };
  };
  [IpcChannel.Agent_SwitchThread]: {
    args: [threadId: string];
    result: { switched: true };
  };
  [IpcChannel.Agent_ListThreads]: {
    args: [];
    result: ThreadSummary[];
  };
  [IpcChannel.Agent_SendChat]: {
    args: [content: string, context: ChatContext];
    result: { turnId: string };
  };
  [IpcChannel.Agent_CancelTurn]: {
    args: [turnId: string];
    result: { ok: true };
  };
  [IpcChannel.Agent_ConfirmEdit]: {
    args: [params: EditConfirmParams];
    result: EditConfirmResult;
  };
  [IpcChannel.Agent_GetActiveState]: {
    args: [];
    result: {
      sessionId: string | null;
      threadId: string | null;
      inflightTurn: InflightTurn | null;
    };
  };
}

// 通道名（在 channels.ts 加）
// Agent_OpenProject = 'agent:open-project'
// Agent_CloseProject = 'agent:close-project'
// Agent_SendChat = 'agent:send-chat'
// ... etc
```

### 3.4 Zod Schemas（`src/main/ipc/ipcSchemas.ts` 增量）

```typescript
import { z } from 'zod';

const safePathSchema = z.string().min(1).max(4096)
  .refine(p => !p.includes('..'), 'Path traversal')
  .refine(p => !p.includes('\0'), 'Null bytes');

const uuidSchema = z.string().uuid();

const rangeSchema = z.object({
  start: z.object({ line: z.number().int().min(0), column: z.number().int().min(0) }),
  end:   z.object({ line: z.number().int().min(0), column: z.number().int().min(0) }),
});

const mentionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: safePathSchema, inline_content: z.string().optional() }),
  z.object({ kind: z.literal('folder'), path: safePathSchema }),
  z.object({ kind: z.literal('symbol'), path: safePathSchema, name: z.string(), range: rangeSchema }),
  z.object({ kind: z.literal('selection'), path: safePathSchema, range: rangeSchema, text: z.string() }),
  z.object({ kind: z.literal('url'), url: z.string().url(), content: z.string().optional() }),
]);

const chatContextSchema = z.object({
  active_file: z.object({
    path: safePathSchema,
    language: z.string(),
    cursor: z.object({ line: z.number().int().min(0), column: z.number().int().min(0) }).optional(),
    visible_range: z.object({ start_line: z.number().int().min(0), end_line: z.number().int().min(0) }).optional(),
    selection: z.object({ range: rangeSchema, text: z.string() }).optional(),
    dirty: z.boolean().optional(),
  }).optional(),
  open_tabs: z.array(z.object({ path: safePathSchema, dirty: z.boolean() })).optional(),
  recent_edits: z.array(z.object({
    path: safePathSchema, ts: z.string(), summary: z.string(),
  })).optional(),
  mentions: z.array(mentionSchema).optional(),
  diagnostics: z.array(z.object({
    path: safePathSchema,
    severity: z.enum(['error', 'warning', 'info']),
    message: z.string(),
    range: rangeSchema.optional(),
  })).optional(),
  project: z.object({
    type: z.enum(['latex', 'typst', 'mixed']),
    main_file: z.string().optional(),
    engine: z.string().optional(),
  }).optional(),
});

const editConfirmParamsSchema = z.object({
  proposal_id: uuidSchema,
  decision: z.enum(['accept', 'reject', 'accept_partial']),
  per_hunk: z.array(z.object({
    hunk_id: z.string(),
    decision: z.enum(['accept', 'reject']),
  })).optional(),
  modified_text: z.array(z.object({
    hunk_id: z.string(),
    new_text: z.string(),
  })).optional(),
});

// 注册到 channelSchemas
channelSchemas.set(IpcChannel.Agent_OpenProject, z.tuple([uuidSchema]));
channelSchemas.set(IpcChannel.Agent_CloseProject, z.tuple([]));
channelSchemas.set(IpcChannel.Agent_ListProjects, z.tuple([]));
channelSchemas.set(IpcChannel.Agent_NewThread, z.tuple([z.string().max(200).optional()]));
channelSchemas.set(IpcChannel.Agent_SwitchThread, z.tuple([uuidSchema]));
channelSchemas.set(IpcChannel.Agent_ListThreads, z.tuple([]));
channelSchemas.set(IpcChannel.Agent_SendChat, z.tuple([
  z.string().min(1).max(50_000),
  chatContextSchema,
]));
channelSchemas.set(IpcChannel.Agent_CancelTurn, z.tuple([uuidSchema]));
channelSchemas.set(IpcChannel.Agent_ConfirmEdit, z.tuple([editConfirmParamsSchema]));
channelSchemas.set(IpcChannel.Agent_GetActiveState, z.tuple([]));
```

**协议消息层的 Zod**（在 `EditorProtocolClient` 内部）：使用同一 schema 库，对每条入站 message 校验，校验失败 emit `error` 事件并打 warn 日志（不打断 stream）。

### 3.5 ServiceContainer 注册

```typescript
// src/main/services/ServiceContainer.ts
export const ServiceNames = {
  // ... existing
  AGENT_SIDECAR: 'AGENT_SIDECAR',
  AGENT_PROTOCOL_CLIENT: 'AGENT_PROTOCOL_CLIENT',
  AGENT_SESSION_MANAGER: 'AGENT_SESSION_MANAGER',
  AGENT_PROJECT_REGISTRY: 'AGENT_PROJECT_REGISTRY',
  AGENT_CONTEXT_BUILDER: 'AGENT_CONTEXT_BUILDER',
  AGENT_EDIT_PROPOSAL_BRIDGE: 'AGENT_EDIT_PROPOSAL_BRIDGE',
  AGENT_CONTEXT_REQUEST_HANDLER: 'AGENT_CONTEXT_REQUEST_HANDLER',
  AGENT_CONFIG_SYNC: 'AGENT_CONFIG_SYNC',
} as const;

// src/main/services/ServiceRegistry.ts
export function registerServices(container: ServiceContainer): void {
  // ... existing

  container.registerSingleton<IProjectRegistry>(ServiceNames.AGENT_PROJECT_REGISTRY,
    () => createProjectRegistry({ root: getProjectsRoot() }));

  container.registerSingleton<ISnacaSidecarService>(ServiceNames.AGENT_SIDECAR,
    () => createSnacaSidecarService({
      binaryPath: getBundledSnacaEditorPath(),
      configPath: getSnacaConfigPath(),
      secureStorage: container.get(ServiceNames.SECURE_STORAGE),
    }));

  container.registerSingleton<IEditorProtocolClient>(ServiceNames.AGENT_PROTOCOL_CLIENT,
    () => createEditorProtocolClient({
      sidecar: container.get(ServiceNames.AGENT_SIDECAR),
    }));

  container.registerSingleton<ISessionManager>(ServiceNames.AGENT_SESSION_MANAGER,
    () => createSessionManager({
      client: container.get(ServiceNames.AGENT_PROTOCOL_CLIENT),
      registry: container.get(ServiceNames.AGENT_PROJECT_REGISTRY),
    }));

  // ... 其余服务同理
}
```

### 3.6 IPC Handler 入口

```typescript
// src/main/ipc/agentHandlers.ts
export interface AgentHandlersDeps {
  sessionManager: ISessionManager;
  projectRegistry: IProjectRegistry;
  protocolClient: IEditorProtocolClient;
  editBridge: IEditProposalBridge;
}

export function registerAgentHandlers(deps: AgentHandlersDeps): void {
  const { sessionManager, projectRegistry, protocolClient, editBridge } = deps;

  registerTypedHandler(IpcChannel.Agent_OpenProject, async (projectId) => {
    await sessionManager.openProject(projectId);
    return {
      sessionId: sessionManager.activeSessionId!,
      threads: await sessionManager.listThreads(),
    };
  });

  registerTypedHandler(IpcChannel.Agent_SendChat, async (content, context) => {
    const turnId = await sessionManager.sendChat(content, context);
    return { turnId };
  });

  registerTypedHandler(IpcChannel.Agent_ConfirmEdit, async (params) => {
    return await editBridge.handleUserConfirm(params);
  });

  // 流式事件 → 通过 webContents.send 推到 renderer
  protocolClient.onTurnDelta((event) => {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('agent:turn-delta', event);
    });
  });

  protocolClient.onEditPropose((event) => { /* same */ });
  // ... 其余事件
}
```

### 3.7 Renderer 侧关键组件

#### `ChatStreamStore`（event-driven）

```typescript
// src/renderer/src/services/agent/ChatStreamStore.ts
export class ChatStreamStore implements IDisposable {
  private turns = new Map<string, TurnState>();
  private readonly _onTurnUpdate = new Emitter<{ turnId: string }>();
  readonly onTurnUpdate = this._onTurnUpdate.event;

  constructor() {
    window.api.agent.onTurnDelta((event) => this.handleDelta(event));
    window.api.agent.onEditPropose((event) => this.handleEditPropose(event));
    // ...
  }

  private handleDelta(event: TurnDeltaEvent) {
    const turn = this.turns.get(event.turnId) ?? this.createTurn(event.turnId);
    turn.applyDelta(event);
    this._onTurnUpdate.fire({ turnId: event.turnId });
  }

  getTurn(turnId: string): TurnState | undefined { return this.turns.get(turnId); }
  // ...
}
```

#### `ChatSidebar`

```tsx
// src/renderer/src/components/chat/ChatSidebar.tsx
export function ChatSidebar() {
  const store = useService(ChatStreamStore);
  const { activeThreadId, inflightTurn, sendChat, cancelInflight } = useActiveSession();
  const turns = useTurnsForThread(activeThreadId);

  const handleSend = useCallback(async (content: string) => {
    const context = await window.api.agent.buildContext();
    await sendChat(content, context);
  }, [sendChat]);

  return (
    <div className="flex h-full flex-col">
      <ThreadHistoryHeader />
      <div className="flex-1 overflow-y-auto">
        {turns.map((turn) => <ChatMessage key={turn.turnId} turn={turn} />)}
      </div>
      <ChatInput
        onSend={handleSend}
        onCancel={cancelInflight}
        busy={inflightTurn !== null}
      />
      <AgentStatusBar inflight={inflightTurn} />
    </div>
  );
}
```

#### `ChatMessage` 内部

```tsx
function ChatMessage({ turn }: { turn: TurnState }) {
  return (
    <div className="border-b px-3 py-2">
      {turn.events.map((evt, i) => {
        switch (evt.kind) {
          case 'user':         return <UserMessage key={i} content={evt.content} />;
          case 'text':         return <AssistantText key={i} text={evt.text} />;
          case 'thinking':     return <ThinkingRenderer key={i} text={evt.text} />;
          case 'tool_use':     return <ToolUseRenderer key={i} call={evt} />;
          case 'tool_result':  return null; // 折叠到对应 tool_use
          default:             return null;
        }
      })}
    </div>
  );
}
```

### 3.8 EditProposalBridge

```typescript
// src/main/services/agent/EditProposalBridge.ts
export class EditProposalBridge implements IEditProposalBridge {
  private pending = new Map<string, {
    proposal: EditProposeEvent;
    resolve: (result: EditConfirmResult) => void;
  }>();

  constructor(
    private client: IEditorProtocolClient,
    private diffReview: IDiffReviewService,
    private fileSystem: IFileSystemService,
  ) {
    client.onEditPropose((event) => this.handlePropose(event));
    client.onEditProposeDelta((event) => this.handleProposeDelta(event));
    client.onEditProposeComplete((event) => this.handleProposeComplete(event));
  }

  private async handlePropose(event: EditProposeEvent): Promise<void> {
    // 1. 校验 base_hash drift
    const currentContent = await this.fileSystem.read(event.file);
    const currentHash = sha256(currentContent);
    if (currentHash !== event.base_hash) {
      // 通知 UI 显示漂移警告
      this.diffReview.presentDriftWarning(event);
    }

    // 2. 渲染 Diff Review
    const reviewId = this.diffReview.present({
      proposalId: event.proposal_id,
      file: event.file,
      hunks: event.hunks,
      summary: event.summary,
      streaming: event.streaming,
    });

    // 3. 不在这里 await——等 renderer 通过 IPC 调 Agent_ConfirmEdit 时触发 handleUserConfirm
  }

  async handleUserConfirm(params: EditConfirmParams): Promise<EditConfirmResult> {
    if (params.decision === 'accept' || params.decision === 'accept_partial') {
      // host_applies 策略：本地写盘
      await this.applyHunks(params);
    }
    // 回调 SNACA
    return await this.client.editConfirm(params);
  }

  private async applyHunks(params: EditConfirmParams) { /* ... */ }
}
```

### 3.9 Studio 工作量汇总

| 模块 | 净行数 |
| :--- | :---: |
| 新增 main services（agent/） | ~2400 |
| 新增 IPC（agentHandlers + schemas + contract） | ~400 |
| 新增 renderer services（agent/） | ~600 |
| 新增 UI 组件（chat/） | ~1500 |
| 新增 hooks | ~150 |
| **小计 P0+P1 新增** | **~5050 行** |
| 删除（IM/OT 主体；P3 才做） | 不在 P0+P1 |

---

## 4. 协议 ↔ 代码映射表

| Spec 章节 | SNACA 实现 | Studio 实现 |
| :--- | :--- | :--- |
| §5 生命周期 | `snaca-editor/src/main.rs`, `handler.rs::handle_init` | `SnacaSidecarService.start()` + `EditorProtocolClient.init()` |
| §7 session/thread | `snaca-editor/src/session_manager.rs` | `SessionManager` + `ProjectRegistry` |
| §9 context 注入 | `snaca-editor/src/context_inject.rs` | `ContextBuilder` |
| §10.10 chat.send | `handler.rs::handle_chat_send` → `editor_runtime::spawn_chat_turn` | `EditorProtocolClient.chatSend()` ← `Agent_SendChat` IPC |
| §11.1 turn.delta | `editor_runtime` emit via `OutboundWriter` | `ChatStreamStore.handleDelta()` ← `'agent:turn-delta'` |
| §11.2-11.4 edit.propose | `snaca-tools/edit.rs` 内 `ctx.edit_proposer.propose()` | `EditProposalBridge.handlePropose()` |
| §10.15 edit.confirm | `handler.rs::handle_edit_confirm` → `EditProposer` future resolve | `EditProposalBridge.handleUserConfirm()` |
| §11.6 context.request | `engine` 内 `flush_unsaved` 反向 RPC | `ContextRequestHandler` |
| §13.1 turn.cancel | `editor_runtime` watch cancel token | `SessionManager.cancelInflight()` |
| §14 错误码 | `snaca-editor-protocol/src/error.rs` | `EditorProtocolClient` 错误事件 |

---

## 5. 关键风险与对策（P0+P1 范围）

| 风险 | 等级 | 对策 |
| :--- | :---: | :--- |
| stdio 帧粘包 / 拆包错误 | 🟡 | NDJSON 严格 `\n` 分隔；reader 用 `tokio::io::Lines`；TS 端用 `readline` 模块 |
| 大量并发 `turn.delta` 阻塞 main 线程 | 🟡 | EditorProtocolClient 内部用队列 + microtask 批处理；renderer 用 `useSyncExternalStore` 节流 |
| `edit.propose` 与用户同时编辑同一文件 | 🟡 | turn 期间该文件 active editor 显示黄条 + 编辑器只读（W2 D4 实现） |
| API key 泄漏到日志 | 🟢 | `EditorProtocolClient` 日志中间件 mask；`SecureStorageService` 用 safeStorage 加密 |
| SNACA 子进程崩溃 | 🟡 | `SnacaSidecarService` 指数退避重启（base 500ms，cap 60s，max 10 次）；前端显示 toast + 重试按钮 |
| Zod 校验失败导致整个 client 卡死 | 🟢 | 入站校验失败仅打 warn + emit error 事件，**不中断** stream |
| Edit 工具的 line/char range 在 LLM 输出错位 | 🟡 | base_hash 校验兜底；漂移时 host UI 提示让用户决定 rebase / force / reject |
| 切换项目时残留 inflight turn | 🟢 | `SessionManager.closeActiveSession()` 先发 `turn.cancel`，等 `done` 后再 `session.close` |

---

## 6. 配置与构建

### 6.1 SNACA 构建产物嵌入

`scipen-studio/scripts/download-lsp.js` 复用模式新增 `scripts/build-or-download-snaca-editor.js`：
- 优先：从 `D:\scipen\snaca` 本地 `cargo build --release --bin snaca-editor`，拷贝到 `resources/bin/snaca-editor[.exe]`
- 备选：未来从 GitHub Release 下载预编译

`package.json` 加：
```json
"scripts": {
  "prebuild": "npm run download:lsp && npm run build:snaca-editor && npm run copy:public-assets",
  "build:snaca-editor": "node scripts/build-or-download-snaca-editor.js"
}
```

### 6.2 snaca.toml 生成

`ConfigSyncService.writeSnacaConfigFile()` 把 Studio settings 渲染成 `~/.scipen-studio/.snaca/snaca.toml`，其中 LLM API key 用 `${SNACA_API_KEY}` 占位。`SnacaSidecarService` spawn 时通过 `process.env` 注入实际 key。

---

## 7. 测试策略

### 7.1 SNACA 单测

| Crate | 重点测试 |
| :--- | :--- |
| `snaca-editor-protocol` | 各方法 params/result 序列化往返；错误码生成 |
| `snaca-editor` | session 生命周期；多 session 并发隔离；Dispatcher 路由 |
| `snaca-tools/edit` | EditProposer mock 三种 decision 路径 |
| `snaca-workspace` | metadata_root 嵌套校验 |

### 7.2 Studio 单测

| 模块 | 重点 |
| :--- | :--- |
| `EditorProtocolClient` | 入站 deltas 顺序正确；编码崩溃恢复 |
| `SessionManager` | 状态机 transition；切 thread 阻塞 inflight |
| `EditProposalBridge` | base_hash drift 处理；accept/reject 双路径 |
| `ContextBuilder` | active_file 解析；mention 提取 |
| Zod schemas | 边界值（路径长度、空白字符串） |

目标覆盖率：新增公共 API ≥ 85%。

### 7.3 端到端手测脚本（P1 收尾 UAT）

1. **基本问答**：打开任意项目 → ChatSidebar 输入"hello" → 看到流式回复 + done
2. **AI Edit Accept**：输入"把 abstract 第一句改简洁" → 看到 Read tool_use + tool_result → Edit proposal 出现 Diff Review → 点 ✓ → 文件被修改、保存
3. **AI Edit Reject**：同上 → 点 ✗ → SNACA 收到 tool_error → 在 chat 中看到 "rejected by user"
4. **Cancel**：发一个会触发多工具的请求 → 中途点 Stop → 2s 内看到 done(cancelled)
5. **切换 thread**：新建 thread → 各发一条消息 → 切回旧 thread → 历史仍在
6. **切换项目**：开 A 项目发消息 → 打开 B 项目 → A 的 session 关闭、B 的 thread 列表加载

---

## 8. 文件清单（新建 / 修改 一览）

### 新建

| 路径 | 行数估算 |
| :--- | :---: |
| `snaca/crates/snaca-editor-protocol/**` | 1200 |
| `snaca/crates/snaca-editor/**` | 1500 |
| `scipen-studio/src/main/services/agent/SnacaSidecarService.ts` | 250 |
| `scipen-studio/src/main/services/agent/EditorProtocolClient.ts` | 500 |
| `scipen-studio/src/main/services/agent/SessionManager.ts` | 400 |
| `scipen-studio/src/main/services/agent/ProjectRegistry.ts` | 280 |
| `scipen-studio/src/main/services/agent/ContextBuilder.ts` | 320 |
| `scipen-studio/src/main/services/agent/EditProposalBridge.ts` | 380 |
| `scipen-studio/src/main/services/agent/ContextRequestHandler.ts` | 220 |
| `scipen-studio/src/main/services/agent/ConfigSyncService.ts` | 250 |
| `scipen-studio/src/main/services/agent/interfaces/*.ts` | 200 |
| `scipen-studio/src/main/ipc/agentHandlers.ts` | 250 |
| `scipen-studio/shared/ipc/agent-contract.ts` | 150 |
| `scipen-studio/shared/ipc/agent-types.ts` | 200 |
| `scipen-studio/src/renderer/src/components/chat/ChatSidebar.tsx` | 350 |
| `scipen-studio/src/renderer/src/components/chat/ChatMessage.tsx` | 250 |
| `scipen-studio/src/renderer/src/components/chat/ChatInput.tsx` | 200 |
| `scipen-studio/src/renderer/src/components/chat/ToolUseRenderer.tsx` | 200 |
| `scipen-studio/src/renderer/src/components/chat/ThinkingRenderer.tsx` | 100 |
| `scipen-studio/src/renderer/src/components/chat/AgentStatusBar.tsx` | 150 |
| `scipen-studio/src/renderer/src/services/agent/ChatStreamStore.ts` | 350 |
| `scipen-studio/src/renderer/src/services/agent/AgentClientService.ts` | 200 |
| `scipen-studio/src/renderer/src/hooks/useChatStream.ts` | 100 |
| `scipen-studio/src/renderer/src/hooks/useActiveSession.ts` | 100 |
| `scipen-studio/scripts/build-or-download-snaca-editor.js` | 150 |

### 修改

| 路径 | 改动 |
| :--- | :--- |
| `snaca/Cargo.toml` | workspace.members + workspace.dependencies |
| `snaca/crates/snaca-workspace/src/lib.rs` | ProjectPaths 双 root |
| `snaca/crates/snaca-tools-api/src/lib.rs` | + EditProposer trait |
| `snaca/crates/snaca-tools/src/edit.rs` / `write.rs` / `multi_edit.rs` | 委派改造 |
| `snaca/crates/snaca-engine/src/lib.rs` | + editor_runtime mod；context.request 反向 RPC |
| `snaca/crates/snaca-state/migrations/*.sql` | threads 加 project_id 索引 |
| `scipen-studio/shared/ipc/channels.ts` | + Agent_* 通道 |
| `scipen-studio/shared/ipc/index.ts` | + IPCAgentContract |
| `scipen-studio/src/main/ipc/ipcSchemas.ts` | + Agent_* schemas |
| `scipen-studio/src/main/ipc/index.ts` | + registerAgentHandlers |
| `scipen-studio/src/main/services/ServiceContainer.ts` | + AGENT_* names |
| `scipen-studio/src/main/services/ServiceRegistry.ts` | 注册 7 个新服务 |
| `scipen-studio/src/main/index.ts` | 启动时 spawn sidecar + init |
| `scipen-studio/src/renderer/src/components/layout/MainLayout.tsx` | 加 ChatSidebar 槽位 |
| `scipen-studio/package.json` | scripts.prebuild + build:snaca-editor |

---

## 9. 完成确认清单

签收前请逐项打勾：

- [ ] `snaca-editor` 二进制能被 Studio spawn 并完成 `init` 握手
- [ ] `session.open` 后 ChatSidebar 显示 thread 列表
- [ ] `chat.send` 收到流式 text deltas，UI 实时渲染
- [ ] `Read` 工具调用前触发 `flush_unsaved`，Studio 正确响应
- [ ] `Edit` 工具触发 `edit.propose`，Diff Review 覆盖层显示
- [ ] Accept 后文件被修改，Monaco model 同步
- [ ] Reject 后 LLM 在 chat 中看到 "rejected by user"
- [ ] `turn.cancel` 在 2s 内中断
- [ ] 切换 thread 时若 inflight 存在，UI 阻塞并提示
- [ ] 切换项目时旧 session 关闭、新 session 打开
- [ ] API key 不出现在 toml、IPC payload、日志
- [ ] `cargo test --workspace` 全绿
- [ ] `npm run lint:check && npm run typecheck:all && npm run test:run` 全绿
- [ ] 6 个端到端手测脚本全部通过

---

## 10. 后续阶段预告

| 阶段 | 紧随其后 | 主要内容 |
| :--- | :--- | :--- |
| P2 | 1 周后 | Ctrl+K InlineEditWidget + 流式 newText + DirectLLM 路径（实际上 SNACA InlineEdit 工具） |
| P3 | 2 周后 | 大清理（删 IM/OT/远程协同代码） + ProjectRegistry 完整 UI |
| P4 | 3 周后 | 多 thread 切换 UI + ThreadHistory |
| P5 | 4-5 周后 | Composer + plan.update + ComposerPanel |
| P6 | 5-6 周后 | Settings UI 完整（含 MCP / Memory Viewer / Skills） |

P0+P1 是基础设施，后续阶段全部在此之上增量。

---

## 11. 变更记录

- **v1** (2026-05-18) — 初版，对齐 `editor-protocol.md` v1.0.0-draft
