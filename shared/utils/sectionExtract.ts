/**
 * @file sectionExtract.ts —— 从编辑器文档中抽取「光标当前段落 / 章节」的纯函数。
 *
 * 用于 M3 主动文献推荐:renderer 在 debounce 后取出光标所在段落文本,发给
 * main 做 embedding 查询。**纯函数、无 monaco 依赖**(接收 `lines: string[]` +
 * 1-based `cursorLine`),便于单测,且 main / renderer 共用 hash。
 *
 * 段落边界 = 空行 / 章节标题(heading)/ 文件首尾。heading 语法按语言区分。
 */

import type { DocLang } from '../types/zotero-embedding';

/** 段落抽取结果。startLine / endLine 为 1-based 闭区间,便于调试定位。 */
export interface ExtractedContext {
  text: string;
  startLine: number;
  endLine: number;
}

/** 默认段落文本上限(字符)。摘要级 embedding 不需要整章,头部信息密度最高。 */
const DEFAULT_MAX_CHARS = 1500;
/** 低于此长度视为「光标在空段」,逐级回退到更大上下文。 */
const MIN_MEANINGFUL_CHARS = 30;
/** 空段回退时取光标上下各 N 行。 */
const FALLBACK_RADIUS = 10;

/** 各语言的章节标题正则(命中即为段落硬边界,且 heading 行本身归入下方段落)。 */
const HEADING_PATTERNS: Record<DocLang, RegExp | null> = {
  latex: /^\s*\\(?:part|chapter|sub){0,2}section\*?\s*\{/,
  markdown: /^\s*#{1,6}\s/,
  typst: /^\s*=+\s/,
  unknown: null,
};

/** 行首注释前缀(剥除以免污染语义),按语言。 */
const LINE_COMMENT: Record<DocLang, RegExp | null> = {
  latex: /^\s*%/,
  markdown: /^\s*<!--/,
  typst: /^\s*\/\//,
  unknown: null,
};

/** 按文件扩展名或 monaco languageId 判定文档语言。 */
export function detectDocLang(filePathOrLangId: string): DocLang {
  const s = filePathOrLangId.toLowerCase();
  if (s === 'latex' || s.endsWith('.tex') || s.endsWith('.ltx')) return 'latex';
  if (s === 'typst' || s.endsWith('.typ')) return 'typst';
  if (s === 'markdown' || s.endsWith('.md') || s.endsWith('.markdown')) return 'markdown';
  return 'unknown';
}

function isBlank(line: string): boolean {
  return /^\s*$/.test(line);
}

function isHeading(line: string, lang: DocLang): boolean {
  const re = HEADING_PATTERNS[lang];
  return re !== null && re.test(line);
}

function isLineComment(line: string, lang: DocLang): boolean {
  const re = LINE_COMMENT[lang];
  return re !== null && re.test(line);
}

/**
 * 在 [from, to] 行范围内拼接正文(剥行首注释),返回 trim 后的文本。
 * 行号 1-based 闭区间;越界自动夹取。
 */
function joinLines(lines: string[], from: number, to: number, lang: DocLang): string {
  const lo = Math.max(1, from);
  const hi = Math.min(lines.length, to);
  const out: string[] = [];
  for (let i = lo; i <= hi; i++) {
    const line = lines[i - 1];
    if (isLineComment(line, lang)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** 头部截断(保留信息密度最高的开头),超出加省略标记。 */
function clampHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)} …`;
}

/**
 * 抽取光标所在段落 / 章节文本。
 *
 * 算法:
 *  1. 从 cursorLine 向上扫到空行 / heading / 文件头 → 上界(heading 行含入)。
 *  2. 从 cursorLine 向下扫到空行 / 下一 heading / 文件尾 → 下界。
 *  3. 结果过短(光标在空段)→ 回退到「当前 heading 到下一 heading」整章;
 *     仍过短 → 回退到光标 ±FALLBACK_RADIUS 行。
 *  4. 头部截断到 maxChars。
 */
export function extractParagraphContext(
  lines: string[],
  cursorLine: number,
  lang: DocLang,
  maxChars: number = DEFAULT_MAX_CHARS
): ExtractedContext {
  if (lines.length === 0) return { text: '', startLine: 0, endLine: 0 };
  const cursor = Math.min(Math.max(1, cursorLine), lines.length);

  // 上界:当前行是 heading → 它即段落顶(含入);否则向上扫到「上一行为空行 /
  // heading」为止(那一行是边界,不含入)。
  let start = cursor;
  while (start > 1) {
    if (isHeading(lines[start - 1], lang)) break; // 光标行/已上移到 heading → 顶
    const above = lines[start - 2];
    if (isBlank(above) || isHeading(above, lang)) break;
    start--;
  }
  // 下界:遇空行 / 下一 heading 停(那一行不含入)。
  let end = cursor;
  while (end < lines.length) {
    const next = lines[end]; // end 的下一行(0-based）
    if (isBlank(next) || isHeading(next, lang)) break;
    end++;
  }

  let text = clampHead(joinLines(lines, start, end, lang), maxChars);
  if (text.length >= MIN_MEANINGFUL_CHARS) {
    return { text, startLine: start, endLine: end };
  }

  // 回退 1:当前 heading 到下一 heading 的整章。
  const chapter = extractEnclosingSection(lines, cursor, lang);
  if (chapter) {
    text = clampHead(joinLines(lines, chapter.startLine, chapter.endLine, lang), maxChars);
    if (text.length >= MIN_MEANINGFUL_CHARS) {
      return { text, startLine: chapter.startLine, endLine: chapter.endLine };
    }
  }

  // 回退 2:光标 ±FALLBACK_RADIUS 行。
  const fStart = Math.max(1, cursor - FALLBACK_RADIUS);
  const fEnd = Math.min(lines.length, cursor + FALLBACK_RADIUS);
  text = clampHead(joinLines(lines, fStart, fEnd, lang), maxChars);
  return { text, startLine: fStart, endLine: fEnd };
}

/** 找光标所在「章节」范围:上一个 heading(含)到下一个 heading(不含)。 */
function extractEnclosingSection(
  lines: string[],
  cursor: number,
  lang: DocLang
): { startLine: number; endLine: number } | null {
  if (HEADING_PATTERNS[lang] === null) return null;
  let start = cursor;
  while (start > 1 && !isHeading(lines[start - 1], lang)) start--;
  let end = cursor;
  while (end < lines.length && !isHeading(lines[end], lang)) end++;
  return { startLine: start, endLine: end };
}

/**
 * 轻量同步字符串 hash(djb2)。用于:
 *   - renderer 段落守卫(文本没变不发查询)
 *   - main embedding 缓存的 abstractHash(摘要变则重 embed)
 * 返回 8 位 hex。非加密用途,只需稳定 + 低碰撞。
 */
export function hashParagraph(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0; // h * 33 + c,强制 32 位
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
