/**
 * @file usePdfMotion.ts - PDF 预览 GSAP 动画 hook
 * @description SyncTeX 落点脉冲高亮。纯渲染层动画,不触碰 pdf.js / canvas 渲染;
 *   集中 GSAP 插件注册与 prefers-reduced-motion 降级,避免动画调用散落到组件里。
 */

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import type { RefObject } from 'react';

// useGSAP 需在使用前注册一次(幂等)。
gsap.registerPlugin(useGSAP);

/**
 * 落点脉冲高亮:`token` 每自增一次,就在 `targetRef` 元素上播放一次
 * "发光框放大淡入 → 停留 → 淡出"。token 为 0 时不动(初始态)。
 *
 * 设计要点:
 * - 用 `autoAlpha` 收口可见性(值为 0 时 GSAP 置 visibility:hidden),叠加层永不挡点击。
 * - 可见性/缩放(opacity/visibility/transform)完全交给 GSAP,组件 style 不声明这些属性,
 *   避免上层 re-render(如 500ms 后清空 highlight)把动画中途覆盖。
 * - `prefers-reduced-motion`:退化为纯静态淡入淡出,无缩放/位移。
 * - `useGSAP({ scope })` 自动 revert;`revertOnUpdate` 保证新一次脉冲干净重启。
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
