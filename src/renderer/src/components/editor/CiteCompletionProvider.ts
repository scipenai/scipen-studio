/**
 * @file CiteCompletionProvider — Monaco completion provider that surfaces
 *   reference candidates at `[@|]` / `@|` positions (markdown / typst).
 *
 * **LaTeX is intentionally not wired up** — texlab already reads every entry
 * from `.scipen/zotero_library.bib` (auto-maintained by BibTexSyncService)
 * for `\cite{}` completion. Single source of truth = the .bib file; adding
 * another provider in Monaco would duplicate LSP results and show every
 * entry twice in the dropdown. markdown / typst have no equivalent LSP cite
 * path (marksman does not do cite, tinymist requires explicit import), so
 * this provider fills the gap.
 *
 * Shares the mirror data source with hover preview, and shares the cite regex
 * shape with `citationKeyScan` / `CitedKeyExtractor`. The three usage sites
 * (completion / hover / cited-refs panel) agree exactly on "what counts as a
 * cite".
 *
 * Candidate data comes from `ZoteroBibMirror.searchByQueryWithScore`
 * (three-tier: citation-key prefix → token → substring fallback). Empty
 * index returns empty; we never pop the wizard from here.
 */

import type { Monaco } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { getZoteroBibMirror } from '../../services/zotero/ZoteroBibMirror';
import type { BibSearchHit } from '../../services/zotero/bibSearchScoring';
import { getActiveRecommendationService } from '../../services/zotero/ActiveRecommendationService';

const LANGUAGE_IDS = ['typst', 'markdown'] as const;
const MAX_SUGGESTIONS = 20;

/**
 * Boundary between the citation-key hit tier and the fuzzy tier.
 * bibSearchScoring assigns ck hits `1000 + (exact?100:0) - keyLen`
 * (exact≈1090, prefix≈990 — both far above this threshold);
 * token / substring fuzzy hits score ≤ ~15. 500 sits comfortably in the
 * middle: ≥500 = user is typing a key, preserve typing order and skip
 * semantic ranking (covers prefix matches); < 500 = fuzzy lookup, apply
 * paragraph-semantic re-ranking.
 */
const CK_PREFIX_TIER = 500;

/**
 * Pre-caret trigger patterns:
 * - LaTeX `\cite[args]{a, b<cursor>` — capture the un-closed brace prefix in `\cite{...`
 * - Markdown `[@<cursor>` — pandoc style
 * - Typst `@<cursor>` — Typst reference
 */
const LATEX_TRIGGER = /\\cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)$/;
const MD_TRIGGER = /\[@([^\]]*)$/;
const TYPST_TRIGGER = /@([A-Za-z][\w-]*)$/;

interface CompletionContext {
  /** Current cite-key prefix being completed. */
  prefix: string;
  /** Replacement-range start column (1-based, Monaco). */
  rangeStart: number;
}

let registered = false;

export function registerCiteCompletionProviders(monacoInstance: Monaco): void {
  if (registered) return;
  registered = true;

  for (const languageId of LANGUAGE_IDS) {
    monacoInstance.languages.registerCompletionItemProvider(languageId, {
      triggerCharacters: ['{', '@', ',', ' '],
      provideCompletionItems: (model: monaco.editor.ITextModel, position: monaco.Position) => {
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

  // LaTeX / Markdown may both use \cite{...}; try LaTeX first.
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

  // Typst also uses @key; markdown also accepts pandoc-style `@key` without brackets.
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
 * For `\cite{a, b, c<cursor>` the real completion prefix is `c`, not the
 * whole `a, b, c`. Take everything after the last comma (then trimStart the
 * space) as the prefix; the start column follows.
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
  // Declare 'prefix-only' intent on the keystroke hot path (tier 1 ck-prefix
  // + tier 2 token-prefix). The substring fallback is sliced at the recall
  // side by RecallMode — by design, half-library noise can never reach here.
  // For an empty prefix searchByQueryWithScore returns empty; fall back to
  // listing the full library.
  const hits: BibSearchHit[] =
    ctx.prefix.length === 0
      ? mirror
          .getAllItems()
          .slice(0, MAX_SUGGESTIONS)
          .map((item) => ({ item, score: 0 }))
      : mirror.searchByQueryWithScore(ctx.prefix, MAX_SUGGESTIONS, 'prefix-only');
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
      // Force mirror's scoring order via 0-padded indices (Monaco sorts the
      // sortText lexicographically, so this is stable).
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
 * Deterministically re-rank candidates by the current paragraph's semantic
 * score (keystroke hot path: synchronous, zero IPC). With no cached score
 * (active recommendation off, not yet ready, paragraph not yet embedded),
 * return the input unchanged — fully equivalent to pre-feature behaviour.
 *
 * Tiers (never cross):
 *  - Tier 0: citation-key hits (score ≥ CK_PREFIX_TIER) — user is typing the
 *    key; preserve mirror order, skip semantic scoring.
 *  - Tier 1: title/author fuzzy hits — within the tier sort descending by
 *    paragraph-semantic score; unscored entries trail; ties fall back to
 *    mirror order.
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
      if (ta !== tb) return ta - tb; // Tier 0 always precedes Tier 1
      if (ta === 0) return a.i - b.i; // Tier 0: preserve mirror order
      const sa = sem(a.h);
      const sb = sem(b.h);
      if (sa !== undefined && sb !== undefined && sa !== sb) return sb - sa; // Semantic desc
      if (sa !== undefined && sb === undefined) return -1; // Scored before unscored
      if (sa === undefined && sb !== undefined) return 1;
      return a.i - b.i; // Both unscored / equal: original order
    })
    .map((x) => x.h);
}

export const _internal = {
  detectContext,
  forCommaSeparated,
  reorderBySemantic,
};
