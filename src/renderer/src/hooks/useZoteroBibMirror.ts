/**
 * @file useZoteroBibMirror —— Zotero mirror 的两条订阅通道
 *
 * @description
 *   - `useZoteroMirrorLifecycle()`:App 级生命周期 hook,**不订阅 mirror state**。
 *     仅负责按 `integrationEnabled` 网关 start/stop 单例 mirror。挂在 App.tsx
 *     顶层,这样即使 StatusBadge 卸载 mirror 也保持 alive。
 *   - `useZoteroBibMirror()`:state 订阅 hook,通过 `useSyncExternalStore` 监听
 *     mirror.bumpSnapshot。组件级使用(StatusBadge / Diagnostics / @cite 弹窗)—
 *     哪个组件用,mirror 状态变化就只让那个组件 re-render。
 *
 *   架构动机:之前 App.tsx 顶层调 `useZoteroBibMirror()` 把 state 订阅绑到根
 *   节点 → mirror 每次 status flicker(每 1-3 秒)整树 invalidate → tab 切换、
 *   编辑器交互全部跟着卡。拆双 hook 后,App 只受 enabled 变化影响(罕见),
 *   state churn 只触达真正消费 state 的叶子组件。
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { createLogger } from '../services/LogService';
import {
  getZoteroBibMirror,
  type ZoteroBibMirror,
  type ZoteroBibMirrorState,
} from '../services/zotero/ZoteroBibMirror';

const logger = createLogger('useZoteroBibMirror');

export interface UseZoteroBibMirrorResult {
  state: ZoteroBibMirrorState;
  mirror: ZoteroBibMirror;
  enabled: boolean;
}

/**
 * 共享子 hook —— 拉 + 订阅 `integrationEnabled` 设置。
 * 两个对外 hook 都用它,各自维护一份本地 state(并发订阅同一 IPC 通道)。
 * 故意不抽 context:enabled 变化罕见(用户手动 toggle 才动),两份订阅开销可忽略。
 */
function useZoteroIntegrationEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void api.zotero
      .getSettings()
      .then((settings) => {
        if (!cancelled) setEnabled(Boolean(settings.integrationEnabled));
      })
      .catch((err) => logger.warn('getSettings failed', err));

    const unsub = api.zotero.onSettingsChanged((settings) => {
      setEnabled(Boolean(settings.integrationEnabled));
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return enabled;
}

/**
 * App 级 mirror 生命周期 —— 挂在 App.tsx 顶层。**不订阅 state**,App 不会
 * 因 mirror.bumpSnapshot 重渲染。enabled toggle 才会触发 App 重渲染(可接受)。
 */
export function useZoteroMirrorLifecycle(): void {
  const mirror = getZoteroBibMirror();
  const enabled = useZoteroIntegrationEnabled();

  useEffect(() => {
    if (enabled) {
      void mirror.start();
    } else {
      mirror.stop();
    }
    return () => {
      mirror.stop();
    };
  }, [enabled, mirror]);
}

/**
 * 组件级 state 订阅 —— StatusBadge / DiagnosticsPopover / @cite 候选弹窗用。
 * useSyncExternalStore 让 React 跟 mirror.bumpSnapshot 同步;调用方组件本地
 * re-render,不污染外层。
 */
export function useZoteroBibMirror(): UseZoteroBibMirrorResult {
  const mirror = getZoteroBibMirror();
  const enabled = useZoteroIntegrationEnabled();

  const state = useSyncExternalStore(
    (listener) => mirror.subscribe(listener),
    () => mirror.getState(),
    () => mirror.getState()
  );

  return { state, mirror, enabled };
}
