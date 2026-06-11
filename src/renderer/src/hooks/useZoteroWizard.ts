/**
 * @file useZoteroWizard.ts — just-in-time Zotero configuration wizard.
 * @description Architecture: module-level store + `useSyncExternalStore` hook so any
 *              component can (a) read wizard state and (b) call `openZoteroWizard()`
 *              to trigger it. The wizard UI mounts once at the App root and renders
 *              from the store.
 *
 *              Module singleton chosen over Context: trigger points are scattered
 *              (settings panel / chat composer / Monaco hover); wrapping a Provider
 *              around the root is a detour. A pub-sub store is simpler and equally
 *              testable.
 *
 *              `finish()` is the wizard's single side-effect sink — atomic write of
 *              three fields (master toggle `integrationEnabled` + `path` +
 *              `localApiEnabled`). Closing the wizard mid-flow has zero side
 *              effects, preventing a "half-enabled" dirty state.
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
  /** Error message when status === 'missing' and the probe threw. */
  error?: string;
}

export interface ZoteroWizardState {
  isOpen: boolean;
  /** 1-based step: 1 = Zotero, 2 = Local API, 3 = BBT. */
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
// Actions (module-level — callable outside hook context)
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

// BBT detection currently piggy-backs on detection.betterBibTexInstalled — the
// Discovery service already pings BBT in parallel inside detectInstallation.
// Replace this call once a dedicated BBT ping lands post-M2.
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

/** Public action: open the wizard. Idempotent — does not reset state if already open. */
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
    prev.currentStep > 1 ? { ...prev, currentStep: (prev.currentStep - 1) as 1 | 2 | 3 } : prev
  );
}

/**
 * Wizard's single side-effect sink — atomic write of three fields:
 *   integrationEnabled    = user enablement intent (master toggle)
 *   path / localApiEnabled = real state observed during this wizard run
 * The canGoNext gate guarantees step1/step2 both passed before finish, so
 * detection.path and pingResult.ok hold real values. Closing mid-flow has
 * zero side effects.
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

/** Full controller — used by the wizard UI. Subscribes to store state changes. */
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
 * Lightweight handle for trigger sites (chat composer / hover provider).
 * Exposes only `open()` and does not subscribe to state changes — avoids
 * unnecessary re-renders.
 */
export function useZoteroWizardController(): { open: () => void } {
  return { open: openZoteroWizard };
}
