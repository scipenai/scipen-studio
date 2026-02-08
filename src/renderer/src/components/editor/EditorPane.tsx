/**
 * @file EditorPane.tsx - Code Editor Pane
 * @description Monaco Editor based LaTeX/Typst editor with syntax highlighting and intelligent completion
 * @depends monaco-editor, api, LSPService, services/core
 */

import Editor, { type OnMount, type OnChange, type Monaco, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import React, { useRef, useCallback, useEffect, useMemo, startTransition } from 'react';
import { DisposableStore } from '../../../../../shared/utils';
import { api } from '../../api';
import { useDelayer, useEvent, useWindowEvent } from '../../hooks';
import { t } from '../../locales';
import { registerInlineCompletionProvider } from '../../services/InlineCompletionService';
import { LSPService, isLSPSupportedFile } from '../../services/LSPService';
import { createLogger } from '../../services/LogService';
import { mathPreviewService } from '../../services/MathPreviewService';
import {
  type CompileOptions,
  type CompileResult,
  getCompileService,
} from '../../services/core/CompileService';
import { getFileExplorerService } from '../../services/core/FileExplorerService';
import { TaskPriority, scheduleIdleTask } from '../../services/core/IdleTaskScheduler';
import {
  getAIService,
  getEditorService,
  getProjectService,
  getSettingsService,
  getUIService,
} from '../../services/core/ServiceRegistry';
import {
  useActiveTabPath,
  useEditorTabs,
  useIsCompiling,
  usePdfData,
  useSettings,
} from '../../services/core/hooks';
import { getLanguageForFile } from '../../utils';
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
} from './hooks';
import { registerLanguages } from './monaco/languages';
import { applyTheme, registerThemes } from './monaco/themes';

const logger = createLogger('EditorPane');

// Why: Use local Monaco bundle to avoid CDN dependency
loader.config({ monaco });

import {
  type SyntaxMarker,
  getSyntaxWorkerClient,
  mapSeverityToMonaco,
} from '../../workers/SyntaxWorkerClient';

// ====== ViewState Cache Helpers ======

/** Saves current editor ViewState to cache */
function saveCurrentViewState(
  editor: monaco.editor.IStandaloneCodeEditor | null,
  path: string | null
): void {
  if (!editor || !path) return;

  const viewState = editor.saveViewState();
  if (viewState) {
    getModelCache().updateViewState(path, viewState);
  }
}

/** Restores ViewState for given path or creates new Model */
function restoreViewState(
  editor: monaco.editor.IStandaloneCodeEditor,
  monacoInstance: Monaco,
  path: string,
  content: string,
  language: string,
  isProgrammaticUpdateRef?: React.MutableRefObject<boolean>
): void {
  const modelCache = getModelCache();
  const cached = modelCache.get(path);

  // Why: Prevent setValue from triggering duplicate onChange handling
  const safeSetValue = (model: monaco.editor.ITextModel, newContent: string) => {
    if (isProgrammaticUpdateRef) {
      isProgrammaticUpdateRef.current = true;
    }
    try {
      model.setValue(newContent);
    } finally {
      if (isProgrammaticUpdateRef) {
        setTimeout(() => {
          isProgrammaticUpdateRef.current = false;
        }, 0);
      }
    }
  };

  if (cached) {
    if (cached.model.getValue() !== content) {
      safeSetValue(cached.model, content);
    }
    editor.setModel(cached.model);

    if (cached.viewState) {
      editor.restoreViewState(cached.viewState);
    }
  } else {
    // Normalize path: replace backslashes and remove leading slashes to avoid invalid URIs
    // e.g., /home/user/file.tex -> file:///home/user/file.tex (not file:////home/user/file.tex)
    const normalizedPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
    const uri = monacoInstance.Uri.parse(`file:///${normalizedPath}`);

    let model = monacoInstance.editor.getModel(uri);
    if (!model || model.isDisposed()) {
      model = monacoInstance.editor.createModel(content, language, uri);
    } else if (model.getValue() !== content) {
      safeSetValue(model, content);
    }

    editor.setModel(model);
    modelCache.set(path, model, null, language);
  }

  editor.focus();
}

// ====== Main Component ======

export const EditorPane: React.FC = React.memo(() => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const disposablesRef = useRef<DisposableStore>(new DisposableStore());
  const previousTabPathRef = useRef<string | null>(null);
  const isEditorMountedRef = useRef<boolean>(false);
  // Why: Prevent setValue from triggering duplicate onChange handling during programmatic updates
  const isProgrammaticUpdateRef = useRef<boolean>(false);

  const openTabs = useEditorTabs();
  const activeTabPath = useActiveTabPath();
  const isCompiling = useIsCompiling();
  const pdfData = usePdfData();
  const settings = useSettings();

  const editorSettings = settings.editor;
  const uiTheme = settings.ui.theme;
  const compilerEngine = settings.compiler.engine;
  const overleafConfig = settings.compiler.overleaf;

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

  // ====== Editor Options ======

  const editorOptions = useMemo(
    () => ({
      fontSize: editorSettings.fontSize,
      fontFamily: editorSettings.fontFamily,
      fontLigatures: false, // Why: Prevents cursor position issues
      tabSize: editorSettings.tabSize,
      wordWrap: editorSettings.wordWrap ? ('on' as const) : ('off' as const),
      minimap: {
        enabled: editorSettings.minimap,
        maxColumn: 80,
        renderCharacters: false, // Why: Significantly improves performance
      },
      lineNumbers: editorSettings.lineNumbers ? ('on' as const) : ('off' as const),
      cursorStyle: editorSettings.cursorStyle,
      cursorBlinking: editorSettings.cursorBlinking,
      cursorWidth: 2,
      scrollBeyondLastLine: false,
      automaticLayout: true,
      padding: { top: 16 },
      smoothScrolling: editorSettings.smoothScrolling,
      renderWhitespace: editorSettings.showWhitespace,
      bracketPairColorization: { enabled: editorSettings.bracketPairColorization },
      renderLineHighlight: editorSettings.renderLineHighlight,
      guides: {
        bracketPairs: true,
        indentation: editorSettings.indentGuides,
      },
      suggest: {
        showKeywords: true,
        showSnippets: true,
      },
      quickSuggestions: editorSettings.autoCompletion,
      inlineSuggest: {
        enabled: editorSettings.ghostText,
      },
      stickyScroll: {
        enabled: editorSettings.stickyScroll,
      },
      letterSpacing: 0,
      disableMonospaceOptimizations: false,
      // Performance optimizations
      renderValidationDecorations: 'editable' as const,
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        useShadows: false,
      },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      renderFinalNewline: 'off' as const,
      occurrencesHighlight: 'off' as const,
      selectionHighlight: false,
      links: false,
      folding: true,
      foldingHighlight: false,
      showFoldingControls: 'mouseover' as const,
    }),
    [editorSettings]
  );

  // ====== Tab Switch Effects ======

  // Why: ViewState caching enables smooth tab switching by persisting scroll/cursor positions
  useEffect(() => {
    const editor = editorRef.current;
    const monacoInstance = monacoRef.current;

    if (!editor || !monacoInstance || !isEditorMountedRef.current) return;
    if (previousTabPathRef.current === activeTabPath) return;

    if (previousTabPathRef.current) {
      saveCurrentViewState(editor, previousTabPathRef.current);
    }

    if (activeTabPath && activeTab) {
      const language = activeTab.language || 'plaintext';
      restoreViewState(
        editor,
        monacoInstance,
        activeTabPath,
        activeTab.content,
        language,
        isProgrammaticUpdateRef
      );
      initializeLSPDocument(editor);
    }

    previousTabPathRef.current = activeTabPath;
  }, [activeTabPath, activeTab]);

  useEffect(() => {
    const openPaths = new Set(openTabs.map((t) => t.path));
    getModelCache().cleanup(openPaths);
  }, [openTabs]);

  // ====== Content Update Handlers ======

  // Why: Handle external content updates (file reload, polishing) by directly updating Monaco Model
  useEvent(getEditorService().onDidChangeContent, (event) => {
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
          setTimeout(() => {
            isProgrammaticUpdateRef.current = false;
          }, 0);
        }

        if (viewState) {
          editor.restoreViewState(viewState);
        }
      }
    }
  });

  // ====== SyncTeX and Navigation ======

  useWindowEvent(
    'synctex-goto-line' as keyof WindowEventMap,
    ((event: CustomEvent<{ file: string; line: number; column: number }>) => {
      const { file, line, column } = event.detail;
      const editor = editorRef.current;
      const editorService = getEditorService();

      const normalizePathForCompare = (p: string | null): string => {
        if (!p) return '';
        return p
          .replace(/\\/g, '/')
          .replace(/^([A-Z]):/, (_, letter) => `${letter.toLowerCase()}:`);
      };

      const targetPath = normalizePathForCompare(file);
      const activePath = normalizePathForCompare(activeTabPath);

      const jumpInEditor = () => {
        const currentEditor = editorRef.current;
        if (!currentEditor) return;
        currentEditor.revealLineInCenter(line);
        currentEditor.setPosition({ lineNumber: line, column: column || 1 });
        currentEditor.focus();
      };

      if (editor && activePath === targetPath) {
        jumpInEditor();
        return;
      }

      api.file
        .read(file)
        .then((result) => {
          if (!result?.content) return;
          const fileName = file.split(/[\\/]/).pop() || 'untitled';
          editorService.addTab({
            path: file,
            name: fileName,
            content: result.content,
            isDirty: false,
            language: getLanguageForFile(fileName),
          });
          editorService.setActiveTab(file);
          setTimeout(jumpInEditor, 0);
        })
        .catch((error) => {
          logger.warn('SyncTeX jump failed to open file:', error);
        });
    }) as EventListener
  );

  useWindowEvent(
    'outline-navigate' as keyof WindowEventMap,
    ((event: CustomEvent<{ line: number }>) => {
      const { line } = event.detail;
      const editor = editorRef.current;
      if (editor) {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      }
    }) as EventListener
  );

  useEffect(() => {
    const disposables = disposablesRef.current;
    disposables.add({ dispose: () => mathPreviewService.dispose() });

    return () => {
      disposables.dispose();
    };
  }, []);

  // ====== Syntax Diagnostics (Worker Thread) ======

  function convertToMonacoMarkers(
    syntaxMarkers: SyntaxMarker[],
    monacoInstance: Monaco
  ): monaco.editor.IMarkerData[] {
    return syntaxMarkers.map((marker) => ({
      severity: mapSeverityToMonaco(marker.severity, monacoInstance),
      message: marker.message,
      startLineNumber: marker.startLineNumber,
      startColumn: marker.startColumn,
      endLineNumber: marker.endLineNumber,
      endColumn: marker.endColumn,
    }));
  }

  const runDiagnostics = useCallback(
    async (content: string, monacoInstance: Monaco, model: monaco.editor.ITextModel | null) => {
      if (!monacoInstance || !model) return;

      try {
        const syntaxWorker = getSyntaxWorkerClient();
        const syntaxMarkers = await syntaxWorker.runDiagnostics(content);

        if (model.isDisposed()) {
          return;
        }

        const markers = convertToMonacoMarkers(syntaxMarkers, monacoInstance);
        monacoInstance.editor.setModelMarkers(model, 'latex', markers);
      } catch (error) {
        console.error('[EditorPane] Syntax check failed:', error);
      }
    },
    []
  );

  // ====== Editor Mount ======

  const handleEditorMount: OnMount = useCallback(
    (editor, monacoInstance) => {
      editorRef.current = editor;
      monacoRef.current = monacoInstance;

      registerLanguages(monacoInstance);
      registerThemes(monacoInstance, uiTheme);

      setupCursorTracking(editor);
      setupScrollTracking(editor);
      setupSyncTexClick(editor);
      setupShortcuts(editor, monacoInstance);
      setupContentChangeTracking(editor);

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
    [editorSettings.autoCompletion, uiTheme, runDiagnostics]
  );

  useEffect(() => {
    if (monacoRef.current) {
      applyTheme(monacoRef.current, uiTheme);
    }
  }, [uiTheme]);

  // ====== LSP Diagnostics ======

  function setupLSPDiagnostics(
    editor: monaco.editor.IStandaloneCodeEditor,
    monacoInstance: Monaco
  ): void {
    const cleanupDiagnostics = LSPService.onDiagnostics((filePath, diagnostics) => {
      const currentModel = editor.getModel();
      if (!currentModel) return;

      const currentPath = currentModel.uri.path;
      if (!currentPath.includes(filePath) && !filePath.includes(currentPath)) return;

      const markers = LSPService.convertDiagnosticsToMarkers(diagnostics, currentModel);
      monacoInstance.editor.setModelMarkers(currentModel, 'texlab', markers);
    });

    disposablesRef.current.add({ dispose: cleanupDiagnostics });
  }

  // Why: Delayer provides Promise support, cancellation, and better memory management than setTimeout
  const diagnosticsDelayer = useDelayer<void>(1000);
  const diagnosticsVersionRef = useRef<number>(0);

  // Why: Version tracking prevents stale diagnostics from overwriting newer results
  const debouncedRunDiagnostics = useCallback(
    (value: string) => {
      void value;
      const currentVersion = ++diagnosticsVersionRef.current;

      diagnosticsDelayer.trigger(() => {
        if (monacoRef.current && editorRef.current) {
          const model = editorRef.current.getModel();
          if (model) {
            scheduleIdleTask(
              () => {
                if (currentVersion !== diagnosticsVersionRef.current) {
                  logger.debug('Diagnostics version outdated, skipping');
                  return;
                }

                const currentTabPath = getEditorService().activeTab?.path;
                if (activeTabPath && currentTabPath && activeTabPath !== currentTabPath) {
                  return;
                }

                if (monacoRef.current && editorRef.current) {
                  const currentModel = editorRef.current.getModel();
                  if (currentModel) {
                    runDiagnostics(currentModel.getValue(), monacoRef.current, currentModel);
                  }
                }
              },
              {
                id: `diagnostics-${activeTabPath}`,
                priority: TaskPriority.High,
                timeout: 3000,
              }
            );
          }
        }
      });
    },
    [diagnosticsDelayer, runDiagnostics, activeTabPath]
  );

  // ====== Content Change Handler ======

  // Why: startTransition marks updates as interruptible, ensuring user input isn't blocked
  const handleEditorChange: OnChange = useCallback(
    (value) => {
      if (isProgrammaticUpdateRef.current) {
        return;
      }

      if (activeTabPath && value !== undefined) {
        startTransition(() => {
          getEditorService().updateContent(activeTabPath, value);
        });
        debouncedRunDiagnostics(value);
      }
    },
    [activeTabPath, debouncedRunDiagnostics]
  );

  // ====== AI Polish Handler ======

  const handlePolishClick = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !activeTabPath) return;

    const selection = editor.getSelection();
    if (!selection || selection.isEmpty()) {
      alert(t('editor.selectTextFirst'));
      return;
    }

    const selectedText = editor.getModel()?.getValueInRange(selection);
    if (!selectedText) return;

    getAIService().setPolishRequest({
      originalText: selectedText,
      polishedText: null,
      isPolishing: false,
      selectionRange: {
        startLine: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLine: selection.endLineNumber,
        endColumn: selection.endColumn,
      },
      filePath: activeTabPath,
    });

    getUIService().setSidebarCollapsed(false);
    getUIService().setSidebarTab('ai');
  }, [activeTabPath]);

  // ====== SyncTeX Jump Handler ======

  const syncTexDelayer = useDelayer<void>(300);

  const handleSyncTexJump = useCallback(() => {
    syncTexDelayer.trigger(() => {
      const editor = editorRef.current;
      if (!editor) return;

      const position = editor.getPosition();
      const uiService = getUIService();
      const settingsService = getSettingsService();
      const projectService = getProjectService();
      const projectPath = projectService.projectPath;

      if (!position || (!uiService.pdfData && !uiService.pdfPath)) return;

      const isRemote =
        projectPath?.startsWith('overleaf://') || projectPath?.startsWith('overleaf:');

      if (isRemote) {
        const remoteBuildId = uiService.remoteBuildId;
        if (!remoteBuildId) {
          uiService.addCompilationLog({ type: 'warning', message: t('syncTeX.compileFirst') });
          return;
        }

        const editorService = getEditorService();
        const currentPath = editorService.activeTabPath;
        if (!currentPath) return;

        const projectId = settingsService.compiler.overleaf?.projectId;
        if (!projectId) {
          uiService.addCompilationLog({ type: 'warning', message: t('syncTeX.missingProjectId') });
          return;
        }

        let filePath = currentPath;
        const match = currentPath.match(/^overleaf:\/\/[^/]+\/(.+)$/);
        if (match) {
          filePath = match[1];
        }

        api.overleaf
          .syncCode(projectId, filePath, position.lineNumber, position.column, remoteBuildId)
          .then((result) => {
            if (result && result.length > 0) {
              const pos = result[0];
              uiService.setPdfHighlight({
                page: pos.page,
                x: pos.h,
                y: pos.v,
                width: pos.width || 50,
                height: pos.height || 20,
              });
              uiService.addCompilationLog({
                type: 'info',
                message: t('syncTeX.jumpToPage', { page: String(pos.page) }),
              });
            } else {
              uiService.addCompilationLog({
                type: 'warning',
                message: t('syncTeX.positionNotFound'),
              });
            }
          });
      } else {
        const synctexPath = uiService.synctexPath;
        const editorService = getEditorService();
        const currentPath = editorService.activeTabPath;

        if (!currentPath || !synctexPath) {
          uiService.addCompilationLog({ type: 'warning', message: t('syncTeX.compileFirst') });
          return;
        }

        api.synctex
          .forward(currentPath, position.lineNumber, position.column, synctexPath)
          .then((result) => {
            if (result && result.page !== undefined) {
              uiService.setPdfHighlight({
                page: result.page,
                x: result.x || 0,
                y: result.y || 0,
                width: result.width || 50,
                height: result.height || 20,
              });
              uiService.addCompilationLog({
                type: 'info',
                message: t('syncTeX.jumpToPage', { page: String(result.page) }),
              });
            } else {
              uiService.addCompilationLog({
                type: 'warning',
                message: t('syncTeX.positionNotFound'),
              });
            }
          });
      }
    });
  }, [syncTexDelayer]);

  // ====== Editor Events ======

  useEditorEvents({
    editorRef,
    activeTabPath,
    onCompile: () => {
      const compileButton = document.querySelector('[data-compile-button]') as HTMLButtonElement;
      compileButton?.click();
    },
    onPolish: handlePolishClick,
  });

  // ====== Compilation ======

  const handleCompile = async () => {
    const uiService = getUIService();

    if (isCompiling) {
      if (activeTab && !activeTab.name.endsWith('.typ') && compilerEngine === 'overleaf') {
        uiService.addCompilationLog({
          type: 'warning',
          message: t('editor.remoteCancelNotSupported'),
        });
        return;
      }

      try {
        const type = activeTab?.name.endsWith('.typ') ? 'typst' : 'latex';
        const result = await api.compile.cancel(type);
        uiService.addCompilationLog({
          type: 'warning',
          message: t('editor.cancelRequested', { status: String(result.cancelled) }),
        });
      } catch (error) {
        uiService.addCompilationLog({
          type: 'error',
          message: t('editor.cancelFailed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      }
      return;
    }

    if (!activeTab || !activeTabPath) return;

    const settingsService = getSettingsService();
    const compileService = getCompileService();

    uiService.setCompiling(true);

    try {
      const options: CompileOptions = {
        engine: compilerEngine as CompileOptions['engine'],
        mainFile: activeTabPath,
        overleaf: compilerEngine === 'overleaf' ? overleafConfig : undefined,
        activeTab: activeTab,
      };

      if (activeTab.name.endsWith('.typ')) {
        options.engine = settingsService.compiler.typstEngine || 'tinymist';
      }

      const result = await compileService.compile(activeTabPath, activeTab.content, options);

      await handleCompileResult(result, uiService);
    } finally {
      uiService.setCompiling(false);
    }
  };

  /** Handles compile result: updates PDF display and UI state */
  const handleCompileResult = async (
    result: CompileResult,
    uiService: ReturnType<typeof getUIService>
  ) => {
    if (result.success) {
      if (result.pdfPath) {
        // Why: PDF.js doesn't support custom protocol URLs, must use binary data
        try {
          const pdfBuffer = await api.file.readBinary(result.pdfPath);
          uiService.setPdfData(pdfBuffer);
          uiService.setPdfUrl(null);
          uiService.addCompilationLog({ type: 'info', message: `PDF path: ${result.pdfPath}` });
        } catch (readError) {
          console.error('Cannot read PDF file:', readError);
          uiService.addCompilationLog({ type: 'error', message: `Cannot read PDF: ${readError}` });
        }
      } else if (result.pdfBuffer) {
        try {
          const buffer =
            result.pdfBuffer instanceof ArrayBuffer
              ? result.pdfBuffer
              : (result.pdfBuffer.buffer.slice(
                  result.pdfBuffer.byteOffset,
                  result.pdfBuffer.byteOffset + result.pdfBuffer.byteLength
                ) as ArrayBuffer);
          uiService.setPdfData(buffer);
          uiService.setPdfUrl(null);
          uiService.addCompilationLog({
            type: 'info',
            message: `PDF size: ${(buffer.byteLength / 1024).toFixed(1)} KB`,
          });
        } catch (e) {
          logger.error('PDF data processing failed', e);
        }
      } else if (result.pdfData) {
        try {
          const binaryString = atob(result.pdfData);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          uiService.setPdfData(bytes.buffer.slice(0));
          uiService.setPdfUrl(null);
          uiService.addCompilationLog({
            type: 'info',
            message: `PDF size: ${(bytes.length / 1024).toFixed(1)} KB (Base64)`,
          });
        } catch (e) {
          logger.error('PDF Base64 decode failed', e);
        }
      }

      if (result.synctexPath) {
        uiService.setSynctexPath(result.synctexPath);
      }
      if (result.buildId) {
        uiService.setRemoteBuildId(result.buildId);
      }
    }

    uiService.setCompilationResult({
      success: result.success,
      pdfPath: result.pdfPath,
      synctexPath: result.synctexPath,
      log: result.log,
      time: result.time,
      errors: result.errors,
      parsedErrors: result.parsedErrors,
      parsedWarnings: result.parsedWarnings,
      parsedInfo: result.parsedInfo,
    });
  };

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

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const editor = editorRef.current;
    if (!editor) return;

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const projectService = getProjectService();
    const uiService = getUIService();
    const projectPath = projectService.projectPath;

    const isRemote = projectPath?.startsWith('overleaf://') || projectPath?.startsWith('overleaf:');
    if (isRemote) {
      uiService.addCompilationLog({ type: 'warning', message: t('fileDrop.remoteNotSupported') });
      return;
    }

    if (!projectPath) {
      uiService.addCompilationLog({ type: 'warning', message: t('fileDrop.openProjectFirst') });
      return;
    }

    const fileExplorerService = getFileExplorerService();
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.eps', '.svg'];
    const insertTexts: string[] = [];
    let copiedCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileName = file.name;
      const ext = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
      // Why: React DragEvent file may not have path in browser, but Electron renderer usually has it
      const srcPath = (file as unknown as { path?: string }).path;

      if (imageExtensions.includes(ext)) {
        if (srcPath) {
          try {
            const destPath = `${projectPath}/${fileName}`.replace(/\\/g, '/');
            const exists = await api.file.exists(destPath);
            if (!exists) {
              await api.file.copy(srcPath, destPath);
              copiedCount++;
            }
          } catch (error) {
            logger.error('Failed to copy image', error);
          }
        }

        const baseName = fileName.substring(0, fileName.lastIndexOf('.'));
        const latexCmd = `\\includegraphics[width=0.8\\textwidth]{${baseName}}`;
        insertTexts.push(latexCmd);
      }
    }

    if (insertTexts.length > 0) {
      const position = editor.getPosition();
      if (position) {
        const text = insertTexts.join('\n');
        editor.executeEdits('smart-drop', [
          {
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            },
            text: text,
          },
        ]);

        if (copiedCount > 0) {
          fileExplorerService.refreshFileTree(projectPath).then((fileTree) => {
            if (fileTree) {
              projectService.setProject(projectPath, fileTree);
            }
          });
        }

        uiService.addCompilationLog({
          type: 'success',
          message:
            copiedCount > 0
              ? t('fileDrop.insertedImagesWithCopy', {
                  count: String(insertTexts.length),
                  copied: String(copiedCount),
                })
              : t('fileDrop.insertedImages', { count: String(insertTexts.length) }),
        });
      }
    }
  }, []);

  // ====== Render ======

  if (openTabs.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]">
        <div className="text-center">
          <p className="text-sm">{t('editor.noFileOpen')}</p>
          <p className="text-xs text-[var(--color-text-disabled)] mt-1">
            {t('editor.selectFileHint')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full flex flex-col bg-[var(--color-bg-secondary)]"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <EditorToolbar
        openTabs={openTabs}
        activeTabPath={activeTabPath}
        isCompiling={isCompiling}
        hasPdf={!!pdfData}
        onTabClick={(path) => getEditorService().setActiveTab(path)}
        onTabClose={handleCloseTab}
        onPolish={handlePolishClick}
        onSyncTexJump={handleSyncTexJump}
        onCompile={handleCompile}
      />

      <div className="flex-1">
        {activeTab && (
          <div className="h-full">
            <Editor
              height="100%"
              language={activeTab.language || 'latex'}
              value={activeTab.content}
              onChange={handleEditorChange}
              onMount={handleEditorMount}
              theme="vs-dark"
              options={editorOptions}
            />
          </div>
        )}
      </div>
    </div>
  );
});

EditorPane.displayName = 'EditorPane';
