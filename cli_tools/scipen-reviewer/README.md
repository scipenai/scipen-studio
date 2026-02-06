# SciPen Reviewer

基于 Claude Agent SDK 构建的现代化多智能体科学论文评审系统，全面支持结构化输出。

## 核心特性

- **多格式支持** - 支持 PDF、DOC、DOCX、PPT、图片（通过 Mineru API 自动转换为 LaTeX）
- **并行评估** - 5 个专业 Agent 并发执行，大幅提升评审效率
- **全面结构化输出** - 所有 Agent 使用 JSON Schema 确保输出格式一致性
- **Typst 报告** - 生成现代化 Typst 格式的专业评审报告
- **文献检索** - 集成 AMiner MCP 服务器进行智能文献搜索

## 快速开始

### 系统要求

- Node.js >= 18.0.0
- pnpm >= 10.15.0
- Typst（用于编译报告，可选）

### 安装

```bash
# 克隆项目
git clone <repository-url>
cd scipen-reviewer

# 安装依赖
pnpm install

# 构建项目
pnpm build

# 全局安装（可选）
pnpm link --global
```

### 环境配置

```bash
# 设置环境变量（可选）
export MINERU_API_TOKEN=your_mineru_token  # PDF/DOCX 转换
export AMINER_API_KEY=your_aminer_key      # AMiner 文献搜索功能
```

## 使用方法

### 评审论文

```bash
# LaTeX 文件（直接评审）
scipen review paper.tex

# PDF 文件（需要 MINERU_API_TOKEN）
scipen review paper.pdf
```

### 查看支持的文件格式

```bash
scipen formats
```

### 帮助

```bash
scipen --help
```

## 项目架构

```
reviewer_system/
├── src/                       # 源代码目录
│   ├── agents/
│   │   └── definitions.ts     # Agent 定义（声明式配置）
│   ├── cli/
│   │   └── scipen-cli.ts      # 命令行工具
│   ├── core/                  # 核心功能
│   │   ├── sdk.ts             # Claude Agent SDK 封装
│   │   ├── types.ts           # 类型定义
│   │   ├── schemas.ts         # JSON Schema 定义（用于结构化输出）
│   │   ├── reviewer.ts        # 主评审控制器
│   │   ├── parallelExecutor.ts # 并行任务执行器
│   │   ├── filePreprocessor.ts # PDF/DOC 转换器
│   │   └── templateRenderer.ts # Typst 模板渲染器
│   ├── templates/             # Typst 报告模板
│   │   ├── review-report.typ
│   │   ├── paper-analysis.typ
│   │   ├── experimental-evaluation.typ
│   │   ├── technical-evaluation.typ
│   │   ├── english-quality.typ
│   │   └── literature-review.typ
│   ├── utils/
│   │   └── statusDisplay.ts   # 终端状态显示
│   └── index.ts               # 主入口文件
├── dist/                      # 构建输出
├── ~/.scipen/reviewer/<论文名>/  # 评审输出目录（运行时生成）
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
└── .gitignore
```

## 开发脚本

```bash
# 开发模式（直接运行 TypeScript）
pnpm dev

# 开发模式 - 评审模式
pnpm dev:review

# 构建项目
pnpm build

# 构建并运行
pnpm start
```

## 工作流程

```
输入文件 (.pdf/.doc/.tex)
         │
         ▼
┌─────────────────────┐
│    文件预处理       │  Mineru API（如需要）
└─────────────────────┘
         │
         ▼
┌─────────────────────┐
│    并行评估 Agent   │  5 个 Agent 并发执行
│  - 论文结构分析     │  → JSON → Typst
│  - 实验设计评估     │  → JSON → Typst
│  - 技术深度评估     │  → JSON → Typst
│  - 英语质量评估     │  → JSON → Typst
│  - 文献综述评估     │  → JSON → Typst
└─────────────────────┘
         │
         ▼
┌─────────────────────┐
│    综合评审 Agent   │  → JSON → Typst
└─────────────────────┘
         │
         ▼
      最终报告
```

## 评估 Agent 详解

| Agent | 功能描述 | Schema | 输出 |
|-------|---------|--------|------|
| **paper-analysis-agent** | 分析论文结构、内容组织、创新贡献 | `paperAnalysisSchema` | JSON → Typst |
| **experimental-evaluator** | 评估实验设计、统计方法、结果有效性 | `experimentalEvaluationSchema` | JSON → Typst |
| **technical-paper-evaluator** | 评估数学推导、技术深度、创新性 | `technicalEvaluationSchema` | JSON → Typst |
| **english-polishing-agent** | 检查语法、学术风格、表达清晰度 | `englishQualitySchema` | JSON → Typst |
| **literature-review-evaluator** | 使用 AMiner 搜索相关文献，评估引用完整性 | `literatureReviewSchema` | JSON → Typst |
| **comprehensive-review-agent** | 综合所有报告，生成最终评审决定 | `reviewDataSchema` | JSON → Typst |

## 输出文件结构

```
~/.scipen/reviewer/<论文名>/
├── converted/                   # 转换后的文件（PDF/DOC → LaTeX）
├── log/                         # 详细执行日志
│   ├── paper-analysis.log
│   ├── experimental-evaluation.log
│   ├── technical-evaluation.log
│   ├── english-quality.log
│   ├── literature-review.log
│   └── final-review.log
├── json/                        # 结构化 JSON 数据
│   ├── paper-analysis-data.json
│   ├── experimental-evaluation-data.json
│   ├── technical-evaluation-data.json
│   ├── english-quality-data.json
│   ├── literature-review-data.json
│   └── review-data.json
└── reports/                     # 评审报告（Typst 格式）
    ├── paper-analysis.typ
    ├── experimental-evaluation.typ
    ├── technical-evaluation.typ
    ├── english-quality.typ
    ├── literature-review.typ
    ├── related-literature.bib
    └── paper-review-report.typ  # 最终评审报告
```

### 编译 Typst 报告

```bash
# 安装 Typst
curl -L https://typst.app/install.sh | sh

# 编译最终报告
cd ~/.scipen/reviewer/<论文名>/reports
typst compile paper-review-report.typ
# 生成 paper-review-report.pdf
```
