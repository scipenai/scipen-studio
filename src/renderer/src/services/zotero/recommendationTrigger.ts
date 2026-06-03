/**
 * @file recommendationTrigger —— Monaco model → 段落上下文 的薄胶水层。
 *
 * 把 monaco 特有的取行/取语言隔离在此,核心边界识别复用 shared 纯函数
 * (sectionExtract),便于 ActiveRecommendationService 单测时注入假 model。
 */

import type { DocLang } from '../../../../../shared/types/zotero-embedding';
import {
  detectDocLang,
  extractParagraphContext,
  hashParagraph,
} from '../../../../../shared/utils/sectionExtract';

/** 抽出当前段落所需的 model 最小接口(便于测试注入)。 */
export interface MinimalModel {
  getLinesContent(): string[];
  getLanguageId(): string;
}

/** monaco languageId → DocLang。 */
export function detectParagraphLang(languageId: string): DocLang {
  return detectDocLang(languageId);
}

/**
 * 从 model + 光标行抽出当前段落文本与 hash。段落过短(空段且回退后仍 <30 字符)
 * 返回 null —— 调用方据此跳过查询。
 */
export function extractFromEditor(
  model: MinimalModel,
  cursorLine: number
): { text: string; hash: string } | null {
  const lines = model.getLinesContent();
  const lang = detectDocLang(model.getLanguageId());
  const { text } = extractParagraphContext(lines, cursorLine, lang);
  if (text.trim().length < 30) return null;
  return { text, hash: hashParagraph(text) };
}
