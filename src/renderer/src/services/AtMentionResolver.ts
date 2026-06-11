/**
 * @file AtMentionResolver — parses `@path` tokens in chat input and
 *   produces SNACA wire-shape `Mention[]` for `chat.send` /
 *   `composer.start`. Hands cleaned content back so the LLM sees a
 *   short `[attached: path]` marker in place of the raw token.
 *
 * Scope (minimal — matches what the LLM actually consumes):
 *   - `@docs/intro.tex` → `Mention { kind: 'file', path, inline_content }`
 *   - Other kinds (`folder` / `symbol` / `selection` / `url`) are not
 *     produced by text tokens; they get attached through dedicated UI
 *     entry points (planned: @symbol dropdown).
 *
 * Limits (same as before — preserve token budget):
 *   - At most 20 files
 *   - Single file capped at 200 KB (truncated marker appended)
 *   - Total across all mentions capped at 1 MB
 */

import { api } from '../api';
import type { Mention } from '../../../main/services/agent/protocol/schemas';
import { truncateToBytes, utf8ByteLength } from '../../../../shared/utils';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

const MENTION_TOKEN_REGEX = /@([^\s,;!?()[\]{}'"<>]+)/g;

export interface MentionBuildResult {
  /** Ready to drop into `ChatContext.mentions` / `ComposerStartParams.mentions`. */
  mentions: Mention[];
  /** Original text with resolved `@path` rewritten to `[attached: path]`. */
  cleanedText: string;
  /** Tokens that couldn't be resolved — surface to the user, don't ship. */
  failed: Array<{ token: string; reason: string }>;
}

/**
 * Extract unique `@token` strings from a free-form chat message.
 * Strips leading `@` and de-duplicates. Tokens stay as the user typed
 * them (slash style preserved); normalisation happens in
 * `buildMentions`.
 */
export function extractMentionTokens(value: string): string[] {
  const matches = value.match(MENTION_TOKEN_REGEX) ?? [];
  return [...new Set(matches.map((item) => item.slice(1)))];
}

/**
 * Resolve every `@path` token in `content` into a SNACA file Mention
 * with inline content. Returns `mentions: []` when there is no project
 * root or no tokens — the caller can pass the result straight through
 * either way.
 */
export async function buildMentions(
  content: string,
  projectRootPath: string | null | undefined
): Promise<MentionBuildResult> {
  if (!projectRootPath) {
    return { mentions: [], failed: [], cleanedText: content };
  }
  const tokens = extractMentionTokens(content);
  if (tokens.length === 0) {
    return { mentions: [], failed: [], cleanedText: content };
  }

  const root = normalizePathSep(projectRootPath).replace(/\/+$/, '');
  const mentions: Mention[] = [];
  const failed: Array<{ token: string; reason: string }> = [];
  const resolvedPaths: string[] = [];
  let totalBytes = 0;

  for (const rawToken of tokens) {
    if (mentions.length >= MAX_FILES) {
      failed.push({ token: rawToken, reason: 'exceeded max files (20)' });
      continue;
    }

    // Reserved prefixes for non-file kinds. `cite:` is resolved earlier
    // by the chat composer (AtCiteDropdown rewrites `@cite:` into a
    // concrete `@cite:<key>` once the user picks an entry), so by the
    // time we reach here the token already carries a canonical citation
    // key and the LLM can use it as-is. Other prefixes
    // (label/fig/tab/sec/symbol/url) have no picker yet — pass through
    // as plain text.
    if (/^(label|cite|fig|tab|sec|symbol|url|https?):/i.test(rawToken)) {
      continue;
    }

    const normalized = normalizePathSep(rawToken).replace(/^\/+|\/+$/g, '');
    if (!normalized) {
      failed.push({ token: rawToken, reason: 'empty path' });
      continue;
    }
    if (isAbsolutePath(normalized) || normalized.includes('..') || normalized.includes('\0')) {
      failed.push({ token: rawToken, reason: 'path must be project-relative' });
      continue;
    }

    const absolutePath = `${root}/${normalized}`;
    try {
      const { content: fileContent } = await api.file.read(absolutePath);
      const fullBytes = utf8ByteLength(fileContent);

      let inlineContent = fileContent;
      if (fullBytes > MAX_FILE_BYTES) {
        inlineContent = truncateToBytes(fileContent, MAX_FILE_BYTES);
      }
      const usedBytes = utf8ByteLength(inlineContent);
      if (totalBytes + usedBytes > MAX_TOTAL_BYTES) {
        failed.push({ token: rawToken, reason: 'exceeded total bytes (1 MB)' });
        continue;
      }
      totalBytes += usedBytes;

      mentions.push({
        kind: 'file',
        path: normalized,
        inline_content: inlineContent,
      });
      resolvedPaths.push(normalized);
    } catch (err) {
      failed.push({
        token: rawToken,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    mentions,
    failed,
    cleanedText: rewriteResolvedTokens(content, resolvedPaths),
  };
}

// ====== Helpers ======

function rewriteResolvedTokens(content: string, paths: string[]): string {
  if (paths.length === 0) return content;
  // Replace longer paths first so `@docs/intro.tex` doesn't get
  // partially matched by a shorter `@docs/intro` token.
  const sorted = [...paths].sort((a, b) => b.length - a.length);
  let result = content;
  for (const p of sorted) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`@${escaped}(?=[\\s,;!?()\\[\\]{}'"<>]|$)`, 'g');
    result = result.replace(pattern, `[attached: ${p}]`);
  }
  return result;
}

function normalizePathSep(p: string): string {
  return p.replace(/\\/g, '/');
}

function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:\/|\/)/.test(p);
}
