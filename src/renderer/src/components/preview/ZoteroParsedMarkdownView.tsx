/**
 * @file ZoteroParsedMarkdownView —— 「论文」面板「解析 MD」视图,渲染 MinerU
 *   产出的 full.md(结构化 markdown:表格 / 公式 / 图片)。复用
 *   MarkdownRenderService(KaTeX + GFM + sanitize),不绑 EditorService。
 *   图片是相对路径(parsed/images/),用 scipen-file:// 重写为可加载 URL。
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

/** 把 markdown 里的相对图片引用重写成 scipen-file:// 绝对 URL。 */
function rewriteImagePaths(markdown: string, parsedDir: string): string {
  // 仅处理 markdown 图片语法 ![alt](relative)，跳过已是 http/绝对/协议的。
  return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (full, alt: string, src: string) => {
    const s = src.trim();
    if (/^([a-z]+:|\/|[a-zA-Z]:[\\/])/.test(s)) return full; // 已绝对/带协议
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
  // scroll-spy:解析 MD 视图也上报当前章节给 AI 上下文。
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
