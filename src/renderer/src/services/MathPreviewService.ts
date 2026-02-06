/**
 * @file MathPreviewService.ts - Math Formula Preview Service
 * @description Implements formula hover preview using KaTeX and Monaco Content Widget
 * @depends KaTeX, Monaco Editor
 */

import katex from 'katex';
import type * as Monaco from 'monaco-editor';
import { createLogger } from './LogService';

const logger = createLogger('MathPreviewService');

// ====== Type Definitions ======

interface MathPreviewConfig {
  enabled: boolean;
  displayMode: 'hover';
  maxPreviewWidth: number;
  fontSize: number;
}

interface MathMatch {
  latex: string;
  type: 'inline' | 'display';
  start: number;
  end: number;
  startLine?: number;
  endLine?: number;
  endColumn?: number;
}

// ====== Custom Hover Widget ======

class MathHoverWidget implements Monaco.editor.IContentWidget {
  private domNode: HTMLElement;
  private position: Monaco.editor.IContentWidgetPosition | null = null;
  public static readonly ID = 'math.preview.widget';

  constructor() {
    this.domNode = document.createElement('div');
    this.domNode.style.cssText = `
      position: absolute;
      z-index: 1000;
      pointer-events: none;
      transition: opacity 0.1s ease-in-out;
      opacity: 0;
    `;
  }

  getId(): string {
    return MathHoverWidget.ID;
  }

  getDomNode(): HTMLElement {
    return this.domNode;
  }

  getPosition(): Monaco.editor.IContentWidgetPosition | null {
    return this.position;
  }

  show(position: Monaco.IPosition, htmlContent: string) {
    this.position = {
      position: position,
      preference: [1, 2], // ABOVE, BELOW
    };

    this.domNode.innerHTML = `
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
      <style>
        .math-preview-card {
          background-color: var(--color-bg-elevated);
          border: 1px solid var(--color-border);
          border-radius: 8px;
          box-shadow: var(--shadow-md), 0 0 0 1px var(--color-border-subtle);
          color: var(--color-text-primary);
          font-family: 'Inter', system-ui, sans-serif;
          min-width: 280px;
          max-width: 600px;
          overflow: hidden;
          animation: slideIn 0.15s cubic-bezier(0.2, 0, 0.13, 1.5);
          transform-origin: bottom center;
        }
        
        .math-preview-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px;
          background-color: var(--color-bg-tertiary);
          border-bottom: 1px solid var(--color-border);
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.02em;
          color: var(--color-text-muted);
          user-select: none;
        }
        
        .math-preview-header-icon {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        
        .math-preview-content {
          padding: 20px 24px;
          display: flex;
          justify-content: center;
          align-items: center;
          overflow-x: auto;
          font-family: 'KaTeX_Main', 'Times New Roman', serif;
          font-size: 1.3em;
          background-color: var(--color-bg-elevated);
        }
        
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(4px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        
        .math-preview-content::-webkit-scrollbar {
          height: 4px;
        }
        .math-preview-content::-webkit-scrollbar-thumb {
          background: var(--color-border-strong);
          border-radius: 2px;
        }
      </style>
      
      <div class="math-preview-card">
        <div class="math-preview-header">
          <div class="math-preview-header-icon">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 4h16v16H4z"></path>
              <path d="M4 4l16 16"></path>
              <path d="M4 20L20 4"></path>
            </svg>
            <span>LaTeX Preview</span>
          </div>
          <div style="font-size: 10px; opacity: 0.7;">KaTeX</div>
        </div>
        <div class="math-preview-content">
          ${htmlContent}
        </div>
      </div>
    `;
    this.domNode.style.opacity = '1';
  }

  hide() {
    this.position = null;
    this.domNode.style.opacity = '0';
  }
}

// ====== Formula Preview Service ======

export class MathPreviewService {
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private monaco: typeof Monaco | null = null;
  private widget: MathHoverWidget | null = null;
  private disposables: Monaco.IDisposable[] = [];
  private decorations: string[] = [];
  private config: MathPreviewConfig = {
    enabled: true,
    displayMode: 'hover',
    maxPreviewWidth: 400,
    fontSize: 14,
  };
  private updateDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastContentHash = '';

  initialize(
    editor: Monaco.editor.IStandaloneCodeEditor,
    monaco: typeof Monaco,
    config?: Partial<MathPreviewConfig>
  ): void {
    this.editor = editor;
    this.monaco = monaco;
    this.widget = new MathHoverWidget();

    if (config) {
      this.config = { ...this.config, ...config };
    }

    editor.addContentWidget(this.widget);

    this.setupHoverListener();

    this.disposables.push(
      editor.onDidChangeModelContent(() => {
        this.debouncedUpdateMathZones();
      })
    );

    requestAnimationFrame(() => this.updateMathZones());
  }

  private setupHoverListener() {
    if (!this.editor || !this.widget) return;

    this.disposables.push(
      this.editor.onMouseMove((e) => {
        if (!this.config.enabled) return;

        if (e.target.type !== this.monaco!.editor.MouseTargetType.CONTENT_TEXT) {
          this.widget!.hide();
          this.editor!.layoutContentWidget(this.widget!);
          return;
        }

        const position = e.target.position;
        if (!position) return;

        const model = this.editor!.getModel();
        if (!model) return;

        const lineContent = model.getLineContent(position.lineNumber);
        let mathMatch: MathMatch | null = this.findMathAtPosition(lineContent, position.column);

        if (!mathMatch) {
          mathMatch = this.findMultiLineMathAtPosition(model, position);
        }

        if (mathMatch) {
          try {
            const html = katex.renderToString(mathMatch.latex, {
              displayMode: true,
              throwOnError: false,
              output: 'html',
              trust: true,
              strict: false,
              macros: {
                '\\eqref': '\\href{#1}{(\\text{#1})}',
                '\\ref': '\\href{#1}{\\text{#1}}',
                '\\label': '\\href{#1}{}',
              },
            });

            this.widget!.show(position, html);
            this.editor!.layoutContentWidget(this.widget!);
          } catch (err) {
            logger.warn('Failed to render formula', err);
          }
        } else {
          this.widget!.hide();
          this.editor!.layoutContentWidget(this.widget!);
        }
      })
    );
  }

  updateConfig(config: Partial<MathPreviewConfig>): void {
    this.config = { ...this.config, ...config };
    this.updateMathZones();
  }

  private findMultiLineMathAtPosition(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position
  ): MathMatch | null {
    const content = model.getValue();
    const lines = content.split('\n');

    let offset = 0;
    for (let i = 0; i < position.lineNumber - 1; i++) {
      offset += lines[i].length + 1;
    }
    offset += position.column - 1;

    const patterns: Array<{ regex: RegExp; type: 'inline' | 'display' }> = [
      { regex: /\$\$([\s\S]*?)\$\$/g, type: 'display' },
      { regex: /\\\[([\s\S]*?)\\\]/g, type: 'display' },
      { regex: /\\\(([\s\S]*?)\\\)/g, type: 'inline' },
      {
        regex: /\\begin\{(equation|align|gather|multline|eqnarray)\*?\}([\s\S]*?)\\end\{\1\*?\}/g,
        type: 'display',
      },
    ];

    for (const { regex, type } of patterns) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const matchStart = match.index;
        const matchEnd = match.index + match[0].length;

        if (offset >= matchStart && offset <= matchEnd) {
          const startPos = this.offsetToPosition(content, matchStart);
          const endPos = this.offsetToPosition(content, matchEnd);

          let latex = match[1];
          if (match[2]) {
            latex = match[2];
          }

          return {
            latex: latex.trim(),
            type,
            start: startPos.column,
            end: endPos.column,
            startLine: startPos.line,
            endLine: endPos.line,
            endColumn: endPos.column,
          };
        }
      }
    }

    return null;
  }

  private offsetToPosition(content: string, offset: number): { line: number; column: number } {
    const lines = content.slice(0, offset).split('\n');
    return {
      line: lines.length,
      column: lines[lines.length - 1].length + 1,
    };
  }

  private findMathAtPosition(line: string, column: number): MathMatch | null {
    const displayDollarRegex = /\$\$([\s\S]*?)\$\$/g;
    let match;
    while ((match = displayDollarRegex.exec(line)) !== null) {
      if (column >= match.index && column <= match.index + match[0].length) {
        return {
          latex: match[1],
          type: 'display',
          start: match.index,
          end: match.index + match[0].length,
        };
      }
    }

    const inlineRegex = /(?<!\$)\$(?!\$)([^$\n]+)\$(?!\$)/g;
    while ((match = inlineRegex.exec(line)) !== null) {
      if (column >= match.index && column <= match.index + match[0].length) {
        return {
          latex: match[1],
          type: 'inline',
          start: match.index,
          end: match.index + match[0].length,
        };
      }
    }

    const inlineMatch = this.findBalancedDelimiter(line, column, '\\(', '\\)');
    if (inlineMatch) {
      return { ...inlineMatch, type: 'inline' };
    }

    const displayMatch = this.findBalancedDelimiter(line, column, '\\[', '\\]');
    if (displayMatch) {
      return { ...displayMatch, type: 'display' };
    }

    return null;
  }

  private findBalancedDelimiter(
    line: string,
    column: number,
    openDelim: string,
    closeDelim: string
  ): { latex: string; start: number; end: number } | null {
    let searchStart = 0;

    while (searchStart < line.length) {
      const openIdx = line.indexOf(openDelim, searchStart);
      if (openIdx === -1) break;

      let depth = 1;
      let i = openIdx + openDelim.length;

      while (i <= line.length - closeDelim.length && depth > 0) {
        if (line.startsWith(openDelim, i)) {
          depth++;
          i += openDelim.length;
        } else if (line.startsWith(closeDelim, i)) {
          depth--;
          if (depth === 0) {
            const end = i + closeDelim.length;
            if (column >= openIdx && column <= end) {
              return {
                latex: line.slice(openIdx + openDelim.length, i),
                start: openIdx,
                end: end,
              };
            }
          }
          i += closeDelim.length;
        } else {
          i++;
        }
      }

      searchStart = openIdx + openDelim.length;
    }

    return null;
  }

  private debouncedUpdateMathZones(): void {
    if (this.updateDebounceTimer) {
      clearTimeout(this.updateDebounceTimer);
    }
    this.updateDebounceTimer = setTimeout(() => {
      this.updateMathZones();
    }, 500);
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  private updateMathZones(): void {
    if (!this.editor || !this.monaco || !this.config.enabled) return;

    const model = this.editor.getModel();
    if (!model) return;

    const content = model.getValue();
    const contentHash = this.simpleHash(content);
    if (contentHash === this.lastContentHash) {
      return;
    }
    this.lastContentHash = contentHash;
    this.addMathDecorations(model, content);
  }

  private addMathDecorations(model: Monaco.editor.ITextModel, content?: string): void {
    if (!this.monaco || !this.editor) return;

    const decorations: Monaco.editor.IModelDeltaDecoration[] = [];
    const docContent = content ?? model.getValue();

    const multiLinePatterns: Array<{ regex: RegExp; className: string }> = [
      {
        regex: /\\begin\{(equation|align|gather|multline|eqnarray)\*?\}[\s\S]*?\\end\{\1\*?\}/g,
        className: 'math-formula-highlight math-formula-display',
      },
      { regex: /\$\$[\s\S]*?\$\$/g, className: 'math-formula-highlight math-formula-display' },
      { regex: /\\\[[\s\S]*?\\\]/g, className: 'math-formula-highlight math-formula-display' },
      { regex: /\\\([\s\S]*?\\\)/g, className: 'math-formula-highlight' },
    ];

    const processedRanges: Array<{ start: number; end: number }> = [];

    for (const { regex, className } of multiLinePatterns) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(docContent)) !== null) {
        const matchStart = match.index;
        const matchEnd = match.index + match[0].length;

        const overlaps = processedRanges.some(
          (r) =>
            (matchStart >= r.start && matchStart < r.end) ||
            (matchEnd > r.start && matchEnd <= r.end)
        );
        if (overlaps) continue;

        processedRanges.push({ start: matchStart, end: matchEnd });

        const startPos = this.offsetToPosition(docContent, matchStart);
        const endPos = this.offsetToPosition(docContent, matchEnd);

        decorations.push({
          range: new this.monaco!.Range(startPos.line, startPos.column, endPos.line, endPos.column),
          options: {
            className: className,
          },
        });
      }
    }

    const lines = docContent.split('\n');
    let lineOffset = 0;

    lines.forEach((line, index) => {
      const inlineDollarRegex = /(?<!\$)\$(?!\$)([^$\n]+)\$(?!\$)/g;
      let match;
      while ((match = inlineDollarRegex.exec(line)) !== null) {
        const absoluteStart = lineOffset + match.index;
        const absoluteEnd = absoluteStart + match[0].length;

        const overlaps = processedRanges.some(
          (r) =>
            (absoluteStart >= r.start && absoluteStart < r.end) ||
            (absoluteEnd > r.start && absoluteEnd <= r.end)
        );
        if (overlaps) continue;

        decorations.push({
          range: new this.monaco!.Range(
            index + 1,
            match.index + 1,
            index + 1,
            match.index + match[0].length + 1
          ),
          options: {
            inlineClassName: 'math-formula-highlight',
          },
        });
      }
      lineOffset += line.length + 1;
    });

    this.decorations = this.editor.deltaDecorations(this.decorations, decorations);
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    if (enabled) {
      this.updateMathZones();
    } else {
      if (this.editor) {
        this.decorations = this.editor.deltaDecorations(this.decorations, []);
      }
      this.widget?.hide();
    }
  }

  dispose(): void {
    if (this.updateDebounceTimer) {
      clearTimeout(this.updateDebounceTimer);
      this.updateDebounceTimer = null;
    }

    if (this.editor && this.widget) {
      this.editor.removeContentWidget(this.widget);
    }

    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];

    if (this.editor) {
      this.decorations = this.editor.deltaDecorations(this.decorations, []);
    }
    this.editor = null;
    this.monaco = null;
    this.widget = null;
    this.lastContentHash = '';
  }
}

// ====== Export Singleton ======

export const mathPreviewService = new MathPreviewService();
