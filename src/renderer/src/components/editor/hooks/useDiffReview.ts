/**
 * @file useDiffReview.ts - Diff Review State & Actions Hook
 * @description Review state derivation, accept/reject review/hunk, hunk navigation, decorations, line tracking
 */

/* eslint-disable react/exhaustive-deps -- Monaco/editor refs and mutable review refs are intentionally consumed imperatively in this hook module. */

import type { Monaco } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEvent } from '../../../hooks';
import { t } from '../../../locales';
import {
  getDiffReviewService,
  type CollaborationReviewKey,
  type PendingReview,
  normalizeReviewPath,
} from '../../../services/core/DiffReviewService';
import { getDiffReviewBridge } from '../../../services/core/DiffReviewBridge';
import {
  renderDiffReview,
  renderDiffReviewWithSweep,
  clearDiffReview,
  computeTotalChangedLines,
  type DiffDecorationState,
} from '../DiffReviewRenderer';
import { computeSingleEdit } from '../utils/editorModelHelpers';

export interface UseDiffReviewParams {
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  monacoRef: React.RefObject<Monaco | null>;
  isProgrammaticUpdateRef: React.MutableRefObject<boolean>;
  activeTab: { _id?: string; name: string; path: string; content: string } | undefined;
  activeReviewKey: CollaborationReviewKey | null;
  runtime: {
    projectId: string;
  };
}

export interface UseDiffReviewReturn {
  displayReview: PendingReview | null;
  reviewFileIds: Set<string>;
  pendingReviewSummary: {
    fileName: string;
    hunkCount: number;
    lineCount: number;
    disabled: boolean;
  } | null;
  diffStateRef: React.MutableRefObject<DiffDecorationState | null>;
  reviewEditSuppressRef: React.MutableRefObject<boolean>;
  handleAcceptReview: () => void;
  handleRejectReview: () => void;
  handleAcceptHunk: (hunkId: string) => void;
  handleRejectHunk: (hunkId: string) => void;
  handleJumpToReviewHunk: (direction?: 'next' | 'prev') => void;
  applyBotEditToReview: (
    editor: monaco.editor.IStandaloneCodeEditor,
    monacoInstance: Monaco,
    reviewKey: CollaborationReviewKey,
    fileId: string,
    newContent: string,
    version: number,
    preApplyOriginal?: string
  ) => void;
  /** Restore diff review decorations when switching to a tab (called from tab switch effect) */
  restoreReviewForTab: (
    editor: monaco.editor.IStandaloneCodeEditor,
    monacoInstance: Monaco,
    fileId: string
  ) => void;
}

export function useDiffReview({
  editorRef,
  monacoRef,
  isProgrammaticUpdateRef,
  activeTab,
  activeReviewKey,
}: UseDiffReviewParams): UseDiffReviewReturn {
  const diffStateRef = useRef<DiffDecorationState | null>(null);
  // Suppress content-change events emitted by review-internal edits (reject hunk) so they don't
  // double-shift hunk line numbers.
  const reviewEditSuppressRef = useRef(false);
  // reviewTick drives currentReview recomputation (service events bump the tick).
  const [reviewTick, setReviewTick] = useState(0);
  // OT mode uses _id; local mode uses the normalized path (forward slashes, matching buildReviewKey).
  const activeFileIdentity =
    activeReviewKey?.fileId ??
    activeTab?._id ??
    (activeTab?.path ? normalizeReviewPath(activeTab.path) : null);

  // currentReview is derived from the service and recomputed whenever reviewTick changes.
  const currentReview = useMemo(() => {
    void reviewTick; // intentional dependency
    if (!activeFileIdentity) return null;
    return getDiffReviewService().getReviewForFile(
      activeFileIdentity,
      activeReviewKey ?? undefined
    );
  }, [activeFileIdentity, activeReviewKey, reviewTick]);

  const displayReview = currentReview;

  // Editor-internal: tab orange dot reads the service's file-level review set and is not reused by IM.
  const reviewFileIds = useMemo(() => {
    void reviewTick;
    return new Set(getDiffReviewService().getAllReviewFileIds());
  }, [reviewTick]);

  // Ref exposes the latest review to keybinding handlers.
  const currentReviewRef = useRef(displayReview);
  currentReviewRef.current = displayReview;

  useEvent(
    getDiffReviewService().onDidRemoveReview,
    (removedReviewId) => {
      if (currentReview && currentReview.id !== removedReviewId) return;
      if (diffStateRef.current && editorRef.current) {
        clearDiffReview(editorRef.current, diffStateRef.current);
        diffStateRef.current = null;
      }
      setReviewTick((tick) => tick + 1);
    },
    [currentReview]
  );

  const handleJumpToReviewHunk = useCallback((direction: 'next' | 'prev' = 'next') => {
    const editor = editorRef.current;
    const review = currentReviewRef.current;
    if (!editor || !review || review.hunks.length === 0) return;

    const cursorLine = editor.getPosition()?.lineNumber ?? 1;
    let target: number | null = null;

    if (direction === 'next') {
      for (const h of review.hunks) {
        if (h.startLine > cursorLine) {
          target = h.startLine;
          break;
        }
      }
      if (target === null) target = review.hunks[0].startLine;
    } else {
      for (let i = review.hunks.length - 1; i >= 0; i -= 1) {
        if (review.hunks[i].startLine < cursorLine) {
          target = review.hunks[i].startLine;
          break;
        }
      }
      if (target === null) target = review.hunks[review.hunks.length - 1].startLine;
    }

    if (target !== null) {
      editor.setPosition({ lineNumber: target, column: 1 });
      editor.revealLineInCenter(target);
    }
  }, []);

  const handleAcceptReview = useCallback(() => {
    if (!currentReview) return;
    const editor = editorRef.current;
    const monacoInstance = monacoRef.current;
    const model = editor?.getModel();

    // Proposal mode: the current content is still originalFullContent, so Accept must write newFullContent.
    // OT bot-edit mode: the content is already newFullContent, so Accept only clears the review state.
    if (editor && monacoInstance && model) {
      const currentContent = model.getValue();
      if (currentContent !== currentReview.newFullContent) {
        reviewEditSuppressRef.current = true;
        try {
          const forwardEdits = computeSingleEdit(
            currentContent,
            currentReview.newFullContent,
            model,
            monacoInstance
          );
          if (forwardEdits.length > 0) {
            model.pushEditOperations([], forwardEdits, () => null);
          }
        } finally {
          queueMicrotask(() => {
            reviewEditSuppressRef.current = false;
          });
        }
      }
    }

    getDiffReviewService().acceptReview(currentReview.id);
  }, [currentReview]);

  const handleRejectReview = useCallback(() => {
    if (!currentReview) return;
    const result = getDiffReviewService().rejectReview(currentReview.id);
    if (!result) return;
    const editor = editorRef.current;
    const monacoInstance = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monacoInstance || !model) return;
    reviewEditSuppressRef.current = true;
    try {
      const reverseEdits = computeSingleEdit(
        model.getValue(),
        result.originalFullContent,
        model,
        monacoInstance
      );
      if (reverseEdits.length > 0) {
        model.pushEditOperations([], reverseEdits, () => null);
      }
    } finally {
      queueMicrotask(() => {
        reviewEditSuppressRef.current = false;
      });
    }
  }, [currentReview]);

  const handleAcceptHunk = useCallback(
    (hunkId: string) => {
      if (!currentReview) return;
      const editor = editorRef.current;
      const monacoInstance = monacoRef.current;
      const model = editor?.getModel();

      // Proposal mode: the current content is still originalFullContent, so we compare against the post-accept content.
      // Strategy: if removing this hunk empties the review, collapse to the Accept-All flow (write newFullContent).
      // Otherwise just mark the hunk as accepted (decorations vanish) and write everything when the final Accept All fires.
      const remainingHunks = currentReview.hunks.filter((h) => h.id !== hunkId);
      if (remainingHunks.length === 0 && editor && monacoInstance && model) {
        // Last hunk — equivalent to Accept All
        const currentContent = model.getValue();
        if (currentContent !== currentReview.newFullContent) {
          reviewEditSuppressRef.current = true;
          try {
            const forwardEdits = computeSingleEdit(
              currentContent,
              currentReview.newFullContent,
              model,
              monacoInstance
            );
            if (forwardEdits.length > 0) {
              model.pushEditOperations([], forwardEdits, () => null);
            }
          } finally {
            queueMicrotask(() => {
              reviewEditSuppressRef.current = false;
            });
          }
        }
      }

      getDiffReviewService().acceptHunk(currentReview.id, hunkId);
    },
    [currentReview]
  );

  const handleRejectHunk = useCallback(
    (hunkId: string) => {
      if (!currentReview) return;
      // rejectHunk already applies the hunk line shift internally; suppress the content-change listener to avoid double-shifting.
      const result = getDiffReviewService().rejectHunk(currentReview.id, hunkId);
      if (!result) return;
      const editor = editorRef.current;
      const monacoInstance = monacoRef.current;
      const model = editor?.getModel();
      if (!editor || !monacoInstance || !model) return;
      const { hunk } = result;
      reviewEditSuppressRef.current = true;
      try {
        if (hunk.type === 'added') {
          const range = new monacoInstance.Range(hunk.startLine, 1, hunk.endLine + 1, 1);
          model.pushEditOperations([], [{ range, text: '' }], () => null);
        } else if (hunk.type === 'removed') {
          const pos = new monacoInstance.Range(hunk.startLine, 1, hunk.startLine, 1);
          model.pushEditOperations([], [{ range: pos, text: hunk.originalText }], () => null);
        } else {
          const range = new monacoInstance.Range(
            hunk.startLine,
            1,
            hunk.endLine,
            Number.MAX_SAFE_INTEGER
          );
          const replacementText = hunk.originalText.endsWith('\n')
            ? hunk.originalText.slice(0, -1)
            : hunk.originalText;
          model.pushEditOperations([], [{ range, text: replacementText }], () => null);
        }
      } finally {
        queueMicrotask(() => {
          reviewEditSuppressRef.current = false;
        });
      }
    },
    [currentReview]
  );

  // Watch review events: refresh decorations and bump the tick.
  useEvent(getDiffReviewService().onDidAddReview, (addedReview) => {
    setReviewTick((t) => t + 1);
    // If the new review targets the currently open tab, render decorations immediately.
    if (
      addedReview.fileId === activeFileIdentity &&
      (!activeReviewKey ||
        (addedReview.reviewKey.backend === activeReviewKey.backend &&
          addedReview.reviewKey.projectId === activeReviewKey.projectId))
    ) {
      const editor = editorRef.current;
      const monacoInstance = monacoRef.current;
      if (editor && monacoInstance) {
        if (diffStateRef.current) clearDiffReview(editor, diffStateRef.current);
        diffStateRef.current = renderDiffReviewWithSweep(editor, monacoInstance, addedReview);
      }
    }
  });

  useEvent(getDiffReviewService().onDidUpdateReview, (updatedReview) => {
    setReviewTick((t) => t + 1);
    if (
      updatedReview.fileId === activeFileIdentity &&
      (!activeReviewKey ||
        (updatedReview.reviewKey.backend === activeReviewKey.backend &&
          updatedReview.reviewKey.projectId === activeReviewKey.projectId))
    ) {
      const editor = editorRef.current;
      const monacoInstance = monacoRef.current;
      if (editor && monacoInstance) {
        if (diffStateRef.current) clearDiffReview(editor, diffStateRef.current);
        diffStateRef.current = renderDiffReview(editor, monacoInstance, updatedReview);
      }
    }
  });

  // ====== Diff Review: track hunk line numbers across user-local edits ======

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const disposable = editor.onDidChangeModelContent((event) => {
      // Track only manual user edits; skip programmatic updates (OT / bot edits) and review-internal ops (reject hunk).
      if (isProgrammaticUpdateRef.current || reviewEditSuppressRef.current) return;
      const fileId = activeFileIdentity;
      if (!fileId) return;
      // Nothing to track without a pending review.
      if (!getDiffReviewService().getReviewForFile(fileId, activeReviewKey ?? undefined)) return;

      for (const change of event.changes) {
        const removedLines = change.range.endLineNumber - change.range.startLineNumber;
        const addedLines = change.text.split('\n').length - 1;
        const lineDelta = addedLines - removedLines;
        if (lineDelta !== 0) {
          getDiffReviewService().applyLineDelta(
            fileId,
            change.range.startLineNumber,
            lineDelta,
            activeReviewKey ?? undefined
          );
        }
      }
    });
    return () => disposable.dispose();
  }, [editorRef.current, activeFileIdentity, activeReviewKey]);

  // ====== Diff Review shortcuts: Alt+] next hunk, Alt+[ previous hunk ======

  useEffect(() => {
    const editor = editorRef.current;
    const monacoInstance = monacoRef.current;
    if (!editor || !monacoInstance) return;

    const d1 = editor.addAction({
      id: 'diffReview.nextHunk',
      label: 'Diff Review: Next Hunk',
      keybindings: [monacoInstance.KeyMod.Alt | monacoInstance.KeyCode.BracketRight],
      run: () => handleJumpToReviewHunk('next'),
    });
    const d2 = editor.addAction({
      id: 'diffReview.prevHunk',
      label: 'Diff Review: Previous Hunk',
      keybindings: [monacoInstance.KeyMod.Alt | monacoInstance.KeyCode.BracketLeft],
      run: () => handleJumpToReviewHunk('prev'),
    });

    return () => {
      d1.dispose();
      d2.dispose();
    };
  }, [editorRef.current, monacoRef.current, handleJumpToReviewHunk]);

  const pendingReviewSummary = useMemo(() => {
    if (!displayReview) return null;
    const fileName =
      activeTab?.name || displayReview.filePath.split(/[\\/]/).pop() || t('diffReview.aiChanges');
    return {
      fileName,
      hunkCount: displayReview.hunks.length,
      lineCount: computeTotalChangedLines(displayReview.hunks),
      disabled: false,
    };
  }, [activeTab?.name, displayReview]);

  /**
   * Shared bot-edit → Diff Review handler (used by both OT and Overleaf flows).
   * Accumulation policy: if a review already exists keep the initial originalContent; otherwise use the current model content.
   */
  const applyBotEditToReview = useCallback(
    (
      editor: monaco.editor.IStandaloneCodeEditor,
      monacoInstance: Monaco,
      reviewKey: CollaborationReviewKey,
      fileId: string,
      newContent: string,
      version: number,
      preApplyOriginal?: string
    ) => {
      const model = editor.getModel();
      if (!model) return;
      const existingReview = getDiffReviewService().getReviewForFile(fileId, reviewKey);
      const originalContent =
        existingReview?.originalFullContent ?? preApplyOriginal ?? model.getValue();
      const review = getDiffReviewService().createReview(fileId, '', originalContent, newContent, {
        version,
        reviewKey,
      });
      if (!review) return;
      if (diffStateRef.current) clearDiffReview(editor, diffStateRef.current);
      diffStateRef.current = renderDiffReviewWithSweep(editor, monacoInstance, review);
      setReviewTick((t) => t + 1);
    },
    []
  );

  // OT remote update with applyRemoteUpdate inlined
  /** Restore diff review decorations when switching to a tab */
  const restoreReviewForTab = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor, monacoInstance: Monaco, fileId: string) => {
      // Consume inactive-file edits buffered by the Bridge (the tab was inactive when the bot edit arrived)
      const pendingEdit = getDiffReviewBridge().consumePendingEdit(
        fileId,
        activeReviewKey ?? undefined
      );
      if (pendingEdit) {
        const model = editor.getModel();
        if (model && model.getValue() !== pendingEdit.newContent) {
          const edits = computeSingleEdit(
            model.getValue(),
            pendingEdit.newContent,
            model,
            monacoInstance
          );
          if (edits.length > 0) model.pushEditOperations([], edits, () => null);
        }
      }

      // Restore review decorations for this file
      const review = getDiffReviewService().getReviewForFile(fileId, activeReviewKey ?? undefined);
      if (review && review.hunks.length > 0) {
        diffStateRef.current = pendingEdit
          ? renderDiffReviewWithSweep(editor, monacoInstance, review)
          : renderDiffReview(editor, monacoInstance, review);
        setReviewTick((t) => t + 1);
      }
    },
    [activeReviewKey]
  );

  return {
    displayReview,
    reviewFileIds,
    pendingReviewSummary,
    diffStateRef,
    reviewEditSuppressRef,
    handleAcceptReview,
    handleRejectReview,
    handleAcceptHunk,
    handleRejectHunk,
    handleJumpToReviewHunk,
    applyBotEditToReview,
    restoreReviewForTab,
  };
}
