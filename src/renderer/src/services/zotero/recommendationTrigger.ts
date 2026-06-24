/**
 * @file recommendationTrigger -- thin glue from Monaco model to paragraph context.
 *
 * Isolates monaco-specific line/language access here; core boundary detection
 * reuses the shared pure functions (sectionExtract), so ActiveRecommendationService
 * unit tests can inject a fake model.
 */

import type { DocLang } from '../../../../../shared/types/zotero-embedding';
import {
  detectDocLang,
  extractParagraphContext,
  hashParagraph,
} from '../../../../../shared/utils/sectionExtract';

/** Minimal model interface needed to extract the current paragraph (eases test injection). */
export interface MinimalModel {
  getLinesContent(): string[];
  getLanguageId(): string;
}

/** monaco languageId -> DocLang. */
export function detectParagraphLang(languageId: string): DocLang {
  return detectDocLang(languageId);
}

/**
 * Extracts current paragraph text and hash from model + cursor line. Returns
 * null when the paragraph is too short (empty paragraph and fallback still
 * <30 chars) -- caller skips the query in that case.
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
