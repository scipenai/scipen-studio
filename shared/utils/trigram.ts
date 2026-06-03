/**
 * @file 通用 trigram 倒排索引 —— 大小写折叠的 3-gram 模糊搜索
 * @description 离线建索引 + O(|q|/3) 查询。命中数 / 查询 trigram 数作为基础打分,
 *              再乘以 doc 权重。空间约 ~3 MB / 5k 条,搜索延迟 < 3 ms。
 *
 *              同时面向 main 进程的 ZoteroIndex 与 renderer 进程的 ZoteroBibMirror,
 *              因此放到 shared/utils,纯函数零依赖。
 *
 *              Token 由上游拼接(典型为 `{citationKey} {title} {creatorsLabel}
 *              {year}` 以空格分隔),标点折叠为空格、大小写归一化为小写。
 */

export interface TrigramSearchResult<K> {
  id: K;
  score: number;
}

interface IndexedDoc {
  /** 文档总 trigram 数(归一化分母)。 */
  size: number;
  /** 文档级权重乘子。 */
  weight: number;
}

export class TrigramIndex<K> {
  private postings: Map<string, Set<K>> = new Map();
  private docs: Map<K, IndexedDoc> = new Map();

  /**
   * 插入或覆盖 `id` 的索引项。同一 id 二次 upsert 会先 remove 后建索引,
   * 因此可安全用于 patch 场景。
   *
   * `weight` 是打分乘子(默认 1.0)。例:为持有 citationKey 的条目加权
   * 1.5,使模糊命中时优先于无 key 条目。
   */
  upsert(id: K, text: string, weight = 1.0): void {
    this.remove(id);
    const grams = extractTrigrams(text);
    if (grams.size === 0) return;

    for (const gram of grams) {
      let bucket = this.postings.get(gram);
      if (!bucket) {
        bucket = new Set();
        this.postings.set(gram, bucket);
      }
      bucket.add(id);
    }
    this.docs.set(id, { size: grams.size, weight });
  }

  remove(id: K): void {
    if (!this.docs.has(id)) return;
    // 不维护 doc→grams 反查表;直接扫 postings。5k 文档下唯一 trigram 约 8k,
    // 删除事件本身极少(window focus 触发的 delta),CPU 完全够。
    for (const bucket of this.postings.values()) {
      bucket.delete(id);
    }
    this.docs.delete(id);
  }

  /**
   * 取前 `limit` 个候选,按 `(overlap / query.size) * weight` 降序排。
   * `minScore` 用来裁掉长尾;希望严格匹配时调高即可。
   */
  search(query: string, limit = 20, minScore = 0.2): TrigramSearchResult<K>[] {
    const qGrams = extractTrigrams(query);
    if (qGrams.size === 0) return [];

    const hits = new Map<K, number>();
    for (const gram of qGrams) {
      const bucket = this.postings.get(gram);
      if (!bucket) continue;
      for (const id of bucket) {
        hits.set(id, (hits.get(id) ?? 0) + 1);
      }
    }

    const out: TrigramSearchResult<K>[] = [];
    const qSize = qGrams.size;
    for (const [id, overlap] of hits) {
      const doc = this.docs.get(id);
      if (!doc) continue;
      const score = (overlap / qSize) * doc.weight;
      if (score < minScore) continue;
      out.push({ id, score });
    }

    out.sort((a, b) => b.score - a.score);
    return out.length > limit ? out.slice(0, limit) : out;
  }

  size(): number {
    return this.docs.size;
  }

  clear(): void {
    this.postings.clear();
    this.docs.clear();
  }
}

/**
 * 把 `text` 切成 3-gram 集合。非字母数字串归一为空格(顺带成为 trigram 边界),
 * 每个 token 两侧 padding 一个空格使前缀字符共享 grams —— `"  s"`、`" sm"`、
 * `"smi"` 等 —— 这是 "smit" 能优先命中 "smith*" 的关键。
 *
 * 中文采用 `一-鿿` 字符类保留 CJK 字符,避免 toLowerCase 后被当作标点切碎。
 */
export function extractTrigrams(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const folded = text
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, ' ')
    .trim();
  if (folded.length === 0) return out;

  for (const token of folded.split(/\s+/)) {
    if (token.length === 0) continue;
    const padded = `  ${token} `;
    for (let i = 0; i <= padded.length - 3; i++) {
      out.add(padded.substring(i, i + 3));
    }
  }
  return out;
}
