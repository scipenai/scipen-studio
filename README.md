<p align="center">
  <img src="resources/icon.png" width="120" height="120" alt="SciPen Studio" />
</p>

<h1 align="center">SciPen Studio</h1>

<p align="center"><strong>Local-first desktop IDE for LaTeX &amp; Typst — instant offline compile (including Chinese), Zotero semantic citation, built-in AI Agent, and Overleaf 3-way sync.</strong></p>

<p align="center">Write on a plane, compile in fractions of a second without installing TeX Live, keep every draft on local disk, and collaborate seamlessly with Overleaf or local toolchains.</p>

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

<!-- TODO: Add 16:9 hero screenshot showing Monaco editor + live PDF SyncTeX + Agent diff review / Zotero Paper pane here -->

## Why SciPen Studio?

| Workflow | Overleaf Free | VS Code + LaTeX Workshop | **SciPen Studio** |
|---|---|---|---|
| **Offline & Zero TeX Install** | Cloud-only; queue & compile timeout limits | Requires multi-GB TeX Live / MiKTeX + manual config | **Ready out of the box**: ships BusyTeX WASM (`pdftex`/`xetex`/`lualatex`) + Typst WASM + TexLab/Tinymist + bundled CJK pack (`ctex` / `xeCJK` / Fandol) |
| **Compile Speed & Feedback** | Upload + remote queue round-trip | Fast locally after manual multi-GB TeX setup | **0.23–0.25 s** warm incremental compile on standard papers; **~1.9 s** on a 106-page CJK monograph in our WASM UtilityProcess |
| **AI Editing & Citation Grounding** | Paid add-on; no Zotero RAG | External copilot extensions; no SyncTeX/cite integration | **Built-in SNACA Agent** (hunk Diff Review, `AskUserQuestion`, 4 academic Skills), `Ctrl+K` inline edit, Zotero active semantic recommendation & CiteShot |
| **Collaboration & Safety** | Cloud Git-backed | DIY Git + `.gitignore` | **Overleaf 3-way merge sync** (`base/local/remote`, edits stay local-first) + Git-free local snapshots & per-message chat Rollback |

## Core Capabilities

- ⚡ **Zero-Install Offline Compiler & Incremental WASM Pipeline** — Ships [BusyTeX](https://github.com/busytex/busytex) (pdfTeX / XeTeX / LuaLaTeX) running in an isolated Electron UtilityProcess alongside [typst.ts](https://github.com/Myriad-Dreamin/typst.ts), plus automatic detection of local Tectonic, TeX Live, or Typst CLI when installed. Reuses `.aux`/`.toc`/`.bbl` artifacts cleanly across edits and verifies all 4 built-in templates (`article`, `ieee` with bundled `IEEEtran.bst`, `thesis`, `beamer`) offline in CI.
- 🀄 **Chinese (`ctex` / `xeCJK` / Fandol) Offline Out of the Box** — Bundles `ctex`, `xeCJK`, `zhnumber`, and Fandol OpenType fonts in `texlive-cjk.data` for zero-network XeTeX builds from the very first compile. When CJK text is detected, a one-click CodeLens inserts standard portable `\usepackage[fontset=fandol]{ctex}` (100% compatible with Overleaf and local TeX Live — zero proprietary lock-in).
- 📚 **Deep Zotero Workflow (Local + Cloud Web API)** — Connects to desktop Zotero (via Better BibTeX) or zotero.org Web API, provides live `@cite` autocomplete, active semantic citation recommendations while typing, CiteShot hover abstract previews, a right-pane Paper tab (`Ctrl+Click` citation to inspect the referenced PDF), local embedding semantic search, and grounded Agent tools (`zotero_search`, `zotero_lookup`, `zotero_annotations`, `zotero_read`).
- 🤖 **Built-in Research AI Agent + `Ctrl+K` Inline Edit** — Ships the [SNACA](https://github.com/scipenai/snaca) Rust agent runtime inside the desktop app with hunk-level Diff Review (*Accept All* / per-hunk ✓/✗), interactive `AskUserQuestion` cards, per-project Memory, MCP support, WebFetch / Tavily WebSearch, 4 bundled [academic-research-skills](https://github.com/Imbad0202/academic-research-skills), direct `Ctrl+K` streaming inline edits, and optional global selection capture (`Alt+D` / `Ctrl+L`).
- ✏️ **Research-Grade Editor & Bidirectional PDF Preview** — Monaco editor backed by bundled TexLab, Tinymist, and Marksman LSPs; pdf.js preview with bidirectional SyncTeX jump, KaTeX formula hover preview, and click-to-jump error diagnostics.
- 🕘 **Git-Free Local History & Overleaf 3-Way Sync** — Content-addressed snapshots record manual labels, compile milestones, AI drift checkpoints, and per-message chat Rollback points; Overleaf projects download locally for offline editing and sync asynchronously with three-way merge (`base / local / remote`).

<!-- TODO: Add Demo clip 1 (Zero-install offline compile + Chinese ctex), Demo clip 2 (Zotero active recommendation + Paper tab), Demo clip 3 (SNACA hunk Diff Review + Ctrl+K + Chat Rollback) here -->

## Measured Compile Performance

Measured directly on this repo's built Electron UtilityProcess (`out/main/busytex-process/index.cjs`, `Win32 x64`, BusyTeX `v1.1.1`) with isolated caches:

| Document & Engine | Network Mode | Cold Compile (3 passes) | Warm Incremental (1 pass) | Remote Fetches (Cold) |
|---|---|---|---|---|
| Bundled `article` template (`pdftex`) | Pure offline (`endpoint: ''`) | **1.84 s** (includes `bibtex8`) | **0.23 s** (`artifactsInjected: 3`) | 0 |
| Bundled `thesis` template, 13–14 pp. (`pdftex`) | Pure offline (`endpoint: ''`) | **1.77 s** (includes `bibtex8`) | **0.25 s** (`artifactsInjected: 6`) | 0 |
| 106-page Chinese `ctexbook` (`amsmath`, `hyperref`, TOC, `xetex`, `fontset=fandol`) | Pure offline (`endpoint: ''`) | **6.71 s** | **1.91 s** (`artifactsInjected: 3`) | 0 |
| 106-page Chinese `ctexbook` (`xetex`, `fontset=fandol`) | Default endpoint (`https://texlive2026.texlyre.org`, empty cache) | **7.19 s** | **2.07 s** (`artifactsInjected: 3`) | **0** HTTP 200 / **0** HTTP 404 (`0 ms` curl) |

> Single-pass warm speeds apply to typical text and formula edits where pagination, TOC, and citations stay converged; structural edits that shift page numbers, cross-references, or bibliographies automatically run the needed rerun / `bibtex8` passes.

## Quick Start

1. Download the installer for **Windows**, **macOS** (Intel / Apple Silicon), or **Linux** (AppImage / `.deb`) from [GitHub Releases](https://github.com/scipenai/scipen-studio/releases).
2. On first launch, choose **New from template** (`article`, `ieee`, `thesis`, `beamer` — all ready offline) or **Open local project** on any existing `.tex` / `.typ` / `.md` folder.
3. Open a `.tex` file and press `Ctrl+Enter` to compile with the bundled WASM engine (pick `pdftex` / `xetex` / `lualatex` in the bottom-right status bar; use `xetex` for Chinese `ctex` documents).
4. AI chat (`Settings → AI`), Zotero (`Settings → Zotero`), and Overleaf sync (`Cloud project`) are all optional — editing and offline compilation work immediately with zero API keys.

<details>
<summary>First launch note for unsigned macOS &amp; Windows installers</summary>

- **macOS Gatekeeper**: Unsigned builds may show *"App is damaged / can't be opened"*. Either right-click `SciPen Studio.app` → **Open** → confirm **Open**, or run in Terminal:
  ```bash
  xattr -dr com.apple.quarantine "/Applications/SciPen Studio.app"
  ```
- **Windows SmartScreen**: Click **More info → Run anyway**.

</details>

<details>
<summary>Build from source (Node.js 20+ &amp; npm 10+)</summary>

```bash
# SNACA agent ships as a git submodule; clone with --recurse-submodules
# (or run `git submodule update --init --recursive` after a plain clone).
git clone --recurse-submodules https://github.com/scipenai/scipen-studio.git
# Bundled academic Skills live in a sibling directory; clone it next to scipen-studio.
git clone https://github.com/Imbad0202/academic-research-skills.git

cd scipen-studio
npm install
npm run prebuild   # download LSPs + BusyTeX (incl. CJK pack) + Typst WASM + build SNACA + stage skills
npm run dev
```

`prebuild` is the one-time bootstrap required before `dev` (`npm run setup` only downloads LSP binaries). If `academic-research-skills` lives elsewhere, set `ARS_SKILLS_DIR=<path>` (or `SCIPEN_SKIP_SKILLS=1` to skip bundling skills).

To verify BusyTeX offline templates and production CJK behavior locally:

```bash
npm run build:workers && npm run verify:busytex
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [DEVELOPER.md](DEVELOPER.md) for packaging (`build:win`, `build:mac`, `build:linux`), tests, and IPC details.

</details>

## Documentation

- [User Guide](docs/USER_GUIDE.md) — feature walkthrough, Zotero / AI / Overleaf setup, and shortcuts
- [Developer Guide](DEVELOPER.md) — architecture, IPC contracts, BusyTeX WASM pipeline, testing
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

- [SNACA](https://github.com/scipenai/snaca) — the built-in agent runtime (sibling scipenai project, embedded as a git submodule)
- [Electron](https://www.electronjs.org/) and [electron-vite](https://electron-vite.org/) — desktop runtime and build pipeline
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — the editor that powers the writing surface
- [BusyTeX](https://github.com/busytex/busytex) & [TeXlyre BusyTeX](https://github.com/TeXlyre/texlyre-busytex) — the bundled WebAssembly TeX engine (pdfTeX / XeTeX / LuaLaTeX)
- [typst.ts](https://github.com/Myriad-Dreamin/typst.ts) — the bundled WebAssembly Typst engine
- [TexLab](https://github.com/latex-lsp/texlab), [Tinymist](https://github.com/Myriad-Dreamin/tinymist), [Marksman](https://github.com/artempyanykh/marksman) — language servers for LaTeX, Typst, and Markdown
- [pdf.js](https://github.com/mozilla/pdf.js) — PDF rendering and CMap support
- [KaTeX](https://katex.org/) — inline math preview
- [diff-match-patch](https://github.com/google/diff-match-patch) — hunk-level diff for AI review
- [Better BibTeX](https://retorque.re/zotero-better-bibtex/) — the Zotero plugin that exposes the library to the app
- [academic-research-skills](https://github.com/Imbad0202/academic-research-skills) — the bundled SNACA Skills (`academic-paper`, `academic-paper-reviewer`, `academic-pipeline`, `deep-research`)
- [Tectonic](https://tectonic-typesetting.github.io/) and [TeX Live](https://www.tug.org/texlive/) — optional full TeX distributions

Thanks to everyone maintaining the upstream projects that make SciPen Studio possible.

## License

[MIT](./LICENSE) © SciPen Team
