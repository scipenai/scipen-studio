<p align="center">
  <img src="resources/icon.png" width="120" height="120" alt="SciPen Studio" />
</p>

<h1 align="center">SciPen Studio</h1>

<p align="center"><strong>A desktop IDE for writing LaTeX and Typst documents.</strong></p>

<p align="center">Designed for research writing — local compile, AI assistance, and Overleaf sync available in one local application.</p>

<p align="center">
  <a href="https://github.com/scipenai/scipen-studio/releases"><img alt="Release" src="https://img.shields.io/github/v/release/scipenai/scipen-studio?display_name=tag&sort=semver" /></a>
  <a href="https://github.com/scipenai/scipen-studio/releases"><img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green.svg" /></a>
</p>

<p align="center">
  <a href="https://github.com/scipenai/scipen-studio/releases">Download</a> ·
  <a href="docs/USER_GUIDE.md">User Guide</a> ·
  <a href="DEVELOPER.md">Developer Guide</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>




## Features

- 🧩 **Built-in compiler** — WebAssembly pdfTeX / XeTeX, no local TeX install required. Tectonic and TeX Live are auto-detected when present.
- ✏️ **Editor** — Monaco with TexLab, Tinymist, and Marksman: completion, diagnostics, hover, and jump-to-definition for LaTeX, Typst, and Markdown.
- 📄 **Live PDF preview** — pdf.js renderer with SyncTeX two-way jump, KaTeX inline math, smooth zoom, and CJK glyph rendering.
- 🤖 **AI agent (built-in)** — SNACA runtime ships with the app: file editing with Diff Review, web search / fetch, interactive multiple-choice questions, per-project memory, and bundled academic-research skills (paper / reviewer / pipeline / deep-research). No separate server to run.
- ☁️ **Overleaf sync** — Sign in once, projects download to disk, edits stay offline, three-way merge on push.

> [!NOTE]
> **Status: 0.3.0-pre.1 — pre-1.0.** Editing, compile, preview, AI agent, and Overleaf flows are stable. Some settings and APIs may still change before 1.0; breaking changes are noted in [CHANGELOG.md](CHANGELOG.md).

## Install

Download the latest installer for **Windows**, **macOS** (Intel and Apple Silicon), or **Linux** (AppImage / .deb) from [GitHub Releases](https://github.com/scipenai/scipen-studio/releases).

The bundled WASM compiler handles standard LaTeX projects with no extra setup. For larger documents that need a full TeX distribution, install [Tectonic](https://tectonic-typesetting.github.io/) or TeX Live and the app will detect it on next launch.

## Quick start

1. Download and install the package from [Releases](https://github.com/scipenai/scipen-studio/releases).
2. On launch, choose **Open local project** and pick a folder containing `.tex`, `.typ`, or `.md` files.
3. Open a `.tex` file and press `Ctrl+Enter` — the bundled WASM compiler runs and the PDF appears on the right.
4. SyncTeX is enabled by default: jump both ways between source and PDF (see the [User Guide](docs/USER_GUIDE.md) for the exact gestures).

The AI assistant and Overleaf sync are optional — first launch needs no configuration to edit, compile, and preview.

## Build from source

```bash
git clone https://github.com/scipenai/scipen-studio.git
cd scipen-studio && npm run setup && npm run dev
```

Requires **Node.js 20+** and **npm 10+**. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development guide — testing, IPC contracts, packaging (`build:win` / `build:mac` / `build:linux`), and architectural conventions.

## Documentation

- [User Guide](docs/USER_GUIDE.md) — feature walkthrough and shortcuts
- [Developer Guide](DEVELOPER.md) — architecture, IPC, workers, testing
- [Contributing](CONTRIBUTING.md) — workflow and coding standards
- [Security Policy](SECURITY.md) — vulnerability reporting (do not file public issues for security bugs)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)

## Community

- [Issues](https://github.com/scipenai/scipen-studio/issues) — bug reports and feature requests
- [Discussions](https://github.com/scipenai/scipen-studio/discussions) — questions, ideas, and showcases
- [Releases](https://github.com/scipenai/scipen-studio/releases) — installers and per-version notes
- [Security](SECURITY.md) — please report vulnerabilities privately, not via public issues

## Built on

SciPen Studio builds on the work of these open-source projects:

- [Electron](https://www.electronjs.org/) and [electron-vite](https://electron-vite.org/) — desktop runtime and build pipeline
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — the editor that powers the writing surface
- [TexLab](https://github.com/latex-lsp/texlab), [Tinymist](https://github.com/Myriad-Dreamin/tinymist), [Marksman](https://github.com/artempyanykh/marksman) — language servers for LaTeX, Typst, and Markdown
- [pdf.js](https://github.com/mozilla/pdf.js) — PDF rendering and CMap support
- [KaTeX](https://katex.org/) — inline math preview
- [diff-match-patch](https://github.com/google/diff-match-patch) — hunk-level diff for AI review
- [Tectonic](https://tectonic-typesetting.github.io/) and [TeX Live](https://www.tug.org/texlive/) — optional full TeX distributions

Thanks to everyone maintaining the upstream projects that make SciPen Studio possible.

## License

[MIT](./LICENSE) © SciPen Team
