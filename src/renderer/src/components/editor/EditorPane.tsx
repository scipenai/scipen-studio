/* eslint-disable react/exhaustive-deps -- editor/model refs are imperative handles in this component. */

/**
 * @file EditorPane.tsx - Code Editor Pane (Shell Component)
 * @description Monaco Editor based LaTeX/Typst editor with syntax highlighting and intelligent completion.
 *              Logic extracted into focused hooks: useOTCollaboration, useDiffReview, useCompilation, useSyncTeX, useDiagnostics.
 * @depends monaco-editor, api, LSPService, services/core
 */

import Editor, { type OnMount, type OnChange, type Monaco, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import React, { useRef, useCallback, useEffect, useMemo, startTransition } from 'react';
import { DisposableStore } from '../../../../../shared/utils';
import { useEvent } from '../../hooks';
import { t } from '../../locales';
import { registerInlineCompletionProvider } from '../../services/InlineCompletionService';
import { LSPService, isLSPSupportedFile } from '../../services/LSPService';
import { createLogger } from '../../services/LogService';
import { mathPreviewService } from '../../services/MathPreviewService';
import { getEditorService } from '../../services/core/ServiceRegistry';
import {
  buildReviewKey,
  getDiffReviewService,
  normalizeReviewPath,
  type CollaborationReviewKey,
} from '../../services/core/DiffReviewService';
import { DiffReviewInlineWidget } from './DiffReviewInlineWidget';
import {
  useActiveTabPath,
  useEditorTabs,
  useIsCompiling,
  usePdfData,
  useProjectPath,
  useProjectRuntime,
  useSettings,
  useWorkspaceMode,
} from '../../services/core/hooks';
import { registerLSPProviders } from '../../utils/LSPProviderRegistry';
import { getModelCache } from '../../utils/ModelCache';
import { EditorToolbar } from './components';
import {
  initializeLSPDocument,
  setupContentChangeTracking,
  setupCursorTracking,
  setupScrollTracking,
  setupShortcuts,
  setupSyncTexClick,
  useEditorEvents,
  useOTCollaboration,
  useDiffReview,
  useCompilation,
  useSyncTeX,
  useDiagnostics,
  useFileDrop,
} from './hooks';
import { registerLanguages } from './monaco/languages';
import { applyTheme, registerThemes } from './monaco/themes';
import {
  saveCurrentViewState,
  restoreViewState,
  buildEditorOptions,
} from './utils/editorModelHelpers';
import { clearDiffReview } from './DiffReviewRenderer';

const logger = createLogger('EditorPane');

loader.config({ monaco });

// ====== Main Component ======

export const EditorPane: React.FC = React.memo(() => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const disposablesRef = useRef<DisposableStore>(new DisposableStore());
  const previousTabPathRef = useRef<string | null>(null);
  const isEditorMountedRef = useRef<boolean>(false);
  const isProgrammaticUpdateRef = useRef<boolean>(false);

  const openTabs = useEditorTabs();
  const activeTabPath = useActiveTabPath();
  const projectPath = useProjectPath();
  const isCompiling = useIsCompiling();
  const pdfData = usePdfData();
  const settings = useSettings();
  const workspaceMode = useWorkspaceMode();

  const editorSettings = settings.editor;
  const uiTheme = settings.ui.theme;
  const compilerEngine = settings.compiler.engine;
  const collaborationConfig = settings.collaboration;
  const runtime = useProjectRuntime();

  const activeTab = useMemo(() => {
    const tab = openTabs.find((t) => t.path === activeTabPath);
    if (activeTabPath && !tab) {
      logger.warn('activeTabPath does not match any openTab', {
        activeTabPath,
        openTabPaths: openTabs.map((t) => t.path),
      });
    }
    return tab;
  }, [openTabs, activeTabPath]);
  const activeReviewKey: CollaborationReviewKey | null = activeTab?.path
    ? buildReviewKey(
        { projectId: runtime.projectId, rootPath: runtime.rootPath },
        activeTab._id || undefined,
        activeTab.path
      )
    : null;
  const activeTabIdentity =
    activeReviewKey?.fileId ??
    activeTab?._id ??
    (activeTab?.path ? normalizeReviewPath(activeTab.path) : null);

  // ====== Extracted Hooks ======

  useOTCollaboration({
    collaborationConfig,
    runtime,
    projectPath,
    activeTab,
    activeReviewKey,
  });

  const {
    displayReview,
    reviewFileIds,
    pendingReviewSummary,
    diffStateRef,
    handleAcceptReview,
    handleRejectReview,
    handleAcceptHunk,
    handleRejectHunk,
    handleJumpToReviewHunk,
    restoreReviewForTab,
  } = useDiffReview({
    editorRef,
    monacoRef,
    isProgrammaticUpdateRef,
    activeTab,
    activeReviewKey,
    runtime,
  });

  const { handleCompile } = useCompilation({
    editorRef,
    monacoRef,
    activeTab,
    activeTabPath,
    isCompiling,
    compilerEngine,
  });

  const { handleSyncTexJump } = useSyncTeX({
    editorRef,
    activeTabPath,
  });

  const { runDiagnostics, debouncedRunDiagnostics, setupLSPDiagnostics } = useDiagnostics({
    editorRef,
    monacoRef,
    disposablesRef,
    activeTabPath,
    activeTabLanguage: activeTab?.language,
  });

  // ====== Editor Options ======

  const editorOptions = useMemo(() => buildEditorOptions(editorSettings), [editorSettings]);

  // ====== Tab Switch Effects ======

  // eslint-disable-next-line react/exhaustive-deps -- diff/model refs are mutable imperative handles, not reactive deps
  useEffect(() => {
    const editor = editorRef.current;
    const monacoInstance = monacoRef.current;

    if (!editor || !monacoInstance || !isEditorMountedRef.current) return;
    if (previousTabPathRef.current === activeTabPath) return;

    // Mark the entire tab switch as programmatic to avoid intermediate onChange pollution
    isProgrammaticUpdateRef.current = true;
    try {
      if (previousTabPathRef.current) {
        saveCurrentViewState(editor, previousTabPathRef.current);
      }

      // Clear previous tab's diff decorations
      if (diffStateRef.current) {
        clearDiffReview(editor, diffStateRef.current);
        diffStateRef.current = null;
      }

      if (activeTabPath && activeTab) {
        const language = activeTab.language || 'plaintext';
        restoreViewState(editor, monacoInstance, activeTabPath, activeTab.content, language);
        initializeLSPDocument(editor);

        // Restore diff review decorations (including Bridge-buffered inactive-file edits)
        if (activeTabIdentity) {
          restoreReviewForTab(editor, monacoInstance, activeTabIdentity);
        }
      }

      previousTabPathRef.current = activeTabPath;
    } finally {
      queueMicrotask(() => {
        isProgrammaticUpdateRef.current = false;
      });
    }
  }, [activeTabPath, activeTab, activeTabIdentity, activeReviewKey, restoreReviewForTab]);

  useEffect(() => {
    const openPaths = new Set(openTabs.map((t) => t.path));
    getModelCache().cleanup(openPaths);
  }, [openTabs]);

  // ====== Content Update Handlers ======

  useEvent(
    getEditorService().onDidChangeContent,
    (event) => {
      const editor = editorRef.current;
      if (!editor) return;

      const shouldUpdate = event.path === activeTabPath && (!event.isDirty || event.forceUpdate);

      if (shouldUpdate) {
        const model = editor.getModel();
        if (model && model.getValue() !== event.content) {
          logger.info(
            `Content update, refreshing Monaco Model: ${event.path} ${event.forceUpdate ? '(programmatic)' : '(external)'}`
          );
          const viewState = editor.saveViewState();

          isProgrammaticUpdateRef.current = true;
          try {
            model.setValue(event.content);
          } finally {
            queueMicrotask(() => {
              isProgrammaticUpdateRef.current = false;
            });
          }

          if (viewState) {
            editor.restoreViewState(viewState);
          }
        }

        if (activeTabIdentity) {
          const review = getDiffReviewService().getReviewForFile(
            activeTabIdentity,
            activeReviewKey ?? undefined
          );
          if (review && event.content === review.originalFullContent) {
            getDiffReviewService().clearReviewForFile(
              activeTabIdentity,
              activeReviewKey ?? undefined
            );
          }
        }
      }
    },
    [activeTabIdentity, activeTabPath, activeReviewKey]
  );

  // ====== Editor Mount ======

  const handleEditorMount: OnMount = useCallback(
    (editor, monacoInstance) => {
      editorRef.current = editor;
      monacoRef.current = monacoInstance;

      registerLanguages(monacoInstance);
      registerThemes(monacoInstance, uiTheme);

      setupCursorTracking(editor);
      const scrollDisposable = setupScrollTracking(editor);
      disposablesRef.current.add(scrollDisposable);
      setupSyncTexClick(editor);
      setupShortcuts(editor, monacoInstance);
      setupContentChangeTracking(editor, isProgrammaticUpdateRef);

      if (editorSettings.autoCompletion) {
        try {
          const latexDisposable = registerInlineCompletionProvider(monacoInstance, 'latex');
          const typstDisposable = registerInlineCompletionProvider(monacoInstance, 'typst');
          disposablesRef.current.add(latexDisposable);
          disposablesRef.current.add(typstDisposable);
          logger.info('Completion providers registered (latex, typst)');
        } catch (error) {
          logger.error('Failed to register completion providers', error);
        }
      }

      registerLSPProviders(monacoInstance);
      setupLSPDiagnostics(editor, monacoInstance);

      try {
        mathPreviewService.initialize(editor, monacoInstance, {
          enabled: true,
          displayMode: 'hover',
          maxPreviewWidth: 400,
          fontSize: 14,
        });
      } catch (error) {
        logger.error('Failed to initialize math preview', error);
      }

      const model = editor.getModel();
      if (model) {
        runDiagnostics(model.getValue(), monacoInstance, model);
      }

      const editorService = getEditorService();
      const initialTab = editorService.tabs.find((t) => t.path === editorService.activeTabPath);
      if (initialTab && editorService.activeTabPath) {
        const language = initialTab.language || 'plaintext';
        restoreViewState(
          editor,
          monacoInstance,
          editorService.activeTabPath,
          initialTab.content,
          language,
          isProgrammaticUpdateRef
        );
        previousTabPathRef.current = editorService.activeTabPath;
        initializeLSPDocument(editor);
      }

      isEditorMountedRef.current = true;
    },
    [editorSettings.autoCompletion, uiTheme, runDiagnostics, setupLSPDiagnostics]
  );

  useEffect(() => {
    if (monacoRef.current) {
      applyTheme(monacoRef.current, uiTheme);
    }
  }, [uiTheme]);

  // ====== Content Change Handler ======

  const handleEditorChange: OnChange = useCallback(
    (value) => {
      if (isProgrammaticUpdateRef.current) return;
      if (value === undefined) return;

      // Use Monaco model URI as the file identity instead of the activeTabPath closure
      // to prevent cross-tab content pollution
      const model = editorRef.current?.getModel();
      if (!model) return;
      const modelPath = model.uri.path.replace(/^\/+/, '').replace(/\\/g, '/');

      const editorService = getEditorService();
      const matchedTab = editorService.tabs.find((tab) => {
        const tabNorm = tab.path.replace(/\\/g, '/');
        return tabNorm.endsWith(modelPath) || modelPath.endsWith(tabNorm);
      });
      if (!matchedTab) return;

      startTransition(() => {
        editorService.updateContent(matchedTab.path, value);
      });
      debouncedRunDiagnostics(value);
    },
    [debouncedRunDiagnostics]
  );

  // ====== Disposables Cleanup ======

  useEffect(() => {
    const disposables = disposablesRef.current;
    disposables.add({ dispose: () => mathPreviewService.dispose() });

    return () => {
      disposables.dispose();
    };
  }, []);

  // ====== Editor Events ======

  useEditorEvents({
    editorRef,
    activeTabPath,
    onCompile: () => {
      const compileButton = document.querySelector('[data-compile-button]') as HTMLButtonElement;
      compileButton?.click();
    },
  });

  // ====== Tab Close Handler ======

  const handleCloseTab = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    e.preventDefault();

    if (LSPService.isRunning() && isLSPSupportedFile(path)) {
      LSPService.closeDocument(path);
    }

    getEditorService().closeTab(path);
  };

  // ====== Drag & Drop ======

  const { handleDragOver, handleDrop } = useFileDrop({ editorRef });

  // ====== Render ======

  if (openTabs.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-[#fffdf9] text-[var(--color-text-muted)]">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-[20px] border border-[rgba(15,23,42,0.06)] bg-white shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
            <span className="text-[24px] font-semibold text-slate-300">S</span>
          </div>
          <p className="text-sm font-medium text-slate-500">{t('editor.noFileOpen')}</p>
          <p className="mt-2 text-xs leading-6 text-[var(--color-text-disabled)]">
            {t('editor.selectFileHint')}
          </p>
          <div className="mt-4 space-y-1 text-[11px] text-slate-400">
            <div>{t('editor.shortcutOpenClaw')}</div>
            <div>{t('editor.shortcutSearchFile')}</div>
            <div>{t('editor.shortcutAIGenerate')}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full flex flex-col bg-[#fffdf9]"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <EditorToolbar
        openTabs={openTabs}
        activeTabPath={activeTabPath}
        isCompiling={isCompiling}
        hasPdf={!!pdfData}
        documentMode={workspaceMode !== 'chat'}
        onTabClick={(path) => getEditorService().setActiveTab(path)}
        onTabClose={handleCloseTab}
        onSyncTexJump={handleSyncTexJump}
        onCompile={handleCompile}
        reviewFileIds={reviewFileIds}
        pendingReview={
          pendingReviewSummary
            ? {
                ...pendingReviewSummary,
                onAcceptAll: handleAcceptReview,
                onRejectAll: handleRejectReview,
                onNextChange: () => handleJumpToReviewHunk('next'),
              }
            : undefined
        }
      />

      <div className="flex-1 relative">
        {activeTab && (
          <div className="h-full">
            <Editor
              height="100%"
              language={activeTab.language || 'latex'}
              onChange={handleEditorChange}
              onMount={handleEditorMount}
              theme="vs-dark"
              options={editorOptions}
            />
          </div>
        )}
        {displayReview && editorRef.current && monacoRef.current && (
          <DiffReviewInlineWidget
            review={displayReview}
            editor={editorRef.current}
            monacoInstance={monacoRef.current}
            onAcceptHunk={handleAcceptHunk}
            onRejectHunk={handleRejectHunk}
            disabled={false}
          />
        )}
      </div>
    </div>
  );
});

EditorPane.displayName = 'EditorPane';
