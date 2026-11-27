<p align="center">
  <img src="resources/icon.png" width="120" height="120" alt="SciPen Studio" />
</p>

<h1 align="center">SciPen Studio</h1>

<p align="center"><strong>本地优先的 LaTeX 与 Typst AI 桌面 IDE — 开箱离线编译（含中文）、Zotero 语义引文、内置 Rust AI Agent 与 Overleaf 三方同步。</strong></p>

<p align="center">无需安装多 GB 本地 TeX 发行版，断网也能写论文；零首编联网等待，所有草稿与修改稳妥留在本地磁盘。</p>

<p align="center">
  <a href="https://github.com/scipenai/scipen-studio/releases"><img alt="Release" src="https://img.shields.io/github/v/release/scipenai/scipen-studio?display_name=tag&sort=semver" /></a>
  <a href="https://github.com/scipenai/scipen-studio/releases"><img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green.svg" /></a>
</p>

<p align="center">
  <a href="https://github.com/scipenai/scipen-studio/releases">下载安装包</a> ·
  <a href="docs/USER_GUIDE.zh-CN.md">用户手册</a> ·
  <a href="DEVELOPER.md">开发者文档</a> ·
  <a href="CHANGELOG.md">更新日志</a>
</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

<!-- TODO: 在此处补充 16:9 首页全屏截图（展示 Monaco 编辑器 + 双向 SyncTeX PDF 预览 + Agent Diff 审阅 / 右侧 Zotero 文献面板） -->

## 为什么选择 SciPen Studio？

| 工作流痛点 | Overleaf 免费版 | VS Code + LaTeX Workshop | **SciPen Studio** |
|---|---|---|---|
| **离线写作与零配置安装** | 依赖云端联网；存在编译队列与超时限制 | 需自行下载数 GB TeX Live / MiKTeX 并折腾配置 | **开箱即用**：内置 BusyTeX WASM (`pdftex`/`xetex`/`lualatex`) + Typst WASM + TexLab/Tinymist + 离线中文数据包 (`ctex` / `xeCJK` / Fandol) |
| **本地编译反馈速度** | 上传同步 + 远端排队往返延迟 | 本机安装完整版后较快，但配置门槛高 | WASM UtilityProcess 内实测常规论文热增量 **0.23–0.25 s**，106 页中文专著热增量 **~1.9 s** |
| **AI 科研改写与文献关联** | 付费增值能力，无本地 Zotero 文献检索联动 | 依赖通用补全插件，与 SyncTeX/引文割裂 | **内置 SNACA Agent**（逐 hunk Diff Review、`AskUserQuestion`、4 项科研 Skill）、`Ctrl+K` 内联流式修改、Zotero 语义推荐与 CiteShot 悬停预览 |
| **多人协作与版本安全** | 云端 Git 历史 | 需自行维护 Git 与 `.gitignore` | **Overleaf 三方合并同步**（`base/local/remote`，日常本地离线零延迟）+ 无需 Git 的本地快照与对话级消息回滚 |

## 核心特性

- ⚡ **内置离线编译器与跨轮增量流水线** — 在独立 Electron UtilityProcess 中运行 [BusyTeX](https://github.com/busytex/busytex) (pdfTeX / XeTeX / LuaLaTeX) 并附带 [typst.ts](https://github.com/Myriad-Dreamin/typst.ts)，同时支持自动识别本地已安装的 Tectonic、TeX Live 或 Typst CLI。跨编译轮次安全复用 `.aux`/`.toc`/`.bbl` 中间产物，发布构建前自动校验 4 套内置模板（`article`、`ieee` 含内置 `IEEEtran.bst`、`thesis`、`beamer`）双引擎纯离线编译通过。
- 🀄 **中文 (`ctex` / `xeCJK` / Fandol) 开箱即用纯离线编译** — 内置 `texlive-cjk.data`，打包 `ctex`、`xeCJK`、`zhnumber` 与 Fandol OpenType 字体；中文文档首次启用 XeTeX 编译即走全本地卷，**无需本地 TeX Live、无需首次联网下载宏包与字库**。检测到中文正文时，编辑器提供一键 CodeLens 插入标准可移植的 `\usepackage[fontset=fandol]{ctex}`（与 Overleaf 和本地 TeX Live 完全兼容，无私有宏包锁定）。
- 📚 **深度 Zotero 工作流（本地 BBT + Cloud Web API）** — 支持本机 Better BibTeX 与官方 zotero.org Web API 双数据源；提供 `@cite` 实时补全、输入停顿主动语义推荐、CiteShot 悬停文献摘要预览、右侧 Paper 标签页直接浏览所引 PDF、本地 embedding 附件全文语义检索，以及 Agent 内置 Zotero 工具（`zotero_search` / `zotero_lookup` / `zotero_annotations` / `zotero_read`）。
- 🤖 **内置科研 AI Agent + `Ctrl+K` 内联编辑** — 应用内随包集成 [SNACA](https://github.com/scipenai/snaca) Rust 运行时（无需外部服务）：支持逐 hunk 彩色 Diff 审阅（全部接受 / 逐块 ✓/✗）、`AskUserQuestion` 多选交互卡、按项目 Markdown 记忆、MCP 工具、WebFetch / Tavily WebSearch 与 4 项内置 [academic-research-skills](https://github.com/Imbad0202/academic-research-skills)；另有直连补全模型的 `Ctrl+K` 流式局部改写及可选全局划词捕获（`Alt+D` / `Ctrl+L`）。
- ✏️ **科研编辑器与双向 SyncTeX 预览** — Monaco 编辑器集成随包分发的 TexLab、Tinymist、Marksman 语言服务器；pdf.js 预览支持正反向 SyncTeX 跳转、KaTeX 公式悬停预览与错误行点击直达。
- 🕘 **免 Git 本地历史与 Overleaf 离线三方同步** — 内容寻址快照自动记录手动命名的 label、编译成功 milestone、AI 大改 drift 快照与对话每条消息的回滚锚点；Overleaf 云端项目拉取到本地后全程离线编辑，推送时按 `base / local / remote` 执行三方合并与冲突弹窗裁决。

<!-- TODO: 在此处补充 3 段短视频 / GIF 占位：Demo 1（断网首次中文 ctex 编译 + 零网络等待）、Demo 2（Zotero 语义推荐 + 右侧 Paper 原文对照）、Demo 3（SNACA Diff Review + Ctrl+K + 消息回滚） -->

## 实测编译速度

以下数据均在当前仓库编译产出的 Electron UtilityProcess (`out/main/busytex-process/index.cjs`，`Win32 x64`，BusyTeX `v1.1.1`) 配合隔离临时目录实测得到：

| 测试文档与引擎 | 网络模式 | 冷编译（含 3 轮收敛） | 热增量编译（局部修改正文，1 pass） | 冷编译远端请求 |
|---|---|---|---|---|
| 内置 `article` 模板 (`pdftex`) | 纯离线 (`endpoint: ''`) | **1.84 s**（含 `bibtex8`） | **0.23 s** (`artifactsInjected: 3`) | 0 |
| 内置 `thesis` 模板，13–14 页 (`pdftex`) | 纯离线 (`endpoint: ''`) | **1.77 s**（含 `bibtex8`） | **0.25 s** (`artifactsInjected: 6`) | 0 |
| 106 页中文 `ctexbook`（`amsmath` + `hyperref` + 目录，`xetex`，`fontset=fandol`） | 纯离线 (`endpoint: ''`) | **6.71 s** | **1.91 s** (`artifactsInjected: 3`) | 0 |
| 106 页中文 `ctexbook`（`xetex`，`fontset=fandol`） | 默认端点（`https://texlive2026.texlyre.org`，空缓存） | **7.19 s** | **2.07 s** (`artifactsInjected: 3`) | **0** 次 HTTP 200 / **0** 次 HTTP 404（`0 ms` curl） |

> 1-pass 热增量耗时适用于章节结构、目录与引用关系稳定的日常正文 / 公式修改；当增删文献引用、改动目录或页码发生变化时，流水线会自动补跑必要的额外编译轮次与 `bibtex8`。

## 快速上手

1. 从 [GitHub Releases](https://github.com/scipenai/scipen-studio/releases) 下载对应平台安装包（**Windows**、**macOS** Intel / Apple Silicon、**Linux** AppImage / `.deb`）。
2. 首次打开可直接点击 **从模板新建**（`article`、`ieee`、`thesis`、`beamer` 均已完成全离线验证）或 **打开本地项目** 选择已有 `.tex` / `.typ` / `.md` 目录。
3. 打开任意 `.tex` 文件，按 `Ctrl+Enter` 使用内置 WASM 引擎编译预览（右下角状态栏可切换 `pdftex` / `xetex` / `lualatex`，中文 `ctex` 文档请选 `xetex`）。
4. AI 对话（*设置 → AI*）、Zotero（*设置 → Zotero*）与 Overleaf 同步（*云端项目*）均为可选项——零配置即可直接编辑与纯离线编译。

<details>
<summary>首次打开未签名 macOS / Windows 安装包说明</summary>

- **macOS Gatekeeper**：首次打开若提示「应用已损坏 / 无法打开」，可右键应用图标选择 **打开** 并二次确认；或在终端执行：
  ```bash
  xattr -dr com.apple.quarantine "/Applications/SciPen Studio.app"
  ```
- **Windows SmartScreen**：点击 **更多信息 → 仍要运行** 即可。

</details>

<details>
<summary>从源码构建（需 Node.js 20+ 与 npm 10+）</summary>

```bash
# SNACA Agent 作为 git submodule 嵌入，克隆时请携带 --recurse-submodules
# （若已普通 clone，可执行 `git submodule update --init --recursive`）。
git clone --recurse-submodules https://github.com/scipenai/scipen-studio.git
# 内置学术 Skill 位于兄弟目录，请克隆到 scipen-studio 同级目录下。
git clone https://github.com/Imbad0202/academic-research-skills.git

cd scipen-studio
npm install
npm run prebuild   # 下载 LSP + BusyTeX（含离线 CJK 数据包）+ Typst WASM + 构建 SNACA + 拷贝 Skills
npm run dev
```

`prebuild` 为首次运行前的必要引导步骤（`npm run setup` 仅下载 LSP 二进制）。如 `academic-research-skills` 位于其他路径，可设置 `ARS_SKILLS_DIR=<路径>`（或通过 `SCIPEN_SKIP_SKILLS=1` 跳过）。

本地验证离线模板与生产级 BusyTeX CJK 行为：

```bash
npm run build:workers && npm run verify:busytex
```

打包命令（`build:win`、`build:mac`、`build:linux`）、测试体系与架构细节见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [DEVELOPER.md](DEVELOPER.md)。

</details>

## 文档

- [用户手册](docs/USER_GUIDE.zh-CN.md) — 功能讲解、Zotero / AI / Overleaf 配置与快捷键一览
- [开发者文档](DEVELOPER.md) — 架构、IPC 契约、BusyTeX WASM 流水线与测试
- [贡献指南](CONTRIBUTING.md) — 开发工作流与编码规范
- [安全策略](SECURITY.md) — 漏洞私下披露流程（安全问题请勿提交公开 Issue）
- [行为准则](CODE_OF_CONDUCT.md)
- [更新日志](CHANGELOG.md)

## 社区

- [Issues](https://github.com/scipenai/scipen-studio/issues) — Bug 反馈与功能建议
- [Discussions](https://github.com/scipenai/scipen-studio/discussions) — 使用交流与想法探讨
- [Releases](https://github.com/scipenai/scipen-studio/releases) — 各平台安装包与版本说明
- [Security](SECURITY.md) — 安全问题请走私下报告通道

## 上游致谢

SciPen Studio 构建在以下开源项目之上：

- [SNACA](https://github.com/scipenai/snaca) — 内置 Agent 运行时（scipenai 姊妹项目，以 git submodule 形式嵌入）
- [Electron](https://www.electronjs.org/) 与 [electron-vite](https://electron-vite.org/) — 桌面运行时与构建链
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — 编辑器内核
- [BusyTeX](https://github.com/busytex/busytex) & [TeXlyre BusyTeX](https://github.com/TeXlyre/texlyre-busytex) — 内置的 WebAssembly TeX 引擎（pdfTeX / XeTeX / LuaLaTeX）
- [typst.ts](https://github.com/Myriad-Dreamin/typst.ts) — 内置的 WebAssembly Typst 引擎
- [TexLab](https://github.com/latex-lsp/texlab)、[Tinymist](https://github.com/Myriad-Dreamin/tinymist)、[Marksman](https://github.com/artempyanykh/marksman) — LaTeX / Typst / Markdown 语言服务器
- [pdf.js](https://github.com/mozilla/pdf.js) — PDF 渲染与 CMap 支持
- [KaTeX](https://katex.org/) — 行内公式预览
- [diff-match-patch](https://github.com/google/diff-match-patch) — AI Diff Review 的逐块比对
- [Better BibTeX](https://retorque.re/zotero-better-bibtex/) — 与本机 Zotero 库联通的插件
- [academic-research-skills](https://github.com/Imbad0202/academic-research-skills) — 内置的 SNACA Skill 内容（`academic-paper`、`academic-paper-reviewer`、`academic-pipeline`、`deep-research`）
- [Tectonic](https://tectonic-typesetting.github.io/) 与 [TeX Live](https://www.tug.org/texlive/) — 可选的完整 TeX 发行版

感谢所有上游项目维护者的开源贡献。

## 开源许可

[MIT](./LICENSE) © SciPen Team
