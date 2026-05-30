/**
 * @file zotero-embedding.ts —— M3 标尺5「主动文献推荐」的 embedding 索引 /
 *   推荐结果线协议类型。
 *
 * 设计:embedding 走云 BYOK(智谱/阿里/openai text-embedding-v3),向量索引 +
 *   cosine 暴力搜索都在 main 进程(canonical),renderer 永不持有向量、永不见
 *   API key。renderer 只把抽好的段落文本发 main(`Zotero_QueryRecommendation`),
 *   收回 top3 文献元数据(`ZoteroEmbeddingResultDTO`)。
 */

import type { ZoteroEmbeddingProvider } from './zotero';

/**
 * 编辑器文档语言。决定段落边界识别(heading 语法)与插入引用的语法
 * (`\cite{}` / `@key` / `[@key]`)。`unknown` 退化为「仅空行分段」。
 */
export type DocLang = 'latex' | 'markdown' | 'typst' | 'unknown';

/**
 * Embedding 索引生命周期状态(照 ZoteroOrchestrator 的状态机形态)。
 *   - `disabled` = 主动推荐未开启(settings activeRecommendation=false)
 *   - `no-key`   = 已开启但 keychain 无 embedding key,等待用户配置
 *   - `building` = 正在全量建库(带 embedded/total 进度)
 *   - `ready`    = 索引就绪可查询
 *   - `error`    = 建库失败(key 无效 / 离线等),errorMessage 说明
 */
export type EmbeddingIndexState = 'disabled' | 'no-key' | 'building' | 'ready' | 'error';

/** 索引状态快照,经 `Zotero_GetEmbeddingStatus` 拉取 + `Zotero_EmbeddingProgress` 广播。 */
export interface EmbeddingIndexStatusDTO {
  state: EmbeddingIndexState;
  /** 当前向量绑定的模型标识(`provider:model`)。换模型时旧向量整体失效。 */
  modelId: string | null;
  /** 库中「有摘要、可参与推荐」的条目总数(分母)。 */
  total: number;
  /** 已完成 embedding 的条目数(building 进度分子)。 */
  embedded: number;
  /** 仅 error 时有效:人类可读错误(已脱敏,不含 key)。 */
  errorMessage?: string;
  updatedAt: string;
}

/** 主动推荐查询请求:renderer 抽好当前段落文本后发给 main。 */
export interface RecommendRequestDTO {
  /** 当前光标所在段落 / 章节的正文(renderer 用 sectionExtract 抽取并截断)。 */
  paragraph: string;
  /** 文档语言,供 rerank 提示语选择 + 结果展示。 */
  lang: DocLang;
  /** 当前文件路径,仅用于日志 / 未来按文件 scope(本轮全库)。 */
  filePath: string;
}

/** 单条推荐文献(top3 之一)。 */
export interface ZoteroEmbeddingResultItemDTO {
  itemKey: string;
  /** BBT 可读引用键;缺失时插入引用退化用 itemKey。 */
  citationKey?: string;
  title: string;
  year?: number;
  /** cosine 相似度分(0~1,已 L2 归一化点积)。 */
  score: number;
  /** LLM rerank 给出的「为何相关」短理由(≤8 词);纯 cosine 兜底时缺失。 */
  reason?: string;
  /** 该条是否经 LLM 精排(false = 纯 cosine 排序)。 */
  reranked: boolean;
}

/**
 * 主动推荐结果。`degraded` 标记降级原因:
 *   - `cosine-only` = 聊天模型未配置,无法 rerank
 *   - `no-rerank`   = 聊天模型忙(正在 streaming)/ rerank 调用失败,本次跳过
 *   undefined = 正常经 rerank 精排。
 */
export interface ZoteroEmbeddingResultDTO {
  items: ZoteroEmbeddingResultItemDTO[];
  /** 回声请求段落的 hash;renderer 据此丢弃过期(段落已变)的响应。 */
  paragraphHash: string;
  degraded?: 'cosine-only' | 'no-rerank';
}

/** 重新导出,便于消费方一处引入。 */
export type { ZoteroEmbeddingProvider };
