# SciPen Studio

<div align="center">
  <img src="resources/icon.png" width="128" height="128" alt="SciPen Studio Logo" />
  <p><strong>本地科研，云端智慧</strong> · AI-Powered LaTeX & Typst IDE</p>

  ![Version](https://img.shields.io/badge/version-0.1.0-blue)
  ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
  ![License](https://img.shields.io/badge/license-MIT-green)
</div>

SciPen Studio is a local-first scientific writing IDE with AI assistance for LaTeX/Typst.

## Highlights

- LaTeX/Typst editor with Monaco + LSP (TexLab/Tinymist)
- AI writing assistant: chat, polish, formula, review
- RAG knowledge base with citations (PDF/Markdown/Images/Audio)
- PDF preview + SyncTeX forward/backward search
- Overleaf sync and optional remote compile
- CLI tools: PDF→LaTeX, paper reviewer, paper→Beamer

## Quick Start

### Users

1. Download from [GitHub Releases](https://github.com/bug-cat-iu/scipen_studio/releases).
2. (Optional) Configure LLM API key in **Settings**.
3. LaTeX: install [Tectonic](https://tectonic-typesetting.github.io/) or TeX Live (optional).
4. Typst: built-in Tinymist works out of the box.

### Developers

**Prereqs**: Node.js 18+ (recommend 22.x), pnpm 9+

```bash
git clone https://github.com/bug-cat-iu/scipen_studio.git
cd scipen-studio
npm run setup
npm run dev
```

## Build

```bash
npm run build
npm run build:win
npm run build:mac
npm run build:linux
```

Artifacts are in `release/`.

## Tests

```bash
npm run test:unit
npm run test:e2e
npm run test:run
```

Lint/typecheck (optional):

```bash
npm run lint
npm run typecheck:all
```

## CLI Tools

- Located in `cli_tools/`
- Setup/build: `npm run cli:setup` or `npm run cli:build`

## Docs

- **User Guide**: [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) - 用户使用手册
- Architecture: `docs/architecture-review.md`
- Knowledge Base: `docs/KnowledgeBaseAlgorithms.md`
- Multimodal RAG: `docs/MultimodalKnowledgeSystem.md`
- LSP binaries: `resources/bin/README.md`

## Project Structure

```
src/main      Electron main process
src/renderer  React UI
src/shared    Shared types/utilities
cli_tools     CLI utilities
resources     Assets & binaries
```

## License

MIT
