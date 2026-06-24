/**
 * @file useMarkdownSectionSpy — scroll-spy for markdown preview. Tracks the
 *   currently visible section heading near the top of the scroll container's
 *   viewport, reports it to UIService.setCurrentMarkdownSection, so that
 *   ChatContextBuilder can inject it into AI context (conveys "which section
 *   the user is reading").
 *
 * Only the heading text is passed, not scroll coordinates (raw coords are
 * uninterpretable to the AI). Use IntersectionObserver with a raised bottom
 * margin (rootMargin) to narrow the detection band to roughly the top 1/3
 * of the container, then take the document-order earliest visible heading
 * as the current section. MarkdownRenderService already assigns ids to headings.
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
        // headings are in document order; first heading inside the detection band = section at viewport top.
        const top = headings.find((h) => visible.has(h)) ?? null;
        ui.setCurrentMarkdownSection(top?.textContent?.trim() || null);
      },
      // Raise bottom edge 66% -> only headings in the top ~1/3 of the container count, avoiding all headings matching at once.
      { root: container, rootMargin: '0px 0px -66% 0px', threshold: 0 }
    );
    headings.forEach((h) => observer.observe(h));

    return () => {
      observer.disconnect();
      ui.setCurrentMarkdownSection(null);
    };
    // deps supplied by caller (typically the rendered html); content change rebuilds the observer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
