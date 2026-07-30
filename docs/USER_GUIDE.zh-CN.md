# SciPen Studio 用户手册

> **适用版本**: 0.5.0
> **最后更新**: 2026-07-16

[English](USER_GUIDE.md) · **简体中文**

---

## 目录

1. [快速入门](#快速入门)
2. [编辑器](#编辑器)
3. [编译与 PDF 预览](#编译与-pdf-预览)
4. [AI 助手](#ai-助手)
5. [Zotero 集成](#zotero-集成)
6. [本地历史与恢复](#本地历史与恢复)
7. [Overleaf 集成](#overleaf-集成)
8. [设置](#设置)
9. [快捷键](#快捷键)
10. [常见问题](#常见问题)

---

## 快速入门

### 安装

1. 在 [GitHub Releases](https://github.com/scipenai/scipen-studio/releases) 下载对应平台的安装包 (Windows / macOS / Linux)。
2. 运行安装程序,按提示完成。
3. 首次启动后,根据需要配置 AI:
   - **对话 / Agent**: SNACA Agent 运行时**随应用分发**,无需外部服务。在 *设置 → AI* 选好对话提供商(OpenAI / Anthropic / DeepSeek / OpenAI 兼容端点),让 Agent 有一个 LLM 可调用即可。
   - **编辑器内联补全**: *设置 → AI* 中填入 OpenAI / Anthropic API Key。
   - **可选**: *设置 → Agent → 联网搜索* 填入 Tavily API Key,Agent 才能用 **WebSearch** 工具(**WebFetch** 抓取网页无需 key)。
   - 各路径互不依赖,按需配置即可。

> macOS 首次打开可能提示「应用已损坏 / 无法打开」——这是 Gatekeeper 拦截未签名应用,**不是真有问题**。两种处理方式:右键应用图标 → *打开* → 弹窗里再确认一次 *打开*;或在终端执行 `xattr -dr com.apple.quarantine "/Applications/SciPen Studio.app"`。Windows 用户首次启动可能看到 SmartScreen 警告,点 *更多信息 → 仍要运行* 即可。

### 打开项目

欢迎页提供三种入口:

- **打开本地项目**: 选择含 `.tex` / `.typ` / `.md` 的本地目录,程序会扫描其结构。
- **云端项目**: 连接 Overleaf 后浏览并下载远端项目到本地。
- **最近项目**: 欢迎页底部展示最近打开过的项目,可直接点击进入。

> 当前版本不内置 LaTeX / Typst 模板;需要新工程的话,在文件系统里建一个空文件夹,通过"打开本地项目"打开即可。

### 第一次编译

1. 打开任意 `.tex` 或 `.typ` 文件。
2. 工具栏点击 **编译** 或按 `Ctrl+Enter`。
3. 默认使用内置 **WASM 编译器**([BusyTeX](https://github.com/busytex/busytex):pdfTeX / XeTeX / LuaLaTeX),无需本地安装 TeX 发行版。
4. 右侧 PDF 预览自动更新;在 PDF 上单击跳回源码,编辑器内 `Ctrl+点击` 正向跳到 PDF 对应位置 (SyncTeX)。

---

## 编辑器

### 支持的文件类型

| 类型 | 扩展名 | LSP |
|------|--------|-----|
| LaTeX | `.tex`, `.bib`, `.sty`, `.cls` | TexLab |
| Typst | `.typ` | Tinymist |
| Markdown | `.md` | Marksman |

LSP 二进制随安装包一同分发,**无需手动安装**。

### 主要能力

- 语法高亮、智能补全、错误诊断、悬浮提示
- 跳转定义 (`Ctrl+点击`) 与查找引用
- 章节 / 环境块代码折叠
- 多光标 (`Alt+点击`) 与列选择
- 查找替换 (`Ctrl+F` / `Ctrl+H`)
- 命令面板 (`Ctrl+P`) 全局命令搜索与文件跳转

---

## 编译与 PDF 预览

### 编译引擎

| 引擎 | 说明 | 是否需要本地安装 |
|------|------|------------------|
| **WASM BusyTeX** (默认) | 内置 WebAssembly 引擎 —— 在**底部状态栏引擎下拉**中选 `pdftex` / `xetex` / `lualatex`。`xetex` / `lualatex` 通过随包分发的 `scipencjk` 处理 CJK(源码含中文时自动注入,**无需 `\usepackage{ctex}`**)。 | 否 |
| **Tectonic** | 自动下载宏包,适合大型项目 | 是 |
| **TeX Live** (pdfLaTeX / XeLaTeX / LuaLaTeX) | 完整发行版 | 是 |

可在 *设置 → 编译器* 切换默认引擎,或从**底部状态栏引擎下拉**(右下角)按项目切换。下拉列表按能力过滤 —— 无法编译当前文件的引擎会置灰。

### PDF 预览

- 基于 pdf.js 渲染,支持任意缩放、虚拟滚动与 CJK 字形
- **SyncTeX 双向跳转**: 编辑器 `Ctrl+点击` → 跳到 PDF 对应位置;PDF 单击 → 跳回源码
- 编辑器侧栏显示编译错误,点击错误条目即可跳到对应行号

> 编辑器内悬停 LaTeX 公式可看到 KaTeX 渲染的预览(独立于 PDF 渲染层)。

---

## AI 助手

> SciPen Studio 把 AI 拆成两条独立通路:
> - **对话 / Agent / 公式生成 / 文本润色** → 通过**内置 SNACA Agent 运行时**(随应用分发,无需外部服务)
> - **编辑器内联补全 (inline completion)** → 通过直连 API (OpenAI / Anthropic 等)
>
> 两条路径互不依赖。

### 1. 项目对话

在对话框输入问题,助手会结合当前打开的文件回答。
- 输入 `@` 触发文件选择器,可引用项目中任意文件作为上下文 (例如 `@chapters/intro.tex`)
- 编译报错时自动把错误日志带入上下文,辅助定位
- 对话使用的模型在 *设置 → AI* 选择(与内联补全同屏)。Anthropic 模型还会在多轮对话中**命中 prompt cache**:基础提示 + 项目记忆稳定段被缓存,只有按本轮问题动态拉取的「相关记忆」段不缓存

### 2. Agent 工具(内置)

配好对话模型后,Agent 可调用工具读写项目文件,基于真实数据回答。**所有 bot 写入都以 Diff Review 卡片形式先呈现给你审**:
- 行内绿 / 黄 / 红 装饰显示新增 / 修改 / 删除
- 顶部覆盖条提供 *Accept All* / *Reject All*
- 每个 hunk 旁有独立 ✓ / ✗ 按钮
- Accept 之后装饰**保留 5 分钟 Undo 窗口** —— 编辑器工具栏出现倒计时 chip 与 *Undo Latest* 按钮,可撤回最后一个 applied hunk(或整份 review)。在 *Auto-accept* 审批模式下这就是你的兜底:edit 立刻落地,但 5 分钟内仍可反悔。

内置工具包含 `Read` / `Write` / `Edit` / `MultiEdit` / `Grep` / `Glob` / `LS` / `Bash` / `Skill` / 内存 + Zotero / `TodoWrite` / `TaskOutput` / `TaskStop` / **WebSearch / WebFetch** / **AskUserQuestion**。文件改动 / shell / Bash 这类高风险工具会走**审批卡片** —— *允许一次*、*始终允许*、*拒绝*。

### 2a. Ctrl+K 内联编辑

选中一段代码,按 `Ctrl+K`,输入指令(如「重写成 bullet list」/「翻译成英文」),模型会把替换文本**流式写回**缓冲区,合并成**单次撤销步**。**与聊天 Agent 独立** —— 用的是 *设置 → AI* 里的**补全模型**,直连 provider,**不走 SNACA**。流式过程中按 `Esc` 取消,按 `Tab` 接受完成后的替换。

### 3. AskUserQuestion(多选问题卡)

当 Agent 不确定你想要哪条路径时,可以在聊天里弹卡问你:
- 一张卡含 **1–4 个问题**,每题 **2–4 个选项**(单选或多选)
- 每个问题都隐含 **「其他」** 文本框,可自由填写
- 点击 *提交*,你的选择就成为 Agent 下一步的输入
- 长时间不答仍可取消:关闭项目 / 中止本轮回话都会回收卡片

提交后卡片消失,模型会把你的答案作为下一个工具结果继续推理。

### 4. 联网搜索与抓取

Agent 内置两个网络工具:
- **WebFetch** — 抓取一个网页并把渲染后的文本喂给模型。**无需 key**。
- **WebSearch** — 调用 Tavily 搜索 top-N 结果。**需要 Tavily API key**(免费档:<https://tavily.com>),在 *设置 → Agent → 联网搜索* 填入。未填时 WebSearch 仍出现在工具清单里,但会返回一条「缺 key」错误,**WebFetch 不受影响**。

Tavily key 仅在 spawn Agent 进程时注入 env,**不写入 Agent 配置文件**。

### 5. 内置学术科研 Skills

安装包内含四个 Skill(SNACA Bundled scope),开箱即用。内容源自 [Imbad0202/academic-research-skills](https://github.com/Imbad0202/academic-research-skills)(构建时打包进来):
- `academic-paper` — 撰写学术论文(intake → outline → draft → revise)
- `academic-paper-reviewer` — 给 manuscript 做 single-blind peer review
- `academic-pipeline` — 编排「文献 → 论文」全链路
- `deep-research` — 多源核对的事实研究报告

Tenant / 项目级的 Skill(`<workspace>/.scipen/skills/...`)按同名覆盖 Bundled,可在不改应用的前提下定制行为。

### 6. 记忆与 Skill 查看器

Agent 把用户偏好和项目事实存为按项目分目录的 Markdown,落在操作系统的**应用数据目录**下(macOS 是 `~/Library/Application Support/SciPen Studio/.snaca/...`、Windows 是 `%APPDATA%\SciPen Studio\.snaca\...`、Linux 是 `~/.config/SciPen Studio/.snaca/...`)。**只读**查看器从 *设置 → Agent* 入口打开:
- **Memory 查看器** — 浏览 / 搜索当前项目的记忆条目,看 source(extractor 还是 user)与自评 confidence
- **Skills 查看器** — 列出当前生效 scope 下所有 Skill(Bundled / Tenant / Project),查看具体内容

低 confidence 的 extractor 条目会被**自动召回**过滤(可配置阈值);它们仍在查看器里可见。

---

## Zotero 集成

有两种数据源可选 —— 本机运行的 **桌面 Zotero**,或 **zotero.org 云端 Web API**。在 *设置 → Zotero → 数据源* 二选一。

### 数据源(Local vs Web)

- **桌面 Zotero (Local API)** —— 默认。需要本机装 Zotero + [Better BibTeX](https://retorque.re/zotero-better-bibtex/) 插件。速度快,支持 BBT 生成的 citation key,首次镜像后即使 Zotero 关闭也能查。
- **云端 Zotero (Web API)** —— 不装 Zotero 客户端也能用(headless / 云端工作站 / 多设备)。提供你的 numeric **user ID** 与 **API key**(在 <https://www.zotero.org/settings/keys> 生成)。Studio 直接调 `api.zotero.org`;key 走 OS keychain,永不明文回渲染进程。**云模式下 Better BibTeX 与 MinerU 精解析不可用**(阶段 A 限制);citation key 由 Studio 内置 minter 生成(BBT 兼容的 `[auth:lower][year][veryshorttitle:lower]` 公式)并保存在 SQLite 本地库。

切换数据源会立即触发一次 refresh,不用等 focus 事件。

### 连接(Local API)

1. 在 Zotero 里安装 Better BibTeX 并启用本地 HTTP 端点(默认 `http://127.0.0.1:23119`)。
2. 打开 *设置 → Zotero* 点 **连接**。文献库会被镜像到本地索引,Zotero 关闭时也能查询。

### 连接(Web API)

1. 登录 <https://www.zotero.org/settings/keys>,创建一个**只读 key**(勾选 "Access your Zotero library" 即可)。同一页顶部显示你的 numeric **user ID**。
2. *设置 → Zotero → 数据源* → 选 **云端 Zotero (Web API)** → 弹出设置对话框。
3. 粘贴 user ID + key,点 **测试连接**。成功后对话框显示 "已连接: *{username}*",此时 **保存** 按钮才可用。
4. 保存后 *Sources* 卡片从 "Zotero Local API + BBT" 双行切成 "Zotero Web API" 单行;*Citation Key 归属* 段显示来自 BBT 同步 / Studio 生成 / 用户覆盖三类的计数。

### 你能得到什么

- **实时 BibTeX** —— 镜像随 Zotero 变化事件刷新;`\bibliography{...}` 一加论文就能补全新 citation key。
- **`@cite` 自动补全** —— 在 `.tex` 里输 `@` 打开实时 citation picker,覆盖当前库。
- **右侧 Paper 标签** —— 预览列的 *Paper* tab 会渲染当前引用的 Zotero 条目 PDF;Agent 上下文也会带上当前 active item,让模型知道你在引哪篇。
- **语义 PDF 搜索** —— 本地 embedding 索引覆盖附件 PDF,支持「找相似段落」查询。
- **Agent 工具** —— SNACA Agent 可调用 Zotero(`zotero_search` / `zotero_lookup` / `zotero_annotations` / `zotero_read`)把写作锚定在你库里真实存在的内容上。

### Embedding 与 MinerU 的 BYOK

语义 PDF 搜索需要 embedding provider(OpenAI 或兼容端点),图像型 PDF 的全文抽取用 [MinerU](https://mineru.net)。两者都**可选**,在 *设置 → Zotero* 配置;不配也能用 Zotero,只是失去语义搜索和图像 PDF 抽取。

---

## 本地历史与恢复

SciPen Studio 为每个项目维护一份**内容寻址的快照库** —— **无需 Git**。快照同时驱动时间线浏览器和 chat 里的按消息回滚。

### 快照触发

| 类型 | 触发 |
|------|------|
| **手动 label** | 侧栏 → *History* → *New label*,起名(可选加描述) |
| **自动 label** | 项目打开期间每 ~6 小时一次 |
| **Milestone** | 每次编译成功后打一个(5 分钟节流,避免连编时刷屏) |
| **Drift 快照** | AI Agent 在同一线程里累计改动足够字节后自动触发 |
| **Step(每次 SNACA 工具调用)** | Agent 每个改文件的工具调用记一条 step,挂在当前 chat thread 的 session 下,parent step 建 DAG |

### 浏览与恢复

- 侧栏 → *History* 打开统一浏览器,含 **Labels** 与 **Sessions** 两个 tab
- 选任一 label / step 可看每文件相对当前磁盘状态的 unified diff
- Label 上点 *Restore* 会把所有 tracked 文件写回磁盘(打开的 tab 从快照重新加载)
- Chat 里 hover 任意 user 消息可见 *Rollback* 按钮 —— 把所有打开 tab 恢复到**该消息之前**记录的最后一个 step(相当于撤销 Agent 在这轮之后做的事)

### 存储

快照落在 `{userData}/scipen-studio/projects/{projectId}/history/` —— SQLite 元数据 + 内容寻址 blob 目录(blob ≤ 4 KiB 内联到 SQLite,更大的落 `blobs/{hexPrefix}/{hash}`)。**孤儿扫描每天一次**,长 chunk 链自动折叠,存储不会无界增长。

---

## Overleaf 集成

### 连接

1. 在欢迎页点击 **云端项目**,弹出 Overleaf 连接对话框。
2. 填入服务器地址 (默认 `https://www.overleaf.com`) 与会话 Cookie (例如 `overleaf_session2=...`,可在浏览器 DevTools 的 Network 面板里复制)。
3. 点击连接,Cookie 保存在本地;同时会拉取项目列表供选择。

### 打开远程项目

连接成功后:
1. 在欢迎页选择 *Overleaf 项目*
2. 选定项目后会**下载到本地** (`~/.scipen-studio/overleaf-projects/{项目名}/`)
3. 后续即在本地工作,完全离线可用

### 同步策略

SciPen Studio 采用 **本地优先 + 后台同步** 模式:

- **本地写入**: 保存即落盘 (本地磁盘是真相源,编辑无网络延迟)
- **后台推送**: 保存后异步把改动推送到 Overleaf,不阻塞编辑器
- **三方比对**: 推送时基于 base (上次同步快照) / local / remote 三方比对
  - 仅本地变化 → 直接推送
  - 仅远端变化 → 拉取覆盖本地
  - 两端都变化 → 触发**冲突解决对话框**,选择保留本地或接受远端

---

## 设置

从命令面板 (`Ctrl+P`) 搜索 "打开设置",或点击右上角设置按钮进入设置面板。

### 通用

| 选项 | 说明 |
|------|------|
| 主题 | 浅色 / 深色 / 跟随系统 |
| 语言 | 中文 / English |
| 字体 | 编辑器字体族与字号 |

### AI

| 选项 | 说明 |
|------|------|
| 提供商 | OpenAI / Anthropic / DeepSeek / OpenAI 兼容端点 |
| API Key | API 密钥 (本地保存) |
| API Host | 自定义端点,用于私有代理或聚合服务 |
| 对话模型 | **内置 Agent** 跑对话 / 工具调用 / `Ctrl+L` 选区发到聊天 用的模型 |
| 补全模型 | **编辑器内联补全 + `Ctrl+K` 内联编辑** 用的模型 |

> Agent 严格需要的只有「对话模型」,Agent 运行时随应用分发,无独立服务。

### Agent

| 选项 | 说明 |
|------|------|
| 审批模式 | Agent 改文件 / 跑 shell 前如何确认: *Interactive*(默认,弹卡)/ *Auto-accept* / *Auto-deny*。*Auto-accept* 会替你 fire accept,但 Diff Review 装饰 + 5 分钟 Undo 窗口仍作为兜底 —— 你依然能在事后撤销。适合熟手;*Interactive* 作默认更稳。 |
| 联网搜索 → Tavily API key | **WebSearch** 工具必需;**WebFetch** 无需此 key。保存后 Agent 运行时自动重启使其生效;留空则关闭 WebSearch。 |
| Engine 高级旋钮(折叠) | `max_iterations` / `loop_guard_max_repeats` / `concurrent_tool_limit` / `max_tokens` / `history_limit` / `compact_after_input_tokens` / 缓存 + 记忆参数。**多数用户无需触碰**,默认值按模型自适应。 |
| Memory 查看器 | 打开二级窗口查看当前项目的记忆条目 |
| Skills 查看器 | 列出当前生效 scope 下所有 Skill(Bundled / Tenant / Project),查看内容 |

### 编译器

| 选项 | 说明 |
|------|------|
| LaTeX 引擎 | WASM pdfTeX / WASM XeTeX / Tectonic / TeX Live |
| Typst 引擎 | 通过内置 Tinymist 编译 |
| TexLive 包服务地址 | WASM 编译按需拉取 TeX 宏包的 URL(留空使用默认值,可填自建服务) |

### 快捷键

可在 *快捷键* 标签页自定义编译、AI 调用、命令面板等命令的绑定。

---

## 快捷键

> 部分快捷键在 macOS 上为 `Cmd` 而非 `Ctrl`。可在 *设置 → 快捷键* 自定义。

### 文件 / 窗口

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+S` | 保存当前文件 |
| `Ctrl+Shift+N` | 新建窗口 |
| `Ctrl+P` | 命令面板 / 文件跳转 |
| `Cmd+W` (macOS) / `Alt+F4` (Windows · Linux) | 关闭窗口 / 退出应用 |

### 编辑

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Ctrl+F` / `Ctrl+H` | 查找 / 替换 |
| `Shift+Alt+↓` / `Shift+Alt+↑` | 向下 / 向上复制当前行 |
| `Alt+↑` / `Alt+↓` | 上下移动行 |
| `Alt+点击` | 添加多光标 |
| `Ctrl+D` | 添加下一处匹配到选区(Monaco 默认) |

### 编译与预览

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Enter` | 编译当前文档 |
| `Ctrl+点击` (编辑器) | SyncTeX 正向跳转 |
| 单击 (PDF) | SyncTeX 反向跳转 |

### AI

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+L` | 把选区发到聊天面板 |
| `Ctrl+K` | 内联编辑 —— 用**补全模型**替换选区(流式写回缓冲区,`Tab` 接受,`Esc` 取消) |
| `@` (聊天输入框) | 引用项目文件 / 目录 / 符号 |

### 界面

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+V` | 切换 PDF 预览面板 |
| `Ctrl+\` | 切换聊天面板(专注写作 / 预览时用) |

> 打开"设置"目前没有专用快捷键,可从命令面板 (`Ctrl+P`) 搜索"打开设置",或点击右上角设置按钮。

---

## 常见问题

### Q: 编译失败,提示找不到 LaTeX 引擎?

**A**: 默认会使用内置 WASM 引擎,无需安装外部工具链。如果你切换到了 Tectonic / TeX Live 但未安装,请:
- 安装 [Tectonic](https://tectonic-typesetting.github.io/) (轻量,自动下载宏包)
- 或安装 [TeX Live](https://www.tug.org/texlive/)
- 或在 *设置 → 编译器 → 默认引擎* 切回 *WASM pdfTeX*

### Q: PDF 预览空白?

**A**: 常见原因:

1. 编译尚未成功,查看下方编译日志
2. WASM 引擎首次加载需要数秒
3. 文件体量过大,可考虑分章节编译
4. 重启应用后再试

### Q: macOS 提示「应用已损坏 / 无法打开」?

**A**: 这是 Gatekeeper 拦截**未签名**应用(pre-1.0 版本不签名),**应用本身没问题**。两种处理:
- 右键 *SciPen Studio.app* → *打开* → 弹窗里再点 *打开*;或
- 终端跑 `xattr -dr com.apple.quarantine "/Applications/SciPen Studio.app"`

### Q: Windows 弹 SmartScreen 警告?

**A**: 同上,pre-1.0 未签名。点 *更多信息 → 仍要运行* 即可。

### Q: Agent 说 "WebSearch unsupported / 缺 Tavily API key"?

**A**: WebSearch 工具需要 Tavily key。免费注册:<https://tavily.com>;在 *设置 → Agent → 联网搜索 → Tavily API key* 填入。保存后 Agent 自动重启,下一轮对话起 WebSearch 即可用。**WebFetch**(抓取单个网页)无需 key。

### Q: Agent 会偷偷改我的文件吗?

**A**: 不会。*审批模式*默认为 **Interactive**,任何文件改动工具(Edit / Write / MultiEdit)和 shell 命令都会在对话里弹出**审批卡**,由你决定 *允许一次* / *始终允许* / *拒绝*。「始终允许」的决策按项目记忆。只有切到 *Auto-accept* 才会替你 fire accept —— 但 Diff Review 装饰 + 5 分钟 Undo 窗口仍作为兜底,任何 applied 后可以事后撤回。

### Q: 如何更新软件?

**A**: 程序内置自动更新 (基于 GitHub Releases),发现新版本时会提示。也可前往 [Releases](https://github.com/scipenai/scipen-studio/releases) 手动下载,安装时本地数据与设置自动保留。

---

## 获取帮助

- **GitHub Issues**: <https://github.com/scipenai/scipen-studio/issues>
- **GitHub Discussions**: <https://github.com/scipenai/scipen-studio/discussions>

---

*感谢使用 SciPen Studio。*
