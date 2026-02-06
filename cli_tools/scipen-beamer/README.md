# SciPen Beamer

基于 Claude Agent SDK 构建的学术论文转 Beamer 演示文稿系统，支持智能分析、自动规划和编译修复。

## 核心特性

- **智能分析** - AI 深度解析论文结构、贡献和关键内容
- **自动规划** - 根据演讲时长智能分配幻灯片数量和内容
- **一键生成** - 从 LaTeX 论文到 PDF 演示文稿全自动
- **编译修复** - 自动检测并修复 LaTeX 编译错误（最多 3 次）
- **中文支持** - 自动检测和处理中文内容
- **自定义模板** - 支持默认主题或自定义 Beamer 模板

## 快速开始

### 系统要求

- Node.js >= 18.0.0
- pnpm >= 10.15.0
- TeX Live（包含 xelatex，用于编译，可选）

### 安装

```bash
# 克隆项目
git clone <repository-url>
cd scipen-beamer

# 安装依赖
pnpm install

# 构建项目
pnpm build

# 全局安装（可选）
pnpm link --global
```

## 使用方法

### 转换论文

```bash
# 基本用法（会询问是否使用自定义模板）
scipen-beamer convert paper.tex

# 跳过交互，直接使用默认样式
scipen-beamer convert paper.tex --no-interactive

# 指定演讲时长（默认 15 分钟）
scipen-beamer convert paper.tex -d 20

# 指定输出目录
scipen-beamer convert paper.tex -o ./output

# 跳过编译
scipen-beamer convert paper.tex --skip-compilation
```

### 帮助

```bash
scipen-beamer --help
```

## 项目架构

```
scipen-beamer/
├── src/
│   ├── agents/
│   │   └── definitions.ts     # Agent 定义（声明式配置）
│   ├── cli/
│   │   ├── index.ts           # 命令行工具
│   │   └── interactive.ts     # 交互式模板选择
│   ├── core/
│   │   ├── sdk.ts             # Claude Agent SDK 封装
│   │   ├── schemas.ts         # JSON Schema 定义（结构化输出）
│   │   └── mainController.ts  # 主控制器（流水线编排）
│   └── utils/
│       ├── statusDisplay.ts   # 终端状态显示
│       └── templateManager.ts # 模板管理器
├── dist/                      # 构建输出
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
└── README.md
```

## 开发脚本

```bash
# 开发模式（直接运行 TypeScript）
pnpm dev convert paper.tex

# 构建项目
pnpm build

# 构建并运行
pnpm start convert paper.tex
```

## 工作流程

```
输入文件 (.tex)
       │
       ▼
┌─────────────────────┐
│  第一阶段: 论文分析  │  Paper Analysis Agent
│  提取结构、贡献、内容 │  → JSON
└─────────────────────┘
       │
       ▼
┌─────────────────────┐
│  第二阶段: 演示规划  │  Presentation Planner Agent
│  分配幻灯片和内容    │  → JSON
└─────────────────────┘
       │
       ▼
┌─────────────────────┐
│  第三阶段: 代码生成  │  Beamer Generator Agent
│  生成完整 LaTeX 代码 │  → .tex
└─────────────────────┘
       │
       ▼
┌─────────────────────┐
│  第四阶段: 编译     │  xelatex（本地）
│  编译失败自动修复    │  Compilation Fixer Agent
└─────────────────────┘
       │
       ▼
    最终 PDF
```

## Agent 详解

| Agent | 功能描述 | 输出 |
|-------|---------|------|
| **Paper Analysis Agent** | 分析论文结构、元数据、贡献、关键内容 | JSON |
| **Presentation Planner Agent** | 根据时长规划幻灯片数量、内容分配、时间节点 | JSON |
| **Beamer Generator Agent** | 生成完整可编译的 Beamer LaTeX 代码 | .tex |
| **Compilation Fixer Agent** | 分析编译错误，修复 LaTeX 代码 | .tex |

## 输出文件结构

```
~/.scipen/beamer/
└── [论文名]/
    ├── presentation.tex      # 生成的 Beamer 源码
    ├── presentation.pdf      # 编译后的 PDF（如果编译成功）
    ├── log/                   # 执行日志
    │   ├── paper-analysis.log
    │   ├── presentation-plan.log
    │   ├── content-generation.log
    │   └── compilation-fix.log
    └── json/                  # 结构化 JSON 数据
        ├── paper-analysis.json
        └── presentation-plan.json
```

## 默认 Beamer 样式

- **主题**: Boadilla
- **背景**: 垂直渐变（红色到蓝色）
- **导航**: 移除导航按钮
- **中文**: 自动检测并使用 CJK 环境

## 自定义模板

支持通过 `-t` 参数或交互式选择使用自定义 Beamer 模板：

```bash
scipen-beamer convert paper.tex -t my-template.tex
```

系统会自动检测模板中的 `\usepackage{}` 引用，并提示所需的 `.sty` 文件。

## 故障排除

### 编译失败

```bash
# 查看编译日志
cat ~/.scipen/beamer/论文名/log/compilation-fix.log

# 手动编译
cd ~/.scipen/beamer/论文名
xelatex presentation.tex
```

### 缺少 xelatex

```bash
# macOS
brew install --cask mactex

# Ubuntu
sudo apt-get install texlive-full

# Windows
# 安装 TeX Live: https://www.tug.org/texlive/
```
