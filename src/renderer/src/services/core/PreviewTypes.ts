/**
 * @file PreviewTypes.ts - Preview mode type definitions
 * @description Defines preview modes and sync event types for multi-engine preview system
 */

export type PreviewMode = 'pdf' | 'markdown' | 'typst' | 'none';

export enum SyncEventType {
  TEXT_CHANGED = 'text-changed',
  SCROLL_TO_LINE = 'scroll-to-line',
  CLICK_TO_SOURCE = 'click-to-source',
  RENDER_COMPLETE = 'render-complete',
}

export interface EditorToPreviewEvent {
  type: SyncEventType;
  content?: string;
  line?: number;
  filePath?: string;
}

export interface PreviewToEditorEvent {
  type: SyncEventType;
  line?: number;
  column?: number;
  filePath?: string;
}

/**
 * Resolve preview mode from file path based on extension.
 */
export function resolvePreviewMode(filePath: string | null): PreviewMode {
  if (!filePath) return 'none';

  const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';

  // Markdown files
  if (['.md', '.markdown', '.mdx'].includes(ext)) {
    return 'markdown';
  }

  // Typst files
  if (ext === '.typ') {
    return 'typst';
  }

  // LaTeX files
  if (['.tex', '.latex', '.ltx', '.sty', '.cls', '.bib'].includes(ext)) {
    return 'pdf';
  }

  return 'none';
}
