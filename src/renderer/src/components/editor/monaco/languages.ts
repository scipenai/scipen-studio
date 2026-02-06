/**
 * @file languages.ts - Monaco Language Registration
 * @description Registers LaTeX and Typst language syntax highlighting and configurations
 */

import type { Monaco } from '@monaco-editor/react';

function registerLatexLanguage(monaco: Monaco): void {
  const languages = monaco.languages.getLanguages();
  const hasLatex = languages.some((lang: { id: string }) => lang.id === 'latex');

  if (hasLatex) return;

  monaco.languages.register({
    id: 'latex',
    extensions: ['.tex', '.latex', '.ltx', '.sty', '.cls'],
  });

  monaco.languages.setLanguageConfiguration('latex', {
    comments: {
      lineComment: '%',
    },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '$', close: '$' },
      { open: '`', close: "'" },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '$', close: '$' },
    ],
  });

  // Enhanced LaTeX syntax highlighting
  monaco.languages.setMonarchTokensProvider('latex', {
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        [/\\documentclass(\[[^\]]*\])?\{[^}]*\}/, 'keyword.control'],
        [/\\usepackage(\[[^\]]*\])?\{[^}]*\}/, 'keyword.control'],
        [/\\begin\{[^}]+\}/, 'keyword.structure'],
        [/\\end\{[^}]+\}/, 'keyword.structure'],
        [
          /\\(section|subsection|subsubsection|chapter|part)\*?\{/,
          { token: 'keyword.section', next: '@braces' },
        ],
        [/\\(label|ref|cite|eqref|pageref)\{/, { token: 'keyword.reference', next: '@braces' }],
        [/\\(textbf|textit|underline|emph)\{/, { token: 'keyword.format', next: '@braces' }],
        [/\\[a-zA-Z@]+\*?/, 'keyword'],
        [/\$\$/, { token: 'string.math', next: '@mathDisplay' }],
        [/\$/, { token: 'string.math', next: '@mathInline' }],
        [/\\\[/, { token: 'string.math', next: '@mathDisplayBracket' }],
        [/\\\(/, { token: 'string.math', next: '@mathInlineBracket' }],
        [/\{/, 'delimiter.curly'],
        [/\}/, 'delimiter.curly'],
        [/\[/, 'delimiter.square'],
        [/\]/, 'delimiter.square'],
        [/[0-9]+/, 'number'],
      ],
      braces: [
        [/[^{}]+/, 'string'],
        [/\}/, { token: 'delimiter.curly', next: '@pop' }],
      ],
      mathInline: [
        [/\$/, { token: 'string.math', next: '@pop' }],
        [/\\[a-zA-Z]+/, 'keyword.math'],
        [/./, 'string.math'],
      ],
      mathDisplay: [
        [/\$\$/, { token: 'string.math', next: '@pop' }],
        [/\\[a-zA-Z]+/, 'keyword.math'],
        [/./, 'string.math'],
      ],
      mathDisplayBracket: [
        [/\\\]/, { token: 'string.math', next: '@pop' }],
        [/\\[a-zA-Z]+/, 'keyword.math'],
        [/./, 'string.math'],
      ],
      mathInlineBracket: [
        [/\\\)/, { token: 'string.math', next: '@pop' }],
        [/\\[a-zA-Z]+/, 'keyword.math'],
        [/./, 'string.math'],
      ],
    },
  });
}

function registerTypstLanguage(monaco: Monaco): void {
  const languages = monaco.languages.getLanguages();
  const hasTypst = languages.some((lang: { id: string }) => lang.id === 'typst');

  if (hasTypst) return;

  monaco.languages.register({ id: 'typst', extensions: ['.typ'] });

  monaco.languages.setLanguageConfiguration('typst', {
    comments: {
      lineComment: '//',
      blockComment: ['/*', '*/'],
    },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: '$', close: '$' },
      { open: '*', close: '*' },
      { open: '_', close: '_' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: '$', close: '$' },
      { open: '*', close: '*' },
      { open: '_', close: '_' },
    ],
  });

  monaco.languages.setMonarchTokensProvider('typst', {
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],

        [/^=+\s.*$/, 'keyword.section'],

        [
          /#(let|set|show|import|include|if|else|for|while|break|continue|return)\b/,
          'keyword.control',
        ],
        [/#[\w-]+/, 'keyword.function'],

        [/<[\w-]+>/, 'keyword.reference'],
        [/@[\w-]+/, 'keyword.reference'],

        [/\*[^*]+\*/, 'keyword.strong'],
        [/_[^_]+_/, 'keyword.emphasis'],

        [/\$/, { token: 'string.math', next: '@math' }],

        [/"/, { token: 'string', next: '@string' }],

        [/\d+(\.\d+)?(em|pt|cm|mm|in|%)?/, 'number'],

        [/[{[(]/, 'delimiter.curly'],
        [/[})\]]/, 'delimiter.curly'],

        [/[+\-*/=<>!&|]+/, 'operator'],
      ],

      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],

      string: [
        [/[^\\"]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, { token: 'string', next: '@pop' }],
      ],

      math: [
        [/\$/, { token: 'string.math', next: '@pop' }],
        [/\\[a-zA-Z]+/, 'keyword.math'],
        [/./, 'string.math'],
      ],
    },
  });
}

export function registerLanguages(monaco: Monaco): void {
  registerLatexLanguage(monaco);
  registerTypstLanguage(monaco);
}
