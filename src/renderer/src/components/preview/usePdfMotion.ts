/**
 * @file usePdfMotion.ts - GSAP animation hook for PDF preview.
 * @description SyncTeX landing-point pulse highlight. Pure render-layer animation;
 *   does not touch pdf.js / canvas rendering. Centralizes GSAP plugin registration
 *   and prefers-reduced-motion fallback so animation calls don't scatter across components.
 */

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import type { RefObject } from 'react';

// useGSAP must be registered once before use (idempotent).
gsap.registerPlugin(useGSAP);

/**
 * Landing-point pulse highlight: every time `token` increments, play one
 * "glow box scale-in fade-in -> hold -> fade-out" on the `targetRef` element.
 * Stays idle when token is 0 (initial state).
 *
 * Design notes:
 * - Use `autoAlpha` to gate visibility (GSAP sets visibility:hidden at 0), so the
 *   overlay never blocks clicks.
 * - Visibility / scale (opacity/visibility/transform) are owned entirely by GSAP;
 *   component style declares none of them, preventing parent re-renders (e.g.
 *   clearing highlight after 500ms) from overriding the animation mid-flight.
 * - `prefers-reduced-motion`: degrade to plain static fade in/out, no scale/translate.
 * - `useGSAP({ scope })` auto-reverts; `revertOnUpdate` ensures each new pulse restarts cleanly.
 */
export function usePulseHighlight(
  scopeRef: RefObject<HTMLElement | null>,
  targetRef: RefObject<HTMLElement | null>,
  token: number
): void {
  useGSAP(
    () => {
      const el = targetRef.current;
      if (!token || !el) return;

      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      if (reduceMotion) {
        gsap
          .timeline()
          .fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2, ease: 'none' })
          .to(el, { autoAlpha: 0, duration: 0.4, ease: 'none' }, '+=1.0');
        return;
      }

      gsap
        .timeline()
        .fromTo(
          el,
          { autoAlpha: 0, scale: 1.25, transformOrigin: 'center center' },
          { autoAlpha: 1, scale: 1, duration: 0.35, ease: 'back.out(2)' }
        )
        .to(el, { autoAlpha: 0, duration: 0.45, ease: 'power2.in' }, '+=0.7');
    },
    { dependencies: [token], scope: scopeRef, revertOnUpdate: true }
  );
}
