import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildReviewKey,
  DiffReviewService,
} from '../../../src/renderer/src/services/core/DiffReviewService';

function setPlatform(platform: string) {
  const current = (window as unknown as { electron?: Record<string, unknown> }).electron ?? {};
  Object.defineProperty(window, 'electron', {
    value: { ...current, platform, ipcRenderer: current.ipcRenderer ?? {} },
    writable: true,
  });
}

describe('DiffReviewService', () => {
  beforeEach(() => {
    setPlatform('win32');
  });

  it('maps different case and slash forms to the same local review on Windows', () => {
    const service = new DiffReviewService();
    const fullPath = 'D:\\Demo\\Abstract.txt';
    const reviewKey = buildReviewKey({ projectId: '', rootPath: 'D:\\Demo' }, undefined, fullPath);

    service.createReview(fullPath, fullPath, 'old', 'new', {
      reviewKey,
      source: {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        proposalFilePath: 'Abstract.txt',
        normalizedFilePath: fullPath,
      },
    });

    const review = service.getReviewForFile('d:/demo/abstract.txt', reviewKey);

    expect(reviewKey.projectId).toBe('d:/demo');
    expect(reviewKey.fileId).toBe('d:/demo/abstract.txt');
    expect(review?.fileId).toBe('d:/demo/abstract.txt');
    expect(service.hasPendingReviewForMessageFile('msg-1', 'D:/DEMO/ABSTRACT.TXT')).toBe(true);
  });

  it('new review for the same file overrides the old message mapping', () => {
    const service = new DiffReviewService();
    const fullPath = 'D:\\Demo\\abstract.txt';
    const reviewKey = buildReviewKey({ projectId: '', rootPath: 'D:\\Demo' }, undefined, fullPath);

    service.createReview(fullPath, fullPath, 'old', 'new-v1', {
      reviewKey,
      source: {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        proposalFilePath: 'abstract.txt',
        normalizedFilePath: fullPath,
      },
    });

    const nextReview = service.createReview(fullPath, fullPath, 'old', 'new-v2', {
      reviewKey,
      source: {
        messageId: 'msg-2',
        conversationId: 'conv-1',
        proposalFilePath: 'abstract.txt',
        normalizedFilePath: fullPath,
      },
    });

    expect(service.getPendingReviewForMessageFile('msg-1', fullPath)).toBeNull();
    expect(service.getPendingReviewForMessageFile('msg-2', fullPath)?.id).toBe(nextReview?.id);
    expect(service.getPendingReviews()).toHaveLength(1);
  });

  it('latest pending source always returns the most recent live review source and ignores reviews without a message source', () => {
    const service = new DiffReviewService();
    const fileA = 'D:\\Demo\\a.txt';
    const fileB = 'D:\\Demo\\b.txt';

    const reviewKeyA = buildReviewKey({ projectId: '', rootPath: 'D:\\Demo' }, undefined, fileA);
    const reviewKeyB = buildReviewKey({ projectId: '', rootPath: 'D:\\Demo' }, undefined, fileB);

    service.createReview(fileA, fileA, 'old-a', 'new-a', {
      reviewKey: reviewKeyA,
      source: {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        proposalFilePath: 'a.txt',
        normalizedFilePath: fileA,
      },
    });

    const reviewB = service.createReview(fileB, fileB, 'old-b', 'new-b', {
      reviewKey: reviewKeyB,
      source: {
        messageId: 'msg-2',
        conversationId: 'conv-1',
        proposalFilePath: 'b.txt',
        normalizedFilePath: fileB,
      },
    });

    service.createReview('ot-file-1', '', 'before', 'after', {
      reviewKey: {
        backend: 'scipen-ot',
        projectId: 'project-1',
        fileId: 'ot-file-1',
      },
    });

    expect(service.getLatestPendingReviewSource()).toEqual({
      reviewId: reviewB?.id,
      reviewKey: reviewB?.reviewKey,
      messageId: 'msg-2',
      normalizedFilePath: 'd:/demo/b.txt',
    });
  });

  it('only retains local reviews for the current project when switching projects', () => {
    const service = new DiffReviewService();
    const projectAPath = 'D:\\Demo\\ProjectA\\chapter1.txt';
    const projectBPath = 'D:\\Demo\\ProjectB\\chapter1.txt';

    const reviewKeyA = buildReviewKey(
      { projectId: '', rootPath: 'D:\\Demo\\ProjectA' },
      undefined,
      projectAPath
    );
    const reviewKeyB = buildReviewKey(
      { projectId: '', rootPath: 'D:\\Demo\\ProjectB' },
      undefined,
      projectBPath
    );

    service.createReview(projectAPath, projectAPath, 'old-a', 'new-a', {
      reviewKey: reviewKeyA,
      source: {
        messageId: 'msg-a',
        conversationId: 'conv-1',
        proposalFilePath: 'chapter1.txt',
        normalizedFilePath: projectAPath,
      },
    });

    service.createReview(projectBPath, projectBPath, 'old-b', 'new-b', {
      reviewKey: reviewKeyB,
      source: {
        messageId: 'msg-b',
        conversationId: 'conv-2',
        proposalFilePath: 'chapter1.txt',
        normalizedFilePath: projectBPath,
      },
    });

    service.clearLocalReviewsExceptProject('D:\\Demo\\ProjectB');

    expect(service.getPendingReviewForMessageFile('msg-a', projectAPath)).toBeNull();
    expect(service.getPendingReviewForMessageFile('msg-b', projectBPath)?.reviewKey.projectId).toBe(
      'd:/demo/projectb'
    );
    expect(service.getPendingReviews()).toHaveLength(1);
  });
});
