/**
 * @file React Hooks bridge layer
 * @description Connect event-driven services with React via useSyncExternalStore
 */

import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { Event, IDisposable } from '../../../../../shared/utils';
import type { LatestPendingReviewSource, PendingReview } from './DiffReviewService';
import type { ProjectRuntimeState } from './ProjectRuntimeContext';
import {
  getEditorService,
  getProjectRuntimeContext,
  getProjectService,
  getSettingsService,
  getUIService,
} from './ServiceRegistry';
import { getDiffReviewService, normalizeReviewPath } from './DiffReviewService';

// ============ Generic Event Subscription Hooks ============

/** Subscribe to a service event and return latest snapshot. */
export function useServiceEvent<T, E = unknown>(event: Event<E>, getSnapshot: () => T): T {
  const eventRef = useRef(event);
  eventRef.current = event;

  const subscribe = useCallback((onStoreChange: () => void) => {
    const disposable = eventRef.current(() => onStoreChange());
    return () => disposable.dispose();
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Subscribe to multiple events and return latest snapshot. */
export function useServiceEvents<T>(events: Event<unknown>[], getSnapshot: () => T): T {
  const eventsRef = useRef(events);
  eventsRef.current = events;

  const subscribe = useCallback((onStoreChange: () => void) => {
    const disposables: IDisposable[] = eventsRef.current.map((e) => e(onStoreChange));
    return () => disposables.forEach((d) => d.dispose());
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ============ Editor Hooks ============

/** Returns current editor tabs. */
export function useEditorTabs() {
  const service = getEditorService();
  // Only subscribe to events affecting tab list, skip onDidChangeContent to avoid re-renders on typing
  return useServiceEvents(
    [service.onDidAddTab, service.onDidRemoveTab, service.onDidChangeDirtyState],
    () => service.tabs
  );
}

/** Returns the active editor tab. */
export function useActiveTab() {
  const service = getEditorService();
  return useServiceEvent(service.onDidChangeActiveTab, () => service.activeTab);
}

/** Returns the active tab's file path. */
export function useActiveTabPath() {
  const service = getEditorService();
  return useServiceEvent(service.onDidChangeActiveTab, () => service.activeTabPath);
}

/** Returns whether the active tab has a pending AI diff review. */
export function useHasPendingReviewForActiveTab() {
  const editorService = getEditorService();
  const reviewService = getDiffReviewService();
  return useServiceEvents(
    [
      editorService.onDidChangeActiveTab,
      reviewService.onDidAddReview,
      reviewService.onDidRemoveReview,
      reviewService.onDidUpdateReview,
    ],
    () => {
      const activeFileId =
        editorService.activeTab?._id ||
        (editorService.activeTab?.path ? normalizeReviewPath(editorService.activeTab.path) : null);
      return activeFileId ? Boolean(reviewService.getReviewForFile(activeFileId)) : false;
    }
  );
}

export function usePendingReviews(): PendingReview[] {
  const reviewService = getDiffReviewService();
  const previousValueRef = useRef<PendingReview[] | null>(null);
  return useServiceEvents(
    [
      reviewService.onDidAddReview,
      reviewService.onDidRemoveReview,
      reviewService.onDidUpdateReview,
    ],
    () => {
      const next = reviewService.getPendingReviews();
      const previous = previousValueRef.current;

      if (
        previous &&
        previous.length === next.length &&
        previous.every((review, index) => review === next[index])
      ) {
        return previous;
      }

      previousValueRef.current = next;
      return next;
    }
  );
}

export function useLatestPendingReviewSource(): LatestPendingReviewSource | null {
  const reviewService = getDiffReviewService();
  const previousValueRef = useRef<LatestPendingReviewSource | null>(null);
  return useServiceEvents(
    [
      reviewService.onDidAddReview,
      reviewService.onDidRemoveReview,
      reviewService.onDidUpdateReview,
    ],
    () => {
      const next = reviewService.getLatestPendingReviewSource();
      const previous = previousValueRef.current;

      if (
        previous &&
        next &&
        previous.reviewId === next.reviewId &&
        previous.messageId === next.messageId &&
        previous.normalizedFilePath === next.normalizedFilePath &&
        previous.reviewKey === next.reviewKey
      ) {
        return previous;
      }

      if (!next) {
        previousValueRef.current = null;
        return null;
      }

      previousValueRef.current = next;
      return next;
    }
  );
}

/** Returns current cursor position. */
export function useCursorPosition() {
  const service = getEditorService();
  return useServiceEvent(service.onDidChangeCursor, () => service.cursorPosition);
}

/** Returns current text selection. */
export function useSelection() {
  const service = getEditorService();
  return useServiceEvent(service.onDidChangeSelection, () => service.selection);
}

// ============ Project Hooks ============

/** Returns current project path. */
export function useProjectPath() {
  const service = getProjectService();
  return useServiceEvent(service.onDidChangeProject, () => service.projectPath);
}

/** Returns project file tree. */
export function useFileTree() {
  const service = getProjectService();
  return useServiceEvents(
    [service.onDidChangeProject, service.onDidChangeFileTree],
    () => service.fileTree
  );
}

/** Returns file conflict state. */
export function useFileConflict() {
  const service = getProjectService();
  return useServiceEvent(service.onDidChangeFileConflict, () => service.fileConflict);
}

/** Returns file path index for @ completion. */
export function useFilePathIndex() {
  const service = getProjectService();
  return useServiceEvent(service.onDidChangeFilePathIndex, () => service.filePathIndex);
}

/** Returns whether file indexing is in progress. */
export function useIsIndexing() {
  const service = getProjectService();
  return useServiceEvent(service.onDidChangeIndexingState, () => service.isIndexing);
}

// ============ UI Hooks ============

/** Returns current sidebar tab. */
export function useSidebarTab() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeSidebarTab, () => service.sidebarTab);
}

/** Returns sidebar collapsed state. */
export function useIsSidebarCollapsed() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeSidebarCollapsed, () => service.isSidebarCollapsed);
}

/** Returns right panel tab. */
export function useRightPanelTab() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeRightPanelTab, () => service.rightPanelTab);
}

/** Returns chat panel visibility (one of the three independent main-page panels). */
export function useChatVisible() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeChatVisible, () => service.chatVisible);
}

/** Returns editor panel visibility (one of the three independent main-page panels). */
export function useEditorVisible() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeEditorVisible, () => service.editorVisible);
}

/** Returns command palette open state. */
export function useIsCommandPaletteOpen() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeCommandPalette, () => service.isCommandPaletteOpen);
}

/** Returns compilation in-progress state. */
export function useIsCompiling() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeCompiling, () => service.isCompiling);
}

/** Returns last compilation result. */
export function useCompilationResult() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeCompilationResult, () => service.compilationResult);
}

/** Returns current PDF binary data. */
export function usePdfData() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangePdf, () => service.pdfData);
}

/** Returns the current Zotero paper PDF bytes (right-panel "paper" tab), or null. */
export function useZoteroPdf(): Uint8Array | null {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeZoteroPdf, () => service.zoteroPdf?.pdfBytes ?? null);
}

/** Returns the current Zotero paper itemKey (right-panel "paper" tab), or null. */
export function useZoteroPaperItemKey(): string | null {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeZoteroPdf, () => service.zoteroPdf?.itemKey ?? null);
}

/** Returns file-scoped PDF preview state. */
export function useFilePdfPreview(filePath: string | null) {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeFilePdfPreview, () =>
    service.getFilePdfPreview(filePath)
  );
}

/** Returns current PDF URL. */
export function usePdfUrl() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangePdf, () => service.pdfUrl);
}

/** Returns current PDF highlight position. */
export function usePdfHighlight() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangePdfHighlight, () => service.pdfHighlight);
}

/** Returns agent state. */
export function useAgentState() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeAgentState, () => service.agentState);
}

/** Returns current preview mode (pdf/markdown/typst/none). */
export function usePreviewMode() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangePreviewMode, () => service.previewMode);
}

/** Returns current research layout focus. */
export function useResearchLayoutFocus() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeResearchLayoutFocus, () => service.researchLayoutFocus);
}

/** Returns current artifact path. */
export function useActiveArtifactPath() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeActiveArtifactPath, () => service.activeArtifactPath);
}

/** Returns current artifact id. */
export function useActiveArtifactId() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeActiveArtifactId, () => service.activeArtifactId);
}

/** Returns log surface mode. */
export function useLogsSurface() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangeLogsSurface, () => service.logsSurface);
}

/** Returns preview visibility flag. */
export function usePreviewVisible() {
  const service = getUIService();
  return useServiceEvent(service.onDidChangePreviewVisible, () => service.isPreviewVisible);
}

// ============ Settings Hooks ============

/**
 * Subscribe to settings changes.
 * @example useSettings(s => s.editor.fontSize) // Use selector to avoid re-renders
 */
export function useSettings(): import('../../types').AppSettings;
export function useSettings<T>(selector: (settings: import('../../types').AppSettings) => T): T;
export function useSettings<T>(
  selector?: (settings: import('../../types').AppSettings) => T
): import('../../types').AppSettings | T {
  const service = getSettingsService();

  const prevValueRef = useRef<T | undefined>(undefined);

  const getSnapshot = useCallback(() => {
    const settings = service.settings;
    if (!selector) {
      return settings;
    }

    const newValue = selector(settings);

    // Shallow compare: return old ref if object values equal to avoid re-render
    if (
      prevValueRef.current !== undefined &&
      typeof newValue === 'object' &&
      newValue !== null &&
      typeof prevValueRef.current === 'object' &&
      prevValueRef.current !== null
    ) {
      const prevKeys = Object.keys(prevValueRef.current as object);
      const newKeys = Object.keys(newValue as object);
      if (
        prevKeys.length === newKeys.length &&
        prevKeys.every(
          (k) =>
            (prevValueRef.current as Record<string, unknown>)[k] ===
            (newValue as Record<string, unknown>)[k]
        )
      ) {
        return prevValueRef.current;
      }
    }

    prevValueRef.current = newValue;
    return newValue;
  }, [service, selector]);

  return useServiceEvent(service.onDidChangeSettings, getSnapshot);
}

/** Returns AI settings. */
export function useAISettings() {
  const service = getSettingsService();
  return useServiceEvent(service.onDidChangeAI, () => service.ai);
}

/** Returns editor settings. */
export function useEditorSettings() {
  const service = getSettingsService();
  return useServiceEvent(service.onDidChangeEditor, () => service.editor);
}

/** Returns compiler settings. */
export function useCompilerSettings() {
  const service = getSettingsService();
  return useServiceEvent(service.onDidChangeCompiler, () => service.compiler);
}

/** Returns UI settings. */
export function useUISettings() {
  const service = getSettingsService();
  return useServiceEvent(service.onDidChangeUI, () => service.ui);
}

/** Returns compilation logs. */
export function useCompilationLogs() {
  const service = getUIService();
  return useServiceEvent(service.onDidAddCompilationLog, () => service.compilationLogs);
}

// ============ Project Runtime Hooks ============

/** Returns full project runtime context snapshot. */
export function useProjectRuntime(): Readonly<ProjectRuntimeState> {
  const ctx = getProjectRuntimeContext();
  return useServiceEvent(ctx.onDidChange, () => ctx.state);
}
