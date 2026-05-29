/**
 * @file useMarkdownSectionSpy —— markdown 预览的 scroll-spy。跟踪滚动容器
 *   视口顶部当前可见的章节标题,上报 UIService.setCurrentMarkdownSection,
 *   供 ChatContextBuilder 注入 AI 上下文(表达「用户正在读哪一节」)。
 *
 * 只传标题文本,不传滚动坐标(裸坐标 AI 无法解读)。用 IntersectionObserver
 * + 上移的下边界(rootMargin)把判定收窄到容器顶部约 1/3,取文档序最靠前的
 * 可见 heading 作为当前章节。MarkdownRenderService 已为每个 heading 生成 id。
 */

import { useEffect } from 'react';
import type React from 'react';
import { getUIService } from '../../services/core';

const HEADING_SELECTOR = 'h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]';

export function useMarkdownSectionSpy(
  containerRef: React.RefObject<HTMLElement | null>,
  deps: unknown[]
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const headings = Array.from(container.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
    if (headings.length === 0) return;

    const ui = getUIService();
    const visible = new Set<HTMLElement>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target as HTMLElement);
          else visible.delete(e.target as HTMLElement);
        }
        // headings 为文档序;取第一个落在判定带内的标题 = 视口顶部章节。
        const top = headings.find((h) => visible.has(h)) ?? null;
        ui.setCurrentMarkdownSection(top?.textContent?.trim() || null);
      },
      // 下边界上移 66% → 只认容器顶部约 1/3 的标题,避免整页标题同时命中。
      { root: container, rootMargin: '0px 0px -66% 0px', threshold: 0 }
    );
    headings.forEach((h) => observer.observe(h));

    return () => {
      observer.disconnect();
      ui.setCurrentMarkdownSection(null);
    };
    // deps 由调用方传入(通常是渲染后的 html),内容变则重建 observer。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
