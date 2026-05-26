/**
 * @file useZoteroWizard.ts — just-in-time Zotero setup wizard controller
 * @description Renderer-side state for the M1 Zotero onboarding wizard.
 *              Wizard does NOT auto-open on app boot (PM-3 decision).
 *              It is opened on demand by the first `@cite:` mention or
 *              first `\cite{}` hover; consumers call `open()` from the
 *              just-in-time trigger sites once those wire-ups land.
 *
 *              M1 batch 1 ships this hook with REAL detect/ping calls
 *              but no real consumer (wizard UI works end-to-end against
 *              skeleton services). Batch 2 will wire AtMentionResolver
 *              and CiteHoverProvider triggers.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** Last error message when status === 'missing' due to a probe failure. */
  error?: string;
}

export interface ZoteroWizardController {
  isOpen: boolean;
  open: () => void;
  close: () => void;

  /** 1-based step index: 1 = Zotero, 2 = Local API, 3 = BBT. */
  currentStep: 1 | 2 | 3;
  goNext: () => void;
  goBack: () => void;

  zoteroStep: WizardStepState;
  detection: ZoteroDetectionResultDTO | null;
  recheckZotero: () => Promise<void>;

  localApiStep: WizardStepState;
  pingResult: ZoteroPingResultDTO | null;
  recheckLocalApi: () => Promise<void>;

  bbtStep: WizardStepState;
  skippedBBT: boolean;
  skipBBT: () => void;
  recheckBBT: () => Promise<void>;

  settings: ZoteroSettingsDTO | null;
  finish: () => void;
}

/**
 * Just-in-time wizard hook. M1 batch 1 is mock-friendly:
 * `recheck*` methods call real IPC but the wizard UI can override them
 * by injecting a `mockOverride` for storybook-style demos. We do NOT
 * inject mocks here — tests will mock `api.zotero.*` directly.
 */
export function useZoteroWizard(): ZoteroWizardController {
  const [isOpen, setIsOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);

  const [zoteroStep, setZoteroStep] = useState<WizardStepState>({ status: 'idle' });
  const [detection, setDetection] = useState<ZoteroDetectionResultDTO | null>(null);

  const [localApiStep, setLocalApiStep] = useState<WizardStepState>({ status: 'idle' });
  const [pingResult, setPingResult] = useState<ZoteroPingResultDTO | null>(null);

  const [bbtStep, setBbtStep] = useState<WizardStepState>({ status: 'idle' });
  const [skippedBBT, setSkippedBBT] = useState(false);

  const [settings, setSettings] = useState<ZoteroSettingsDTO | null>(null);

  // Latest closure of settings — used in unsub cleanup to avoid stale refs.
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    void api.zotero
      .getSettings()
      .then(setSettings)
      .catch((err) => logger.warn('initial getSettings failed', err));

    unsubRef.current = api.zotero.onSettingsChanged(setSettings);
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [isOpen]);

  const recheckZotero = useCallback(async () => {
    setZoteroStep({ status: 'checking' });
    try {
      const result = await api.zotero.detectInstallation();
      setDetection(result);
      setZoteroStep({ status: result.found ? 'ok' : 'missing' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('detectInstallation failed', err);
      setDetection(null);
      setZoteroStep({ status: 'missing', error: msg });
    }
  }, []);

  const recheckLocalApi = useCallback(async () => {
    setLocalApiStep({ status: 'checking' });
    try {
      const result = await api.zotero.pingLocalApi();
      setPingResult(result);
      setLocalApiStep({
        status: result.ok ? 'ok' : 'missing',
        error: result.ok ? undefined : result.error,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('pingLocalApi failed', err);
      setPingResult(null);
      setLocalApiStep({ status: 'missing', error: msg });
    }
  }, []);

  // BBT detection currently piggy-backs on detection.betterBibTexInstalled.
  // M1 batch 2 will introduce BetterBibTexClient with a dedicated ping;
  // until then `recheckBBT` re-runs `detectInstallation` which carries the
  // (placeholder) flag forward.
  const recheckBBT = useCallback(async () => {
    setBbtStep({ status: 'checking' });
    try {
      const result = await api.zotero.detectInstallation();
      setDetection(result);
      const ok = result.betterBibTexInstalled === true;
      setBbtStep({ status: ok ? 'ok' : 'missing' });
      setSkippedBBT(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('BBT recheck failed', err);
      setBbtStep({ status: 'missing', error: msg });
    }
  }, []);

  const skipBBT = useCallback(() => {
    setSkippedBBT(true);
    setBbtStep({ status: 'missing' });
  }, []);

  const open = useCallback(() => {
    setIsOpen(true);
    setCurrentStep(1);
    void recheckZotero();
  }, [recheckZotero]);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const goNext = useCallback(() => {
    setCurrentStep((cur) => {
      if (cur === 1) {
        void recheckLocalApi();
        return 2;
      }
      if (cur === 2) {
        void recheckBBT();
        return 3;
      }
      return cur;
    });
  }, [recheckLocalApi, recheckBBT]);

  const goBack = useCallback(() => {
    setCurrentStep((cur) => (cur > 1 ? ((cur - 1) as 1 | 2 | 3) : cur));
  }, []);

  const finish = useCallback(() => {
    // wizard 全部副作用集中在此 — 一次性原子落盘三字段:
    //   integrationEnabled = 用户启用意图(D 方案主开关)
    //   path / localApiEnabled = 此次走完 wizard 时观察到的真实状态
    // canGoNext gate 已保证 step1/step2 都通过才能到 finish,故 detection.path
    // 和 pingResult.ok 都有真实值。半途关 wizard 则零副作用。
    void api.zotero
      .setSettings({
        integrationEnabled: true,
        path: detection?.path ?? '',
        localApiEnabled: pingResult?.ok ?? false,
      })
      .catch((err) => logger.warn('finish: setSettings failed', err));
    setIsOpen(false);
  }, [detection, pingResult]);

  return {
    isOpen,
    open,
    close,
    currentStep,
    goNext,
    goBack,
    zoteroStep,
    detection,
    recheckZotero,
    localApiStep,
    pingResult,
    recheckLocalApi,
    bbtStep,
    skippedBBT,
    skipBBT,
    recheckBBT,
    settings,
    finish,
  };
}
