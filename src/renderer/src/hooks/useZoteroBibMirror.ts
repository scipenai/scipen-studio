/**
 * @file useZoteroBibMirror —— App 级 hook,按 `integrationEnabled` 网关驱动 mirror 生命周期
 * @description 内部订阅 `Zotero_SettingsChanged` 拿到 `integrationEnabled`,
 *              切换为 true 时 start mirror(订阅 + 全量拉取),false 时 stop。
 *              组件卸载等价于 stop。
 *
 *              返回 `{ state, mirror, enabled }`:state 走 useSyncExternalStore,
 *              mirror 句柄留给需要直接 search/refresh 的场景(StatusBar 诊断、
 *              @cite 弹窗 etc.),enabled 暴露给 StatusBar 决定是否渲染徽章。
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

export function useZoteroBibMirror(): UseZoteroBibMirrorResult {
  const mirror = getZoteroBibMirror();
  const [enabled, setEnabled] = useState(false);

  // 拉取初始 settings + 订阅变更。
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

  // 网关驱动 mirror 生命周期。
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

  const state = useSyncExternalStore(
    (listener) => mirror.subscribe(listener),
    () => mirror.getState(),
    () => mirror.getState()
  );

  return { state, mirror, enabled };
}
