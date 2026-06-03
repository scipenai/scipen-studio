/**
 * @file EmbeddingRerank —— 推荐质量核心:对 cosine 粗召的候选做 LLM 精排。
 *
 * 复用 main 的聊天模型(IAIService.chat)给「当前段落」选最该引的几篇,带一句
 * 理由。这是「把推荐做好」的最大杠杆(借鉴 snaca-engine 的 cosine→rerank 两阶段)。
 *
 * 三级降级(永远有 cosine 兜底,见 EmbeddingIndexService.recommend):
 *   ① 聊天模型未配置 → 不调,返回 null
 *   ② 聊天模型忙(用户正在对话,isGenerating)→ 不抢配额,返回 null
 *   ③ 调用抛错 / 6s 超时 / JSON 非法 / itemKey 不在候选 → 返回 null
 */

import type { DocLang } from '../../../../shared/types/zotero-embedding';
import type { IAIService, AIMessage } from '../interfaces/IAIService';
import { createLogger } from '../LoggerService';

const logger = createLogger('EmbeddingRerank');

/** rerank 调用硬超时;一次小请求,超时即放弃走降级。 */
const RERANK_TIMEOUT_MS = 6000;
/** prompt 内段落截断,控 token。 */
const PARAGRAPH_LIMIT = 1500;
/** 每条候选摘要截断。 */
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

/** 构造 rerank 的 user prompt(纯函数,导出供测试)。 */
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
 * 解析模型输出(纯函数,导出供测试)。容错:提取首个 JSON 数组、校验每个 itemKey
 * 属于候选集、保序。任何异常返回 null(调用方降级)。
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
      if (out.some((o) => o.itemKey === itemKey)) continue; // 去重
      const reason = typeof entry?.reason === 'string' ? entry.reason : '';
      out.push({ itemKey, reason });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * 调 LLM 精排。返回 null 表示「降级到纯 cosine」(未配置 / 忙 / 失败 / 超时)。
 */
export async function rerankCandidates(
  ai: IAIService,
  paragraph: string,
  candidates: RerankCandidate[],
  lang: DocLang
): Promise<RerankedItem[] | null> {
  if (candidates.length === 0) return null;
  if (!ai.isConfigured()) return null; // ① 未配置
  if (ai.isGenerating()) return null; // ② 忙,避免抢用户对话配额

  const messages: AIMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildRerankPrompt(paragraph, candidates, lang) },
  ];

  try {
    const raw = await withTimeout(ai.chat(messages), RERANK_TIMEOUT_MS);
    return parseRerankResponse(raw, candidates);
  } catch (err) {
    logger.warn('rerank failed, falling back to cosine', { error: String(err) });
    return null; // ③ 抛错 / 超时
  }
}

/** Promise + 超时(超时只丢弃响应,不真正取消——一次小请求,可接受)。 */
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
