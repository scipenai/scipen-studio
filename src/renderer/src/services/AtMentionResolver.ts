/**
 * @file AtMentionResolver.ts
 * @description Resolves @path mentions from chat input by reading file contents
 *   via the Electron file IPC, then returns DTOs ready to be embedded in
 *   IM message metadata for OpenClaw to consume.
 *
 * Single-file mentions only (per product decision):
 *   "@docs/intro.tex" -> reads <projectRoot>/docs/intro.tex
 *
 * Limits (per product decision):
 *   - At most 20 files
 *   - Single file content capped at 200KB (truncated otherwise)
 *   - Total content capped at 1MB across all referenced files
 */

import { api } from '../api';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

const MENTION_TOKEN_REGEX = /@([^\s,;!?()[\]{}'"<>]+)/g;

export interface ReferencedFile {
  /** Path relative to the project root (forward-slash separated). */
  path: string;
  /** Basename of the file. */
  name: string;
  /** Full file content; truncated to limit when oversized. */
  content: string;
  /** Original byte size before any truncation. */
  size_bytes: number;
  /** True when the content was truncated to fit limits. */
  truncated: boolean;
  /** Optional language hint inferred from extension (e.g. "latex", "typst"). */
  language?: string;
}

export interface ResolvedAtMentionsResult {
  referencedFiles: ReferencedFile[];
  failed: Array<{ path: string; reason: string }>;
  /** Original text with successfully-resolved `@path` tokens rewritten to `[attached: path]`. */
  cleanedText: string;
}

/**
 * Extracts unique @path tokens from a free-form chat message.
 * Strips leading "@" and de-duplicates. Path remains as user typed
 * (forward / backward slashes preserved until normalization in resolver).
 */
export function extractMentionTokens(value: string): string[] {
  const matches = value.match(MENTION_TOKEN_REGEX) ?? [];
  return [...new Set(matches.map((item) => item.slice(1)))];
}

export async function resolveAtMentions(
  content: string,
  projectRootPath: string | null | undefined
): Promise<ResolvedAtMentionsResult> {
  if (!projectRootPath) {
    return { referencedFiles: [], failed: [], cleanedText: content };
  }

  const tokens = extractMentionTokens(content);
  if (tokens.length === 0) {
    return { referencedFiles: [], failed: [], cleanedText: content };
  }

  const referencedFiles: ReferencedFile[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  let totalBytes = 0;

  const root = normalizePathSep(projectRootPath).replace(/\/+$/, '');

  for (const rawToken of tokens) {
    if (referencedFiles.length >= MAX_FILES) {
      failed.push({ path: rawToken, reason: 'Exceeded max files limit (20)' });
      continue;
    }

    const normalized = normalizePathSep(rawToken).replace(/^\/+|\/+$/g, '');
    if (!normalized) {
      failed.push({ path: rawToken, reason: 'Empty path' });
      continue;
    }
    if (isAbsolutePath(normalized) || normalized.includes('..') || normalized.includes('\0')) {
      failed.push({ path: rawToken, reason: 'Path must be project-relative' });
      continue;
    }

    const absolutePath = joinPath(root, normalized);

    try {
      const { content: fileContent } = await api.file.read(absolutePath);
      const sizeBytes = utf8ByteLength(fileContent);

      let resultContent = fileContent;
      let truncated = false;
      if (sizeBytes > MAX_FILE_BYTES) {
        resultContent = truncateToBytes(fileContent, MAX_FILE_BYTES);
        truncated = true;
      }

      const resultBytes = utf8ByteLength(resultContent);
      if (totalBytes + resultBytes > MAX_TOTAL_BYTES) {
        failed.push({ path: normalized, reason: 'Exceeded total bytes limit (1MB)' });
        continue;
      }
      totalBytes += resultBytes;

      const name = basename(normalized);
      referencedFiles.push({
        path: normalized,
        name,
        content: resultContent,
        size_bytes: sizeBytes,
        truncated,
        language: inferLanguage(name),
      });
    } catch (err) {
      failed.push({
        path: normalized,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const resolvedPaths = referencedFiles.map((f) => f.path);
  const cleanedText = rewriteMentionsAsMarkers(content, resolvedPaths);

  return { referencedFiles, failed, cleanedText };
}

/**
 * Marker pair the renderer can detect to fold inline attachment content into a
 * compact chip when displaying the message in the chat UI.
 */
export const ATTACHMENTS_OPEN_TAG = '<attachments>';
export const ATTACHMENTS_CLOSE_TAG = '</attachments>';

export interface ParsedAttachmentSummary {
  path: string;
  name: string;
  sizeBytes: number;
  language?: string;
  truncated: boolean;
}

export interface ParsedMessageContent {
  /** Message text with the `<attachments>...</attachments>` block stripped out. */
  text: string;
  attachments: ParsedAttachmentSummary[];
}

/**
 * Inverse of formatAttachmentsBlock: extracts attachment summaries from an IM
 * message body so the renderer can show compact chips instead of the full file
 * content. The full content stays in the message — this is purely a UI concern.
 */
export function parseMessageAttachments(content: string): ParsedMessageContent {
  const openIdx = content.indexOf(ATTACHMENTS_OPEN_TAG);
  if (openIdx < 0) return { text: content, attachments: [] };
  const closeIdx = content.indexOf(ATTACHMENTS_CLOSE_TAG, openIdx);
  if (closeIdx < 0) return { text: content, attachments: [] };

  const block = content.slice(openIdx + ATTACHMENTS_OPEN_TAG.length, closeIdx);
  const before = content.slice(0, openIdx).trim();
  const after = content.slice(closeIdx + ATTACHMENTS_CLOSE_TAG.length).trim();
  const text = [before, after].filter(Boolean).join('\n\n');

  const attachments: ParsedAttachmentSummary[] = [];
  const fileTagRegex = /<file\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = fileTagRegex.exec(block)) !== null) {
    const attrs = match[1];
    const getAttr = (key: string): string | undefined => {
      const m = new RegExp(`${key}="([^"]*)"`).exec(attrs);
      return m?.[1];
    };
    const path = getAttr('path');
    const name = getAttr('name');
    if (!path || !name) continue;
    attachments.push({
      path,
      name,
      sizeBytes: Number(getAttr('size') ?? '0'),
      language: getAttr('lang'),
      truncated: getAttr('truncated') === 'true',
    });
  }
  return { text, attachments };
}

/**
 * Serialises the resolved files into an XML-like block that gets appended to
 * the IM message content. Any IM bot or LLM runtime can consume the resulting
 * message verbatim — no plugin support required.
 */
export function formatAttachmentsBlock(files: ReferencedFile[]): string {
  if (files.length === 0) return '';
  const parts: string[] = [ATTACHMENTS_OPEN_TAG];
  for (const file of files) {
    const lang = file.language ? ` lang="${file.language}"` : '';
    const truncated = file.truncated ? ' truncated="true"' : '';
    parts.push(
      `<file path="${file.path}" name="${file.name}" size="${file.size_bytes}"${lang}${truncated}>`
    );
    parts.push(file.content);
    parts.push('</file>');
  }
  parts.push(ATTACHMENTS_CLOSE_TAG);
  return parts.join('\n');
}

/**
 * Rewrites every successfully-resolved `@path` token in the original message to
 * `[attached: path]`, leaving unresolved/failed mentions intact so the user
 * still sees what didn't get attached.
 */
function rewriteMentionsAsMarkers(content: string, paths: string[]): string {
  if (paths.length === 0) return content;
  // Replace longer paths first so e.g. `@docs/intro.tex` isn't partially
  // matched by a shorter `@docs/intro` token.
  const sorted = [...paths].sort((a, b) => b.length - a.length);
  let result = content;
  for (const p of sorted) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The mention is delimited by the same non-token characters used in
    // extractMentionTokens (whitespace + punctuation + brackets) or end of input.
    const pattern = new RegExp(`@${escaped}(?=[\\s,;!?()\\[\\]{}'"<>]|$)`, 'g');
    result = result.replace(pattern, `[attached: ${p}]`);
  }
  return result;
}

// ====== Helpers ======

function normalizePathSep(p: string): string {
  return p.replace(/\\/g, '/');
}

function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:\/|\/)/.test(p);
}

function joinPath(root: string, rel: string): string {
  return `${root}/${rel}`;
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function truncateToBytes(s: string, maxBytes: number): string {
  const reserve = 80;
  const safeMax = Math.max(0, maxBytes - reserve);
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (utf8ByteLength(s.slice(0, mid)) <= safeMax) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return `${s.slice(0, lo)}\n\n[...truncated]`;
}

function inferLanguage(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tex') || lower.endsWith('.ltx')) return 'latex';
  if (lower.endsWith('.typ')) return 'typst';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.bib')) return 'bibtex';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.txt')) return 'plaintext';
  return undefined;
}
