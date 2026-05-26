/**
 * @file CiteCompletionProvider —— Monaco completion provider,在
 *   `\cite{|}` / `[@|]` / `@|` 处弹文献候选。
 *
 * 与 `CiteHoverProvider` 共用 mirror 数据源,与 `CitedKeyExtractor` 共用 cite
 * regex 形态。三处保持语义一致:补全 / hover / 引用面板对"什么算 cite"零分歧。
 *
 * 候选数据来自 `ZoteroBibMirror.searchByQueryWithScore`(citation-key 前缀 →
 * token → substring fallback 三档评分)。空索引时返回空,不弹 wizard ——
 * completion 不应该用模态打扰用户;chat composer 的 `@cite:` 流是显式入口。
 */

import type { Monaco } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { getZoteroBibMirror } from '../../services/zotero/ZoteroBibMirror';

const LANGUAGE_IDS = ['latex', 'typst', 'markdown'] as const;
const MAX_SUGGESTIONS = 20;

/**
 * 光标前匹配触发位置:
 * - LaTeX `\cite[args]{a, b<cursor>` —— 抓 `\cite{...` 内尚未闭合 brace 的前缀
 * - Markdown `[@<cursor>` —— pandoc 风格
 * - Typst `@<cursor>` —— Typst 引用
 */
const LATEX_TRIGGER = /\\cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)$/;
const MD_TRIGGER = /\[@([^\]]*)$/;
const TYPST_TRIGGER = /@([A-Za-z][\w-]*)$/;

interface CompletionContext {
  /** 当前正在补全的 cite key 前缀。 */
  prefix: string;
  /** 替换范围的起始列(1-based,Monaco)。 */
  rangeStart: number;
}

let registered = false;

export function registerCiteCompletionProviders(monacoInstance: Monaco): void {
  if (registered) return;
  registered = true;

  for (const languageId of LANGUAGE_IDS) {
    monacoInstance.languages.registerCompletionItemProvider(languageId, {
      triggerCharacters: ['{', '@', ',', ' '],
      provideCompletionItems: (
        model: monaco.editor.ITextModel,
        position: monaco.Position
      ) => {
        const ctx = detectContext(model, position, languageId);
        if (!ctx) return { suggestions: [] };
        return buildSuggestions(monacoInstance, position, ctx);
      },
    });
  }
}

function detectContext(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  languageId: (typeof LANGUAGE_IDS)[number]
): CompletionContext | null {
  const linePrefix = model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });

  // LaTeX / Markdown 都可能用 \cite{...},先试 LaTeX。
  if (languageId !== 'typst') {
    const latex = LATEX_TRIGGER.exec(linePrefix);
    if (latex) return forCommaSeparated(latex, position.column);
    if (languageId === 'markdown') {
      const md = MD_TRIGGER.exec(linePrefix);
      if (md) {
        const prefix = md[1];
        return { prefix, rangeStart: position.column - prefix.length };
      }
    }
  }

  // Typst 也用 @key,markdown 里同样兼容 pandoc 风格 `@key`(不带方括号)。
  if (languageId === 'typst' || languageId === 'markdown') {
    const typst = TYPST_TRIGGER.exec(linePrefix);
    if (typst) {
      const prefix = typst[1];
      return { prefix, rangeStart: position.column - prefix.length };
    }
  }
  return null;
}

/**
 * `\cite{a, b, c<cursor>` 时,真正补全的 prefix 应是 `c`,而不是整段 `a, b, c`。
 * 把最后一个逗号之后的部分(再 trimStart 掉空格)当 prefix,起始 column 跟着算。
 */
function forCommaSeparated(match: RegExpExecArray, caretColumn: number): CompletionContext {
  const insideBrace = match[1];
  const lastCommaIdx = insideBrace.lastIndexOf(',');
  const segment = lastCommaIdx >= 0 ? insideBrace.slice(lastCommaIdx + 1) : insideBrace;
  const prefix = segment.trimStart();
  return { prefix, rangeStart: caretColumn - prefix.length };
}

function buildSuggestions(
  monacoInstance: Monaco,
  position: monaco.Position,
  ctx: CompletionContext
): monaco.languages.CompletionList {
  const mirror = getZoteroBibMirror();
  const hits = mirror.searchByQueryWithScore(ctx.prefix, MAX_SUGGESTIONS);
  if (hits.length === 0) return { suggestions: [] };

  const range = new monacoInstance.Range(
    position.lineNumber,
    ctx.rangeStart,
    position.lineNumber,
    position.column
  );

  const suggestions: monaco.languages.CompletionItem[] = hits.map((hit, idx) => {
    const item = hit.item;
    const key = item.citationKey ?? item.itemKey;
    const detail = [item.creatorsLabel, item.year ? String(item.year) : '']
      .filter(Boolean)
      .join(' · ');
    return {
      label: {
        label: key,
        description: item.title,
        detail: detail ? `  ${detail}` : undefined,
      },
      kind: monacoInstance.languages.CompletionItemKind.Reference,
      insertText: key,
      filterText: `${key} ${item.title ?? ''} ${item.creatorsLabel ?? ''}`,
      // sortText 强制按 mirror 评分顺序(用前缀 0-padded 序号,Monaco 字典序就稳)。
      sortText: String(idx).padStart(4, '0'),
      detail,
      documentation: item.title
        ? { value: `**${escapeMarkdown(item.title)}**`, isTrusted: false }
        : undefined,
      range,
    };
  });

  return { suggestions };
}

function escapeMarkdown(s: string): string {
  return s.replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1');
}

export const _internal = {
  detectContext,
  forCommaSeparated,
};
