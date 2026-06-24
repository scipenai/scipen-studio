/**
 * @file bibSearchScoring — Zotero candidate scoring (used by @cite)
 * @description Three-tier scoring:
 *
 *  1. **Citation-key prefix direct hit** — top priority. When the user types a
 *     citation key prefix inside `\cite{`, only prefix-matching keys matter.
 *     Exact match +100; shorter keys rank higher (a shorter prefix is more
 *     precise).
 *
 *  2. **Token-intersection scoring** — tokenize the query; each token does a
 *     prefix match against the inverted index. Exact token match scores 10;
 *     prefix matches decay with length delta. A recency bias is layered in
 *     (newer papers +).
 *
 *  3. **Substring fallback** — when the first two tiers are empty, scan the
 *     query as a substring against the haystack; +1 per hit.
 *
 * Ported from m2-zotero-stash c38298d's Web Worker (off-thread) design, but
 * this repo's renderer keeps the data on the main thread in a mirror. 5k-entry
 * scoring measures <8ms in practice, so a Worker is unnecessary. If the lib
 * later grows large enough to jank, the pure function below can move into a
 * Worker verbatim.
 */

import type { ZoteroItemDTO } from '../../../../../shared/types/zotero';

export interface BibSearchHit {
  item: ZoteroItemDTO;
  /** Higher ranks first; the main thread no longer sorts — this function does. */
  score: number;
}

/**
 * Recall-intent contract. The keystroke hot path (@cite completion) and the
 * fuzzy search box (chat @ dropdown / Agent zotero_search tool) need different
 * recall granularity; routing both through one API that returns three-tier
 * mixed results forces callers to suppress noise via sortText / filter at the
 * UI layer — pushing recall precision onto the UI. This type promotes the
 * intent into the interface contract, and the scoring function dispatches on
 * the declaration.
 *
 *  - `'prefix-only'`: tier 1 (ck prefix) + tier 2 (token prefix). Keystroke
 *    hot path: fires every keystroke; the semantic is precise prefix match.
 *    A substring fallback here is noise, not safety net (a single character
 *    recalls half the library and drowns LSP candidates).
 *  - `'full'` (default): all three tiers, including substring fallback.
 *    Search box / LLM tool: user-invoked; falling back to substring when
 *    prefix misses is the expected behaviour.
 */
export type RecallMode = 'prefix-only' | 'full';

/** Inverted index and haystack are maintained by the caller; this module does not build them. */
export interface BibSearchCorpus {
  items: ReadonlyMap<string, ZoteroItemDTO>;
  /** citationKey (lowercase) → itemKey. Used for prefix matching. */
  citationKeyIndex: ReadonlyMap<string, string>;
  /** token (lowercase, ≥2 chars) → set of itemKeys. */
  tokenIndex: ReadonlyMap<string, ReadonlySet<string>>;
  /** itemKey → concatenated lowercase haystack (used by substring fallback). */
  haystacks: ReadonlyMap<string, string>;
}

const MIN_TOKEN_LEN = 2;

/**
 * Minimum query length to enable the substring fallback. Too-short queries
 * (1–2 chars) tank substring recall precision — a single character is almost
 * certain to appear in half the haystack entries, and in @cite completion
 * that recalls papers unrelated to the prefix and drowns LSP candidates
 * (typing `@f` would surface every paper whose title contains `f`, smothering
 * tinymist's `<fig-*>` labels). Paired with MIN_TOKEN_LEN=2: the token tier
 * already guards the per-token minimum; the substring tier is looser than
 * the token tier, so the threshold sits at 3 to enforce the semantic of
 * "below 3 chars LSP wins; ≥3 chars unlocks fuzzy search".
 */
const MIN_SUBSTRING_QUERY_LEN = 3;

/** Tokenize: lowercase + split on non-alphanumeric + length threshold. */
export function tokenize(s: string): string[] {
  const tokens: string[] = [];
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_TOKEN_LEN) tokens.push(raw);
  }
  return tokens;
}

/** Derive a haystack from one ZoteroItemDTO (title + creators + year + ck). */
export function buildHaystack(item: ZoteroItemDTO): string {
  return [
    item.citationKey ?? '',
    item.title ?? '',
    item.creatorsLabel ?? '',
    item.year ? String(item.year) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function searchBibCorpus(
  corpus: BibSearchCorpus,
  query: string,
  limit: number,
  mode: RecallMode = 'full'
): BibSearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0 || limit <= 0) return [];

  // ----- 1. citation-key prefix direct hit -----
  const ckPrefixHits: BibSearchHit[] = [];
  for (const [ck, itemKey] of corpus.citationKeyIndex) {
    if (!ck.startsWith(q)) continue;
    const item = corpus.items.get(itemKey);
    if (!item) continue;
    const score = 1000 + (ck === q ? 100 : 0) - ck.length;
    ckPrefixHits.push({ item, score });
    if (ckPrefixHits.length >= limit * 2) break;
  }

  // ----- 2. token intersection + recency bias -----
  const queryTokens = tokenize(q);
  const tokenScores = new Map<string, number>();
  if (queryTokens.length > 0) {
    for (const qt of queryTokens) {
      for (const [tok, postings] of corpus.tokenIndex) {
        if (!tok.startsWith(qt)) continue;
        const weight = tok === qt ? 10 : Math.max(1, 10 - (tok.length - qt.length));
        for (const itemKey of postings) {
          tokenScores.set(itemKey, (tokenScores.get(itemKey) ?? 0) + weight);
        }
      }
    }
  }

  // ----- 3. substring fallback — 'full' mode only -----
  // prefix-only mode forbids substring by design: in the keystroke hot path
  // substring recall is noise, not a fallback (typing `@f` should not surface
  // every paper whose title contains `f`, smothering tinymist's LSP labels).
  if (mode === 'full' && ckPrefixHits.length === 0 && tokenScores.size === 0) {
    if (q.length < MIN_SUBSTRING_QUERY_LEN) return [];
    const out: BibSearchHit[] = [];
    for (const [itemKey, haystack] of corpus.haystacks) {
      if (!haystack.includes(q)) continue;
      const item = corpus.items.get(itemKey);
      if (!item) continue;
      out.push({ item, score: 1 });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ----- 4. merge + recency bias + truncate -----
  const merged = new Map<string, BibSearchHit>();
  for (const hit of ckPrefixHits) merged.set(hit.item.itemKey, hit);
  for (const [itemKey, score] of tokenScores) {
    const item = corpus.items.get(itemKey);
    if (!item) continue;
    const recency = item.year ? Math.max(0, item.year - 2000) / 100 : 0;
    const existing = merged.get(itemKey);
    const combined = (existing?.score ?? 0) + score + recency;
    merged.set(itemKey, { item, score: combined });
  }

  const sorted = Array.from(merged.values()).sort((a, b) => b.score - a.score);
  return sorted.length > limit ? sorted.slice(0, limit) : sorted;
}
