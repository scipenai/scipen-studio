/**
 * @file editorModelHelpers.ts - Editor Model Pure Helpers
 * @description Pure functions for Monaco model operations: ViewState cache, content diff, OT ops conversion
 */

import type { Monaco } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import type { AppSettings } from '../../../types/app';
import { getModelCache } from '../../../utils/ModelCache';

// ====== ViewState Cache Helpers ======

/** Saves current editor ViewState to cache */
export function saveCurrentViewState(
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
export function restoreViewState(
  editor: monaco.editor.IStandaloneCodeEditor,
  monacoInstance: Monaco,
  path: string,
  content: string,
  language: string,
  isProgrammaticUpdateRef?: React.MutableRefObject<boolean>
): void {
  const modelCache = getModelCache();
  const cached = modelCache.get(path);

  const safeSetValue = (model: monaco.editor.ITextModel, newContent: string) => {
    if (isProgrammaticUpdateRef) {
      isProgrammaticUpdateRef.current = true;
    }
    try {
      model.setValue(newContent);
    } finally {
      if (isProgrammaticUpdateRef) {
        queueMicrotask(() => {
          isProgrammaticUpdateRef.current = false;
        });
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

export function computeSingleEdit(
  currentContent: string,
  nextContent: string,
  model: monaco.editor.ITextModel,
  monacoInstance: Monaco
): monaco.editor.IIdentifiedSingleEditOperation[] {
  if (currentContent === nextContent) {
    return [];
  }

  let prefix = 0;
  const maxPrefix = Math.min(currentContent.length, nextContent.length);
  while (prefix < maxPrefix && currentContent[prefix] === nextContent[prefix]) {
    prefix += 1;
  }

  let currentSuffix = currentContent.length;
  let nextSuffix = nextContent.length;
  while (
    currentSuffix > prefix &&
    nextSuffix > prefix &&
    currentContent[currentSuffix - 1] === nextContent[nextSuffix - 1]
  ) {
    currentSuffix -= 1;
    nextSuffix -= 1;
  }

  const start = model.getPositionAt(prefix);
  const end = model.getPositionAt(currentSuffix);
  return [
    {
      range: new monacoInstance.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      text: nextContent.slice(prefix, nextSuffix),
      forceMoveMarkers: true,
    },
  ];
}

/**
 * Convert an array of OT RawOps into Monaco edit operations.
 * RawOp encoding: positive number = retain, string = insert, negative number = remove (|n| characters).
 */
export function opsToMonacoEdits(
  ops: (number | string | { retain?: number; insert?: string; delete?: number })[],
  model: monaco.editor.ITextModel,
  monacoInstance: Monaco
): monaco.editor.IIdentifiedSingleEditOperation[] {
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  let cursor = 0;
  // Buffer insert text so an adjacent remove can be merged into a single replace edit (avoiding overlapping ranges).
  let pendingInsert: string | null = null;

  const flushInsert = () => {
    if (pendingInsert !== null) {
      const pos = model.getPositionAt(cursor);
      edits.push({
        range: new monacoInstance.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        text: pendingInsert,
      });
      pendingInsert = null;
    }
  };

  for (const op of ops) {
    if (typeof op === 'number') {
      if (op > 0) {
        flushInsert();
        cursor += op;
      } else if (op < 0) {
        // remove — merge with pendingInsert into a replace when present, otherwise a plain delete
        const removeLen = Math.abs(op);
        const start = model.getPositionAt(cursor);
        const end = model.getPositionAt(cursor + removeLen);
        edits.push({
          range: new monacoInstance.Range(
            start.lineNumber,
            start.column,
            end.lineNumber,
            end.column
          ),
          text: pendingInsert,
        });
        pendingInsert = null;
        cursor += removeLen;
      }
    } else if (typeof op === 'string') {
      // insert — buffer the text in case a subsequent remove merges with it
      pendingInsert = pendingInsert !== null ? pendingInsert + op : op;
    }
  }

  flushInsert();
  return edits;
}

export function compileEntryTargetsFile(
  entryFile: string | undefined,
  activeFilePath: string
): boolean {
  if (!entryFile) return true;
  const normalizedEntry = entryFile.replace(/\\/g, '/');
  const normalizedActive = activeFilePath.replace(/\\/g, '/');
  const activeName = activeFilePath.split(/[/\\]/).pop() || activeFilePath;
  return (
    normalizedEntry === normalizedActive ||
    normalizedActive.endsWith(`/${normalizedEntry}`) ||
    normalizedEntry.endsWith(`/${activeName}`) ||
    normalizedEntry === activeName
  );
}

export function compilationEntriesToMarkers(
  entries: Array<{ line: number | null; message: string; file?: string }>,
  activeFilePath: string,
  monacoInstance: Monaco
): monaco.editor.IMarkerData[] {
  return entries
    .filter(
      (entry) =>
        typeof entry.line === 'number' &&
        entry.line > 0 &&
        compileEntryTargetsFile(entry.file, activeFilePath)
    )
    .map((entry) => ({
      severity: monacoInstance.MarkerSeverity.Error,
      message: entry.message,
      startLineNumber: entry.line!,
      startColumn: 1,
      endLineNumber: entry.line!,
      endColumn: Number.MAX_SAFE_INTEGER,
    }));
}

/** Build Monaco editor options from AppSettings.editor */
export function buildEditorOptions(
  editorSettings: AppSettings['editor']
): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    fontSize: editorSettings.fontSize,
    fontFamily: editorSettings.fontFamily,
    fontLigatures: false, // Prevents cursor position issues
    tabSize: editorSettings.tabSize,
    wordWrap: editorSettings.wordWrap ? ('on' as const) : ('off' as const),
    lineNumbers: editorSettings.lineNumbers ? ('on' as const) : ('off' as const),
    cursorStyle: editorSettings.cursorStyle,
    cursorBlinking: editorSettings.cursorBlinking,
    cursorWidth: 2,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    padding: { top: 16, bottom: 10 },
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
      verticalScrollbarSize: 12,
      horizontalScrollbarSize: 10,
      useShadows: false,
    },
    minimap: {
      enabled: editorSettings.minimap,
      showSlider: 'mouseover' as const,
      renderCharacters: false,
      maxColumn: 140,
    },
    overviewRulerLanes: 3,
    hideCursorInOverviewRuler: true,
    renderFinalNewline: 'off' as const,
    occurrencesHighlight: 'off' as const,
    selectionHighlight: false,
    links: false,
    folding: true,
    foldingHighlight: false,
    showFoldingControls: 'mouseover' as const,
  };
}
