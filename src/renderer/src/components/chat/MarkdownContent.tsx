/**
 * @file MarkdownContent.tsx - Markdown Renderer Component
 * @description Markdown renderer supporting GFM, LaTeX formulas and code highlighting
 */

// Import KaTeX CSS to properly render LaTeX formulas
import 'katex/dist/katex.min.css';

import { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

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
  const processedContent = useMemo(() => processLatexBrackets(content), [content]);

  return (
    <div
      className={`prose prose-slate dark:prose-invert prose-sm max-w-none break-words markdown-content ${className || ''}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          code: (codeProps: any) => {
            const { inline, children, className: codeClassName } = codeProps;
            const match = /language-(\w+)/.exec(codeClassName || '');
            const language = match ? match[1] : '';

            return inline ? (
              <code>{children}</code>
            ) : (
              <div className="relative group">
                {language && (
                  <span className="absolute top-2 right-2 text-xs text-[var(--color-text-muted)] opacity-60">
                    {language}
                  </span>
                )}
                <pre className="overflow-x-auto">
                  <code className={`block whitespace-pre ${codeClassName || ''}`}>{children}</code>
                </pre>
              </div>
            );
          },
          // pre is handled by code component, just pass through here
          pre: ({ children }) => <>{children}</>,
          ul: ({ children }) => (
            <ul className="list-disc list-inside space-y-1 my-2">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside space-y-1 my-2">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="my-1 text-[var(--color-text-secondary)]">{children}</li>
          ),
          p: ({ children }) => (
            <p className="my-2 leading-relaxed text-[var(--color-text-secondary)]">{children}</p>
          ),
          h1: ({ children }) => (
            <h1 className="text-xl font-bold mt-4 mb-2 text-[var(--color-text-primary)]">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-lg font-bold mt-3 mb-2 text-[var(--color-text-primary)]">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-base font-semibold mt-3 mb-1 text-[var(--color-text-primary)]">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-sm font-semibold mt-2 mb-1 text-[var(--color-text-primary)]">
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
          thead: ({ children }) => (
            <thead className="bg-[var(--color-bg-tertiary)]">{children}</thead>
          ),
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
          em: ({ children }) => (
            <em className="italic text-[var(--color-text-secondary)]">{children}</em>
          ),
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
});

MarkdownContent.displayName = 'MarkdownContent';
