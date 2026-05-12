/**
 * @file DiffReviewService.ts — AI Diff Review lifecycle manager
 * @description Tracks pending review state for OpenClaw AI edits. When a remote OT
 *   update is identified as a bot edit, creates a review entry (with diff hunks)
 *   that EditorPane renders as inline diff decorations with Accept/Reject buttons.
 */

import DiffMatchPatch from 'diff-match-patch';
import type { CollaborationBackend } from '../../../../../shared/api-types';
import { Emitter, type Event, type IDisposable } from '../../../../../shared/utils';
import { getPlatform } from '../../utils';

// ====== Data structures ======

export interface DiffHunk {
  id: string;
  type: 'added' | 'removed' | 'modified';
  /** Starting line in the new content (1-based) */
  startLine: number;
  /** Ending line in the new content (1-based, inclusive) */
  endLine: number;
  /** Original text that was deleted/replaced */
  originalText: string;
  /** Inserted/replacement text */
  newText: string;
}

export interface CollaborationReviewKey {
  backend: CollaborationBackend;
  projectId: string;
  fileId: string;
}

export interface PendingReview {
  id: string;
  reviewKey: CollaborationReviewKey;
  fileId: string;
  filePath: string;
  normalizedFilePath: string;
  hunks: DiffHunk[];
  originalFullContent: string;
  newFullContent: string;
  timestamp: number;
  sourceVersion?: number;
  sourceMessageId?: string;
  sourceConversationId?: string;
  sourceProposalFilePath?: string;
}

interface ReviewSourceOptions {
  messageId: string;
  conversationId?: string;
  proposalFilePath: string;
  normalizedFilePath: string;
}

interface CreateReviewOptions {
  version?: number;
  reviewKey?: CollaborationReviewKey;
  source?: ReviewSourceOptions;
}

export interface LatestPendingReviewSource {
  reviewId: string;
  reviewKey: CollaborationReviewKey;
  messageId: string;
  normalizedFilePath: string;
}

// ====== Diff computation ======

const dmp = new DiffMatchPatch();

let nextReviewId = 1;
let nextHunkId = 1;

export function normalizeReviewPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) {
    return normalized;
  }
  return getPlatform() === 'windows' ? normalized.toLowerCase() : normalized;
}

function normalizeReviewKey(key: CollaborationReviewKey): CollaborationReviewKey {
  if (key.backend !== 'local') {
    return key;
  }
  return {
    backend: key.backend,
    projectId: normalizeReviewPath(key.projectId),
    fileId: normalizeReviewPath(key.fileId),
  };
}

function serializeReviewKey(key: CollaborationReviewKey): string {
  const normalizedKey = normalizeReviewKey(key);
  return `${normalizedKey.backend}:${normalizedKey.projectId}:${normalizedKey.fileId}`;
}

function serializeMessagePathKey(messageId: string, normalizedFilePath: string): string {
  return `${messageId}:${normalizedFilePath}`;
}

function fallbackReviewKey(fileId: string): CollaborationReviewKey {
  return {
    backend: 'scipen-ot',
    projectId: '__legacy__',
    fileId,
  };
}

function normalizeFileIdentity(fileId: string, reviewKey?: CollaborationReviewKey): string {
  if (reviewKey?.backend === 'local') {
    return normalizeReviewPath(reviewKey.fileId || fileId);
  }
  return fileId;
}

function normalizeDisplayFilePath(
  filePath: string,
  reviewKey: CollaborationReviewKey,
  fileId: string
): string {
  if (filePath) {
    return reviewKey.backend === 'local' ? normalizeReviewPath(filePath) : filePath;
  }
  return reviewKey.backend === 'local' ? normalizeReviewPath(fileId) : filePath;
}

/**
 * Build the reviewKey for a DiffReview — all modules must use this helper.
 *
 * - OT mode (projectId set): `scipen-ot:{projectId}:{otFileId}`
 * - IM-only mode (no OT): `local:{rootPath}:{filePath}`
 */
export function buildReviewKey(
  context: { projectId: string; rootPath: string },
  otFileId: string | undefined,
  filePath: string
): CollaborationReviewKey {
  if (context.projectId && otFileId) {
    return { backend: 'scipen-ot', projectId: context.projectId, fileId: otFileId };
  }
  return {
    backend: 'local',
    projectId: normalizeReviewPath(context.rootPath),
    fileId: normalizeReviewPath(filePath),
  };
}

/** Count effective lines (trailing empty line excluded) */
function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function computeLineHunks(originalContent: string, newContent: string): DiffHunk[] {
  const lineData = dmp.diff_linesToChars_(originalContent, newContent);
  const diffs = dmp.diff_main(lineData.chars1, lineData.chars2, false);
  dmp.diff_charsToLines_(diffs, lineData.lineArray);
  dmp.diff_cleanupSemantic(diffs);

  const hunks: DiffHunk[] = [];
  let currentLine = 1;

  let i = 0;
  while (i < diffs.length) {
    const [op, text] = diffs[i];

    if (op === 0) {
      currentLine += countLines(text);
      i += 1;
      continue;
    }

    let removedText = '';
    let addedText = '';
    const hunkStartLine = currentLine;

    while (i < diffs.length && diffs[i][0] !== 0) {
      const [hunkOp, hunkText] = diffs[i];
      if (hunkOp === -1) {
        removedText += hunkText;
      } else if (hunkOp === 1) {
        addedText += hunkText;
      }
      i += 1;
    }

    const addedLineCount = countLines(addedText);
    const endLine = hunkStartLine + Math.max(0, addedLineCount - 1);

    let type: DiffHunk['type'];
    if (removedText && addedText) {
      type = 'modified';
    } else if (removedText) {
      type = 'removed';
    } else {
      type = 'added';
    }

    hunks.push({
      id: `hunk-${nextHunkId++}`,
      type,
      startLine: hunkStartLine,
      endLine: Math.max(hunkStartLine, endLine),
      originalText: removedText,
      newText: addedText,
    });

    currentLine = hunkStartLine + addedLineCount;
  }

  return hunks;
}

export function createPreviewReview(
  reviewKey: CollaborationReviewKey,
  filePath: string,
  originalContent: string,
  newContent: string,
  sourceVersion?: number
): PendingReview | null {
  const normalizedReviewKey = normalizeReviewKey(reviewKey);
  const normalizedFileId = normalizeFileIdentity(normalizedReviewKey.fileId, normalizedReviewKey);
  const normalizedFilePath = normalizeDisplayFilePath(
    filePath,
    normalizedReviewKey,
    normalizedFileId
  );
  const hunks = computeLineHunks(originalContent, newContent);
  if (hunks.length === 0) {
    return null;
  }
  return {
    id: `preview-review-${nextReviewId++}`,
    reviewKey: normalizedReviewKey,
    fileId: normalizedFileId,
    filePath: normalizedFilePath,
    normalizedFilePath,
    hunks,
    originalFullContent: originalContent,
    newFullContent: newContent,
    timestamp: Date.now(),
    sourceVersion,
  };
}

// ====== Service ======

/** Per-review TTL: 60 minutes without activity */
const REVIEW_TTL_MS = 60 * 60 * 1000;
/** Maximum number of reviews retained; oldest is evicted when exceeded */
const MAX_REVIEWS = 50;

export class DiffReviewService implements IDisposable {
  private readonly reviews = new Map<string, PendingReview>();
  private readonly reviewIndex = new Map<string, string>(); // serialized reviewKey -> reviewId
  private readonly reviewIdsByMessageId = new Map<string, Set<string>>();
  private readonly reviewIdByMessageAndPath = new Map<string, string>();
  private readonly latestVersionByReviewKey = new Map<string, number>();

  private readonly _onDidAddReview = new Emitter<PendingReview>();
  readonly onDidAddReview: Event<PendingReview> = this._onDidAddReview.event;

  private readonly _onDidRemoveReview = new Emitter<string>();
  readonly onDidRemoveReview: Event<string> = this._onDidRemoveReview.event;

  private readonly _onDidUpdateReview = new Emitter<PendingReview>();
  readonly onDidUpdateReview: Event<PendingReview> = this._onDidUpdateReview.event;

  private indexReviewSource(review: PendingReview): void {
    if (!review.sourceMessageId) {
      return;
    }
    const reviewIds = this.reviewIdsByMessageId.get(review.sourceMessageId) ?? new Set<string>();
    reviewIds.add(review.id);
    this.reviewIdsByMessageId.set(review.sourceMessageId, reviewIds);
    this.reviewIdByMessageAndPath.set(
      serializeMessagePathKey(review.sourceMessageId, review.normalizedFilePath),
      review.id
    );
  }

  private removeReviewSourceIndex(review: PendingReview): void {
    if (!review.sourceMessageId) {
      return;
    }
    const reviewIds = this.reviewIdsByMessageId.get(review.sourceMessageId);
    if (reviewIds) {
      reviewIds.delete(review.id);
      if (reviewIds.size === 0) {
        this.reviewIdsByMessageId.delete(review.sourceMessageId);
      }
    }
    this.reviewIdByMessageAndPath.delete(
      serializeMessagePathKey(review.sourceMessageId, review.normalizedFilePath)
    );
  }

  private removeReviewById(reviewId: string): PendingReview | null {
    const review = this.reviews.get(reviewId);
    if (!review) {
      return null;
    }
    this.reviews.delete(reviewId);
    this.reviewIndex.delete(serializeReviewKey(review.reviewKey));
    this.removeReviewSourceIndex(review);
    this._onDidRemoveReview.fire(reviewId);
    return review;
  }

  createReview(
    fileId: string,
    filePath: string,
    originalContent: string,
    newContent: string,
    options?: CreateReviewOptions
  ): PendingReview | null {
    const reviewKey = normalizeReviewKey(options?.reviewKey ?? fallbackReviewKey(fileId));
    const normalizedFileId = normalizeFileIdentity(fileId, reviewKey);
    const normalizedFilePath = normalizeDisplayFilePath(filePath, reviewKey, normalizedFileId);
    const normalizedSourceFilePath = options?.source?.normalizedFilePath
      ? normalizeReviewPath(options.source.normalizedFilePath)
      : normalizedFilePath;
    const source = options?.source
      ? {
          ...options.source,
          normalizedFilePath: normalizedSourceFilePath,
        }
      : undefined;

    const serializedKey = serializeReviewKey(reviewKey);
    const existingReview = this.getReviewForFile(normalizedFileId, reviewKey);

    if (
      options?.version !== undefined &&
      this.latestVersionByReviewKey.has(serializedKey) &&
      options.version <= (this.latestVersionByReviewKey.get(serializedKey) ?? -1)
    ) {
      return existingReview;
    }

    if (
      existingReview &&
      existingReview.originalFullContent === originalContent &&
      existingReview.newFullContent === newContent &&
      existingReview.normalizedFilePath === normalizedSourceFilePath &&
      existingReview.sourceMessageId === source?.messageId &&
      (options?.version === undefined || existingReview.sourceVersion === options.version)
    ) {
      return existingReview;
    }

    if (source) {
      const existingMappedReviewId = this.reviewIdByMessageAndPath.get(
        serializeMessagePathKey(source.messageId, normalizedSourceFilePath)
      );
      if (
        existingMappedReviewId &&
        existingMappedReviewId !== this.reviewIndex.get(serializedKey)
      ) {
        this.removeReviewById(existingMappedReviewId);
      }
    }

    const existingId = this.reviewIndex.get(serializedKey);
    if (existingId) {
      this.removeReviewById(existingId);
    }

    const hunks = computeLineHunks(originalContent, newContent);
    if (options?.version !== undefined) {
      this.latestVersionByReviewKey.set(serializedKey, options.version);
    }
    if (hunks.length === 0) {
      this.reviewIndex.delete(serializedKey);
      return null;
    }

    const review: PendingReview = {
      id: `review-${nextReviewId++}`,
      reviewKey,
      fileId: normalizedFileId,
      filePath: normalizedFilePath,
      normalizedFilePath: normalizedSourceFilePath,
      hunks,
      originalFullContent: originalContent,
      newFullContent: newContent,
      timestamp: Date.now(),
      sourceVersion: options?.version,
      sourceMessageId: source?.messageId,
      sourceConversationId: source?.conversationId,
      sourceProposalFilePath: source?.proposalFilePath,
    };

    this.reviews.set(review.id, review);
    this.reviewIndex.set(serializedKey, review.id);
    this.indexReviewSource(review);
    this.evictStaleReviews();
    this._onDidAddReview.fire(review);
    return review;
  }

  /** Evict expired and over-limit reviews */
  private evictStaleReviews(): void {
    const now = Date.now();
    for (const [id, review] of this.reviews) {
      if (now - review.timestamp > REVIEW_TTL_MS) {
        this.removeReviewById(id);
      }
    }
    if (this.reviews.size > MAX_REVIEWS) {
      const sorted = Array.from(this.reviews.entries()).sort(
        (a, b) => a[1].timestamp - b[1].timestamp
      );
      const toRemove = sorted.slice(0, this.reviews.size - MAX_REVIEWS);
      for (const [id] of toRemove) {
        this.removeReviewById(id);
      }
    }
  }

  clearReviewForFile(fileId: string, reviewKey?: CollaborationReviewKey): void {
    const normalizedReviewKey = reviewKey ? normalizeReviewKey(reviewKey) : undefined;
    const serializedKey = serializeReviewKey(normalizedReviewKey ?? fallbackReviewKey(fileId));
    const reviewId = this.reviewIndex.get(serializedKey);
    if (reviewId) {
      this.removeReviewById(reviewId);
      return;
    }
    const review = this.getReviewForFile(fileId, normalizedReviewKey);
    if (review) {
      this.removeReviewById(review.id);
    }
  }

  clearLocalReviewsExceptProject(projectRootPath: string): void {
    const normalizedProjectRoot = normalizeReviewPath(projectRootPath);
    for (const [reviewId, review] of this.reviews) {
      if (
        review.reviewKey.backend === 'local' &&
        review.reviewKey.projectId !== normalizedProjectRoot
      ) {
        this.removeReviewById(reviewId);
      }
    }
  }

  clearAllReviews(): void {
    for (const reviewId of Array.from(this.reviews.keys())) {
      this.removeReviewById(reviewId);
    }
  }

  acceptReview(reviewId: string): void {
    this.removeReviewById(reviewId);
  }

  rejectReview(reviewId: string): { originalFullContent: string } | null {
    const review = this.reviews.get(reviewId);
    if (!review) return null;
    const { originalFullContent } = review;
    this.removeReviewById(reviewId);
    return { originalFullContent };
  }

  acceptHunk(reviewId: string, hunkId: string): void {
    const review = this.reviews.get(reviewId);
    if (!review) return;
    review.hunks = review.hunks.filter((hunk) => hunk.id !== hunkId);
    if (review.hunks.length === 0) {
      this.acceptReview(reviewId);
    } else {
      this._onDidUpdateReview.fire(review);
    }
  }

  rejectHunk(reviewId: string, hunkId: string): { hunk: DiffHunk } | null {
    const review = this.reviews.get(reviewId);
    if (!review) return null;
    const hunk = review.hunks.find((entry) => entry.id === hunkId);
    if (!hunk) return null;

    const lines = review.newFullContent.split('\n');
    const startIdx = hunk.startLine - 1;
    const deleteCount = hunk.type === 'removed' ? 0 : hunk.endLine - hunk.startLine + 1;
    const insertLines = hunk.originalText ? hunk.originalText.split('\n') : [];
    if (insertLines.length > 0 && insertLines[insertLines.length - 1] === '') {
      insertLines.pop();
    }
    lines.splice(startIdx, deleteCount, ...insertLines);
    review.newFullContent = lines.join('\n');

    let lineDelta = 0;
    if (hunk.type === 'added') {
      lineDelta = -countLines(hunk.newText);
    } else if (hunk.type === 'removed') {
      lineDelta = countLines(hunk.originalText);
    } else {
      lineDelta = countLines(hunk.originalText) - countLines(hunk.newText);
    }

    const rejectedEndLine = hunk.endLine;
    review.hunks = review.hunks.filter((entry) => entry.id !== hunkId);
    if (lineDelta !== 0) {
      for (const entry of review.hunks) {
        if (entry.startLine > rejectedEndLine) {
          entry.startLine += lineDelta;
          entry.endLine += lineDelta;
        }
      }
    }

    if (review.hunks.length === 0) {
      this.removeReviewById(reviewId);
    } else {
      this._onDidUpdateReview.fire(review);
    }
    return { hunk };
  }

  applyLineDelta(
    fileId: string,
    editStartLine: number,
    lineDelta: number,
    reviewKey?: CollaborationReviewKey
  ): void {
    if (lineDelta === 0) return;
    const review = this.getReviewForFile(fileId, reviewKey);
    if (!review) return;

    let changed = false;
    for (const hunk of review.hunks) {
      if (hunk.startLine >= editStartLine) {
        hunk.startLine += lineDelta;
        hunk.endLine += lineDelta;
        changed = true;
      }
    }
    if (changed) {
      this._onDidUpdateReview.fire(review);
    }
  }

  getReviewForFile(fileId: string, reviewKey?: CollaborationReviewKey): PendingReview | null {
    if (reviewKey) {
      const reviewId = this.reviewIndex.get(serializeReviewKey(reviewKey));
      if (!reviewId) return null;
      return this.reviews.get(reviewId) ?? null;
    }
    const normalizedFileId = normalizeReviewPath(fileId);
    for (const review of this.reviews.values()) {
      if (
        review.fileId === fileId ||
        (review.reviewKey.backend === 'local' && review.fileId === normalizedFileId)
      ) {
        return review;
      }
    }
    return null;
  }

  getPendingReviewForMessageFile(messageId: string, fullPath: string): PendingReview | null {
    const reviewId = this.reviewIdByMessageAndPath.get(
      serializeMessagePathKey(messageId, normalizeReviewPath(fullPath))
    );
    if (!reviewId) {
      return null;
    }
    return this.reviews.get(reviewId) ?? null;
  }

  hasPendingReviewForMessageFile(messageId: string, fullPath: string): boolean {
    return Boolean(this.getPendingReviewForMessageFile(messageId, fullPath));
  }

  getLatestPendingReviewSource(): LatestPendingReviewSource | null {
    let latest: PendingReview | null = null;
    for (const review of this.reviews.values()) {
      if (!review.sourceMessageId) {
        continue;
      }
      if (!latest || review.timestamp >= latest.timestamp) {
        latest = review;
      }
    }
    if (!latest?.sourceMessageId) {
      return null;
    }
    return {
      reviewId: latest.id,
      reviewKey: latest.reviewKey,
      messageId: latest.sourceMessageId,
      normalizedFilePath: latest.normalizedFilePath,
    };
  }

  getPendingReviews(): PendingReview[] {
    return Array.from(this.reviews.values()).sort(
      (left, right) => right.timestamp - left.timestamp
    );
  }

  hasActiveReviews(): boolean {
    return this.reviews.size > 0;
  }

  getAllReviewFileIds(): string[] {
    return Array.from(new Set(Array.from(this.reviews.values()).map((review) => review.fileId)));
  }

  dispose(): void {
    this.reviews.clear();
    this.reviewIndex.clear();
    this.reviewIdsByMessageId.clear();
    this.reviewIdByMessageAndPath.clear();
    this.latestVersionByReviewKey.clear();
    this._onDidAddReview.dispose();
    this._onDidRemoveReview.dispose();
    this._onDidUpdateReview.dispose();
  }
}

// ====== Singleton ======

let instance: DiffReviewService | null = null;

export function getDiffReviewService(): DiffReviewService {
  if (!instance) {
    instance = new DiffReviewService();
  }
  return instance;
}
