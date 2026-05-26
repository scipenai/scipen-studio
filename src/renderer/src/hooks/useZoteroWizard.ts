/**
 * @file useZoteroWizard.ts —— just-in-time Zotero 配置向导
 * @description 架构:module-level store + `useSyncExternalStore` hook,让任意组件
 *              都能 (a) 读 wizard 状态、(b) 调 `openZoteroWizard()` 触发。Wizard
 *              UI 只在 App 根挂一份,订阅 store 渲染。
 *
 *              选择 module 单例而非 Context,因为触发点散在多处(设置面板 / chat
 *              composer / Monaco hover),Provider 包到根反而绕路。pub-sub store
 *              更简洁,等价可测。
 *
 *              `finish()` 是 wizard 唯一的副作用集中点 —— 原子写入三字段(D 方案
 *              主开关 integrationEnabled + path + localApiEnabled)。半途关 wizard
 *              则零副作用,避免出现"半启用"脏状态。
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { api } from '../api';
import type {
  ZoteroDetectionResultDTO,
  ZoteroPingResultDTO,
  ZoteroSettingsDTO,
} from '../../../../shared/types/zotero';
import { createLogger } from '../services/LogService';

const logger = createLogger('useZoteroWizard');

export type WizardStepStatus = 'idle' | 'checking' | 'ok' | 'missing';

export interface WizardStepState {
  status: WizardStepStatus;
  /** status === 'missing' 且 probe 抛错时的错误信息。 */
  error?: string;
}

export interface ZoteroWizardState {
  isOpen: boolean;
  /** 1-based step:1 = Zotero,2 = Local API,3 = BBT。 */
  currentStep: 1 | 2 | 3;
  zoteroStep: WizardStepState;
  detection: ZoteroDetectionResultDTO | null;
  localApiStep: WizardStepState;
  pingResult: ZoteroPingResultDTO | null;
  bbtStep: WizardStepState;
  skippedBBT: boolean;
  settings: ZoteroSettingsDTO | null;
}

const INITIAL_STATE: ZoteroWizardState = {
  isOpen: false,
  currentStep: 1,
  zoteroStep: { status: 'idle' },
  detection: null,
  localApiStep: { status: 'idle' },
  pingResult: null,
  bbtStep: { status: 'idle' },
  skippedBBT: false,
  settings: null,
};

// ============================================================
// Module-level store
// ============================================================

let state: ZoteroWizardState = INITIAL_STATE;
const listeners = new Set<() => void>();
let settingsUnsub: (() => void) | null = null;

function setState(updater: (prev: ZoteroWizardState) => ZoteroWizardState): void {
  state = updater(state);
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ZoteroWizardState {
  return state;
}

// ============================================================
// Actions(module-level —— 非 hook 上下文也能调用)
// ============================================================

async function recheckZotero(): Promise<void> {
  setState((prev) => ({ ...prev, zoteroStep: { status: 'checking' } }));
  try {
    const result = await api.zotero.detectInstallation();
    setState((prev) => ({
      ...prev,
      detection: result,
      zoteroStep: { status: result.found ? 'ok' : 'missing' },
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('detectInstallation failed', err);
    setState((prev) => ({
      ...prev,
      detection: null,
      zoteroStep: { status: 'missing', error: msg },
    }));
  }
}

async function recheckLocalApi(): Promise<void> {
  setState((prev) => ({ ...prev, localApiStep: { status: 'checking' } }));
  try {
    const result = await api.zotero.pingLocalApi();
    setState((prev) => ({
      ...prev,
      pingResult: result,
      localApiStep: {
        status: result.ok ? 'ok' : 'missing',
        error: result.ok ? undefined : result.error,
      },
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('pingLocalApi failed', err);
    setState((prev) => ({
      ...prev,
      pingResult: null,
      localApiStep: { status: 'missing', error: msg },
    }));
  }
}

// BBT 检测当前借 detection.betterBibTexInstalled —— Discovery service 在
// detectInstallation 内部已并行 ping 过 BBT。M2 之后引入独立 BBT ping 时
// 替换此调用。
async function recheckBBT(): Promise<void> {
  setState((prev) => ({ ...prev, bbtStep: { status: 'checking' } }));
  try {
    const result = await api.zotero.detectInstallation();
    const ok = result.betterBibTexInstalled === true;
    setState((prev) => ({
      ...prev,
      detection: result,
      bbtStep: { status: ok ? 'ok' : 'missing' },
      skippedBBT: false,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('BBT recheck failed', err);
    setState((prev) => ({
      ...prev,
      bbtStep: { status: 'missing', error: msg },
    }));
  }
}

function skipBBT(): void {
  setState((prev) => ({
    ...prev,
    skippedBBT: true,
    bbtStep: { status: 'missing' },
  }));
}

/** 公开 action:弹 wizard。重复调用幂等(已打开时不重置 state)。 */
export function openZoteroWizard(): void {
  if (state.isOpen) return;
  setState((prev) => ({ ...prev, isOpen: true, currentStep: 1 }));
  void recheckZotero();
  void api.zotero
    .getSettings()
    .then((s) => setState((prev) => ({ ...prev, settings: s })))
    .catch((err) => logger.warn('initial getSettings failed', err));
  if (!settingsUnsub) {
    settingsUnsub = api.zotero.onSettingsChanged((s) => {
      setState((prev) => ({ ...prev, settings: s }));
    });
  }
}

function closeWizard(): void {
  setState((prev) => ({ ...prev, isOpen: false }));
  if (settingsUnsub) {
    settingsUnsub();
    settingsUnsub = null;
  }
}

function goNext(): void {
  setState((prev) => {
    if (prev.currentStep === 1) {
      void recheckLocalApi();
      return { ...prev, currentStep: 2 };
    }
    if (prev.currentStep === 2) {
      void recheckBBT();
      return { ...prev, currentStep: 3 };
    }
    return prev;
  });
}

function goBack(): void {
  setState((prev) =>
    prev.currentStep > 1
      ? { ...prev, currentStep: (prev.currentStep - 1) as 1 | 2 | 3 }
      : prev
  );
}

/**
 * wizard 唯一副作用集中点 —— 一次原子落盘三字段:
 *   integrationEnabled = 用户启用意图(D 方案主开关)
 *   path / localApiEnabled = 此次走完 wizard 观察到的真实状态
 * canGoNext gate 已保证 step1/step2 都通过才能到 finish,detection.path
 * 和 pingResult.ok 都有真实值;半途关 wizard 则零副作用。
 */
function finish(): void {
  const { detection, pingResult } = state;
  void api.zotero
    .setSettings({
      integrationEnabled: true,
      path: detection?.path ?? '',
      localApiEnabled: pingResult?.ok ?? false,
    })
    .catch((err) => logger.warn('finish: setSettings failed', err));
  closeWizard();
}

// ============================================================
// Hook surface
// ============================================================

export interface ZoteroWizardController extends ZoteroWizardState {
  open: () => void;
  close: () => void;
  goNext: () => void;
  goBack: () => void;
  recheckZotero: () => Promise<void>;
  recheckLocalApi: () => Promise<void>;
  recheckBBT: () => Promise<void>;
  skipBBT: () => void;
  finish: () => void;
}

/** Full controller —— wizard UI 用。订阅 store 状态变化。 */
export function useZoteroWizard(): ZoteroWizardController {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const open = useCallback(() => openZoteroWizard(), []);
  const close = useCallback(() => closeWizard(), []);
  const next = useCallback(() => goNext(), []);
  const back = useCallback(() => goBack(), []);
  const fin = useCallback(() => finish(), []);

  return useMemo(
    () => ({
      ...snapshot,
      open,
      close,
      goNext: next,
      goBack: back,
      recheckZotero,
      recheckLocalApi,
      recheckBBT,
      skipBBT,
      finish: fin,
    }),
    [snapshot, open, close, next, back, fin]
  );
}

/**
 * 轻量 handle —— 给 chat composer / hover provider 等触发位置用,
 * 只暴露 `open()`,不订阅 state 变化(避免无意义 re-render)。
 */
export function useZoteroWizardController(): { open: () => void } {
  return { open: openZoteroWizard };
}
