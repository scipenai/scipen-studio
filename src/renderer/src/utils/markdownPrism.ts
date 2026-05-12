import Prism from 'prismjs';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-latex';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-python';

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  md: 'markdown',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  tex: 'latex',
  ltx: 'latex',
  typ: 'latex',
  typst: 'latex',
  py: 'python',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function resolveMarkdownLanguage(languageHint?: string | null): string {
  const normalized = (languageHint || '').trim().toLowerCase();
  if (!normalized) return '';
  return LANGUAGE_ALIASES[normalized] || normalized;
}

export function highlightMarkdownCode(
  code: string,
  languageHint?: string | null
): {
  html: string;
  language: string;
  highlighted: boolean;
} {
  const language = resolveMarkdownLanguage(languageHint);
  const grammar = language ? Prism.languages[language] : null;

  if (!language || !grammar) {
    return {
      html: escapeHtml(code),
      language,
      highlighted: false,
    };
  }

  return {
    html: Prism.highlight(code, grammar, language),
    language,
    highlighted: true,
  };
}
