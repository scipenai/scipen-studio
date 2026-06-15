<p align="center">
  <img src="resources/icon.png" width="120" height="120" alt="SciPen Studio" />
</p>

<h1 align="center">SciPen Studio</h1>

<p align="center"><strong>用于撰写 LaTeX 与 Typst 文档的桌面 IDE。</strong></p>

<p align="center">面向科研写作 — 把本地编译、AI 助手与 Overleaf 同步整合在同一个本地应用里。</p>

<p align="center">
  <a href="https://github.com/scipenai/scipen-studio/releases"><img alt="Release" src="https://img.shields.io/github/v/release/scipenai/scipen-studio?display_name=tag&sort=semver" /></a>
  <a href="https://github.com/scipenai/scipen-studio/releases"><img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green.svg" /></a>
</p>

<p align="center">
  <a href="https://github.com/scipenai/scipen-studio/releases">下载</a> ·
  <a href="docs/USER_GUIDE.zh-CN.md">用户手册</a> ·
  <a href="DEVELOPER.md">开发者文档</a> ·
  <a href="CHANGELOG.md">更新日志</a>
</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>




## 功能特性

- 🧩 **内置编译器** — WebAssembly pdfTeX / XeTeX,无需本地安装 TeX 发行版;若本地有 Tectonic 或 TeX Live 会自动识别。
- ✏️ **编辑器** — Monaco 编辑器接入 TexLab、Tinymist、Marksman:为 LaTeX、Typst、Markdown 提供补全、诊断、悬浮提示与跳转定义。
- 📄 **实时 PDF 预览** — 基于 pdf.js,支持 SyncTeX 正反向跳转、KaTeX 行内公式、平滑缩放与 CJK 字形显示。
- 🤖 **AI Agent(内置)** — SNACA 运行时随应用分发:文件编辑(逐 hunk Diff Review)、联网搜索 / 抓取、向用户发起的多选问题卡、按项目记忆、以及内置学术科研 Skill(paper / reviewer / pipeline / deep-research,源自 [Imbad0202/academic-research-skills](https://github.com/Imbad0202/academic-research-skills))。无需额外起服务。
- 🕘 **本地历史与恢复** — 自动为项目留痕,无需 Git:手动命名的 label(类似有名字的存档)、编译成功自动 milestone、AI 大改后的 drift 快照、聊天中按用户消息粒度回滚。统一时间线浏览器内可浏览、对比与恢复。
- ☁️ **Overleaf 同步** — 登录一次,项目下载到本地磁盘,可离线编辑,推送时基于 base / local / remote 进行三方合并。

> [!NOTE]
> **当前状态:0.3.0-pre.1 — pre-1.0。** 编辑、编译、预览、AI Agent 与 Overleaf 同步流程已稳定;部分设置项与 API 在 1.0 之前可能仍有调整,破坏性变更会在 [CHANGELOG.md](CHANGELOG.md) 中标注。

## 安装

前往 [GitHub Releases](https://github.com/scipenai/scipen-studio/releases) 下载安装包,**Windows**、**macOS** (Intel + Apple Silicon)、**Linux** (AppImage / .deb) 均提供。

内置 WASM 编译器足以处理常规 LaTeX 项目;若文档体量较大或依赖完整宏包,可装 [Tectonic](https://tectonic-typesetting.github.io/) 或 TeX Live,程序会在下次启动时自动识别。

## 上手 30 秒

1. 从 [Releases](https://github.com/scipenai/scipen-studio/releases) 下载安装包并安装。
2. 启动后选择 **打开本地项目**,选一个含 `.tex` / `.typ` / `.md` 的文件夹。
3. 打开任意 `.tex` 文件,按 `Ctrl+Enter` 编译,内置 WASM 引擎会跑起来,PDF 出现在右侧。
4. SyncTeX 默认开启,源码与 PDF 之间可双向跳转(具体手势见 [用户手册](docs/USER_GUIDE.zh-CN.md))。

AI 助手与 Overleaf 同步是可选项,首次启动不需要任何配置就能编辑、编译、预览。

## 从源码构建

```bash
git clone https://github.com/scipenai/scipen-studio.git
cd scipen-studio && npm run setup && npm run dev
```

需要 **Node.js 20+** 与 **npm 10+**。完整开发说明(测试、IPC 契约、打本地安装包 `build:win` / `build:mac` / `build:linux`、架构约定)见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档

- [用户手册](docs/USER_GUIDE.zh-CN.md) — 功能讲解与快捷键
- [开发者文档](DEVELOPER.md) — 架构、IPC、Worker、测试
- [贡献指南](CONTRIBUTING.md) — 工作流与编码规范
- [安全策略](SECURITY.md) — 漏洞披露流程 (安全问题请勿在公开 Issue 披露)
- [行为准则](CODE_OF_CONDUCT.md)
- [更新日志](CHANGELOG.md)

## 社区

- [Issues](https://github.com/scipenai/scipen-studio/issues) — Bug 反馈与功能请求
- [Discussions](https://github.com/scipenai/scipen-studio/discussions) — 提问、想法与作品分享
- [Releases](https://github.com/scipenai/scipen-studio/releases) — 安装包与各版本说明
- [Security](SECURITY.md) — 安全问题请走私下披露通道,不要在公开 Issue 提交

## 上游致谢

SciPen Studio 构建在以下开源项目之上:

- [Electron](https://www.electronjs.org/) 与 [electron-vite](https://electron-vite.org/) — 桌面运行时与构建链
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — 编辑器内核
- [TexLab](https://github.com/latex-lsp/texlab)、[Tinymist](https://github.com/Myriad-Dreamin/tinymist)、[Marksman](https://github.com/artempyanykh/marksman) — LaTeX / Typst / Markdown 语言服务器
- [pdf.js](https://github.com/mozilla/pdf.js) — PDF 渲染与 CMap 支持
- [KaTeX](https://katex.org/) — 行内公式预览
- [diff-match-patch](https://github.com/google/diff-match-patch) — AI Diff Review 的逐块比对
- [academic-research-skills](https://github.com/Imbad0202/academic-research-skills) — 内置的 SNACA Skill 内容(`academic-paper`、`academic-paper-reviewer`、`academic-pipeline`、`deep-research`)
- [Tectonic](https://tectonic-typesetting.github.io/) 与 [TeX Live](https://www.tug.org/texlive/) — 可选的完整 TeX 发行版

感谢上游所有维护者,SciPen Studio 因你们而存在。

## 开源许可

[MIT](./LICENSE) © SciPen Team
