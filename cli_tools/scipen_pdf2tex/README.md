# PDF to LaTeX Converter

一个强大的命令行工具，使用 VLM (Vision Language Model) 将 PDF 转换为高质量 LaTeX 代码。

## ✨ 功能特性

- ✅ **统一 API 接口**：支持任何 OpenAI 兼容的 VLM API（OpenAI、Claude、Gemini、本地模型等）
- ✅ **共享配置**：与 SciPen 主程序共享 `~/.scipen/config.json` 配置
- ✅ **专业 LaTeX 输出**：使用精心设计的提示词，确保高质量的 LaTeX 代码
- ✅ **中文文档支持**：内置 ctex 宏包，完美支持中文 PDF
- ✅ **智能清理**：自动清理 AI 输出中的冗余内容，确保格式统一
- ✅ **并发处理**：支持多页 PDF 并发转换，提高效率
- ✅ **高质量图像**：可配置 DPI，精确控制图像质量
- ✅ **详细进度**：实时显示转换进度和成功率

## 📦 安装

```bash
# 安装依赖
pnpm install

# 构建项目
pnpm run build

# 全局安装（可选）
npm link
```

## 🚀 快速开始

### 1. 检查/初始化配置

首次使用时，运行：

```bash
scipen-pdf2tex init
```

这会检查 `~/.scipen/config.json` 配置文件，如果不存在则创建默认配置。

配置文件与 SciPen 主程序共享，VLM 配置在 `vlm` 字段下：

```json
{
  "vlm": {
    "provider": "openai",
    "model": "gpt-4-vision-preview",
    "apiKey": "your-api-key",
    "baseUrl": "https://api.openai.com/v1",
    "timeout": 120000,
    "maxTokens": 8000,
    "temperature": 0.3
  }
}
```

### 2. 转换 PDF

配置完成后，直接运行：

```bash
scipen-pdf2tex convert input.pdf
```

输出文件默认保存到 `~/.scipen/pdf2tex/input.tex`。

## 📖 详细使用

### 基本命令

```bash
# 使用配置文件转换（输出到 ~/.scipen/pdf2tex/）
scipen-pdf2tex convert input.pdf

# 指定输出文件
scipen-pdf2tex convert input.pdf -o output.tex

# 覆盖配置文件中的参数
scipen-pdf2tex convert input.pdf --base-url http://localhost:8000 --model gpt-4-vision-preview

# 设置 DPI 和并发数
scipen-pdf2tex convert input.pdf --dpi 600 --concurrent 5
```

### 命令行选项

```bash
scipen-pdf2tex convert <input> [选项]

选项:
  -o, --output <path>         输出 LaTeX 文件路径（默认: ~/.scipen/pdf2tex/<文件名>.tex）
  --base-url <url>            VLM API 端点 URL
  --api-key <key>             API 密钥
  --model <name>              模型名称
  --dpi <number>              PDF 渲染 DPI (默认: 300)
  --concurrent <number>       并发请求数 (默认: 3)
  --max-tokens <number>       最大生成 token 数
  --temperature <number>      温度参数
  --timeout <number>          请求超时时间（毫秒）
```

**配置优先级**：命令行参数 > 全局配置 (`~/.scipen/config.json`)

## 🔧 支持的 VLM 提供商

本工具支持任何兼容 OpenAI Chat Completions API 的服务：

### 本地模型（vLLM）

```bash
# 启动 vLLM 服务
python -m vllm.entrypoints.openai.api_server \
  --model /path/to/Qwen2-VL-7B-Instruct \
  --port 8000
```

配置 `~/.scipen/config.json`：
```json
{
  "vlm": {
    "provider": "vllm",
    "model": "Qwen2-VL-7B-Instruct",
    "apiKey": "",
    "baseUrl": "http://localhost:8000"
  }
}
```

### OpenAI

```json
{
  "vlm": {
    "provider": "openai",
    "model": "gpt-4-vision-preview",
    "apiKey": "sk-xxx",
    "baseUrl": "https://api.openai.com/v1"
  }
}
```

### Claude (via OpenAI-compatible proxy)

```json
{
  "vlm": {
    "provider": "claude",
    "model": "claude-3-opus-20240229",
    "apiKey": "sk-ant-xxx",
    "baseUrl": "https://your-claude-proxy.com/v1"
  }
}
```

### Gemini (via OpenAI-compatible proxy)

```json
{
  "vlm": {
    "provider": "gemini",
    "model": "gemini-pro-vision",
    "apiKey": "AIza-xxx",
    "baseUrl": "https://your-gemini-proxy.com/v1"
  }
}
```

## 📁 配置文件

### 全局配置

配置文件位于：`~/.scipen/config.json`

- 与 SciPen 主程序共享配置
- 修改后所有 SciPen 工具生效
- 包含 LLM、VLM、Embedding 等多种模型配置

### 目录结构

```
~/.scipen/
├── config.json          # 全局配置文件
├── pdf2tex/            # PDF 转 LaTeX 输出目录
│   └── *.tex
├── beamer/             # 论文转 Beamer 输出目录
├── reviewer/           # 论文评审输出目录
├── templates/          # Beamer 模板目录
└── styles/             # 样式文件目录
```

## 🎯 输出特性

### LaTeX 宏包

自动包含以下宏包，确保广泛兼容性：

- **ctex**: 中文支持
- **amsmath, amssymb**: 数学符号和公式
- **amsthm**: 定理环境
- **graphicx**: 图像支持
- **booktabs**: 专业表格
- **hyperref**: 超链接和目录
- **geometry**: 页面设置
- **xcolor**: 颜色支持

### 数学环境规则

VLM 会遵循严格的数学环境规则：

- 行内公式：`\(...\)`
- 行间公式：`\[...\]`
- 严格的环境匹配和嵌套
- 配对定界符（`\left` 和 `\right`）
- 特殊字符自动转义

## 💡 使用场景

### 场景 1：个人使用本地模型

```bash
# 1. 启动 vLLM 服务
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2-VL-7B-Instruct \
  --port 8000

# 2. 编辑 ~/.scipen/config.json 配置 VLM

# 3. 转换
scipen-pdf2tex convert paper.pdf
```

### 场景 2：使用云端 API

```bash
# 一次性转换，使用命令行参数
scipen-pdf2tex convert paper.pdf \
  --base-url https://api.openai.com/v1 \
  --api-key sk-xxx \
  --model gpt-4-vision-preview \
  --dpi 600
```

### 场景 3：批量转换

```bash
# Bash
for file in *.pdf; do
  scipen-pdf2tex convert "$file"
done

# PowerShell
Get-ChildItem *.pdf | ForEach-Object {
  scipen-pdf2tex convert $_.Name
}
```

## ⚙️ 开发

```bash
# 开发模式
pnpm run dev -- convert input.pdf

# 构建
pnpm run build

# 调试模式
DEBUG=1 scipen-pdf2tex convert input.pdf
```

## 📊 性能优化

### DPI 设置

- **150-200**: 快速预览，质量较低
- **300** (默认): 平衡质量和速度
- **600**: 高质量，推荐用于正式文档
- **1200**: 超高质量，处理慢，文件大

### 并发数

- **1**: 适合本地小显存模型
- **3** (默认): 适合大多数场景
- **5-10**: 适合云端 API（注意限流）

### 超时设置

- 默认 120 秒
- 复杂页面可能需要更长时间
- 根据模型速度和页面复杂度调整

## ⚠️ 注意事项

- **API 调用费用**：使用云端 API 时注意成本
- **本地模型要求**：推荐至少 7B 参数的视觉模型
- **中文文档编译**：使用 XeLaTeX 或 LuaLaTeX 编译生成的 LaTeX
- **大文件处理**：可能需要较长时间，建议先测试几页
- **网络稳定性**：确保 API 端点可访问

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 License

MIT

---

**提示**：首次运行 `convert` 命令会自动检查配置文件，无需手动运行 `init` 命令。
