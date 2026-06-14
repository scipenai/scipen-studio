/**
 * @file ZoteroParsedMarkdownView — the "Parsed MD" view within the "Paper" panel; renders MinerU's
 *   full.md output (structured markdown: tables / formulas / images). Reuses
 *   MarkdownRenderService (KaTeX + GFM + sanitize); not bound to EditorService.
 *   Images are relative paths (parsed/images/), rewritten with scipen-file:// to a loadable URL.
 */

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import { getMarkdownRenderService } from '../../services/core';
import { useSettings } from '../../services/core/hooks';
import { useMarkdownSectionSpy } from './useMarkdownSectionSpy';
import 'katex/dist/katex.min.css';

/** Rewrite relative image references inside markdown to absolute scipen-file:// URLs. */
function rewriteImagePaths(markdown: string, parsedDir: string): string {
  // Only handle markdown image syntax ![alt](relative); skip anything already absolute / with a protocol.
  return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (full, alt: string, src: string) => {
    const s = src.trim();
    if (/^([a-z]+:|\/|[a-zA-Z]:[\\/])/.test(s)) return full; // already absolute / has a protocol
    try {
      const abs = `${parsedDir}/${s}`;
      return `![${alt}](${api.file.getLocalFileUrl(abs)})`;
    } catch {
      return full;
    }
  });
}

export const ZoteroParsedMarkdownView: React.FC<{ itemKey: string }> = ({ itemKey }) => {
  const { t } = useTranslation();
  const theme = useSettings((s) => s.ui.theme);
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  // scroll-spy: the parsed MD view also reports the current section to the AI context.
  useMarkdownSectionSpy(containerRef, [html]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const parsed = await api.zotero.getParsedMarkdown(itemKey);
      if (cancelled) return;
      if (!parsed) {
        setHtml(null);
        setLoading(false);
        return;
      }
      const md = rewriteImagePaths(parsed.markdown, parsed.parsedDir);
      const result = await getMarkdownRenderService().render({
        markdown: md,
        filePath: null,
        projectPath: null,
        theme,
      });
      if (cancelled) return;
      setHtml(result.html);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [itemKey, theme]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg-secondary)]">
        <Loader2 size={24} className="animate-spin text-[var(--color-text-muted)]" />
      </div>
    );
  }

  if (html === null) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg-secondary)] px-6 text-center text-sm text-[var(--color-text-muted)]">
        {t('zoteroPaper.mdUnavailable')}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full overflow-auto bg-[var(--color-bg-primary)] p-6">
      <article
        className="markdown-content markdown-document-body prose-sm"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
};
