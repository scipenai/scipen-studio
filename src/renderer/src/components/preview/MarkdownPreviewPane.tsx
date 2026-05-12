/**
 * @file MarkdownPreviewPane.tsx - Markdown real-time preview
 * @description Uses MarkdownRenderService to render sanitized HTML while preserving scroll sync and click-to-source.
 */

import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Delayer } from '../../../../../shared/utils/async';
import { api } from '../../api';
import { getEditorService, getUIService } from '../../services/core/ServiceRegistry';
import { openFileInEditor } from '../../services/core/FileOpenService';
import { getMarkdownRenderService } from '../../services/core';
import { useActiveTabPath, useProjectPath, useSettings } from '../../services/core/hooks';
import { SyncEventType } from '../../services/core/PreviewTypes';
import { useTranslation } from '../../locales';
import type { MarkdownFrontmatterField, MarkdownRenderResult } from '../../types';
import 'katex/dist/katex.min.css';

const DEBOUNCE_MS = 100;

function formatFrontmatterLabel(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (segment) => segment.toUpperCase());
}

function pickFrontmatterValue(
  fields: MarkdownFrontmatterField[],
  candidates: string[]
): string | null {
  const map = new Map(fields.map((field) => [field.key.toLowerCase(), field.value]));
  for (const candidate of candidates) {
    const value = map.get(candidate.toLowerCase());
    if (value) {
      return value;
    }
  }
  return null;
}

export const MarkdownPreviewPane: React.FC = memo(() => {
  const { t } = useTranslation();
  const activeTabPath = useActiveTabPath();
  const projectPath = useProjectPath();
  const theme = useSettings((settings) => settings.ui.theme);
  const [content, setContent] = useState<string>('');
  const [rendered, setRendered] = useState<MarkdownRenderResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const delayerRef = useRef<Delayer<void> | null>(null);
  const requestIdRef = useRef(0);
  const frontmatterTitle = useMemo(
    () =>
      rendered
        ? pickFrontmatterValue(rendered.frontmatter, ['title', 'name']) ||
          activeTabPath?.replace(/\\/g, '/').split('/').pop() ||
          'Markdown'
        : activeTabPath?.replace(/\\/g, '/').split('/').pop() || 'Markdown',
    [activeTabPath, rendered]
  );
  const frontmatterDescription = useMemo(
    () =>
      rendered
        ? pickFrontmatterValue(rendered.frontmatter, ['description', 'summary', 'subtitle'])
        : null,
    [rendered]
  );
  const visibleFrontmatter = useMemo(
    () =>
      (rendered?.frontmatter || []).filter(
        (field) =>
          !['title', 'name', 'description', 'summary', 'subtitle'].includes(field.key.toLowerCase())
      ),
    [rendered]
  );

  useEffect(() => {
    delayerRef.current = new Delayer<void>(DEBOUNCE_MS);
    return () => delayerRef.current?.dispose();
  }, []);

  useEffect(() => {
    const editorService = getEditorService();
    setContent(editorService.activeTab?.content || '');

    const disposable = editorService.onDidChangeContent((event) => {
      const newContent = event.content;
      if (delayerRef.current) {
        delayerRef.current
          .trigger(() => {
            setContent(newContent);
            return Promise.resolve();
          })
          .catch(() => {});
      } else {
        setContent(newContent);
      }
    });

    const tabDisposable = editorService.onDidChangeActiveTab((tab) => {
      setContent(tab?.content || '');
    });

    return () => {
      disposable.dispose();
      tabDisposable.dispose();
    };
  }, []);

  useEffect(() => {
    const uiService = getUIService();
    const disposable = uiService.onDidEditorToPreview((event) => {
      if (
        event.type === SyncEventType.SCROLL_TO_LINE &&
        event.line != null &&
        containerRef.current
      ) {
        const target = containerRef.current.querySelector(`[data-line="${event.line}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    });

    return () => disposable.dispose();
  }, []);

  useEffect(() => {
    const currentRequestId = ++requestIdRef.current;

    if (!content) {
      setRendered(null);
      setError(null);
      return;
    }

    getMarkdownRenderService()
      .render({ markdown: content, filePath: activeTabPath, projectPath, theme })
      .then((result) => {
        if (currentRequestId !== requestIdRef.current) return;
        setRendered(result);
        setError(null);
      })
      .catch((err) => {
        if (currentRequestId !== requestIdRef.current) return;
        setRendered(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [content, activeTabPath, projectPath, theme]);

  const openLocalFile = useCallback(async (filePath: string) => {
    await openFileInEditor(filePath);
  }, []);

  const handleClick = useCallback(
    async (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const copyButton = target.closest('[data-copy-code]') as HTMLButtonElement | null;
      if (copyButton) {
        e.preventDefault();
        e.stopPropagation();
        const encoded = copyButton.getAttribute('data-copy-code') || '';
        if (encoded) {
          await navigator.clipboard.writeText(decodeURIComponent(encoded));
          copyButton.textContent = t('markdownPreview.copied');
          copyButton.setAttribute('data-copied', 'true');
          window.setTimeout(() => {
            copyButton.textContent = t('markdownPreview.copyCode');
            copyButton.setAttribute('data-copied', 'false');
          }, 1400);
        }
        return;
      }
      const anchor = target.closest('a') as HTMLAnchorElement | null;
      if (anchor) {
        const localPath = anchor.getAttribute('data-scipen-local-path');
        const href = anchor.getAttribute('href') || '';

        if (localPath) {
          e.preventDefault();
          const actualPath = localPath.split('#')[0];
          if (/\.(md|markdown|mdx)$/i.test(actualPath)) {
            await openLocalFile(actualPath);
          } else {
            await api.file.openPath(actualPath);
          }
          return;
        }

        if (href.startsWith('#')) {
          e.preventDefault();
          const anchorId = href.slice(1);
          const el = containerRef.current?.querySelector(`#${CSS.escape(anchorId)}`);
          el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }

        if (/^(https?:|mailto:)/i.test(href)) {
          e.preventDefault();
          await api.app.openExternal(href);
          return;
        }
      }

      let el: HTMLElement | null = target;
      while (el && el !== containerRef.current) {
        const line = el.getAttribute('data-line');
        if (line) {
          const lineNum = Number.parseInt(line, 10);
          if (!Number.isNaN(lineNum)) {
            getUIService().firePreviewToEditor({
              type: SyncEventType.CLICK_TO_SOURCE,
              line: lineNum,
            });
          }
          break;
        }
        el = el.parentElement;
      }
    },
    [openLocalFile, t]
  );

  if (!content) {
    return (
      <div className="h-full flex items-center justify-center bg-[var(--color-bg-secondary)]">
        <p className="text-[var(--color-text-muted)] text-sm">
          {t('preview.noPreview') || 'No content to preview'}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-[var(--color-bg-secondary)] px-6 text-center">
        <div className="max-w-2xl rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-4">
          <p className="mb-2 text-sm font-medium text-[var(--color-error)]">
            {t('preview.markdownRenderError')}
          </p>
          <pre className="overflow-auto whitespace-pre-wrap text-xs text-[var(--color-text-muted)]">
            {error}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="markdown-preview-surface h-full overflow-auto cursor-default"
      onClick={handleClick}
    >
      <div className="markdown-document-shell">
        {(rendered?.frontmatter.length || 0) > 0 && (
          <section className="markdown-document-hero">
            <div className="markdown-document-hero__eyebrow">
              {t('markdownPreview.documentLabel')}
            </div>
            <h1 className="markdown-document-hero__title">{frontmatterTitle}</h1>
            {frontmatterDescription && (
              <p className="markdown-document-hero__description">{frontmatterDescription}</p>
            )}
            {visibleFrontmatter.length > 0 && (
              <div className="markdown-document-meta">
                {visibleFrontmatter.map((field) => (
                  <div key={field.key} className="markdown-meta-pill">
                    <span className="markdown-meta-pill__label">
                      {formatFrontmatterLabel(field.key)}
                    </span>
                    <span className="markdown-meta-pill__value">{field.value}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
        <article
          className="markdown-content markdown-document-body prose-sm"
          dangerouslySetInnerHTML={{ __html: rendered?.html || '' }}
        />
      </div>
    </div>
  );
});

MarkdownPreviewPane.displayName = 'MarkdownPreviewPane';
