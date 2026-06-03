/**
 * @file useLazyModule.ts - 可靠提交的动态组件加载(替代 React.lazy + Suspense)
 * @description 本应用中 React.lazy + Suspense 的「首次 resolve」不提交挂载 —— 诊断实测:
 *   chunk 在首次点击即解析(<12ms),但组件直到下一次交互才 mount(即用户感知的「点两次才出现」)。
 *   根因:lazy 的加载器天生异步 → 必 suspend 一次 → resolve 后 React 把「提交」排进低优先级
 *   retry lane,被持续的高优先级渲染饿死,直到下次交互强制 flush。
 *
 *   本 hook 改走「动态 import → setState」路径:setState 是默认优先级更新,提交可靠、不被饿死;
 *   同时保留 code-split(动态 import 仍产出独立 chunk)。配合 shell 的 idle 预加载,import 命中
 *   已 warm 的缓存 → 近乎瞬时。静态导入(如文件抽屉)是同一思路的极端形态(零异步),已验证可靠。
 */
import { useEffect, useState, type ComponentType } from 'react';

/**
 * 动态加载一个组件并在就绪后返回它(未就绪返回 null,由调用方渲染 fallback)。
 * @param load 模块加载器,返回目标组件,例如 `() => import('./Heavy').then(m => m.Heavy)`
 */
export function useLazyModule<P = Record<string, never>>(
  load: () => Promise<ComponentType<P>>
): ComponentType<P> | null {
  const [Component, setComponent] = useState<ComponentType<P> | null>(null);

  useEffect(() => {
    let alive = true;
    void load()
      .then((resolved) => {
        // 函数式 setState:组件本身是函数,直接传会被当作 updater,故包一层返回。
        if (alive) setComponent(() => resolved);
      })
      .catch((err) => {
        // chunk 加载失败罕见但严重(组件会永久停在 fallback),记日志便于诊断;
        // 不抛出 → 不连累整个面板(组件自身渲染期的真实错误仍由上层 ErrorBoundary 兜底)。
        console.error('[useLazyModule] 动态组件加载失败', err);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load 在每个调用点是稳定的模块加载器,仅挂载时加载一次
  }, []);

  return Component;
}
