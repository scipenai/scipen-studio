/**
 * @file CiteHoverProvider —— Monaco hover provider,在 `\cite{key}` (LaTeX) /
 *   `@key` (Typst) / `[@key]` 的 `@key` 上(Markdown / pandoc) 渲染 Zotero
 *   悬停卡片。
 *
 * 不挂到 `LSPProviderRegistry`,因为 LSP backend 不知道 Zotero。Citation hover
 * 是纯 renderer-side concern,作为独立 provider 注册;Monaco 自动把多个 provider
 * 的 hover 合并成单个 stacked tooltip。
 *
 * key 提取 regex 与 `CitedKeyExtractor` 完全一致,确保"什么算 citation"在 hover
 * / 引用面板 / completion 三处零语义漂移。
 */

import type { Monaco } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import type { ZoteroItemDTO } from '../../../../../shared/types/zotero';
import { getZoteroBibMirror } from '../../services/zotero/ZoteroBibMirror';

const LANGUAGE_IDS = ['latex', 'typst', 'markdown'] as const;

const LATEX_CITE_REGEX = /\\cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
const TYPST_CITE_REGEX = /@([A-Za-z][\w-]{1,})/g;

let registered = false;

export function registerCiteHoverProviders(monacoInstance: Monaco): void {
  if (registered) return;
  registered = true;

  for (const languageId of LANGUAGE_IDS) {
    monacoInstance.languages.registerHoverProvider(languageId, {
      provideHover: (model: monaco.editor.ITextModel, position: monaco.Position) => {
        const key = findCitationKeyAt(model, position, languageId);
        if (!key) return null;
        const entry = lookupKey(key);
        if (!entry) return null;
        return {
          range: new monacoInstance.Range(
            position.lineNumber,
            position.column,
            position.lineNumber,
            position.column
          ),
          contents: buildHoverContents(entry),
        };
      },
    });
  }
}

function lookupKey(key: string): ZoteroItemDTO | undefined {
  const mirror = getZoteroBibMirror();
  return mirror.getByCitationKey(key) ?? mirror.getByItemKey(key);
}

function buildHoverContents(entry: ZoteroItemDTO): monaco.IMarkdownString[] {
  const lines: string[] = [];
  const keyLabel = entry.citationKey ?? entry.itemKey;
  if (entry.title) {
    lines.push(`**${escapeMarkdown(entry.title)}**`);
  }
  lines.push(`\`${escapeMarkdown(keyLabel)}\``);
  const meta = [entry.creatorsLabel, entry.year ? String(entry.year) : '']
    .filter(Boolean)
    .join(' · ');
  if (meta) lines.push(escapeMarkdown(meta));
  return [{ value: lines.join('  \n'), isTrusted: false }];
}

/**
 * 定位光标所在的 citation key —— 仅扫当前行,避免每次 hover 全文 regex 抖动。
 * 同时支持 LaTeX `\cite{}` 和 Typst `@key`;Markdown 走 LaTeX regex(pandoc
 * 风格 `[@key]` 内的 `@key` 还是会命中 Typst regex,体感无缝)。
 */
function findCitationKeyAt(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  languageId: (typeof LANGUAGE_IDS)[number]
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
 * 给一个 `\cite{a,b,c}` 匹配 + 光标列,返回光标所在的具体 key
 * (多 key 引用时 hover 跟着光标走)。光标在命令本身(braces 外)时返回 null。
 */
function extractKeyAt(match: RegExpExecArray, col: number): string | null {
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

function escapeMarkdown(s: string): string {
  return s.replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1');
}

/** 测试用导出。 */
export const _internal = {
  findCitationKeyAt,
  extractKeyAt,
  buildHoverContents,
};
