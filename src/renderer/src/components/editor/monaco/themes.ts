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
      { token: 'keyword.structure', foreground: '93c5fd' }, // blue-300(冷)替暖黄
      { token: 'keyword.section', foreground: '67e8f9' }, // --color-accent-bright
      { token: 'keyword.reference', foreground: '94a3b8' }, // --color-text-secondary
      { token: 'keyword.format', foreground: '5eead4' }, // teal(冷)替暖橙棕
      { token: 'keyword.math', foreground: '10b981' }, // --color-success
      { token: 'string', foreground: '5eead4' }, // teal(冷)替暖橙棕
      { token: 'string.math', foreground: '22d3ee' }, // cyan(冷)替 amber
      { token: 'number', foreground: '10b981' }, // --color-success
      { token: 'delimiter.curly', foreground: '94a3b8' }, // slate(冷)替 amber
      { token: 'markup.heading', foreground: '67e8f9', fontStyle: 'bold' },
      { token: 'markup.quote', foreground: '94a3b8' },
      { token: 'markup.list', foreground: '22d3ee' },
      { token: 'markup.fence', foreground: '64748b' },
      { token: 'markup.inlinecode', foreground: '22d3ee' }, // cyan(冷)替 amber
      { token: 'markup.link', foreground: '38bdf8' },
      { token: 'markup.bold', foreground: 'f8fafc', fontStyle: 'bold' },
      { token: 'markup.italic', foreground: 'cbd5e1', fontStyle: 'italic' },
      { token: 'markup.table', foreground: 'cbd5e1' },
      { token: 'markup.html', foreground: '10b981' },
    ],
    colors: {
      // 注:Monaco 主题色只认 #RRGGBB[AA] hex,rgba() 会被丢弃回退默认 —— 全部用 hex
      'editor.background': '#18181b',
      'editor.foreground': '#fafafa',
      'editorCursor.foreground': '#22d3ee',
      'editor.lineHighlightBackground': '#27272a',
      // 选区:品牌 accent(柔青),替换原失效的 rgba(亮青)
      'editor.selectionBackground': '#69a7c738',
      'editor.inactiveSelectionBackground': '#69a7c71a',
      'editor.selectionHighlightBackground': '#69a7c724',
      'editorLineNumber.foreground': '#64748b',
      'editorLineNumber.activeForeground': '#94a3b8',
      'editorIndentGuide.background': '#ffffff0f',
      'editorIndentGuide.activeBackground': '#ffffff24',
      'editorWidget.background': '#202023',
      'editorWidget.border': '#ffffff14',
      // 诊断:柔和 danger/warning,替换 Monaco 默认刺眼红
      'editorError.foreground': '#d88484',
      'editorWarning.foreground': '#d1a168',
      // Overview ruler(右侧"红柱子"半透明降噪)
      'editorOverviewRuler.border': '#00000000',
      'editorOverviewRuler.errorForeground': '#d8848466',
      'editorOverviewRuler.warningForeground': '#d1a16866',
      'editorOverviewRuler.infoForeground': '#8fa2d955',
      // Minimap(右侧缩略图:选区 / 错误 / 警告 / 查找命中)
      'minimap.selectionHighlight': '#69a7c7',
      'minimap.errorHighlight': '#d88484',
      'minimap.warningHighlight': '#d1a168',
      'minimap.findMatchHighlight': '#69a7c7',
      // Scrollbar(中性 slate)
      'scrollbarSlider.background': '#94a3b833',
      'scrollbarSlider.hoverBackground': '#94a3b859',
      'scrollbarSlider.activeBackground': '#94a3b880',
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
      { token: 'keyword.control', foreground: 'c026d3' }, // fuchsia(冷)替 academic-red
      { token: 'keyword.structure', foreground: '2563eb' }, // blue 替 academic-gold
      { token: 'keyword.section', foreground: '1e4e8c' }, // academic-blue(冷,保留)
      { token: 'keyword.reference', foreground: '0d7377' }, // academic-teal(冷,保留)
      { token: 'keyword.format', foreground: '0d9488' }, // teal 替 academic-gold
      { token: 'keyword.math', foreground: '4f46e5' }, // --color-info
      { token: 'string', foreground: '0d7377' }, // academic-teal(冷,保留)
      { token: 'string.math', foreground: '0d9488' }, // teal 替 academic-gold
      { token: 'number', foreground: '0891b2' }, // cyan 替 academic-red
      { token: 'delimiter.curly', foreground: '64748b' }, // slate 替 academic-gold
      { token: 'markup.heading', foreground: '1e4e8c', fontStyle: 'bold' },
      { token: 'markup.quote', foreground: '6b7280' },
      { token: 'markup.list', foreground: '0d7377' },
      { token: 'markup.fence', foreground: '6b7280' },
      { token: 'markup.inlinecode', foreground: '0d9488' }, // teal(冷)替 academic-gold
      { token: 'markup.link', foreground: '1e4e8c' },
      { token: 'markup.bold', foreground: '1a1c1e', fontStyle: 'bold' },
      { token: 'markup.italic', foreground: '3d4249', fontStyle: 'italic' },
      { token: 'markup.table', foreground: '3d4249' },
      { token: 'markup.html', foreground: '0d7377' },
    ],
    colors: {
      // 注:Monaco 主题色只认 #RRGGBB[AA] hex,rgba() 会被丢弃回退默认 —— 全部用 hex
      'editor.background': '#ffffff',
      'editor.foreground': '#1e293b',
      'editorCursor.foreground': '#3f89a8',
      'editor.lineHighlightBackground': '#f1f5f9',
      // 选区:quiet-blue accent(与品牌强调色统一,去掉旧 academic-navy)
      'editor.selectionBackground': '#3f89a82e',
      'editor.inactiveSelectionBackground': '#3f89a817',
      'editor.selectionHighlightBackground': '#3f89a824',
      'editorLineNumber.foreground': '#94a3b8',
      'editorLineNumber.activeForeground': '#475569',
      'editorIndentGuide.background': '#1e293b0f',
      'editorIndentGuide.activeBackground': '#1e293b24',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#e2e8f0',
      // 诊断:柔和 danger/warning,替换 Monaco 默认刺眼红
      'editorError.foreground': '#c67070',
      'editorWarning.foreground': '#b7874c',
      // Overview ruler(右侧"红柱子"半透明降噪)
      'editorOverviewRuler.border': '#00000000',
      'editorOverviewRuler.errorForeground': '#c6707073',
      'editorOverviewRuler.warningForeground': '#b7874c70',
      'editorOverviewRuler.infoForeground': '#728dc766',
      // Minimap(右侧缩略图:选区 / 错误 / 警告 / 查找命中)
      'minimap.selectionHighlight': '#3f89a8',
      'minimap.errorHighlight': '#c67070',
      'minimap.warningHighlight': '#b7874c',
      'minimap.findMatchHighlight': '#3f89a8',
      // Scrollbar(中性 slate)
      'scrollbarSlider.background': '#64748b26',
      'scrollbarSlider.hoverBackground': '#64748b40',
      'scrollbarSlider.activeBackground': '#64748b59',
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
