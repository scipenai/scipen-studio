/**
 * @file DiffReviewBridge.ts — global bot-edit capture
 * @description
 *   Listens to bot-edit events for every file at the renderer-global layer
 *   (outside EditorPane). EditorPane handles edits to the active file directly
 *   (it needs the Monaco editor instance); edits to inactive files are buffered
 *   here and applied when the user switches to the corresponding tab.
 */

import type { IDisposable } from '../../../../../shared/utils';
import type { CollaborationReviewKey } from './DiffReviewService';
import { createLogger } from '../LogService';
import { getDiffReviewService } from './DiffReviewService';
import { getOverleafLiveService } from './OverleafLiveService';
import { getEditorService } from './ServiceRegistry';

const logger = createLogger('DiffReviewBridge');

export interface PendingFileEdit {
  reviewKey: CollaborationReviewKey;
  originalContent: string;
  newContent: string;
  filePath: string;
  /** Creation timestamp; used by GC to purge expired entries */
  createdAt: number;
}

function serializeReviewKey(key: CollaborationReviewKey): string {
  return `${key.backend}:${key.projectId}:${key.fileId}`;
}

/** TTL for buffered edits: 30 minutes */
const PENDING_EDIT_TTL_MS = 30 * 60 * 1000;
/** GC sweep interval: 5 minutes */
const GC_INTERVAL_MS = 5 * 60 * 1000;

export class DiffReviewBridge implements IDisposable {
  private readonly pendingEdits = new Map<string, PendingFileEdit>();
  private readonly disposables: Array<(() => void) | { dispose(): void }> = [];
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Remote Overleaf bot edit (non-active file)
    this.disposables.push(
      getOverleafLiveService().onDidReceiveRemotePatch((update) => {
        if (update.sessionType !== 'bot') return;
        this.handleRemoteBotEdit({
          backend: 'scipen-ot',
          projectId: update.projectId,
          fileId: update.docId,
          content: update.content,
          version: update.version,
          source: 'Overleaf',
        });
      })
    );

    // Periodically purge expired buffered edits
    this.gcTimer = setInterval(() => this.purgeExpiredEdits(), GC_INTERVAL_MS);
  }

  /**
   * Shared remote bot-edit handler for OT and Overleaf.
   * Handles inactive files only; active-file edits go through EditorPane.
   */
  private handleRemoteBotEdit(params: {
    backend: CollaborationReviewKey['backend'];
    projectId: string;
    fileId: string;
    content: string;
    version: number;
    source: string;
  }): void {
    const activeFileId = getEditorService().activeTab?._id;
    if (params.fileId === activeFileId) return;

    const reviewKey: CollaborationReviewKey = {
      backend: params.backend,
      projectId: params.projectId,
      fileId: params.fileId,
    };
    const serialized = serializeReviewKey(reviewKey);
    const existing = this.pendingEdits.get(serialized);

    // Resolve the pre-edit content: reuse the first originalContent for accumulated edits,
    // otherwise pull from the already-open tab.
    const tab = getEditorService().tabs.find((entry) => entry._id === params.fileId);
    const tabContent = tab?.content ?? '';
    const baseContent = existing?.originalContent || tabContent;

    if (!baseContent) {
      // File has never been opened and no buffered baseline exists — we cannot recover
      // an exact pre-edit content. Still create a review (originalContent='' → full-text
      // additions in the diff) so the user sees the review instead of silently accepting
      // the bot's changes when they open the file.
      logger.info(
        `[Bridge] Inactive-file bot edit (${params.source}), file not open; creating full-text review: fileId=${params.fileId}`
      );
      const review = getDiffReviewService().createReview(
        params.fileId,
        existing?.filePath || '',
        '',
        params.content,
        { version: params.version, reviewKey }
      );
      if (review) {
        this.pendingEdits.set(serialized, {
          reviewKey,
          originalContent: '',
          newContent: params.content,
          filePath: existing?.filePath || '',
          createdAt: existing?.createdAt ?? Date.now(),
        });
      }
      return;
    }

    if (baseContent === params.content) return;

    logger.info(`[Bridge] Inactive-file bot edit (${params.source}): fileId=${params.fileId}`);
    const review = getDiffReviewService().createReview(
      params.fileId,
      '',
      baseContent,
      params.content,
      { version: params.version, reviewKey }
    );
    if (!review) {
      this.pendingEdits.delete(serialized);
      return;
    }
    this.pendingEdits.set(serialized, {
      reviewKey,
      originalContent: baseContent,
      newContent: params.content,
      filePath: existing?.filePath || '',
      createdAt: existing?.createdAt ?? Date.now(),
    });
  }

  consumePendingEdit(fileId: string, reviewKey?: CollaborationReviewKey): PendingFileEdit | null {
    const key = reviewKey ? serializeReviewKey(reviewKey) : null;
    const edit = key
      ? this.pendingEdits.get(key)
      : Array.from(this.pendingEdits.values()).find((entry) => entry.reviewKey.fileId === fileId);
    if (edit) {
      this.pendingEdits.delete(serializeReviewKey(edit.reviewKey));
      logger.info(`[Bridge] Consumed buffered edit: fileId=${fileId}`);
    }
    return edit ?? null;
  }

  hasPendingEdit(fileId: string, reviewKey?: CollaborationReviewKey): boolean {
    if (reviewKey) {
      return this.pendingEdits.has(serializeReviewKey(reviewKey));
    }
    return Array.from(this.pendingEdits.values()).some(
      (entry) => entry.reviewKey.fileId === fileId
    );
  }

  /** Purge buffered edits older than TTL */
  private purgeExpiredEdits(): void {
    const now = Date.now();
    let purged = 0;
    for (const [key, edit] of this.pendingEdits) {
      if (now - edit.createdAt > PENDING_EDIT_TTL_MS) {
        this.pendingEdits.delete(key);
        getDiffReviewService().clearReviewForFile(edit.reviewKey.fileId, edit.reviewKey);
        purged++;
      }
    }
    if (purged > 0) {
      logger.info(`[Bridge] GC purged ${purged} expired buffered edits`);
    }
  }

  dispose(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    this.disposables.forEach((disposable) =>
      typeof disposable === 'function' ? disposable() : disposable.dispose()
    );
    this.pendingEdits.clear();
  }
}

let bridge: DiffReviewBridge | null = null;

export function getDiffReviewBridge(): DiffReviewBridge {
  if (!bridge) bridge = new DiffReviewBridge();
  return bridge;
}
