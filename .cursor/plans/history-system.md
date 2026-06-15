# SciPen 版本控制系统 · 实施计划

> 落盘版,执行 anchor。源自完整调研(Overleaf history-v1 / regent / Notion / Cursor / Mercurial revlog / Loro / Eg-walker / Replicache / Authorea / Manubot)。

## 范围与边界

**本计划覆盖 scipen-studio 桌面端的本地 history。** 协同场景(scipen-web-server 多人 history + 跨设备同步)留至 P5+,由独立计划承接。

显式不做:
- ❌ 暴露 git CLI / git-bridge
- ❌ 替换 OT 为 CRDT(Yjs/Automerge/Loro)
- ❌ 抄 regent 的 Go 二进制 / `rgt` CLI(只借 Step 概念)
- ❌ multi-author blame UI(留 P5)
- ❌ 跨项目 history search
- ❌ 分支命名 + branch 合并 UI(session-as-branch 是底层模型,不给用户暴露 git 心智)
- ❌ export to git
- ❌ Peritext / Eg-walker rich text intent preservation(scipen 是 plain text + LaTeX/Markdown 结构化标记)

## 1. 类型映射

| 表面诉求 | 真实维度 | 现状缺口 |
|---------|---------|---------|
| "我想加版本控制" | (1) 文档级时间游走 / (2) AI 会话级 undo / (3) 命名快照 / (4) 多人编辑 blame | OT log 已是连续状态机但无 user-visible 时间线;Diff Review 仅 hunk 级,无"撤回此次 AI 会话"能力;无 label;无 blame UI |
| "类似 Git" | **不要 Git 心智**(学术写作用户非开发者) | 需 GUI 内建,不暴露 CLI |
| "AI 改动可回滚" | regent 模型(Step=tool turn, session=branch);Cursor UX 验证为黄金标准 | SNACA 已有 tool_call_id 链,未持久化为 step |

**根因**:OT 层是连续状态机,无语义化里程碑;Diff Review 是 hunk 决策,无会话级 commit 单元;中间缺一个翻译层把 ops 翻译成"用户能理解的版本/快照/branch"。

## 2. 四层架构

```
L3  UX 时间线层
    timeline slider · label sidebar · 消息点击回滚
    (借: Cursor + Overleaf history UI)
L2  AI 会话级 Step/Session DAG
    Step{parent, tree_blob, causes, session, ts}
    session = chat thread = branch
    (借: regent + Notion transaction pipeline)
L1  文档级 Snapshot/Chunk
    blob (BLAKE3 content-addressed)
    chunk (OT ops range, append-only revlog 思路)
    label (user-named snapshot)
    (借: Overleaf history-v1 + Mercurial revlog)
L0  OT 真相层 ✅ 已有 (不动)
    ot-server operations 表 + actor id + version
```

三句话定位:
- **L0 不动**,它是协同真相
- **L1 做"哪一刻文档长什么样"**(blob+chunk+label),Overleaf 学到位
- **L2 做"AI 撤回 + 人类 batch undo"**(step DAG),regent + Notion 学到位
- **L3 做"用户能看懂"**(timeline + 消息回滚 + Diff Review 视觉统一),Cursor + Overleaf 学到位

## 3. L1 文档级 Snapshot · 设计

### 3.1 SQLite Schema (P0.2 引入 better-sqlite3 后落地)

```sql
CREATE TABLE history_blob (
  hash       BLOB PRIMARY KEY,          -- BLAKE3-256 binary
  bytes      BLOB,                       -- 小 blob inline (<4KB)
  size       INTEGER NOT NULL,
  refcount   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX history_blob_orphan ON history_blob(refcount) WHERE refcount = 0;

CREATE TABLE history_chunk (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL,
  file_id       TEXT NOT NULL,
  version_from  INTEGER NOT NULL,
  version_to    INTEGER NOT NULL,
  base_blob     BLOB NOT NULL,
  target_blob   BLOB NOT NULL,
  op_count      INTEGER NOT NULL,
  primary_actor TEXT,
  created_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX history_chunk_file_version ON history_chunk(file_id, version_to);

CREATE TABLE history_label (
  id           TEXT PRIMARY KEY,          -- ULID
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  kind         TEXT NOT NULL,             -- 'manual' | 'auto' | 'milestone'
  created_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL
) STRICT;

CREATE TABLE history_label_file (
  label_id   TEXT NOT NULL REFERENCES history_label(id) ON DELETE CASCADE,
  file_id    TEXT NOT NULL,
  blob_hash  BLOB NOT NULL,
  version    INTEGER NOT NULL,
  PRIMARY KEY (label_id, file_id)
) STRICT;
```

设计要点:
- **Hash 算法**:M2 暂用 Node 内置 `node:crypto` SHA-256(32 字节,与 BLAKE3 同长度;`Hash = Uint8Array` 是私有细节,后续可一行切换)。原计划 BLAKE3 因 M2 时网络不可达 + 不引入新依赖优先,留 TODO(blake3) 待 @noble/hashes 可装时切换并对两算法跑同套 BlobStore 测试。性能预算 §11 50ms 仍满足(SHA-256 < 100ms / 1MB)
- **Chunk = Mercurial revlog 思路**(append-only + 单文件 chunk 链),不走 Git pack
- **Chunk 不存 ops 内容**,只存 base+target blob 指针 + version range;ops 仍在 L0 operations 表是真相
- **Label 多文件原子单元**(投稿涉及整个 project)
- **refcount 部分索引** WHERE refcount=0 → O(1) 找孤儿

### 3.2 Blob 存储路径(本地 desktop)

```
~/.scipen-studio/projects/{projectId}/history/
├── meta.db                        # SQLite metadata (P0.2 起)
└── blobs/
    ├── 6c/                        # 前 2 hex 分桶
    │   └── 6cab4f...              # 完整 hash 文件名
    └── ...
```

- 分桶 2 hex = 256 桶,避免单目录文件爆炸
- 小 blob (<4KB) inline 进 SQLite;大 blob 走文件系统
- BLAKE3 hash 算法

### 3.3 与 ot-server 集成

`HistoryWriter` 异步消费 OT op 流,**绝不阻塞 OT op apply 热路径**(setImmediate / worker thread);失败 = log warn 不丢 op(OT log 才是真相)。

flush 节奏:每 N ops(100)/每 T 秒(30)取小。

### 3.4 Label 创建入口

| 入口 | 触发 | name 来源 |
|------|------|----------|
| 命令面板 `Ctrl+K → Create label` | 用户主动 | 输入对话框 |
| 自动按时间(每天 18:00) | 系统 | `Auto: 2026-06-15 18:00` kind=auto |
| 自动按里程碑(编译成功 + diff>500 字符 + 距上次自动 label >2h) | 系统 | kind=milestone |
| AI 改动前(SNACA tool 影响 >3 文件) | SNACA bridge | `Before agent: {first user msg 30 字}` kind=auto |

## 4. L2 AI 会话级 Step/Session DAG · 设计

### 4.1 SQLite Schema

```sql
CREATE TABLE history_step (
  hash         BLOB PRIMARY KEY,         -- BLAKE3 hash of canonical encoding
  parent_hash  BLOB,                     -- NULL = root
  project_id   TEXT NOT NULL,
  session_id   TEXT NOT NULL REFERENCES history_session(id),
  tree_hash    BLOB NOT NULL,            -- merkle root, 也是 blob (kind='tree')
  causes       BLOB NOT NULL,            -- msgpack: [{tool_name, args_json, result_summary}]
  origin       TEXT NOT NULL,            -- 'snaca_tool' | 'human_edit' | 'merge'
  ts           INTEGER NOT NULL,
  size_delta   INTEGER NOT NULL
) STRICT;
CREATE INDEX history_step_session ON history_step(session_id, ts);

CREATE TABLE history_step_file (
  step_hash BLOB NOT NULL REFERENCES history_step(hash) ON DELETE CASCADE,
  file_id   TEXT NOT NULL,
  blob_hash BLOB NOT NULL,
  PRIMARY KEY (step_hash, file_id)
) STRICT;

CREATE TABLE history_session (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  chat_thread_id  TEXT,                  -- NULL = 纯人类编辑 session
  head_step_hash  BLOB,
  parent_session  TEXT REFERENCES history_session(id),
  created_at      INTEGER NOT NULL,
  closed_at       INTEGER
) STRICT;
```

设计要点:
- **Step hash** = BLAKE3 of canonical encoding of `(parent, tree, causes, session, ts)` → 自动去重
- **tree_hash 是 merkle root**(也存到 blob 表 kind='tree')
- **causes** 用 msgpack 紧凑,args_json 保留可读
- **origin 三态**:`snaca_tool` / `human_edit` / `merge`

### 4.2 Step 写入 hook 点

| Hook | 触发 | session_id |
|------|------|-----------|
| H1: SNACA tool turn 完成 | `ChatStreamStore.onApprovalResolved(toolCallId)` | chat_thread_id → sessionId |
| H2: 人类编辑 idle batch | OTService.onOpsApplied debounce (5s idle 或 100 ops) | 当前 thread 的 session 或 main session |
| H3: 协同冲突合并 | OT merge fire 时 | 涉及的 session,新 step origin='merge' |

### 4.3 Session-as-branch 语义

```
main session (项目创建时初始化)
├── chat-session-A (thread A 开始)
│   ├── step: snaca_tool (Bash)
│   ├── step: snaca_tool (Write)
│   └── step: human_edit
└── chat-session-B
    └── step: snaca_tool (Read)
```

回滚 = HEAD 倒退 + 原 branch 不删(detached 借 Loro 概念,新编辑自动 attach 创建新 branch)。

## 5. L3 UX 时间线 · 设计

### 5.1 三个入口

| 入口 | 形态 | 借鉴 |
|------|------|------|
| A. 顶部 timeline slider | 项目级,横向轴,左右拖动预览 | Overleaf History |
| B. Chat 消息悬停 "撤回到这里" | 每条用户消息悬停时显示 | **Cursor message rollback** |
| C. 命令面板 `Ctrl+K` | Create label / Browse history / Restore to label | 通用 |

### 5.2 视觉一致性

| 元素 | Diff Review | ApprovalCard | UserQuestionCard | RollbackCard(新) |
|------|------------|-------------|-----------------|----------------|
| 头部 chip | "Pending review" | risk + tool name + ⚠/⛔ | "Decision needed" + ❓ | "Rollback" + ⏪ |
| 顶部条 | — | risk 三色 2px | 倒计时三色 2px | session diff 量条 |
| 决策按钮 | Accept/Reject + per-hunk | Deny/Allow once/Allow always | Submit/Skip | Rollback/Cancel |

→ 决策卡片统一设计语言,L3 直接复用现有模式。

## 6. 回滚语义(关键 — 容易出错)

**Naive 方案(错)**:直接修改 OT log "删除"后续 ops → 破坏协同语义。

**正确方案**(借 Replicache rewind+replay + Loro detach+attach):

```
1. Snapshot 当前 OT version V_now
2. 找到目标 step S_target (version V_target)
3. 在 L0 写一个 'rollback' op,内容置为 S_target.tree blob 内容
   (新 op, version V_now+1, 不是删除旧 op)
4. 协同其他 client 通过 OT 自动同步
5. L2 写 origin='merge' step,parent=S_target,causes=['rollback_from V_now']
```

好处:L0 append-only;历史不丢;协同自动同步。

坏处:rollback 是一个大 op(整文件 replace),OT 协同时可能短暂 lag;mitigation = 分块 apply + UI "应用中" 状态。

## 7. GC 策略

- blob refcount 全程事务(chunk/step/label insert ++ / delete --)
- 后台 daemon 每天扫 `WHERE refcount=0 AND created_at < now - 7d` → 删 blob 文件 + DB row
- chunk 数 > 1000 / file → chunk merge(连续 N 个合并为大 chunk)
- session closed_at < now - 30d → archived(step 不删,UI 折叠)

## 8. 集成点

| 子系统 | 集成方式 | 状态 |
|--------|---------|------|
| ot-server | **零改动**(真相层守住最小职责) | ✅ 兼容 |
| scipen-studio main | 新增 `src/main/services/history/` 包 + IPC `History_*` | 新建 |
| scipen-studio renderer | `useHistory()` hook + timeline 组件 + RollbackCard | 新建 |
| ChatStreamStore | onApprovalResolved → recordStep | hook 点已有 |
| Diff Review | accept/reject 完成时与 SNACA tool 写在同一个 step | hook 点已有 |
| OverleafSyncService | 检测远端有变 → 写 step(origin='merge') | 待 hook |
| IndexedDB 备份(Phase 7) | 并存(IDB 防丢失,history 是 user-facing 时间线) | 不冲突 |

## 9. Phase 拆分

| Phase | 子模块 | 工作量 | 出口标准 |
|-------|-------|-------|---------|
| **P0** 基础设施 | M0 plan / M1 骨架 / M2 BlobStore / M3 SQLite migration / M4 HistoryService / M5 IPC channels / M6 ChunkWriter consumer | 5-8 天 | 后端 API 可读写 blob/chunk;0 UI |
| **P1** L1 MVP | manual label 命令 + 简易 timeline (Ctrl+K → list labels) | 5-7 天 | 用户可"Create label" + "Open label";尚无 rollback UI |
| **P2** L2 + Cursor rollback | step DAG + ChatStreamStore hook + 消息悬停 rollback + RollbackCard | 7-10 天 | "撤回到此消息前"端到端可用 |
| **P3** Timeline UI | 顶部 timeline slider + auto labels + diff preview | 7-10 天 | 用户可视化时间游走 |
| **P4** GC + 压缩 + 协同语义 | refcount GC daemon + chunk merge + rollback 协同 broadcast | 5-7 天 | 长期 stable |

MVP cut = P0+P1+P2(≈ 20 天)= 80% 用户价值。

## 10. P0 子模块路线(本计划首批)

| 模块 | 内容 | 验证 |
|------|------|------|
| **M0** plan md | 落盘 `.cursor/plans/history-system.md` | git diff 已写入 |
| **M1** 包骨架 | `src/main/services/history/`:`IHistoryService.ts` + `types.ts` + `HistoryService.ts` 占位 + `BlobStore.ts` 接口 + log 子 logger | typecheck:all + lint baseline + check-no-cjk OK |
| **M2** BlobStore + BLAKE3 | `BlobStore.ts` 完整实现:BLAKE3 hash via @noble/hashes(纯 JS,无 native binding)+ 文件 IO + 内存 refcount(SQLite 后续模块迁移)+ vitest 单测 | 同上 + 单测全绿 |
| **M3** SQLite migration | 引入 better-sqlite3(tilde 版本)+ 0001_init_history.sql + migration runner + 切换 refcount 到 SQLite | 同上;首启动新建 .db,二启动 idempotent |
| **M4** HistoryService 实现 | recordChunk / createLabel / listLabels / getLabelSnapshot 等核心 API | 单元测试 + integration 测试 |
| **M5** IPC channels + preload | `History_RecordChunk` 等 channel + zod schema + preload api.history.* | typecheck + 调用方契约对齐 |
| **M6** ChunkWriter consumer | OT op event hook + 异步 chunk flush + perf budget benchmark | benchmark `<50ms avg` |

## 11. 性能预算

| 操作 | 路径 | 预算 |
|------|------|------|
| Monaco keystroke | OT op apply | <16ms (60fps frame budget,history 异步不在 critical) |
| HistoryWriter chunk flush | BLAKE3 + blob put + insert | <50ms (worker / setImmediate) |
| Step write | hash + tree merkle + insert | <100ms |
| Rollback to step | 找 step + read tree + replay | <2s (项目 <10MB) |
| Timeline UI 渲染 | DB scan + virtualize | <100ms |

## 12. 反回归 guard

- 单测矩阵(history-writer / history-rollback / history-gc)
- e2e 测试(SNACA flow / Cursor rollback / 协同)
- CI perf budget(regression > 20% 失败)
- migration 幂等 + 失败回退

## 13. 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| 协同 + rollback 冲突场景未穷尽 | 中 | P4 引入 Eg-walker paper 第 6 节 DAG merge 测试集 |
| 存储爆炸 | 中 | refcount 事务 + 每周 reconcile + 监控 |
| BLAKE3 库 cross-platform | 低 | 纯 JS 起步,性能不够再升 napi-rs |
| rollback OT 协同 lag | 中 | rollback op 分块 apply + UI 进度 |
| AI 高频 step 暴涨 | 中 | step debounce + dedupe |

## 14. Sources

架构 / 同领域:
- Overleaf history-v1 architecture (ReadmeX)
- regent-vcs/re_gent (GitHub)
- Notion data model + data scale journey

底层存储 / 算法:
- Mercurial revlog (Nathan Goldbaum) + PackedRepoPlan
- Replicache Concepts

CRDT(P10 候选):
- Eg-walker EuroSys'25 paper + Diamond Types
- Loro + Peritext + Pijul Model

AI Agent UX 对照:
- Cline + Cursor + Copilot CLI

学术写作反面:
- Manubot paper (PLOS Comp Bio)

---

执行历史(模块完成时追加):

P0 后端基础设施 ✅
- [x] M0 plan md(3dc9bce)
- [x] M1 包骨架(6dcf553)
- [x] M2 BlobStore + SHA-256(BLAKE3 留 TODO)+ 11 测(c2e7f0c)
- [x] M3 SQLite migration + 持久化 refcount + 7 测 + better-sqlite3 ~12.6 dep(6c8d5c0)
- [x] M4 HistoryService 核心 API(L1 chunk/label/snapshot + L2 step/session)+ 13 测(9147d38)
- [x] M5 HistoryManager per-project lifecycle + ServiceContainer 注册 + 安全护栏 + 10 测(595a811)
- [x] M5b IPC layer:6 channels + zod schema + preload api.history + ALLOWED_INVOKE_CHANNELS 白名单(eff64cf)
- [x] M6 ChunkWriter 异步批量 consumer + perf 预算 + onError 容错 + 8 测(e37c531)
- [x] M5c IPC PutBlob 暴露(2e3c12a)

P1 L1 文档级 MVP ✅
- [x] P1.UI.A NewLabelDialog + 命令面板 Create label + 23 i18n keys(全 zh+en)
- [x] P1.UI.B BrowseLabelsDialog list/detail + KindChip 三色 + Browse 入口

P2 L2 AI 会话级 + Cursor 风格 rollback ✅
- [x] P2.A IPC RecordStep + ChatStreamStore SNACA tool hook(H1):markApprovalResolved 时 fire-and-forget recordStep,session=`chat-${threadId}`,per-session head step 形成 DAG
- [x] P2.B Label Restore 启用(共享 dialog + apply 流程)
- [x] P2.C.backend resolveStepSnapshot + findStepBeforeTs + 2 新单测
- [x] P2.C.UI Cursor 风格:用户消息悬停 RotateCcw 按钮 → findStepBeforeTs → confirm → applySnapshot 写盘+setContentFromExternal

P3 Timeline UI + auto labels + diff preview ✅
- [x] P3.auto-label 每 6h 时间触发器(0ba5970)
- [x] P3.compile-trigger 编译成功 + 5min 节流触发 milestone label(77fb803)
- [x] P3.size-tracking SNACA 累积 5KB 阈值触发(ab10538)
- [x] P3.timeline 顶部时间轴 scrubber(BrowseLabelsDialog 内,4ccac97)
- [x] P3.diff-preview label detail 每文件 +N/-N 行变化预览(ef74175)

P4 GC + chunk merge ✅
- [x] P4.GC blob orphan sweep daemon + sweepAll API + 1 测(7b2bd9f)
- [x] P4.chunk-merge 连续 chunk 合并 + 2 测(a5c3a4c)
- [x] P4.chunk-merge-auto sweepAll 闭环触发 mergeAllChunks + 1 测(6914bc9)

P5 协同 ✅(通过 Overleaf 而非 OT)
- [x] P5/Overleaf rollback 走 triggerOverleafSyncAfterSave 协同 broadcast(2b39f48)
  · plan §6 原 OT broadcast 假设与 scipen-studio 实际架构不匹配(已迁 Overleaf local-first)
  · 修正:rollback 内容写盘后 fire Overleaf sync(non-Overleaf 项目 no-op),冲突走标准对话框

vitest 累计:56/56 全过
typecheck:all / lint:check / check-no-cjk:全程 baseline 持平

═════════════════════════════════════════════════════════════════
全部 phase ✅(P0/P1/P2/P3/P4/P5 in scope 完成)
═════════════════════════════════════════════════════════════════

显式 plan §12 排除的未做项:
- Git CLI / git-bridge 暴露(学术写作用户非开发者)
- 替换 OT 为 CRDT(Yjs/Automerge/Loro)— 工作量 6+ 月,ROI 负
- regent rgt CLI Go 二进制依赖
- multi-author blame UI
- 跨项目 history search
- 分支命名 / branch 合并 UI(session-as-branch 是底层模型,不暴露 git 心智)
- export to git
- Peritext / Eg-walker rich-text intent preservation(scipen 是 plain text)
