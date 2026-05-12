/**
 * @file useProposalProcessor.ts — Processes AI proposals (propose_edit) and creates Diff Reviews automatically
 *
 * When an IM message contains proposals with streaming=false,
 * opens each target file and creates a DiffReview for it.
 */

import { useEffect, useRef } from 'react';
import type { EditProposalDTO, StudioIMMessageDTO } from '../../../../shared/api-types';
import { api } from '../api';
import {
  buildReviewKey,
  getDiffReviewService,
  normalizeReviewPath,
} from '../services/core/DiffReviewService';
import { getEditorService, getProjectRuntimeContext } from '../services/core';
import { openFileInEditor } from '../services/core/FileOpenService';
import { LogService } from '../services/LogService';

const log = {
  info: (m: string, d?: unknown) => LogService.info('ProposalProcessor', m, d),
  warn: (m: string, d?: unknown) => LogService.warn('ProposalProcessor', m, d),
};

/** Build an absolute path from project root plus relative path. */
function buildFullPath(projectPath: string, relativePath: string): string {
  const root = normalizeReviewPath(projectPath);
  const rel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `${root}/${rel}`;
}

// ── Replacement engine ──────────────────────────────────────────

interface ApplyResult {
  content: string;
  applied: number;
  skipped: string[];
}

/**
 * Apply proposals to file content.
 *
 * Strategy: locate every old_string occurrence in the original content,
 * verify no overlaps, then apply replacements **in reverse order** so
 * earlier replacements never shift the offsets of later ones.
 */
function applyProposalsToContent(content: string, proposals: EditProposalDTO[]): ApplyResult {
  // Normalise line endings to LF — the AI always emits LF in old_string/new_string,
  // but file content on Windows may contain CRLF.
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const hadCRLF = normalizedContent !== content;

  // Phase 1: locate every replacement position
  const located: Array<{
    start: number;
    end: number;
    newString: string;
    filePath: string;
  }> = [];
  const skipped: string[] = [];

  for (const p of proposals) {
    if (!p.old_string) {
      skipped.push(`${p.description || p.file_path} | old_string=<empty>`);
      continue;
    }
    const normalizedOld = p.old_string.replace(/\r\n/g, '\n');
    const idx = normalizedContent.indexOf(normalizedOld);

    // ── Fuzzy fallback: detect full-file replacement intent ─────
    // When the LLM does a "polish/rewrite" it often stuffs the entire file into old_string,
    // but mutates parts of it along the way, so an exact indexOf fails.
    // Heuristic: if old_string is ≥ 70% of the content length, at least 200 chars,
    // and shares a ≥ 50% common prefix, treat it as a full-file replacement intent
    // and substitute the actual content for the AI's imperfect old_string.
    // The absolute floor prevents very small files (< 100 chars) from being misdetected.
    if (
      idx === -1 &&
      normalizedOld.length >= 200 &&
      normalizedOld.length >= normalizedContent.length * 0.7
    ) {
      let commonPrefix = 0;
      const maxCmp = Math.min(normalizedContent.length, normalizedOld.length);
      while (
        commonPrefix < maxCmp &&
        normalizedContent[commonPrefix] === normalizedOld[commonPrefix]
      ) {
        commonPrefix++;
      }
      if (commonPrefix >= normalizedOld.length * 0.5) {
        log.info(
          `Fuzzy match: old_string ≈ full content (diverge@${commonPrefix}/${normalizedOld.length}), treating as full-file replacement`
        );
        located.push({
          start: 0,
          end: normalizedContent.length,
          newString: p.new_string.replace(/\r\n/g, '\n'),
          filePath: p.file_path,
        });
        continue;
      }
    }

    if (idx === -1) {
      // Pinpoint the mismatch: walk both strings char by char to find the divergence point.
      let divergePos = 0;
      const maxCmp = Math.min(normalizedContent.length, normalizedOld.length);
      while (divergePos < maxCmp && normalizedContent[divergePos] === normalizedOld[divergePos]) {
        divergePos++;
      }
      const ctxStart = Math.max(0, divergePos - 10);
      const contentAround = normalizedContent
        .slice(ctxStart, divergePos + 20)
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
      const oldAround = normalizedOld
        .slice(ctxStart, divergePos + 20)
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
      log.warn(`old_string mismatch at pos ${divergePos}/${normalizedOld.length}`, {
        filePath: p.file_path,
        contentAround: `"${contentAround}"`,
        oldAround: `"${oldAround}"`,
        contentLen: normalizedContent.length,
        oldLen: normalizedOld.length,
      });
      skipped.push(
        `${p.description ? `${p.description} | ` : ''}diverge@${divergePos}/${normalizedOld.length}`
      );
      continue;
    }
    located.push({
      start: idx,
      end: idx + normalizedOld.length,
      newString: p.new_string.replace(/\r\n/g, '\n'),
      filePath: p.file_path,
    });
  }

  if (located.length === 0) {
    return { content, applied: 0, skipped };
  }

  // Phase 2: sort by start offset and check for overlaps.
  located.sort((a, b) => a.start - b.start);
  for (let i = 1; i < located.length; i++) {
    if (located[i].start < located[i - 1].end) {
      console.warn(
        '[ProposalProcessor] Overlapping proposals detected, applying sequentially as fallback'
      );
      let result = normalizedContent;
      let applied = 0;
      for (const p of proposals) {
        if (!p.old_string) continue;
        const norm = p.old_string.replace(/\r\n/g, '\n');
        const idx2 = result.indexOf(norm);
        if (idx2 === -1) continue;
        result =
          result.slice(0, idx2) +
          p.new_string.replace(/\r\n/g, '\n') +
          result.slice(idx2 + norm.length);
        applied++;
      }
      return { content: hadCRLF ? result.replace(/\n/g, '\r\n') : result, applied, skipped };
    }
  }

  // Phase 3: replace from right to left so resolved offsets stay valid.
  let result = normalizedContent;
  for (let i = located.length - 1; i >= 0; i--) {
    const loc = located[i];
    result = result.slice(0, loc.start) + loc.newString + result.slice(loc.end);
  }

  return {
    content: hadCRLF ? result.replace(/\n/g, '\r\n') : result,
    applied: located.length,
    skipped,
  };
}

// ── Core processing ─────────────────────────────────────────────

function isBotMessage(msg: StudioIMMessageDTO, botUserId?: string): boolean {
  return Boolean(botUserId && msg.sender_id === botUserId);
}

/**
 * Handle proposals for a single file: open → read content → compute diff → create Review.
 */
/** Look up a tab by path, tolerating forward vs back slashes. */
function findTab(editorService: ReturnType<typeof getEditorService>, fullPath: string) {
  return editorService.getTab(fullPath) ?? editorService.getTab(fullPath.replace(/\//g, '\\'));
}

async function processFileProposals(
  filePath: string,
  proposals: EditProposalDTO[],
  projectPath: string,
  messageId: string,
  conversationId?: string
): Promise<boolean> {
  const editorService = getEditorService();
  const fullPath = buildFullPath(projectPath, filePath);
  const openTab = findTab(editorService, fullPath);

  // Source of truth: the AI's active_file_content is pulled from Monaco's tab.content
  // (see im-collaboration.ts), and DiffReview decorations must line up with Monaco
  // model line numbers. That means old_string has to be diffed against tab.content,
  // not the disk copy. Fall back to disk only when the file is not open in the editor
  // (in which case Monaco cannot be "ahead" of disk).
  let originalContent: string;
  let contentSource: 'tab' | 'disk';
  if (openTab) {
    originalContent = openTab.content;
    contentSource = 'tab';
  } else {
    try {
      const result = await api.file.read(fullPath);
      if (!result || result.content === undefined) {
        log.warn('Cannot read file', { fullPath });
        return false;
      }
      originalContent = result.content;
      contentSource = 'disk';
    } catch (err) {
      log.warn('Failed to read file', { fullPath, err: String(err) });
      return false;
    }
  }

  // Apply every replacement (offset-safe).
  const {
    content: newContent,
    applied,
    skipped,
  } = applyProposalsToContent(originalContent, proposals);
  if (applied === 0) {
    // No match — return false so the caller retries; do not mark processed.
    // Log source / head / length so we can diff the AI's old_string against reality.
    log.warn('No proposals applied (old_string mismatch, will retry)', {
      filePath,
      source: contentSource,
      contentLen: originalContent.length,
      contentHead: originalContent.slice(0, 60).replace(/\n/g, '\\n'),
      skipped,
    });
    return false;
  }
  if (newContent === originalContent) {
    console.info(`[ProposalProcessor] No actual changes for: ${filePath}`);
    return true;
  }

  const runtime = getProjectRuntimeContext().state;
  const otFileId = openTab?._id || undefined;
  const reviewKey = buildReviewKey(runtime, otFileId, fullPath);

  const review = getDiffReviewService().createReview(
    reviewKey.fileId,
    fullPath,
    originalContent,
    newContent,
    {
      reviewKey,
      source: {
        messageId,
        conversationId,
        proposalFilePath: filePath,
        normalizedFilePath: fullPath,
      },
    }
  );

  if (review) {
    console.info(
      `[ProposalProcessor] DiffReview for ${filePath}: ${review.hunks.length} hunk(s), ${applied} applied${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}`
    );
    // Make sure the file is open in the editor and visible.
    if (!openTab) {
      await openFileInEditor(fullPath);
    } else {
      editorService.setActiveTab(openTab.path);
    }
  }

  return true;
}

// ── Hook ─────────────────────────────────────────────────────────

/**
 * Hook that scans IM messages for AI proposals and opens Diff Reviews for them.
 *
 * Strategy:
 * - Failed messages are not flagged as processed — the next effect retries them.
 * - Successful messages are flagged so we never double-handle them.
 * - When the processed set exceeds 200 entries, GC the ones no longer in `messages`.
 */
export function useProposalProcessor(
  messages: StudioIMMessageDTO[],
  botUserId?: string,
  projectPath?: string | null
): void {
  const processedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());
  const retryCountRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!projectPath) {
      getDiffReviewService().clearAllReviews();
      return;
    }
    getDiffReviewService().clearLocalReviewsExceptProject(projectPath);
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath) return;

    for (const msg of messages) {
      if (!isBotMessage(msg, botUserId)) continue;
      if (msg.metadata?.streaming === true) continue;
      const proposals = msg.metadata?.proposals;
      if (!proposals || proposals.length === 0) continue;
      if (processedRef.current.has(msg.id)) continue;
      if (inFlightRef.current.has(msg.id)) continue;
      if ((retryCountRef.current.get(msg.id) ?? 0) >= 3) continue;

      // Mark as in-flight to block concurrent triggers.
      log.info('Processing proposals', {
        msgId: msg.id,
        count: proposals.length,
        files: proposals.map((p) => p.file_path),
        projectPath,
      });
      inFlightRef.current.add(msg.id);

      // Group by file_path.
      const grouped = new Map<string, EditProposalDTO[]>();
      for (const p of proposals) {
        const existing = grouped.get(p.file_path) || [];
        existing.push(p);
        grouped.set(p.file_path, existing);
      }

      // Process asynchronously — only mark processed when every file succeeds, otherwise allow a retry.
      const msgId = msg.id;
      const conversationId = msg.conversation_id;
      const promises = Array.from(grouped.entries()).map(([fp, fps]) =>
        processFileProposals(fp, fps, projectPath, msgId, conversationId)
      );

      void Promise.all(promises)
        .then((results) => {
          const allOk = results.every(Boolean);
          if (allOk) {
            processedRef.current.add(msgId);
            retryCountRef.current.delete(msgId);
          } else {
            retryCountRef.current.set(msgId, (retryCountRef.current.get(msgId) ?? 0) + 1);
          }
        })
        .catch((err) => {
          console.error('[ProposalProcessor] Unexpected error processing proposals:', err);
        })
        .finally(() => {
          inFlightRef.current.delete(msgId);
        });
    }

    // GC entries whose message is no longer in the list.
    if (processedRef.current.size > 200) {
      const currentIds = new Set(messages.map((m) => m.id));
      for (const id of processedRef.current) {
        if (!currentIds.has(id)) {
          processedRef.current.delete(id);
        }
      }
    }
  }, [messages, botUserId, projectPath]);
}
