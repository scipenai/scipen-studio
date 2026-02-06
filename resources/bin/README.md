# LSP 二进制文件

此目录用于存放 LSP 服务器的二进制文件，它们会被打包到应用程序中。

## 需要的文件

### Windows (x64)
- `texlab.exe` - LaTeX LSP
- `tinymist.exe` - Typst LSP

### macOS (x64/arm64)
- `texlab` - LaTeX LSP
- `tinymist` - Typst LSP

### Linux (x64)
- `texlab` - LaTeX LSP
- `tinymist` - Typst LSP

## 下载方式

### TexLab
从 GitHub Releases 下载：https://github.com/latex-lsp/texlab/releases

### Tinymist
从 GitHub Releases 下载：https://github.com/Myriad-Dreamin/tinymist/releases

或者使用 Cargo 安装后复制：
```bash
cargo install tinymist
# 二进制文件位于 ~/.cargo/bin/tinymist
```

## 注意事项

1. 确保下载的是对应平台的正确版本
2. Linux/macOS 上需要确保文件有执行权限：`chmod +x tinymist texlab`
3. 如果用户系统已安装这些工具（在 PATH 中），应用会自动检测并使用，无需在此目录放置

