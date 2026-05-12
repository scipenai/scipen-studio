/**
 * @file MarkdownContent.tsx - Markdown Renderer Component
 * @description Markdown renderer supporting GFM, LaTeX formulas and code highlighting
 */

// Import KaTeX CSS to properly render LaTeX formulas
import 'katex/dist/katex.min.css';

import { memo, useCallback, useMemo, useState, type ComponentPropsWithoutRef } from 'react';
import { useTranslation } from '../../locales';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Components } from 'react-markdown';
import { highlightMarkdownCode, resolveMarkdownLanguage } from '../../utils/markdownPrism';

/**
 * Convert LaTeX formula brackets to Markdown format
 * Uses balanced bracket algorithm to handle nested structures, based on cherry-studio implementation
 */
export const processLatexBrackets = (text: string): string => {
  if (!text) return text;

  // Check for potential LaTeX patterns - use [\s\S] to match any character including newlines
  const containsLatexRegex = /\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/;
  if (!containsLatexRegex.test(text)) {
    return text;
  }

  const protectedItems: string[] = [];
  let processedContent = text;

  processedContent = processedContent
    .replace(/(```[\s\S]*?```|`[^`]*`)/g, (match) => {
      const index = protectedItems.length;
      protectedItems.push(match);
      return `__SCIPEN_PROTECTED_${index}__`;
    })
    .replace(/\[([^[\]]*(?:\[[^\]]*\][^[\]]*)*)\]\([^)]*?\)/g, (match) => {
      const index = protectedItems.length;
      protectedItems.push(match);
      return `__SCIPEN_PROTECTED_${index}__`;
    });

  const findLatexMatch = (str: string, openDelim: string, closeDelim: string) => {
    // Count consecutive backslashes: odd count means escaped, even count means unescaped
    const escaped = (i: number) => {
      let count = 0;
      while (--i >= 0 && str[i] === '\\') count++;
      return count & 1;
    };
    for (let i = 0, n = str.length; i <= n - openDelim.length; i++) {
      if (!str.startsWith(openDelim, i) || escaped(i)) continue;

      for (let j = i + openDelim.length, depth = 1; j <= n - closeDelim.length && depth; j++) {
        const delta =
          str.startsWith(openDelim, j) && !escaped(j)
            ? 1
            : str.startsWith(closeDelim, j) && !escaped(j)
              ? -1
              : 0;

        if (delta) {
          depth += delta;
          if (!depth)
            return {
              start: i,
              end: j + closeDelim.length,
              pre: str.slice(0, i),
              body: str.slice(i + openDelim.length, j),
              post: str.slice(j + closeDelim.length),
            };
          j += (delta > 0 ? openDelim : closeDelim).length - 1;
        }
      }
    }
    return null;
  };

  const processMath = (
    content: string,
    openDelim: string,
    closeDelim: string,
    wrapper: string
  ): string => {
    let result = '';
    let remaining = content;

    while (remaining.length > 0) {
      const match = findLatexMatch(remaining, openDelim, closeDelim);
      if (!match) {
        result += remaining;
        break;
      }
      result += match.pre;
      result += `${wrapper}${match.body}${wrapper}`;
      remaining = match.post;
    }
    return result;
  };

  // Process block-level formulas first, then inline formulas (to avoid conflicts)
  let result = processMath(processedContent, '\\[', '\\]', '$$');
  result = processMath(result, '\\(', '\\)', '$');
  result = result.replace(/__SCIPEN_PROTECTED_(\d+)__/g, (match, indexStr) => {
    const index = Number.parseInt(indexStr, 10);
    if (index >= 0 && index < protectedItems.length) {
      return protectedItems[index];
    }
    return match;
  });

  return result;
};

export interface MarkdownContentProps {
  content: string;
  className?: string;
}

function stripHiddenContext(content: string): string {
  return content.replace(/\[SCIPEN_HIDDEN_CONTEXT\][\s\S]*?\[\/SCIPEN_HIDDEN_CONTEXT\]/g, '');
}

function normalizeShortFencedBlocks(content: string): string {
  return content.replace(/```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, (match, language, body) => {
    const normalizedBody = String(body ?? '').trim();
    const lines = normalizedBody.split('\n').filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      return '';
    }

    if (lines.length === 1 && normalizedBody.length <= 120 && !normalizedBody.includes('`')) {
      const inline = `\`${normalizedBody}\``;
      if (typeof language === 'string' && language.trim()) {
        return `${inline}`;
      }
      return inline;
    }

    return match;
  });
}

function formatCodeLanguageLabel(language: string): string {
  const normalized = language.toLowerCase().trim();
  if (!normalized || normalized === 'text' || normalized === 'plaintext') {
    return '';
  }
  return normalized;
}

function shouldUseCompactCodeBlock(code: string): boolean {
  const lines = code
    .trimEnd()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return (
    lines.length > 0 &&
    lines.length <= 6 &&
    lines.every((line) => line.length <= 48) &&
    code.trim().length <= 240
  );
}

function shouldRenderAsInlineCode(rawCode: string, language: string, inline?: boolean): boolean {
  if (inline) {
    return true;
  }

  const normalized = rawCode.trim();
  if (!normalized) {
    return false;
  }

  const lineCount = normalized.split('\n').filter((line) => line.trim().length > 0).length;
  if (language) {
    return false;
  }

  return lineCount === 1 && normalized.length <= 80;
}

interface MarkdownCodeBlockProps {
  code: string;
  language: string;
  html: string;
  className?: string;
  compact?: boolean;
}

const MarkdownCodeBlock = memo<MarkdownCodeBlockProps>(
  ({ code, language, html, className, compact = false }) => {
    const [copied, setCopied] = useState(false);
    const { t } = useTranslation();
    const languageLabel = formatCodeLanguageLabel(language);
    const showToolbar = !compact && Boolean(languageLabel || code.trim().length > 0);

    const handleCopy = useCallback(async () => {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }, [code]);

    if (compact) {
      return (
        <pre className="markdown-inline-code-block">
          <code
            className={`prism-code markdown-inline-code-block__code ${language ? `language-${language}` : ''} ${className || ''}`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </pre>
      );
    }

    return (
      <div className="markdown-code-block" data-language={language}>
        {showToolbar ? (
          <div className="markdown-code-block__toolbar">
            <div className="markdown-code-block__meta">
              {languageLabel ? (
                <span className="markdown-code-block__language">{languageLabel}</span>
              ) : null}
            </div>
            <button
              type="button"
              className="markdown-code-block__copy"
              data-copied={copied ? 'true' : 'false'}
              onClick={() => {
                void handleCopy();
              }}
            >
              {copied ? t('markdownContent.copied') : t('markdownContent.copyCode')}
            </button>
          </div>
        ) : null}
        <div
          className="markdown-code-block__scroll"
          role="region"
          aria-label={`${language || 'text'} code block`}
        >
          <pre className="markdown-code-block__body overflow-x-auto">
            <code
              className={`block whitespace-pre prism-code markdown-code-block__code ${language ? `language-${language}` : ''} ${className || ''}`}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </pre>
        </div>
      </div>
    );
  }
);

MarkdownCodeBlock.displayName = 'MarkdownCodeBlock';

const STATIC_MARKDOWN_COMPONENTS: Partial<Components> = {
  pre: ({ children }) => <>{children}</>,
  ul: ({ children }) => <ul className="list-disc list-inside space-y-1 my-2">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside space-y-1 my-2">{children}</ol>,
  li: ({ children }) => <li className="my-1 text-[var(--color-text-secondary)]">{children}</li>,
  p: ({ children }) => (
    <p className="my-2 leading-relaxed text-[var(--color-text-secondary)]">{children}</p>
  ),
  h1: ({ children }) => (
    <h1 className="text-[15px] font-bold mt-3 mb-1.5 text-[var(--color-text-primary)]">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-[15px] font-bold mt-2.5 mb-1.5 text-[var(--color-text-primary)]">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[15px] font-semibold mt-2 mb-1 text-[var(--color-text-primary)]">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-[14px] font-semibold mt-2 mb-1 text-[var(--color-text-primary)]">
      {children}
    </h4>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-[var(--color-accent)] pl-4 my-2 italic text-[var(--color-text-secondary)]">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-4">
      <table className="min-w-full border-collapse border border-[var(--color-border)] rounded-lg overflow-hidden">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-[var(--color-bg-tertiary)]">{children}</thead>,
  tbody: ({ children }) => (
    <tbody className="divide-y divide-[var(--color-border-subtle)]">{children}</tbody>
  ),
  tr: ({ children }) => (
    <tr className="hover:bg-[var(--color-bg-hover)] transition-colors">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-4 py-2 text-left text-xs font-semibold text-[var(--color-text-primary)] border-b border-[var(--color-border)]">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2 text-sm text-[var(--color-text-secondary)] border-b border-[var(--color-border-subtle)]">
      {children}
    </td>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[var(--color-accent)] hover:text-[var(--color-accent-bright)] underline transition-colors"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-[var(--color-border)]" />,
  strong: ({ children }) => (
    <strong className="font-semibold text-[var(--color-text-primary)]">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-[var(--color-text-secondary)]">{children}</em>,
};

/**
 * Markdown renderer component - uses memo to avoid unnecessary re-renders
 *
 * Supports:
 * - GFM (GitHub Flavored Markdown)
 * - LaTeX math formulas (rendered with KaTeX)
 * - Code blocks
 * - Tables
 * - Links
 */
export const MarkdownContent = memo<MarkdownContentProps>(({ content, className }) => {
  // Preprocess LaTeX formulas using balanced bracket algorithm
  const processedContent = useMemo(
    () => processLatexBrackets(normalizeShortFencedBlocks(stripHiddenContext(content))),
    [content]
  );
  const preferCompactCodeBlocks = Boolean(className?.includes('chat-markdown'));
  type MarkdownCodeProps = ComponentPropsWithoutRef<'code'> & {
    inline?: boolean;
    node?: unknown;
  };

  const components = useMemo<Partial<Components>>(
    () => ({
      ...STATIC_MARKDOWN_COMPONENTS,
      code: (codeProps: MarkdownCodeProps) => {
        const { inline, children, className: codeClassName } = codeProps;
        const match = /language-(\w+)/.exec(codeClassName || '');
        const language = resolveMarkdownLanguage(match ? match[1] : '');
        const rawCode = (Array.isArray(children) ? children.join('') : String(children)).replace(
          /\n$/,
          ''
        );
        const highlighted = highlightMarkdownCode(rawCode, language);

        return shouldRenderAsInlineCode(rawCode, highlighted.language || language, inline) ? (
          <code className="markdown-inline-code-chip">{rawCode}</code>
        ) : (
          <MarkdownCodeBlock
            code={rawCode}
            language={highlighted.language || language}
            html={highlighted.html}
            className={codeClassName || ''}
            compact={preferCompactCodeBlocks && shouldUseCompactCodeBlock(rawCode)}
          />
        );
      },
    }),
    [preferCompactCodeBlocks]
  );

  return (
    <div
      className={`prose prose-slate dark:prose-invert prose-sm max-w-none break-words markdown-content ${className || ''}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
});

MarkdownContent.displayName = 'MarkdownContent';
