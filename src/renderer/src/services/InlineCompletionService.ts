/**
 * @file InlineCompletionService.ts - Inline Completion Service
 * @description Integrates deterministic completion and AI RAG completion to provide Monaco inline suggestions
 * @depends CompletionManager, Monaco Editor
 */

import type * as Monaco from 'monaco-editor';
import { DisposableStore, type IDisposable } from '../../../../shared/utils';
import {
  type CompletionContext,
  type CompletionItem,
  completionManager,
} from './CompletionManager';
import { isLSPSupportedFile } from './LSPService';
import { TaskPriority, cancelIdleTask, scheduleIdleTask } from './core/IdleTaskScheduler';
import { getEditorService, getProjectService } from './core/ServiceRegistry';

// ====== Configuration ======

const CONFIG = {
  INSTANT_TRIGGER_CHARS: ['\\', '{', '['],
  DEBOUNCE_DELAY: 500, // AI trigger delay (ms)
  MIN_PREFIX_LENGTH: 2, // Minimum prefix length to trigger AI
  MIN_LINE_LENGTH_FOR_CONTINUATION: 15, // After line reaches this length, space/punctuation can trigger continuation

  CACHE_MAX_SIZE: 100,

  // Performance optimization: isInMathMode only scans recent N lines
  MATH_MODE_SCAN_LINES: 100,

  GHOST_TEXT_COLOR: '#6b7280',
  SOURCE_ICON: '📚',

  INDEX_DEBOUNCE_MS: 2000,
};

// ====== State Types ======

interface CompletionState {
  isEnabled: boolean;
  currentSuggestion: string | null;
  suggestionSource: string | null;
  pendingRequest: AbortController | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  lastPrefix: string;
  partialAcceptIndex: number;
}

// ====== Utility Functions ======

/**
 * Detect if in math mode
 *
 * Optimization: Only scan content near cursor position to avoid full document scan
 * This significantly improves completion performance in long documents (e.g., academic papers)
 */
function isInMathMode(model: Monaco.editor.ITextModel, position: Monaco.Position): boolean {
  // Optimization: Only scan recent N lines instead of entire document
  const scanStartLine = Math.max(1, position.lineNumber - CONFIG.MATH_MODE_SCAN_LINES);

  const textUntilPosition = model.getValueInRange({
    startLineNumber: scanStartLine,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });

  const dollarCount = (textUntilPosition.match(/(?<!\\)\$/g) || []).length;
  if (dollarCount % 2 === 1) return true;

  const displayMathStart = (textUntilPosition.match(/\\\[/g) || []).length;
  const displayMathEnd = (textUntilPosition.match(/\\\]/g) || []).length;
  if (displayMathStart > displayMathEnd) return true;

  const mathEnvs = ['equation', 'align', 'gather', 'multline', 'eqnarray'];
  for (const env of mathEnvs) {
    const beginRe = new RegExp(`\\\\begin\\{${env}\\*?\\}`, 'g');
    const endRe = new RegExp(`\\\\end\\{${env}\\*?\\}`, 'g');
    const beginCount = (textUntilPosition.match(beginRe) || []).length;
    const endCount = (textUntilPosition.match(endRe) || []).length;
    if (beginCount > endCount) return true;
  }

  return false;
}

/**
 * Detect trigger context
 */
function detectTriggerContext(
  lineContent: string,
  column: number
): { type: 'command' | 'environment' | 'cite' | 'ref' | 'file' | 'text'; prefix: string } {
  const textBeforeCursor = lineContent.slice(0, column - 1);

  // \cite{...
  if (/\\cite[p]?\{[^}]*$/.test(textBeforeCursor)) {
    const match = textBeforeCursor.match(/\\cite[p]?\{([^}]*)$/);
    return { type: 'cite', prefix: match?.[1] || '' };
  }

  // \ref{...
  if (/\\ref\{[^}]*$/.test(textBeforeCursor)) {
    const match = textBeforeCursor.match(/\\ref\{([^}]*)$/);
    return { type: 'ref', prefix: match?.[1] || '' };
  }

  if (/\\(input|include|includegraphics)\{[^}]*$/.test(textBeforeCursor)) {
    const match = textBeforeCursor.match(/\\(input|include|includegraphics)\{([^}]*)$/);
    return { type: 'file', prefix: match?.[2] || '' };
  }

  // \begin{...
  if (/\\begin\{[^}]*$/.test(textBeforeCursor)) {
    const match = textBeforeCursor.match(/\\begin\{([^}]*)$/);
    return { type: 'environment', prefix: match?.[1] || '' };
  }

  if (/\\[a-zA-Z@]*$/.test(textBeforeCursor) || textBeforeCursor.endsWith('\\')) {
    const match = textBeforeCursor.match(/(\\[a-zA-Z@]*)$/);
    return { type: 'command', prefix: match?.[1] || '\\' };
  }

  const textMatch = textBeforeCursor.match(/([a-zA-Z0-9\u4e00-\u9fa5]*)$/);
  return { type: 'text', prefix: textMatch?.[1] || '' };
}

// ====== Monaco Completion Item Conversion ======

function toMonacoCompletionItems(
  items: CompletionItem[],
  range: Monaco.IRange,
  monaco: typeof Monaco
): Monaco.languages.CompletionItem[] {
  return items.map((item, index) => ({
    label: {
      label: item.label,
      description: item.detail,
    },
    kind: getMonacoCompletionKind(item.kind, monaco),
    insertText: item.insertText,
    insertTextRules: item.insertText.includes('${')
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      : undefined,
    documentation: item.documentation ? { value: item.documentation, isTrusted: true } : undefined,
    detail: item.previewHtml || item.detail,
    range,
    sortText: item.sortText || String(index).padStart(4, '0'),
    filterText: item.filterText || item.label,
  }));
}

function getMonacoCompletionKind(
  kind: CompletionItem['kind'],
  monaco: typeof Monaco
): Monaco.languages.CompletionItemKind {
  switch (kind) {
    case 'command':
      return monaco.languages.CompletionItemKind.Function;
    case 'environment':
      return monaco.languages.CompletionItemKind.Struct;
    case 'citation':
      return monaco.languages.CompletionItemKind.Reference;
    case 'label':
      return monaco.languages.CompletionItemKind.Variable;
    case 'file':
      return monaco.languages.CompletionItemKind.File;
    case 'math':
      return monaco.languages.CompletionItemKind.Constant;
    case 'snippet':
      return monaco.languages.CompletionItemKind.Snippet;
    case 'ai':
      return monaco.languages.CompletionItemKind.Text;
    default:
      return monaco.languages.CompletionItemKind.Text;
  }
}

// ====== InlineCompletionService Class ======

/**
 * Smart completion service
 *
 * Implements IDisposable interface to ensure proper resource cleanup
 */
export class InlineCompletionService implements IDisposable {
  private readonly _disposables = new DisposableStore();

  private _state: CompletionState = {
    isEnabled: true,
    currentSuggestion: null,
    suggestionSource: null,
    pendingRequest: null,
    debounceTimer: null,
    lastPrefix: '',
    partialAcceptIndex: 0,
  };

  private _pendingIndexUpdates = new Map<
    string,
    { content: string; timer: ReturnType<typeof setTimeout> }
  >();

  // Monaco provider disposables
  private _providerDisposables: Monaco.IDisposable[] = [];

  // ============ Getters ============

  get isEnabled(): boolean {
    return this._state.isEnabled;
  }

  get currentSuggestion(): string | null {
    return this._state.currentSuggestion;
  }

  get suggestionSource(): string | null {
    return this._state.suggestionSource;
  }

  // ====== Control Methods ======

  enable(): void {
    this._state.isEnabled = true;
  }

  disable(): void {
    this._state.isEnabled = false;
  }

  clearCache(): void {
    completionManager.clearCache();
  }

  // ====== Partial Acceptance Feature ======

  getNextWordFromSuggestion(): string | null {
    if (!this._state.currentSuggestion) return null;

    const remaining = this._state.currentSuggestion.slice(this._state.partialAcceptIndex);
    if (!remaining) return null;

    const match = remaining.match(/^(\s*\S+)/);
    if (match) {
      const word = match[1];
      this._state.partialAcceptIndex += word.length;
      return word;
    }

    return null;
  }

  resetPartialAccept(): void {
    this._state.partialAcceptIndex = 0;
  }

  // ====== Index Management ======

  async indexProjectFiles(projectPath: string): Promise<void> {
    await completionManager.getIndexer().indexProject(projectPath);
  }

  /**
   * Update single file index (with debounce)
   */
  updateFileIndex(filePath: string, content: string): void {
    const pending = this._pendingIndexUpdates.get(filePath);
    if (pending) {
      clearTimeout(pending.timer);
    }

    const timer = setTimeout(() => {
      this._pendingIndexUpdates.delete(filePath);

      // Use unified scheduler to avoid multiple tasks executing simultaneously when switching back
      // Fixed task ID, duplicate scheduling automatically deduplicates
      scheduleIdleTask(
        () => {
          completionManager.getIndexer().updateFile(filePath, content);
        },
        {
          id: `index-file-${filePath}`,
          priority: TaskPriority.Low,
          timeout: 5000,
        }
      );
    }, CONFIG.INDEX_DEBOUNCE_MS);

    this._pendingIndexUpdates.set(filePath, { content, timer });
  }

  /**
   * Clear pending index update for specified file
   * Called when file closes to prevent memory leaks
   */
  clearPendingIndexUpdate(filePath: string): void {
    const pending = this._pendingIndexUpdates.get(filePath);
    if (pending) {
      clearTimeout(pending.timer);
      this._pendingIndexUpdates.delete(filePath);
    }
    cancelIdleTask(`index-file-${filePath}`);
  }

  getIndexStats(): { labels: number; citations: number; files: number } {
    return completionManager.getIndexer().getStats();
  }

  // ====== Provider Registration ======

  /**
   * Register Monaco completion providers
   */
  registerProviders(monaco: typeof Monaco, languageId = 'latex'): IDisposable {
    const completionDisposable = monaco.languages.registerCompletionItemProvider(
      languageId,
      this._createCompletionProvider(monaco)
    );
    this._providerDisposables.push(completionDisposable);

    const inlineDisposable = this._createInlineCompletionProvider(monaco, languageId);
    this._providerDisposables.push(inlineDisposable);

    return {
      dispose: () => {
        completionDisposable.dispose();
        inlineDisposable.dispose();
        this._providerDisposables = this._providerDisposables.filter(
          (d) => d !== completionDisposable && d !== inlineDisposable
        );
      },
    };
  }

  // ====== Layer 1: Deterministic Completion Provider ======

  _createCompletionProvider(monaco: typeof Monaco): Monaco.languages.CompletionItemProvider {
    return {
      triggerCharacters: ['\\', '{', '[', ','],

      provideCompletionItems: async (
        model: Monaco.editor.ITextModel,
        position: Monaco.Position,
        _context: Monaco.languages.CompletionContext,
        _token: Monaco.CancellationToken
      ): Promise<Monaco.languages.CompletionList | null> => {
        const lineContent = model.getLineContent(position.lineNumber);
        const triggerContext = detectTriggerContext(lineContent, position.column);
        const inMathMode = isInMathMode(model, position);

        const items: CompletionItem[] = [];

        const activeTabPath = getEditorService().activeTabPath;
        const filePath =
          activeTabPath && isLSPSupportedFile(activeTabPath) ? activeTabPath : undefined;

        switch (triggerContext.type) {
          case 'command':
            const commandItems = await completionManager.getCommandCompletionsAsync(
              triggerContext.prefix,
              inMathMode,
              filePath,
              position.lineNumber,
              position.column
            );
            items.push(...commandItems);
            break;

          case 'environment':
            items.push(...completionManager.getEnvironmentCompletions(triggerContext.prefix));
            break;

          case 'cite':
            items.push(...completionManager.getCitationCompletions(triggerContext.prefix));
            break;

          case 'ref':
            const labelPrefix = triggerContext.prefix.match(/^([a-z]+:)/)?.[1];
            items.push(
              ...completionManager.getLabelCompletions(
                triggerContext.prefix.replace(/^[a-z]+:/, ''),
                labelPrefix
              )
            );
            break;

          case 'file':
            const extensions = lineContent.includes('includegraphics')
              ? ['png', 'jpg', 'jpeg', 'pdf', 'eps', 'svg']
              : ['tex'];
            items.push(...completionManager.getFileCompletions(triggerContext.prefix, extensions));
            break;
        }

        if (items.length === 0) {
          return null;
        }

        const wordAtPosition = model.getWordAtPosition(position);
        const range: Monaco.IRange = wordAtPosition
          ? {
              startLineNumber: position.lineNumber,
              startColumn: wordAtPosition.startColumn,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            }
          : {
              startLineNumber: position.lineNumber,
              startColumn: Math.max(1, position.column - triggerContext.prefix.length),
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            };

        const suggestions = toMonacoCompletionItems(items, range, monaco);

        return {
          suggestions,
          incomplete: false,
        };
      },
    };
  }

  // ====== Layer 2: AI Ghost Text Provider ======

  _createInlineCompletionProvider(monaco: typeof Monaco, languageId: string): Monaco.IDisposable {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingController: AbortController | null = null;
    let lastRequestId = 0;

    const state = this._state;

    const provider: Monaco.languages.InlineCompletionsProvider = {
      disposeInlineCompletions: () => {
        // Called by Monaco when completion is accepted or cancelled
      },

      provideInlineCompletions: async (
        model: Monaco.editor.ITextModel,
        position: Monaco.Position,
        _context: Monaco.languages.InlineCompletionContext,
        token: Monaco.CancellationToken
      ) => {
        if (!state.isEnabled) return null;

        const lineContent = model.getLineContent(position.lineNumber);
        const textBeforeCursor = lineContent.slice(0, position.column - 1);
        const triggerContext = detectTriggerContext(lineContent, position.column);

        // Instant trigger strategy: Don't trigger AI for \、{ etc.
        if (CONFIG.INSTANT_TRIGGER_CHARS.some((c) => textBeforeCursor.endsWith(c))) {
          return null;
        }

        if (triggerContext.type !== 'text') {
          return null;
        }

        const trimmedLineLength = textBeforeCursor.trim().length;
        const endsWithSpaceOrPunctuation = /[\s,.;:!?，。；：！？]$/.test(textBeforeCursor);
        const canTriggerContinuation =
          trimmedLineLength >= CONFIG.MIN_LINE_LENGTH_FOR_CONTINUATION &&
          endsWithSpaceOrPunctuation;

        if (triggerContext.prefix.length < CONFIG.MIN_PREFIX_LENGTH && !canTriggerContinuation) {
          return null;
        }

        // Cancel previous request
        if (pendingController) {
          pendingController.abort();
        }
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        const requestId = ++lastRequestId;
        pendingController = new AbortController();

        return new Promise((resolve) => {
          debounceTimer = setTimeout(async () => {
            if (token.isCancellationRequested || requestId !== lastRequestId) {
              resolve(null);
              return;
            }

            try {
              const fullContent = model.getValue();
              const inMathMode = isInMathMode(model, position);

              const completionContext: CompletionContext = {
                lineContent,
                lineNumber: position.lineNumber,
                column: position.column,
                prefix: triggerContext.prefix,
                isInMathMode: inMathMode,
                documentContent: fullContent,
              };

              const completionKnowledgeBaseId = getProjectService().completionKnowledgeBaseId;

              const suggestion = await completionManager.getAICompletion(
                completionContext,
                completionKnowledgeBaseId || undefined,
                pendingController?.signal
              );

              if (!suggestion || token.isCancellationRequested || requestId !== lastRequestId) {
                resolve(null);
                return;
              }

              state.currentSuggestion = suggestion.text;
              state.suggestionSource = suggestion.source || null;
              state.partialAcceptIndex = 0;

              resolve({
                items: [
                  {
                    insertText: suggestion.text,
                    range: {
                      startLineNumber: position.lineNumber,
                      startColumn: position.column,
                      endLineNumber: position.lineNumber,
                      endColumn: position.column,
                    },
                    command: suggestion.source
                      ? {
                          id: 'editor.action.showHover',
                          title: `Source: ${suggestion.source}`,
                        }
                      : undefined,
                  },
                ],
              });
            } catch (error) {
              if ((error as Error).name !== 'AbortError') {
                console.error('AI completion failed:', error);
              }
              resolve(null);
            }
          }, CONFIG.DEBOUNCE_DELAY);
        });
      },
    };

    const disposable = monaco.languages.registerInlineCompletionsProvider(languageId, provider);

    return {
      dispose: () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        if (pendingController) pendingController.abort();
        disposable.dispose();
      },
    };
  }

  // ====== Lifecycle ======

  dispose(): void {
    for (const [, pending] of this._pendingIndexUpdates) {
      clearTimeout(pending.timer);
    }
    this._pendingIndexUpdates.clear();

    if (this._state.debounceTimer) {
      clearTimeout(this._state.debounceTimer);
    }

    if (this._state.pendingRequest) {
      this._state.pendingRequest.abort();
    }

    for (const disposable of this._providerDisposables) {
      disposable.dispose();
    }
    this._providerDisposables = [];

    this._state = {
      isEnabled: false,
      currentSuggestion: null,
      suggestionSource: null,
      pendingRequest: null,
      debounceTimer: null,
      lastPrefix: '',
      partialAcceptIndex: 0,
    };

    this._disposables.dispose();
  }
}

// ====== Singleton Instance ======

let Instance: InlineCompletionService | null = null;

export function getInlineCompletionService(): InlineCompletionService {
  if (!Instance) {
    Instance = new InlineCompletionService();
  }
  return Instance;
}

export function _setInlineCompletionServiceInstance(instance: InlineCompletionService): void {
  Instance = instance;
}

// ====== Backward Compatible Exports ======
// Maintain backward compatibility with old API, gradually migrate callers

const service = getInlineCompletionService();

export function createCompletionProvider(
  monaco: typeof Monaco
): Monaco.languages.CompletionItemProvider {
  return service._createCompletionProvider(monaco);
}

export function createInlineCompletionProvider(
  monaco: typeof Monaco,
  languageId = 'latex'
): Monaco.IDisposable {
  return service._createInlineCompletionProvider(monaco, languageId);
}

export function registerInlineCompletionProvider(
  monaco: typeof Monaco,
  languageId = 'latex'
): Monaco.IDisposable {
  return service.registerProviders(monaco, languageId);
}

export function enableCompletion(): void {
  service.enable();
}

export function disableCompletion(): void {
  service.disable();
}

export function isCompletionEnabled(): boolean {
  return service.isEnabled;
}

export function clearCompletionCache(): void {
  service.clearCache();
}

export function getNextWordFromSuggestion(): string | null {
  return service.getNextWordFromSuggestion();
}

export function resetPartialAccept(): void {
  service.resetPartialAccept();
}

export function getSuggestionSource(): string | null {
  return service.suggestionSource;
}

export async function indexProjectFiles(projectPath: string): Promise<void> {
  return service.indexProjectFiles(projectPath);
}

export function updateFileIndex(filePath: string, content: string): void {
  service.updateFileIndex(filePath, content);
}

export function getIndexStats(): { labels: number; citations: number; files: number } {
  return service.getIndexStats();
}
