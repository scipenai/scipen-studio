/**
 * @file citationKeyScan —— 在编辑器某位置定位光标所在的 citation key(单行扫描)。
 *   hover 预览(CitePreviewService)、Ctrl+Click 跳转(editorSetup)共用,确保
 *   「什么算 citation」零语义漂移。key 提取 regex 与 `CitedKeyExtractor` 一致。
 */

import type * as monaco from 'monaco-editor';

const LATEX_CITE_REGEX = /\\cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
const TYPST_CITE_REGEX = /@([A-Za-z][\w-]{1,})/g;

/**
 * 定位光标所在的 citation key —— 仅扫当前行,避免每次 hover 全文 regex 抖动。
 * 同时支持 LaTeX `\cite{}` 和 Typst `@key`;Markdown 走 LaTeX 路径(pandoc 风格
 * `[@key]` 内的 `@key` 也会命中 Typst regex,体感无缝)。
 */
export function findCitationKeyAt(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  // string(非联合)以接受 model.getLanguageId();内部只对 'typst' 特判。
  languageId: string
): string | null {
  const line = model.getLineContent(position.lineNumber);
  const col = position.column - 1;

  if (languageId === 'typst') {
    return scanLine(line, col, TYPST_CITE_REGEX, (m) => m[1]);
  }
  const latexHit = scanLine(line, col, LATEX_CITE_REGEX, (m) => extractKeyAt(m, col));
  if (latexHit) return latexHit;
  return scanLine(line, col, TYPST_CITE_REGEX, (m) => m[1]);
}

function scanLine(
  line: string,
  col: number,
  regex: RegExp,
  pick: (m: RegExpExecArray) => string | null
): string | null {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (col >= match.index && col <= match.index + match[0].length) {
      const picked = pick(match);
      if (picked) return picked.trim();
    }
  }
  return null;
}

/**
 * 给一个 `\cite{a,b,c}` 匹配 + 光标列,返回光标所在的具体 key(多 key 引用时
 * hover 跟着光标走)。光标在命令本身(braces 外)时返回 null。
 */
export function extractKeyAt(match: RegExpExecArray, col: number): string | null {
  const matchStart = match.index;
  const matchText = match[0];
  const braceStart = matchStart + matchText.indexOf('{') + 1;
  const braceEnd = matchStart + matchText.lastIndexOf('}');
  if (col < braceStart || col > braceEnd) return null;
  const inside = match[1];
  let cursor = 0;
  for (const part of inside.split(',')) {
    const start = cursor;
    const end = cursor + part.length;
    if (col - braceStart >= start && col - braceStart <= end) {
      return part.trim();
    }
    cursor = end + 1;
  }
  return null;
}

/**
 * 反向:给定 citation key + 语言,返回应插入编辑器的引用文本。与上面的扫描
 * regex 同源(「什么算 cite」零漂移):latex `\cite{}` / typst `@key` /
 * markdown pandoc `[@key]`。未知语言退化为 latex `\cite{}`(最通用)。
 */
export function formatCitationInsert(citationKey: string, languageId: string): string {
  if (languageId === 'typst') return `@${citationKey}`;
  if (languageId === 'markdown') return `[@${citationKey}]`;
  return `\\cite{${citationKey}}`;
}

/** 测试用导出。 */
export const _internal = { findCitationKeyAt, extractKeyAt, formatCitationInsert };
