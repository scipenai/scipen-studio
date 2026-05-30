/**
 * @file bibSearchScoring —— Zotero 文献候选评分(@cite 专用)
 * @description 三档评分:
 *
 *  1. **citation-key 前缀直接命中** —— 最高优先级。用户在 `\cite{` 内输入
 *     citation key 前缀时,只关心 key 是否前缀匹配。完全相等 +100;
 *     越短的 key 越靠前(短前缀更精确)。
 *
 *  2. **token 交集打分** —— query 拆 token,每个 token 对倒排索引做前缀匹配。
 *     完全匹配 token 10 分,前缀匹配按长度差衰减。叠加 recency bias(新论文 +)。
 *
 *  3. **substring fallback** —— 前两档全空时,把 query 当 substring 在
 *     haystack 里扫,每命中一份 1 分。
 *
 * 设计 port 自 m2-zotero-stash c38298d 的 Web Worker(off-thread),
 * 但本仓 renderer 已经把数据放在主线程 mirror,5k entry 评分实测 <8ms,
 * 不需要 Worker。如果未来 lib 大到卡顿,这个纯函数也可以一字不改搬进 Worker。
 */

import type { ZoteroItemDTO } from '../../../../../shared/types/zotero';

export interface BibSearchHit {
  item: ZoteroItemDTO;
  /** 越大越靠前;主线程不再排序,由本函数排好。 */
  score: number;
}

/** 倒排索引和 haystack 由调用方维护,本模块不负责构建。 */
export interface BibSearchCorpus {
  items: ReadonlyMap<string, ZoteroItemDTO>;
  /** citationKey(小写) → itemKey。前缀匹配用。 */
  citationKeyIndex: ReadonlyMap<string, string>;
  /** token(小写 ≥2 char)→ itemKey 集合。 */
  tokenIndex: ReadonlyMap<string, ReadonlySet<string>>;
  /** itemKey → 拼接小写 haystack(substring fallback 用)。 */
  haystacks: ReadonlyMap<string, string>;
}

const MIN_TOKEN_LEN = 2;

/**
 * substring fallback 的最小 query 长度门槛。query 太短(1–2 字符)进 substring
 * 召回精度归零 —— 单字符必然在 haystack 半数 entry 里出现,在 @cite 补全里
 * 会召回与 prefix 无关的论文,淹没 LSP 真候选(打 `@f` 误召回所有 title 含 f
 * 的论文,把 tinymist 的 `<fig-*>` label 挤掉)。与 MIN_TOKEN_LEN=2 对位的设计:
 * token 档已守住 query 拆 token 的最小长度;substring 档比 token 更松散,
 * 门槛设在 3 才能撑住"3 字符以下让 LSP 优先,3+ 才真启动模糊搜索"的语义。
 */
const MIN_SUBSTRING_QUERY_LEN = 3;

/** 拆 token:小写 + 非字母数字切分 + 长度门槛。 */
export function tokenize(s: string): string[] {
  const tokens: string[] = [];
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_TOKEN_LEN) tokens.push(raw);
  }
  return tokens;
}

/** 由一个 ZoteroItemDTO 派生 haystack(title + creators + year + ck)。 */
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
  limit: number
): BibSearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0 || limit <= 0) return [];

  // ----- 1. citation-key 前缀直接命中 -----
  const ckPrefixHits: BibSearchHit[] = [];
  for (const [ck, itemKey] of corpus.citationKeyIndex) {
    if (!ck.startsWith(q)) continue;
    const item = corpus.items.get(itemKey);
    if (!item) continue;
    const score = 1000 + (ck === q ? 100 : 0) - ck.length;
    ckPrefixHits.push({ item, score });
    if (ckPrefixHits.length >= limit * 2) break;
  }

  // ----- 2. token 交集 + recency bias -----
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

  // ----- 3. substring fallback(前两档全空时)-----
  if (ckPrefixHits.length === 0 && tokenScores.size === 0) {
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

  // ----- 4. 合并 + recency bias + 截断 -----
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
