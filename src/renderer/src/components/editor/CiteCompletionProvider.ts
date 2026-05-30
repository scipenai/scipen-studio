/**
 * @file CiteCompletionProvider —— Monaco completion provider,在
 *   `[@|]` / `@|` 处弹文献候选(markdown / typst)。
 *
 * **LaTeX 故意不挂** —— texlab 已经从 BibTexSyncService 自动同步的
 * `.scipen/zotero_library.bib` 里读出全部 entry 做 `\cite{}` completion,
 * 单一真相源 = .bib 文件;在 Monaco 上再挂一份会和 LSP 重复 + 重复 entry
 * 在 dropdown 里出现两次。markdown / typst 没有等价的 LSP cite 路径
 * (marksman 不做 cite,tinymist 要求显式 import),这里继续补位。
 *
 * 与 hover 预览共用 mirror 数据源,与 `citationKeyScan` / `CitedKeyExtractor`
 * 共用 cite regex 形态。三处对"什么算 cite"零分歧:补全 / hover / 引用面板。
 *
 * 候选数据来自 `ZoteroBibMirror.searchByQueryWithScore`(citation-key 前缀 →
 * token → substring fallback 三档评分)。空索引时返回空,不弹 wizard。
 */

import type { Monaco } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { getZoteroBibMirror } from '../../services/zotero/ZoteroBibMirror';
import type { BibSearchHit } from '../../services/zotero/bibSearchScoring';
import { getActiveRecommendationService } from '../../services/zotero/ActiveRecommendationService';
import { createLogger } from '../../services/LogService';

// 临时诊断日志(用于定位 typst .typ 打 @s 不弹文献的问题)。修完后整体移除,
// 风格对齐 d607e45 主动推荐链路日志:info 级走 batch flush 到 main.log,
// 关键决策点都打一条;脱敏只打长度 / 数量 / 状态,不打段落原文。
const diag = createLogger('CiteCompletion');

const LANGUAGE_IDS = ['typst', 'markdown'] as const;
const MAX_SUGGESTIONS = 20;

/**
 * citation-key 命中档与模糊档的分界阈值。bibSearchScoring 给 citation-key 命中的
 * 分是 `1000 + (精确?100:0) - keyLen`(精确≈1090、前缀≈990,均远高于此阈值);
 * token / substring 模糊档分 ≤ ~15。取 500 居中分界:≥500 = 用户在敲 key,
 * 保持键入序、语义分不参与(含前缀匹配);< 500 = 模糊找,才按段落语义分重排。
 */
const CK_PREFIX_TIER = 500;

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
  if (registered) {
    diag.info('register: skipped (already registered)');
    return;
  }
  registered = true;
  diag.info('register: ok', { languages: [...LANGUAGE_IDS] });

  for (const languageId of LANGUAGE_IDS) {
    monacoInstance.languages.registerCompletionItemProvider(languageId, {
      triggerCharacters: ['{', '@', ',', ' '],
      provideCompletionItems: (
        model: monaco.editor.ITextModel,
        position: monaco.Position
      ) => {
        const modelLang = model.getLanguageId();
        const ctx = detectContext(model, position, languageId);
        if (!ctx) {
          // 没命中任意 trigger —— 大概率是 typst 打了裸 @(TYPST_TRIGGER 要求 ≥1 字母)
          // 或当前 model 语言不是注册的语言(modelLang 与 languageId 不一致时只会从
          // languageId 这边触发,modelLang 是 plaintext 则 provider 根本不会被调到)
          const linePrefix = model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: Math.max(1, position.column - 16),
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          });
          diag.info('provide: no trigger', {
            languageId,
            modelLang,
            line: position.lineNumber,
            col: position.column,
            tail: linePrefix,
          });
          return { suggestions: [] };
        }
        diag.info('provide: trigger matched', {
          languageId,
          modelLang,
          prefixLen: ctx.prefix.length,
          prefix: ctx.prefix,
        });
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
  const libSize = mirror.getAllItems().length;
  // 键入热路径声明 'prefix-only' 意图(档 1 ck-prefix + 档 2 token-prefix)。
  // substring 兜底由 RecallMode 在召回端切除 —— 架构上不可能召回半库噪声。
  // 空 prefix 时 searchByQueryWithScore 对空查询返空,fallback 列全部文献。
  const hits: BibSearchHit[] =
    ctx.prefix.length === 0
      ? mirror.getAllItems().slice(0, MAX_SUGGESTIONS).map((item) => ({ item, score: 0 }))
      : mirror.searchByQueryWithScore(ctx.prefix, MAX_SUGGESTIONS, 'prefix-only');
  diag.info('build: hits', {
    libSize,
    prefixLen: ctx.prefix.length,
    hits: hits.length,
    top3: hits.slice(0, 3).map((h) => ({
      k: h.item.citationKey ?? h.item.itemKey,
      s: h.score,
    })),
  });
  if (hits.length === 0) return { suggestions: [] };

  const ordered = reorderBySemantic(hits);

  const range = new monacoInstance.Range(
    position.lineNumber,
    ctx.rangeStart,
    position.lineNumber,
    position.column
  );

  const suggestions: monaco.languages.CompletionItem[] = ordered.map((hit, idx) => {
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

/**
 * 按当前段落语义分对候选确定性分层重排(键入热路径,纯同步,零 IPC)。
 * 无缓存分(未开主动推荐 / 未 ready / 尚未嵌段)→ 原样返回,完全等同改动前。
 *
 * 分层(档间永不交叉):
 *  - Tier 0:citation-key 命中(score ≥ CK_PREFIX_TIER)—— 用户在敲 key,
 *    保持 mirror 原序,语义分不参与。
 *  - Tier 1:题名/作者词模糊命中 —— 同档内按段落语义分降序,无分项垫底,
 *    同分回落 mirror 原序。
 */
function reorderBySemantic(hits: BibSearchHit[]): BibSearchHit[] {
  const ranking = getActiveRecommendationService().getCitationRanking();
  if (!ranking) return hits;

  const sem = (h: BibSearchHit): number | undefined => {
    const ck = h.item.citationKey;
    return ck ? ranking.get(ck) : undefined;
  };
  return hits
    .map((h, i) => ({ h, i }))
    .sort((a, b) => {
      const ta = a.h.score >= CK_PREFIX_TIER ? 0 : 1;
      const tb = b.h.score >= CK_PREFIX_TIER ? 0 : 1;
      if (ta !== tb) return ta - tb; // Tier0 恒先于 Tier1
      if (ta === 0) return a.i - b.i; // Tier0 内:保持 mirror 原序
      const sa = sem(a.h);
      const sb = sem(b.h);
      if (sa !== undefined && sb !== undefined && sa !== sb) return sb - sa; // 语义降序
      if (sa !== undefined && sb === undefined) return -1; // 有分先于无分
      if (sa === undefined && sb !== undefined) return 1;
      return a.i - b.i; // 都无分 / 同分:原序
    })
    .map((x) => x.h);
}

export const _internal = {
  detectContext,
  forCommaSeparated,
  reorderBySemantic,
};
