# LSP binaries

This directory holds LSP server binaries that ship inside the packaged app.

## Auto-managed (gitignored)

`npm install` (or `npm run download:lsp`) downloads these for the current platform.
Do not commit them.

| Binary | LSP | Source |
|--------|-----|--------|
| `texlab` / `texlab.exe` | LaTeX | https://github.com/latex-lsp/texlab/releases |
| `tinymist` / `tinymist.exe` | Typst | https://github.com/Myriad-Dreamin/tinymist/releases |
| `marksman` / `marksman.exe` | Markdown | https://github.com/artempyanykh/marksman/releases |

Pinned versions live in `scripts/download-{texlab,tinymist,marksman}.js`.

## Notes

1. On Linux/macOS the download scripts `chmod +x` the binary automatically.
2. If a user already has the tool on `PATH`, the app falls back to it; bundled binaries are an offline default.

