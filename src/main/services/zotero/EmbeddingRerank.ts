/**
 * @file EmbeddingRerank — recommendation-quality core: LLM rerank over the
 *   cosine coarse-recall candidates.
 *
 * Reuses main's chat model (IAIService.chat) to pick the most worth-citing
 * papers for "this paragraph", with a one-line reason. This is the biggest
 * lever for "doing recommendation well" (borrowing snaca-engine's two-stage
 * cosine -> rerank).
 *
 * Three-level degradation (cosine is always the fallback, see
 * EmbeddingIndexService.recommend):
 *   (1) chat model not configured -> skip, return null
 *   (2) chat model busy (user is mid-conversation, isGenerating) -> don't
 *       steal quota, return null
 *   (3) call throws / 6s timeout / invalid JSON / itemKey not in candidates -> return null
 */

import type { DocLang } from '../../../../shared/types/zotero-embedding';
import type { IAIService, AIMessage } from '../interfaces/IAIService';
import { createLogger } from '../LoggerService';

const logger = createLogger('EmbeddingRerank');

/** Hard timeout for the rerank call; a small request, fall back on timeout. */
const RERANK_TIMEOUT_MS = 6000;
/** Paragraph truncation inside the prompt, to control tokens. */
const PARAGRAPH_LIMIT = 1500;
/** Per-candidate abstract truncation. */
const ABSTRACT_LIMIT = 300;

export interface RerankCandidate {
  itemKey: string;
  citationKey?: string;
  title: string;
  abstract?: string;
  cosineScore: number;
}

export interface RerankedItem {
  itemKey: string;
  reason: string;
}

const SYSTEM_PROMPT =
  'You are a citation recommendation assistant. Given a paragraph the author is ' +
  'writing and a list of candidate papers, pick the papers most worth citing at ' +
  'this point. Respond ONLY with a JSON array like ' +
  '[{"itemKey":"ABCD1234","reason":"<short reason>"}], most relevant first, no prose.';

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

/** Build the rerank user prompt (pure function, exported for tests). */
export function buildRerankPrompt(
  paragraph: string,
  candidates: RerankCandidate[],
  lang: DocLang
): string {
  const lines = candidates.map((c, i) => {
    const abstract = c.abstract ? ` | ${clip(c.abstract, ABSTRACT_LIMIT)}` : '';
    return `${i + 1}. itemKey=${c.itemKey} | ${c.title}${abstract}`;
  });
  const reasonLang = lang === 'latex' || lang === 'unknown' ? 'English' : 'the paragraph language';
  return [
    '[PARAGRAPH]',
    clip(paragraph, PARAGRAPH_LIMIT),
    '',
    '[CANDIDATES]',
    ...lines,
    '',
    `Return the top 3 itemKeys most relevant to the paragraph, each with an 8-word reason in ${reasonLang}.`,
  ].join('\n');
}

/**
 * Parse the model output (pure function, exported for tests). Tolerant:
 * extracts the first JSON array, validates each itemKey is in the candidate
 * set, preserves order. Any exception returns null (caller degrades).
 */
export function parseRerankResponse(
  raw: string,
  candidates: RerankCandidate[]
): RerankedItem[] | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  const valid = new Set(candidates.map((c) => c.itemKey));
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    const out: RerankedItem[] = [];
    for (const entry of parsed) {
      const itemKey = typeof entry?.itemKey === 'string' ? entry.itemKey : null;
      if (!itemKey || !valid.has(itemKey)) continue;
      if (out.some((o) => o.itemKey === itemKey)) continue; // dedupe
      const reason = typeof entry?.reason === 'string' ? entry.reason : '';
      out.push({ itemKey, reason });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Call the LLM reranker. Returns null to signal "degrade to pure cosine"
 * (not configured / busy / failed / timeout).
 */
export async function rerankCandidates(
  ai: IAIService,
  paragraph: string,
  candidates: RerankCandidate[],
  lang: DocLang
): Promise<RerankedItem[] | null> {
  if (candidates.length === 0) return null;
  if (!ai.isConfigured()) return null; // (1) not configured
  if (ai.isGenerating()) return null; // (2) busy, don't steal user-chat quota

  const messages: AIMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildRerankPrompt(paragraph, candidates, lang) },
  ];

  try {
    const raw = await withTimeout(ai.chat(messages), RERANK_TIMEOUT_MS);
    return parseRerankResponse(raw, candidates);
  } catch (err) {
    logger.warn('rerank failed, falling back to cosine', { error: String(err) });
    return null; // (3) thrown / timeout
  }
}

/** Promise + timeout (timeout discards the response, doesn't truly cancel — small request, acceptable). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rerank timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
