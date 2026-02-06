/**
 * @file CompletionManager.ts - Intelligent Completion Manager
 * @description Layered completion strategy integrating LSP, static completion, and AI Ghost Text
 * @depends LSPService, AIService, LatexIndexer
 */

import { api } from '../api';
import { AIService } from './AIService';
import { CompletionCacheService } from './LRUCache';
import { LSPService } from './LSPService';
import { LatexIndexer } from './LatexIndexer';

// ====== Type Definitions ======

export interface CompletionItem {
  label: string;
  kind: 'command' | 'environment' | 'citation' | 'label' | 'file' | 'math' | 'snippet' | 'ai';
  insertText: string;
  detail?: string;
  documentation?: string;
  sortText?: string;
  filterText?: string;
  previewHtml?: string;
  source?: string;
  bibKey?: string;
}

export interface GhostTextSuggestion {
  text: string;
  source?: string;
  bibKeys?: string[];
}

export interface CompletionContext {
  lineContent: string;
  lineNumber: number;
  column: number;
  prefix: string;
  triggerChar?: string;
  isInMathMode: boolean;
  isInEnvironment?: string;
  documentContent: string;
  filePath?: string;
}

// ====== LRU Cache (using lru-cache library) ======
// Note: GhostText cache now uses CompletionCacheService

// ====== LaTeX Commands and Environment Definitions ======

const LATEX_COMMANDS: CompletionItem[] = [
  // Document structure
  {
    label: '\\documentclass',
    kind: 'command',
    insertText: '\\documentclass{${1:article}}',
    detail: '文档类',
  },
  {
    label: '\\usepackage',
    kind: 'command',
    insertText: '\\usepackage{${1:package}}',
    detail: '引用宏包',
  },
  { label: '\\title', kind: 'command', insertText: '\\title{${1:标题}}', detail: '文档标题' },
  { label: '\\author', kind: 'command', insertText: '\\author{${1:作者}}', detail: '作者' },
  { label: '\\date', kind: 'command', insertText: '\\date{${1:\\today}}', detail: '日期' },
  { label: '\\maketitle', kind: 'command', insertText: '\\maketitle', detail: '生成标题' },

  // Sections
  { label: '\\section', kind: 'command', insertText: '\\section{${1:标题}}', detail: '章节' },
  {
    label: '\\subsection',
    kind: 'command',
    insertText: '\\subsection{${1:标题}}',
    detail: '子章节',
  },
  {
    label: '\\subsubsection',
    kind: 'command',
    insertText: '\\subsubsection{${1:标题}}',
    detail: '子子章节',
  },
  { label: '\\paragraph', kind: 'command', insertText: '\\paragraph{${1:标题}}', detail: '段落' },
  { label: '\\chapter', kind: 'command', insertText: '\\chapter{${1:标题}}', detail: '章' },

  // References
  { label: '\\cite', kind: 'command', insertText: '\\cite{${1:key}}', detail: '引用文献' },
  { label: '\\ref', kind: 'command', insertText: '\\ref{${1:label}}', detail: '引用标签' },
  { label: '\\label', kind: 'command', insertText: '\\label{${1:name}}', detail: '设置标签' },
  { label: '\\pageref', kind: 'command', insertText: '\\pageref{${1:label}}', detail: '引用页码' },
  { label: '\\eqref', kind: 'command', insertText: '\\eqref{${1:label}}', detail: '引用公式' },

  // Formatting
  { label: '\\textbf', kind: 'command', insertText: '\\textbf{${1:text}}', detail: '粗体' },
  { label: '\\textit', kind: 'command', insertText: '\\textit{${1:text}}', detail: '斜体' },
  { label: '\\underline', kind: 'command', insertText: '\\underline{${1:text}}', detail: '下划线' },
  { label: '\\emph', kind: 'command', insertText: '\\emph{${1:text}}', detail: '强调' },

  // Figures and tables
  {
    label: '\\includegraphics',
    kind: 'command',
    insertText: '\\includegraphics[width=${1:0.8}\\textwidth]{${2:image}}',
    detail: '插入图片',
  },
  { label: '\\caption', kind: 'command', insertText: '\\caption{${1:标题}}', detail: '图表标题' },
  { label: '\\centering', kind: 'command', insertText: '\\centering', detail: '居中' },

  // File operations
  { label: '\\input', kind: 'command', insertText: '\\input{${1:file}}', detail: '引入文件' },
  { label: '\\include', kind: 'command', insertText: '\\include{${1:file}}', detail: '引入章节' },
  {
    label: '\\bibliography',
    kind: 'command',
    insertText: '\\bibliography{${1:refs}}',
    detail: '参考文献',
  },
  {
    label: '\\bibliographystyle',
    kind: 'command',
    insertText: '\\bibliographystyle{${1:plain}}',
    detail: '参考文献样式',
  },
];

const MATH_SYMBOLS: CompletionItem[] = [
  // Greek letters
  { label: '\\alpha', kind: 'math', insertText: '\\alpha', detail: 'α', previewHtml: 'α' },
  { label: '\\beta', kind: 'math', insertText: '\\beta', detail: 'β', previewHtml: 'β' },
  { label: '\\gamma', kind: 'math', insertText: '\\gamma', detail: 'γ', previewHtml: 'γ' },
  { label: '\\delta', kind: 'math', insertText: '\\delta', detail: 'δ', previewHtml: 'δ' },
  { label: '\\epsilon', kind: 'math', insertText: '\\epsilon', detail: 'ε', previewHtml: 'ε' },
  { label: '\\theta', kind: 'math', insertText: '\\theta', detail: 'θ', previewHtml: 'θ' },
  { label: '\\lambda', kind: 'math', insertText: '\\lambda', detail: 'λ', previewHtml: 'λ' },
  { label: '\\mu', kind: 'math', insertText: '\\mu', detail: 'μ', previewHtml: 'μ' },
  { label: '\\pi', kind: 'math', insertText: '\\pi', detail: 'π', previewHtml: 'π' },
  { label: '\\sigma', kind: 'math', insertText: '\\sigma', detail: 'σ', previewHtml: 'σ' },
  { label: '\\omega', kind: 'math', insertText: '\\omega', detail: 'ω', previewHtml: 'ω' },
  { label: '\\Gamma', kind: 'math', insertText: '\\Gamma', detail: 'Γ', previewHtml: 'Γ' },
  { label: '\\Delta', kind: 'math', insertText: '\\Delta', detail: 'Δ', previewHtml: 'Δ' },
  { label: '\\Omega', kind: 'math', insertText: '\\Omega', detail: 'Ω', previewHtml: 'Ω' },

  // ====== Operators ======
  {
    label: '\\sum',
    kind: 'math',
    insertText: '\\sum_{${1:i=1}}^{${2:n}}',
    detail: '∑',
    previewHtml: '∑',
  },
  {
    label: '\\prod',
    kind: 'math',
    insertText: '\\prod_{${1:i=1}}^{${2:n}}',
    detail: '∏',
    previewHtml: '∏',
  },
  {
    label: '\\int',
    kind: 'math',
    insertText: '\\int_{${1:a}}^{${2:b}}',
    detail: '∫',
    previewHtml: '∫',
  },
  {
    label: '\\frac',
    kind: 'math',
    insertText: '\\frac{${1:num}}{${2:den}}',
    detail: '分数',
    previewHtml: 'a/b',
  },
  { label: '\\sqrt', kind: 'math', insertText: '\\sqrt{${1:x}}', detail: '√', previewHtml: '√' },
  { label: '\\partial', kind: 'math', insertText: '\\partial', detail: '∂', previewHtml: '∂' },
  { label: '\\nabla', kind: 'math', insertText: '\\nabla', detail: '∇', previewHtml: '∇' },
  { label: '\\infty', kind: 'math', insertText: '\\infty', detail: '∞', previewHtml: '∞' },

  // ====== Relation Symbols ======
  { label: '\\leq', kind: 'math', insertText: '\\leq', detail: '≤', previewHtml: '≤' },
  { label: '\\geq', kind: 'math', insertText: '\\geq', detail: '≥', previewHtml: '≥' },
  { label: '\\neq', kind: 'math', insertText: '\\neq', detail: '≠', previewHtml: '≠' },
  { label: '\\approx', kind: 'math', insertText: '\\approx', detail: '≈', previewHtml: '≈' },
  { label: '\\equiv', kind: 'math', insertText: '\\equiv', detail: '≡', previewHtml: '≡' },
  { label: '\\in', kind: 'math', insertText: '\\in', detail: '∈', previewHtml: '∈' },
  { label: '\\subset', kind: 'math', insertText: '\\subset', detail: '⊂', previewHtml: '⊂' },
  { label: '\\subseteq', kind: 'math', insertText: '\\subseteq', detail: '⊆', previewHtml: '⊆' },

  // ====== Arrows ======
  {
    label: '\\rightarrow',
    kind: 'math',
    insertText: '\\rightarrow',
    detail: '→',
    previewHtml: '→',
  },
  { label: '\\leftarrow', kind: 'math', insertText: '\\leftarrow', detail: '←', previewHtml: '←' },
  {
    label: '\\Rightarrow',
    kind: 'math',
    insertText: '\\Rightarrow',
    detail: '⇒',
    previewHtml: '⇒',
  },
  {
    label: '\\Leftrightarrow',
    kind: 'math',
    insertText: '\\Leftrightarrow',
    detail: '⇔',
    previewHtml: '⇔',
  },

  // ====== Matrices and Vectors ======
  { label: '\\mathbf', kind: 'math', insertText: '\\mathbf{${1:x}}', detail: '粗体向量' },
  { label: '\\mathcal', kind: 'math', insertText: '\\mathcal{${1:X}}', detail: '花体' },
  { label: '\\mathbb', kind: 'math', insertText: '\\mathbb{${1:R}}', detail: '黑板粗体' },
  { label: '\\hat', kind: 'math', insertText: '\\hat{${1:x}}', detail: '帽子' },
  { label: '\\bar', kind: 'math', insertText: '\\bar{${1:x}}', detail: '横线' },
  { label: '\\vec', kind: 'math', insertText: '\\vec{${1:v}}', detail: '向量箭头' },
  { label: '\\dot', kind: 'math', insertText: '\\dot{${1:x}}', detail: '点' },
];

const ENVIRONMENTS: { [key: string]: string } = {
  equation: '\\begin{equation}\n\t${1}\n\\end{equation}',
  'equation*': '\\begin{equation*}\n\t${1}\n\\end{equation*}',
  align: '\\begin{align}\n\t${1} &= ${2} \\\\\\\\\n\\end{align}',
  'align*': '\\begin{align*}\n\t${1} &= ${2} \\\\\\\\\n\\end{align*}',
  figure:
    '\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=0.8\\textwidth]{${1:image}}\n\t\\caption{${2:Caption}}\n\t\\label{fig:${3:label}}\n\\end{figure}',
  table:
    '\\begin{table}[htbp]\n\t\\centering\n\t\\caption{${1:Caption}}\n\t\\label{tab:${2:label}}\n\t\\begin{tabular}{${3:ccc}}\n\t\t\\toprule\n\t\t${4:Header1} & ${5:Header2} & ${6:Header3} \\\\\\\\\n\t\t\\midrule\n\t\t${7:Data1} & ${8:Data2} & ${9:Data3} \\\\\\\\\n\t\t\\bottomrule\n\t\\end{tabular}\n\\end{table}',
  itemize: '\\begin{itemize}\n\t\\item ${1}\n\\end{itemize}',
  enumerate: '\\begin{enumerate}\n\t\\item ${1}\n\\end{enumerate}',
  description: '\\begin{description}\n\t\\item[${1:Term}] ${2:Description}\n\\end{description}',
  proof: '\\begin{proof}\n\t${1}\n\\end{proof}',
  theorem: '\\begin{theorem}\n\t${1}\n\\end{theorem}',
  lemma: '\\begin{lemma}\n\t${1}\n\\end{lemma}',
  definition: '\\begin{definition}\n\t${1}\n\\end{definition}',
  abstract: '\\begin{abstract}\n\t${1}\n\\end{abstract}',
  verbatim: '\\begin{verbatim}\n${1}\n\\end{verbatim}',
  lstlisting: '\\begin{lstlisting}[language=${1:Python}]\n${2}\n\\end{lstlisting}',
  tikzpicture: '\\begin{tikzpicture}\n\t${1}\n\\end{tikzpicture}',
  matrix: '\\begin{matrix}\n\t${1} & ${2} \\\\\\\\\n\t${3} & ${4}\n\\end{matrix}',
  pmatrix: '\\begin{pmatrix}\n\t${1} & ${2} \\\\\\\\\n\t${3} & ${4}\n\\end{pmatrix}',
  bmatrix: '\\begin{bmatrix}\n\t${1} & ${2} \\\\\\\\\n\t${3} & ${4}\n\\end{bmatrix}',
  cases:
    '\\begin{cases}\n\t${1} & \\text{if } ${2} \\\\\\\\\n\t${3} & \\text{otherwise}\n\\end{cases}',
};

// ====== Typst Commands and Snippet Definitions ======

const TYPST_COMMANDS: CompletionItem[] = [
  // Document settings
  { label: '#set', kind: 'command', insertText: '#set ${1:rule}(${2:args})', detail: '设置规则' },
  {
    label: '#show',
    kind: 'command',
    insertText: '#show ${1:selector}: ${2:replacement}',
    detail: '显示规则',
  },
  { label: '#let', kind: 'command', insertText: '#let ${1:name} = ${2:value}', detail: '定义变量' },
  {
    label: '#import',
    kind: 'command',
    insertText: '#import "${1:module}": ${2:items}',
    detail: '导入模块',
  },
  {
    label: '#include',
    kind: 'command',
    insertText: '#include "${1:file.typ}"',
    detail: '包含文件',
  },

  // Text formatting
  {
    label: '#text',
    kind: 'command',
    insertText: '#text(${1:size: 12pt})[${2:content}]',
    detail: '文本样式',
  },
  { label: '#strong', kind: 'command', insertText: '#strong[${1:text}]', detail: '加粗' },
  { label: '#emph', kind: 'command', insertText: '#emph[${1:text}]', detail: '强调/斜体' },
  { label: '#underline', kind: 'command', insertText: '#underline[${1:text}]', detail: '下划线' },
  { label: '#strike', kind: 'command', insertText: '#strike[${1:text}]', detail: '删除线' },
  { label: '#smallcaps', kind: 'command', insertText: '#smallcaps[${1:text}]', detail: '小型大写' },
  { label: '#raw', kind: 'command', insertText: '#raw("${1:code}")', detail: '原始文本/代码' },
  { label: '#link', kind: 'command', insertText: '#link("${1:url}")[${2:text}]', detail: '超链接' },

  // Page and layout
  {
    label: '#page',
    kind: 'command',
    insertText: '#page(${1:paper: "a4"})[${2:content}]',
    detail: '页面设置',
  },
  { label: '#pagebreak', kind: 'command', insertText: '#pagebreak()', detail: '分页' },
  {
    label: '#align',
    kind: 'command',
    insertText: '#align(${1:center})[${2:content}]',
    detail: '对齐',
  },
  {
    label: '#box',
    kind: 'command',
    insertText: '#box(${1:width: 100%})[${2:content}]',
    detail: '盒子',
  },
  { label: '#block', kind: 'command', insertText: '#block[${1:content}]', detail: '块元素' },
  {
    label: '#grid',
    kind: 'command',
    insertText: '#grid(columns: ${1:2}, gutter: ${2:10pt})[${3:content}]',
    detail: '网格布局',
  },
  {
    label: '#stack',
    kind: 'command',
    insertText: '#stack(dir: ${1:ltr}, spacing: ${2:10pt})[${3:content}]',
    detail: '堆叠布局',
  },

  // Images and figures
  {
    label: '#image',
    kind: 'command',
    insertText: '#image("${1:path}", width: ${2:80%})',
    detail: '插入图片',
  },
  {
    label: '#figure',
    kind: 'command',
    insertText: '#figure(\n  ${1:content},\n  caption: [${2:caption}]\n) <${3:label}>',
    detail: '图表',
  },
  {
    label: '#table',
    kind: 'command',
    insertText:
      '#table(\n  columns: ${1:3},\n  [${2:Header 1}], [${3:Header 2}], [${4:Header 3}],\n  [${5:Data 1}], [${6:Data 2}], [${7:Data 3}]\n)',
    detail: '表格',
  },

  // Lists
  {
    label: '#list',
    kind: 'command',
    insertText: '#list(\n  [${1:Item 1}],\n  [${2:Item 2}]\n)',
    detail: '无序列表',
  },
  {
    label: '#enum',
    kind: 'command',
    insertText: '#enum(\n  [${1:Item 1}],\n  [${2:Item 2}]\n)',
    detail: '有序列表',
  },
  {
    label: '#terms',
    kind: 'command',
    insertText: '#terms(\n  [${1:Term}], [${2:Definition}]\n)',
    detail: '术语列表',
  },

  // References
  { label: '#cite', kind: 'command', insertText: '#cite(<${1:key}>)', detail: '引用文献' },
  { label: '#ref', kind: 'command', insertText: '#ref(<${1:label}>)', detail: '引用标签' },
  {
    label: '#bibliography',
    kind: 'command',
    insertText: '#bibliography("${1:refs.bib}")',
    detail: '参考文献',
  },

  // Math
  { label: '#math.equation', kind: 'command', insertText: '$ ${1:formula} $', detail: '数学公式' },

  // Conditionals and loops
  {
    label: '#if',
    kind: 'command',
    insertText: '#if ${1:condition} {\n  ${2:content}\n}',
    detail: '条件语句',
  },
  {
    label: '#for',
    kind: 'command',
    insertText: '#for ${1:item} in ${2:collection} {\n  ${3:content}\n}',
    detail: '循环语句',
  },
  {
    label: '#while',
    kind: 'command',
    insertText: '#while ${1:condition} {\n  ${2:content}\n}',
    detail: 'While 循环',
  },
];

const TYPST_MATH_SYMBOLS: CompletionItem[] = [
  // Greek letters (Typst uses names directly)
  { label: 'alpha', kind: 'math', insertText: 'alpha', detail: 'α', previewHtml: 'α' },
  { label: 'beta', kind: 'math', insertText: 'beta', detail: 'β', previewHtml: 'β' },
  { label: 'gamma', kind: 'math', insertText: 'gamma', detail: 'γ', previewHtml: 'γ' },
  { label: 'delta', kind: 'math', insertText: 'delta', detail: 'δ', previewHtml: 'δ' },
  { label: 'epsilon', kind: 'math', insertText: 'epsilon', detail: 'ε', previewHtml: 'ε' },
  { label: 'theta', kind: 'math', insertText: 'theta', detail: 'θ', previewHtml: 'θ' },
  { label: 'lambda', kind: 'math', insertText: 'lambda', detail: 'λ', previewHtml: 'λ' },
  { label: 'mu', kind: 'math', insertText: 'mu', detail: 'μ', previewHtml: 'μ' },
  { label: 'pi', kind: 'math', insertText: 'pi', detail: 'π', previewHtml: 'π' },
  { label: 'sigma', kind: 'math', insertText: 'sigma', detail: 'σ', previewHtml: 'σ' },
  { label: 'omega', kind: 'math', insertText: 'omega', detail: 'ω', previewHtml: 'ω' },
  { label: 'Gamma', kind: 'math', insertText: 'Gamma', detail: 'Γ', previewHtml: 'Γ' },
  { label: 'Delta', kind: 'math', insertText: 'Delta', detail: 'Δ', previewHtml: 'Δ' },
  { label: 'Omega', kind: 'math', insertText: 'Omega', detail: 'Ω', previewHtml: 'Ω' },

  // Operators
  {
    label: 'sum',
    kind: 'math',
    insertText: 'sum_(${1:i=1})^(${2:n})',
    detail: '∑',
    previewHtml: '∑',
  },
  {
    label: 'prod',
    kind: 'math',
    insertText: 'prod_(${1:i=1})^(${2:n})',
    detail: '∏',
    previewHtml: '∏',
  },
  {
    label: 'integral',
    kind: 'math',
    insertText: 'integral_(${1:a})^(${2:b})',
    detail: '∫',
    previewHtml: '∫',
  },
  {
    label: 'frac',
    kind: 'math',
    insertText: 'frac(${1:num}, ${2:den})',
    detail: '分数',
    previewHtml: 'a/b',
  },
  { label: 'sqrt', kind: 'math', insertText: 'sqrt(${1:x})', detail: '√', previewHtml: '√' },
  { label: 'partial', kind: 'math', insertText: 'partial', detail: '∂', previewHtml: '∂' },
  { label: 'nabla', kind: 'math', insertText: 'nabla', detail: '∇', previewHtml: '∇' },
  { label: 'infinity', kind: 'math', insertText: 'infinity', detail: '∞', previewHtml: '∞' },

  // Relation symbols
  { label: 'lt.eq', kind: 'math', insertText: 'lt.eq', detail: '≤', previewHtml: '≤' },
  { label: 'gt.eq', kind: 'math', insertText: 'gt.eq', detail: '≥', previewHtml: '≥' },
  { label: 'eq.not', kind: 'math', insertText: 'eq.not', detail: '≠', previewHtml: '≠' },
  { label: 'approx', kind: 'math', insertText: 'approx', detail: '≈', previewHtml: '≈' },
  { label: 'equiv', kind: 'math', insertText: 'equiv', detail: '≡', previewHtml: '≡' },
  { label: 'in', kind: 'math', insertText: 'in', detail: '∈', previewHtml: '∈' },
  { label: 'subset', kind: 'math', insertText: 'subset', detail: '⊂', previewHtml: '⊂' },
  { label: 'subset.eq', kind: 'math', insertText: 'subset.eq', detail: '⊆', previewHtml: '⊆' },

  // Arrows
  { label: 'arrow.r', kind: 'math', insertText: 'arrow.r', detail: '→', previewHtml: '→' },
  { label: 'arrow.l', kind: 'math', insertText: 'arrow.l', detail: '←', previewHtml: '←' },
  {
    label: 'arrow.r.double',
    kind: 'math',
    insertText: 'arrow.r.double',
    detail: '⇒',
    previewHtml: '⇒',
  },
  {
    label: 'arrow.l.r.double',
    kind: 'math',
    insertText: 'arrow.l.r.double',
    detail: '⇔',
    previewHtml: '⇔',
  },

  // Matrices
  {
    label: 'mat',
    kind: 'math',
    insertText: 'mat(\n  ${1:a}, ${2:b};\n  ${3:c}, ${4:d}\n)',
    detail: '矩阵',
  },
  { label: 'vec', kind: 'math', insertText: 'vec(${1:x}, ${2:y})', detail: '向量' },
  {
    label: 'cases',
    kind: 'math',
    insertText: 'cases(\n  ${1:condition1} &"if" ${2:case1},\n  ${3:otherwise} &"otherwise"\n)',
    detail: '分段函数',
  },
];

// ====== Completion Manager ======

export class CompletionManager {
  private indexer: LatexIndexer;
  private pendingRequest: AbortController | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lspAvailable: boolean | null = null;

  constructor() {
    this.indexer = new LatexIndexer();
  }

  getIndexer(): LatexIndexer {
    return this.indexer;
  }

  /**
   * Check if LSP is available
   */
  async isLSPAvailable(): Promise<boolean> {
    if (this.lspAvailable !== null) return this.lspAvailable;
    this.lspAvailable = LSPService.isRunning();
    return this.lspAvailable;
  }

  /**
   * Reset LSP availability status (called when LSP state changes)
   */
  resetLSPStatus(): void {
    this.lspAvailable = null;
  }

  // ====== Layer 1: Deterministic Completion ======

  /**
   * Get command completions (prefer LSP, fallback to static completions)
   * @throws {Error} When LSP request fails
   */
  async getCommandCompletionsAsync(
    prefix: string,
    isInMathMode: boolean,
    filePath?: string,
    line?: number,
    column?: number,
    language = 'latex'
  ): Promise<CompletionItem[]> {
    const lspRunning = LSPService.isRunning();

    if (filePath && line !== undefined && column !== undefined && lspRunning) {
      try {
        // Only flush when there are pending updates to avoid unnecessary async calls
        if (LSPService.hasPendingIncrementalUpdates(filePath)) {
          await LSPService.flushIncrementalUpdates(filePath);
        }

        const lspItems = await LSPService.getCompletions(filePath, { lineNumber: line, column });

        // Check if LSP returned command completions
        // TexLab/Tinymist return command completions without \ or # prefix
        const firstLabel = lspItems?.[0]?.label;
        // Monaco CompletionItem.label can be string or { label: string } object
        const firstLabelStr =
          typeof firstLabel === 'string'
            ? firstLabel
            : (firstLabel as { label?: string } | undefined)?.label || '';

        // Check if it's a snippet trigger character (single non-letter character)
        const isSnippetTrigger = firstLabelStr.length === 1 && !/[a-zA-Z]/.test(firstLabelStr);

        const commandPrefix = language === 'typst' ? '#' : '\\';
        if (isSnippetTrigger && prefix.startsWith(commandPrefix)) {
          return this.getCommandCompletions(prefix, isInMathMode, language);
        }

        if (lspItems && lspItems.length > 0) {
          // Convert LSP completion items to internal format
          const items: CompletionItem[] = lspItems.map((item) => {
            const rawLabel = typeof item.label === 'string' ? item.label : item.label.label;
            // Handle label prefix
            let label = rawLabel;
            if (language === 'typst') {
              // Typst: Add # prefix if label doesn't start with # but prefix does
              if (!rawLabel.startsWith('#') && prefix.startsWith('#')) {
                label = `#${rawLabel}`;
              }
            } else {
              // LaTeX: Add \ prefix if label doesn't start with \ but prefix does
              if (!rawLabel.startsWith('\\') && prefix.startsWith('\\')) {
                label = `\\${rawLabel}`;
              }
            }
            const insertText = item.insertText || rawLabel;

            return {
              label,
              kind: this.lspKindToInternal(item.kind),
              insertText,
              detail: item.detail ? `${item.detail} [LSP]` : '[LSP]',
              documentation:
                typeof item.documentation === 'string'
                  ? item.documentation
                  : item.documentation?.value,
              sortText: item.sortText,
              filterText: item.filterText || rawLabel,
              source: 'lsp',
            };
          });
          return items;
        }
      } catch {
        return this.getCommandCompletions(prefix, isInMathMode, language);
      }
    }

    // Fallback to static completions
    return this.getCommandCompletions(prefix, isInMathMode, language);
  }

  /**
   * Convert LSP CompletionItemKind to internal type
   */
  private lspKindToInternal(kind?: number): CompletionItem['kind'] {
    // Monaco/LSP CompletionItemKind:
    // 1=Text, 2=Method, 3=Function, 4=Constructor, 5=Field,
    // 6=Variable, 7=Class, 8=Interface, 9=Module, 10=Property,
    // 11=Unit, 12=Value, 13=Enum, 14=Keyword, 15=Snippet,
    // 16=Color, 17=File, 18=Reference, 19=Folder, 20=EnumMember,
    // 21=Constant, 22=Struct, 23=Event, 24=Operator, 25=TypeParameter
    switch (kind) {
      case 3: // Function
      case 2: // Method
        return 'command';
      case 15: // Snippet
        return 'snippet';
      case 17: // File
        return 'file';
      case 18: // Reference
        return 'label';
      case 14: // Keyword
        return 'command';
      default:
        return 'command';
    }
  }

  /**
   * Get command completions (synchronous version, static completions only)
   * @param prefix Prefix to match
   * @param isInMathMode Whether in math mode
   * @param language Language type: 'latex' | 'typst'
   */
  getCommandCompletions(
    prefix: string,
    isInMathMode: boolean,
    language = 'latex'
  ): CompletionItem[] {
    const items: CompletionItem[] = [];
    const searchPrefix = prefix.toLowerCase();

    if (language === 'typst') {
      // Typst command completions
      for (const cmd of TYPST_COMMANDS) {
        if (
          cmd.label.toLowerCase().startsWith(searchPrefix) ||
          cmd.label.toLowerCase().includes(searchPrefix)
        ) {
          items.push(cmd);
        }
      }

      // Typst math mode
      if (isInMathMode) {
        for (const sym of TYPST_MATH_SYMBOLS) {
          if (sym.label.toLowerCase().startsWith(searchPrefix)) {
            items.push(sym);
          }
        }
      }
    } else {
      // LaTeX command completions
      for (const cmd of LATEX_COMMANDS) {
        if (cmd.label.toLowerCase().startsWith(searchPrefix)) {
          items.push(cmd);
        }
      }

      // LaTeX math mode
      if (isInMathMode || prefix.startsWith('\\')) {
        for (const sym of MATH_SYMBOLS) {
          if (sym.label.toLowerCase().startsWith(searchPrefix)) {
            items.push(sym);
          }
        }
      }
    }

    return items;
  }

  /**
   * Get environment completions (auto-close)
   */
  getEnvironmentCompletions(prefix: string): CompletionItem[] {
    const items: CompletionItem[] = [];
    const searchPrefix = prefix.toLowerCase();

    for (const [name, template] of Object.entries(ENVIRONMENTS)) {
      if (name.toLowerCase().startsWith(searchPrefix)) {
        items.push({
          label: name,
          kind: 'environment',
          insertText: template,
          detail: `\\begin{${name}}...\\end{${name}}`,
          documentation: `Create ${name} environment`,
        });
      }
    }

    return items;
  }

  /**
   * Get label completions (\ref)
   */
  getLabelCompletions(prefix: string, labelPrefix?: string): CompletionItem[] {
    const labels = this.indexer.getLabels();
    const items: CompletionItem[] = [];
    const searchPrefix = prefix.toLowerCase();

    for (const label of labels) {
      // Filter by type prefix (e.g., fig:, tab:, eq:)
      if (labelPrefix && !label.name.startsWith(labelPrefix)) {
        continue;
      }

      if (label.name.toLowerCase().includes(searchPrefix)) {
        items.push({
          label: label.name,
          kind: 'label',
          insertText: label.name,
          detail: `${label.type} - Line ${label.line}`,
          documentation: label.context,
          source: label.file,
        });
      }
    }

    return items;
  }

  /**
   * Get citation completions (\cite)
   */
  getCitationCompletions(prefix: string): CompletionItem[] {
    const citations = this.indexer.getCitations();
    const items: CompletionItem[] = [];
    const searchPrefix = prefix.toLowerCase();

    for (const cite of citations) {
      // Support fuzzy search: author, year, title
      const matchText =
        `${cite.key} ${cite.author || ''} ${cite.year || ''} ${cite.title || ''}`.toLowerCase();

      if (matchText.includes(searchPrefix)) {
        items.push({
          label: cite.key,
          kind: 'citation',
          insertText: cite.key,
          detail: cite.author ? `${cite.author} (${cite.year || 'N/A'})` : cite.key,
          documentation: cite.title,
          bibKey: cite.key,
          source: cite.file,
          // Sort by citation count
          sortText: String(1000 - (cite.citedCount || 0)).padStart(4, '0') + cite.key,
        });
      }
    }

    // Sort by sort field
    items.sort((a, b) => (a.sortText || a.label).localeCompare(b.sortText || b.label));

    return items;
  }

  /**
   * Get file path completions
   */
  getFileCompletions(prefix: string, extensions: string[]): CompletionItem[] {
    const files = this.indexer.getFiles(extensions);
    const items: CompletionItem[] = [];
    const searchPrefix = prefix.toLowerCase();

    for (const file of files) {
      if (file.toLowerCase().includes(searchPrefix)) {
        items.push({
          label: file,
          kind: 'file',
          insertText: file,
          detail: 'File',
        });
      }
    }

    return items;
  }

  // ====== Layer 2: AI RAG Completion ======

  /**
   * Get AI Ghost Text suggestion
   */
  async getAICompletion(
    context: CompletionContext,
    knowledgeBaseId?: string,
    signal?: AbortSignal
  ): Promise<GhostTextSuggestion | null> {
    // Check cache - using new LRU cache service
    // Note: If knowledge base is used, include knowledge base ID in cache key
    const cacheKey = knowledgeBaseId ? `${context.prefix}__kb:${knowledgeBaseId}` : context.prefix;
    const cachedText = CompletionCacheService.get(cacheKey, context.lineContent);
    if (cachedText) {
      const cached: GhostTextSuggestion = { text: cachedText };
      // Check if prefix matches (Levenshtein distance < 3)
      if (this.canReuseCache(context.prefix, cached.text)) {
        return this.adjustCachedResult(cached, context.prefix);
      }
    }

    try {
      // Build RAG context
      let ragContext = '';
      const bibKeys: string[] = [];

      if (knowledgeBaseId) {
        try {
          const searchResult = await api.knowledge.search({
            query: context.lineContent,
            libraryIds: [knowledgeBaseId],
            topK: 3,
            scoreThreshold: 0.3,
          });

          if (searchResult?.results && searchResult.results.length > 0) {
            ragContext = searchResult.results
              .map((r) => {
                const metadata = r.metadata as Record<string, unknown> | undefined;
                const bibKey = metadata?.bib_key;
                if (bibKey && typeof bibKey === 'string') {
                  bibKeys.push(bibKey);
                }
                const source = r.filename || 'unknown';
                return `[Source: ${source}] ${r.content}`;
              })
              .join('\n\n');
          }
        } catch (e) {
          console.error('[Completion] RAG retrieval failed:', e);
        }
      }

      // Build prompt
      const systemPrompt = this.buildSystemPrompt(context, ragContext, bibKeys);

      // Build context text
      const contextText = this.buildContextText(context);

      // Call AI
      const completion = await AIService.getCompletion(
        `${contextText}\n\n[System Prompt]: ${systemPrompt}`
      );

      if (!completion || signal?.aborted) {
        return null;
      }

      // Post-process (sanitize)
      const cleanedText = this.sanitizeCompletion(completion, context);

      const result: GhostTextSuggestion = {
        text: cleanedText,
        bibKeys: bibKeys.length > 0 ? bibKeys : undefined,
        source: bibKeys.length > 0 ? 'Knowledge Base' : undefined,
      };

      // Cache result - using new LRU cache service
      // Use same cache key as read (includes knowledge base ID)
      CompletionCacheService.set(cacheKey, cleanedText, context.lineContent);

      return result;
    } catch (error) {
      console.error('[Completion] AI completion failed:', error);
      return null;
    }
  }

  /**
   * Build context text (for AI completion)
   */
  private buildContextText(context: CompletionContext): string {
    const lines = context.documentContent.split('\n');
    const startLine = Math.max(0, context.lineNumber - 10);
    const endLine = Math.min(lines.length, context.lineNumber + 5);

    const relevantLines = lines.slice(startLine, endLine);
    const currentLineIndex = context.lineNumber - 1 - startLine;

    // Mark cursor position on current line
    if (currentLineIndex >= 0 && currentLineIndex < relevantLines.length) {
      const line = relevantLines[currentLineIndex];
      relevantLines[currentLineIndex] =
        `${line.slice(0, context.column - 1)}█${line.slice(context.column - 1)}`;
    }

    return relevantLines.join('\n');
  }

  /**
   * Build system prompt
   */
  private buildSystemPrompt(
    context: CompletionContext,
    ragContext: string,
    bibKeys: string[]
  ): string {
    // Detect file type
    const isTypst = context.filePath?.endsWith('.typ');
    const formatName = isTypst ? 'Typst' : 'LaTeX';

    let prompt = `You are an academic writing assistant for ${formatName} documents.
Your task is to complete the text naturally and academically.

IMPORTANT RULES:
1. Output ONLY the completion text, no explanations
2. Do NOT include markdown code blocks
3. Keep the completion concise (1-2 sentences max)
4. Match the writing style of the document
5. Use correct ${formatName} syntax`;

    if (isTypst) {
      prompt +=
        '\n6. Typst uses: #function() for commands, = for headings, $math$ for formulas, @key for citations';
    } else {
      prompt +=
        '\n6. LaTeX uses: \\command{} for commands, \\section{} for headings, $math$ for formulas, \\cite{key} for citations';
    }

    if (context.isInMathMode) {
      const mathNote = isTypst
        ? 'You are in math mode. Use Typst math syntax.'
        : 'You are in math mode. Use standard LaTeX math notation.';
      prompt += `\n7. ${mathNote}`;
    }

    if (ragContext) {
      const citeCmd = isTypst ? `@${bibKeys[0] || 'key'}` : `\\cite{${bibKeys[0] || 'key'}}`;
      prompt += `\n\nContext from Knowledge Base:
${ragContext}

If you use information from the context, YOU MUST append the citation command like ${citeCmd}.`;
    }

    return prompt;
  }

  /**
   * Sanitize AI output (reference Void)
   */
  private sanitizeCompletion(text: string, context: CompletionContext): string {
    let result = text;

    // 1. Remove Markdown code blocks
    result = result.replace(/```latex\n?/g, '').replace(/```\n?/g, '');

    // 2. Remove cursor placeholders (█ and similar characters)
    result = result.replace(/[█▌▐▀▄■□▪▫●○◆◇]/g, '');

    // 3. Remove leading newlines
    result = result.replace(/^\n+/, '');

    // 4. Check for duplication with following text
    const afterCursor = context.documentContent.slice(
      context.documentContent.indexOf(context.lineContent) + context.column
    );

    // If AI generated \end{...} but same already exists in following text, remove it
    const endEnvMatch = result.match(/\\end\{([^}]+)\}/);
    if (endEnvMatch) {
      const envName = endEnvMatch[1];
      if (afterCursor.trimStart().startsWith(`\\end{${envName}}`)) {
        result = result.replace(`\\end{${envName}}`, '');
      }
    }

    // 5. Balance check: ensure brackets are paired
    result = this.balanceBrackets(result);

    // 6. Limit length
    const lines = result.split('\n');
    if (lines.length > 5) {
      result = lines.slice(0, 5).join('\n');
    }

    return result.trim();
  }

  /**
   * Balance brackets
   */
  private balanceBrackets(text: string): string {
    let result = text;

    const pairs = [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ];

    for (const [open, close] of pairs) {
      let count = 0;
      for (const char of result) {
        if (char === open) count++;
        else if (char === close) count--;
      }

      // Fill missing closing brackets
      while (count > 0) {
        result += close;
        count--;
      }
      // If too many closing brackets, try to fill at start (or delete directly)
      while (count < 0) {
        const idx = result.lastIndexOf(close);
        if (idx >= 0) {
          result = result.slice(0, idx) + result.slice(idx + 1);
        }
        count++;
      }
    }

    return result;
  }

  /**
   * Check if cache can be reused
   */
  private canReuseCache(newPrefix: string, cachedText: string): boolean {
    // Levenshtein distance < 3
    return this.levenshteinDistance(newPrefix, cachedText.slice(0, newPrefix.length)) < 3;
  }

  /**
   * Calculate Levenshtein distance
   */
  private levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * Adjust cached result based on new prefix
   */
  private adjustCachedResult(cached: GhostTextSuggestion, newPrefix: string): GhostTextSuggestion {
    // If cached text starts with new prefix, remove prefix part
    if (cached.text.startsWith(newPrefix)) {
      return {
        ...cached,
        text: cached.text.slice(newPrefix.length),
      };
    }
    return cached;
  }

  // ====== Trigger Strategy ======

  /**
   * Determine trigger type
   */
  getTriggerType(char: string, context: CompletionContext): 'instant' | 'debounced' | 'none' {
    // Instant trigger: \ or { character
    if (char === '\\' || char === '{') {
      return 'instant';
    }

    // Instant trigger inside command arguments
    if (context.prefix.startsWith('\\') && char !== ' ') {
      return 'instant';
    }

    // Natural language characters: debounced trigger
    if (/[a-zA-Z0-9\u4e00-\u9fa5]/.test(char)) {
      return 'debounced';
    }

    return 'none';
  }

  /**
   * Analyze context
   */
  analyzeContext(content: string, lineNumber: number, column: number): CompletionContext {
    const lines = content.split('\n');
    const lineContent = lines[lineNumber - 1] || '';
    const textBeforeCursor = lineContent.slice(0, column);

    // Detect math mode
    const isInMathMode = this.isInMathMode(content, lineNumber, column);

    // Detect current environment
    const currentEnv = this.detectCurrentEnvironment(content, lineNumber);

    // Extract prefix (currently typing command or text)
    const prefix = this.extractPrefix(textBeforeCursor);

    return {
      lineContent,
      lineNumber,
      column,
      prefix,
      isInMathMode,
      isInEnvironment: currentEnv,
      documentContent: content,
    };
  }

  /**
   * Detect if in math mode
   */
  private isInMathMode(content: string, line: number, column: number): boolean {
    const textBefore =
      content.split('\n').slice(0, line).join('\n') +
      content.split('\n')[line - 1]?.slice(0, column);

    // Detect $ ... $
    const dollarCount = (textBefore.match(/(?<!\\)\$/g) || []).length;
    if (dollarCount % 2 === 1) return true;

    // Detect \[ ... \]
    const displayMathStart = (textBefore.match(/\\\[/g) || []).length;
    const displayMathEnd = (textBefore.match(/\\\]/g) || []).length;
    if (displayMathStart > displayMathEnd) return true;

    // Detect math environments
    const mathEnvs = ['equation', 'align', 'gather', 'multline', 'eqnarray'];
    for (const env of mathEnvs) {
      const beginCount = (textBefore.match(new RegExp(`\\\\begin\\{${env}\\*?\\}`, 'g')) || [])
        .length;
      const endCount = (textBefore.match(new RegExp(`\\\\end\\{${env}\\*?\\}`, 'g')) || []).length;
      if (beginCount > endCount) return true;
    }

    return false;
  }

  /**
   * Detect current environment
   */
  private detectCurrentEnvironment(content: string, line: number): string | undefined {
    const lines = content.split('\n').slice(0, line);
    const envStack: string[] = [];

    for (const l of lines) {
      const beginMatch = l.match(/\\begin\{([^}]+)\}/g);
      const endMatch = l.match(/\\end\{([^}]+)\}/g);

      if (beginMatch) {
        for (const m of beginMatch) {
          const name = m.match(/\\begin\{([^}]+)\}/)?.[1];
          if (name) envStack.push(name);
        }
      }

      if (endMatch) {
        for (const m of endMatch) {
          const name = m.match(/\\end\{([^}]+)\}/)?.[1];
          if (name && envStack[envStack.length - 1] === name) {
            envStack.pop();
          }
        }
      }
    }

    return envStack[envStack.length - 1];
  }

  /**
   * Extract prefix
   */
  private extractPrefix(textBeforeCursor: string): string {
    // Match last command or word
    const match = textBeforeCursor.match(/(\\[a-zA-Z@]*|[a-zA-Z0-9\u4e00-\u9fa5]*)$/);
    return match ? match[1] : '';
  }

  /**
   * Cancel pending request
   */
  cancelPendingRequest(): void {
    if (this.pendingRequest) {
      this.pendingRequest.abort();
      this.pendingRequest = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    CompletionCacheService.clear();
  }
}

// Export singleton
export const completionManager = new CompletionManager();
