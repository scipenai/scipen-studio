/**
 * @file themes.ts - Monaco Theme Definitions
 * @description Defines editor dark and light themes, synced with design system colors
 */

import type { Monaco } from '@monaco-editor/react';

/**
 * Define dark theme - "Quantum Ink"
 * Synchronized with index.css :root variables
 */
function defineDarkTheme(monaco: Monaco): void {
  monaco.editor.defineTheme('scipen-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
      { token: 'keyword', foreground: '22d3ee' }, // cyan --color-accent
      { token: 'keyword.control', foreground: 'C586C0' },
      { token: 'keyword.structure', foreground: 'DCDCAA' },
      { token: 'keyword.section', foreground: '67e8f9' }, // --color-accent-bright
      { token: 'keyword.reference', foreground: '94a3b8' }, // --color-text-secondary
      { token: 'keyword.format', foreground: 'CE9178' },
      { token: 'keyword.math', foreground: '10b981' }, // --color-success
      { token: 'string', foreground: 'CE9178' },
      { token: 'string.math', foreground: 'f59e0b' }, // --color-warning
      { token: 'number', foreground: '10b981' }, // --color-success
      { token: 'delimiter.curly', foreground: 'f59e0b' }, // --color-warning
    ],
    colors: {
      // Synchronized with index.css --color-bg-secondary
      'editor.background': '#111827',
      // Synchronized with index.css --color-text-primary
      'editor.foreground': '#f1f5f9',
      // Synchronized with index.css --color-accent
      'editorCursor.foreground': '#22d3ee',
      // Synchronized with index.css --color-bg-tertiary
      'editor.lineHighlightBackground': '#1a2234',
      // Synchronized with index.css --editor-selectionBackground
      'editor.selectionBackground': 'rgba(34, 211, 238, 0.2)',
      'editor.inactiveSelectionBackground': 'rgba(34, 211, 238, 0.1)',
      // Synchronized with index.css --color-text-muted
      'editorLineNumber.foreground': '#64748b',
      // Synchronized with index.css --color-text-secondary
      'editorLineNumber.activeForeground': '#94a3b8',
      // Synchronized with index.css --color-border-subtle
      'editorIndentGuide.background': 'rgba(56, 189, 248, 0.08)',
      'editorIndentGuide.activeBackground': 'rgba(56, 189, 248, 0.12)',
      // Sidebar synchronized with index.css --color-bg-primary
      'editorWidget.background': '#0c1018',
      'editorWidget.border': 'rgba(56, 189, 248, 0.12)',
      // Scrollbar
      'scrollbarSlider.background': 'rgba(148, 163, 184, 0.2)',
      'scrollbarSlider.hoverBackground': 'rgba(148, 163, 184, 0.35)',
      'scrollbarSlider.activeBackground': 'rgba(148, 163, 184, 0.5)',
    },
  });
}

/**
 * Define light theme - "Paper Light"
 * Synchronized with index.css .light-theme variables
 */
function defineLightTheme(monaco: Monaco): void {
  monaco.editor.defineTheme('scipen-solarized-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' }, // --ink-medium
      { token: 'keyword', foreground: '1e4e8c' }, // --academic-blue
      { token: 'keyword.control', foreground: 'b91c1c' }, // --academic-red
      { token: 'keyword.structure', foreground: 'c07d10' }, // --academic-gold
      { token: 'keyword.section', foreground: '1e4e8c' }, // --academic-blue
      { token: 'keyword.reference', foreground: '0d7377' }, // --academic-teal
      { token: 'keyword.format', foreground: 'c07d10' }, // --academic-gold
      { token: 'keyword.math', foreground: '4f46e5' }, // --color-info
      { token: 'string', foreground: '0d7377' }, // --academic-teal
      { token: 'string.math', foreground: 'c07d10' }, // --academic-gold
      { token: 'number', foreground: 'b91c1c' }, // --academic-red
      { token: 'delimiter.curly', foreground: 'c07d10' }, // --academic-gold
    ],
    colors: {
      // Synchronized with index.css --paper-cream
      'editor.background': '#faf8f3',
      // Synchronized with index.css --ink-black
      'editor.foreground': '#1a1c1e',
      // Synchronized with index.css --academic-blue
      'editorCursor.foreground': '#1e4e8c',
      // Synchronized with index.css --paper-warm
      'editor.lineHighlightBackground': '#f4f1ea',
      // Selection background
      'editor.selectionBackground': 'rgba(30, 78, 140, 0.15)',
      'editor.inactiveSelectionBackground': 'rgba(30, 78, 140, 0.08)',
      // Synchronized with index.css --ink-medium
      'editorLineNumber.foreground': '#6b7280',
      // Synchronized with index.css --ink-dark
      'editorLineNumber.activeForeground': '#3d4249',
      // Indent guides
      'editorIndentGuide.background': 'rgba(30, 78, 140, 0.08)',
      'editorIndentGuide.activeBackground': 'rgba(30, 78, 140, 0.15)',
      // Widget background
      'editorWidget.background': '#ffffff',
      'editorWidget.border': 'rgba(30, 78, 140, 0.15)',
      // Scrollbar
      'scrollbarSlider.background': 'rgba(30, 78, 140, 0.15)',
      'scrollbarSlider.hoverBackground': 'rgba(30, 78, 140, 0.25)',
      'scrollbarSlider.activeBackground': 'rgba(30, 78, 140, 0.35)',
    },
  });
}

/**
 * Register and apply themes
 * @param monaco Monaco instance
 * @param currentTheme Current theme setting ('light' | 'dark' | 'system')
 */
export function registerThemes(monaco: Monaco, currentTheme: 'light' | 'dark' | 'system'): void {
  defineDarkTheme(monaco);
  defineLightTheme(monaco);
  applyTheme(monaco, currentTheme);
}

/**
 * Apply theme without redefining
 */
export function applyTheme(monaco: Monaco, currentTheme: 'light' | 'dark' | 'system'): void {
  if (currentTheme === 'light') {
    monaco.editor.setTheme('scipen-solarized-light');
  } else if (currentTheme === 'dark') {
    monaco.editor.setTheme('scipen-dark');
  } else {
    // Follow system preference
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    monaco.editor.setTheme(prefersDark ? 'scipen-dark' : 'scipen-solarized-light');
  }
}
