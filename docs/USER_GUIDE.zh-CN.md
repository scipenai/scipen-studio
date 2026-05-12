# SciPen Studio 用户手册

> **适用版本**: 0.2.0
> **最后更新**: 2026-04-28

[English](USER_GUIDE.md) · **简体中文**

---

## 目录

1. [快速入门](#快速入门)
2. [编辑器](#编辑器)
3. [编译与 PDF 预览](#编译与-pdf-预览)
4. [AI 助手](#ai-助手)
5. [Overleaf 集成](#overleaf-集成)
6. [设置](#设置)
7. [快捷键](#快捷键)
8. [常见问题](#常见问题)

---

## 快速入门

### 安装

1. 在 [GitHub Releases](https://github.com/scipenai/scipen-studio/releases) 下载对应平台的安装包 (Windows / macOS / Linux)。
2. 运行安装程序,按提示完成。
3. 首次启动后,根据需要配置 AI:
   - **对话 / Agent**: *设置 → 协作 / IM* 中接入 OpenClaw runtime (默认模式)
   - **编辑器内联补全**: *设置 → AI* 中填入 OpenAI / Anthropic API Key
   - 两者互不依赖,可只配置其一。

### 打开项目

欢迎页提供三种入口:

- **打开本地项目**: 选择含 `.tex` / `.typ` / `.md` 的本地目录,程序会扫描其结构。
- **云端项目**: 连接 Overleaf 后浏览并下载远端项目到本地。
- **最近项目**: 欢迎页底部展示最近打开过的项目,可直接点击进入。

> 当前版本不内置 LaTeX / Typst 模板;需要新工程的话,在文件系统里建一个空文件夹,通过"打开本地项目"打开即可。

### 第一次编译

1. 打开任意 `.tex` 或 `.typ` 文件。
2. 工具栏点击 **编译** 或按 `Ctrl+Enter`。
3. 默认使用内置 **WASM 编译器** (StellarLatex pdfTeX),无需本地安装 TeX 发行版。
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
| **WASM pdfTeX** (默认) | 内置 StellarLatex,开箱即用 | 否 |
| **WASM XeTeX** | 内置,支持 Unicode / CJK | 否 |
| **Tectonic** | 自动下载宏包,适合大型项目 | 是 |
| **TeX Live** (pdfLaTeX / XeLaTeX / LuaLaTeX) | 完整发行版 | 是 |

可在 *设置 → 编译器* 切换默认引擎,或针对单个项目通过工具栏选择。

### PDF 预览

- 基于 pdf.js 渲染,支持任意缩放、虚拟滚动与 CJK 字形
- **SyncTeX 双向跳转**: 编辑器 `Ctrl+点击` → 跳到 PDF 对应位置;PDF 单击 → 跳回源码
- 编辑器侧栏显示编译错误,点击错误条目即可跳到对应行号

> 编辑器内悬停 LaTeX 公式可看到 KaTeX 渲染的预览(独立于 PDF 渲染层)。

---

## AI 助手

> SciPen Studio 把 AI 拆成两条独立通路:
> - **对话 / Agent / 公式生成 / 文本润色** → 通过 OpenClaw runtime(默认)
> - **编辑器内联补全 (inline completion)** → 通过直连 API (OpenAI / Anthropic 等)
>
> 两套互不依赖: 只想用补全可以不接 OpenClaw,只想用 Agent 可以不填 API Key。

### 能力

#### 1. 项目对话

在对话框输入问题,助手会结合当前打开的文件回答。
- 输入 `@` 触发文件选择器,可引用项目中任意文件作为上下文 (例如 `@chapters/intro.tex`)
- 编译报错时自动把错误日志带入上下文,辅助定位

#### 2. OpenClaw Agent 模式

接入 OpenClaw 后,助手可调用工具读取项目文件、提出跨文件改动。Bot 写入都以 **Diff Review** 形式呈现:
- 行内绿色 / 黄色 / 红色装饰展示新增 / 修改 / 删除
- 顶部覆盖条提供 *Accept All* / *Reject All*
- 每个 hunk 旁有独立 ✓ / ✗ 按钮

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
| 提供商 | OpenAI / Anthropic / OpenAI 兼容端点 — 用于**编辑器内联补全** |
| API Key | API 密钥 (本地保存) |
| API Host | 自定义端点,用于私有代理或聚合服务 |
| 模型 | 选择 completion 模型(给内联补全用) |

> 对话 / Agent 的模型不在这里配置,而是在 OpenClaw 服务端管理 — 见 *设置 → 协作 / IM* 中的 OpenClaw 配置。

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
| `Ctrl+L` | 选中文本后调用 AI |
| `@` (AI 输入框) | 引用项目文件 |

### 界面

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+V` | 切换 PDF 预览面板 |

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

### Q: 如何更新软件?

**A**: 程序内置自动更新 (基于 GitHub Releases),发现新版本时会提示。也可前往 [Releases](https://github.com/scipenai/scipen-studio/releases) 手动下载,安装时本地数据与设置自动保留。

---

## 获取帮助

- **GitHub Issues**: <https://github.com/scipenai/scipen-studio/issues>
- **GitHub Discussions**: <https://github.com/scipenai/scipen-studio/discussions>

---

*感谢使用 SciPen Studio。*
